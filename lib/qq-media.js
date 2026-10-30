import {readFileSync} from 'node:fs';
import {getModelSelection} from './models.js';

const faceNames=new Map(Object.entries(JSON.parse(readFileSync(new URL('../assets/qq-faces.json',import.meta.url),'utf8'))));
const MAX_IMAGES=3,MAX_IMAGE_BYTES=5*1024*1024,MAX_TOTAL_BYTES=12*1024*1024,DEADLINE_MS=15000;
const imageHosts=new Set(['gchat.qpic.cn','c2cpicdw.qpic.cn','multimedia.nt.qq.com.cn','gxh.vip.qq.com']);
const imageTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};

export class QQMediaError extends Error {
  constructor(message,status=400){super(message);this.name='QQMediaError';this.status=status;}
}
function imageURL(value) {
  let url;
  try{if(typeof value!=='string'||!value||value.length>8192)throw Error();url=new URL(value);}catch{throw new QQMediaError('QQ图片地址无效，请重新发送图片。');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!imageHosts.has(url.hostname))throw new QQMediaError('QQ图片地址不在允许的官方图片服务内。');
  return url.href;
}
function safeFile(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/u.test(value)?value:undefined;}
function marketFace(data) {
  const id=data?.emoji_id,packageId=data?.emoji_package_id,key=data?.key;
  if(typeof id!=='string'||!/^[a-fA-F0-9]{32}$/u.test(id)||!Number.isSafeInteger(packageId)||packageId<0||typeof key!=='string'||!key||key.length>256||/[\u0000-\u001f\u007f]/u.test(key))return undefined;
  return {emoji_id:id,emoji_package_id:packageId,key,summary:typeof data.summary==='string'?data.summary.slice(0,200):'[商城表情]'};
}
function parsedImage(data,type) {
  const mface=marketFace(data),file=safeFile(data?.file);
  let url;
  if(data?.url!==undefined&&data.url!=='')url=imageURL(data.url);
  else if(type==='mface'&&mface)url=imageURL(`https://gxh.vip.qq.com/club/item/parcel/item/${mface.emoji_id.slice(0,2)}/${mface.emoji_id}/raw300.gif`);
  if(!url&&!file)throw new QQMediaError('QQ图片缺少可用的图片地址或文件标识。');
  return {...url?{url}:{},...file?{file}:{},...typeof data?.summary==='string'?{summary:data.summary.slice(0,200)}:{},...mface?{mface}:{}};
}

