import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({resolve(specifier,context,next){
  if(specifier==='@deepseek-ai/dsh-credentials')return {url:'data:text/javascript,export const credentialRef = name => ({name});',shortCircuit:true};
  return next(specifier,context);
}});
const {installQQ}=await import('../lib/qq.js');
const pause=(ms=2)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label='condition'){for(let i=0;i<250;i++){if(fn())return;await pause();}assert.fail('Timed out: '+label);}
async function environment(t,options={}){
  const root=options.root??await mkdtemp(join(tmpdir(),'dafeiyu-qq-groups-'));
  let time=1_800_000_000_000,message=0,sequence=0,outgoingId=900;
  const configValue={qq:{enabled:true,wsUrl:'ws://127.0.0.1:13001',botId:'10001',ownerId:'20002',sessionId:'private-session',voiceReplies:true,groups:[{id:'50005',name:'四人群',enabled:true}],...options.qq}};
  const config={get:()=>structuredClone(configValue),async update(patch){configValue.qq={...configValue.qq,...patch.qq};return this.get();}};
  const listeners=new Map(),agents=new Map(),calls=[],sockets=[],followups=[],speechCalls=[],ensured=[];
  function makeAgent(id,preset='whale-group'){
    const events=[];const session={id,header:{agentPreset:preset},snapshotEvents:()=>events};
    const agent={id,session,status:'idle',followup(input){followups.push({sessionId:id,message:input});agent.status='running';if(!options.holdTurn)queueMicrotask(()=>complete(agent,input));}};
    agents.set(id,agent);return agent;
  }
  const owner=makeAgent('private-session','whale');
  const emit=(agent,type,data)=>{const event={type,data,seq:++sequence,time};agent.session.snapshotEvents().push(event);for(const fn of listeners.get('session/event')??[])fn(agent.session,event);};
  function complete(agent=agents.get(followups.at(-1)?.sessionId),input=followups.at(-1)?.message,{foreign=false,reason='completed'}={}){
    emit(agent,'turn/start',{turn:sequence+1});emit(agent,'user/message',input);
    if(foreign)emit(agent,'user/message',{id:'foreign-input',source:{kind:'user'},content:[{type:'text',text:'另一个会话输入'}]});
    emit(agent,'assistant/message',{message:{content:[{type:'text',text:'你好呀，本鱼在这里呢。'}]}});agent.status='idle';emit(agent,'turn/end',{reason:{kind:reason}});
  }
  class Socket{
    constructor(url){this.url=url;this.readyState=0;this.listeners=new Map();sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.event('open',{});});}
    addEventListener(name,fn){const a=this.listeners.get(name)??[];a.push(fn);this.listeners.set(name,a);}
    event(name,value){for(const fn of this.listeners.get(name)??[])fn(value);}
    incoming(value){this.event('message',{data:JSON.stringify(value)});}
    close(){if(this.readyState===3)return;this.readyState=3;this.event('close',{});}
    send(raw){
      const req=JSON.parse(raw);calls.push(req);
      const data=req.action==='get_login_info'?{user_id:'10001'}:req.action==='get_status'?{online:true}:req.action==='get_friend_msg_history'?{messages:[]}:req.action==='get_group_list'?(options.groups??[{group_id:50005,group_name:'四人群',member_count:4}]):{message_id:++outgoingId};
      let res={status:'ok',retcode:0,data};if(options.rpc)res=options.rpc(req,res,this);
      if(res)queueMicrotask(()=>this.incoming({...res,echo:req.echo}));
    }
  }
  const ctx={agents:{get:id=>agents.get(id)},credentials:{resolve:async()=>({value:'private-token'})},on(name,fn){const a=listeners.get(name)??[];a.push(fn);listeners.set(name,a);return()=>listeners.set(name,(listeners.get(name)??[]).filter(x=>x!==fn));},effect(fn){fn();}};
  const groupConversations=options.noGroups?undefined:{async ensure(input){ensured.push(input);if(options.ensure)return options.ensure(input,{agents,makeAgent});const id='group-'+input.groupId+'-member-'+input.senderId;if(!agents.has(id))makeAgent(id);return {sessionId:id};}};
  const speech={async synthesize(text,details){speechCalls.push({text,details});if(options.synthesize)return options.synthesize(text,details);return {audio:Buffer.from('group-wave'),delivery:{mode:'model',emotion:'warm'}};}};
  const qq=installQQ(ctx,{config,speech,root,groupConversations,stickers:options.stickers,mediaPrepare:options.mediaPrepare,WebSocketImpl:Socket,makeMessage:input=>({...input,id:'sdk-'+(++message)}),now:()=>time,rpcTimeoutMs:options.rpcTimeoutMs??30,retryDelayMs:1000,turnTimeoutMs:1800,groupPrepareTimeoutMs:options.groupPrepareTimeoutMs??30000});
  const incoming=(extra={})=>sockets.at(-1).incoming({post_type:'message',message_type:'group',sub_type:'normal',self_id:'10001',user_id:'30003',group_id:'50005',message_id:'in-'+(++message),time:Math.floor(time/1000),message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:' 在吗？'}}],...extra});
  const sends=()=>calls.filter(x=>['send_group_msg','send_private_msg'].includes(x.action));
  const changePreset=(id,preset)=>{const a=agents.get(id);a.session.header.agentPreset=preset;for(const fn of listeners.get('agent-preset/selected')??[])fn(id);};
  t.after(async()=>{qq.dispose();await pause(35);if(!options.keepRoot)await rm(root,{recursive:true,force:true});});
  return {root,qq,config,owner,agents,calls,sockets,followups,speechCalls,ensured,incoming,sends,complete,emit,changePreset,advance:n=>{time+=n;},ready:()=>until(()=>qq.snapshot().connected,'connected')};
}

