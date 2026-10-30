import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
const categories=['模式与角色','语音','记忆','挂件与音效','QQ'];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const clone=value=>JSON.parse(JSON.stringify(value));

function hookRunner(){
  const cells=[];let cursor=0,pending=[];
  const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((value,index)=>!Object.is(value,b[index]));
  const hooks={
    useState(initial){const id=cursor++;if(!cells[id])cells[id]={value:typeof initial==='function'?initial():initial};return [cells[id].value,next=>{cells[id].value=typeof next==='function'?next(cells[id].value):next;}];},
    useRef(initial){const id=cursor++;if(!cells[id])cells[id]={current:initial};return cells[id];},
    useEffect(effect,deps){const id=cursor++;if(!cells[id]||changed(cells[id].deps,deps))pending.push(()=>{cells[id]?.cleanup?.();cells[id]={deps,cleanup:effect()};});},
    useCallback(fn,deps){const id=cursor++;if(!cells[id]||changed(cells[id].deps,deps))cells[id]={value:fn,deps};return cells[id].value;},
  };
  return {hooks,render(component){cursor=0;pending=[];const tree=component({});pending.forEach(effect=>effect());return tree;},dispose(){cells.forEach(cell=>cell?.cleanup?.());}};
}
function nodes(tree,result=[]){
  if(Array.isArray(tree)){tree.forEach(child=>nodes(child,result));return result;}
  if(!tree||typeof tree!=='object')return result;
  if(typeof tree.type==='function')return nodes(tree.type(tree.props),result);
  result.push(tree);nodes(tree.props?.children,result);return result;
}
function text(tree){if(Array.isArray(tree))return tree.map(text).join('');if(tree&&typeof tree==='object')return text(tree.props?.children);return tree==null||tree===false?'':String(tree);}

