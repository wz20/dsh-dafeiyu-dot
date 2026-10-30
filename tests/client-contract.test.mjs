import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function environment(fetchImpl = async () => ({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true})}), hooks = {}) {
  let definition;
  const events = new Map();
  const window = {
    __ModuleLoader__: {load(value) {definition = value;}},
    addEventListener(type, fn) {if (!events.has(type)) events.set(type,new Set()); events.get(type).add(fn);},
    removeEventListener(type,fn) {events.get(type)?.delete(fn);},
    dispatchEvent(event) {events.get(event.type)?.forEach(fn=>fn(event));},
  };
  const document = {head:{appendChild(){}},createElement:()=>({dataset:{},remove(){}})};
  const React = {createElement:(type,props,...children)=>({type,props:{...props,children}}), ...hooks};
  const context = vm.createContext({window,document,console,fetch:fetchImpl,AbortController,DOMException,setTimeout,clearTimeout,Uint8Array,Float32Array,ArrayBuffer,DataView,URL,crypto:globalThis.crypto,navigator:{mediaDevices:{}},btoa:x=>Buffer.from(x,'binary').toString('base64'),CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}}});
  vm.runInContext(source.replace('    function App(props) {','    window.__test = {request, readSpeechDelivery, startAudioPlayback, encodeWav, Microphone, observeMessages, memoryDate, palaceSummary, indexedMemories, memorySources, audioStops, open, stopAudio, stopWidgetAudio};\n    function App(props) {'),context);
  const plugin = definition.factory(name=>{assert.equal(name,'react');return React;});
  return {window,context,definition,plugin,api:window.__test,events};
}

test('client registers the native session controls and root overlay with owned cleanup',()=>{
  const {plugin,definition,events}=environment();
  assert.equal(definition.id,'dsh-dafeiyu-dot');
  const effects=[],registrations=[];
  plugin.apply({effect(fn){effects.push(fn());},slots:{inject(name,fn){fn();},register(options,component){registrations.push({options,component});return ()=>{};}}});
  assert.deepEqual(registrations.map(x=>x.options.name),['shell.overlay','conversation.session.header.actions','conversation.session.header.utilities','main','sidebar.panellist']);
  assert.equal(registrations[1].options.id,'agent-preset');
  assert.equal(registrations[1].options.priority,-200);
  assert.equal(registrations[3].options.key,'dsh-dafeiyu-dot');
  assert.equal(registrations[3].options.inject().placement,'panel');
  assert.equal(registrations[4].options.id,'dsh-dafeiyu-dot');
  assert.equal(registrations[4].options.label(),'大肥鱼');
  assert.equal(events.get('dafeiyu:open').size,1);
  effects.forEach(fn=>fn());
  assert.equal(events.get('dafeiyu:open').size,0);
});

test('JSON and binary requests stay on the plugin origin and surface service errors',async()=>{
  const calls=[];
  const {api}=environment(async(url,options)=>{calls.push({url,options});return {ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>new Blob(['wav'])};});
  const blob=await api.request('/synthesize',{text:'你好'},{audio:true});
  assert.equal(await blob.text(),'wav');
  assert.equal(calls[0].url,'/dsh-dafeiyu-dot/synthesize');
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(JSON.parse(calls[0].options.body).text,'你好');
  const failed=environment(async()=>({ok:false,headers:{get:()=> 'application/json'},json:async()=>({ok:false,error:'音色不可用'})}));
  await assert.rejects(failed.api.request('/voices'),/音色不可用/);
});

test('caller cancellation aborts a pending request',async()=>{
  let fetchSignal;
  const {api}=environment((_url,options)=>new Promise((_resolve,reject)=>{fetchSignal=options.signal;options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
  const controller=new AbortController();
  const pending=api.request('/speech/prepare',{}, {signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(fetchSignal.aborted,true);
});

test('binary speech exposes delivery status only after receiving the complete audio',async()=>{
  const order=[];
  const {api}=environment(async()=>({ok:true,headers:{get:name=>name==='content-type'?'audio/wav':'natural-fallback'},blob:async()=>{order.push('audio');return new Blob(['wav']);}}));
  const blob=await api.request('/synthesize',{text:'你好呀'},{audio:true,onAudioResponse:response=>order.push(response.headers.get('x-dafeiyu-delivery'))});
  assert.equal(await blob.text(),'wav');assert.deepEqual(order,['audio','natural-fallback']);
});

test('speech delivery accepts only known modes and emotions with bounded timing metadata',()=>{
  const {api}=environment();
  const response=values=>({headers:{get:name=>values[name]??null}});
  const read=values=>api.readSpeechDelivery(response(values));
  const result=read({'x-dafeiyu-delivery':'model','x-dafeiyu-emotion':'soothing','x-dafeiyu-preparation-ms':'3529'});
  assert.equal(result.emotion,'soothing');assert.equal(result.preparationMs,3529);
  assert.equal(read({'x-dafeiyu-delivery':'unexpected','x-dafeiyu-emotion':'joyful'}),null);
  assert.equal(read({'x-dafeiyu-delivery':'model','x-dafeiyu-emotion':'arbitrary-html','x-dafeiyu-preparation-ms':'Infinity'}).emotion,null);
  assert.equal(read({'x-dafeiyu-delivery':'natural-fallback','x-dafeiyu-emotion':'sad','x-dafeiyu-preparation-ms':'-1'}).preparationMs,null);
  assert.equal(read({'x-dafeiyu-delivery':'natural-fallback','x-dafeiyu-emotion':'warm'}).emotion,'warm');
  assert.equal(read({'x-dafeiyu-delivery':'natural-fallback','x-dafeiyu-emotion':'arbitrary-html'}).emotion,null);
  assert.equal(read({'x-dafeiyu-delivery':'unsupported','x-dafeiyu-emotion':'warm'}).emotion,null);
});

test('playback startup times out and a late native play promise is immediately paused',async()=>{
  const {api}=environment();let finish,pauses=0;
  const player={play:()=>new Promise(resolve=>{finish=resolve;}),pause:()=>{pauses++;}};
  await assert.rejects(api.startAudioPlayback(player,{timeoutMs:5}),/声音播放未能启动/);
  assert.equal(pauses,1);finish();await settle();assert.equal(pauses,2);
});

test('cancelling playback startup releases its wait without waiting for the native play promise',async()=>{
  const {api}=environment();const controller=new AbortController();let pauses=0,finish;
  const player={play:()=>new Promise(resolve=>{finish=resolve;}),pause:()=>{pauses++;}};
  const pending=api.startAudioPlayback(player,{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(pauses,1);
  finish();await settle();assert.equal(pauses,2);
});

test('48kHz microphone audio becomes 16kHz mono PCM WAV with bounded samples',()=>{
  const {api}=environment();
  const samples=new Float32Array(48000);for(let i=0;i<samples.length;i++) samples[i]=2*Math.sin(i/20);
  const bytes=api.encodeWav(samples,48000), view=new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes.subarray(0,4)).toString(),'RIFF');
  assert.equal(Buffer.from(bytes.subarray(8,12)).toString(),'WAVE');
  assert.equal(view.getUint16(22,true),1);
  assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint16(34,true),16);
  assert.equal(view.getUint32(40,true),32000);
  assert.equal(bytes.length,32044);
  assert.equal(view.getInt16(44+10*2,true),32767);
});

test('leaving while microphone permission is pending releases late granted tracks',async()=>{
  const {api,context,window}=environment();fakeAudioContext(window);
  let grant,stopped=0;
  context.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;});
  const microphone=new api.Microphone(()=>true,()=>{},()=>{});
  const pending=microphone.start();microphone.dispose();
  grant({getTracks:()=>[{stop(){stopped++;}}]});await assert.rejects(pending,{name:'AbortError'});
  assert.equal(stopped,1);
  assert.equal(microphone.closed,true);
});

test('VAD ignores gated input and emits one Chinese-ASR-ready utterance after silence',()=>{
  const {api}=environment();let allowed=false;const utterances=[];
  const microphone=new api.Microphone(()=>allowed,x=>utterances.push(x),()=>{});
  microphone.context={sampleRate:48000};
  const voice=new Float32Array(4800).fill(.06),silence=new Float32Array(4800);
  for(let i=0;i<5;i++) microphone.process(voice);
  assert.equal(microphone.chunks.length,0);
  allowed=true;
  for(let i=0;i<5;i++) microphone.process(voice);
  for(let i=0;i<9;i++) microphone.process(silence);
  assert.equal(utterances.length,1);
  const wav=Buffer.from(utterances[0],'base64');assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.equal(wav.readUInt32LE(24),16000);
  assert.equal(microphone.chunks.length,0);
});


test('history is consumed silently; only a completed speakable reply is delivered once',()=>{
  const {api}=environment(), seen=new Set();
  const history=[{id:'old',role:'assistant',text:'历史',speakable:true}];
  assert.equal(api.observeMessages(history,seen,true,false).speakable,undefined);
  const streaming=[...history,{id:'new',role:'assistant',text:'正在回复',speakable:false}];
  assert.equal(api.observeMessages(streaming,seen,false,true).speakable,null);
  const completed=[...history,{id:'new',role:'assistant',text:'完成回复',speakable:true}];
  assert.equal(api.observeMessages(completed,seen,false,false).speakable.text,'完成回复');
  assert.equal(api.observeMessages(completed,seen,false,false).fresh.length,0);
  const interrupted=[...completed,{id:'aborted',role:'assistant',text:'中断内容',speakable:false}];
  assert.equal(api.observeMessages(interrupted,seen,false,false).speakable,undefined);
});

test('an idle projection keeps a pending final reply eligible until its completion arrives',()=>{
  const {api}=environment(), seen=new Set();
  const history=[{id:'old',role:'assistant',text:'历史回复',speakable:true}];
  assert.equal(api.observeMessages(history,seen,true,false).speakable,undefined);
  const pending=[...history,{id:'final',role:'assistant',text:'主人，本鱼在呢。',speakable:false}];
  assert.equal(api.observeMessages(pending,seen,false,false).speakable,undefined);
  const completed=pending.map(message=>message.id==='final'?{...message,speakable:true}:message);
  assert.equal(api.observeMessages(completed,seen,false,false).speakable?.text,'主人，本鱼在呢。');
  assert.equal(api.observeMessages(completed,seen,false,false).speakable,undefined);
});


function hookRunner() {
  const cells=[];let cursor=0,pending=[];
  const changed=(a,b)=>!a || !b || a.length!==b.length || a.some((x,i)=>!Object.is(x,b[i]));
  const hooks={
    useState(initial){const id=cursor++;if(!cells[id])cells[id]={value:typeof initial==='function'?initial():initial};return [cells[id].value,value=>{cells[id].value=typeof value==='function'?value(cells[id].value):value;}];},
    useRef(initial){const id=cursor++;if(!cells[id])cells[id]={current:initial};return cells[id];},
    useEffect(fn,deps){const id=cursor++;if(!cells[id] || changed(cells[id].deps,deps)){pending.push(()=>{cells[id]?.cleanup?.();cells[id]={deps,cleanup:fn()};});}},
    useCallback(fn,deps){const id=cursor++;if(!cells[id] || changed(cells[id].deps,deps))cells[id]={value:fn,deps};return cells[id].value;}
  };
  return {hooks,render(component,props){cursor=0;pending=[];const result=component(props);pending.forEach(fn=>fn());return result;},dispose(){cells.forEach(x=>x?.cleanup?.());}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('native header reads only future completed whale replies and disposes session observation',async()=>{
  const runner=hookRunner(), state={running:false,preset:'whale'}, config={tts:{autoRead:true,volume:.7}};
  let messages=[{id:'history',role:'assistant',text:'历史回复',speakable:true}],reads=[],stops=0;
  const env=environment(async url=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>url.includes('/state')?{ok:true,session:{preset:state.preset},config}:{ok:true,messages,running:state.running}}),runner.hooks);
  let Header;const effects=[];
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='conversation.session.header.actions')Header=component;return ()=>{};}}});
  env.window.addEventListener('dafeiyu:read',e=>reads.push(e.detail));
  env.api.stopAudio=()=>{stops++;};
  const props={sessionId:'session-a',useSessions:select=>select({byId:{'session-a':{projectionValues:{agentPreset:state.preset}}}}),useSession:select=>select({running:state.running})};
  runner.render(Header,props);await settle();assert.equal(reads.length,0);
  state.running=true;messages=[...messages,{id:'new',role:'assistant',text:'准备回复',speakable:false}];runner.render(Header,props);await settle();assert.equal(reads.length,0);
  state.running=false;messages=messages.map(x=>x.id==='new'?{...x,text:'主人，我在。',speakable:true}:x);runner.render(Header,props);await settle();
  assert.equal(reads.length,1);assert.equal(reads[0].sessionId,'session-a');assert.equal(reads[0].text,'主人，我在。');
  env.api.open('immersive','session-a');state.running=true;runner.render(Header,props);await settle();
  state.running=false;messages=[...messages,{id:'immersive',role:'assistant',text:'页面回复',speakable:true}];runner.render(Header,props);await settle();assert.equal(reads.length,1);
  env.api.open('call','session-a');state.running=true;runner.render(Header,props);await settle();
  state.running=false;messages=[...messages,{id:'call',role:'assistant',text:'通话页面负责朗读这一句',speakable:true}];runner.render(Header,props);await settle();
  assert.equal(reads.length,1,'the native header must not duplicate speech owned by the simple call page');
  state.preset='standard';runner.render(Header,props);await settle();assert.equal(reads.length,1);
  runner.dispose();effects.forEach(fn=>fn());
  assert.equal(env.events.get('dafeiyu:config').size,0);
});


