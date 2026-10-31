import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './storage.js';

export const dataRoot = () => join(process.env.DSH_HOME || join(homedir(),'.dsh'),'dsh-dafeiyu-dot');
const persona = readFileSync(new URL('../assets/persona.md',import.meta.url),'utf8');
export const defaultConfig = () => ({
  role:{name:'大肥鱼',address:'主人',prompt:persona},
  tts:{source:'local',localUrl:'http://127.0.0.1:3900/v1',localModel:'audiocpp',localVoice:'',apiUrl:'https://api.openai.com/v1',apiModel:'tts-1',apiVoice:'alloy',keyConfigured:false,volume:0.75,speed:1,autoRead:false,emotional:true,expressiveness:'natural'},
  memory:{enabled:true},
  qq:{enabled:false,wsUrl:'ws://127.0.0.1:13001',napcatUrl:'http://127.0.0.1:16099',botId:'',ownerId:'',sessionId:'',voiceReplies:true,stickerReplies:true,groups:[]},
  widget:{enabled:true,soundEnabled:false,volume:0.7,regions:{
    head:{audio:'audio/head.wav',text:'嗯？主人，本鱼在呢。'},
    face:{audio:'audio/face.wav',text:'哼，别戳本鱼的脸啦。'},
    tail:{audio:'audio/tail.wav',text:'鱼鳍才不是拿来拽的，坏主人。'}
  }}
});

