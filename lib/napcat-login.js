import {createHash} from 'node:crypto';
import qrcode from 'qrcode-generator';
import {napcatUrl} from './config.js';

const DEFAULT_URL='http://127.0.0.1:16099';
const MAX_RESPONSE_BYTES=64*1024;
const MAX_QR_LENGTH=2048;
const SESSION_TTL=10*60*1000;
const QR_HOSTS=new Set(['txz.qq.com','xui.ptlogin2.qq.com','ssl.ptlogin2.qq.com']);
export const validateNapcatUrl=napcatUrl;

class LoginError extends Error {
  constructor(message,status,code){super(message);this.status=status;this.code=code;}
}
const invalid=()=>new LoginError('NapCat 返回的登录信息无法读取，请稍后重试。',502,'NAPCAT_RESPONSE_INVALID');
const cancelled=()=>new LoginError('已停止检查 QQ 登录状态。',499,'NAPCAT_CANCELLED');

async function readResponse(response,signal) {
  if(!response.ok||response.redirected)throw invalid();
  const length=response.headers?.get('content-length');
  if(length!==null&&Number(length)>MAX_RESPONSE_BYTES)throw invalid();
  let text;
  if(response.body?.getReader){
    const reader=response.body.getReader(),parts=[];let size=0,complete=false;
    const abort=()=>{void reader.cancel().catch(()=>{});};
    signal.addEventListener('abort',abort,{once:true});
    try{
      while(true){
        if(signal.aborted)throw cancelled();
        const chunk=await reader.read();
        if(chunk.done){complete=true;break;}
        size+=chunk.value.byteLength;
        if(size>MAX_RESPONSE_BYTES)throw invalid();
        parts.push(Buffer.from(chunk.value));
      }
      text=Buffer.concat(parts,size).toString('utf8');
    }finally{
      signal.removeEventListener('abort',abort);
      if(!complete)void reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
  }else{
    text=await response.text();
    if(Buffer.byteLength(text)>MAX_RESPONSE_BYTES)throw invalid();
  }
  try{
    const value=JSON.parse(text);
    if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
    return value;
  }catch{throw invalid();}
}

function qrImage(value) {
  if(typeof value!=='string'||!value||value.length>MAX_QR_LENGTH||/[\r\n\0]/.test(value))throw new LoginError('NapCat 返回的登录二维码无效，请刷新后重试。',502,'NAPCAT_QR_INVALID');
  let url;
  try{url=new URL(value);}catch{throw new LoginError('NapCat 返回的登录二维码无效，请刷新后重试。',502,'NAPCAT_QR_INVALID');}
  if(url.protocol!=='https:'||!QR_HOSTS.has(url.hostname)||url.username||url.password||url.hash||url.port&&url.port!=='443')throw new LoginError('NapCat 返回的登录二维码无效，请刷新后重试。',502,'NAPCAT_QR_INVALID');
  const image=qrcode(0,'M');
  image.addData(url.href,'Byte');image.make();
  const svg=image.createSvgTag({cellSize:4,margin:16,scalable:true});
  return 'data:image/svg+xml;base64,'+Buffer.from(svg,'utf8').toString('base64');
}

export function createNapcatLogin(ctx,config,{fetchImpl=globalThis.fetch,timeoutMs=8000,now=Date.now}={}) {
  let cached=null;

  async function tokenValue(){
    let credential;
    try{
      const {credentialRef}=await import('@deepseek-ai/dsh-credentials');
      credential=await ctx.credentials.resolve(credentialRef('DAFEIYU_NAPCAT_WEBUI_TOKEN'));
    }catch{throw new LoginError('暂时无法读取 NapCat 管理密钥，请稍后重试。',503,'NAPCAT_CREDENTIALS_UNAVAILABLE');}
    if(typeof credential?.value!=='string'||!credential.value.trim())throw new LoginError('请先保存 NapCat 管理页 Token，再获取登录二维码。',428,'NAPCAT_TOKEN_REQUIRED');
    const token=credential.value.trim();
    if(token.length>8192)throw new LoginError('NapCat 管理页 Token 填写不正确。',401,'NAPCAT_TOKEN_INVALID');
    return token;
  }

  async function state({refresh=false,signal}={}) {
    if(signal?.aborted)throw cancelled();
    const endpoint=napcatUrl(config.get().qq?.napcatUrl??DEFAULT_URL);
    const controller=new AbortController();let timedOut=false,rejectAbort;
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const onAbort=()=>rejectAbort?.(timedOut?new LoginError('NapCat 登录检查超时，请确认本机服务正在运行。',504,'NAPCAT_TIMEOUT'):cancelled());
    controller.signal.addEventListener('abort',onAbort,{once:true});
    const abortPromise=new Promise((_,reject)=>{rejectAbort=reject;});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);

    const work=async()=>{
      const token=await tokenValue();
      const key=endpoint+'\n'+createHash('sha256').update(token).digest('hex');
      const post=async(path,body,credential)=>{
        if(controller.signal.aborted)throw cancelled();
        const response=await fetchImpl(endpoint+'/api'+path,{
          method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},
          body:JSON.stringify(body),signal:controller.signal,redirect:'error',cache:'no-store'
        });
        if(credential&&(response.status===401||response.status===403))throw new LoginError('',401,'NAPCAT_SESSION_EXPIRED');
        const result=await readResponse(response,controller.signal);
        if(result.code!==0){
          if(credential&&/^(?:Unauthorized|Token has expired|token is invalid)$/i.test(String(result.message??'')))throw new LoginError('',401,'NAPCAT_SESSION_EXPIRED');
          if(path==='/auth/login')throw new LoginError('NapCat 管理页 Token 不正确，请重新保存。',401,'NAPCAT_TOKEN_INVALID');
          throw new LoginError('NapCat 暂时无法提供登录信息，请稍后重试。',502,'NAPCAT_RESPONSE_INVALID');
        }
        if(!result.data||typeof result.data!=='object'||Array.isArray(result.data))throw invalid();
        return result.data;
      };
      const authenticate=async(force=false)=>{
        if(!force&&cached?.key===key&&cached.expiresAt>now())return cached.credential;
        const data=await post('/auth/login',{hash:createHash('sha256').update(token+'.napcat').digest('hex')});
        if(data.require2FA===true)throw new LoginError('NapCat 管理页已启用二次验证，请在本机管理页完成登录。',409,'NAPCAT_2FA_REQUIRED');
        if(typeof data.Credential!=='string'||!data.Credential||data.Credential.length>16_384)throw invalid();
        cached={key,credential:data.Credential,expiresAt:now()+SESSION_TTL};
        return cached.credential;
      };
      let credential=await authenticate();
      const call=async(path)=>{
        try{return await post(path,{},credential);}catch(error){
          if(error?.code!=='NAPCAT_SESSION_EXPIRED')throw error;
          cached=null;credential=await authenticate(true);
          try{return await post(path,{},credential);}catch(retryError){
            if(retryError?.code==='NAPCAT_SESSION_EXPIRED')throw new LoginError('NapCat 管理页登录已失效，请重新保存 Token。',401,'NAPCAT_TOKEN_INVALID');
            throw retryError;
          }
        }
      };
      const status=await call('/QQLogin/CheckLoginStatus');
      if(typeof status.isLogin!=='boolean')throw invalid();
      for(const field of ['coreReady','isOffline','qrLoginAccepted'])if(status[field]!==undefined&&typeof status[field]!=='boolean')throw invalid();
      const pendingScan=status.qrLoginAccepted===true||['qrcode_scanned','initializing','reconnecting'].includes(status.loginPhase);
      const ready=status.isLogin===true&&status.isOffline!==true&&(status.coreReady===true||status.coreReady===undefined&&!pendingScan);
      if(ready)return {phase:'ready',loggedIn:true,coreReady:true};
      const waiting={loggedIn:false,coreReady:false};
      if(status.loginPhase==='reconnecting')return {phase:'reconnecting',...waiting};
      if(status.loginPhase==='initializing'||status.isLogin===true&&status.coreReady===false)return {phase:'initializing',...waiting};
      if(status.qrLoginAccepted===true||status.loginPhase==='qrcode_scanned')return {phase:'scanned',...waiting};
      let code=status.qrcodeurl;
      if(refresh){
        const refreshed=await call('/QQLogin/RefreshQRcode');
        if(refreshed.restarting===true)return {phase:'reconnecting',...waiting};
        code=refreshed.qrcodeurl;
      }else if(!code&&status.isOffline!==true){
        code=(await call('/QQLogin/GetQQLoginQrcode')).qrcode;
      }
      return {phase:'waiting_qrcode',...waiting,...code?{qrImage:qrImage(code)}:{}};
    };
    try{return await Promise.race([work(),abortPromise]);}
    catch(error){
      if(error instanceof LoginError)throw error;
      if(controller.signal.aborted)throw timedOut?new LoginError('NapCat 登录检查超时，请确认本机服务正在运行。',504,'NAPCAT_TIMEOUT'):cancelled();
      throw new LoginError('无法连接本机 NapCat，请确认管理页地址与服务状态。',503,'NAPCAT_UNREACHABLE');
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);
    }
  }
  return {state};
}