/** Keep user-authored text separate from QQ media metadata and generated face labels. */
export function parseQQContent(message) {
  const result={text:'',images:[],faces:[],kind:'other',parts:[]};
  const blocks=typeof message==='string'?[{type:'text',data:{text:message}}]:Array.isArray(message)?message:[];
  if(blocks.length>256)throw new QQMediaError('QQ消息内容过多，请分开发送。');
  for(const block of blocks){
    if(block?.type==='text'&&typeof block.data?.text==='string'){
      result.text+=block.data.text;result.parts.push({type:'text',text:block.data.text});
    }else if(block?.type==='image'||block?.type==='mface'){
      if(result.images.length>=MAX_IMAGES)throw new QQMediaError('一条QQ消息最多接收三张图片或表情包。');
      result.parts.push({type:'image',index:result.images.length});result.images.push(parsedImage(block.data,block.type));
    }else if(block?.type==='face'){
      const raw=block.data?.id;if(typeof raw!=='string'&&!Number.isSafeInteger(raw))continue;
      const id=String(raw);if(!/^\d{1,6}$/u.test(id))continue;
      if(result.faces.length>=50)throw new QQMediaError('一条QQ消息的表情过多，请分开发送。');
      const name=faceNames.get(id)?.replace(/^\//u,'');result.parts.push({type:'face',index:result.faces.length});result.faces.push({id,...name?{name}:{}});
    }
  }
  if(result.text.length>4000)throw new QQMediaError('QQ文字过长，请分开发送。');
  result.kind=result.images.length?'image':result.faces.length?'face':result.text.length?'text':'other';
  return result;
}

function rasterType(bytes) {
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  throw new QQMediaError('QQ图片不是可处理的PNG、JPEG、WebP或GIF图片。',502);
}
function canonicalImage(value,maxBytes) {
  if(typeof value==='string'&&value.length>Math.ceil(maxBytes/3)*4)throw new QQMediaError('QQ图片超过本条消息的大小限制。',413);
  if(typeof value!=='string'||!value||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/u.test(value))throw new QQMediaError('QQ图片编码无效。',502);
  const bytes=Buffer.from(value,'base64');
  if(bytes.toString('base64')!==value)throw new QQMediaError('QQ图片编码无效。',502);
  if(bytes.length>maxBytes)throw new QQMediaError('QQ图片超过本条消息的大小限制。',413);
  return bytes;
}
function cancelBody(response){try{Promise.resolve(response?.body?.cancel()).catch(()=>{});}catch{}}

/** Admit image bytes before making durable image references available to this exact QQ turn. */
export async function prepareQQContent(ctx,agent,parsed,{signal,admit,fetch:fetcher=globalThis.fetch,rpc,timeoutMs=DEADLINE_MS}={}) {
  const control=new AbortController();
  const externalAbort=()=>control.abort(signal.reason);
  signal?.addEventListener('abort',externalAbort,{once:true});if(signal?.aborted)externalAbort();
  const timer=setTimeout(()=>control.abort(new QQMediaError('QQ图片处理超时，请重新发送或稍后重试。',504)),Math.min(DEADLINE_MS,Math.max(1,Number(timeoutMs)||DEADLINE_MS)));
  const active=control.signal;
  async function bounded(work) {
    active.throwIfAborted();let abort;
    try{return await new Promise((resolve,reject)=>{
      abort=()=>reject(active.reason);active.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{active.throwIfAborted();return work();}).then(resolve,reject);
    });}finally{active.removeEventListener('abort',abort);}
  }
  async function check(){active.throwIfAborted();if(admit&&await bounded(()=>admit())===false)throw new QQMediaError('QQ来源已经变化，本条图片未进入对话。',409);active.throwIfAborted();}
  let route;
  async function checkRoute(){await check();if(route){const current=getModelSelection(ctx,agent);if(!current||current.provider!==route.provider||current.model!==route.model)throw new QQMediaError('当前会话模型已改变，请重新发送图片。',409);}}
  async function download(address,maxBytes) {
    let location=imageURL(address);
    for(let redirects=0;;redirects++){
      await checkRoute();
      const response=await bounded(()=>Promise.resolve(fetcher(location,{redirect:'manual',credentials:'omit',signal:active,headers:{accept:'image/png,image/jpeg,image/webp,image/gif'}})).then(value=>{if(active.aborted)cancelBody(value);return value;}));
      try{await checkRoute();}catch(error){cancelBody(response);throw error;}
      if([301,302,303,307,308].includes(response.status)){
        const next=response.headers?.get('location');cancelBody(response);
        if(!next||redirects>=3)throw new QQMediaError('QQ图片地址跳转次数过多或无效。',502);
        let target;try{target=new URL(next,location).href;}catch{throw new QQMediaError('QQ图片地址跳转无效。',502);}location=imageURL(target);continue;
      }
      if(!response.ok){cancelBody(response);throw new QQMediaError('QQ图片链接已过期或下载失败，请重新发送。',502);}
      const declared=response.headers?.get('content-length');
      if(declared&&/^\d+$/u.test(declared)&&Number(declared)>maxBytes){cancelBody(response);throw new QQMediaError('QQ图片超过本条消息的大小限制。',413);}
      if(!response.body||typeof response.body.getReader!=='function'){cancelBody(response);throw new QQMediaError('QQ图片没有可读取的数据。',502);}
      const reader=response.body.getReader(),chunks=[];let length=0;
      try{
        while(true){const item=await bounded(()=>reader.read());if(item.done)break;
          if(!(item.value instanceof Uint8Array))throw new QQMediaError('QQ图片返回了无效数据。',502);
          if(length+item.value.byteLength>maxBytes)throw new QQMediaError('QQ图片超过本条消息的大小限制。',413);
          const bytes=Buffer.from(item.value);chunks.push(bytes);length+=bytes.length;
        }
      }catch(error){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}throw error;}
      finally{try{reader.releaseLock();}catch{}}
      if(!length)throw new QQMediaError('QQ图片数据为空，请重新发送。',502);
      await checkRoute();return Buffer.concat(chunks,length);
    }
  }
  try{
    await check();
    if(!parsed||typeof parsed.text!=='string'||!Array.isArray(parsed.images)||!Array.isArray(parsed.faces)||!Array.isArray(parsed.parts)||parsed.images.length>MAX_IMAGES)throw new QQMediaError('QQ消息内容无效。');
    let attachments;
    if(parsed.images.length){
      if(typeof admit!=='function')throw new QQMediaError('QQ消息来源尚未确认，图片未进入对话。',409);
      try{attachments=ctx.get?.('attachments')??ctx.attachments;}catch{}
      if(typeof attachments?.saveImages!=='function')throw new QQMediaError('DSH图片附件服务尚未准备，暂时不能接收QQ图片。',503);
      route=getModelSelection(ctx,agent);
      if(!route||typeof ctx.llm?.resolveModelInfo!=='function')throw new QQMediaError('暂时无法确认当前模型的图片能力，请检查会话模型。',503);
      let info;try{info=await bounded(()=>ctx.llm.resolveModelInfo(route.provider,route.model,active));}catch(error){active.throwIfAborted();throw new QQMediaError('暂时无法确认当前模型的图片能力，请稍后重试。',503);}
      if(!info?.inputModalities?.includes('image'))throw new QQMediaError('当前会话模型不支持图片，请先切换到支持看图的模型。',409);
    }
    await checkRoute();
    const media=[];let total=0;
    for(const image of parsed.images){
      await checkRoute();let bytes;const limit=Math.min(MAX_IMAGE_BYTES,MAX_TOTAL_BYTES-total);
      if(image.url)bytes=await download(image.url,limit);
      else {
        const file=safeFile(image.file);if(!file||typeof rpc!=='function')throw new QQMediaError('QQ图片没有可用的下载地址，请重新发送。',502);
        let data;try{data=await bounded(()=>rpc('get_image',{file}));}catch(error){active.throwIfAborted();throw new QQMediaError('QQ图片暂时无法取回，请重新发送。',502);}
        await checkRoute();
        if(data?.base64!==undefined)bytes=canonicalImage(data.base64,limit);
        else if(typeof data?.url==='string'&&data.url.startsWith('https://'))bytes=await download(data.url,limit);
        else throw new QQMediaError('QQ图片没有可用的下载地址，请重新发送。',502);
      }
      if(bytes.length>limit)throw new QQMediaError('QQ图片超过本条消息的大小限制。',413);
      const mime=rasterType(bytes);total+=bytes.length;media.push({bytes,mime,name:`qq-image-${media.length+1}.${extensions[mime]}`});
    }
    let refs=[];
    if(media.length){
      await checkRoute();
      try{refs=await bounded(()=>attachments.saveImages(media.map(m=>({data:new Uint8Array(m.bytes),mediaType:m.mime,name:m.name}))));}
      catch(error){active.throwIfAborted();throw new QQMediaError('QQ图片内容无效或DSH暂时无法保存图片附件。',502);}
      await checkRoute();
      if(!Array.isArray(refs)||refs.length!==media.length||refs.some(ref=>!ref||!/^sha256:[a-f0-9]{64}$/u.test(String(ref.attachmentId))||!imageTypes.has(ref.mediaType)||!Number.isSafeInteger(ref.width)||ref.width<1||!Number.isSafeInteger(ref.height)||ref.height<1||!Number.isSafeInteger(ref.bytes)||ref.bytes<1))throw new QQMediaError('DSH没有返回有效的QQ图片附件。',502);
    }
    const content=[];
    for(const part of parsed.parts){
      if(part.type==='text'&&typeof part.text==='string')content.push({type:'text',text:part.text});
      else if(part.type==='image'&&Number.isInteger(part.index)&&refs[part.index]){
        content.push({type:'image',attachment:refs[part.index]});
        if(media[part.index].mime==='image/gif')content.push({type:'text',text:'[QQ动图说明：当前模型接收的是单帧画面，不能据此判断完整动画。]',dafeiyuQQEnrichment:true});
      }else if(part.type==='face'&&Number.isInteger(part.index)&&parsed.faces[part.index]){
        const id=parsed.faces[part.index].id,name=faceNames.get(id)?.replace(/^\//u,'');
        content.push({type:'text',text:name?`[QQ系统表情：${name}]`:`[QQ系统表情，编号${id}，含义未知]`,dafeiyuQQEnrichment:true});
      }else throw new QQMediaError('QQ消息的图片或表情顺序无效。');
    }
    await checkRoute();return {content,media};
  }catch(error){active.throwIfAborted();if(error instanceof QQMediaError)throw error;throw new QQMediaError('QQ图片或表情暂时无法处理，请稍后重试。',502);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',externalAbort);}
}
