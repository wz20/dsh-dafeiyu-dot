import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {JsonStore} from './storage.js';
import {MemoryStore} from './memory.js';
import {installMemoryLifecycle} from './memory-lifecycle.js';
import {currentPreset,isRoot,resolveAgent} from './session.js';

const validId=value=>typeof value==='string'&&/^[1-9]\d{4,19}$/.test(value);
const failure=message=>Object.assign(Error(message),{status:409});

/** A persistent group/member identity always owns its own history and palace. */
export function createGroupConversations(ctx,{config,root,palaceRoot,onReady=()=>{},installLifecycle=installMemoryLifecycle}={}) {
  let registry,error,disposed=false,lastError=null;
  let diagnostic;try{diagnostic=new JsonStore(join(root,'qq-group-status.json'),{});}catch{}
  const records=new Map(),sessions=new Map(),stores=new Map(),lifecycles=new Map(),pending=new Map(),scopeErrors=new Map();
  const keyOf=(groupId,senderId)=>groupId+':'+senderId;
  const enabled=groupId=>config.get()?.qq?.enabled!==false&&config.get()?.qq?.groups?.some(g=>g.id===groupId&&g.enabled===true)===true;
  try {
    registry=new JsonStore(join(root,'qq-group-sessions.json'),{version:1,members:[]});
    const rows=registry.get().members;
    if(!Array.isArray(rows))throw Error('Invalid group registry');
    for(const row of rows){
      if(!validId(row.groupId)||!validId(row.senderId)||typeof row.sessionId!=='string'||!row.sessionId||row.sessionId.length>200)throw Error('Invalid group identity');
      const key=keyOf(row.groupId,row.senderId);
      if(records.has(key)||sessions.has(row.sessionId))throw Error('Duplicate group identity');
      records.set(key,row);sessions.set(row.sessionId,row);
    }
  } catch {records.clear();sessions.clear();error='群聊会话记录暂时无法读取，私人会话不受影响。';}

  function admit(agent,row) {
    if(disposed||error||!row||!enabled(row.groupId)||!isRoot(agent)||currentPreset(agent.session)!=='whale-group'||sessions.get(agent.id)!==row)
      throw failure('这个群成员的独立会话尚未启用。');
  }
  function storeFor(row) {
    const key=keyOf(row.groupId,row.senderId);
    if(!stores.has(key)){
      try{
        const store=new MemoryStore(join(root,'groups',row.groupId,'members',row.senderId,'memories.json'),{palaceRoot:join(palaceRoot,'groups',row.groupId,'members',row.senderId)});
        const lifecycle=installLifecycle(ctx,store,()=>config.get(),{acceptAgent:agent=>{
          try{admit(agent,row);return agent.id===row.sessionId;}catch{return false;}
        },ownsAgent:agent=>sessions.get(agent.id)===row&&agent.id===row.sessionId});
        stores.set(key,store);lifecycles.set(key,lifecycle);scopeErrors.delete(key);
      }catch{scopeErrors.set(key,true);throw failure('这个群成员的记忆暂时无法读取。');}
    }
    return stores.get(key);
  }
  function resolveStore(agent,ownerStore) {
    const row=sessions.get(agent?.id);
    if(row||currentPreset(agent?.session)==='whale-group'){admit(agent,row);return storeFor(row);}
    return ownerStore;
  }
  async function ensure({groupId,senderId},{signal}={}) {
    signal?.throwIfAborted();
    if(disposed||error||!validId(groupId)||!validId(senderId)||!enabled(groupId))throw failure('请先启用这个QQ群。');
    const key=keyOf(groupId,senderId);
    if(pending.has(key))return waitFor(pending.get(key),signal);
    let stage='create-session';
    const operation=(async()=>{
      let row=records.get(key);
      if(!row){
        const cwd=join(root,'groups',groupId,'members',senderId);mkdirSync(cwd,{recursive:true,mode:0o700});
        const created=await ctx.sessionController.create({agentPreset:'whale-group',cwd});
        stage='resolve-created-session';
        signal?.throwIfAborted();
        if(!enabled(groupId)||disposed)throw failure('这个QQ群已停用。');
        const id=created?.sessionId,agent=await resolveAgent(ctx,id);
        if(!isRoot(agent)||currentPreset(agent.session)!=='whale-group'||sessions.has(id))throw failure('群聊需要全新的独立陪伴会话。');
        signal?.throwIfAborted();
        row={groupId,senderId,sessionId:id,createdAt:new Date().toISOString()};
        await registry.mutate(value=>{signal?.throwIfAborted();if(!enabled(groupId)||disposed)throw failure('这个QQ群已停用。');value.members.push(row);return value;});
        records.set(key,row);sessions.set(row.sessionId,row);
      }
      stage='resolve-group-session';const agent=await resolveAgent(ctx,row.sessionId);signal?.throwIfAborted();admit(agent,row);
      storeFor(row);onReady();signal?.throwIfAborted();
      lastError=null;
      void diagnostic?.mutate(()=>({at:new Date().toISOString(),ready:true,lastError:null})).catch(()=>{});
      return {sessionId:row.sessionId};
    })().catch(cause=>{
      if(!signal?.aborted){
        const detail=String(cause?.message??'').replace(/\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:access[_-]?token|password|secret)\s*[:=]\s*\S+/gi,'[已隐藏]').replace(/(?:https?|file):\/\/\S+/g,'[链接已隐藏]').slice(0,700);
        lastError={stage,code:String(cause?.code??cause?.name??'GROUP_UNAVAILABLE').slice(0,100),detail};
        void diagnostic?.mutate(()=>({at:new Date().toISOString(),lastError})).catch(()=>{});
      }
      throw cause;
    });
    pending.set(key,operation);
    const cleanup=()=>{if(pending.get(key)===operation)pending.delete(key);};operation.then(cleanup,cleanup);
    return waitFor(operation,signal);
  }
  async function waitFor(operation,signal){
    signal?.throwIfAborted();if(!signal)return operation;
    let abort;const cancelled=new Promise((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([operation,cancelled]);}finally{signal.removeEventListener('abort',abort);}
  }
  async function reconcile() {
    for(const row of records.values())try{storeFor(row);}catch{}
    const q=config.get()?.qq;
    if(q?.enabled&&validId(q.ownerId))for(const group of q.groups??[])if(group.enabled)try{await ensure({groupId:group.id,senderId:q.ownerId});}catch{}
    await Promise.allSettled([...lifecycles.values()].map(l=>l.reconcile()));onReady();
  }
  function isGroupSession(id){return sessions.has(id)||currentPreset(ctx.agents.get(id)?.session)==='whale-group';}
  async function checkpoint(agent,options){const row=sessions.get(agent?.id);if(!row)throw failure('群成员记忆归属尚未确认，补存已停止。');storeFor(row);return lifecycles.get(keyOf(row.groupId,row.senderId)).checkpoint(agent,options);}
  function dispose(){disposed=true;for(const l of lifecycles.values())l.dispose();}
  ctx.effect(()=>dispose);
  for(const row of records.values())try{storeFor(row);}catch{}
  return {ensure,resolveStore,reconcile,isGroupSession,checkpoint,dispose,snapshot:()=>({sessions:records.size,unavailableMemories:scopeErrors.size,lastError,...error?{error}:{}})};
}
