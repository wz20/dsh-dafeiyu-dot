import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,readFile,writeFile,readdir,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../lib/storage.js';

registerHooks({resolve(specifier,context,next){
 if(specifier==='@deepseek-ai/dsh-credentials')return {url:'data:text/javascript,export const credentialRef = name => ({name});',shortCircuit:true};
 return next(specifier,context);
}});
const {installQQ}=await import('../lib/qq.js');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,label='condition',timeout=2500){const start=Date.now();while(Date.now()-start<timeout){if(condition())return;await pause(3);}assert.fail('Timed out: '+label);}

async function environment(t,options={}){
 const root=options.root??await mkdtemp(join(tmpdir(),'dafeiyu-qq-monitor-'));let timestamp=1_800_000_000_000,sequence=0,nextUser=0,nextInbound=0,nextOutgoing=900;
 const value={qq:{enabled:true,wsUrl:'ws://127.0.0.1:13001',botId:'10001',ownerId:'20002',sessionId:'fish-session',voiceReplies:true,...options.qq}};
 if(options.corruptMonitor)await mkdir(join(root,'qq-monitor.json'));
 const listeners=new Map(),sockets=[],calls=[],followups=[],speechCalls=[],events=[];
 const config={get:()=>structuredClone(value),async update(patch){value.qq={...value.qq,...patch.qq};return this.get();}};
 const session={id:'fish-session',header:{agentPreset:'whale'},snapshotEvents:()=>[...events]};
 const agent={id:session.id,status:'idle',session,followup(message){followups.push(message);agent.status='running';if(!options.holdTurn)queueMicrotask(()=>complete(message));}};
 function emit(type,data){const event={type,data,seq:++sequence,time:timestamp};events.push(event);for(const fn of listeners.get('session/event')??[])fn(session,event);}
 function complete(message=followups.at(-1),reason='completed'){
  emit('turn/start',{turn:sequence+1});emit('user/message',message);emit('assistant/message',{message:{id:'assistant-'+sequence,content:[{type:'text',text:'主人，我在这里陪你呢。'}]}});agent.status='idle';emit('turn/end',{reason:{kind:reason}});
 }
 class FakeWebSocket{
  constructor(url){this.url=url;this.readyState=0;this.handlers=new Map();sockets.push(this);queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this.event('open',{});});}
  addEventListener(type,fn){const list=this.handlers.get(type)??[];list.push(fn);this.handlers.set(type,list);}
  event(type,data){for(const fn of this.handlers.get(type)??[])fn(data);}
  message(data){this.event('message',{data:JSON.stringify(data)});}
  send(raw){
   const request=JSON.parse(raw);calls.push(request);
   let response={status:'ok',retcode:0,data:request.action==='get_login_info'?{user_id:'10001'}:request.action==='get_status'?{online:true,good:true}:request.action==='get_friend_msg_history'?{messages:options.history??[]}:{message_id:++nextOutgoing}};
   if(options.rpcResponse)response=options.rpcResponse(request,response,this);
   if(response)queueMicrotask(()=>this.message({...response,echo:request.echo}));
  }
  close(){if(this.readyState===3)return;this.readyState=3;this.event('close',{});}
 }
 const ctx={agents:{get:id=>id===session.id?agent:undefined},credentials:{resolve:async()=>({value:'private-gateway-token'})},on(type,fn){const list=listeners.get(type)??[];list.push(fn);listeners.set(type,list);return()=>listeners.set(type,(listeners.get(type)??[]).filter(x=>x!==fn));},effect(fn){fn();}};
 const speech={async synthesize(text,details){speechCalls.push({text,details});if(options.synthesize)return options.synthesize(text,details);return {audio:Buffer.from('test-wave'),delivery:{mode:'model',emotion:'warm',cached:false,preparationMs:95,privateField:'never-visible'}};}};
 const qq=installQQ(ctx,{config,speech,root,WebSocketImpl:FakeWebSocket,makeMessage:input=>({...input,id:'sdk-user-'+(++nextUser)}),now:()=>timestamp,rpcTimeoutMs:options.rpcTimeoutMs??35,retryDelayMs:1000,turnTimeoutMs:2000});
 const snapshot=()=>qq.snapshot();const entries=()=>snapshot().monitor?.entries??[];
 const incoming=(text,extra={})=>{sockets.at(-1).message({post_type:'message',message_type:'private',sub_type:'friend',self_id:'10001',user_id:'20002',message_id:'in-'+(++nextInbound),time:Math.floor(timestamp/1000),message:[{type:'text',data:{text}}],...extra});};
 const ready=()=>until(()=>snapshot().connected,'verified connection');
 const loaded=()=>until(()=>snapshot().monitor?.backfillState==='ready'||snapshot().monitor?.backfillState==='unavailable','history load');
 const persisted=()=>until(()=>snapshot().monitor&&!snapshot().monitor.persisting,'monitor storage flush');
 async function dispose(){qq.dispose();await until(()=>!snapshot().monitor?.persisting,'final monitor flush').catch(()=>{});}
 t.after(async()=>{await dispose();if(!options.keepRoot)await rm(root,{recursive:true,force:true});});
 return {root,qq,config,session,agent,calls,sockets,followups,speechCalls,events,incoming,ready,loaded,persisted,entries,snapshot,complete,dispose,advance:ms=>{timestamp+=ms;},time:()=>timestamp};
}
function historical(id,userId,kind='text',text='已保存的私聊',extra={}){return {post_type:userId==='10001'?'message_sent':'message',message_type:'private',sub_type:'friend',self_id:'10001',user_id:userId,message_id:id,time:1_800_000_000,message:[{type:kind,data:kind==='text'?{text}:{file:'sensitive-file-id',url:'https://private.example/voice?access_token=secret',path:'/Users/private/voice.wav'}}],...extra};}

