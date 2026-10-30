import { observeSongResult } from './song-result.js';
export class ModeSwitchError extends Error { constructor(message,status=409){super(message);this.status=status;} }
const switching=new Set();
export function claimSessionChange(sessionId) {
  if(switching.has(sessionId))throw new ModeSwitchError('会话设置正在切换，请稍等。');
  switching.add(sessionId);
  return ()=>switching.delete(sessionId);
}
export function currentPreset(session) {
  let preset=session?.header?.agentPreset;
  for(const e of session?.snapshotEvents?.()??[])if(e.type==='agent-preset/selected')preset=e.data.agentPreset;
  return preset??'standard';
}
export function isRoot(agent){return !!agent&&!agent.session.header?.parentSession&&agent.session.header?.origin!=='subagent';}
export function requireWhale(agent) {
  if(!isRoot(agent)||!['whale','whale-group'].includes(currentPreset(agent.session)))throw new ModeSwitchError('请先将这个会话切换为鲸鱼娘模式。',409);
  return agent;
}
export async function resolveAgent(ctx,id) {
  if(typeof id!=='string'||!id||id.length>200)throw new ModeSwitchError('请先选择会话。',400);
  let agent=ctx.agents.get(id);
  if(!agent&&ctx.sessionController){
    const result=await ctx.sessionController.resolveAgent(id);
    if(result?.error)throw new ModeSwitchError('这个会话暂时无法打开。',404);
    agent=result?.agent??result;
  }
  if(!isRoot(agent))throw new ModeSwitchError('请先打开主会话。',404);
  return agent;
}
export async function switchWhaleMode(ctx,{sessionId,agentPreset,expectedPreset}) {
  if(!['standard','whale'].includes(agentPreset))throw new ModeSwitchError('请选择标准模式或鲸鱼娘模式。',400);
  const agent=await resolveAgent(ctx,sessionId);
  if(agent.status!=='idle')throw new ModeSwitchError('请等待当前回复完成后再切换。');
  const release=claimSessionChange(sessionId);
  try{return await agent.runMaintenance(async signal=>{
    const previous=currentPreset(agent.session);
    if(previous===agentPreset)return {sessionId,agentPreset,previous};
    if(!['standard','whale'].includes(previous))throw new ModeSwitchError('此按钮用于标准模式与鲸鱼娘模式之间切换。',400);
    if(expectedPreset!==previous)throw new ModeSwitchError('会话模式已改变，请重新点击。');
    const target=await ctx.agentPresets.resolve(agentPreset);
    if(target.broken)throw new ModeSwitchError('目标模式暂时不可用。',503);
    signal.throwIfAborted();
    try{
      await ctx.agentPresets.recompose(agent.ctx,agentPreset);signal.throwIfAborted();
      agent.session.append('agent-preset/selected',{agentPreset});
    }catch(error){if(currentPreset(agent.session)!==agentPreset)await ctx.agentPresets.recompose(agent.ctx,previous);throw error;}
    return {sessionId,agentPreset,previous};
  });}finally{release();}
}
function plain(content){return Array.isArray(content)?content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n'):'';}
export function projectMessages(events) {
  const out=[];let pending=[],song=null;const calls=new Set();
  for(const [index,e] of events.entries()){
    if(e.type==='turn/start'){song=null;calls.clear();}
    const generated=observeSongResult(e,calls);if(generated)song=generated;
    if(e.type==='user/message'&&e.data?.source?.kind==='user'){
      const text=plain(e.data.content);if(text)out.push({id:String(e.id??index),role:'user',text,speakable:false});
    }
    if(e.type==='assistant/message'){
      const m=e.data.message;const text=plain(m?.content);
      if(text.trim()){const row={id:String(e.id??index),role:'assistant',text,speakable:false,terminal:false};out.push(row);pending.push({row,tool:m.content.some(b=>b.type==='tool-call')});}
    }
    if(e.type==='turn/end'){
      pending.forEach(({row})=>{row.terminal=true;});
      if(e.data?.reason?.kind==='completed'){
        const final=pending.filter(x=>!x.tool).at(-1);if(final){final.row.speakable=true;if(song)Object.assign(final.row,song);}
        else if(song)out.push({id:String(e.id??index),role:'assistant',text:`《${song.title}》`,terminal:true,speakable:true,...song});
      }pending=[];song=null;calls.clear();
    }
  }
  return out.slice(-200);
}
export async function sendText(ctx,{sessionId,text,requestId},receipts,makeMessage) {
  if(typeof text!=='string'||!text.trim()||text.length>32000||typeof requestId!=='string'||!requestId||requestId.length>160)throw new ModeSwitchError('请输入消息后发送。',400);
  const agent=requireWhale(await resolveAgent(ctx,sessionId));
  if(switching.has(sessionId))throw new ModeSwitchError('会话设置正在切换，请稍等。');
  const key=sessionId+':'+requestId;
  if(receipts.has(key))return {accepted:true};
  if(agent.status!=='idle')throw new ModeSwitchError('大肥鱼正在回复，请稍等。');
  receipts.set(key,Date.now());
  try{
    const factory=makeMessage??(await import('@deepseek-ai/dsh-llm')).createUserMessage;
    requireWhale(agent);
    if(switching.has(sessionId))throw new ModeSwitchError('会话设置正在切换，请稍等。');
    if(agent.status!=='idle')throw new ModeSwitchError('大肥鱼正在回复，请稍等。');
    agent.followup(factory({content:[{type:'text',text:text.trim()}],source:{kind:'user'}}));
  }
  catch(error){receipts.delete(key);throw error;}
  if(receipts.size>1000){const cutoff=Date.now()-3600000;for(const [k,time]of receipts)if(time<cutoff)receipts.delete(k);}
  return {accepted:true};
}
