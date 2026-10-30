import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGroupConversations} from '../lib/group-conversations.js';
import {MemoryStore} from '../lib/memory.js';

async function environment(){
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-group-checkpoint-')),agents=new Map(),handlers=new Map();
  const values={memory:{enabled:true},qq:{enabled:true,groups:[{id:'40004',enabled:true},{id:'50005',enabled:true}]}};
  const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},effect:()=>{},on(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return()=>handlers.get(name).delete(fn)},llm:{async *stream(){yield {type:'text-delta',text:'{"facts":[]}'};yield {type:'finish',reason:{kind:'stop'}}}},sessionController:{async create(spec){
    const id='group-session-'+agents.size,log=[],session={id,header:{agentPreset:spec.agentPreset},snapshotEvents:()=>[...log],requestHeader:()=>({config:{provider:'fixture',model:'fixture'}})};
    const agent={id,session,log};agents.set(id,agent);return {sessionId:id};
  }}};
  const groups=createGroupConversations(ctx,{root,palaceRoot:join(root,'palace'),config:{get:()=>values}}),owner=new MemoryStore(join(root,'owner.json'));
  return{root,groups,owner,agents,values,emit(agent,event){agent.log.push(event);for(const fn of handlers.get('session/event')??[])fn(agent.session,event)},async dispose(){groups.dispose();await new Promise(resolve=>setTimeout(resolve,25));await rm(root,{recursive:true,force:true})}};
}
function turn(n,text){const time=Date.parse('2026-10-30T02:00:00Z')+n*1000;return[
  {type:'turn/start',time,data:{turn:n}},
  {type:'user/message',time:time+1,data:{id:'user-'+n,source:{kind:'user'},content:[{type:'text',text}]}},
  {type:'assistant/message',time:time+2,data:{message:{id:'assistant-'+n,content:[{type:'text',text:'嗯，听见啦。'}]}}},
  {type:'turn/end',time:time+3,data:{turn:n,reason:{kind:'completed'}}},
]}

test('compaction checkpoints route only to the mapped group and member palace',async()=>{
  const e=await environment();
  try{
    const a=await e.groups.ensure({groupId:'40004',senderId:'20002'}),b=await e.groups.ensure({groupId:'40004',senderId:'30003'}),c=await e.groups.ensure({groupId:'50005',senderId:'20002'});
    const agent=e.agents.get(a.sessionId);agent.log.push(...turn(1,'我喜欢热茶'));
    const result=await e.groups.checkpoint(agent,{waitMs:1000});assert.equal(result.durable,true);assert.equal(result.enqueued,1);
    const store=e.groups.resolveStore(agent,e.owner);assert.equal(store.get().jobs[0].source.userEventId,'user-1');assert.equal(store.get().jobs[0].source.sessionId,agent.id);
    for(const id of [b.sessionId,c.sessionId])assert.equal(e.groups.resolveStore(e.agents.get(id),e.owner).get().jobs.length,0);
    assert.equal(e.owner.get().jobs.length,0);
    await assert.rejects(e.groups.checkpoint({id:'unknown',session:{header:{agentPreset:'whale-group'}}}),/归属/);
  }finally{await e.dispose()}
});

test('disabling a group excludes its received text after re-enabling without falling back to owner memory',async()=>{
  const e=await environment();
  try{
    const a=await e.groups.ensure({groupId:'40004',senderId:'20002'}),agent=e.agents.get(a.sessionId),store=e.groups.resolveStore(agent,e.owner);
    e.values.qq.groups[0].enabled=false;await e.groups.reconcile();
    for(const event of turn(1,'我喜欢热茶'))e.emit(agent,event);
    await e.groups.reconcile();e.values.qq.groups[0].enabled=true;await e.groups.reconcile();
    await e.groups.checkpoint(agent,{waitMs:1000});assert.equal(store.get().jobs.length,0);assert.equal(e.owner.get().jobs.length,0);
    assert.equal(store.isSourceExcluded({sessionId:agent.id,userEventId:'user-1'}),true);
    assert.doesNotMatch(await readFile(store.statePath,'utf8'),/我喜欢热茶/);
  }finally{await e.dispose()}
});
