import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryExplorer} from '../assets/memory-explorer.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

// Run the explorer's hooks and effects; child components remain elements with inspectable props.
function hookRunner(){
  const cells=[];let cursor=0,pending=[],dirty=false,mounted=true;
  const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((value,index)=>!Object.is(value,b[index]));
  const hooks={
    useState(initial){
      const index=cursor++;if(!cells[index])cells[index]={value:typeof initial==='function'?initial():initial};
      return [cells[index].value,next=>{if(!mounted)return;const value=typeof next==='function'?next(cells[index].value):next;if(!Object.is(value,cells[index].value)){cells[index].value=value;dirty=true;}}];
    },
    useRef(initial){const index=cursor++;if(!cells[index])cells[index]={current:initial};return cells[index];},
    useMemo(factory,deps){const index=cursor++;if(!cells[index]||changed(cells[index].deps,deps))cells[index]={value:factory(),deps};return cells[index].value;},
    useEffect(effect,deps){const index=cursor++;if(!cells[index]||changed(cells[index].deps,deps))pending.push(()=>{cells[index]?.cleanup?.();cells[index]={deps};cells[index].cleanup=effect();});},
  };
  return {
    hooks,
    render(component,props){
      let tree,passes=0;
      do{assert.ok(++passes<30,'effects should settle without a render loop');cursor=0;pending=[];dirty=false;tree=component(props);const effects=pending;pending=[];effects.forEach(effect=>effect());}while(dirty);
      return tree;
    },
    dispose(){mounted=false;cells.forEach(cell=>cell?.cleanup?.());},
  };
}
function nodes(tree,result=[]){
  if(Array.isArray(tree)){tree.forEach(child=>nodes(child,result));return result;}
  if(!tree||typeof tree!=='object')return result;
  result.push(tree);nodes(tree.props?.children,result);return result;
}
function text(tree){if(Array.isArray(tree))return tree.map(text).join('');if(tree&&typeof tree==='object')return text(tree.props?.children);return tree==null||tree===false?'':String(tree);}
const record=(id,label)=>({id,spaceId:'owner',status:'active',subject:'主人',predicate:label,tags:['相伴'],content:label+'的摘要',updatedAt:'2026-10-29T10:00:00Z'});
const inventory=[record('a','记忆 A'),record('b','记忆 B')];
const complete=id=>({...inventory.find(item=>item.id===id),content:id==='a'?'A 独有的完整正文':'B 独有的完整正文'});

function explorerHarness(overrides={}){
  const runner=hookRunner();
  function Button(){}function Icon(){}
  const React={...runner.hooks,Fragment:Symbol('Fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}})};
  const Explorer=createMemoryExplorer(React,{Button,Icon,assetRoot:'/assets/'});
  const props={records:inventory,spaces:[{id:'owner',name:'我眼里的主人'}],busy:false,onClose(){},onSettings(){},onNew(){},onEdit:async()=>true,onSave:async()=>true,onForget:async()=>true,onRead:async id=>complete(id),renderDetails:memory=>React.createElement('span',{'data-provenance-id':memory.id},'来源 '+memory.id),management:'管理内容',editor:'可编辑的记忆内容',...overrides};
  let tree;
  const render=()=>tree=runner.render(Explorer,props);
  const all=()=>nodes(tree);
  const button=label=>{const found=all().find(item=>item.type===Button&&text(item)===label);assert.ok(found,'expected button: '+label);return found;};
  const select=id=>{const graph=all().find(item=>typeof item.type==='function'&&item.props.graph&&typeof item.props.onSelect==='function');assert.ok(graph,'graph should expose node selection');graph.props.onSelect('memory:'+id);return render();};
  const body=()=>text(all().find(item=>item.props.className==='dfg-memory-body'));
  const heading=()=>{const title=all().find(item=>item.props.className==='dfg-detail-title');return text(nodes(title).find(item=>item.type==='h2'));};
  render();
  return {render,all,button,select,body,heading,dispose:()=>runner.dispose()};
}

test('a late detail response cannot replace the selected memory after its read is cancelled',async()=>{
  const reads=[];
  const page=explorerHarness({onRead:(id,signal)=>{const pending=deferred();reads.push({id,signal,...pending});return pending.promise;}});
  try{
    assert.equal(reads.length,1);assert.equal(reads[0].id,'a');
    page.select('b');assert.equal(reads.length,2);assert.equal(reads[0].signal.aborted,true);assert.equal(reads[1].signal.aborted,false);
    assert.equal(page.heading(),'记忆 B');assert.equal(page.body(),'记忆 B的摘要');
    reads[1].resolve(complete('b'));await settle();page.render();assert.equal(page.body(),'B 独有的完整正文');
    // The transport deliberately ignores cancellation, so the component must reject the stale result.
    reads[0].resolve(complete('a'));await settle();page.render();
    assert.equal(page.heading(),'记忆 B');assert.equal(page.body(),'B 独有的完整正文');
    assert.ok(page.all().some(item=>item.props['data-provenance-id']==='b'));
    assert.equal(page.all().some(item=>item.props['data-provenance-id']==='a'),false);
  }finally{page.dispose();}
  assert.equal(reads[1].signal.aborted,true,'unmount should release the selected detail request');
});

test('retry creates a cancellable detail read and a late retry cannot clear the next memory loading state',async()=>{
  const reads=[];
  const page=explorerHarness({onRead:(id,signal)=>{const pending=deferred();reads.push({id,signal,...pending});return pending.promise;}});
  try{
    reads[0].reject(new Error('暂时无法读取'));await settle();page.render();
    page.button('重试').props.onClick();page.render();assert.equal(reads.length,2);assert.equal(reads[1].id,'a');
    assert.ok(reads[1].signal instanceof AbortSignal,'retry must use the same cancellation contract as an initial read');
    assert.equal(reads[0].signal.aborted,true);
    page.select('b');assert.equal(reads.length,3);assert.equal(reads[1].signal.aborted,true);
    reads[1].resolve(complete('a'));await settle();page.render();
    assert.equal(page.heading(),'记忆 B');assert.equal(page.body(),'记忆 B的摘要');
    assert.ok(page.all().some(item=>item.props.role==='status'&&text(item)==='正在读取完整记忆…'),'stale retry must not finish B loading');
    reads[2].resolve(complete('b'));await settle();page.render();
    assert.equal(page.body(),'B 独有的完整正文');
    assert.equal(page.all().some(item=>item.props.role==='status'&&text(item)==='正在读取完整记忆…'),false);
  }finally{page.dispose();}
});

test('an edit completing after node selection changes cannot open the former memory editor',async()=>{
  const previousDocument=globalThis.document,edits=[];
  globalThis.document={activeElement:{isConnected:true,focus(){}}};
  const page=explorerHarness({onEdit:id=>{const pending=deferred();edits.push({id,...pending});return pending.promise;}});
  try{
    await settle();page.render();
    const editA=page.button('编辑').props.onClick();page.render();assert.equal(edits[0].id,'a');
    page.select('b');edits[0].resolve(complete('a'));await editA;await settle();page.render();
    assert.equal(page.heading(),'记忆 B');assert.equal(page.all().some(item=>item.props.role==='dialog'),false);
    // Positive control: editing the current node still opens its editor.
    const editB=page.button('编辑').props.onClick();page.render();assert.equal(edits[1].id,'b');
    edits[1].resolve(complete('b'));await editB;page.render();
    assert.ok(page.all().some(item=>item.props.role==='dialog'));
    assert.ok(page.all().some(item=>item.props.className==='dfg-sheet-body'&&text(item)==='可编辑的记忆内容'));
  }finally{page.dispose();if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});