test('memory palace status distinguishes unavailable state, queued work and failures',()=>{
  const {api}=environment();
  assert.equal(api.palaceSummary(null).tone,'unknown');
  assert.equal(api.palaceSummary({pendingJobs:0}).tone,'unknown');
  assert.equal(api.palaceSummary({pendingJobs:0,failedJobs:0}).text,'当前没有待整理任务');
  assert.equal(api.palaceSummary({pendingJobs:2,failedJobs:1}).text,'待整理 2 项，另有 1 项等待重试');
  assert.equal(api.palaceSummary({pendingJobs:0,failedJobs:2}).tone,'failed');
});

test('people, topic and date index filters use returned record ids within the selected space',()=>{
  const {api}=environment();
  const records=[{id:'a',spaceId:'self'},{id:'b',spaceId:'owner'},{id:'c',spaceId:'self'}];
  const index={people:[{name:'主人',ids:['a','b']}],topics:[{name:'工作',ids:['c']}],dates:[{date:'2026-10-28',ids:['a','c']}]};
  assert.deepEqual(Array.from(api.indexedMemories(records,'self',{kind:'people',value:'主人'},index),x=>x.id),['a']);
  assert.deepEqual(Array.from(api.indexedMemories(records,'self',{kind:'topics',value:'工作'},index),x=>x.id),['c']);
  assert.deepEqual(Array.from(api.indexedMemories(records,'self',{kind:'dates',value:'2026-10-28'},index),x=>x.id),['a','c']);
  assert.equal(api.indexedMemories(records,'self',{kind:'people',value:'已删除索引'},index).length,0);
  const source={kind:'conversation',sessionId:'session-a',evidence:'原始证据'};
  assert.equal(api.memorySources({source,sources:[{...source}]}).length,1);
});

function renderedNodes(node, output=[]) {
  if(Array.isArray(node)){node.forEach(child=>renderedNodes(child,output));return output;}
  if(!node || typeof node!=='object')return output;
  if(typeof node.type==='function')return renderedNodes(node.type(node.props),output);
  output.push(node);renderedNodes(node.props?.children,output);return output;
}
function nodeText(node) {if(Array.isArray(node))return node.map(nodeText).join('');if(node && typeof node==='object')return nodeText(node.props?.children);return node==null?'':String(node);}

test('memory page fetches complete content for editing and requires explicit chain-forget confirmation',async()=>{
  const runner=hookRunner(),calls=[],fullContent='完整记忆正文。'.repeat(350);
  const config={role:{name:'大肥鱼',address:'主人',prompt:'完整角色设定'},tts:{source:'local',localUrl:'',localVoice:'大肥鱼',autoRead:false,volume:.8},memory:{enabled:true},widget:{enabled:true,soundEnabled:true,volume:.7,regions:{head:{},face:{},tail:{}}}};
  let rows=[{id:'memory-a',spaceId:'self',content:'搜索返回的片段',truncated:true,contentLength:fullContent.length,subject:'主人',updatedAt:'2026-10-28T12:00:00Z',source:{kind:'conversation',sessionId:'source-session',evidence:'你说过的原话'},supersedes:'older-memory'}];
  const env=environment(async(url,options)=>{
    calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
    let data={ok:true};
    if(url.includes('/state'))data={...data,config,session:{id:'session-a',preset:'whale'},sessions:[{id:'session-a',title:'陪伴',preset:'whale'}]};
    else if(url.includes('/memories?')||url.endsWith('/memory/graph'))data={...data,memories:rows,spaces:[{id:'self',name:'鲸鱼娘自己的'},{id:'owner',name:'我眼里的主人'}],palace:{palaceRoot:'/workspace/记忆宫殿',memoryCount:rows.length,pendingJobs:0,failedJobs:1},index:{builtAt:'2026-10-28T12:00:00Z',people:[{name:'主人',count:1,ids:['memory-a']}],topics:[],dates:[]}};
    else if(url.includes('/memory?id='))data={...data,memory:{...rows[0],content:fullContent}};
    else if(url.endsWith('/memories') && options.method==='DELETE')rows=[];
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>data};
  },runner.hooks);
  let App;const effects=[];env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;return ()=>{};}}});
  runner.render(App,{});env.api.open('settings','session-a');runner.render(App,{});await settle();
  let tree=runner.render(App,{});let nodes=renderedNodes(tree);
  nodes.find(node=>node.type==='button' && nodeText(node)==='记忆').props.onClick();runner.render(App,{});await settle();
  tree=runner.render(App,{});nodes=renderedNodes(tree);
  assert.equal(nodes.find(node=>node.type==='input' && node.props['aria-label']==='记忆宫殿实际路径').props.value,'/workspace/记忆宫殿');
  assert.ok(nodeText(tree).includes('1 项整理任务等待重试'));
  assert.ok(nodeText(tree).includes('source-session'));
  let copied='';env.context.navigator.clipboard={writeText:async value=>{copied=value;}};
  await nodes.find(node=>node.type==='button' && nodeText(node)==='复制路径').props.onClick();assert.equal(copied,'/workspace/记忆宫殿');
  nodes.find(node=>node.type==='button' && nodeText(node)==='阅读全文').props.onClick();await settle();tree=runner.render(App,{});nodes=renderedNodes(tree);assert.ok(nodeText(tree).includes(fullContent));
  nodes.find(node=>node.type==='button' && nodeText(node)==='编辑').props.onClick();await settle();
  tree=runner.render(App,{});nodes=renderedNodes(tree);
  assert.equal(calls.filter(call=>call.url.includes('/memory?id=memory-a')).length,2);
  assert.equal(nodes.find(node=>node.type==='textarea' && node.props['aria-label']==='记忆内容').props.value,fullContent);
  nodes.find(node=>node.type==='button' && nodeText(node)==='保存记忆').props.onClick();await settle();runner.render(App,{});
  assert.equal(calls.find(call=>call.url.endsWith('/memories') && call.method==='POST').body.content,fullContent);
  nodes=renderedNodes(runner.render(App,{}));nodes.find(node=>node.type==='button' && node.props['aria-label']==='忘记这条记忆').props.onClick();
  assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
  tree=runner.render(App,{});nodes=renderedNodes(tree);assert.ok(nodeText(tree).includes('忘记这条记忆及其旧版本？'));
  nodes.find(node=>node.type==='button' && nodeText(node)==='确认忘记').props.onClick();await settle();runner.render(App,{});
  assert.equal(calls.filter(call=>call.method==='DELETE').length,1);
  nodes=renderedNodes(runner.render(App,{}));nodes.find(node=>node.type==='button' && nodeText(node)==='重建索引').props.onClick();await settle();runner.render(App,{});
  assert.ok(calls.some(call=>call.url.endsWith('/memory/reindex') && call.method==='POST'));
  nodes=renderedNodes(runner.render(App,{}));nodes.find(node=>node.type==='button' && nodeText(node)==='重试整理').props.onClick();await settle();runner.render(App,{});
  assert.ok(calls.some(call=>call.url.endsWith('/memory/retry') && call.method==='POST'));
  runner.dispose();effects.forEach(fn=>fn());
});

function draftStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {get length(){return data.size;},key(index){return [...data.keys()][index] ?? null;},getItem(key){return data.has(key)?data.get(key):null;},setItem(key,value){data.set(key,String(value));},removeItem(key){data.delete(key);},values:data};
}
async function mountDraftComposer(storage, {failSend = false} = {}) {
  const runner=hookRunner(), acknowledgements=[];
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',autoRead:false,volume:.8},memory:{enabled:true},widget:{enabled:true,regions:{}}};
  const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  const env=environment(async(url,options)=>{
    if(url.includes('/state'))return response({config,session:{id:new URL('http://localhost'+url).searchParams.get('sessionId'),preset:'whale'},sessions:[{id:'session-a',title:'A',preset:'whale'},{id:'session-b',title:'B',preset:'whale'}]});
    if(url.includes('/messages'))return response({messages:[],running:false});
    if(url.endsWith('/send')) {
      if(failSend==='unaccepted')return response({accepted:false});
      if(failSend)return {ok:false,headers:{get:()=> 'application/json'},json:async()=>({ok:false,error:'暂时无法发送'})};
      return await new Promise(resolve=>acknowledgements.push(()=>resolve(response({accepted:true}))));
    }
    return response({voices:[]});
  },runner.hooks);
  env.window.localStorage=storage;
  let App;const effects=[];env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;return ()=>{};}}});
  const render=()=>runner.render(App,{});
  render();env.api.open('immersive','session-a');render();await settle();render();await settle();
  return {env,render,acknowledgements,composer(){return renderedNodes(render()).find(node=>node.type==='textarea' && node.props['aria-label']==='给鲸鱼娘发消息');},submit(){renderedNodes(render()).find(node=>node.type==='form' && node.props.className==='dfj-composer').props.onSubmit({preventDefault(){}});},dispose(){runner.dispose();effects.forEach(fn=>fn());}};
}

test('immersive atmosphere can be paused and retains that choice after reopening',async()=>{
  const storage=draftStorage(),key='dsh-dafeiyu-dot:ambient-motion:v1';
  let page=await mountDraftComposer(storage);
  try {
    let nodes=renderedNodes(page.render()),room=nodes.find(node=>node.props.className?.split(/\s+/).includes('dfj-immersive'));
    assert.equal(room.props['data-motion'],'active');
    const pause=nodes.find(node=>node.type==='button' && node.props['aria-label']==='暂停动态效果');
    assert.ok(pause,'ambient animation must expose a visible pause control');pause.props.onClick();
    nodes=renderedNodes(page.render());room=nodes.find(node=>node.props.className?.split(/\s+/).includes('dfj-immersive'));
    assert.equal(room.props['data-motion'],'paused');assert.equal(storage.getItem(key),'paused');
    assert.ok(nodes.some(node=>node.type==='button' && node.props['aria-label']==='开启动效'));
    assert.equal(page.acknowledgements.length,0);
  } finally {page.dispose();}
  page=await mountDraftComposer(storage);
  try {
    let nodes=renderedNodes(page.render());assert.equal(nodes.find(node=>node.props.className?.split(/\s+/).includes('dfj-immersive')).props['data-motion'],'paused');
    nodes.find(node=>node.type==='button' && node.props['aria-label']==='开启动效').props.onClick();
    nodes=renderedNodes(page.render());assert.equal(nodes.find(node=>node.props.className?.split(/\s+/).includes('dfj-immersive')).props['data-motion'],'active');
    assert.equal(storage.getItem(key),'active');
  } finally {page.dispose();}
});

async function mountOceanRoom() {
  const runner=hookRunner(),clock=controlledClock(),calls=[],players=[],copied=[];
  const longReply='我在这里陪你呀。这一段要完整留下，读到后面也能回到刚才的位置。'.repeat(90)+'这是完整回复的最后一句。';
  const longUser='这是主人正在认真说的一件事，整句话也应该能读到。'.repeat(30);
  const storage=draftStorage({'dsh-dafeiyu-dot:text-draft:v1:session-a':'阅读时保留的草稿'});
  const state={running:false,preset:'whale',messages:[{id:'user-long',role:'user',text:longUser,speakable:false},{id:'reply-long',role:'assistant',text:longReply,terminal:true,speakable:true}]};
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',localModel:'audiocpp',localUrl:'http://127.0.0.1:3900/v1',localVoice:'fish',autoRead:false,volume:.8,emotional:true,expressiveness:'natural'},memory:{enabled:true},widget:{enabled:true,regions:{}}};
  const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  const env=environment(async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null});
    if(url.includes('/state'))return response({config,session:{id:'session-a',title:'深海会话',preset:state.preset},sessions:[{id:'session-a',title:'深海会话',preset:state.preset}]});
    if(url.includes('/messages'))return response({messages:state.messages,running:state.running});
    if(url.includes('/models?'))return response({selected:{provider:'p',model:'one'},groups:[{id:'p',name:'服务',models:[{id:'one',name:'模型一'}]}],failures:[]});
    if(url.endsWith('/config')){Object.assign(config,JSON.parse(options.body));return response({config});}
    if(url.endsWith('/synthesize'))return {ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>new Blob(['wav'])};
    if(url.endsWith('/speech/prepare')||url.endsWith('/health'))return response({asr:{available:true,phase:'ready'}});
    return response({voices:[]});
  },runner.hooks);
  env.context.setTimeout=clock.setTimeout;env.context.clearTimeout=clock.clearTimeout;env.window.localStorage=storage;
  fakeAudioContext(env.window);let stopped=0;
  env.context.navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){stopped++;}}]});
  env.context.navigator.clipboard={writeText:async value=>{copied.push(value);}};
  env.context.Audio=class {constructor(url){this.url=url;players.push(this);}play(){return Promise.resolve();}pause(){this.paused=true;}};
  let App;const effects=[];
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;return ()=>{};}}});
  const render=()=>runner.render(App,{}),nodes=()=>renderedNodes(render());
  const button=label=>nodes().find(node=>node.type==='button' && (node.props['aria-label']===label||nodeText(node)===label));
  async function flush(){render();await settle();render();await settle();return render();}
  render();env.api.open('immersive','session-a');await flush();await flush();
  return {env,state,calls,clock,players,copied,longReply,longUser,storage,render,nodes,button,flush,stopped:()=>stopped,composer:()=>nodes().find(node=>node.type==='textarea' && node.props['aria-label']==='给鲸鱼娘发消息'),room:()=>nodes().find(node=>node.props.className?.split(/\s+/).includes('dfj-immersive')),dispose(){runner.dispose();effects.forEach(fn=>fn());}};
}

test('expanded reading keeps full conversation content, draft and an active call',async()=>{
  const page=await mountOceanRoom();
  try {
    const reading=page.nodes().find(node=>node.props['aria-label']==='当前对话');
    assert.ok(reading,'the current conversation must expose a keyboard-readable scroll region');
    assert.equal(reading.props.tabIndex,0);
    assert.ok(nodeText(reading).includes(page.longReply));assert.ok(nodeText(reading).includes(page.longUser));
    assert.equal(page.composer().props.rows,2);
    const start=page.button('开始语音').props.onClick();page.render();await start;await page.flush();
    assert.ok(page.button('结束语音'));assert.equal(page.stopped(),0);
    assert.equal(page.room().props['data-reading'],'normal');
    page.button('展开阅读').props.onClick();await page.flush();
    assert.equal(page.room().props['data-reading'],'expanded');
    assert.equal(page.composer().props.value,'阅读时保留的草稿');assert.equal(page.stopped(),0);assert.ok(page.button('结束语音'));
    page.button('暂停动态效果').props.onClick();page.render();
    assert.equal(page.room().props['data-motion'],'paused');assert.ok(page.button('结束语音'));
    page.button('恢复沉浸布局').props.onClick();await page.flush();
    assert.equal(page.room().props['data-reading'],'normal');assert.ok(page.button('结束语音'));
    assert.equal(page.storage.getItem('dsh-dafeiyu-dot:text-draft:v1:session-a'),'阅读时保留的草稿');
    assert.equal(page.calls.filter(call=>call.url.endsWith('/send')).length,0);
  } finally {page.dispose();}
});

test('reading actions copy full replies and manually replay only completed whale replies',async()=>{
  const page=await mountOceanRoom();
  try {
    const copy=page.button('复制回复'),replay=page.button('重播回复');
    assert.ok(copy,'a long reply must have a copy action');assert.ok(replay,'a completed reply must have a replay action');
    assert.equal(replay.props.disabled,false);
    await copy.props.onClick();await page.flush();assert.deepEqual(page.copied,[page.longReply]);
    const pending=replay.props.onClick();page.render();await pending;await page.flush();
    const synthesis=page.calls.filter(call=>call.url.endsWith('/synthesize'));
    assert.equal(synthesis.length,1);assert.equal(synthesis[0].body.text,page.longReply);assert.equal(synthesis[0].body.sessionId,'session-a');
    assert.equal(page.players.length,1);assert.ok(page.button('停止声音'));
    page.button('停止声音').props.onClick();await page.flush();assert.equal(page.players[0].paused,true);
    page.state.running=true;await page.clock.tick(2300);await page.flush();assert.equal(page.button('重播回复').props.disabled,true);
    page.state.running=false;page.state.messages=[{id:'pending',role:'assistant',text:'还没说完',terminal:false,speakable:false}];
    await page.clock.tick(2300);await page.flush();assert.equal(page.button('重播回复').props.disabled,true);
    page.state.messages=[{id:'complete',role:'assistant',text:'说完啦。',terminal:true,speakable:true}];
    await page.clock.tick(2300);await page.flush();assert.equal(page.button('重播回复').props.disabled,false);
    page.env.window.dispatchEvent({type:'dafeiyu:mode',detail:{sessionId:'session-a',preset:'standard'}});await page.flush();
    assert.equal(page.button('重播回复').props.disabled,true);
    assert.equal(page.composer().props.value,'阅读时保留的草稿');
  } finally {page.dispose();}
});

test('a generated utterance shows its real tone and a later reply cannot inherit that tone',async()=>{
  const page=await mountOceanRoom();
  try {
    const original=page.env.context.fetch;
    page.env.context.fetch=async(url,options)=>url.endsWith('/synthesize')?{ok:true,headers:{get:name=>({'content-type':'audio/wav','x-dafeiyu-delivery':'model','x-dafeiyu-emotion':'soothing','x-dafeiyu-preparation-ms':'3529'}[name]??null)},blob:async()=>new Blob(['wav'])}:original(url,options);
    await page.button('重播回复').props.onClick();await page.flush();
    assert.equal(page.room().props['data-emotion'],'soothing');assert.equal(page.room().props['data-voice-state'],'speaking');
    assert.ok(nodeText(page.render()).includes('温柔安抚'));
    page.players[0].onended();await page.flush();
    assert.equal(page.room().props['data-emotion'],'soothing');assert.equal(page.room().props['data-voice-state'],'idle');
    page.state.messages=[{id:'another',role:'assistant',text:page.longReply,terminal:true,speakable:true}];
    await page.clock.tick(2300);await page.flush();
    assert.equal(page.room().props['data-emotion'],'none');
  } finally {page.dispose();}
});

