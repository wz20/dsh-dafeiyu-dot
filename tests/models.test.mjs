import test from 'node:test';
import assert from 'node:assert/strict';
import {getModelSelection,listSessionModels,selectSessionModel} from '../lib/models.js';
import {sendText} from '../lib/session.js';

function fixture() {
  const events=[],commits=[],resolved=[],defaults=[];let selected={provider:'provider-a',model:'model-a',reasoningEffort:'high'},phase='idle';
  const catalog={default:{provider:'provider-a',model:'model-a'},groups:[{id:'provider-a',name:'服务甲',apiKey:'catalog-secret',models:[{id:'model-a',name:'模型甲',token:'model-secret',reasoning:{efforts:[{id:'low',name:'低'},{id:'high',name:'高'}],defaultEffort:'high'}},{id:'model-b',name:'模型乙'}]}],failures:[{id:'provider-b',name:'服务乙',message:'https://host/?token=failure-secret'}]};
  const agent={id:'session-a',ctx:{},session:{header:{agentPreset:'whale'},snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'logged-provider',model:'logged-model',reasoningEffort:'low',apiKey:'header-secret'}}),append(type,data){events.push({type,data});}},get status(){return phase==='running'?'running':'idle';},followup(){throw Error('unexpected send');},async runMaintenance(job){if(phase!=='idle')throw Error('maintenance occupied');phase='maintenance';try{return await job(new AbortController().signal);}finally{phase='idle';}}};
  let chain=Promise.resolve();
  const control={selectionFor:()=>({current:selected}),selectForNextRequest(_agent,next){commits.push(next);selected=next;agent.session.append('model/selection',next);},serializeImageAdmission(_agent,job){const pending=chain.then(job);chain=pending.catch(()=>{});return pending;}};
  const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessionController:{agents:control,modelCatalog:async()=>catalog,selectModel(){throw Error('global mutation path');}},agentDefaultModel:{saveSelection:selection=>defaults.push(selection)},llm:{resolveCallConfig:async selection=>{resolved.push(selection);return {...selection,...selection.model==='model-a'&&!selection.reasoningEffort?{reasoningEffort:'high'}:{},apiKey:'resolved-secret'};}}};
  return {ctx,agent,catalog,control,events,commits,resolved,defaults,setPhase:value=>{phase=value;},get phase(){return phase;}};
}

test('current model reads the pending host selection and emits only route fields',()=>{
  const f=fixture();assert.deepEqual(getModelSelection(f.ctx,f.agent),{provider:'provider-a',model:'model-a',reasoningEffort:'high'});
  delete f.control.selectionFor;assert.deepEqual(getModelSelection(f.ctx,f.agent),{provider:'logged-provider',model:'logged-model',reasoningEffort:'low'});
  f.agent.session.requestHeader=()=>undefined;assert.equal(getModelSelection(f.ctx,f.agent),null);
});

test('model catalog projects safe metadata and isolates provider failure messages',async()=>{
  const f=fixture();const result=await listSessionModels(f.ctx,{sessionId:f.agent.id},new AbortController().signal);
  assert.deepEqual(result.selected,{provider:'provider-a',model:'model-a',reasoningEffort:'high'});
  assert.equal(result.groups[0].models[0].reasoning.defaultEffort,'high');
  assert.deepEqual(result.failures,[{id:'provider-b',name:'服务乙',message:'暂时无法读取该服务的模型。'}]);
  assert.doesNotMatch(JSON.stringify(result),/catalog-secret|model-secret|failure-secret|apiKey|token/);
  delete f.control.selectionFor;f.agent.session.requestHeader=()=>undefined;
  assert.deepEqual((await listSessionModels(f.ctx,{sessionId:f.agent.id})).selected,f.catalog.default);
});

test('catalog reads are root-scoped and observe cancellation',async()=>{
  const f=fixture();f.agent.session.header.parentSession='parent';
  await assert.rejects(listSessionModels(f.ctx,{sessionId:f.agent.id}),error=>error.status===404);
  delete f.agent.session.header.parentSession;
  const controller=new AbortController();controller.abort();
  await assert.rejects(listSessionModels(f.ctx,{sessionId:f.agent.id},controller.signal),{name:'AbortError'});
});

test('selection normalizes the route under maintenance without saving a global default',async()=>{
  const f=fixture();const answer=await selectSessionModel(f.ctx,{sessionId:f.agent.id,provider:'provider-a',model:'model-a'});
  assert.deepEqual(answer,{sessionId:f.agent.id,selected:{provider:'provider-a',model:'model-a',reasoningEffort:'high'}});
  assert.deepEqual(f.resolved,[{provider:'provider-a',model:'model-a'}]);assert.equal(f.commits.length,1);
  assert.deepEqual(f.events,[{type:'model/selection',data:answer.selected}]);assert.equal(f.defaults.length,0);assert.equal(f.phase,'idle');
  const noEffort=await selectSessionModel(f.ctx,{sessionId:f.agent.id,provider:'provider-a',model:'model-b'});
  assert.deepEqual(noEffort.selected,{provider:'provider-a',model:'model-b'});
});