async function mountSettings({deferMemoryModule=false,nativePanel=false}={}){
  const runner=hookRunner(),calls=[],events=new Map(),effects=[];
  const overlayRunner=hookRunner();let activeRunner=runner;
  let definition,App,Overlay,moduleLoads=0;
  const layoutState={activePanelId:nativePanel?'dsh-dafeiyu-dot':null},panelSelections=[];
  const layout={panelInfo:{getSnapshot:()=>layoutState},selectPanel(id){layoutState.activePanelId=id;panelSelections.push(id);}};
  const initial={
    role:{name:'大肥鱼',address:'主人',prompt:'一份完整的角色设定'},
    tts:{source:'local',localUrl:'http://127.0.0.1:3900/v1',localModel:'audiocpp',localVoice:'sample-voice',apiUrl:'https://api.example.com/v1',apiModel:'tts',apiVoice:'sample',autoRead:false,volume:.8,speed:1,emotional:true,expressiveness:'natural'},
    memory:{enabled:true},
    widget:{enabled:true,soundEnabled:true,volume:.7,regions:{head:{text:'头部回应',audio:'audio/head.wav'},face:{text:'脸颊回应',audio:'audio/face.wav'},tail:{text:'鱼鳍回应',audio:'audio/tail.wav'}}},
    qq:{enabled:false,wsUrl:'ws://127.0.0.1:13001',sessionId:'session-a',voiceReplies:true,stickerReplies:true,groups:[]},
  };
  let stored=clone(initial);
  const React={...Object.fromEntries(Object.keys(runner.hooks).map(name=>[name,(...args)=>activeRunner.hooks[name](...args)])),Fragment:Symbol('Fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}})};
  const window={
    __ModuleLoader__:{load(value){definition=value;}},
    __memoryModule:{createMemoryExplorer(react){moduleLoads++;return function ExplorerShell(props){return react.createElement('section',{'data-memory-module':'loaded'},react.createElement('div',{className:'dfg-settings-action'},props.settingsAction),props.management,props.editor);};}},
    addEventListener(type,fn){if(!events.has(type))events.set(type,new Set());events.get(type).add(fn);},
    removeEventListener(type,fn){events.get(type)?.delete(fn);},
    dispatchEvent(event){events.get(event.type)?.forEach(fn=>fn(event));},
    localStorage:{length:0,key(){return null;},getItem(){return null;}},
  };
  let rejectModule;
  window.__loadMemoryModule=()=>deferMemoryModule?new Promise((_resolve,reject)=>{rejectModule=reject;}):Promise.resolve(window.__memoryModule);
  const document={hidden:false,head:{appendChild(){}},createElement:()=>({dataset:{},remove(){}}),addEventListener(){},removeEventListener(){}};
  const fetch=async(url,options={})=>{
    const method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    calls.push({url,method,body});
    let data={};
    if(url.includes('/state')&&!url.includes('/qq/'))data={config:clone(stored),session:{id:'session-a',title:'陪伴会话',preset:'whale',running:false},sessions:[{id:'session-a',title:'陪伴会话',preset:'whale'}]};
    else if(url.endsWith('/config')&&method==='POST'){stored=clone(body);data={config:clone(stored)};}
    else if(url.includes('/memory/graph'))data={records:[],spaces:[{id:'self',name:'鲸鱼娘自己的'},{id:'owner',name:'我眼里的主人'}],palace:{palaceRoot:'/sample/记忆宫殿',memoryCount:0,pendingJobs:0,failedJobs:0},index:{builtAt:'2026-10-29T10:00:00Z',people:[],topics:[],dates:[]}};
    else if(url.endsWith('/voices'))data={voices:[{id:'sample-voice',name:'大肥鱼'}]};
    else if(url.endsWith('/health'))data={tts:{available:true},asr:{available:true,phase:'ready'}};
    else if(url.includes('/qq/state'))data={qq:{enabled:false,connected:false,monitor:{messages:[],retentionDays:7,limit:200}},config:clone(stored.qq)};
    else if(url.includes('/qq/groups'))data={groups:[]};
    else if(url.includes('/qq/messages'))data={messages:[],total:0};
    return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({ok:true,...data})};
  };
  const context=vm.createContext({window,document,console,fetch,AbortController,DOMException,setTimeout,clearTimeout,setInterval,clearInterval,Uint8Array,Float32Array,ArrayBuffer,DataView,URL,crypto:globalThis.crypto,navigator:{mediaDevices:{}},btoa:value=>Buffer.from(value,'binary').toString('base64'),CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}}});
  const importPattern=/\bimport\(\s*ASSET\s*\+\s*['"]memory-explorer\.js\?v=\d+['"]\s*\)/g;
  assert.equal([...source.matchAll(importPattern)].length,1,'the harness must replace the actual explorer module import');
  const executable=source.replace(importPattern,'window.__loadMemoryModule()').replace('    function App(props) {','    window.__navigationTest = {open};\n    function App(props) {');
  vm.runInContext(executable,context);
  const plugin=definition.factory(name=>{assert.equal(name,'react');return React;});
  plugin.apply({...nativePanel?{layout}:{},effect(fn){effects.push(fn());},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='shell.overlay'){Overlay=component;if(!nativePanel)App=component;}if(nativePanel&&options.name==='main')App=()=>component(options.inject());return ()=>{};}}});
  let tree,overlayTree;
  const render=()=>{activeRunner=runner;tree=runner.render(App);if(nativePanel){activeRunner=overlayRunner;overlayTree=overlayRunner.render(Overlay);activeRunner=runner;}return tree;};
  const all=()=>nodes(render());
  async function flush(){for(let i=0;i<3;i++){render();await settle();}return render();}
  const nav=()=>all().find(node=>node.type==='nav'&&node.props['aria-label']==='配置分类');
  const navButtons=()=>nodes(nav()).filter(node=>node.type==='button');
  async function go(label){const button=navButtons().find(node=>text(node)===label);assert.ok(button,'configuration navigation must contain '+label);button.props.onClick();await flush();}
  const button=label=>{const found=all().find(node=>node.type==='button'&&text(node)===label);assert.ok(found,'expected button '+label);return found;};
  const byAria=label=>{const found=all().find(node=>node.props['aria-label']===label);assert.ok(found,'expected field '+label);return found;};
  const field=(label,tag='input')=>{const container=all().find(node=>node.type==='label'&&text(node).startsWith(label));assert.ok(container,'expected labeled field '+label);const found=nodes(container).find(node=>node.type===tag);assert.ok(found,'expected '+tag+' for '+label);return found;};
  const configWrites=()=>calls.filter(call=>call.url.endsWith('/config')&&call.method==='POST');
  render();if(!nativePanel)window.__navigationTest.open('settings','session-a');await flush();
  return {all,navButtons,go,button,field,byAria,flush,calls,configWrites,panelSelections,layoutState,open:window.__navigationTest.open,overlayButton:label=>nodes(overlayTree).find(node=>node.type==='button'&&node.props['aria-label']===label),dispatch:event=>window.dispatchEvent(event),stored:()=>clone(stored),initial,moduleLoads:()=>moduleLoads,rejectModule:()=>rejectModule(new Error('sample module unavailable')),dispose(){runner.dispose();overlayRunner.dispose();effects.forEach(cleanup=>cleanup?.());}};
}