function string(value,label,max=500) {
  if (typeof value !== 'string' || !value.trim() || value.length>max) throw Object.assign(Error(label+'填写不正确。'),{status:400});
  return value.trim();
}
function url(value) {
  let parsed;
  try{parsed=new URL(string(value,'语音服务地址',2048));}
  catch{throw Object.assign(Error('请填写有效的语音服务地址。'),{status:400});}
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Object.assign(Error('请填写 HTTP 或 HTTPS 语音服务地址。'),{status:400});
  return parsed.href.replace(/\/$/,'');
}
function volume(v) { if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)throw Object.assign(Error('音量范围为 0 到 1。'),{status:400});return v; }
function bool(v) { if(typeof v!=='boolean')throw Object.assign(Error('开关值不正确。'),{status:400});return v; }
export function napcatUrl(value) {
  let address;try{address=new URL(string(value,'NapCat管理地址',2048));}catch{throw Object.assign(Error('请填写本机 NapCat 管理地址。'),{status:400});}
  if(!['http:','https:'].includes(address.protocol)||!['127.0.0.1','localhost','[::1]'].includes(address.hostname)||address.username||address.password||address.search||address.hash||address.pathname!=='/')throw Object.assign(Error('NapCat管理地址仅接受本机 HTTP 或 HTTPS 地址，密钥请单独保存。'),{status:400});
  return address.origin;
}
export function validatePatch(base,patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Object.assign(Error('配置格式不正确。'),{status:400});
  const next=structuredClone(base);
  for(const field of ['name','address','prompt'])if(patch.role?.[field]!==undefined)next.role[field]=string(patch.role[field],field,field==='prompt'?65536:100);
  if(patch.tts){
    const p=patch.tts;
    if(p.source!==undefined){if(!['local','api'].includes(p.source))throw Object.assign(Error('请选择本地或 API 语音。'),{status:400});next.tts.source=p.source;}
    for(const f of ['localUrl','apiUrl'])if(p[f]!==undefined)next.tts[f]=url(p[f]);
    for(const f of ['localModel','localVoice','apiModel','apiVoice'])if(p[f]!==undefined)next.tts[f]=f==='localVoice'&&p[f]===''?'':string(p[f],f,200);
    if(p.volume!==undefined)next.tts.volume=volume(p.volume);
    if(p.speed!==undefined){if(typeof p.speed!=='number'||!Number.isFinite(p.speed)||p.speed<0.75||p.speed>1.5)throw Object.assign(Error('语速范围为 0.75 到 1.5 倍。'),{status:400});next.tts.speed=p.speed;}
    if(p.autoRead!==undefined)next.tts.autoRead=bool(p.autoRead);
    if(p.emotional!==undefined)next.tts.emotional=bool(p.emotional);
    if(p.expressiveness!==undefined){if(!['gentle','natural','vivid'].includes(p.expressiveness))throw Object.assign(Error('请选择轻柔、自然或鲜明的表达方式。'),{status:400});next.tts.expressiveness=p.expressiveness;}
  }
  if(patch.memory?.enabled!==undefined)next.memory.enabled=bool(patch.memory.enabled);
  if(patch.qq!==undefined){
    const p=patch.qq;
    if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('QQ配置格式不正确。'),{status:400});
    next.qq??=defaultConfig().qq;
    if(p.napcatUrl!==undefined)next.qq.napcatUrl=napcatUrl(p.napcatUrl);
    if(p.groups!==undefined){
      if(!Array.isArray(p.groups)||p.groups.length>20)throw Object.assign(Error('群聊列表最多配置二十个群。'),{status:400});
      const ids=new Set();
      next.qq.groups=p.groups.map(g=>{
        if(!g||typeof g!=='object'||typeof g.id!=='string'||!(/^[1-9]\d{4,19}$/).test(g.id)||ids.has(g.id)||typeof g.enabled!=='boolean')throw Object.assign(Error('请使用有效且不重复的群聊配置。'),{status:400});
        ids.add(g.id);return {id:g.id,name:string(g.name,'群名称',200),enabled:g.enabled};
      });
    }
    for(const f of ['enabled','voiceReplies','stickerReplies'])if(p[f]!==undefined)next.qq[f]=bool(p[f]);
    if(p.wsUrl!==undefined){
      let address;try{address=new URL(p.wsUrl);}catch{throw Object.assign(Error('请填写本机QQ网关的WebSocket地址。'),{status:400});}
      if(!['ws:','wss:'].includes(address.protocol)||!['127.0.0.1','localhost','[::1]'].includes(address.hostname)||address.username||address.password||address.search||address.hash)throw Object.assign(Error('QQ网关仅连接本机回环地址，令牌请单独保存。'),{status:400});
      next.qq.wsUrl=address.href.replace(/\/$/,'');
    }
    for(const f of ['botId','ownerId'])if(p[f]!==undefined){
      if(typeof p[f]!=='string'||(p[f]&&!/^[1-9]\d{4,19}$/.test(p[f])))throw Object.assign(Error('QQ账号格式不正确。'),{status:400});
      next.qq[f]=p[f];
    }
    if(p.sessionId!==undefined){if(typeof p.sessionId!=='string'||p.sessionId.length>200||/[\r\n\0]/.test(p.sessionId))throw Object.assign(Error('请选择QQ使用的鲸鱼娘会话。'),{status:400});next.qq.sessionId=p.sessionId;}
    if(next.qq.enabled&&!next.qq.sessionId)throw Object.assign(Error('启用QQ前请选择鲸鱼娘会话。'),{status:400});
  }
  if(patch.widget){
    const p=patch.widget;
    for(const f of ['enabled','soundEnabled'])if(p[f]!==undefined)next.widget[f]=bool(p[f]);
    if(p.volume!==undefined)next.widget.volume=volume(p.volume);
    for(const region of ['head','face','tail'])if(p.regions?.[region]){
      const r=p.regions[region];
      if(r.text!==undefined)next.widget.regions[region].text=string(r.text,'语音说明',500);
      if(r.audio!==undefined){
        if(!/^audio\/[a-z0-9_-]+\.(wav|mp3|ogg)$/.test(r.audio))throw Object.assign(Error('请选择内置语音。'),{status:400});
        next.widget.regions[region].audio=r.audio;
      }
    }
  }
  return next;
}
export class ConfigStore extends JsonStore {
  constructor(path=join(dataRoot(),'config.json')) {
    super(path,defaultConfig());
    this.value=validatePatch(defaultConfig(),this.value);
  }
  update(patch) { return this.mutate(base=>validatePatch(base,patch)); }
}
let singleton;
export function getConfigStore(path) { return singleton ??= new ConfigStore(path); }
