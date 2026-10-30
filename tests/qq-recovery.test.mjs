import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

registerHooks({resolve(name,context,next){if(name==='@deepseek-ai/dsh-credentials')return{url:'data:text/javascript,export const credentialRef=name=>({name});',shortCircuit:true};return next(name,context)}});
const {installQQ}=await import('../lib/qq.js');
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
class Clock{
  now=1_800_000_000_000;next=0;tasks=new Map();
  setTimeout(fn,delay=0){const id={value:++this.next,unref(){return this}};this.tasks.set(id,{fn,at:this.now+Math.max(0,delay)});return id;}
  clearTimeout(id){this.tasks.delete(id);}
  async tick(ms){const target=this.now+ms;for(let guard=0;guard<500;guard++){const next=[...this.tasks].filter(([,x])=>x.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){this.now=target;await settle();return}this.now=next[1].at;this.tasks.delete(next[0]);next[1].fn();await settle();}assert.fail('timer loop did not settle');}
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-qq-recovery-')),clock=new Clock(),sockets=[],calls=[],handlers=new Map(),log=[],followups=[];let constructorCalls=0;
  const settings={qq:{enabled:true,wsUrl:'ws://127.0.0.1:13001',botId:'10001',ownerId:'20002',sessionId:'fixture-session',voiceReplies:false,stickerReplies:false}};
  const config={get:()=>structuredClone(settings),async update(patch){settings.qq={...settings.qq,...patch.qq};return this.get()}};
  const session={id:'fixture-session',header:{agentPreset:'whale'},snapshotEvents:()=>[...log]};
  const agent={id:session.id,status:'idle',session,followup(input){followups.push(input);agent.status='running'}};
  const emit=(type,data)=>{const event={type,data,time:clock.now,seq:log.length};log.push(event);for(const fn of handlers.get('session/event')??[])fn(session,event)};
  class Socket{
    constructor(url){constructorCalls++;if(options.constructorThrows?.(constructorCalls))throw Error('transport details');this.url=url;this.readyState=0;this.handlers=new Map();sockets.push(this);if(options.open!==false)queueMicrotask(()=>this.open());}
    addEventListener(name,fn){const list=this.handlers.get(name)??[];list.push(fn);this.handlers.set(name,list)}
    event(name,value={}){for(const fn of this.handlers.get(name)??[])fn(value)}
    open(){if(this.readyState!==0)return;this.readyState=1;this.event('open')}
    message(event){this.event('message',{data:JSON.stringify(event)})}
    close(){if(this.readyState===3)return;this.readyState=3;this.event('close')}
    send(raw){const req=JSON.parse(raw);calls.push({...req,socket:this});let data=req.action==='get_login_info'?{user_id:'10001'}:req.action==='get_status'?{online:true,good:true}:req.action==='get_friend_msg_history'?{messages:[]}:{message_id:calls.length};let response={status:'ok',retcode:0,data};if(options.respond)response=options.respond(req,response,this);if(response)queueMicrotask(()=>this.message({...response,echo:req.echo}))}
  }
  const ctx={agents:{get:id=>id===agent.id?agent:undefined},credentials:{resolve:async()=>({value:'fixture-token'})},on(name,fn){const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list);return()=>handlers.set(name,(handlers.get(name)??[]).filter(x=>x!==fn))},effect(fn){fn()}};
  const qq=installQQ(ctx,{config,speech:{synthesize:async()=>{throw Error('speech must stay unused')}},root,WebSocketImpl:Socket,makeMessage:input=>({...input,id:'fixture-user-'+followups.length}),now:()=>clock.now,timers:clock,connectTimeoutMs:100,healthIntervalMs:200,rpcTimeoutMs:50,retryDelayMs:20,retryMaxDelayMs:80});
  await settle();
  t.after(async()=>{qq.dispose();for(let i=0;i<100&&qq.snapshot().monitor.persisting;i++)await settle();await rm(root,{recursive:true,force:true})});
  return{qq,clock,sockets,calls,config,agent,followups,emit,constructors:()=>constructorCalls,incoming(id='fixture-input'){sockets.at(-1).message({post_type:'message',message_type:'private',sub_type:'friend',self_id:'10001',user_id:'20002',message_id:id,time:Math.floor(clock.now/1000),message:[{type:'text',data:{text:'你好'}}]})},complete(){emit('turn/start',{turn:1});emit('user/message',followups.at(-1));emit('assistant/message',{message:{id:'fixture-assistant',content:[{type:'text',text:'本鱼在呢。'}]}});agent.status='idle';emit('turn/end',{reason:{kind:'completed'}})}};
}

test('an unopened socket reaches a deadline, retries and ignores its late open event',async t=>{
  const e=await fixture(t,{open:false});assert.equal(e.qq.snapshot().phase,'connecting');await e.clock.tick(100);
  assert.equal(e.qq.snapshot().phase,'error');assert.equal(e.sockets[0].readyState,3);assert.match(e.qq.snapshot().lastError,/超时/);assert.equal(e.qq.snapshot().recovery.nextRetryAt,e.clock.now+20);
  e.sockets[0].event('open');await settle();assert.equal(e.calls.length,0);
  await e.clock.tick(20);assert.equal(e.sockets.length,2);e.sockets[1].open();await settle();assert.equal(e.qq.snapshot().connected,true);assert.equal(e.qq.snapshot().recovery.attempts,0);
});

