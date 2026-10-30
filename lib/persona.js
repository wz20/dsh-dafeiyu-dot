import { getConfigStore } from './config.js';
export const name='dafeiyu-persona';
export const inject=['systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({name:'dafeiyu:persona',order:0,text:()=>{
    const c=getConfigStore().get();
    return c.role.prompt+'\n\n当前角色名称：'+c.role.name+'。对用户的日常称呼：'+c.role.address+'。';
  }});
}