test('stopping voice preparation rejects a late tone and never starts its audio',async()=>{
  const page=await mountOceanRoom();let finish;
  try {
    const original=page.env.context.fetch;
    page.env.context.fetch=(url,options)=>url.endsWith('/synthesize')?new Promise(resolve=>{finish=resolve;}):original(url,options);
    const pending=page.button('重播回复').props.onClick();await page.flush();
    assert.equal(page.room().props['data-voice-state'],'preparing');assert.ok(nodeText(page.render()).includes('正在准备这一句声音'));
    page.button('停止声音').props.onClick();await page.flush();
    finish({ok:true,headers:{get:name=>({'content-type':'audio/wav','x-dafeiyu-delivery':'model','x-dafeiyu-emotion':'joyful'}[name]??null)},blob:async()=>new Blob(['wav'])});
    await pending;await page.flush();
    assert.equal(page.room().props['data-emotion'],'none');assert.equal(page.room().props['data-voice-state'],'idle');assert.equal(page.players.length,0);
  } finally {page.dispose();}
});

test('playback rejection explains sound permission and stale audio errors stay silent after stopping',async()=>{
  const page=await mountOceanRoom();
  try {
    const AudioBefore=page.env.context.Audio;
    page.env.context.Audio=class {pause(){} play(){return Promise.reject(new DOMException('denied','NotAllowedError'));}};
    await page.button('重播回复').props.onClick();await page.flush();
    assert.ok(nodeText(page.render()).includes('声音播放暂未获得允许'));
    assert.ok(!nodeText(page.render()).includes('麦克风访问已被拒绝'));
    page.button('关闭提示').props.onClick();await page.flush();page.env.context.Audio=AudioBefore;
    await page.button('重播回复').props.onClick();await page.flush();
    const oldError=page.players.at(-1).onerror;
    page.button('停止声音').props.onClick();await page.flush();oldError();await page.flush();
    assert.ok(!nodeText(page.render()).includes('语音播放失败'));
  } finally {page.dispose();}
});

test('tone selection stays silent and explicit previews use the same text with distinct controlled emotions',async()=>{
  const page=await mountOceanRoom();const previews=[];
  try {
    const original=page.env.context.fetch;
    page.env.context.fetch=async(url,options)=>{
      if(!url.endsWith('/synthesize'))return original(url,options);
      const body=JSON.parse(options.body);previews.push(body);
      return {ok:true,headers:{get:name=>({'content-type':'audio/wav','x-dafeiyu-delivery':'preview','x-dafeiyu-emotion':body.previewEmotion}[name]??null)},blob:async()=>new Blob(['wav'])};
    };
    page.button('声音与情绪').props.onClick();await page.flush();
    page.button('轻快开心').props.onClick();await page.flush();assert.equal(previews.length,0);
    await page.button('试听这份心情').props.onClick();await page.flush();
    assert.equal(previews[0].preview,true);assert.equal(previews[0].previewEmotion,'joyful');assert.equal(previews[0].sessionId,undefined);
    page.players[0].onended();await page.flush();
    page.button('温柔安抚').props.onClick();await page.flush();
    await page.button('试听这份心情').props.onClick();await page.flush();
    assert.equal(previews[1].previewEmotion,'soothing');assert.equal(previews[1].text,previews[0].text);
  } finally {page.dispose();}
});

async function mountModelComposer() {
  const runner=hookRunner(),clock=controlledClock(),changes=[],sends=[],messageHolds=[];
  const storage=draftStorage({'dsh-dafeiyu-dot:text-draft:v1:session-a':'保留我的草稿','dsh-dafeiyu-dot:text-draft:v1:session-b':'另一个会话的草稿'});
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',autoRead:false,volume:.8},memory:{enabled:true},widget:{enabled:true,regions:{}}};
  const selected={
    'session-a':{provider:'p',model:'one',reasoningEffort:'high'},
    'session-b':{provider:'p',model:'two',reasoningEffort:'low'},
  };
  const groups=[{id:'p',name:'服务P',models:[{id:'one',name:'模型一',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}},{id:'two',name:'模型二',reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}}]}];
  const response=(data,ok=true)=>({ok,headers:{get:()=> 'application/json'},json:async()=>({ok,...data})});
  const env=environment(async(url,options)=>{
    const sid=new URL('http://localhost'+url).searchParams.get('sessionId');
    if(url.includes('/state'))return response({config,session:{id:sid,preset:'whale'},sessions:[{id:'session-a',title:'A',preset:'whale'},{id:'session-b',title:'B',preset:'whale'}]});
    if(url.includes('/messages')){
      const data={messages:[],running:false,modelSelection:{...selected[sid]}},hold=messageHolds.shift();
      if(hold){hold.requested=true;return await new Promise(resolve=>{hold.release=patch=>resolve(response({...data,...patch}));});}
      return response(data);
    }
    if(url.includes('/models?'))return response({selected:{...selected[sid]},groups,failures:[]});
    if(url.endsWith('/model')){
      const body=JSON.parse(options.body);
      return await new Promise(resolve=>changes.push({body,success(value={provider:body.provider,model:body.model,...(body.reasoningEffort?{reasoningEffort:body.reasoningEffort}:{})}){selected[body.sessionId]={...value};resolve(response({sessionId:body.sessionId,selected:value}));},fail(){resolve(response({error:'模型切换暂时失败'},false));}}));
    }
    if(url.endsWith('/send')){sends.push(JSON.parse(options.body));return response({accepted:true});}
    return response({voices:[]});
  },runner.hooks);
  env.context.setTimeout=clock.setTimeout;env.context.clearTimeout=clock.clearTimeout;env.window.localStorage=storage;
  let App;const effects=[];env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;return ()=>{};}}});
  const render=()=>runner.render(App,{}),nodes=()=>renderedNodes(render());
  async function flush(){render();await settle();render();await settle();return render();}
  render();env.api.open('immersive','session-a');await flush();await flush();
  return {env,changes,sends,storage,clock,render,nodes,flush,holdNextMessages(){const hold={requested:false};messageHolds.push(hold);return hold;},selector(){return nodes().find(node=>node.type==='select' && node.props['aria-label']==='对话模型');},effort(){return nodes().find(node=>node.type==='select' && node.props['aria-label']==='思考强度');},composer(){return nodes().find(node=>node.type==='textarea' && node.props['aria-label']==='给鲸鱼娘发消息');},sendButton(){return nodes().find(node=>node.type==='button' && node.props['aria-label']==='发送消息');},submit(){nodes().find(node=>node.type==='form' && node.props.className==='dfj-composer').props.onSubmit({preventDefault(){}});},dispose(){runner.dispose();effects.forEach(fn=>fn());}};
}

test('immersive model changes preserve drafts and gate duplicate sends until committed',async()=>{
  const page=await mountModelComposer();
  try {
    assert.ok(page.selector(),'the immersive composer must expose a session model selector');
    assert.equal(page.selector().props.value,JSON.stringify(['p','one']));
    assert.equal(page.effort().props.value,'high');
    assert.ok(page.nodes().some(node=>node.type==='option' && node.props.value===''));
    assert.equal(page.composer().props.value,'保留我的草稿');
    page.selector().props.onChange({target:{value:JSON.stringify(['p','two'])}});
    page.submit();page.submit();await page.flush();
    assert.equal(page.changes.length,1);assert.equal(page.sends.length,0,'model switching must gate imperative duplicate submits');
    assert.equal(page.selector().props.disabled,true);assert.equal(page.sendButton().props.disabled,true);
    assert.equal(page.composer().props.value,'保留我的草稿');
    assert.equal(page.changes[0].body.sessionId,'session-a');assert.equal(page.changes[0].body.provider,'p');assert.equal(page.changes[0].body.model,'two');
    page.changes[0].success({provider:'p',model:'two',reasoningEffort:'low'});await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']));assert.equal(page.selector().props.disabled,false);
    assert.equal(page.effort().props.value,'low');assert.equal(page.sendButton().props.disabled,false);
    assert.equal(page.composer().props.value,'保留我的草稿');
    page.effort().props.onChange({target:{value:''}});await page.flush();
    assert.equal(page.changes.length,2);assert.equal('reasoningEffort' in page.changes[1].body,false,'automatic reasoning omits an explicit effort');
    page.changes[1].success({provider:'p',model:'two'});await page.flush();
    assert.equal(page.effort().props.value,'');assert.equal(page.composer().props.value,'保留我的草稿');
  } finally {page.dispose();}
});

test('a failed immersive model change retains the selected model and editable draft for retry',async()=>{
  const page=await mountModelComposer();
  try {
    assert.ok(page.selector(),'the immersive composer must expose a session model selector');
    page.selector().props.onChange({target:{value:JSON.stringify(['p','two'])}});await page.flush();
    page.composer().props.onChange({target:{value:'切换期间继续写的草稿'}});page.changes[0].fail();await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','one']));assert.equal(page.effort().props.value,'high');
    assert.equal(page.selector().props.disabled,false);assert.equal(page.sendButton().props.disabled,false);
    assert.equal(page.composer().props.value,'切换期间继续写的草稿');
    assert.equal(page.storage.getItem('dsh-dafeiyu-dot:text-draft:v1:session-a'),'切换期间继续写的草稿');
    assert.ok(nodeText(page.render()).includes('模型切换暂时失败'));
    page.selector().props.onChange({target:{value:JSON.stringify(['p','two'])}});await page.flush();
    assert.equal(page.changes.length,2);page.changes[1].success({provider:'p',model:'two',reasoningEffort:'low'});await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']));assert.equal(page.composer().props.value,'切换期间继续写的草稿');
    assert.equal(page.sends.length,0);
  } finally {page.dispose();}
});

test('late model changes from another session cannot replace the active session selection or draft',async()=>{
  const page=await mountModelComposer();
  try {
    assert.ok(page.selector(),'the immersive composer must expose a session model selector');
    page.selector().props.onChange({target:{value:JSON.stringify(['p','two'])}});await page.flush();
    assert.equal(page.changes.length,1);
    page.env.api.open('immersive','session-b');await page.flush();await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']));assert.equal(page.effort().props.value,'low');
    assert.equal(page.composer().props.value,'另一个会话的草稿');
    page.changes[0].success({provider:'p',model:'one',reasoningEffort:'high'});await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']));assert.equal(page.effort().props.value,'low');
    assert.equal(page.selector().props.disabled,false);assert.equal(page.sendButton().props.disabled,false);
    assert.equal(page.composer().props.value,'另一个会话的草稿');
    assert.equal(page.storage.getItem('dsh-dafeiyu-dot:text-draft:v1:session-a'),'保留我的草稿');
    assert.equal(page.sends.length,0);
  } finally {page.dispose();}
});