test('active health checks detect a logged-out account even without a heartbeat',async t=>{
  let online=true;const e=await fixture(t,{respond:(req,normal)=>req.action==='get_status'?{...normal,data:{online,good:true}}:normal});assert.equal(e.qq.snapshot().connected,true);
  online=false;await e.clock.tick(200);assert.equal(e.qq.snapshot().connected,false);assert.match(e.qq.snapshot().lastError,/离线/);assert.equal(e.qq.snapshot().recovery.nextRetryAt,e.clock.now+20);
  assert.equal(e.followups.length,0);assert.equal(e.calls.some(x=>x.action.startsWith('send_')),false);
  online=true;await e.clock.tick(20);assert.equal(e.qq.snapshot().connected,true);assert.equal(e.qq.snapshot().paired,true);assert.equal(e.qq.snapshot().recovery.lastHealthyAt,e.clock.now);
});

test('a half-open gateway times out a health RPC and reconnects without overlapping checks',async t=>{
  let statusCalls=0;const e=await fixture(t,{respond:(req,normal)=>req.action==='get_status'&&++statusCalls>1?null:normal});assert.equal(e.qq.snapshot().connected,true);
  await e.clock.tick(200);assert.equal(e.qq.snapshot().recovery.checking,true);assert.equal(statusCalls,2);
  await e.clock.tick(49);assert.equal(statusCalls,2);assert.equal(e.qq.snapshot().connected,true);
  await e.clock.tick(1);assert.equal(e.qq.snapshot().connected,false);assert.match(e.qq.snapshot().lastError,/响应/);assert.equal(e.qq.snapshot().recovery.nextRetryAt,e.clock.now+20);
});

test('manual reconnect verifies a new socket with unchanged pairing and cancels the former health check',async t=>{
  let pending,statusCalls=0;const e=await fixture(t,{respond:(req,normal,ws)=>{if(req.action==='get_status'&&++statusCalls===2){pending={req,ws};return null}return normal}});
  await e.clock.tick(200);assert.ok(pending);const before=e.config.get();await e.qq.reconnect();await settle();assert.equal(e.sockets.length,2);assert.equal(e.qq.snapshot().connected,true);assert.deepEqual(e.config.get(),before);
  pending.ws.message({status:'ok',retcode:0,echo:pending.req.echo,data:{online:false}});await settle();assert.equal(e.qq.snapshot().connected,true);assert.equal(e.qq.snapshot().recovery.checking,false);
});

test('transport construction failures retry with capped backoff and disposal releases every timer',async t=>{
  const e=await fixture(t,{constructorThrows:()=>true});assert.equal(e.qq.snapshot().phase,'error');assert.equal(e.qq.snapshot().recovery.nextRetryAt,e.clock.now+20);
  for(const delay of [20,40,80,80]){await e.clock.tick(delay);assert.equal(e.qq.snapshot().recovery.nextRetryAt,e.clock.now+Math.min(delay*2,80));}
  assert.equal(e.constructors(),5);e.qq.dispose();assert.equal(e.clock.tasks.size,0);await e.clock.tick(1000);assert.equal(e.constructors(),5);
});

test('uncertain sends and old queued replies are never replayed after health recovery',async t=>{
  let online=true;const e=await fixture(t,{respond:(req,normal)=>req.action==='send_private_msg'?null:req.action==='get_status'?{...normal,data:{online}}:normal});
  e.incoming();for(let i=0;i<80&&!e.followups.length;i++)await settle();assert.equal(e.followups.length,1);e.complete();for(let i=0;i<80&&!e.calls.some(x=>x.action==='send_private_msg');i++)await settle();assert.equal(e.calls.filter(x=>x.action==='send_private_msg').length,1);
  online=false;await e.clock.tick(200);assert.equal(e.qq.snapshot().connected,false);online=true;await e.clock.tick(20);assert.equal(e.qq.snapshot().connected,true);assert.equal(e.sockets.length,2);e.incoming();for(let i=0;i<40;i++)await settle();assert.equal(e.followups.length,1);assert.equal(e.calls.filter(x=>x.action==='send_private_msg').length,1);
  await e.config.update({qq:{enabled:false}});await e.qq.reconcile();await e.clock.tick(500);assert.equal(e.qq.snapshot().phase,'disabled');assert.equal(e.sockets.length,2);
});

test('disposing during a pending health check releases its timeout and ignores a late reply',async t=>{
  let pending,statusCalls=0;const e=await fixture(t,{respond:(req,normal,ws)=>{if(req.action==='get_status'&&++statusCalls===2){pending={req,ws};return null}return normal}});
  await e.clock.tick(200);assert.equal(e.qq.snapshot().recovery.checking,true);e.qq.dispose();assert.equal(e.clock.tasks.size,0);
  pending.ws.message({status:'ok',retcode:0,echo:pending.req.echo,data:{online:true}});await e.clock.tick(1000);assert.equal(e.qq.snapshot().phase,'disabled');assert.equal(e.sockets.length,1);assert.equal(e.clock.tasks.size,0);
});

test('a changed account on an open gateway requires explicit confirmation instead of reconnecting another identity',async t=>{
  let identity='10001';const e=await fixture(t,{respond:(req,normal)=>req.action==='get_login_info'?{...normal,data:{user_id:identity}}:normal});assert.equal(e.qq.snapshot().connected,true);
  identity='30003';await e.clock.tick(200);assert.equal(e.qq.snapshot().connected,false);assert.match(e.qq.snapshot().lastError,/不一致/);assert.equal(e.qq.snapshot().recovery.nextRetryAt,null);assert.equal(e.qq.snapshot().botId,'10001');await e.clock.tick(500);assert.equal(e.sockets.length,1);assert.equal(e.config.get().qq.botId,'10001');
});