test('a real group mention from any member uses a group-member session and sends voice only to that group',async t=>{
  const e=await environment(t);await e.ready();e.incoming();await until(()=>e.sends().length===1,'group reply');
  assert.deepEqual(e.ensured,[{groupId:'50005',senderId:'30003'}]);assert.equal(e.followups[0].sessionId,'group-50005-member-30003');
  assert.equal(e.followups[0].message.content[0].text,'在吗？');assert.equal(e.speechCalls[0].details.sessionId,'group-50005-member-30003');
  assert.equal(e.sends()[0].action,'send_group_msg');assert.equal(e.sends()[0].params.group_id,'50005');assert.equal(e.sends()[0].params.message[0].type,'record');
  assert.equal(e.qq.snapshot().monitor.entries.length,0);assert.equal(e.qq.snapshot().sentVoice,0);assert.equal(e.qq.snapshot().groupActivity.sentVoice,1);
});

test('ordinary text, fake mentions, at-all, quoted mentions, other bots and unapproved groups never enter an agent',async t=>{
  const e=await environment(t);await e.ready();
  for(const extra of [
    {message:[{type:'text',data:{text:'@小鲸鱼 在吗'}}]},
    {message:[{type:'text',data:{text:'[CQ:at,qq=10001] 在吗'}}]},
    {message:[{type:'at',data:{qq:'all'}},{type:'text',data:{text:'大家好'}}]},
    {message:[{type:'reply',data:{id:'quoted',message:[{type:'at',data:{qq:'10001'}}]}},{type:'text',data:{text:'引用'}}]},
    {message:[{type:'at',data:{qq:'99999'}},{type:'text',data:{text:'其他人'}}]},
    {group_id:'60006'},{user_id:'10001'},{self_id:'99999'},{sub_type:'anonymous'},{anonymous:{id:'someone'}},
    {post_type:'message_sent'},{time:1_799_999_999},{time:1_800_000_061},
  ])e.incoming(extra);
  await pause(35);assert.equal(e.ensured.length,0);assert.equal(e.followups.length,0);assert.equal(e.sends().length,0);
});

test('group setup fails closed without a group service or if it returns the private session',async t=>{
  for(const options of [{noGroups:true},{ensure:async()=>({sessionId:'private-session'})}]){
    const e=await environment(t,options);await e.ready();e.incoming();await pause(35);assert.equal(e.followups.length,0);assert.equal(e.sends().length,0);
  }
});

test('members and groups have separate sessions and a service cannot reuse another member session',async t=>{
  const e=await environment(t,{qq:{groups:[{id:'50005',enabled:true},{id:'60006',enabled:true}]}});await e.ready();
  e.incoming({message_id:'same-id'});e.incoming({user_id:'40004',message_id:'same-id'});e.incoming({group_id:'60006',message_id:'same-id'});
  await until(()=>e.sends().length===3,'three isolated replies');assert.equal(new Set(e.followups.map(x=>x.sessionId)).size,3);
  assert.deepEqual(e.sends().map(x=>x.params.group_id),['50005','50005','60006']);
  const b=await environment(t,{ensure:async(_input,{agents,makeAgent})=>{if(!agents.has('shared'))makeAgent('shared');return {sessionId:'shared'};}});await b.ready();b.incoming();await until(()=>b.sends().length===1);b.incoming({user_id:'40004'});await pause(30);assert.equal(b.followups.length,1);
});

