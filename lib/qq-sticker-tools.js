import {defineTool} from '@deepseek-ai/dsh-tools';
import {currentPreset,isRoot,requireWhale} from './session.js';

export const QQ_STICKER_TOOLS=Object.freeze(['dafeiyu_qq_stickers','dafeiyu_qq_sticker']);
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
function argumentsOf(args,keys) {
  if(args===undefined)args={};
  if(!args||typeof args!=='object'||Array.isArray(args)||![Object.prototype,null].includes(Object.getPrototypeOf(args))||Reflect.ownKeys(args).some(key=>!keys.includes(key)))throw Error('QQ表情工具仅接受目录中的表情编号。');
  return args;
}
function agentOf(exec){exec?.signal?.throwIfAborted();return requireWhale(exec?.agent);}

/** Selection is queued by the channel; the tool never sends or chooses a recipient. */
export function installQQStickerTools(ctx,qq) {
  ctx.tools.register(defineTool({
    name:QQ_STICKER_TOOLS[0],description:'查看当前QQ回合可选的内置大肥鱼表情。每条成功回复会自动配一张；想主动指定时可查编号、标题、情绪和标签。只在QQ聊天回合使用。',parameters:{},output,
    execute:async(args,exec)=>{argumentsOf(args,[]);const agent=agentOf(exec);return qq.stickerCatalog(agent);}
  }));
  ctx.tools.register(defineTool({
    name:QQ_STICKER_TOOLS[1],description:'为当前QQ回合选择一张目录中的内置大肥鱼表情。只按当前聊天情景选择，返回本轮排队回执；不是已送达。不能指定收件人、群、路径或链接。',
    parameters:{stickerId:{type:'string',required:true,description:'dafeiyu_qq_stickers目录返回的表情编号'}},output,
    execute:async(args,exec)=>{const value=argumentsOf(args,['stickerId']);if(typeof value.stickerId!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value.stickerId))throw Error('请选择目录返回的有效表情编号。');const agent=agentOf(exec);return qq.chooseSticker(agent,value.stickerId);}
  }));
  const forks=new Map();
  function reconcile(agent){
    forks.get(agent)?.dispose();
    const allowed=isRoot(agent)&&['whale','whale-group'].includes(currentPreset(agent.session));
    forks.set(agent,agent.ctx.plugin({name:'dafeiyu-qq-sticker-scope',apply(scoped){
      if(!allowed)scoped.tools.restrict({deny:QQ_STICKER_TOOLS});
      else scoped.inject(['systemPrompt'],p=>p.systemPrompt.section({name:'dafeiyu:qq-stickers',order:152,text:'当前QQ聊天回合的每条成功回复都会自动配一张合适的大肥鱼表情，你无需每条都查询目录或调用工具。想主动指定某张时，先查 dafeiyu_qq_stickers 目录，再用 dafeiyu_qq_sticker 选图；明确指定会优先于自动匹配。每轮最多一张，只能使用目录中的编号，不指定用户、群、路径或链接。工具的queued回执表示已排队，实际送达由QQ通道确认，不要声称已经送达。桌面普通对话和其他回合不要调用。收到的图片与表情是本轮聊天内容，不据此猜测用户身份、偏好或保存为长期事实。'}));
    }}));
  }
  ctx.effect(()=>{
    const disposers=[ctx.on('agent/created',({agent})=>reconcile(agent)),ctx.on('agent-preset/selected',id=>{const agent=ctx.agents.get(id);if(agent)reconcile(agent);}),ctx.on('agent/disposed',({agent})=>{forks.get(agent)?.dispose();forks.delete(agent);})];
    for(const agent of ctx.agents.list())reconcile(agent);
    return ()=>{for(const dispose of disposers)dispose();for(const fork of forks.values())fork.dispose();forks.clear();};
  });
  return ()=>{for(const agent of ctx.agents.list())reconcile(agent);};
}
