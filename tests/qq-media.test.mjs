import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQQContent,prepareQQContent} from '../lib/qq-media.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const url='https://gchat.qpic.cn/example/image.png?fileid=private-selector';
const image=(address=url)=>({type:'image',data:{file:'ABC123.png',url:address}});
const text=value=>({type:'text',data:{text:value}});
function environment({modalities=['text','image'],fetch:fetcher,saveImages}={}) {
  let selected={provider:'deepseek-account',model:'deepseek-flash'};
  const calls=[],saved=[],admissions=[],agent={id:'session-1'};
  const ctx={sessionController:{agents:{selectionFor:()=>({current:selected})}},llm:{resolveModelInfo:async()=>({inputModalities:modalities})},get:key=>key==='attachments'?{saveImages:async inputs=>{saved.push(inputs);if(saveImages)return saveImages(inputs);return inputs.map((_v,i)=>({attachmentId:'sha256:'+String(i+1).repeat(64),mediaType:'image/png',width:1,height:1,bytes:PNG.length}));}}:undefined};
  const options={admit:async()=>{admissions.push(true);},fetch:async(address,init)=>{calls.push({address,init});return fetcher?fetcher(address,init):new Response(PNG);}};
  return {ctx,agent,calls,saved,admissions,options,setSelection:value=>{selected=value;}};
}
const prepare=(e,message,extra={})=>prepareQQContent(e.ctx,e.agent,parseQQContent(message),{...e.options,...extra});
const safeError=(status,pattern=/QQ|图片|表情|模型|附件/)=>error=>error?.status===status&&pattern.test(error.message)&&!error.message.includes('private-selector')&&!error.message.includes('PRIVATE');

test('parsing preserves raw text and source order while separating images and official face labels',()=>{
 const p=parseQQContent([text(' 原文 '),image(),{type:'face',data:{id:'14'}},text('继续'),{type:'at',data:{qq:'10001'}}]);
 assert.equal(p.text,' 原文 继续');assert.equal(p.kind,'image');assert.equal(p.images.length,1);assert.equal(p.faces[0].name,'微笑');
 assert.deepEqual(p.parts.map(v=>v.type),['text','image','face','text']);assert.equal(p.parts[0].text,' 原文 ');
 assert.equal(parseQQContent('[CQ:face,id=14]').faces.length,0);
 assert.equal(parseQQContent([{type:'face',data:{id:{toString:'not-callable'}}}]).faces.length,0);
});