test('owner-only history backfill displays private text and voice without entering the Agent or dedup intake',async t=>{
 const e=await environment(t,{history:[historical('h1','20002'),historical('h2','10001','record'),historical('h3','30003'),historical('h4','20002','text','群聊',{message_type:'group'}),historical('h5','20002','text','错误登录号',{self_id:'99999'}),historical('h6','10001','text','发给其他用户',{target_id:'30003'}),historical('h7','10001','text','其他私聊',{peer_id:'30003'})]});
 await e.ready();await e.loaded();assert.equal(e.snapshot().monitor.limit,200);assert.equal(e.snapshot().monitor.retentionDays,7);assert.equal(e.entries().length,2);
 assert.deepEqual(new Set(e.entries().map(x=>x.kind)),new Set(['text','voice']));assert.equal(e.followups.length,0);assert.equal(e.events.length,0);assert.equal(e.speechCalls.length,0);
 assert.equal(e.calls.find(x=>x.action==='get_friend_msg_history').params.user_id,'20002');assert.equal(e.calls.find(x=>x.action==='get_friend_msg_history').params.count,20);
 await e.persisted();assert.ok(!(await readdir(e.root)).includes('qq-state.json'));assert.doesNotMatch(await readFile(join(e.root,'qq-monitor.json'),'utf8'),/private\.example|sensitive-file-id|\/Users\/private|access_token/);
 assert.ok(e.entries().every(x=>!('ownerId'in x)&&!('botId'in x)&&!('_ownerId'in x)&&!('_botId'in x)));
});

