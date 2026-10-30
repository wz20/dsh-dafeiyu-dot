import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {MemoryStore} from '../lib/memory.js'
import {installMemoryLifecycle,validateExtractedFacts} from '../lib/memory-lifecycle.js'

const base=Date.parse('2026-10-28T10:00:00Z')
function historyTurn(n,text='我住在北京',{reason='completed',tool=false,sourceKind='user',time=base+n*1000,content}={}) {
  return [
    {type:'turn/start',time,data:{turn:n}},
    {type:'user/message',id:'user-event-'+n,time:time+1,data:{id:'user-'+n,source:{kind:sourceKind},content:content??[{type:'text',text}]}},
    {type:'assistant/message',id:'assistant-event-'+n,time:time+2,data:{message:{id:'assistant-'+n,content:[{type:'text',text:'嗯，本鱼记下啦。'},...(tool?[{type:'tool-call',name:'unrelated'}]:[])]}}},
    ...(reason?[{type:'turn/end',time:time+3,data:{turn:n,reason:{kind:reason}}}]:[]),
  ]
}
const hold=(_llm,_source,_route,signal)=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
async function fixture({events=[],preset='whale',enabled=true,extractor,store:provided,acceptAgent,captureExisting=true,initiallyLoaded=true}={}) {
  const dir=await mkdtemp(join(tmpdir(),'dafeiyu-checkpoint-')),store=provided??new MemoryStore(join(dir,'cache.json'),{palaceRoot:join(dir,'palace')})
  const handlers=new Map(),effects=[],config={memory:{enabled}},log=[...events]
  const session={id:'private-a',header:{agentPreset:preset},snapshotEvents:()=>[...log],requestHeader:()=>({config:{provider:'companion-provider',model:'companion-model'}})}
  const agent={id:session.id,session,status:'idle'}
  const ctx={llm:{},agents:{list:()=>initiallyLoaded?[agent]:[],get:id=>id===agent.id?agent:undefined},on(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return()=>handlers.get(name).delete(fn)},effect(fn){effects.push(fn())}}
  const actualExtractor=extractor??(async(_llm,source)=>validateExtractedFacts({facts:[{spaceId:'owner',subject:'用户',predicate:'居住城市',value:'北京',evidence:'我住在北京'}]},source))
  const lifecycle=installMemoryLifecycle(ctx,store,()=>config,{extractor:actualExtractor,acceptAgent,captureExisting,retryDelaysMs:[1,1],timeoutMs:5000})
  return{dir,store,session,agent,config,log,lifecycle,created(){for(const fn of handlers.get('agent/created')??[])fn({agent})},emit(event){log.push(event);for(const fn of handlers.get('session/event')??[])fn(session,event)},async dispose(){lifecycle.dispose();await lifecycle.waitForIdle();await rm(dir,{recursive:true,force:true})}}
}

test('a checkpoint durably captures missed completed turns with original source identities before extraction',async()=>{
  const f=await fixture({events:historyTurn(1),extractor:hold})
  try{
    const result=await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    assert.equal(result.durable,true);assert.equal(result.enqueued,1)
    const job=f.store.get().jobs[0]
    assert.equal(job.source.userEventId,'user-1');assert.equal(job.source.assistantEventId,'assistant-1')
    assert.equal(job.source.observedAt,new Date(base+1001).toISOString())
    assert.equal(job.source.userText,'我住在北京');assert.equal(job.source.assistantText,'')
    assert.equal(job.route.model,'companion-model');assert.equal(f.store.search('北京').length,0)
    const reopened=new MemoryStore(join(f.dir,'other-cache.json'),{palaceRoot:join(f.dir,'palace')})
    assert.equal(reopened.get().jobs[0].source.userText,'我住在北京')
  }finally{await f.dispose()}
})

test('checkpoint replay and normal end-of-turn capture use one durable job and one fact',async()=>{
  const f=await fixture()
  try{
    for(const event of historyTurn(1))f.emit(event)
    await f.lifecycle.waitForIdle();assert.equal(f.store.status().memoryCount,1)
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    assert.equal(f.store.get().jobs.length,1);assert.equal(f.store.status().memoryCount,1)
    assert.equal(f.store.search('北京')[0].sources.length,1)
  }finally{await f.dispose()}
})

test('historical scanning follows the creation preset and selected modes instead of saving earlier coding turns',async()=>{
  const events=[...historyTurn(1),{type:'agent-preset/selected',data:{agentPreset:'whale'}},...historyTurn(2),{type:'agent-preset/selected',data:{agentPreset:'standard'}},...historyTurn(3),{type:'agent-preset/selected',data:{agentPreset:'whale'}}]
  const f=await fixture({preset:'standard',events,extractor:hold})
  try{await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.deepEqual(f.store.get().jobs.map(j=>j.source.userEventId),['user-2'])}finally{await f.dispose()}
})