test('a poll started during model switching preserves the committed selection while updating messages',async()=>{
  const page=await mountModelComposer();let delayed;
  try {
    page.selector().props.onChange({target:{value:JSON.stringify(['p','two'])}});await page.flush();
    assert.equal(page.changes.length,1);assert.equal(page.selector().props.disabled,true);
    delayed=page.holdNextMessages();await page.clock.tick(2200);
    assert.equal(delayed.requested,true,'the delayed poll must start while the model mutation is pending');
    page.changes[0].success({provider:'p',model:'two',reasoningEffort:'low'});await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']));assert.equal(page.selector().props.disabled,false);
    delayed.release({messages:[{id:'late-user',role:'user',text:'轮询仍应更新消息'}]});await page.flush();
    assert.equal(page.selector().props.value,JSON.stringify(['p','two']),'a stale poll from the mutation window must not revert the committed model');
    assert.equal(page.effort().props.value,'low');assert.ok(nodeText(page.render()).includes('轮询仍应更新消息'),'message updates from that response remain valid');
    assert.equal(page.composer().props.value,'保留我的草稿');
  } finally {if(delayed?.requested)delayed.release({});page.dispose();}
});

test('session drafts survive reload, remain isolated, and clear only an unchanged successfully sent draft',async()=>{
  const prefix='dsh-dafeiyu-dot:text-draft:v1:',keyA=prefix+'session-a',keyB=prefix+'session-b';
  const storage=draftStorage({[keyA]:'你是谁',[keyB]:'另一个会话的草稿','another-plugin:value':'保留其他插件的数据'});
  let page=await mountDraftComposer(storage);
  assert.equal(page.composer().props.value,'你是谁');
  page.composer().props.onChange({target:{value:'等待发送的草稿'}});
  assert.equal(storage.getItem(keyA),'等待发送的草稿');
  page.env.api.open('immersive','session-b');page.render();await settle();
  assert.equal(page.composer().props.value,'另一个会话的草稿');
  page.env.api.open('immersive','session-a');page.render();await settle();page.render();await settle();
  assert.equal(page.composer().props.value,'等待发送的草稿');
  page.submit();assert.equal(page.acknowledgements.length,1);
  page.composer().props.onChange({target:{value:'发送等待期间继续写的新草稿'}});
  page.acknowledgements.shift()();await settle();
  assert.equal(page.composer().props.value,'发送等待期间继续写的新草稿');
  assert.equal(storage.getItem(keyA),'发送等待期间继续写的新草稿');
  page.dispose();
  page=await mountDraftComposer(storage);
  assert.equal(page.composer().props.value,'发送等待期间继续写的新草稿');
  page.submit();assert.equal(page.acknowledgements.length,1);page.acknowledgements.shift()();await settle();
  assert.equal(page.composer().props.value,'');assert.equal(storage.getItem(keyA),null);
  assert.equal(storage.getItem(keyB),'另一个会话的草稿');assert.equal(storage.getItem('another-plugin:value'),'保留其他插件的数据');
  page.dispose();
  storage.setItem(keyA,'发送失败要保留');page=await mountDraftComposer(storage,{failSend:true});page.submit();await settle();
  assert.equal(page.composer().props.value,'发送失败要保留');assert.equal(storage.getItem(keyA),'发送失败要保留');page.dispose();
  page=await mountDraftComposer(storage,{failSend:'unaccepted'});page.submit();await settle();assert.equal(storage.getItem(keyA),'发送失败要保留');assert.equal(page.composer().props.value,'发送失败要保留');page.dispose();
});


test('native running transitions preserve the shared pending reply and audio owner',async()=>{
  const runner=hookRunner(),state={running:false,preset:'whale'},env=environment(async url=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>url.includes('/state')?{ok:true,session:{preset:'whale'},config:{tts:{autoRead:false}}}:{ok:true,messages:[],running:state.running}}),runner.hooks);
  let Header;let stopped=0;env.api.audioStops.add(()=>stopped++);const effects=[];
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='conversation.session.header.actions')Header=component;return ()=>{};}}});
  const props={sessionId:'session-a',useSessions:select=>select({byId:{'session-a':{projectionValues:{agentPreset:'whale'}}}}),useSession:select=>select({running:state.running})};
  runner.render(Header,props);await settle();state.running=true;runner.render(Header,props);await settle();state.running=false;runner.render(Header,props);await settle();
  assert.equal(stopped,0,'running changes only replace observation requests; they must not stop the page owner');
  runner.dispose();assert.equal(stopped,1);effects.forEach(fn=>fn());
});

function fakeAudioContext(window, {events=[], resume} = {}) {
  const contexts=[];
  const node=()=>({connect(){},disconnect(){}});
  window.AudioContext=class {
    constructor(options){this.options=options;this.state='suspended';this.sampleRate=48000;this.destination={};contexts.push(this);events.push('audio-created');}
    resume(){events.push('audio-resume');if(resume)return resume(this);this.state='running';return Promise.resolve();}
    createMediaStreamSource(){return node();}
    createScriptProcessor(){const processor=node();this.processor=processor;return processor;}
    createGain(){return {...node(),gain:{value:1}};}
    close(){this.state='closed';return Promise.resolve();}
  };
  return contexts;
}
const outcomeBefore=(promise,milliseconds=120)=>Promise.race([promise.then(()=>({done:true}),error=>({error})),new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),milliseconds))]);

test('microphone primes audio synchronously and cancels a pending permission request',async()=>{
  const env=environment(),events=[],contexts=fakeAudioContext(env.window,{events});let grant,stopped=0;
  env.context.navigator.mediaDevices.getUserMedia=()=>{events.push('media-requested');return new Promise(resolve=>{grant=resolve;});};
  const microphone=new env.api.Microphone(()=>true,()=>{},()=>{}),controller=new AbortController();
  const pending=microphone.start({signal:controller.signal});
  try {
    assert.deepEqual(events,['audio-created','audio-resume','media-requested']);
    controller.abort();const result=await outcomeBefore(pending);assert.equal(result.error?.name,'AbortError');assert.equal(contexts[0].state,'closed');
  } finally {microphone.dispose();grant?.({getTracks:()=>[{stop(){stopped++;}}]});await pending.catch(()=>{});}
  assert.equal(stopped,1);
});

test('microphone reports permission timeout and releases tracks granted afterwards',async()=>{
  const env=environment();fakeAudioContext(env.window);let grant,stopped=0;const phases=[];
  env.context.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;});
  const microphone=new env.api.Microphone(()=>true,()=>{},()=>{},{onPhase:value=>phases.push(value)});
  const pending=microphone.start({permissionTimeoutMs:15,audioTimeoutMs:15});
  try {const result=await outcomeBefore(pending);assert.match(result.error?.message || '',/麦克风授权.*超时/);assert.equal(phases[0].phase,'waiting-permission');}
  finally {microphone.dispose();grant?.({getTracks:()=>[{stop(){stopped++;}}]});await pending.catch(()=>{});}
  assert.equal(stopped,1);
});

test('microphone distinguishes granted input from suspended audio startup',async()=>{
  const env=environment(),phases=[];let resumeAudio,stopped=0;
  fakeAudioContext(env.window,{resume:()=>new Promise(resolve=>{resumeAudio=resolve;})});
  env.context.navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){stopped++;}}]});
  const microphone=new env.api.Microphone(()=>true,()=>{},()=>{},{onPhase:value=>phases.push(value)});
  const pending=microphone.start({permissionTimeoutMs:15,audioTimeoutMs:15});
  try {const result=await outcomeBefore(pending);assert.match(result.error?.message || '',/音频启动.*超时/);assert.ok(phases.some(value=>value.phase==='starting-audio' && value.audioState==='suspended'));}
  finally {microphone.dispose();resumeAudio?.();await pending.catch(()=>{});}
  assert.ok(stopped>=1);
});

function controlledClock() {
  let now=0,sequence=0;const timers=new Map();
  return {setTimeout(fn,delay=0){const id=++sequence;timers.set(id,{at:now+delay,fn});return id;},clearTimeout(id){timers.delete(id);},async tick(milliseconds){const target=now+milliseconds;for(;;){const next=[...timers.entries()].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();}now=target;await settle();}};
}

