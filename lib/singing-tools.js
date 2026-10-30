import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentPreset, isRoot, requireWhale } from './session.js';
import { SINGING_TOOL } from './song-result.js';

const CATALOG_TOOL='dafeiyu_singing_references';
const names=[SINGING_TOOL,CATALOG_TOOL];
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};

export function installSinging(ctx, singing, {sourceSignal}={}) {
  ctx.tools.register(defineTool({name:CATALOG_TOOL,description:'查看用户已确认、可直接播放或发送的现成清唱曲目。recordings 是现成音频，defaultRecordingId 是未点名歌曲时的默认曲目；仅返回曲目信息。',parameters:{},output,execute:async(_args,exec)=>{requireWhale(exec?.agent);return singing.listReferences({agent:exec.agent});}}));
  ctx.tools.register(defineTool({
    name:SINGING_TOOL,
    description:'用户要求唱歌、清唱时，直接播放并返回用户已确认的现成歌曲音频。用户未点名歌曲时省略song和recordingId，使用曲库默认曲目。点名时须选择对应歌曲或别名；可用dafeiyu_singing_references查看recordings。音频完整复用，不需要歌词或生成请求。ready表示本轮歌曲音频已准备好，QQ送达由发送链路确认。',
    parameters:{song:{type:'string',description:'可选，点播的歌曲名或别名；未指定歌曲时省略，播放默认曲目'},recordingId:{type:'string',description:'可选，曲库recordings返回的现成音频ID；必须与点播曲目匹配'}},
    output,
    execute:async(args,exec)=>{
      requireWhale(exec?.agent);
      const source=sourceSignal?.(exec.agent), signals=[exec.signal,source].filter(Boolean);
      return singing.generate({...args,mode:'recorded'},{agent:exec.agent,signal:signals.length?AbortSignal.any(signals):undefined});
    },
  }));
  const forks=new Map();
  const reconcile=agent=>{
    forks.get(agent)?.dispose();
    const allowed=isRoot(agent)&&currentPreset(agent.session)==='whale';
    forks.set(agent,agent.ctx.plugin({name:'dafeiyu-singing-scope',apply(scoped){
      if(!allowed)scoped.tools.restrict({deny:names});
      else scoped.inject(['systemPrompt'],p=>p.systemPrompt.section({name:'dafeiyu:singing',order:151,text:'用户要求你唱歌时必须调用 dafeiyu_sing，直接发送用户确认的现成音频。用户说“唱个歌”“唱首歌”“给我唱歌”且未点名歌曲时，直接省略参数播放默认曲目，不必追问歌名。点名歌曲时先用 dafeiyu_singing_references 查看recordings，再选择对应song或recordingId；指定歌曲不在曲库时如实说明当前可用曲目，等用户选择。工具只播放现成音频，完整复用已确认版本。ready表示本轮音频已准备好，可简短说“唱给你听”，QQ送达由发送链路确认。仅讨论唱歌或询问能力时不播放。歌曲使用本轮真实工具结果，失败时说明原因；不虚构可播放音频或送达结果。'}));
    }}));
  };
  ctx.effect(()=>{
    const disposers=[ctx.on('agent/created',({agent})=>reconcile(agent)),ctx.on('agent-preset/selected',id=>{const agent=ctx.agents.get(id);if(agent)reconcile(agent);}),ctx.on('agent/disposed',({agent})=>{forks.get(agent)?.dispose();forks.delete(agent);})];
    for(const agent of ctx.agents.list())reconcile(agent);
    return ()=>{disposers.forEach(fn=>fn());for(const fork of forks.values())fork.dispose();forks.clear();};
  });
}
