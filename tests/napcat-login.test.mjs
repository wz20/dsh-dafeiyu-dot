import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';

registerHooks({resolve(name,context,next){if(name==='@deepseek-ai/dsh-credentials')return {url:'data:text/javascript,export const credentialRef = name => ({name});',shortCircuit:true};return next(name,context);}});
const {createNapcatLogin,validateNapcatUrl}=await import('../lib/napcat-login.js');
const QR='https://txz.qq.com/p?k=fixture-code&f=1';
const SECRET='fixture-local-webui-secret';
const CREDENTIAL='fixture-session-credential';
const response=(data,options={})=>new Response(JSON.stringify({code:0,data}),{headers:{'Content-Type':'application/json'},...options});

function fixture(options={}) {
  const requests=[],refs=[];
  const value={qq:{napcatUrl:'http://127.0.0.1:16099'}};
  let secret=SECRET,status={isLogin:false,coreReady:false,loginPhase:'waiting_qrcode',qrcodeurl:QR};
  const ctx={credentials:{async resolve(ref){refs.push(ref);if(options.credentialError)throw Error(SECRET);return {value:secret};}}};
  const fetchImpl=async(url,init)=>{
    const path=new URL(url).pathname,body=JSON.parse(init.body);requests.push({url:String(url),path,init,body});
    if(options.respond)return options.respond(path,init,body,requests);
    if(path==='/api/auth/login')return response({Credential:CREDENTIAL});
    if(path==='/api/QQLogin/CheckLoginStatus')return response(status);
    if(path==='/api/QQLogin/RefreshQRcode')return response({qrcodeurl:QR});
    if(path==='/api/QQLogin/GetQQLoginQrcode')return response({qrcode:QR});
    throw Error('Unexpected fixture request');
  };
  const login=createNapcatLogin(ctx,{get:()=>structuredClone(value)},{fetchImpl,timeoutMs:options.timeoutMs??1000,...options.now?{now:options.now}:{}});
  return {login,requests,refs,value,setSecret:v=>{secret=v;},setStatus:v=>{status=v;}};
}

test('NapCat endpoints accept only credential-free loopback origins',()=>{
  for(const value of ['http://127.0.0.1:16099','https://localhost:6099/','http://[::1]:6099'])assert.match(validateNapcatUrl(value),/^https?:/);
  for(const value of ['https://remote.example','http://127.0.0.1.evil.example','http://name:secret@localhost','http://localhost?token=secret','http://localhost/#token','file:///tmp/napcat','ws://127.0.0.1','http://localhost/webui','http://0.0.0.0','http://192.168.1.1'])assert.throws(()=>validateNapcatUrl(value),{status:400});
});

test('authentication stays server-side and returns only the generated QR image and normalized status',async()=>{
  const e=fixture(),state=await e.login.state();
  assert.equal(state.phase,'waiting_qrcode');assert.equal(state.loggedIn,false);assert.equal(state.coreReady,false);
  assert.match(state.qrImage,/^data:image\/svg\+xml;base64,/);
  const svg=Buffer.from(state.qrImage.split(',')[1],'base64').toString();assert.match(svg,/<svg/);assert.match(svg,/<path/);
  assert.deepEqual(e.refs[0],{name:'DAFEIYU_NAPCAT_WEBUI_TOKEN'});
  assert.equal(e.requests[0].body.hash,createHash('sha256').update(SECRET+'.napcat').digest('hex'));
  assert.equal(e.requests[1].init.headers.Authorization,'Bearer '+CREDENTIAL);
  for(const req of e.requests){assert.equal(req.init.redirect,'error');assert.equal(req.init.cache,'no-store');assert.ok(req.init.signal);}
  assert.deepEqual(Object.keys(state).sort(),['coreReady','loggedIn','phase','qrImage']);
  assert.doesNotMatch(JSON.stringify(state),/fixture-local-webui-secret|fixture-session-credential|fixture-code|qrcodeurl|loginError/);
});

test('ready status waits for an explicit coreReady false, while original NapCat isLogin remains compatible',async()=>{
  const e=fixture();e.setStatus({isLogin:true,coreReady:false,loginPhase:'initializing',qrcodeurl:QR});
  assert.deepEqual(await e.login.state(),{phase:'initializing',loggedIn:false,coreReady:false});
  e.setStatus({isLogin:true});assert.deepEqual(await e.login.state({refresh:true}),{phase:'ready',loggedIn:true,coreReady:true});
  assert.equal(e.requests.filter(r=>r.path.includes('RefreshQRcode')).length,0);
});