test('the native sidebar opens global settings without selecting or creating a conversation',async()=>{
  const page=await mountSettings({nativePanel:true});
  try{
    assert.deepEqual(page.navButtons().map(text),categories);
    const root=page.all().find(node=>node.props.className==='dfj-root dfj-panel-root');
    assert.equal(root.props.role,'region');assert.equal(root.props['aria-modal'],undefined);
    assert.equal(page.button('语音通话').props.disabled,true);
    assert.ok(page.calls.some(call=>call.url==='/dsh-dafeiyu-dot/state'));
    assert.equal(page.calls.some(call=>call.url.includes('sessionId=')||call.url.endsWith('/session')),false);
    for(const label of categories)await page.go(label);
    assert.equal(page.configWrites().length,0);
    await page.go('模式与角色');
    page.field('会话','select').props.onChange({target:{value:'session-a'}});await page.flush();
    assert.equal(page.button('语音通话').props.disabled,false);
    page.button('语音通话').props.onClick();await page.flush();
    assert.equal(page.layoutState.activePanelId,null,'conversation calls leave the native settings panel');
    assert.equal(page.all().some(node=>node.props.className==='dfj-panel-host'),false);
    page.overlayButton('通话设置').props.onClick();await page.flush();
    assert.equal(page.layoutState.activePanelId,'dsh-dafeiyu-dot');
    assert.equal(page.navButtons().find(node=>node.props['aria-current']==='page').props.children[0],'语音');
    assert.equal(page.byAria('说话语速').props.value,1);
    page.open('settings','session-a','memory');await page.flush();
    page.open('settings','session-a','voice');await page.flush();
    assert.equal(page.byAria('说话语速').props.value,1,'a repeated settings shortcut must select its target category');
  }finally{page.dispose();}
});

test('native read events have a single owner when panel and overlay surfaces are both mounted',async()=>{
  const page=await mountSettings({nativePanel:true});
  try{
    page.dispatch({type:'dafeiyu:read',detail:{sessionId:'session-a',text:'一条完整回复',config:{tts:{autoRead:true}}}});await page.flush();
    assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,1);
    page.open(null);await page.flush();
    assert.equal(page.layoutState.activePanelId,null);
    page.dispatch({type:'dafeiyu:read',detail:{sessionId:'session-a',text:'下一条完整回复',config:{tts:{autoRead:true}}}});await page.flush();
    assert.equal(page.calls.filter(call=>call.url.endsWith('/synthesize')).length,2);
  }finally{page.dispose();}
});