test('two completed conversation rounds keep the call open and re-enable the composer',async()=>{
  const appRunner=hookRunner(),headerRunner=hookRunner();let active=appRunner;
  const hooks=Object.fromEntries(['useState','useRef','useEffect','useCallback'].map(name=>[name,(...args)=>active.hooks[name](...args)]));
  const state={running:false,messages:[]},events=[],players=[];let resolvePreparation,transcribed=0;
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',autoRead:true,volume:.8},memory:{enabled:true},widget:{enabled:true,regions:{}}};
  const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  const env=environment(async(url,options)=>{
    if(url.includes('/state'))return response({config,session:{id:'session-a',preset:'whale',running:state.running},sessions:[{id:'session-a',title:'陪伴',preset:'whale'}]});
    if(url.includes('/messages'))return response({messages:state.messages,running:state.running});
    if(url.endsWith('/send')){const body=JSON.parse(options.body);state.running=true;state.messages.push({id:'user-'+state.messages.length,role:'user',text:body.text});return response({accepted:true});}
    if(url.endsWith('/synthesize'))return {ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>new Blob(['wav'])};
    if(url.endsWith('/speech/prepare')){events.push('asr-prepare');return await new Promise(resolve=>{resolvePreparation=()=>resolve(response({asr:{available:true,phase:'ready'}}));});}
    if(url.endsWith('/transcribe')){transcribed++;return response({text:''});}
    if(url.endsWith('/health'))return response({asr:{available:true,phase:'ready'}});
    return response({voices:[]});
  },hooks);
  const clock=controlledClock();env.context.setTimeout=clock.setTimeout;env.context.clearTimeout=clock.clearTimeout;
  const contexts=fakeAudioContext(env.window,{events});let tracksStopped=0;
  env.context.navigator.permissions={query:async()=>({state:'denied'})};
  env.context.navigator.mediaDevices.getUserMedia=async()=>{events.push('media-requested');return {getTracks:()=>[{stop(){tracksStopped++;}}]};};
  env.context.Audio=class {constructor(){players.push(this);}play(){return Promise.resolve();}pause(){}};
  env.window.localStorage=draftStorage();let App,Header;const effects=[],channel=[];
  env.window.addEventListener('dafeiyu:stop-audio',event=>channel.push(event.detail?.source));
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;if(options.name==='conversation.session.header.actions')Header=component;return ()=>{};}}});
  const renderApp=()=>{active=appRunner;return appRunner.render(App,{});};
  const headerProps={sessionId:'session-a',useSessions:select=>select({byId:{'session-a':{projectionValues:{agentPreset:'whale'}}}}),useSession:select=>select({running:state.running})};
  const renderHeader=()=>{active=headerRunner;return headerRunner.render(Header,headerProps);};
  renderApp();renderHeader();await settle();env.api.open('immersive','session-a');renderApp();await settle();renderApp();await settle();renderApp();
  const start=renderedNodes(renderApp()).find(node=>node.type==='button' && nodeText(node)==='开始语音').props.onClick();
  assert.deepEqual(events.slice(0,4),['audio-created','audio-resume','media-requested','asr-prepare']);
  renderApp();await settle();let tree=renderApp();
  assert.equal(renderedNodes(tree).find(node=>node.props.className==='dfj-ocean-stage').props['data-call-ready'],false);
  const emit=()=>{for(let i=0;i<5;i++)contexts[0].processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(.06)}});for(let i=0;i<9;i++)contexts[0].processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800)}});};
  emit();await settle();assert.equal(transcribed,0,'VAD must remain closed until ASR and microphone are both ready');
  resolvePreparation();await start;tree=renderApp();emit();await settle();renderApp();assert.equal(transcribed,1);
  assert.equal(renderedNodes(tree).find(node=>node.props.className==='dfj-ocean-stage').props['data-call-ready'],true);
  for(let round=1;round<=2;round++) {
    let nodes=renderedNodes(renderApp());nodes.find(node=>node.type==='textarea' && node.props['aria-label']==='给鲸鱼娘发消息').props.onChange({target:{value:'第'+round+'轮'}});nodes=renderedNodes(renderApp());
    assert.equal(nodes.find(node=>node.type==='button' && node.props['aria-label']==='发送消息').props.disabled,false);
    nodes.find(node=>node.type==='form' && node.props.className==='dfj-composer').props.onSubmit({preventDefault(){}});renderApp();renderHeader();await settle();
    await clock.tick(2200);renderApp();state.running=false;
    const reply={id:'assistant-'+round,role:'assistant',text:'主人，本鱼在这里。'+round,speakable:round===1,terminal:round===1};
    state.messages.push(reply);renderHeader();await settle();await clock.tick(800);tree=renderApp();nodes=renderedNodes(tree);
    if(round===2){
      assert.equal(players.length,1,'an idle assistant projection must wait for its terminal event before speaking');
      nodes.find(node=>node.type==='textarea' && node.props['aria-label']==='给鲸鱼娘发消息').props.onChange({target:{value:'接下来继续聊'}});nodes=renderedNodes(renderApp());
      assert.equal(nodes.find(node=>node.type==='button' && node.props['aria-label']==='发送消息').props.disabled,true,'a pending final reply must retain the send gate');
      reply.speakable=true;reply.terminal=true;await clock.tick(800);tree=renderApp();nodes=renderedNodes(tree);
      assert.equal(nodes.find(node=>node.type==='button' && node.props['aria-label']==='发送消息').props.disabled,false,'the completed reply must release the send gate');
    }
    assert.equal(players.length,round);
    assert.ok(nodes.some(node=>node.type==='button' && nodeText(node)==='结束语音'),'the dot playback event must not end its own call');
    assert.equal(nodes.find(node=>node.props.className==='dfj-ocean-stage').props['data-call-ready'],true);
    assert.ok(nodeText(tree).includes('主人，本鱼在这里。'+round));players.at(-1).onended();renderApp();
  }
  assert.ok(channel.length>=3);assert.ok(channel.every(source=>source==='dot'));
  renderedNodes(renderApp()).find(node=>node.type==='button' && nodeText(node)==='结束语音').props.onClick();renderApp();assert.equal(contexts[0].state,'closed');assert.ok(tracksStopped>=1);
  active=headerRunner;headerRunner.dispose();active=appRunner;appRunner.dispose();effects.forEach(fn=>fn());
});

test('a new cancelled turn end releases an immersive send with no assistant output',async()=>{
  const runner=hookRunner(),clock=controlledClock(),state={running:false,messages:[],lastTurnEnd:{id:'old-turn',reason:'completed'}},players=[];
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',autoRead:true,volume:.8},memory:{enabled:true},widget:{enabled:true,regions:{}}};
  const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  const env=environment(async(url,options)=>{
    if(url.includes('/state'))return response({config,session:{id:'session-a',preset:'whale',running:false},sessions:[{id:'session-a',title:'陪伴',preset:'whale'}]});
    if(url.includes('/messages'))return response({...state});
    if(url.endsWith('/send')){state.messages.push({id:'user',role:'user',text:JSON.parse(options.body).text});return response({accepted:true});}
    return response({voices:[]});
  },runner.hooks);
  env.context.setTimeout=clock.setTimeout;env.context.clearTimeout=clock.clearTimeout;env.window.localStorage=draftStorage();
  env.context.Audio=class {constructor(){players.push(this);}play(){return Promise.resolve();}pause(){}};
  let App;const effects=[];env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;return ()=>{};}}});
  const render=()=>runner.render(App,{});
  try {
    render();env.api.open('immersive','session-a');render();await settle();render();await settle();render();
    let nodes=renderedNodes(render());nodes.find(node=>node.type==='textarea').props.onChange({target:{value:'发出这一轮'}});nodes=renderedNodes(render());
    nodes.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});render();await settle();
    nodes=renderedNodes(render());nodes.find(node=>node.type==='textarea').props.onChange({target:{value:'取消后继续'}});render();
    await clock.tick(2200);nodes=renderedNodes(render());
    assert.equal(nodes.find(node=>node.type==='button' && node.props['aria-label']==='发送消息').props.disabled,true,'the previous turn end must not complete the current send');
    state.lastTurnEnd={id:'new-cancelled-turn',reason:'cancelled'};
    await clock.tick(800);nodes=renderedNodes(render());
    assert.equal(nodes.find(node=>node.type==='button' && node.props['aria-label']==='发送消息').props.disabled,false,'a new cancelled turn must release the composer even without assistant text');
    assert.equal(players.length,0,'cancelled turns must remain silent');
  } finally {runner.dispose();effects.forEach(fn=>fn());}
});

test('input analysis uses a silent sink and accepts live input despite a denied permission query',async()=>{
  const env=environment(),phases=[];const contexts=fakeAudioContext(env.window);let grant,stopped=0;
  env.context.navigator.permissions={query:async()=>({state:'denied'})};
  env.context.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;});
  const microphone=new env.api.Microphone(()=>true,()=>{},()=>{},{onPhase:value=>phases.push(value)}),pending=microphone.start({permissionTimeoutMs:1000});
  try {
    const waiting=await outcomeBefore(pending,10);assert.equal(waiting.timedOut,true,'the diagnostic query must not decide device authorization');
    grant({getTracks:()=>[{stop(){stopped++;}}]});await pending;
    assert.equal(contexts[0].options?.sinkId?.type,'none');assert.equal(contexts[0].state,'running');assert.equal(phases.at(-1).phase,'ready');assert.equal(phases.at(-1).permissionQuery,'denied');
  } finally {microphone.dispose();grant?.({getTracks:()=>[{stop(){stopped++;}}]});await pending.catch(()=>{});}
  assert.ok(stopped>=1);
});

test('the call page immediately shows denied microphone access and remains usable',async()=>{
  const page=await mountDraftComposer(draftStorage());const contexts=fakeAudioContext(page.env.window);
  page.env.context.navigator.permissions={query:async()=>({state:'granted'})};
  page.env.context.navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError');};
  const start=renderedNodes(page.render()).find(node=>node.type==='button' && nodeText(node)==='开始语音').props.onClick();
  await start;let tree=page.render(),nodes=renderedNodes(tree);
  assert.ok(nodeText(tree).includes('麦克风访问已被拒绝'));
  assert.ok(nodes.some(node=>node.type==='button' && nodeText(node)==='开始语音'));
  assert.equal(nodes.find(node=>node.props.className==='dfj-ocean-stage').props['data-call-ready'],false);
  assert.equal(contexts[0].state,'closed');page.dispose();
});

test('panel visibility broadcasts, replays for a late widget, and restores on cleanup',()=>{
  const env=environment(),effects=[],seen=[],early=[];
  env.window.addEventListener('dafeiyu:view',event=>early.push(event.detail.view));
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(){return ()=>{};}}});
  assert.deepEqual(early,[null]);
  env.window.addEventListener('dafeiyu:view',event=>seen.push(event.detail.view));
  env.api.open('settings','session-a');env.api.open('immersive','session-a');env.api.open(null);
  assert.deepEqual(seen,['settings','immersive',null]);
  env.api.open('settings','session-a');let panelActive=false;
  const enabled=true;env.window.addEventListener('dafeiyu:view',event=>{panelActive=event.detail.view==='settings' || event.detail.view==='immersive';assert.equal(Object.keys(event.detail).join(','),'view');});
  env.window.dispatchEvent({type:'dafeiyu:view-request'});assert.equal(panelActive,true);assert.equal(enabled && !panelActive,false);
  effects.forEach(fn=>fn());assert.equal(seen.at(-1),null);assert.equal(panelActive,false);assert.equal(enabled && !panelActive,true);
  const count=seen.length;env.window.dispatchEvent({type:'dafeiyu:view-request'});assert.equal(seen.length,count);assert.equal(env.events.get('dafeiyu:view-request').size,0);
});

test('very long replies remain readable and copyable while manual speech explains its size limit',async()=>{
  const page=await mountOceanRoom();
  try {
    const content='这是一段需要完整保留的长回复。'.repeat(320)+'最后一句也在这里呀。';
    page.state.messages=[{id:'very-long',role:'assistant',text:content,terminal:true,speakable:true}];
    await page.clock.tick(2300);await page.flush();
    assert.ok(nodeText(page.nodes().find(node=>node.props['aria-label']==='当前对话')).includes(content));
    assert.equal(page.button('重播回复').props.disabled,true);
    assert.match(page.button('重播回复').props.title,/较长/);
    assert.equal(page.button('复制回复').props.disabled,false);
    await page.button('复制回复').props.onClick();await page.flush();
    assert.equal(page.copied.at(-1),content);assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,0);
  } finally {page.dispose();}
});

test('a delayed copy result cannot mark a later reply as copied',async()=>{
  const page=await mountOceanRoom();let finish;
  try {
    page.env.context.navigator.clipboard.writeText=()=>new Promise(resolve=>{finish=resolve;});
    const copying=page.button('复制回复').props.onClick();
    page.state.messages=[{id:'next-reply',role:'assistant',text:'接着说这件事呀。',terminal:true,speakable:true}];
    await page.clock.tick(2300);await page.flush();finish();await copying;await page.flush();
    assert.ok(!nodeText(page.render()).includes('已复制'));
    assert.equal(page.composer().props.value,'阅读时保留的草稿');
  } finally {finish?.();page.dispose();}
});