test('an accepted scan is preserved even when refresh is requested',async()=>{
  const e=fixture();e.setStatus({isLogin:false,coreReady:false,qrLoginAccepted:true,loginPhase:'qrcode_scanned',qrcodeurl:QR});
  assert.deepEqual(await e.login.state({refresh:true}),{phase:'scanned',loggedIn:false,coreReady:false});
  assert.equal(e.requests.length,2);
});

test('refresh requests a new QR from the NapCat API and keeps reconnecting status separate',async()=>{
  const e=fixture();await e.login.state({refresh:true});assert.equal(e.requests.at(-1).path,'/api/QQLogin/RefreshQRcode');
  e.setStatus({isLogin:false,coreReady:false,loginPhase:'reconnecting',qrcodeurl:QR});
  assert.deepEqual(await e.login.state({refresh:true}),{phase:'reconnecting',loggedIn:false,coreReady:false});
  assert.equal(e.requests.filter(r=>r.path.includes('RefreshQRcode')).length,1);
});

test('a cached WebUI session is reused but a changed token or endpoint is authenticated again',async()=>{
  const e=fixture();await e.login.state();await e.login.state();
  assert.equal(e.requests.filter(r=>r.path==='/api/auth/login').length,1);
  e.setSecret('fixture-rotated-secret');await e.login.state();
  e.value.qq.napcatUrl='http://127.0.0.1:16098';await e.login.state();
  assert.equal(e.requests.filter(r=>r.path==='/api/auth/login').length,3);
});

test('missing or unavailable credentials produce safe actionable errors without contacting NapCat',async()=>{
  const e=fixture();e.setSecret('');await assert.rejects(e.login.state(),{status:428,code:'NAPCAT_TOKEN_REQUIRED'});assert.equal(e.requests.length,0);
  const f=fixture({credentialError:true});await assert.rejects(f.login.state(),error=>{assert.doesNotMatch(error.message,new RegExp(SECRET));return error.status===503;});assert.equal(f.requests.length,0);
});

test('a malformed endpoint cannot receive the stored token hash',async()=>{
  const e=fixture();e.value.qq.napcatUrl='https://external.example';await assert.rejects(e.login.state(),{status:400});assert.equal(e.requests.length,0);assert.equal(e.refs.length,0);
});

test('QQ QR destinations are restricted to safe HTTPS login domains',async()=>{
  const e=fixture();
  for(const qrcodeurl of ['http://txz.qq.com/p?k=x','https://txz.qq.com.evil.example/p','https://evil.example/p','https://secret@txz.qq.com/p','https://txz.qq.com:8443/p','javascript:alert(1)','data:image/png;base64,YQ==','https://txz.qq.com/p#fragment','https://txz.qq.com/p?k='+'x'.repeat(4096)]){
    e.setStatus({isLogin:false,qrcodeurl});await assert.rejects(e.login.state(),error=>error.code==='NAPCAT_QR_INVALID');
  }
});

test('upstream error text and unsupported secondary authentication never leak credential details',async()=>{
  const rejected=fixture({respond:()=>new Response(JSON.stringify({code:-1,message:SECRET}),{status:200})});
  await assert.rejects(rejected.login.state(),error=>{assert.doesNotMatch(error.message,new RegExp(SECRET));return error.status===401;});
  const twoFactor=fixture({respond:()=>response({require2FA:true})});
  await assert.rejects(twoFactor.login.state(),{status:409,code:'NAPCAT_2FA_REQUIRED'});
});

test('redirect and oversized upstream responses are rejected before a status is shown',async()=>{
  const redirect=fixture({respond:()=>new Response(null,{status:302,headers:{Location:'https://external.example/'}})});
  await assert.rejects(redirect.login.state(),error=>error.code==='NAPCAT_RESPONSE_INVALID');
  const oversized=fixture({respond:()=>new Response('x'.repeat(70_000),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(oversized.login.state(),error=>error.code==='NAPCAT_RESPONSE_INVALID');
});

test('the request deadline covers a stalled response body',async()=>{
  let cancelled=false;
  const hanging=fixture({timeoutMs:20,respond:()=>new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}})});
  await assert.rejects(hanging.login.state(),{status:504,code:'NAPCAT_TIMEOUT'});
  assert.equal(cancelled,true);
});

test('closing the dialog cancels a status request with a safe error',async()=>{
  const e=fixture({respond:()=>new Promise(()=>{})}),controller=new AbortController(),pending=e.login.state({signal:controller.signal});
  controller.abort();await assert.rejects(pending,{status:499,code:'NAPCAT_CANCELLED'});
});