test('memory navigation keeps every configuration category reachable with its production form',async()=>{
  const page=await mountSettings();
  try{
    await page.go('记忆');
    assert.equal(page.moduleLoads(),1);
    assert.ok(page.all().some(node=>node.props['data-memory-module']==='loaded'),'the test must exercise the loaded explorer rather than its fallback');
    assert.deepEqual(page.navButtons().map(text),categories);
    assert.equal(page.navButtons().find(node=>text(node)==='记忆').props['aria-current'],'page');
    for(const label of ['模式与角色','语音','挂件与音效','QQ']){
      await page.go(label);
      assert.deepEqual(page.navButtons().map(text),categories);
      assert.equal(page.navButtons().find(node=>text(node)===label).props['aria-current'],'page');
      if(label==='模式与角色')assert.equal(page.byAria('完整角色提示词').props.value,page.initial.role.prompt);
      if(label==='语音'){assert.equal(page.field('本地服务地址').props.value,page.initial.tts.localUrl);assert.equal(page.byAria('说话语速').props.value,1);}
      if(label==='挂件与音效'){assert.equal(page.byAria('显示记账挂件').props.role,'switch');assert.ok(page.all().some(node=>node.type==='input'&&node.props.value==='audio/head.wav'));}
      if(label==='QQ'){page.button('连接与配对').props.onClick();await page.flush();assert.equal(page.byAria('QQ陪伴会话').type,'select');assert.equal(page.field('本机QQ网关').props.value,page.initial.qq.wsUrl);}
      await page.go('记忆');
      assert.ok(page.all().some(node=>node.props['data-memory-module']==='loaded'));
    }
    assert.equal(page.configWrites().length,0,'navigation and read-only form loading must not save configuration');
    assert.deepEqual(page.stored(),page.initial);
  }finally{page.dispose();}
});

test('every configuration page keeps its category rail in the shared shell',async()=>{
  const page=await mountSettings();
  try{
    for(const label of ['模式与角色','记忆','语音','记忆','挂件与音效','QQ','记忆']){
      await page.go(label);
      const shell=page.all().find(node=>node.props.className==='dfj-settings dfc-settings-shell');
      assert.ok(shell,'all categories must use the shared settings shell');
      const rail=shell.props.children[0];
      assert.equal(rail.props.className,'dfc-category-rail');
      assert.deepEqual(nodes(rail).filter(node=>node.type==='button').map(text),categories);
      assert.equal(page.all().filter(node=>node.type==='nav'&&node.props['aria-label']==='配置分类').length,1);
    }
  }finally{page.dispose();}
});

test('the shared category rail stays available while the graph loads and when loading fails',async()=>{
  const page=await mountSettings({deferMemoryModule:true});
  try{
    await page.go('记忆');
    assert.equal(page.moduleLoads(),0);
    assert.ok(page.all().some(node=>node.props.role==='status'&&text(node)==='正在展开记忆星图…'));
    for(const failed of [false,true]){
      if(failed){page.rejectModule();await page.flush();assert.ok(page.all().some(node=>node.props.role==='alert'));}
      const shell=page.all().find(node=>node.props.className==='dfj-settings dfc-settings-shell');
      assert.equal(shell.props.children[0].props.className,'dfc-category-rail');
      assert.deepEqual(page.navButtons().map(text),categories);
      assert.equal(page.all().filter(node=>node.type==='nav'&&node.props['aria-label']==='配置分类').length,1);
    }
    page.button('返回工作区');
    page.byAria('启用陪伴记忆').props.onClick();await page.flush();
    await page.button('保存设置').props.onClick();await page.flush();
    assert.equal(page.stored().memory.enabled,false);
    await page.go('语音');
    assert.equal(page.field('本地服务地址').props.value,page.initial.tts.localUrl);
    assert.equal(page.configWrites().length,1);
  }finally{page.dispose();}
});