test('group message identities are deduplicated independently of private messages and survive reload',async t=>{
  const e=await environment(t,{keepRoot:true});await e.ready();e.incoming({message_id:'repeat'});e.incoming({message_id:'repeat'});await until(()=>e.sends().length===1);
  e.incoming({message_type:'private',sub_type:'friend',user_id:'20002',message_id:'repeat',message:[{type:'text',data:{text:'私聊同一ID'}}]});await until(()=>e.sends().length===2);assert.equal(e.sends()[1].action,'send_private_msg');
  const saved=JSON.parse(await readFile(join(e.root,'qq-state.json'),'utf8'));assert.equal(saved.messages.length,2);
  e.qq.dispose();const b=await environment(t,{root:e.root,keepRoot:true});await b.ready();b.incoming({message_id:'repeat'});await pause(30);assert.equal(b.followups.length,0);await rm(e.root,{recursive:true,force:true});
});

test('removing a group during voice preparation suppresses a late group delivery',async t=>{
  let release;const e=await environment(t,{synthesize:()=>new Promise(resolve=>{release=resolve;})});await e.ready();e.incoming();await until(()=>!!release,'voice preparation');
  await e.config.update({qq:{groups:[]}});await e.qq.reconcile();release({audio:Buffer.from('late-wave')});await pause(35);assert.equal(e.sends().length,0);
});

test('leaving the private preset cancels only private work and retains a queued group reply',async t=>{
  const e=await environment(t,{holdTurn:true});await e.ready();e.incoming({message_type:'private',sub_type:'friend',user_id:'20002',message:[{type:'text',data:{text:'私人请求'}}]});await until(()=>e.followups.length===1);
  e.incoming();await until(()=>e.ensured.length===1);e.changePreset('private-session','standard');await until(()=>e.followups.length===2,'group after private cancellation');
  e.complete();await until(()=>e.sends().length===1);assert.equal(e.sends()[0].action,'send_group_msg');
});

test('a foreign message in a group turn cannot be forwarded to the group',async t=>{
  const e=await environment(t,{holdTurn:true});await e.ready();e.incoming();await until(()=>e.followups.length===1);e.complete(undefined,undefined,{foreign:true});await pause(30);assert.equal(e.sends().length,0);
});

test('group text fallback mentions its actual sender and never appears in private monitoring',async t=>{
  const e=await environment(t,{synthesize:async()=>{throw Error('private-details');}});await e.ready();e.incoming();await until(()=>e.sends().length===1);
  const send=e.sends()[0];assert.equal(send.action,'send_group_msg');assert.equal(send.params.message[0].type,'at');assert.equal(send.params.message[0].data.qq,'30003');assert.equal(send.params.message[1].type,'text');assert.equal(e.qq.snapshot().monitor.entries.length,0);
  assert.doesNotMatch(JSON.stringify(e.qq.snapshot()),/private-details/);
});

test('an uncertain group send is not retried or replaced by a second reply',async t=>{
  const e=await environment(t,{rpcTimeoutMs:8,rpc:(req,res)=>req.action==='send_group_msg'?null:res});await e.ready();e.incoming();await until(()=>e.sends().length===1);await pause(35);assert.equal(e.sends().length,1);assert.match(e.qq.snapshot().lastError,/未确认/);
});

test('group directory is read-only, validates metadata and rejects unverified connections',async t=>{
  const e=await environment(t,{groups:[{group_id:50005,group_name:'四人群',member_count:4},{group_id:50005,group_name:'重复',member_count:5},{group_id:'invalid',group_name:'坏数据'}]});await e.ready();
  assert.deepEqual(await e.qq.listGroups(),[{id:'50005',name:'四人群',memberCount:4}]);assert.equal(e.followups.length,0);assert.equal(e.sends().length,0);assert.equal(e.calls.some(x=>x.action==='get_group_msg_history'),false);
  e.qq.dispose();await assert.rejects(e.qq.listGroups(),/连接/);
});

test('a disconnected group preparation cannot block a later verified connection',async t=>{
  let first=true,release;
  const e=await environment(t,{ensure:async(input,{makeAgent,agents})=>{
    if(first){first=false;return await new Promise(resolve=>{release=resolve;});}
    const id='reconnected-group';if(!agents.has(id))makeAgent(id);return {sessionId:id};
  }});await e.ready();e.incoming();await until(()=>!!release,'preparing group');
  await e.config.update({qq:{groups:[{id:'50005',name:'已更新群名',enabled:true}]}});await e.qq.reconcile();await e.ready();e.incoming({message_id:'after-reconnect'});
  await until(()=>e.sends().length===1,'fresh group reply');release({sessionId:'private-session'});await pause(20);assert.equal(e.sends().length,1);assert.equal(e.sends()[0].action,'send_group_msg');
});