test('Escape leaves expanded reading before closing the immersive page',async()=>{
  const page=await mountOceanRoom();
  try {
    page.button('展开阅读').props.onClick();await page.flush();
    page.env.window.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});await page.flush();
    assert.ok(page.room(),'the first Escape must keep the conversation open');
    assert.equal(page.room().props['data-reading'],'normal');assert.equal(page.composer().props.value,'阅读时保留的草稿');
    page.env.window.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});await page.flush();
    assert.equal(page.room(),undefined);
  } finally {page.dispose();}
});

test('song replay sends the exact reply identity and displays singing delivery',async()=>{
 const page=await mountOceanRoom();let body;
 try{
  const original=page.env.context.fetch;
  page.env.context.fetch=async(url,options)=>{
   if(!url.endsWith('/synthesize'))return original(url,options);
   body=JSON.parse(options.body);
   return {ok:true,headers:{get:name=>({'content-type':'audio/wav','x-dafeiyu-delivery':'singing'}[name]??null)},blob:async()=>new Blob(['song'])};
  };
  await page.button('重播回复').props.onClick();await page.flush();
  assert.equal(body.replyId,'reply-long');assert.equal(body.sessionId,'session-a');
  assert.ok(nodeText(page.render()).includes('大肥鱼清唱'));assert.equal(page.players.length,1);
 }finally{page.dispose();}
});

async function mountSimpleCall({autoRead=false,deferMedia=false,deferRecognition=false,deferSynthesis=false,observeNativeHeader=false,initialState={}}={}) {
  const runner=hookRunner(),headerRunner=hookRunner(),clock=controlledClock(),calls=[],players=[],media=[],recognitions=[],syntheses=[],deferredHeaders=[];let active=runner,nextMessageIsHeader=false,heldHeaderSnapshot=null;
  const hooks=Object.fromEntries(['useState','useRef','useEffect','useCallback'].map(name=>[name,(...args)=>active.hooks[name](...args)]));
  const state={running:false,preset:'whale',messages:[],lastTurnEnd:null,...initialState};let tracksStopped=0,sequence=0;
  const config={role:{name:'大肥鱼',address:'主人',prompt:'角色设定'},tts:{source:'local',localModel:'audiocpp',localVoice:'fish',speed:1.25,autoRead,volume:.7,emotional:true,expressiveness:'vivid'},memory:{enabled:true},widget:{enabled:true,soundEnabled:true,volume:.7,regions:{head:{},face:{},tail:{}}}};
  const json=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  const wav=()=>({ok:true,headers:{get:name=>({'content-type':'audio/wav','x-dafeiyu-delivery':'model','x-dafeiyu-emotion':'warm'}[name]??null)},blob:async()=>new Blob(['wav'])});
  const env=environment(async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body,signal:options.signal});
    if(url.includes('/state')){nextMessageIsHeader=true;return json({config,session:{id:new URL('http://localhost'+url).searchParams.get('sessionId'),title:'陪伴会话',preset:state.preset},sessions:[{id:'session-a',title:'会话A',preset:state.preset},{id:'session-b',title:'会话B',preset:'whale'}]});}
    if(url.includes('/messages')){
      const headerRead=nextMessageIsHeader;nextMessageIsHeader=false;
      if(headerRead&&heldHeaderSnapshot){const captured=heldHeaderSnapshot;heldHeaderSnapshot=null;return await new Promise(resolve=>deferredHeaders.push({signal:options.signal,resolve:()=>resolve(json(captured))}));}
      return json({...state});
    }
    if(url.includes('/models?'))return json({selected:{provider:'p',model:'one'},groups:[{id:'p',name:'服务',models:[{id:'one',name:'模型一'}]}],failures:[]});
    if(url.endsWith('/send')){state.running=true;state.messages.push({id:'user-'+(++sequence),role:'user',text:body.text});return json({accepted:true});}
    if(url.endsWith('/stop')){state.running=false;state.lastTurnEnd={id:'stopped-'+(++sequence),reason:'cancelled'};return json({});}
    if(url.endsWith('/synthesize'))return deferSynthesis?await new Promise(resolve=>syntheses.push({signal:options.signal,resolve:()=>resolve(wav())})):wav();
    if(url.endsWith('/transcribe'))return deferRecognition?await new Promise(resolve=>recognitions.push({signal:options.signal,resolve:text=>resolve(json({text}))})):json({text:'语音输入'});
    if(url.endsWith('/speech/prepare')||url.endsWith('/health'))return json({asr:{available:true,phase:'ready'}});
    return json({voices:[{id:'fish',name:'大肥鱼音色'}]});
  },hooks);
  env.context.setTimeout=clock.setTimeout;env.context.clearTimeout=clock.clearTimeout;env.window.localStorage=draftStorage();
  const contexts=fakeAudioContext(env.window);
  const stream=()=>({getTracks:()=>[{stop(){tracksStopped++;}}]});
  env.context.navigator.mediaDevices.getUserMedia=()=>deferMedia?new Promise(resolve=>media.push({resolve:()=>resolve(stream())})):Promise.resolve(stream());
  env.context.Audio=class {constructor(){players.push(this);this.pauses=0;}play(){this.played=true;return Promise.resolve();}pause(){this.pauses++;}};
  let App,Entry,Header;const effects=[];
  env.plugin.apply({effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay')App=component;if(options.name==='conversation.session.header.utilities')Entry=component;if(options.name==='conversation.session.header.actions')Header=component;return ()=>{};}}});
  const render=()=>{active=runner;return runner.render(App,{});},nodes=()=>renderedNodes(render()),button=label=>nodes().find(node=>node.type==='button'&&(node.props['aria-label']===label||nodeText(node)===label));
  const renderHeader=()=>{active=headerRunner;return headerRunner.render(Header,{sessionId:'session-a',useSessions:select=>select({byId:{'session-a':{projectionValues:{agentPreset:state.preset}}}}),useSession:select=>select({running:state.running})});};
  const flush=async()=>{render();if(observeNativeHeader)renderHeader();await settle();render();await settle();return render();};
  const emit=()=>{const processor=contexts.at(-1)?.processor;assert.ok(processor?.onaudioprocess,'a live microphone processor is required');for(let i=0;i<5;i++)processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(.06)}});for(let i=0;i<9;i++)processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800)}});};
  async function send(text){if(!nodes().some(node=>node.type==='textarea')){button('文字与模型').props.onClick();render();}nodes().find(node=>node.type==='textarea'&&node.props['aria-label']==='给大肥鱼发消息').props.onChange({target:{value:text}});render();nodes().find(node=>node.type==='form'&&node.props.className==='dfj-call-composer').props.onSubmit({preventDefault(){}});await flush();}
  async function complete(text='主人，我在这里呀。'){state.running=false;const id='assistant-'+(++sequence);state.messages.push({id,role:'assistant',text,speakable:true,terminal:true});state.lastTurnEnd={id:'completed-'+sequence,reason:'completed'};if(observeNativeHeader)renderHeader();await clock.tick(2300);await flush();return id;}
  render();env.api.open('call','session-a');await flush();await flush();
  return {env,state,config,calls,players,media,recognitions,syntheses,contexts,clock,render,nodes,button,flush,send,complete,emit,deferredHeaders,holdHeaderSnapshot:snapshot=>{heldHeaderSnapshot=JSON.parse(JSON.stringify(snapshot));},tracksStopped:()=>tracksStopped,entry:sessionId=>renderedNodes(Entry({sessionId})),stage:()=>nodes().find(node=>node.props.className==='dfj-call-stage'),dispose(){headerRunner.dispose();runner.dispose();effects.forEach(fn=>fn());}};
}

test('session call entries and public settings navigation retain the current session',async()=>{
  const page=await mountSimpleCall();const views=[];page.env.window.addEventListener('dafeiyu:view',event=>views.push(event.detail.view));
  try{
    assert.equal(page.entry('session-a').some(node=>node.props['aria-label']==='打开大肥鱼配置中心'),false);
    page.env.window.dispatchEvent({type:'dafeiyu:open',detail:{view:'settings',sessionId:'session-a'}});await page.flush();
    assert.equal(views.at(-1),'settings');assert.ok(page.nodes().some(node=>node.props.className==='dfj-settings dfc-settings-shell'));
    page.button('语音通话').props.onClick();await page.flush();assert.equal(views.at(-1),'call');assert.ok(page.stage());
    assert.equal(new URL('http://localhost'+page.calls.filter(call=>call.url.includes('/state')).at(-1).url).searchParams.get('sessionId'),'session-a');
    page.entry('session-b').find(node=>node.props['aria-label']==='与大肥鱼通话').props.onClick();await page.flush();
    assert.equal(new URL('http://localhost'+page.calls.filter(call=>call.url.includes('/state')).at(-1).url).searchParams.get('sessionId'),'session-b');
    page.env.window.dispatchEvent({type:'dafeiyu:open',detail:{view:'immersive',sessionId:'session-a'}});await page.flush();assert.equal(views.at(-1),'settings');
    page.env.window.dispatchEvent({type:'dafeiyu:open',detail:{view:'call',sessionId:'session-b'}});await page.flush();assert.equal(views.at(-1),'call');assert.ok(page.stage());
    assert.equal(page.calls.filter(call=>call.url.endsWith('/session')||call.url.endsWith('/config')).length,0);
    assert.equal(page.contexts.length,0,'opening the call page must not acquire a microphone');
  }finally{page.dispose();}
});

test('simple calls speak two completed rounds while desktop auto-read stays off',async()=>{
  const page=await mountSimpleCall();
  try{
    assert.equal(page.button('开始通话').props.disabled,false);await page.button('开始通话').props.onClick();await page.flush();
    assert.equal(page.stage().props['data-call-ready'],true);
    for(let round=1;round<=2;round++){
      await page.send('第'+round+'句');const id=await page.complete('我听见啦，第'+round+'句。');
      assert.equal(page.players.length,round);assert.equal(page.players.at(-1).played,true);assert.equal(page.players.at(-1).volume,.7);
      assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).at(-1).body.replyId,id);
      assert.equal(page.calls.filter(call=>call.url.endsWith('/send')).at(-1).body.sessionId,'session-a');
      assert.ok(page.button('挂断'));assert.equal(page.stage().props['data-call-ready'],true);
      page.players.at(-1).onended();await page.flush();
    }
    assert.equal(page.config.tts.autoRead,false);assert.equal(page.calls.filter(call=>call.url.endsWith('/config')).length,0);
    page.button('挂断').props.onClick();await page.flush();assert.equal(page.contexts[0].state,'closed');assert.ok(page.tracksStopped()>0);
  }finally{page.dispose();}
});