test('cancelled, open, tool-only, internal and image-enrichment sources do not become backfilled facts',async()=>{
  const events=[...historyTurn(1,'我住在北京',{reason:'cancelled'}),...historyTurn(2,'我住在北京',{tool:true}),...historyTurn(3,'我住在北京',{sourceKind:'runtime-context'}),...historyTurn(4,'',{content:[{type:'text',text:'我住在北京',dafeiyuQQEnrichment:true},{type:'image',url:'data:image/png;...'}]}),...historyTurn(5,'我住在北京',{reason:null})]
  const f=await fixture({events})
  try{await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(f.store.get().jobs.length,0)}finally{await f.dispose()}
})

test('secrets, opt-outs and hypothetical statements stay outside the durable checkpoint queue',async()=>{
  const f=await fixture({events:[...historyTurn(1,'别记住，我住在北京'),...historyTurn(2,'假如我住在北京'),...historyTurn(3,'我的密码是 private-value，我住在北京')]})
  try{const result=await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(result.enqueued,0);assert.equal(f.store.get().jobs.length,0)}finally{await f.dispose()}
})

test('a queue write failure aborts checkpoint success and replay fills the gap without duplicating durable work',async()=>{
  const f=await fixture({events:[...historyTurn(1),...historyTurn(2)],extractor:hold});const create=f.store.createJob.bind(f.store);let failed=false
  f.store.createJob=async payload=>{if(payload.source.userEventId==='user-2'&&!failed){failed=true;throw Error('disk-unavailable')}return create(payload)}
  try{
    await assert.rejects(f.lifecycle.checkpoint(f.agent,{waitMs:0}),/记忆|保存|持久|disk/)
    assert.equal(f.store.get().jobs.length,1)
    const result=await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(result.durable,true)
    assert.deepEqual(f.store.get().jobs.map(j=>j.source.userEventId).sort(),['user-1','user-2'])
  }finally{await f.dispose()}
})

test('cancelling a checkpoint preserves sources already durably queued and replay can finish remaining sources',async()=>{
  const f=await fixture({events:[...historyTurn(1),...historyTurn(2)],extractor:hold});const controller=new AbortController(),create=f.store.createJob.bind(f.store)
  f.store.createJob=async payload=>{const job=await create(payload);controller.abort(new DOMException('Aborted','AbortError'));return job}
  try{
    await assert.rejects(f.lifecycle.checkpoint(f.agent,{signal:controller.signal,waitMs:0}),{name:'AbortError'})
    assert.equal(f.store.get().jobs.length,1)
    f.store.createJob=create;await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(f.store.get().jobs.length,2)
  }finally{await f.dispose()}
})

test('a backfilled older source cannot overwrite a more recent correction',async()=>{
  const f=await fixture({events:historyTurn(1)})
  try{
    await f.store.consolidate([{spaceId:'owner',subject:'用户',predicate:'居住城市',value:'杭州',evidence:'我搬到杭州了',content:'用户 · 居住城市：杭州',operation:'update'}],{sessionId:'later',userEventId:'later-user',assistantEventId:'later-assistant',userText:'我搬到杭州了',observedAt:'2026-10-29T10:00:00Z'})
    await f.lifecycle.checkpoint(f.agent,{waitMs:1000});await f.lifecycle.waitForIdle()
    assert.deepEqual(f.store.search('居住城市').map(x=>x.value),['杭州'])
  }finally{await f.dispose()}
})

test('missing original source time cannot be replaced by the checkpoint wall clock',async()=>{
  const events=historyTurn(1);for(const e of events)delete e.time
  const f=await fixture({events})
  try{await assert.rejects(f.lifecycle.checkpoint(f.agent,{waitMs:0}),/时间|来源/);assert.equal(f.store.status().memoryCount,0)}finally{await f.dispose()}
})

test('disabled memory, standard sessions and rejected group mappings do not scan or save',async()=>{
  for(const options of [{enabled:false},{preset:'standard'},{preset:'whale-group',acceptAgent:()=>false}]){
    const f=await fixture({...options,events:historyTurn(1)})
    try{await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(f.store.get().jobs.length,0)}finally{await f.dispose()}
  }
})

test('a graceful plugin restart retains interrupted consolidation for automatic recovery',async()=>{
  const f=await fixture({events:historyTurn(1),extractor:hold});let second
  try{
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});await new Promise(resolve=>setImmediate(resolve));f.lifecycle.dispose();await f.lifecycle.waitForIdle()
    const jobs=f.store.get().jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].status,'queued');assert.equal(jobs[0].source.userText,'我住在北京')
    second=await fixture({store:f.store});await second.lifecycle.waitForIdle();assert.equal(f.store.status().memoryCount,1);assert.equal(f.store.get().jobs[0].status,'completed')
  }finally{if(second)await second.dispose();await f.dispose()}
})