test('unknown routes and unsupported reasoning levels cannot enter the runtime selection',async()=>{
  const f=fixture(),base={sessionId:f.agent.id,provider:'provider-a',model:'model-a'};
  for(const patch of [{provider:'missing'},{model:'missing'},{reasoningEffort:'ultra'},{model:'model-b',reasoningEffort:'high'},{provider:''},{model:123},{reasoningEffort:''}])
    await assert.rejects(selectSessionModel(f.ctx,{...base,...patch}),error=>error.status===400);
  assert.equal(f.commits.length,0);assert.equal(f.resolved.length,0);
});

test('running, standard and subagent sessions reject model changes',async()=>{
  const f=fixture(),request={sessionId:f.agent.id,provider:'provider-a',model:'model-a'};
  f.setPhase('running');await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===409);
  f.setPhase('idle');f.agent.session.header.agentPreset='standard';await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===409);
  f.agent.session.header.agentPreset='whale';f.agent.session.header.origin='subagent';await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===404);
  assert.equal(f.commits.length,0);
});

test('a pending model change blocks sends and another change even while maintenance reports idle',async()=>{
  const f=fixture();let resolveNormalization,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  f.ctx.llm.resolveCallConfig=async selection=>{entered();return await new Promise(resolve=>{resolveNormalization=()=>resolve(selection);});};
  const request={sessionId:f.agent.id,provider:'provider-a',model:'model-b'};
  const pending=selectSessionModel(f.ctx,request);await ready;assert.equal(f.agent.status,'idle');
  await assert.rejects(sendText(f.ctx,{sessionId:f.agent.id,text:'正在切换时发送',requestId:'blocked'},new Map(),value=>value),error=>error.status===409);
  await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===409);
  resolveNormalization();await pending;
  f.agent.followup=()=>{};await sendText(f.ctx,{sessionId:f.agent.id,text:'切换后发送',requestId:'allowed'},new Map(),value=>value);
  assert.equal(f.commits.length,1);
});

test('mode, ownership and cancellation are rechecked before committing after async normalization',async()=>{
  const f=fixture(),request={sessionId:f.agent.id,provider:'provider-a',model:'model-a'};
  f.ctx.llm.resolveCallConfig=async selection=>{f.agent.session.header.agentPreset='standard';return selection;};
  await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===409);assert.equal(f.commits.length,0);
  f.agent.session.header.agentPreset='whale';f.ctx.llm.resolveCallConfig=async selection=>selection;
  const get=f.ctx.agents.get;
  f.ctx.llm.resolveCallConfig=async selected=>{f.ctx.agents.get=()=>undefined;return selected;};
  await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===404);assert.equal(f.commits.length,0);
  f.ctx.agents.get=get;f.ctx.llm.resolveCallConfig=async selected=>selected;
  f.agent.runMaintenance=async job=>{const controller=new AbortController();controller.abort();return job(controller.signal);};
  await assert.rejects(selectSessionModel(f.ctx,request),{name:'AbortError'});assert.equal(f.commits.length,0);
});

test('cancellation during model normalization prevents a late commit and releases admission',async()=>{
  const f=fixture(),request={sessionId:f.agent.id,provider:'provider-a',model:'model-b'};
  let activeSignal,finish,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const controller=new AbortController();
  f.agent.runMaintenance=async job=>{activeSignal=controller.signal;return job(activeSignal);};
  f.ctx.llm.resolveCallConfig=async selected=>{entered();return new Promise(resolve=>{finish=()=>resolve(selected);});};
  const pending=selectSessionModel(f.ctx,request);await ready;controller.abort();finish();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(f.commits.length,0);
  f.agent.runMaintenance=job=>job(new AbortController().signal);f.ctx.llm.resolveCallConfig=async selected=>selected;
  assert.equal((await selectSessionModel(f.ctx,request)).selected.model,'model-b');
});

test('unavailable host capabilities fail clearly and cannot fall back to changing the global model',async()=>{
  const f=fixture(),request={sessionId:f.agent.id,provider:'provider-a',model:'model-a'};
  delete f.control.selectForNextRequest;await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===503&&/模型/.test(error.message));
  delete f.ctx.sessionController.modelCatalog;await assert.rejects(listSessionModels(f.ctx,{sessionId:f.agent.id}),error=>error.status===503);
  assert.equal(f.commits.length,0);assert.equal(f.defaults.length,0);
});

test('normalization errors are sanitized and release the shared session change gate',async()=>{
  const f=fixture(),request={sessionId:f.agent.id,provider:'provider-a',model:'model-b'};
  f.ctx.llm.resolveCallConfig=async()=>{throw Error('Authorization: Bearer provider-secret');};
  await assert.rejects(selectSessionModel(f.ctx,request),error=>error.status===503&&!/provider-secret|Bearer/.test(error.message));
  f.ctx.llm.resolveCallConfig=async selected=>selected;
  assert.equal((await selectSessionModel(f.ctx,request)).selected.model,'model-b');
});