test('market stickers reported as image or mface use validated marketplace metadata',()=>{
 const data={emoji_package_id:123,emoji_id:'abcdef0123456789abcdef0123456789',key:'market-key',summary:'[开心]'};
 const p=parseQQContent([{type:'mface',data}]);assert.equal(p.kind,'image');assert.match(p.images[0].url,/^https:\/\/gxh\.vip\.qq\.com\//);assert.equal(p.images[0].mface.emoji_id,data.emoji_id);
 const mapped=parseQQContent([{type:'image',data:{...data,file:'AB.gif',url:p.images[0].url}}]);assert.equal(mapped.images[0].mface.emoji_package_id,123);
});

test('more than three images and unsafe or malformed image selectors are refused',()=>{
 assert.throws(()=>parseQQContent([image(),image(),image(),image()]),safeError(400));
 for(const address of ['http://gchat.qpic.cn/x','https://gchat.qpic.cn.evil.example/x','https://gchat.qpic.cn@evil.example/x','https://u:p@gchat.qpic.cn/x','https://gchat.qpic.cn:444/x','https://127.0.0.1/x','file:///etc/passwd','https://multimedia.nt.qq.com.cn.evil/x'])assert.throws(()=>parseQQContent([image(address)]),safeError(400));
 assert.throws(()=>parseQQContent([{type:'image',data:{file:'/etc/passwd'}}]),safeError(400));
});

test('text and faces require no vision service and generated labels never become user original text',async()=>{
 const ctx={},agent={};const p=parseQQContent([text('请记住这句原话'),{type:'face',data:{id:'14'}},{type:'face',data:{id:'999999'}}]);
 const result=await prepareQQContent(ctx,agent,p);
 assert.deepEqual(result.content[0],{type:'text',text:'请记住这句原话'});
 const labels=result.content.filter(v=>v.dafeiyuQQEnrichment);assert.equal(labels.length,2);assert.match(labels[0].text,/微笑/);assert.match(labels[1].text,/编号.*999999/);assert.equal(result.media.length,0);
});

test('accepted images use the selected model and admitted durable attachment references',async()=>{
 const e=environment(),result=await prepare(e,[image(),text('这是我发的图')]);
 assert.equal(e.calls.length,1);assert.equal(e.calls[0].init.redirect,'manual');assert.equal(e.saved.length,1);assert.deepEqual(Buffer.from(e.saved[0][0].data),PNG);
 assert.equal(result.content[0].type,'image');assert.equal(result.content[0].attachment.attachmentId,'sha256:'+'1'.repeat(64));assert.deepEqual(result.content[1],{type:'text',text:'这是我发的图'});
 assert.deepEqual(result.media[0].bytes,PNG);assert.equal(result.media[0].mime,'image/png');assert.equal(result.media[0].url,undefined);assert.doesNotMatch(JSON.stringify(result.media),/private-selector|https|file:/);assert.ok(e.admissions.length>=3);
});

test('GIF bytes remain available for this turn while the model gets an explicitly single-frame attachment',async()=>{
 const e=environment({fetch:()=>new Response(GIF)}),result=await prepare(e,[image('https://gxh.vip.qq.com/face.gif')]);
 assert.deepEqual(result.media[0].bytes,GIF);assert.equal(result.media[0].mime,'image/gif');assert.equal(e.saved[0][0].mediaType,'image/gif');assert.ok(result.content.some(v=>v.dafeiyuQQEnrichment&&/单帧/.test(v.text)));
});

test('text-only models and unavailable attachment storage fail before any image download',async()=>{
 const e=environment({modalities:['text']});await assert.rejects(prepare(e,[image()]),safeError(409));assert.equal(e.calls.length,0);assert.equal(e.saved.length,0);
 const missing=environment();missing.ctx.get=()=>undefined;await assert.rejects(prepare(missing,[image()]),safeError(503));assert.equal(missing.calls.length,0);
});

test('image preparation requires an explicit identity-admission callback',async()=>{
 const e=environment();await assert.rejects(prepareQQContent(e.ctx,e.agent,parseQQContent([image()]),{fetch:e.options.fetch}),safeError(409));assert.equal(e.calls.length,0);assert.equal(e.saved.length,0);
});

test('image redirects are individually checked and bounded to three hops',async()=>{
 const e=environment({fetch:()=>new Response(null,{status:302,headers:{location:'https://evil.example/private'}})});await assert.rejects(prepare(e,[image()]),safeError(400));assert.equal(e.calls.length,1);assert.equal(e.saved.length,0);
 let n=0;const loops=environment({fetch:()=>new Response(null,{status:302,headers:{location:'https://gchat.qpic.cn/next-'+(++n)}})});await assert.rejects(prepare(loops,[image()]),safeError(502));assert.equal(loops.calls.length,4);
});

test('expired responses and invalid image bytes do not enter attachments',async()=>{
 for(const response of [new Response('PRIVATE remote error',{status:403}),new Response('<svg>not an accepted raster</svg>')]){
  const e=environment({fetch:()=>response});await assert.rejects(prepare(e,[image()]),safeError(502));assert.equal(e.saved.length,0);
 }
 const corrupt=environment({saveImages:()=>{throw Error('PRIVATE decoder details');}});await assert.rejects(prepare(corrupt,[image()]),safeError(502));
});

test('declared, streamed and aggregate image size limits stop processing before attachment publication',async()=>{
 const declared=environment({fetch:()=>new Response(PNG,{headers:{'content-length':String(5*1024*1024+1)}})});await assert.rejects(prepare(declared,[image()]),safeError(413));assert.equal(declared.saved.length,0);
 const streamed=environment({fetch:()=>new Response(Buffer.alloc(5*1024*1024+1))});await assert.rejects(prepare(streamed,[image()]),safeError(413));assert.equal(streamed.saved.length,0);
 const big=Buffer.alloc(4.5*1024*1024);PNG.copy(big);const aggregate=environment({fetch:()=>new Response(big)});await assert.rejects(prepare(aggregate,[image(),image(),image()]),safeError(413));assert.equal(aggregate.saved.length,0);
});

test('safe get_image fallback accepts canonical bytes and never reads a container path',async()=>{
 const e=environment();let calls=0;const result=await prepare(e,[{type:'image',data:{file:'ABC123.png'}}],{rpc:async(action,args)=>{calls++;assert.equal(action,'get_image');assert.deepEqual(args,{file:'ABC123.png'});return {base64:PNG.toString('base64'),file:'/container/private.png'};}});
 assert.equal(calls,1);assert.equal(e.calls.length,0);assert.deepEqual(result.media[0].bytes,PNG);
 const path=environment();await assert.rejects(prepare(path,[{type:'image',data:{file:'ABC123.png'}}],{rpc:async()=>({file:'/container/private.png',url:'/container/private.png'})}),safeError(502));assert.equal(path.calls.length,0);assert.equal(path.saved.length,0);
});

test('identity admission and cancellation are checked before and after asynchronous media work',async()=>{
 const blocked=environment();await assert.rejects(prepare(blocked,[image()],{admit:()=>false}),safeError(409));assert.equal(blocked.calls.length,0);
 const controller=new AbortController(),reason=Error('cancelled');let start;const started=new Promise(r=>start=r);const pendingFetch=environment({fetch:()=>{start();return new Promise(()=>{});}});
 const pending=prepare(pendingFetch,[image()],{signal:controller.signal});await started;controller.abort(reason);await assert.rejects(pending,error=>error===reason);assert.equal(pendingFetch.saved.length,0);
 let allowed=true;const changed=environment({fetch:()=>{allowed=false;return new Response(PNG);}});await assert.rejects(prepare(changed,[image()],{admit:()=>allowed}),safeError(409));assert.equal(changed.saved.length,0);
});

test('a changed model route and late attachment result cannot publish content',async()=>{
 const changed=environment({fetch:()=>{changed.setSelection({provider:'other',model:'other'});return new Response(PNG);}});await assert.rejects(prepare(changed,[image()]),safeError(409));assert.equal(changed.saved.length,0);
 const controller=new AbortController();let started;const ready=new Promise(r=>started=r);const late=environment({saveImages:()=>{started();return new Promise(()=>{});}});const pending=prepare(late,[image()],{signal:controller.signal});await ready;controller.abort(null);await assert.rejects(pending,error=>error===null);
});

test('the total deadline bounds even a non-cooperative downloader',async()=>{
 const e=environment({fetch:()=>new Promise(()=>{})});await assert.rejects(prepare(e,[image()],{timeoutMs:8}),safeError(504));assert.equal(e.saved.length,0);
});

test('a non-cooperative fetch response arriving after cancellation has its body cancelled',async()=>{
 const controller=new AbortController();let entered,finish,cancelled=0;const ready=new Promise(r=>entered=r);
 const e=environment({fetch:()=>{entered();return new Promise(r=>finish=r);}});
 const pending=prepare(e,[image()],{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending,{name:'AbortError'});
 finish(new Response(new ReadableStream({cancel(){cancelled++;}})));await new Promise(r=>setImmediate(r));
 assert.equal(cancelled,1);assert.equal(e.saved.length,0);
});

test('changed admission cancels an arrived response before reading its body',async()=>{
 let allowed=true,cancelled=0;const e=environment({fetch:()=>{allowed=false;return new Response(new ReadableStream({cancel(){cancelled++;}}));}});
 await assert.rejects(prepare(e,[image()],{admit:()=>allowed,timeoutMs:8}),safeError(409));assert.equal(cancelled,1);assert.equal(e.saved.length,0);
});