test('a group service returning an ordinary companion session is rejected before followup',async t=>{
  const e=await environment(t,{ensure:async(_input,{makeAgent})=>{makeAgent('unsafe-companion','whale');return {sessionId:'unsafe-companion'};}});await e.ready();e.incoming();await pause(25);assert.equal(e.followups.length,0);assert.equal(e.sends().length,0);
});


test('a timed-out group preparation releases intake without forwarding a late result',async t=>{
  let release;const e=await environment(t,{groupPrepareTimeoutMs:8,ensure:async()=>new Promise(resolve=>{release=resolve;})});await e.ready();e.incoming();await until(()=>!!release);
  e.incoming({message_type:'private',sub_type:'friend',user_id:'20002',message_id:'after-timeout',message:[{type:'text',data:{text:'仍可私聊'}}]});
  await until(()=>e.sends().length===1,'private reply after group timeout');assert.equal(e.sends()[0].action,'send_private_msg');release({sessionId:'private-session'});await pause(15);assert.equal(e.followups.length,1);
});


test('a group mention with only an image can receive its own voice and selected sticker',async t=>{
 const prepared=[];const e=await environment(t,{holdTurn:true,mediaPrepare:async(_ctx,agent,parsed)=>{prepared.push(agent.id);return {content:[{type:'image',attachment:{attachmentId:'fixture'}}],media:[]};},stickers:{list:async()=>[{id:'joyful',title:'嘿嘿！'}],read:async()=>({id:'joyful',bytes:Buffer.from('validated-group-sticker'),mime:'image/png',summary:'嘿嘿！'})}});
 await e.ready();e.incoming({message:[{type:'at',data:{qq:'10001'}},{type:'image',data:{url:'https://gchat.qpic.cn/group.png'}}]});await until(()=>e.followups.length===1,'group image');
 const {sessionId,message}=e.followups[0],agent=e.agents.get(sessionId);assert.equal(message.content[0].type,'image');assert.deepEqual(prepared,[sessionId]);
 e.emit(agent,'turn/start',{turn:700});e.emit(agent,'user/message',message);await e.qq.chooseSticker(agent,'joyful');
 e.emit(agent,'assistant/message',{message:{content:[{type:'text',text:'嘿嘿，这张好可爱呀。'}]}});agent.status='idle';e.emit(agent,'turn/end',{reason:{kind:'completed'}});
 await until(()=>e.sends().length===2,'group voice and sticker');assert.ok(e.sends().every(x=>x.action==='send_group_msg'&&x.params.group_id==='50005'));assert.equal(e.sends()[1].params.message[0].type,'image');assert.equal(e.qq.snapshot().groupActivity.sentSticker,1);assert.equal(e.qq.snapshot().sentSticker,0);assert.equal(e.qq.snapshot().monitor.entries.length,0);
});

test('group images still require a true mention and enabled group before media preparation',async t=>{
 let prepared=0;const e=await environment(t,{mediaPrepare:async()=>{prepared++;return {content:[],media:[]};}});await e.ready();
 const image={type:'image',data:{url:'https://gchat.qpic.cn/group.png'}};
 for(const value of [{group_id:'60006',message:[{type:'at',data:{qq:'10001'}},image]},{message:[image]},{message:[{type:'text',data:{text:'@大肥鱼'}},image]},{message:[{type:'at',data:{qq:'all'}},image]}])e.incoming(value);
 await pause(30);assert.equal(prepared,0);assert.equal(e.ensured.length,0);assert.equal(e.followups.length,0);assert.equal(e.sends().length,0);
});

test('automatic group stickers accompany replies and recent choices remain isolated per group member',async t=>{
 const rows=[{id:'warm-a',title:'本鱼在呢',emotion:'warm',tags:['generic']},{id:'warm-b',title:'陪你呀',emotion:'warm',tags:['generic']}];
 const stickers={list:async()=>rows,read:async id=>({id,bytes:Buffer.from('sticker-'+id),mime:'image/png',summary:'本鱼在呢'})};
 const e=await environment(t,{stickers});await e.ready();
 for(const [index,user_id]of ['30003','30003','40004'].entries()){e.incoming({user_id,message_id:'automatic-group-'+index});await until(()=>e.sends().length===(index+1)*2,'automatic group sticker');}
 const image=e.sends().filter(r=>r.params.message[0].type==='image'),ids=image.map(r=>Buffer.from(r.params.message[0].data.file.slice(9),'base64').toString());
 assert.deepEqual(ids,['sticker-warm-a','sticker-warm-b','sticker-warm-a']);assert.ok(e.sends().every(r=>r.action==='send_group_msg'&&r.params.group_id==='50005'));assert.equal(e.qq.snapshot().groupActivity.sentSticker,3);assert.equal(e.qq.snapshot().sentSticker,0);assert.equal(e.qq.snapshot().monitor.entries.length,0);
});
