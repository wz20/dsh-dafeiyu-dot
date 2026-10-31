import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { json, readJson, authorize } from './http.js';
import { currentPreset, resolveAgent, requireWhale, switchWhaleMode, projectMessages, sendText, isRoot } from './session.js';
import { validatePatch } from './config.js';
import { spaces } from './memory.js';
import { getModelSelection, listSessionModels, selectSessionModel } from './models.js';
import { localAssetPath } from './local-assets.js';
const BASE='/dsh-dafeiyu-dot';
const assetRoot=fileURLToPath(new URL('../assets/',import.meta.url));
const mimes={'.png':'image/png','.svg':'image/svg+xml','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.md':'text/plain; charset=utf-8','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg'};
// Unicode full case-fold exceptions after compatibility normalization (Unicode 16.0.0).
const graphCaseFold={"\u00df":"ss","\u01f0":"j\u030c","\u0345":"\u03b9","\u0390":"\u03b9\u0308\u0301","\u03b0":"\u03c5\u0308\u0301","\u03c2":"\u03c3","\u13a0":"\u13a0","\u13a1":"\u13a1","\u13a2":"\u13a2","\u13a3":"\u13a3","\u13a4":"\u13a4","\u13a5":"\u13a5","\u13a6":"\u13a6","\u13a7":"\u13a7","\u13a8":"\u13a8","\u13a9":"\u13a9","\u13aa":"\u13aa","\u13ab":"\u13ab","\u13ac":"\u13ac","\u13ad":"\u13ad","\u13ae":"\u13ae","\u13af":"\u13af","\u13b0":"\u13b0","\u13b1":"\u13b1","\u13b2":"\u13b2","\u13b3":"\u13b3","\u13b4":"\u13b4","\u13b5":"\u13b5","\u13b6":"\u13b6","\u13b7":"\u13b7","\u13b8":"\u13b8","\u13b9":"\u13b9","\u13ba":"\u13ba","\u13bb":"\u13bb","\u13bc":"\u13bc","\u13bd":"\u13bd","\u13be":"\u13be","\u13bf":"\u13bf","\u13c0":"\u13c0","\u13c1":"\u13c1","\u13c2":"\u13c2","\u13c3":"\u13c3","\u13c4":"\u13c4","\u13c5":"\u13c5","\u13c6":"\u13c6","\u13c7":"\u13c7","\u13c8":"\u13c8","\u13c9":"\u13c9","\u13ca":"\u13ca","\u13cb":"\u13cb","\u13cc":"\u13cc","\u13cd":"\u13cd","\u13ce":"\u13ce","\u13cf":"\u13cf","\u13d0":"\u13d0","\u13d1":"\u13d1","\u13d2":"\u13d2","\u13d3":"\u13d3","\u13d4":"\u13d4","\u13d5":"\u13d5","\u13d6":"\u13d6","\u13d7":"\u13d7","\u13d8":"\u13d8","\u13d9":"\u13d9","\u13da":"\u13da","\u13db":"\u13db","\u13dc":"\u13dc","\u13dd":"\u13dd","\u13de":"\u13de","\u13df":"\u13df","\u13e0":"\u13e0","\u13e1":"\u13e1","\u13e2":"\u13e2","\u13e3":"\u13e3","\u13e4":"\u13e4","\u13e5":"\u13e5","\u13e6":"\u13e6","\u13e7":"\u13e7","\u13e8":"\u13e8","\u13e9":"\u13e9","\u13ea":"\u13ea","\u13eb":"\u13eb","\u13ec":"\u13ec","\u13ed":"\u13ed","\u13ee":"\u13ee","\u13ef":"\u13ef","\u13f0":"\u13f0","\u13f1":"\u13f1","\u13f2":"\u13f2","\u13f3":"\u13f3","\u13f4":"\u13f4","\u13f5":"\u13f5","\u13f8":"\u13f0","\u13f9":"\u13f1","\u13fa":"\u13f2","\u13fb":"\u13f3","\u13fc":"\u13f4","\u13fd":"\u13f5","\u1c80":"\u0432","\u1c81":"\u0434","\u1c82":"\u043e","\u1c83":"\u0441","\u1c84":"\u0442","\u1c85":"\u0442","\u1c86":"\u044a","\u1c87":"\u0463","\u1c88":"\ua64b","\u1e96":"h\u0331","\u1e97":"t\u0308","\u1e98":"w\u030a","\u1e99":"y\u030a","\u1e9e":"ss","\u1f50":"\u03c5\u0313","\u1f52":"\u03c5\u0313\u0300","\u1f54":"\u03c5\u0313\u0301","\u1f56":"\u03c5\u0313\u0342","\u1f80":"\u1f00\u03b9","\u1f81":"\u1f01\u03b9","\u1f82":"\u1f02\u03b9","\u1f83":"\u1f03\u03b9","\u1f84":"\u1f04\u03b9","\u1f85":"\u1f05\u03b9","\u1f86":"\u1f06\u03b9","\u1f87":"\u1f07\u03b9","\u1f88":"\u1f00\u03b9","\u1f89":"\u1f01\u03b9","\u1f8a":"\u1f02\u03b9","\u1f8b":"\u1f03\u03b9","\u1f8c":"\u1f04\u03b9","\u1f8d":"\u1f05\u03b9","\u1f8e":"\u1f06\u03b9","\u1f8f":"\u1f07\u03b9","\u1f90":"\u1f20\u03b9","\u1f91":"\u1f21\u03b9","\u1f92":"\u1f22\u03b9","\u1f93":"\u1f23\u03b9","\u1f94":"\u1f24\u03b9","\u1f95":"\u1f25\u03b9","\u1f96":"\u1f26\u03b9","\u1f97":"\u1f27\u03b9","\u1f98":"\u1f20\u03b9","\u1f99":"\u1f21\u03b9","\u1f9a":"\u1f22\u03b9","\u1f9b":"\u1f23\u03b9","\u1f9c":"\u1f24\u03b9","\u1f9d":"\u1f25\u03b9","\u1f9e":"\u1f26\u03b9","\u1f9f":"\u1f27\u03b9","\u1fa0":"\u1f60\u03b9","\u1fa1":"\u1f61\u03b9","\u1fa2":"\u1f62\u03b9","\u1fa3":"\u1f63\u03b9","\u1fa4":"\u1f64\u03b9","\u1fa5":"\u1f65\u03b9","\u1fa6":"\u1f66\u03b9","\u1fa7":"\u1f67\u03b9","\u1fa8":"\u1f60\u03b9","\u1fa9":"\u1f61\u03b9","\u1faa":"\u1f62\u03b9","\u1fab":"\u1f63\u03b9","\u1fac":"\u1f64\u03b9","\u1fad":"\u1f65\u03b9","\u1fae":"\u1f66\u03b9","\u1faf":"\u1f67\u03b9","\u1fb2":"\u1f70\u03b9","\u1fb3":"\u03b1\u03b9","\u1fb4":"\u03ac\u03b9","\u1fb6":"\u03b1\u0342","\u1fb7":"\u03b1\u0342\u03b9","\u1fbc":"\u03b1\u03b9","\u1fc2":"\u1f74\u03b9","\u1fc3":"\u03b7\u03b9","\u1fc4":"\u03ae\u03b9","\u1fc6":"\u03b7\u0342","\u1fc7":"\u03b7\u0342\u03b9","\u1fcc":"\u03b7\u03b9","\u1fd2":"\u03b9\u0308\u0300","\u1fd6":"\u03b9\u0342","\u1fd7":"\u03b9\u0308\u0342","\u1fe2":"\u03c5\u0308\u0300","\u1fe4":"\u03c1\u0313","\u1fe6":"\u03c5\u0342","\u1fe7":"\u03c5\u0308\u0342","\u1ff2":"\u1f7c\u03b9","\u1ff3":"\u03c9\u03b9","\u1ff4":"\u03ce\u03b9","\u1ff6":"\u03c9\u0342","\u1ff7":"\u03c9\u0342\u03b9","\u1ffc":"\u03c9\u03b9","\uab70":"\u13a0","\uab71":"\u13a1","\uab72":"\u13a2","\uab73":"\u13a3","\uab74":"\u13a4","\uab75":"\u13a5","\uab76":"\u13a6","\uab77":"\u13a7","\uab78":"\u13a8","\uab79":"\u13a9","\uab7a":"\u13aa","\uab7b":"\u13ab","\uab7c":"\u13ac","\uab7d":"\u13ad","\uab7e":"\u13ae","\uab7f":"\u13af","\uab80":"\u13b0","\uab81":"\u13b1","\uab82":"\u13b2","\uab83":"\u13b3","\uab84":"\u13b4","\uab85":"\u13b5","\uab86":"\u13b6","\uab87":"\u13b7","\uab88":"\u13b8","\uab89":"\u13b9","\uab8a":"\u13ba","\uab8b":"\u13bb","\uab8c":"\u13bc","\uab8d":"\u13bd","\uab8e":"\u13be","\uab8f":"\u13bf","\uab90":"\u13c0","\uab91":"\u13c1","\uab92":"\u13c2","\uab93":"\u13c3","\uab94":"\u13c4","\uab95":"\u13c5","\uab96":"\u13c6","\uab97":"\u13c7","\uab98":"\u13c8","\uab99":"\u13c9","\uab9a":"\u13ca","\uab9b":"\u13cb","\uab9c":"\u13cc","\uab9d":"\u13cd","\uab9e":"\u13ce","\uab9f":"\u13cf","\uaba0":"\u13d0","\uaba1":"\u13d1","\uaba2":"\u13d2","\uaba3":"\u13d3","\uaba4":"\u13d4","\uaba5":"\u13d5","\uaba6":"\u13d6","\uaba7":"\u13d7","\uaba8":"\u13d8","\uaba9":"\u13d9","\uabaa":"\u13da","\uabab":"\u13db","\uabac":"\u13dc","\uabad":"\u13dd","\uabae":"\u13de","\uabaf":"\u13df","\uabb0":"\u13e0","\uabb1":"\u13e1","\uabb2":"\u13e2","\uabb3":"\u13e3","\uabb4":"\u13e4","\uabb5":"\u13e5","\uabb6":"\u13e6","\uabb7":"\u13e7","\uabb8":"\u13e8","\uabb9":"\u13e9","\uabba":"\u13ea","\uabbb":"\u13eb","\uabbc":"\u13ec","\uabbd":"\u13ed","\uabbe":"\u13ee","\uabbf":"\u13ef"};
function graphSearchText(value){return Array.from(String(value??'').normalize('NFKC'),char=>graphCaseFold[char]??char.toLowerCase()).join('');}
export function registerRoutes(ctx,{config,memory,speech,singing,reconcile,lifecycle,qq,napcatLogin,cwd,localAssetRoot}) {
  const receipts=new Map();
  const credential=()=>credentialRef('DAFEIYU_TTS_API_KEY');
  const configView=async()=>{
    const c=config.get();
    try{const d=await ctx.credentials.describe(credential());c.tts.keyConfigured=!!d?.configured;}catch{c.tts.keyConfigured=false;}
    if(c.qq)try{const d=await ctx.credentials.describe(credentialRef('DAFEIYU_QQ_TOKEN'));c.qq.tokenConfigured=!!d?.configured;}catch{c.qq.tokenConfigured=false;}
    if(c.qq)try{const d=await ctx.credentials.describe(credentialRef('DAFEIYU_NAPCAT_WEBUI_TOKEN'));c.qq.napcatTokenConfigured=!!d?.configured;}catch{c.qq.napcatTokenConfigured=false;}
    return c;
  };
  const sessions=async signal=>{
    const result=await ctx.sessionController.list({},signal);
    return result.items.filter(row=>!row.parentSessionId&&row.origin!=='subagent').map(row=>({id:row.sessionId,title:row.projections?.values?.title??'未命名会话',preset:row.projections?.values?.agentPreset??'standard'}));
  };
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:BASE,handler:async(req,res)=>{
    const rejection=authorize(req,ctx.connection);if(rejection){json(res,rejection,{ok:false,error:'请从 DeepSeek Harness 内打开。'});return;}
    const controller=new AbortController();const abort=()=>controller.abort();
    req.once('aborted',abort);res.once('close',abort);
    try{
      const url=new URL(req.url,'http://localhost');const route=url.pathname.slice(BASE.length);const method=req.method;
      if(method==='GET'&&route.startsWith('/assets/')){
        const relative=decodeURIComponent(route.slice(8));const target=resolve(assetRoot,relative);
        if(!target.startsWith(assetRoot.replace(/\/$/,'')+sep)||!mimes[extname(target)]||relative.includes('\0'))throw Object.assign(Error('资源不存在。'),{status:404});
        const personal=await localAssetPath(localAssetRoot,relative),selected=personal??target;
        const meta=await stat(selected);if(!meta.isFile()||meta.size>15_000_000)throw Object.assign(Error('资源不可用。'),{status:404});
        const bytes=await readFile(selected),cache=personal?'private, no-store':['.css','.js'].includes(extname(target))?'no-cache':'public, max-age=3600';res.writeHead(200,{'Content-Type':mimes[extname(target)],'Cache-Control':cache,'X-Content-Type-Options':'nosniff'});res.end(bytes);return;
      }
      if(method==='GET'&&route==='/state'){
        const sid=url.searchParams.get('sessionId');let session=null;
        const roster=await sessions(controller.signal);
        if(sid){const agent=await resolveAgent(ctx,sid);const selected=getModelSelection(ctx,agent);session={id:agent.id,title:roster.find(s=>s.id===agent.id)?.title??'陪伴会话',preset:currentPreset(agent.session),running:agent.status!=='idle',model:selected?.model??'',modelSelection:selected};}
        json(res,200,{ok:true,config:await configView(),session,sessions:roster,speech:speech.snapshot?.()??{},widget:config.get().widget,qq:qq?.snapshot()??null});return;
      }
      if(method==='GET'&&route==='/messages'){
        const agent=await resolveAgent(ctx,url.searchParams.get('sessionId'));
        const events=agent.session.snapshotEvents();let lastTurnEnd=null;
        events.forEach((event,index)=>{if(event.type==='turn/end')lastTurnEnd={id:String(event.id??index),reason:event.data?.reason?.kind??'unknown'};});
        json(res,200,{ok:true,messages:projectMessages(events),lastTurnEnd,running:agent.status!=='idle',preset:currentPreset(agent.session),modelSelection:getModelSelection(ctx,agent)});return;
      }
      if(method==='GET'&&route==='/models'){json(res,200,{ok:true,...await listSessionModels(ctx,{sessionId:url.searchParams.get('sessionId')},controller.signal)});return;}
      if(method==='GET'&&route==='/widget'){json(res,200,{ok:true,widget:config.get().widget});return;}
      if(method==='GET'&&route==='/qq/groups'){
        if(!qq?.listGroups)throw Object.assign(Error('QQ群列表尚未就绪。'),{status:503});
        json(res,200,{ok:true,groups:await qq.listGroups()});return;
      }
      if(method==='GET'&&route==='/memories'){json(res,200,{ok:true,memories:memory.search(url.searchParams.get('q')??''),spaces,palace:{...memory.status(),organizer:lifecycle?.snapshot()},index:memory.index()});return;}
      if(method==='GET'&&route==='/memory/graph/search'){
        const query=url.searchParams.get('q')??'';
        if(query.length>1000)throw Object.assign(Error('搜索内容最多一千个字符。'),{status:400});
        if(typeof memory.get!=='function')throw Object.assign(Error('记忆图谱尚未就绪。'),{status:503});
        const terms=graphSearchText(query).trim().split(/\s+/u).filter(Boolean),inventory=memory.get();
        const ids=(Array.isArray(inventory?.memories)?inventory.memories:[])
          .filter(record=>record?.status==='active'&&!record.testOnly&&!record.source?.testOnly)
          .filter(record=>{
            const text=graphSearchText([...['content','value','subject','entity','scope','predicate'].map(field=>typeof record[field]==='string'?record[field]:''),...(Array.isArray(record.tags)?record.tags.filter(tag=>typeof tag==='string'):[])].join('\n'));
            return terms.every(term=>text.includes(term));
          }).map(record=>record.id);
        json(res,200,{ok:true,ids});return;
      }
      if(method==='GET'&&route==='/memory/graph'){
        if(typeof memory.get!=='function')throw Object.assign(Error('记忆图谱尚未就绪。'),{status:503});
        const inventory=memory.get();
        const records=(Array.isArray(inventory?.memories)?inventory.memories:[])
          .filter(record=>record?.status==='active'&&!record.testOnly&&!record.source?.testOnly)
          .map(record=>{
            const content=typeof record.content==='string'?record.content:'';
            const entry={};
            for(const field of ['id','spaceId','subject','entity','scope','predicate','createdAt','updatedAt','status'])if(typeof record[field]==='string')entry[field]=record[field];
            return {...entry,tags:Array.isArray(record.tags)?record.tags.filter(tag=>typeof tag==='string'):[],content:content.slice(0,1200),contentLength:content.length,truncated:content.length>1200,...typeof record.source?.kind==='string'?{source:{kind:record.source.kind}}:{}};
          });
        const ids=new Set(records.map(record=>record.id)),catalog=memory.index?.()??{},index={builtAt:catalog.builtAt};
        for(const kind of ['people','topics','dates'])index[kind]=(Array.isArray(catalog[kind])?catalog[kind]:[]).map(group=>{
          const members=Array.isArray(group.ids)?group.ids.filter(id=>ids.has(id)):[];
          return {...kind==='dates'?{date:group.date}:{name:group.name},ids:members,count:members.length};
        }).filter(group=>group.count>0);
        json(res,200,{ok:true,records,spaces,palace:{...memory.status(),organizer:lifecycle?.snapshot()},index});return;
      }
      if(method==='GET'&&route==='/memory'){
        const record=memory.getRecord(url.searchParams.get('id'));
        if(!record)throw Object.assign(Error('这条记忆已不存在。'),{status:404});
        json(res,200,{ok:true,memory:record});return;
      }
      if(method==='GET'&&route==='/voices'){json(res,200,{ok:true,voices:await speech.voices()});return;}
      if(method==='GET'&&route==='/qq/state'){json(res,200,{ok:true,qq:qq?.snapshot()??null,config:(await configView()).qq});return;}
      if(method==='GET'&&route==='/qq/login'){
        if(!napcatLogin)throw Object.assign(Error('NapCat扫码服务尚未就绪。'),{status:503});
        json(res,200,{ok:true,login:await napcatLogin.state({signal:controller.signal}),qq:qq?.snapshot()??null});return;
      }
      if(method==='GET'&&route==='/health'){json(res,200,{ok:true,...await speech.health()});return;}
      if(!['POST','DELETE'].includes(method)){json(res,405,{ok:false,error:'不支持此操作。'});return;}
      const body=await readJson(req);
      if(method==='POST'&&route==='/qq/login/config'){
        const next=validatePatch(config.get(),{qq:{napcatUrl:body.napcatUrl??config.get().qq.napcatUrl}});
        if(body.napcatToken!==undefined){
          if(typeof body.napcatToken!=='string'||body.napcatToken.length>8192)throw Object.assign(Error('NapCat管理密钥填写不正确。'),{status:400});
          if(body.napcatToken.trim())await ctx.credentials.set(credentialRef('DAFEIYU_NAPCAT_WEBUI_TOKEN'),body.napcatToken.trim());
        }
        await config.update({qq:{napcatUrl:next.qq.napcatUrl}});json(res,200,{ok:true,config:(await configView()).qq});return;
      }
      if(method==='POST'&&route==='/qq/login/refresh'){
        if(!napcatLogin)throw Object.assign(Error('NapCat扫码服务尚未就绪。'),{status:503});
        json(res,200,{ok:true,login:await napcatLogin.state({refresh:true,signal:controller.signal}),qq:qq?.snapshot()??null});return;
      }
      if(method==='POST'&&route==='/config'){
        validatePatch(config.get(),body);
        const key=body.apiKey??body.tts?.apiKey;
        if(typeof key==='string'&&key.trim()){
          if(key.length>8192)throw Object.assign(Error('API 密钥过长。'),{status:400});
          await ctx.credentials.set(credential(),key.trim());
        }
        if(body.qqToken!==undefined){
          if(typeof body.qqToken!=='string'||body.qqToken.length>8192)throw Object.assign(Error('QQ网关令牌填写不正确。'),{status:400});
          if(body.qqToken.trim())await ctx.credentials.set(credentialRef('DAFEIYU_QQ_TOKEN'),body.qqToken.trim());
        }
        await config.update(body);await reconcile();json(res,200,{ok:true,config:await configView()});return;
      }
      if(method==='POST'&&route==='/widget'){await config.update({widget:body});json(res,200,{ok:true,widget:config.get().widget});return;}
      if(method==='POST'&&route==='/mode'){const switched=await switchWhaleMode(ctx,body);await qq?.reconcile();json(res,200,{ok:true,...switched});return;}
      if(method==='POST'&&route==='/qq/pairing'){if(!qq)throw Object.assign(Error('QQ通道尚未就绪。'),{status:503});json(res,200,{ok:true,pairing:qq.startPairing(),qq:qq.snapshot()});return;}
      if(method==='POST'&&route==='/qq/reconnect'){if(!qq?.reconnect)throw Object.assign(Error('QQ通道尚未就绪。'),{status:503});json(res,200,{ok:true,qq:await qq.reconnect()});return;}
      if(method==='POST'&&route==='/qq/unpair'){await config.update({qq:{ownerId:''}});await qq?.reconcile();json(res,200,{ok:true,qq:qq?.snapshot()??null,config:(await configView()).qq});return;}
      if(method==='POST'&&route==='/model'){json(res,200,{ok:true,...await selectSessionModel(ctx,body)});return;}
      if(method==='POST'&&route==='/session'){
        const created=await ctx.sessionController.create({agentPreset:'whale',...(cwd?{cwd}: {})});
        json(res,200,{ok:true,sessionId:created.sessionId});return;
      }
      if(method==='POST'&&route==='/send'){json(res,200,{ok:true,...await sendText(ctx,body,receipts)});return;}
      if(method==='POST'&&route==='/stop'){const agent=requireWhale(await resolveAgent(ctx,body.sessionId));agent.cancel({kind:'user'});json(res,200,{ok:true});return;}
      if(method==='POST'&&route==='/synthesize'){
        const agent=body.preview===true?null:requireWhale(await resolveAgent(ctx,body.sessionId));
        const reply=agent&&body.replyId?projectMessages(agent.session.snapshotEvents()).find(row=>row.id===body.replyId&&row.role==='assistant'&&row.speakable):null;
        if(body.replyId&&!reply)throw Object.assign(Error('这条回复尚未完成或已不可用。'),{status:409});
        const audio=reply?.songId?await singing.read(reply.songId,body.sessionId):await speech.synthesize(body.text,{signal:controller.signal,preview:body.preview,sessionId:body.sessionId,...body.preview===true?{previewEmotion:body.previewEmotion}:{}});
        if(body.preview!==true)requireWhale(await resolveAgent(ctx,body.sessionId));
        res.writeHead(200,{'Content-Type':audio.mime,'Cache-Control':'no-store',...(audio.delivery?{'X-Dafeiyu-Delivery':audio.delivery.mode,...audio.delivery.emotion?{'X-Dafeiyu-Emotion':audio.delivery.emotion}:{},...Number.isSafeInteger(audio.delivery.preparationMs)&&audio.delivery.preparationMs>=0?{'X-Dafeiyu-Preparation-Ms':String(audio.delivery.preparationMs)}:{},...typeof audio.delivery.cached==='boolean'?{'X-Dafeiyu-Cached':String(audio.delivery.cached)}:{}}:{})});res.end(audio.audio);return;
      }
      if(method==='POST'&&route==='/speech/prepare'){await speech.prepare();json(res,200,{ok:true,...await speech.health()});return;}
      if(method==='POST'&&route==='/transcribe'){
        requireWhale(await resolveAgent(ctx,body.sessionId));
        json(res,200,{ok:true,...await speech.transcribe(body,controller.signal)});return;
      }
      if(method==='POST'&&route==='/memories'){json(res,200,{ok:true,memory:await memory.put(body)});return;}
      if(method==='DELETE'&&route==='/memories'){await memory.remove(body.id);json(res,200,{ok:true});return;}
      if(method==='POST'&&route==='/memory/reindex'){const index=await memory.rebuildIndex();json(res,200,{ok:true,index,palace:memory.status()});return;}
      if(method==='POST'&&route==='/memory/projects/reconcile'){
        if(typeof memory.reconcileProjectFacts!=='function')throw Object.assign(Error('项目记忆整理尚未就绪。'),{status:503});
        const result=await memory.reconcileProjectFacts();json(res,200,{ok:true,...result,palace:memory.status()});return;
      }
      if(method==='POST'&&route==='/memory/retry'){
        if(!lifecycle)throw Object.assign(Error('记忆整理器尚未就绪。'),{status:503});
        json(res,200,{ok:true,...await lifecycle.retry(body.id),palace:memory.status()});return;
      }
      json(res,404,{ok:false,error:'这个入口暂时不可用。'});
    }catch(error){
      if(controller.signal.aborted)return;
      const known=Number.isInteger(error.status)&&error.status>=400&&error.status<=599;
      if(!known)console.error('dsh-dafeiyu-dot request failed:',error?.name??'Error');
      json(res,known?error.status:500,{ok:false,error:known?error.message:'操作暂时未完成，请稍后重试。',...(error.code==='NAPCAT_TOKEN_REQUIRED'?{code:error.code}:{})});
    }finally{req.off('aborted',abort);res.off('close',abort);}
  }}));
}