test('reattaching a session preserves durable jobs and starts capture at newly observed content',async()=>{
  const f=await fixture({events:historyTurn(1),captureExisting:false,extractor:hold});let second
  try{
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.equal(f.store.get().jobs.length,0)
    for(const event of historyTurn(2))f.log.push(event)
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});assert.deepEqual(f.store.get().jobs.map(j=>j.source.userEventId),['user-2'])
    f.lifecycle.dispose();await f.lifecycle.waitForIdle()
    const reopened=new MemoryStore(join(f.dir,'fresh-cache.json'),{palaceRoot:join(f.dir,'palace')})
    second=await fixture({events:[...historyTurn(1),...historyTurn(2),...historyTurn(3)],captureExisting:false,store:reopened})
    await second.lifecycle.checkpoint(second.agent,{waitMs:1000});await second.lifecycle.waitForIdle()
    assert.deepEqual(reopened.get().jobs.map(j=>j.source.userEventId),['user-2'])
    second.log.push(...historyTurn(4));await second.lifecycle.checkpoint(second.agent,{waitMs:1000});await second.lifecycle.waitForIdle()
    assert.deepEqual(reopened.get().jobs.map(j=>j.source.userEventId),['user-2','user-4'])
  }finally{if(second)await second.dispose();await f.dispose()}
})

test('messages while memory is disabled remain excluded after re-enabling without saving their text',async()=>{
  const f=await fixture({captureExisting:false})
  try{
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});f.config.memory.enabled=false;await f.lifecycle.reconcile()
    for(const event of historyTurn(1,'我住在北京'))f.emit(event)
    await f.lifecycle.waitForIdle();assert.equal(f.store.get().jobs.length,0)
    f.config.memory.enabled=true;await f.lifecycle.reconcile();await f.lifecycle.checkpoint(f.agent,{waitMs:1000});await f.lifecycle.waitForIdle()
    assert.equal(f.store.get().jobs.length,0);assert.equal(f.store.status().memoryCount,0)
    const {readFile}=await import('node:fs/promises');const state=await readFile(f.store.statePath,'utf8')
    assert.doesNotMatch(state,/我住在北京/);assert.equal(JSON.parse(state).excludedSources.length,1)
  }finally{await f.dispose()}
})

test('a newly created session establishes its boundary before any missed completed turns',async()=>{
  const f=await fixture({captureExisting:false,initiallyLoaded:false,extractor:hold})
  try{
    f.created();await f.lifecycle.waitForIdle()
    f.log.push(...historyTurn(1))
    await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    assert.deepEqual(f.store.get().jobs.map(job=>job.source.userEventId),['user-1'])
  }finally{await f.dispose()}
})

test('an unfinished pre-upgrade turn cannot save its old user message when the response finishes after upgrade',async()=>{
  const events=historyTurn(1),f=await fixture({events:events.slice(0,2),captureExisting:false})
  try{
    for(const event of events.slice(2))f.emit(event)
    await f.lifecycle.waitForIdle();await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    assert.equal(f.store.get().jobs.length,0)
  }finally{await f.dispose()}
})

test('a truncated or replaced event history cannot move the persisted capture boundary backwards',async()=>{
  const f=await fixture({events:historyTurn(1),captureExisting:false})
  try{
    await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    f.log.splice(0,f.log.length,...historyTurn(2))
    await assert.rejects(f.lifecycle.checkpoint(f.agent,{waitMs:0}),{code:'CAPTURE_BOUNDARY_CHANGED'})
    assert.equal(f.lifecycle.snapshot().checkpoint.durable,false);assert.equal(f.store.get().jobs.length,0)
  }finally{await f.dispose()}
})

test('failed exclusion writes block compaction until disabled-message receipts are durably stored',async()=>{
  const f=await fixture({captureExisting:false}),exclude=f.store.excludeSource.bind(f.store);let fail=true
  try{
    await f.lifecycle.checkpoint(f.agent,{waitMs:0});f.config.memory.enabled=false;await f.lifecycle.reconcile()
    f.store.excludeSource=async source=>{if(fail)throw Error('EIO');return exclude(source)}
    for(const event of historyTurn(1))f.emit(event)
    await f.lifecycle.waitForIdle();f.config.memory.enabled=true
    await assert.rejects(f.lifecycle.checkpoint(f.agent,{waitMs:0}),/记忆|保存/)
    assert.equal(f.store.get().jobs.length,0);assert.equal(f.lifecycle.snapshot().checkpoint.durable,false)
    fail=false;await f.lifecycle.reconcile();await f.lifecycle.checkpoint(f.agent,{waitMs:0})
    assert.equal(f.store.get().jobs.length,0);assert.equal(f.store.isSourceExcluded({sessionId:f.agent.id,userEventId:'user-1'}),true)
  }finally{await f.dispose()}
})