test('hanging up suppresses a late call reply even with desktop auto-read on and redial remains clean',async()=>{
  const page=await mountSimpleCall({autoRead:true});
  try{
    await page.button('开始通话').props.onClick();await page.flush();await page.send('先说这一句');
    page.button('挂断').props.onClick();await page.flush();
    assert.equal(page.button('开始通话').props.disabled,true,'an unfinished agent turn cannot be redialled');
    await page.complete('上一通的迟到回复');assert.equal(page.players.length,0);assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,0);
    await page.button('开始通话').props.onClick();await page.flush();assert.equal(page.players.length,0,'redial must not replay the previous call');
    await page.send('现在是新的一通');await page.complete('这一次我在呀。');assert.equal(page.players.length,1);
    assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).at(-1).body.text,'这一次我在呀。');
  }finally{page.dispose();}
});

test('closing a pending call keeps its late reply silent in the native conversation reader',async()=>{
  const page=await mountSimpleCall({autoRead:true,observeNativeHeader:true});
  try{
    await page.button('开始通话').props.onClick();await page.flush();await page.send('关闭后这句回复应当保持静默');
    page.button('返回会话').props.onClick();await page.flush();await page.complete('已经关闭通话后的迟到回复');
    assert.equal(page.players.length,0,'the native reader must not take over a cancelled call reply');
    assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,0);
    assert.equal(page.config.tts.autoRead,true,'ordinary desktop auto-read remains a separate preference');
    page.state.running=true;page.state.messages.push({id:'native-user',role:'user',text:'回到原生会话后继续聊'});await page.flush();
    await page.complete('原生会话后续回复仍能正常朗读');
    assert.equal(page.players.length,1,'suppressing a cancelled call must not disable later native auto-read');
    assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).at(-1).body.text,'原生会话后续回复仍能正常朗读');
  }finally{page.dispose();}
});

test('stale header snapshots preserve pending call ownership and empty cancelled turns release it',async()=>{
  for(const outcome of ['reply','cancelled']){
    const historical={id:'history-one',role:'assistant',text:'已有的上一轮',speakable:true,terminal:true};
    const page=await mountSimpleCall({autoRead:true,observeNativeHeader:true,initialState:{messages:[historical],lastTurnEnd:{id:'history-turn-one',reason:'completed'}}});
    try{
      if(outcome==='reply'){
        page.holdHeaderSnapshot({...page.state});await page.clock.tick(2300);await page.flush();assert.equal(page.deferredHeaders.length,1);
        page.state.messages.push({id:'history-two',role:'assistant',text:'页面已经看见的更新一轮',speakable:true,terminal:true});page.state.lastTurnEnd={id:'history-turn-two',reason:'completed'};
        await page.clock.tick(2300);await page.flush();
      }
      await page.button('开始通话').props.onClick();await page.flush();
      // Keep the native projection at its prior idle state until this old read returns.
      page.button('文字与模型').props.onClick();page.render();
      page.nodes().find(node=>node.type==='textarea'&&node.props['aria-label']==='给大肥鱼发消息').props.onChange({target:{value:'本次通话中的一句话'}});page.render();
      page.nodes().find(node=>node.type==='form'&&node.props.className==='dfj-call-composer').props.onSubmit({preventDefault(){}});page.render();await settle();page.render();
      assert.equal(page.calls.filter(call=>call.url.endsWith('/send')).length,1);
      if(outcome==='reply'){
        assert.equal(page.deferredHeaders[0].signal.aborted,false,'the early header read is still in flight when the call turn is claimed');
        page.deferredHeaders[0].resolve();await settle();page.render();
      }
      page.button('返回会话').props.onClick();await page.flush();
      if(outcome==='reply')await page.complete('这次通话真正完成的迟到回复');
      else {page.state.running=false;page.state.lastTurnEnd={id:'cancelled-call-without-assistant',reason:'cancelled'};await page.flush();await page.clock.tick(2300);await page.flush();}
      assert.equal(page.players.length,0,outcome+' must remain silent after the call page closes');
      assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,0);
      page.state.running=true;page.state.messages.push({id:'native-after-'+outcome,role:'user',text:'之后回到原生会话正常交流'});await page.flush();
      await page.complete('之后原生会话的正常回复');assert.equal(page.players.length,1,outcome+' must release ownership before the next native turn');
      assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).at(-1).body.text,'之后原生会话的正常回复');
    }finally{page.dispose();}
  }
});

test('a call hung up during permission preparation releases late microphone tracks',async()=>{
  const page=await mountSimpleCall({deferMedia:true});
  try{
    const starting=page.button('开始通话').props.onClick();await page.flush();assert.equal(page.media.length,1);assert.equal(page.stage().props['data-call-ready'],false);
    page.button('挂断').props.onClick();await page.flush();assert.equal(page.contexts[0].state,'closed');
    page.media[0].resolve();await starting;await page.flush();
    assert.ok(page.tracksStopped()>0);assert.ok(page.button('开始通话'));assert.equal(page.stage().props['data-call-ready'],false);
    assert.equal(page.calls.filter(call=>call.url.endsWith('/transcribe')||call.url.endsWith('/send')||call.url.endsWith('/synthesize')).length,0);
  }finally{page.dispose();}
});

test('muting and hanging up discard late ASR results across a redial',async()=>{
  const page=await mountSimpleCall({deferRecognition:true});
  try{
    await page.button('开始通话').props.onClick();await page.flush();page.emit();await page.flush();assert.equal(page.recognitions.length,1);
    page.button('麦克风静音').props.onClick();await page.flush();assert.equal(page.recognitions[0].signal.aborted,true);
    page.recognitions[0].resolve('静音前的迟到文本');await page.flush();assert.equal(page.calls.filter(call=>call.url.endsWith('/send')).length,0);
    page.button('取消静音').props.onClick();await page.flush();page.emit();await page.flush();assert.equal(page.recognitions.length,2);
    page.button('挂断').props.onClick();await page.flush();assert.equal(page.recognitions[1].signal.aborted,true);
    await page.button('开始通话').props.onClick();await page.flush();page.recognitions[1].resolve('上一通的迟到文本');await page.flush();
    assert.equal(page.calls.filter(call=>call.url.endsWith('/send')).length,0);
    page.emit();await page.flush();assert.equal(page.recognitions.length,3);page.recognitions[2].resolve('新通话中的这句话');await page.flush();
    const sent=page.calls.filter(call=>call.url.endsWith('/send'));assert.equal(sent.length,1);assert.equal(sent[0].body.text,'新通话中的这句话');assert.equal(sent[0].body.sessionId,'session-a');
  }finally{page.dispose();}
});

test('hanging up cancels voice preparation and rejects its late audio',async()=>{
  const page=await mountSimpleCall({deferSynthesis:true});
  try{
    await page.button('开始通话').props.onClick();await page.flush();await page.send('等你说话');await page.complete();assert.equal(page.syntheses.length,1);
    page.button('挂断').props.onClick();await page.flush();assert.equal(page.syntheses[0].signal.aborted,true);
    page.syntheses[0].resolve();await page.flush();assert.equal(page.players.length,0);assert.equal(page.contexts[0].state,'closed');assert.equal(page.button('开始通话').props.disabled,false);
  }finally{page.dispose();}
});

test('leaving a simple call for settings, another session, closing or standard mode releases audio input',async()=>{
  for(const destination of ['settings','session-b','close','standard']){
    const page=await mountSimpleCall();
    try{
      await page.button('开始通话').props.onClick();await page.flush();assert.equal(page.stage().props['data-call-ready'],true);
      if(destination==='settings')page.button('通话设置').props.onClick();
      else if(destination==='session-b')page.env.api.open('call','session-b');
      else if(destination==='close')page.button('返回会话').props.onClick();
      else {page.state.preset='standard';page.env.window.dispatchEvent({type:'dafeiyu:mode',detail:{sessionId:'session-a',preset:'standard'}});}
      await page.flush();assert.equal(page.contexts[0].state,'closed',destination);assert.ok(page.tracksStopped()>0,destination);assert.equal(page.players.length,0,destination);
      assert.equal(page.button('挂断'),undefined,destination);
      if(destination==='session-b')assert.equal(page.nodes().find(node=>node.type==='select'&&node.props['aria-label']==='通话会话').props.value,'session-b');
      if(destination==='standard')assert.equal(page.button('开始通话').props.disabled,true);
    }finally{page.dispose();}
  }
});

test('QQ recovery reconnects saved settings once and leaves unsaved connection fields untouched',async()=>{
  const page=await mountOceanRoom();let attempts=0,finish;const original=page.env.context.fetch;page.env.context.setInterval=()=>0;page.env.context.clearInterval=()=>{};
  const response=data=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})});
  page.env.context.fetch=async(url,options)=>{
    if(url.endsWith('/qq/reconnect')){attempts++;await new Promise(resolve=>finish=resolve);return response({qq:{phase:'connecting',connected:false,paired:true}});}
    if(url.endsWith('/qq/status'))return response({qq:{phase:'error',connected:false,paired:true,lastError:'网关暂时离线',recovery:{nextRetryAt:Date.now()+5000}}});
    if(url.includes('/state')){const r=await original(url,options),data=await r.json();data.config.qq={enabled:true,sessionId:'session-a',wsUrl:'ws://127.0.0.1:13001',ownerId:'20002'};return response(data);}
    return original(url,options);
  };
  try{
    page.env.api.open('settings','session-a','qq');await page.flush();await page.flush();
    page.button('连接与配对').props.onClick();await page.flush();
    const field=page.nodes().find(n=>n.type==='input'&&n.props['aria-label']==='本机QQ网关');field.props.onChange({target:{value:'ws://127.0.0.1:14001'}});await page.flush();
    const before=page.calls.filter(x=>x.url.endsWith('/config')).length,pending=page.button('重新连接').props.onClick();await page.flush();
    assert.equal(page.button('正在重连…').props.disabled,true);assert.equal(attempts,1);finish();await pending;await page.flush();
    assert.equal(page.calls.filter(x=>x.url.endsWith('/config')).length,before);
    assert.equal(page.nodes().find(n=>n.type==='input'&&n.props['aria-label']==='本机QQ网关').props.value,'ws://127.0.0.1:14001');
    assert.ok(nodeText(page.render()).includes('已开始重新连接已保存的QQ网关'));
  }finally{page.dispose();}
});