test('live owner input and confirmed emotional voice output are correlated while foreign and group inputs stay invisible',async t=>{
 const e=await environment(t);await e.ready();await e.loaded();
 e.incoming('不记录群聊',{message_type:'group',message_id:'group'});e.incoming('不记录别人',{user_id:'30003',message_id:'foreign'});e.incoming('不记录自己',{user_id:'10001',message_id:'self'});e.incoming('主人回来啦',{message_id:'owner-live'});
 await until(()=>e.snapshot().sentVoice===1,'actual voice acknowledgment');const entries=e.entries();assert.equal(e.followups.length,1);assert.equal(entries.filter(x=>x.direction==='in').length,1);
 assert.equal(entries.find(x=>x.direction==='in').text,'主人回来啦');const voice=entries.find(x=>x.direction==='out'&&x.kind==='voice');assert.ok(voice);assert.equal(voice.status,'sent');assert.equal(voice.text,'主人，我在这里陪你呢。');assert.equal(voice.audioBytes,9);
 assert.deepEqual(voice.delivery,{mode:'model',emotion:'warm',cached:false,preparationMs:95});assert.doesNotMatch(JSON.stringify(entries),/不记录|never-visible|test-wave|base64:\/\//);
 assert.ok(entries.every(x=>Number.isFinite(Date.parse(x.at))&&Number.isFinite(Date.parse(x.updatedAt))));
});

test('history and repeated live delivery share message-id identity instead of duplicating monitor entries',async t=>{
 const e=await environment(t,{history:[historical('shared-id','20002')]});await e.ready();await e.loaded();
 e.incoming('已保存的私聊',{message_id:'shared-id'});e.incoming('已保存的私聊',{message_id:'shared-id'});await until(()=>e.snapshot().sentVoice===1,'single accepted turn');
 assert.equal(e.followups.length,1);assert.equal(e.entries().filter(x=>x.direction==='in'&&x.messageId==='shared-id').length,1);
});

test('monitor retention is capped at 200 entries, expires after seven days, and survives reopening',async t=>{
 const e=await environment(t,{keepRoot:true,holdTurn:true});await e.ready();await e.loaded();e.agent.status='running';
 for(let i=0;i<220;i++)e.incoming('监控消息'+i,{message_id:'bounded-'+i});
 await until(()=>e.snapshot().received===220,'all owner arrivals',6000);await e.persisted();assert.equal(e.entries().length,200);assert.equal(e.entries().some(x=>x.messageId==='bounded-0'),false);
 const onDisk=JSON.parse(await readFile(join(e.root,'qq-monitor.json'),'utf8'));assert.equal(onDisk.entries.length,200);
 await e.dispose();const reopened=await environment(t,{root:e.root,holdTurn:true,keepRoot:true});await reopened.ready();await reopened.loaded();assert.equal(reopened.entries().length,200);
 reopened.advance(7*86_400_000+1);reopened.agent.status='running';reopened.incoming('七天后的新消息',{message_id:'new-week'});await until(()=>reopened.entries().some(x=>x.messageId==='new-week'),'fresh monitor entry');await reopened.persisted();assert.equal(reopened.entries().length,1);
 await reopened.dispose();await rm(e.root,{recursive:true,force:true});
});

test('unpairing or changing owner hides prior history and ignores a delayed former-owner backfill',async t=>{
 let delayed;const e=await environment(t,{rpcResponse:(request,normal,ws)=>{if(request.action==='get_friend_msg_history'&&request.params.user_id==='20002'){delayed={request,ws};return null;}return normal;}});
 await e.ready();await until(()=>!!delayed,'first history request');assert.equal(e.snapshot().monitor.backfillState,'loading');
 await e.config.update({qq:{ownerId:'30003'}});await e.qq.reconcile();await e.ready();delayed.ws.message({status:'ok',retcode:0,echo:delayed.request.echo,data:{messages:[historical('old-secret','20002','text','旧主人的私密消息')]}});await e.loaded();assert.equal(e.entries().length,0);
 await e.config.update({qq:{ownerId:''}});await e.qq.reconcile();assert.equal(e.entries().length,0);
});

test('monitor redacts pairing codes, credentials, links, file paths and binary payloads before persistence',async t=>{
 const e=await environment(t,{qq:{voiceReplies:false}});await e.ready();await e.loaded();
 const secret='API_KEY=monitor-private-key password:monitor-password token=monitor-token {"token":"json-private-token","password":"json-private-password"} Authorization: Bearer fake-bearer-private-value Basic ZmFrZS1iYXNpYy1wcml2YXRl https://private.example/?signature=monitor-signature /Users/private/voice.wav 缓存位于/Users/private/embedded.wav base64://U0VDUkVU private-gateway-token '+('鱼'.repeat(1000));
 e.incoming(secret,{message_id:'sensitive'});await until(()=>e.snapshot().sentText===1);const nonce='A0F478E55A46D04D70C83ED6';e.incoming('配对 '+nonce,{message_id:'control'});await until(()=>e.entries().some(x=>x.kind==='control'),'redacted control message');await e.persisted();
 const serialized=JSON.stringify(e.entries())+'\n'+await readFile(join(e.root,'qq-monitor.json'),'utf8');assert.doesNotMatch(serialized,/monitor-private-key|monitor-password|monitor-token|json-private-token|json-private-password|fake-bearer-private-value|ZmFrZS1iYXNpYy1wcml2YXRl|monitor-signature|private-gateway-token|private\.example|\/Users\/private|U0VDUkVU|A0F478E55A46D04D70C83ED6|base64:\/\//);assert.ok(e.entries().every(x=>x.text.length<=800));assert.equal(e.followups.length,1);
});

test('rejected or unconfirmed voice sends never appear as sent and do not cause automatic duplicate transmission',async t=>{
 for(const uncertain of [false,true]){
  const e=await environment(t,{rpcTimeoutMs:10,rpcResponse:(request,normal)=>request.action==='send_private_msg'&&(uncertain||request.params.message?.[0]?.type==='record')?(uncertain?null:{status:'failed',retcode:1200,message:'private-rpc-details'}):normal});await e.ready();await e.loaded();e.incoming('说一句',{message_id:'failure-'+uncertain});
  await until(()=>e.entries().some(x=>x.direction==='out'&&x.kind==='voice'&&x.status===(uncertain?'uncertain':'failed')),'voice failure monitor');const voice=e.entries().find(x=>x.direction==='out'&&x.kind==='voice');assert.notEqual(voice.status,'sent');assert.equal(e.snapshot().sentVoice,0);assert.doesNotMatch(JSON.stringify(e.entries()),/private-rpc-details/);
  if(uncertain){await pause(20);assert.equal(e.calls.filter(x=>x.action==='send_private_msg').length,1);}else await until(()=>e.snapshot().sentText===1,'explicit rejection text fallback');
 }
});

test('owner changes cancel pending synthesis without leaking late text or voice into the new owner monitor',async t=>{
 let finish;const e=await environment(t,{synthesize:()=>new Promise(resolve=>{finish=resolve;})});await e.ready();await e.loaded();e.incoming('旧主人的待回声音',{message_id:'old-synthesis'});await until(()=>e.speechCalls.length===1);assert.ok(e.entries().some(x=>x.status==='synthesizing'));
 await e.config.update({qq:{ownerId:'30003',voiceReplies:false}});await e.qq.reconcile();await e.ready();await e.loaded();assert.equal(e.entries().length,0);finish({audio:Buffer.from('late-private-wave'),delivery:{mode:'model',emotion:'sad'}});await pause(15);assert.equal(e.entries().length,0);assert.equal(e.calls.filter(x=>x.action==='send_private_msg').length,0);
});

test('monitor storage failures leave the QQ dialogue working with a safe monitoring error',async t=>{
 const e=await environment(t,{corruptMonitor:true});await e.ready();await e.loaded();e.incoming('监控不可写时也能聊',{message_id:'storage-failure'});await until(()=>e.snapshot().sentVoice===1);assert.equal(e.followups.length,1);await until(()=>!!e.snapshot().monitor.error,'safe storage error');assert.doesNotMatch(JSON.stringify(e.snapshot().monitor),/EISDIR|qq-monitor\.json|private-gateway-token/);
});

test('disposing during a monitor commit preserves later arrivals and their final cancellation status',async t=>{
 const original=JsonStore.prototype.mutate;let release,held=false;
 JsonStore.prototype.mutate=function(change){
  if(this.path.endsWith('/qq-monitor.json')&&!held){held=true;return new Promise((resolve,reject)=>{release=()=>{release=undefined;return original.call(this,change).then(resolve,reject);};});}
  return original.call(this,change);
 };
 t.after(()=>{JsonStore.prototype.mutate=original;release?.();});
 const e=await environment(t,{holdTurn:true});await e.ready();await e.loaded();e.agent.status='running';
 e.incoming('第一条排队',{message_id:'commit-first'});await until(()=>held,'held monitor disk commit');
 e.incoming('第二条排队',{message_id:'commit-second'});await until(()=>e.snapshot().received===2,'second queued arrival');
 e.qq.dispose();release();await e.persisted();
 const saved=JSON.parse(await readFile(join(e.root,'qq-monitor.json'),'utf8'));
 assert.equal(saved.entries.length,2);assert.ok(saved.entries.every(entry=>entry.status==='cancelled'));
});

test('reopening marks interrupted monitor work as uncertain without replaying it to the Agent or QQ',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-qq-monitor-reopen-'));
 const at=new Date(1_800_000_000_000).toISOString();
 const entries=['queued','replying','synthesizing','sent','failed'].map((status,index)=>({id:'restart-'+status,botId:'10001',ownerId:'20002',ordinal:index+1,at,updatedAt:at,direction:index<3?'in':'out',kind:'text',status,text:'重开状态 '+status,messageId:'restart-message-'+index}));
 await writeFile(join(root,'qq-monitor.json'),JSON.stringify({version:1,entries}));
 const e=await environment(t,{root});await e.ready();await e.loaded();
 for(const status of ['queued','replying','synthesizing']){
  const entry=e.entries().find(item=>item.id==='restart-'+status);assert.equal(entry.status,'uncertain');assert.equal(entry.error,'上次运行结果未记录，请核对QQ聊天');
 }
 for(const status of ['sent','failed'])assert.equal(e.entries().find(item=>item.id==='restart-'+status).status,status);
 await e.persisted();const saved=JSON.parse(await readFile(join(root,'qq-monitor.json'),'utf8'));
 assert.equal(saved.entries.filter(entry=>entry.status==='uncertain').length,3);
 assert.equal(e.followups.length,0);assert.equal(e.speechCalls.length,0);assert.equal(e.calls.filter(call=>call.action==='send_private_msg').length,0);
});