test('configuration and memory drafts survive round trips through the memory graph without writes',async()=>{
  const page=await mountSettings();
  try{
    page.field('她的名字').props.onChange({target:{value:'海汐'}});
    page.byAria('完整角色提示词').props.onChange({target:{value:'保留尚未保存的角色草稿'}});
    await page.go('语音');page.field('本地服务地址').props.onChange({target:{value:'http://127.0.0.1:3999/v1'}});page.byAria('说话语速').props.onChange({target:{value:'1.25'}});
    await page.go('挂件与音效');page.byAria('显示记账挂件').props.onClick();page.field('挂件音量').props.onChange({target:{value:'0.42'}});
    await page.go('QQ');page.button('连接与配对').props.onClick();await page.flush();page.field('本机QQ网关').props.onChange({target:{value:'ws://127.0.0.1:13101'}});page.byAria('QQ语音回复').props.onClick();
    await page.go('记忆');page.byAria('记忆内容').props.onChange({target:{value:'尚未保存的记忆草稿'}});
    for(const label of ['模式与角色','语音','挂件与音效','QQ']){
      await page.go(label);
      if(label==='模式与角色'){assert.equal(page.field('她的名字').props.value,'海汐');assert.equal(page.byAria('完整角色提示词').props.value,'保留尚未保存的角色草稿');}
      if(label==='语音'){assert.equal(page.field('本地服务地址').props.value,'http://127.0.0.1:3999/v1');assert.equal(page.byAria('说话语速').props.value,1.25);}
      if(label==='挂件与音效'){assert.equal(page.byAria('显示记账挂件').props['aria-checked'],false);assert.equal(page.field('挂件音量').props.value,.42);}
      if(label==='QQ'){assert.equal(page.field('本机QQ网关').props.value,'ws://127.0.0.1:13101');assert.equal(page.byAria('QQ语音回复').props['aria-checked'],false);}
      await page.go('记忆');assert.equal(page.byAria('记忆内容').props.value,'尚未保存的记忆草稿');
    }
    assert.equal(page.configWrites().length,0);
    assert.deepEqual(page.stored(),page.initial);
  }finally{page.dispose();}
});

test('dirty settings can be saved from the graph footer without losing the other sections',async()=>{
  const page=await mountSettings();
  try{
    page.field('她的名字').props.onChange({target:{value:'海汐'}});
    await page.go('语音');page.byAria('说话语速').props.onChange({target:{value:'1.15'}});
    await page.go('记忆');
    const bar=page.all().find(node=>node.props.className==='dfg-settings-action');
    const save=nodes(bar).find(node=>node.type==='button'&&text(node)==='保存设置');
    assert.ok(save,'dirty configuration needs a save action on the memory page');assert.equal(save.props.disabled,false);
    await save.props.onClick();await page.flush();
    const writes=page.configWrites();assert.equal(writes.length,1);assert.equal(writes[0].body.role.name,'海汐');assert.equal(writes[0].body.tts.speed,1.15);assert.deepEqual(writes[0].body.widget,page.initial.widget);assert.deepEqual(writes[0].body.qq,page.initial.qq);
    const cleanBar=page.all().find(node=>node.props.className==='dfg-settings-action');
    assert.equal(nodes(cleanBar).some(node=>node.type==='button'&&text(node)==='保存设置'),false,'saved footer should return to its clean state');
    await page.go('模式与角色');assert.equal(page.field('她的名字').props.value,'海汐');
  }finally{page.dispose();}
});

test('the memory enable setting remains explicitly saveable from the memory page',async()=>{
  const page=await mountSettings();
  try{
    await page.go('记忆');page.byAria('启用陪伴记忆').props.onClick();await page.flush();
    assert.equal(page.byAria('启用陪伴记忆').props['aria-checked'],false);assert.equal(page.configWrites().length,0);
    const bar=page.all().find(node=>node.props.className==='dfg-settings-action'),save=nodes(bar).find(node=>node.type==='button'&&text(node)==='保存设置');
    assert.ok(save);assert.equal(save.props.disabled,false);await save.props.onClick();await page.flush();
    assert.equal(page.configWrites().length,1);assert.equal(page.stored().memory.enabled,false);assert.deepEqual(page.stored().role,page.initial.role);
    await page.go('模式与角色');await page.go('记忆');assert.equal(page.byAria('启用陪伴记忆').props['aria-checked'],false);
  }finally{page.dispose();}
});