test('the original QR endpoint is used only when the current status has no QR URL',async()=>{
  const e=fixture();e.setStatus({isLogin:false});
  const state=await e.login.state();assert.match(state.qrImage,/^data:image\/svg\+xml;base64,/);
  assert.equal(e.requests.at(-1).path,'/api/QQLogin/GetQQLoginQrcode');
  e.setStatus({isLogin:true,isOffline:true});
  assert.deepEqual(await e.login.state(),{phase:'waiting_qrcode',loggedIn:false,coreReady:false});
  assert.equal(e.requests.filter(r=>r.path==='/api/QQLogin/GetQQLoginQrcode').length,1);
});

test('refresh restarting does not produce a stale QR image',async()=>{
  const e=fixture({respond(path){if(path==='/api/auth/login')return response({Credential:CREDENTIAL});if(path==='/api/QQLogin/CheckLoginStatus')return response({isLogin:false,qrcodeurl:QR});return response({qrcodeurl:'',restarting:true});}});
  assert.deepEqual(await e.login.state({refresh:true}),{phase:'reconnecting',loggedIn:false,coreReady:false});
});

test('an expired cached session is authenticated once before the status request is retried',async()=>{
  let authCalls=0,statusCalls=0;
  const e=fixture({respond(path){
    if(path==='/api/auth/login'){authCalls++;return response({Credential:'fixture-session-'+authCalls});}
    statusCalls++;
    return statusCalls===2?new Response(JSON.stringify({code:-1,message:'Unauthorized'}),{status:401}):response({isLogin:true,coreReady:true});
  }});
  await e.login.state();assert.deepEqual(await e.login.state(),{phase:'ready',loggedIn:true,coreReady:true});
  assert.equal(authCalls,2);assert.equal(statusCalls,3);
});

test('a repeatedly rejected session ends with one safe error and bounded authentication attempts',async()=>{
  let authCalls=0;
  const e=fixture({respond(path){if(path==='/api/auth/login'){authCalls++;return response({Credential:CREDENTIAL});}return new Response(JSON.stringify({code:-1,message:SECRET}),{status:403});}});
  await assert.rejects(e.login.state(),error=>{assert.doesNotMatch(error.message,new RegExp(SECRET));return error.status===401&&error.code==='NAPCAT_TOKEN_INVALID';});
  assert.equal(authCalls,2);
});

test('a stalled transport obeys the operation deadline even if a fetch implementation ignores abort',async()=>{
  const e=fixture({timeoutMs:15,respond:()=>new Promise(()=>{})});
  await assert.rejects(e.login.state(),{status:504,code:'NAPCAT_TIMEOUT'});
});

test('upstream exception and invalid JSON are safely replaced',async()=>{
  const network=fixture({respond(){throw Error('socket failure '+SECRET);}});
  await assert.rejects(network.login.state(),error=>error.code==='NAPCAT_UNREACHABLE'&&!error.message.includes(SECRET));
  const broken=fixture({respond:()=>new Response('{broken '+SECRET)});
  await assert.rejects(broken.login.state(),error=>error.code==='NAPCAT_RESPONSE_INVALID'&&!error.message.includes(SECRET));
});

test('cancellation before work starts avoids credential reads and network requests',async()=>{
  const e=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(e.login.state({signal:controller.signal}),{code:'NAPCAT_CANCELLED'});
  assert.equal(e.refs.length,0);assert.equal(e.requests.length,0);
});

test('malformed status flags cannot be mistaken for a completed login',async()=>{
  const e=fixture();
  for(const status of [{isLogin:'true'},{isLogin:true,coreReady:'false'},{isLogin:true,isOffline:'true'},{isLogin:false,qrLoginAccepted:1}]){
    e.setStatus(status);await assert.rejects(e.login.state(),{code:'NAPCAT_RESPONSE_INVALID'});
  }
});

test('an explicit pending scan or initializing phase is preserved when a gateway omits coreReady',async()=>{
  const e=fixture();
  for(const phase of ['qrcode_scanned','initializing','reconnecting']){
    e.setStatus({isLogin:true,loginPhase:phase,qrLoginAccepted:phase!=='reconnecting'});
    const state=await e.login.state({refresh:true});assert.equal(state.loggedIn,false);assert.equal(state.phase,phase==='qrcode_scanned'?'scanned':phase);
  }
  assert.equal(e.requests.filter(r=>r.path.includes('RefreshQRcode')).length,0);
});

test('the cached management session is reauthenticated when its local cache lifetime expires',async()=>{
  let now=1_800_000_000_000;
  const e=fixture({now:()=>now});await e.login.state();now+=10*60*1000-1;await e.login.state();
  assert.equal(e.requests.filter(r=>r.path==='/api/auth/login').length,1);
  now++;await e.login.state();assert.equal(e.requests.filter(r=>r.path==='/api/auth/login').length,2);
});
