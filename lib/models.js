import {ModeSwitchError,claimSessionChange,resolveAgent,requireWhale} from './session.js';

const unavailable=()=>new ModeSwitchError('当前 DSH 暂不支持在这里切换模型，请更新宿主后重试。',503);
function text(value,max=512) {
  if(typeof value!=='string')return null;
  const cleaned=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
  return cleaned&&cleaned.length<=max?cleaned:null;
}
function selection(value) {
  const provider=text(value?.provider),model=text(value?.model);
  if(!provider||!model)return null;
  const effort=text(value.reasoningEffort,100);
  return {provider,model,...effort?{reasoningEffort:effort}:{}};
}
function metadata(catalog) {
  const groups=[];
  for(const group of Array.isArray(catalog?.groups)?catalog.groups:[]) {
    const id=text(group?.id),name=text(group?.name,256);
    if(!id||!name)continue;
    const models=[];
    for(const model of Array.isArray(group.models)?group.models:[]) {
      const modelId=text(model?.id),modelName=text(model?.name,256);
      if(!modelId||!modelName)continue;
      const description=text(model.description,2000),efforts=[];
      for(const effort of Array.isArray(model.reasoning?.efforts)?model.reasoning.efforts:[]) {
        const effortId=text(effort?.id,100),effortName=text(effort?.name,256),effortDescription=text(effort?.description,2000);
        if(effortId&&effortName)efforts.push({id:effortId,name:effortName,...effortDescription?{description:effortDescription}:{}});
      }
      const defaultEffort=text(model.reasoning?.defaultEffort,100);
      const reasoning=model.reasoning&&typeof model.reasoning==='object'?{efforts,...defaultEffort&&efforts.some(e=>e.id===defaultEffort)?{defaultEffort}:{}}:null;
      models.push({id:modelId,name:modelName,...description?{description}:{},...reasoning?{reasoning}:{}});
    }
    if(models.length)groups.push({id,name,models});
  }
  const failures=(Array.isArray(catalog?.failures)?catalog.failures:[]).flatMap(failure=>{
    const id=text(failure?.id),name=text(failure?.name,256);
    return id&&name?[{id,name,message:'暂时无法读取该服务的模型。'}]:[];
  });
  return {default:selection(catalog?.default),groups,failures};
}
async function catalogFor(ctx,signal) {
  signal?.throwIfAborted();
  if(typeof ctx.sessionController?.modelCatalog!=='function')throw unavailable();
  let raw;
  try{raw=await ctx.sessionController.modelCatalog();}
  catch{signal?.throwIfAborted();throw new ModeSwitchError('暂时无法读取模型列表，请稍后重试。',503);}
  signal?.throwIfAborted();
  return metadata(raw);
}

/** Read the Host-owned pending route before falling back to the last durable request. */
export function getModelSelection(ctx,agent) {
  const control=ctx.sessionController?.agents;
  if(typeof control?.selectionFor==='function') {
    const selected=selection(control.selectionFor(agent)?.current);
    if(selected)return selected;
  }
  return selection(agent?.session?.requestHeader?.()?.config);
}

export async function listSessionModels(ctx,{sessionId},signal) {
  signal?.throwIfAborted();
  const agent=await resolveAgent(ctx,sessionId),catalog=await catalogFor(ctx,signal);
  signal?.throwIfAborted();
  return {selected:getModelSelection(ctx,agent)??catalog.default,groups:catalog.groups,failures:catalog.failures};
}

/** Commit the normalized Session-local route through its owning Host controller. */
export async function selectSessionModel(ctx,{sessionId,provider,model,reasoningEffort}) {
  if(!text(sessionId,200)||!text(provider)||!text(model)||(reasoningEffort!==undefined&&!text(reasoningEffort,100)))
    throw new ModeSwitchError('请选择有效的会话、模型与思考等级。',400);
  const release=claimSessionChange(sessionId);
  try {
    const agent=requireWhale(await resolveAgent(ctx,sessionId)),control=ctx.sessionController?.agents;
    if(agent.status!=='idle')throw new ModeSwitchError('请等待当前回复完成后再切换模型。');
    if(typeof control?.selectionFor!=='function'||typeof control.selectForNextRequest!=='function'||typeof control.serializeImageAdmission!=='function'||typeof ctx.llm?.resolveCallConfig!=='function'||typeof agent.runMaintenance!=='function')throw unavailable();
    return await control.serializeImageAdmission(agent,async()=>{
      if(agent.status!=='idle')throw new ModeSwitchError('请等待当前回复完成后再切换模型。');
      requireWhale(agent);
      return await agent.runMaintenance(async signal=>{
        const assertReady=()=>{
          signal.throwIfAborted();requireWhale(agent);
          if(ctx.agents.get(agent.id)!==agent)throw new ModeSwitchError('这个会话暂时无法打开，请重新进入后重试。',404);
          if(agent.status!=='idle')throw new ModeSwitchError('请等待当前回复完成后再切换模型。');
        };
        assertReady();
        const catalog=await catalogFor(ctx,signal);assertReady();
        const group=catalog.groups.find(group=>group.id===provider),entry=group?.models.find(entry=>entry.id===model);
        if(!entry) {
          if(catalog.failures.some(failure=>failure.id===provider))throw new ModeSwitchError('暂时无法读取该服务的模型，请稍后重试。',503);
          throw new ModeSwitchError('这个模型暂不可选，请刷新模型列表。',400);
        }
        if(reasoningEffort!==undefined&&!entry.reasoning?.efforts.some(effort=>effort.id===reasoningEffort))
          throw new ModeSwitchError('这个模型不支持所选思考等级，请重新选择。',400);
        let resolved;
        try{resolved=await ctx.llm.resolveCallConfig({provider,model,...reasoningEffort===undefined?{}:{reasoningEffort}});}
        catch{signal.throwIfAborted();throw new ModeSwitchError('这个模型暂时无法切换，请稍后重试。',503);}
        assertReady();
        const selected=selection(resolved);
        if(!selected)throw new ModeSwitchError('模型服务未返回有效选择，请稍后重试。',503);
        control.selectForNextRequest(agent,selected);
        return {sessionId,selected};
      });
    });
  } finally {release();}
}
