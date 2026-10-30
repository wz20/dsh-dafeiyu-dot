import {createGraphDynamics} from './memory-graph-dynamics.js';
import {buildMemoryGraph, connectedNodeIds, filterMemoryGraph} from './memory-graph.js';

const COLORS = {owner:'#65d5dc', self:'#bba0f2', shared:'#edc777'};
const GROUPS = {owner:'主人', self:'鲸鱼娘', shared:'共同主题'};
const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';

export function createMemoryExplorer(React, {Icon, Button, assetRoot}) {
  const h = React.createElement;
  const {useState, useRef, useEffect, useMemo} = React;

  function Graph({graph, selectedId, onSelect, query, searching, motion = true, reducedMotion = false}) {
    const host=useRef(null),canvas=useRef(null),world=useRef(null),buttons=useRef(new Map()),gesture=useRef(null),engine=useRef(null),wake=useRef(()=>{}),blockedClick=useRef(0),spacePressed=useRef(false);
    const [size,setSize]=useState({width:1000,height:720}),[camera,setCamera]=useState({zoom:1,x:0,y:0}),[hovered,setHovered]=useState(''),[draggingId,setDraggingId]=useState('');
    const frameCamera=useRef({zoom:1,x:0,y:0}),goalCamera=useRef({zoom:1,x:0,y:0}),drawing=useRef(null);
    const base=Math.max(.65,Math.min(size.width/1100,Math.max(1,size.height-75)/760));
    const offset={x:(size.width-1100*base)/2,y:(size.height-75-760*base)/2};
    const focus=graph.nodes.some(node=>node.id===(draggingId||hovered||selectedId))?(draggingId||hovered||selectedId):'';
    const neighbors=useMemo(()=>focus?connectedNodeIds(graph,focus):null,[graph,focus]);
    function commitCamera(value,immediate=false){
      const next=typeof value==='function'?value(goalCamera.current):value;
      goalCamera.current=next;if(immediate||!motion)frameCamera.current={...next};setCamera(next);wake.current();
    }
    function zoomAt(factor,x=size.width/2,y=(size.height-75)/2){
      commitCamera(current=>{const zoom=Math.max(.4,Math.min(3.5,current.zoom*factor)),ratio=zoom/current.zoom;return {zoom,x:x-offset.x-(x-offset.x-current.x)*ratio,y:y-offset.y-(y-offset.y-current.y)*ratio};});
    }
    function resetView(){engine.current?.reset();commitCamera({zoom:1,x:0,y:0});}
    function currentGeometry(){const current=frameCamera.current;return {scale:base*current.zoom,x:offset.x+current.x,y:offset.y+current.y};}
    useEffect(()=>{
      const element=host.current;if(!element)return;
      const update=()=>{const box=element.getBoundingClientRect();setSize({width:Math.max(1,box.width),height:Math.max(1,box.height)});};update();
      const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();
    },[]);
    useEffect(()=>{
      const previous=engine.current,next=createGraphDynamics(graph,{reducedMotion});next.setMotion(motion);
      for(const node of next.nodes.values()){
        const old=previous?.nodes.get(node.id);
        if(old){node.x=old.x;node.y=old.y;node.anchorX=old.anchorX;node.anchorY=old.anchorY;}
        else if(!motion){node.x=node.anchorX;node.y=node.anchorY;}
      }
      previous?.dispose();engine.current=next;gesture.current=null;setDraggingId('');wake.current();
      return()=>next.dispose();
    },[graph,reducedMotion]);
    useEffect(()=>{engine.current?.setMotion(motion);wake.current();},[motion]);
    useEffect(()=>{commitCamera({zoom:1,x:0,y:0});},[query]);
    drawing.current={graph,focus,motion,base,offset,size};
    useEffect(()=>{
      const surface=canvas.current;if(!surface)return;
      const context=surface.getContext('2d');if(!context)return;
      const ratio=Math.min(window.devicePixelRatio||1,2);
      surface.width=Math.round(size.width*ratio);surface.height=Math.round(size.height*ratio);
      let raf=0,last=0,closed=false;const alphas=new Map();
      const schedule=()=>{if(!closed&&!raf&&!document.hidden)raf=requestAnimationFrame(draw);};wake.current=schedule;
      function draw(now){
        raf=0;if(closed||document.hidden)return;
        const dt=last?Math.min((now-last)/1000,.05):1/60;last=now;
        const scene=drawing.current,dynamics=engine.current;if(!dynamics)return;
        const moving=dynamics.step(dt,now/1000),current=frameCamera.current,target=goalCamera.current;
        const ease=scene.motion?1-Math.exp(-dt*17):1;
        let cameraMoving=false;
        for(const key of ['x','y','zoom']){const difference=target[key]-current[key];if(Math.abs(difference)>.0005){current[key]+=difference*ease;cameraMoving=true;}else current[key]=target[key];}
        const scale=scene.base*current.zoom,origin={x:scene.offset.x+current.x,y:scene.offset.y+current.y};
        if(world.current)world.current.style.transform=`translate(${origin.x}px, ${origin.y}px) scale(${scale})`;
        for(const node of dynamics.nodes.values()){
          const button=buttons.current.get(node.id);if(!button)continue;
          button.style.left=node.x+'px';button.style.top=node.y+'px';
          button.style.width=Math.max((node.r||8)*2,28/scale)+'px';button.style.height=Math.max((node.r||8)*2,28/scale)+'px';
        }
        context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,scene.size.width,scene.size.height);
        context.translate(origin.x,origin.y);context.scale(scale,scale);
        let fading=false,particleBudget=70,index=0;
        for(const edge of scene.graph.edges){
          const a=dynamics.nodes.get(edge.source),b=dynamics.nodes.get(edge.target);if(!a||!b)continue;
          const active=!scene.focus||edge.source===scene.focus||edge.target===scene.focus;
          const targetAlpha=active?(scene.focus ? .8 : .34):.12;
          const previous=alphas.get(edge.id)??targetAlpha,alpha=previous+(targetAlpha-previous)*(scene.motion?Math.min(1,dt*10):1);alphas.set(edge.id,alpha);if(Math.abs(alpha-targetAlpha)>.003)fading=true;
          const dx=b.x-a.x,dy=b.y-a.y,length=Math.max(1,Math.hypot(dx,dy)),bend=Math.min(18,length*.045)*(index%2?1:-1),cx=(a.x+b.x)/2-dy/length*bend,cy=(a.y+b.y)/2+dx/length*bend;
          context.beginPath();context.moveTo(a.x,a.y);context.quadraticCurveTo(cx,cy,b.x,b.y);context.strokeStyle=COLORS[a.group]||COLORS.owner;context.globalAlpha=alpha;context.lineWidth=active&&scene.focus?1.65:1;context.shadowColor=context.strokeStyle;context.shadowBlur=active&&scene.focus?7:0;context.stroke();context.shadowBlur=0;
          if(scene.motion&&active&&particleBudget>0&&(scene.focus||index%3===0)){
            const t=(now*.000115+index*.173)%1,s=1-t,x=s*s*a.x+2*s*t*cx+t*t*b.x,y=s*s*a.y+2*s*t*cy+t*t*b.y;
            context.beginPath();context.arc(x,y,scene.focus?2.2:1.5,0,Math.PI*2);context.fillStyle=COLORS[a.group]||COLORS.owner;context.globalAlpha=scene.focus ? .9 : .55;context.shadowColor=context.fillStyle;context.shadowBlur=9;context.fill();context.shadowBlur=0;particleBudget--;
          }
          index++;
        }
        context.globalAlpha=1;
        if(scene.motion||moving||cameraMoving||fading||gesture.current)schedule();
      }
      const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;last=0;}else schedule();};document.addEventListener('visibilitychange',visibility);schedule();
      return()=>{closed=true;cancelAnimationFrame(raf);document.removeEventListener('visibilitychange',visibility);if(wake.current===schedule)wake.current=()=>{};};
    },[size.width,size.height,graph,reducedMotion]);
    useEffect(()=>{wake.current();},[focus,camera,motion]);
    useEffect(()=>{
      const element=host.current;if(!element)return;
      const wheel=event=>{
        event.preventDefault();event.stopPropagation();
        const pixels=event.deltaMode===1?16:event.deltaMode===2?size.height:1;
        if(event.ctrlKey||event.metaKey){const box=element.getBoundingClientRect();zoomAt(Math.exp(-event.deltaY*.006),event.clientX-box.left,event.clientY-box.top);}
        else commitCamera(current=>({...current,x:current.x-(event.shiftKey?event.deltaY:event.deltaX)*pixels,y:current.y-(event.shiftKey?0:event.deltaY)*pixels}),true);
      };
      element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
    },[size.width,size.height,motion]);
    function pointerDown(event){
      if(gesture.current||event.button!==0)return;
      const nodeButton=event.target.closest('[data-node-id]');if(event.target.closest('button')&&!nodeButton)return;
      const nodeId=spacePressed.current?'':nodeButton?.dataset.nodeId||'',node=engine.current?.nodes.get(nodeId),geometry=currentGeometry();
      event.preventDefault();event.stopPropagation();
      gesture.current={id:event.pointerId,nodeId:node?.id||'',nodeStart:node?{x:node.x,y:node.y}:null,x:event.clientX,y:event.clientY,camera:{...frameCamera.current},scale:geometry.scale,moved:false};
      if(node){engine.current.beginDrag(node.id);setDraggingId(node.id);nodeButton.focus({preventScroll:true});}else host.current?.focus({preventScroll:true});
      try{event.currentTarget.setPointerCapture(event.pointerId);}catch{ /* Document fallback owns the same pointer if capture is interrupted. */ }
      event.currentTarget.dataset.dragging='true';wake.current();
    }
    function pointerMove(event){
      const drag=gesture.current;if(!drag||drag.id!==event.pointerId)return;
      event.preventDefault();const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(dx,dy)>4)drag.moved=true;
      if(drag.nodeId){engine.current?.dragTo(drag.nodeId,drag.nodeStart.x+dx/drag.scale,drag.nodeStart.y+dy/drag.scale);wake.current();}
      else commitCamera({...drag.camera,x:drag.camera.x+dx,y:drag.camera.y+dy},true);
    }
    function finishPointer(event,cancelled=false){
      const drag=gesture.current;if(!drag||drag.id!==event.pointerId)return;
      if(drag.nodeId)engine.current?.endDrag(drag.nodeId);gesture.current=null;setDraggingId('');if(host.current)host.current.dataset.dragging='false';
      if(drag.moved)blockedClick.current=performance.now()+350;else if(!cancelled)onSelect(drag.nodeId);
      if(host.current?.hasPointerCapture?.(drag.id))host.current.releasePointerCapture(drag.id);wake.current();
    }
    useEffect(()=>{
      const move=event=>{if(gesture.current&&!host.current?.contains(event.target))pointerMove(event);},up=event=>finishPointer(event),cancel=event=>finishPointer(event,true),blur=()=>{if(gesture.current)finishPointer({pointerId:gesture.current.id},true);spacePressed.current=false;};
      document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);window.addEventListener('blur',blur);
      return()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',blur);};
    },[graph]);
    function focusNode(node){
      const item=engine.current?.nodes.get(node.id)||node,g=currentGeometry(),x=g.x+item.x*g.scale,y=g.y+item.y*g.scale;
      if(x<35||x>size.width-35||y<35||y>size.height-85)commitCamera(current=>({...current,x:size.width/2-item.x*g.scale-offset.x,y:(size.height-75)/2-item.y*g.scale-offset.y}));
    }
    const geometry=currentGeometry();
    return h('div',{className:'dfg-map',ref:host,tabIndex:0,role:'region','data-motion':motion?'active':'paused','aria-label':'记忆关系图：拖动画布平移，拖动节点调整位置，滚动平移，Ctrl或Command加滚轮缩放',onPointerDownCapture:pointerDown,onPointerMove:pointerMove,onPointerUp:event=>finishPointer(event),onPointerCancel:event=>finishPointer(event,true),onLostPointerCapture:event=>finishPointer(event,true),onDragStart:event=>event.preventDefault(),onKeyUp:event=>{if(event.code==='Space')spacePressed.current=false;},onKeyDown:event=>{
      if(event.code==='Space'){event.preventDefault();spacePressed.current=true;return;}if(event.target!==event.currentTarget)return;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();commitCamera(current=>({...current,x:current.x+(event.key==='ArrowLeft'?50:event.key==='ArrowRight'?-50:0),y:current.y+(event.key==='ArrowUp'?50:event.key==='ArrowDown'?-50:0)}));}
      if(event.key==='+'||event.key==='='){event.preventDefault();zoomAt(1.2);}if(event.key==='-'){event.preventDefault();zoomAt(1/1.2);}if(event.key==='0')resetView();
    }},h('canvas',{ref:canvas,'aria-hidden':true}),
      h('div',{className:'dfg-world',ref:world,style:{transform:`translate(${geometry.x}px, ${geometry.y}px) scale(${geometry.scale})`}},...graph.nodes.map((node,index)=>{
        const live=engine.current?.nodes.get(node.id)||node,selected=selectedId===node.id,dim=neighbors&&!neighbors.has(node.id)&&node.id!==focus,labelVisible=node.kind!=='memory'||graph.nodes.length<45||selected||hovered===node.id;
        const topicIcon=/语音|声音|音色/.test(node.label)?'microphone':/交流|称呼|对话/.test(node.label)?'message-circle':/喜好|偏好|相伴|故事|回忆/.test(node.label)?'heart':/项目|工作|开发|索引/.test(node.label)?'code':'book';
        return h('button',{type:'button',key:node.id,ref:element=>{if(element)buttons.current.set(node.id,element);else buttons.current.delete(node.id);},className:'dfg-node dfg-node-'+node.kind+(selected?' is-selected':'')+(dim?' is-dimmed':'')+(draggingId===node.id?' is-dragging':''),'data-node-id':node.id,'data-group':node.group,draggable:false,'aria-pressed':selected,tabIndex:selectedId?(selected?0:-1):(index===0?0:-1),'aria-label':(node.kind==='memory'?'记忆：':node.kind==='person'?'人物：':'主题：')+(node.fullLabel||node.label),title:(node.fullLabel||node.label)+' · 拖动调整位置',style:{left:live.x,top:live.y,width:Math.max((node.r||8)*2,28/geometry.scale),height:Math.max((node.r||8)*2,28/geometry.scale),'--node-color':COLORS[node.group]||COLORS.owner,'--node-size':(node.r||8)*2+'px','--node-delay':Math.min(index*.028,.4)+'s'},onClick:event=>{if(event.detail===0||performance.now()>blockedClick.current)onSelect(node.id);},onDoubleClick:event=>{event.preventDefault();onSelect(node.id);const item=engine.current?.nodes.get(node.id)||node;commitCamera({zoom:1.3,x:size.width/2-item.x*base*1.3-offset.x,y:(size.height-75)/2-item.y*base*1.3-offset.y});},onPointerEnter:()=>setHovered(node.id),onPointerLeave:()=>setHovered(''),onFocus:()=>{setHovered(node.id);if(!gesture.current)focusNode(node);},onBlur:()=>setHovered(''),onKeyDown:event=>{
          if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();const direction=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1,nextIndex=(index+direction+graph.nodes.length)%graph.nodes.length,next=graph.nodes[nextIndex];onSelect(next.id);requestAnimationFrame(()=>buttons.current.get(next.id)?.focus({preventScroll:true}));
        }},h('span',{className:'dfg-node-core'},node.kind==='person'&&node.group==='self'?h('img',{src:assetRoot+'portrait.png',alt:'',draggable:false}):h(Icon,{name:node.kind==='memory'?'file-text':node.kind==='person'?'user':topicIcon,size:node.kind==='person'?30:node.kind==='memory'?14:21})),labelVisible&&h('span',{className:'dfg-node-label'},node.label),node.kind!=='memory'&&h('small',{className:'dfg-node-count'},(node.memberIds?.length??node.count??0)+' 条记忆'));
      })),
      h('div',{className:'dfg-map-caption','aria-hidden':true},'拖动画布或节点 · 滚动平移 · Ctrl / ⌘ + 滚轮缩放'),
      h('div',{className:'dfg-camera','aria-label':'关系图视角'},h(Button,{icon:'minus',variant:'quiet','aria-label':'缩小关系图',disabled:camera.zoom<=.4,onClick:()=>zoomAt(1/1.2)}),h('output',{'aria-label':'缩放比例'},Math.round(camera.zoom*100)+'%'),h(Button,{icon:'plus',variant:'quiet','aria-label':'放大关系图',disabled:camera.zoom>=3.5,onClick:()=>zoomAt(1.2)}),h(Button,{icon:'arrows-maximize',variant:'quiet','aria-label':'回到全图',onClick:resetView})),
      !graph.nodes.length&&h('div',{className:'dfg-map-empty'},h(Icon,{name:'sparkles',size:32}),h('h2',null,searching?'正在寻找这段记忆…':query?'还没找到这段记忆':'记忆，从相伴开始'),h('p',null,searching?'正在检索完整正文。':query?'试试人物、主题或记忆里的关键词。':'每一条记住的事，都会在这里连成星图。')));
  }

  return function MemoryExplorer(props) {
    const {records=[],spaces=[],palace,busy,onClose,onSettings,onRead,onSearch,onNew,onEdit,onSave,onForget,renderDetails,management,editor,summary}=props;
    const [query,setQuery]=useState(''),[view,setView]=useState('graph'),[selectedId,setSelectedId]=useState(''),[panel,setPanel]=useState(''),[full,setFull]=useState(null),[readError,setReadError]=useState(''),[reading,setReading]=useState(false),[readAttempt,setReadAttempt]=useState(0),[confirm,setConfirm]=useState(''),[actionError,setActionError]=useState(''),[actionBusy,setActionBusy]=useState(false);
    const [motionEnabled,setMotionEnabled]=useState(()=>{try{return typeof window==='undefined'||window.localStorage?.getItem('dsh-dafeiyu-dot:memory-motion:v1')!=='paused';}catch{return true;}});
    const [systemReduced,setSystemReduced]=useState(()=>typeof window!=='undefined'&&!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),[pageVisible,setPageVisible]=useState(()=>typeof document==='undefined'||!document.hidden);
    const animated=motionEnabled&&!systemReduced&&pageVisible;
    useEffect(()=>{
      props.onPanelChange?.(!!panel);
      return()=>props.onPanelChange?.(false);
    },[panel,props.onPanelChange]);
    useEffect(()=>{
      if(typeof window==='undefined'||typeof document==='undefined')return;
      const media=window.matchMedia?.('(prefers-reduced-motion: reduce)'),change=()=>setSystemReduced(!!media?.matches),visibility=()=>setPageVisible(!document.hidden);
      media?.addEventListener?.('change',change);document.addEventListener('visibilitychange',visibility);
      return()=>{media?.removeEventListener?.('change',change);document.removeEventListener('visibilitychange',visibility);};
    },[]);
    function toggleMotion(){const next=!motionEnabled;setMotionEnabled(next);try{window.localStorage?.setItem('dsh-dafeiyu-dot:memory-motion:v1',next?'active':'paused');}catch{ /* The current page still uses the requested motion state. */ }}
    const [searchResult,setSearchResult]=useState(null),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
    const graph=useMemo(()=>buildMemoryGraph(records,{spaces}),[records,spaces]);
    const visible=useMemo(()=>filterMemoryGraph(graph,query,searchResult?.query===query?{recordIds:searchResult.ids}:undefined),[graph,query,searchResult]);
    useEffect(()=>{
      setSearchResult(null);setSearchError('');
      if(!query.trim()||!onSearch){setSearching(false);return;}
      const controller=new AbortController();setSearching(true);
      const timer=setTimeout(()=>onSearch(query,controller.signal).then(ids=>{if(!controller.signal.aborted)setSearchResult({query,ids});}).catch(error=>{if(!controller.signal.aborted)setSearchError(error.message||'全文搜索暂不可用。');}).finally(()=>{if(!controller.signal.aborted)setSearching(false);}),180);
      return()=>{controller.abort();clearTimeout(timer);};
    },[query,records]);
    const selected=visible.nodes.find(node=>node.id===selectedId), record=records.find(item=>item.id===selected?.recordId);
    const initialized=useRef(false), readGeneration=useRef(0), currentRecordId=useRef(''), sheetTrigger=useRef(null);currentRecordId.current=record?.id||'';
    function showPanel(value){sheetTrigger.current=document.activeElement;setPanel(value);}
    function closePanel(){setPanel('');requestAnimationFrame(()=>sheetTrigger.current?.isConnected&&sheetTrigger.current.focus({preventScroll:true}));}
    const linkedIds=useMemo(()=>selected?connectedNodeIds(visible,selected.id):new Set(),[visible,selected]);
    const linked=visible.nodes.filter(node=>node.id!==selectedId&&linkedIds.has(node.id));
    useEffect(()=>{if(!initialized.current&&graph.nodes.length){initialized.current=true;setSelectedId(graph.nodes.find(node=>node.kind==='memory')?.id||graph.nodes[0].id);}},[graph]);
    useEffect(()=>{if(selectedId&&!visible.nodes.some(node=>node.id===selectedId))setSelectedId(visible.nodes.find(node=>node.kind==='memory')?.id||'');},[visible,selectedId]);
    useEffect(()=>{
      setFull(null);setReadError('');setConfirm('');const generation=++readGeneration.current;
      if(!record){setReading(false);return;}
      const controller=new AbortController();setReading(true);
      onRead(record.id,controller.signal).then(memory=>{if(!controller.signal.aborted&&generation===readGeneration.current)setFull(memory);}).catch(error=>{if(!controller.signal.aborted)setReadError(error.message||'暂时无法读取完整记忆。');}).finally(()=>{if(!controller.signal.aborted)setReading(false);});
      return()=>controller.abort();
    },[record?.id,record?.updatedAt,readAttempt]);
    function choose(id){setSelectedId(id);setConfirm('');setActionError('');}
    async function edit(){if(!record||actionBusy)return;const id=record.id;setActionBusy(true);setActionError('');try{if(await onEdit(id)&&currentRecordId.current===id)showPanel('editor');}catch(error){if(currentRecordId.current===id)setActionError(error.message);}finally{setActionBusy(false);}}
    async function forget(){if(!record||confirm!==record.id||actionBusy)return;setActionBusy(true);setActionError('');try{if(await onForget(record.id)){setConfirm('');setSelectedId('');}}catch(error){setActionError(error.message);}finally{setActionBusy(false);}}
    const body=full?.id===record?.id?full:record;
    const matchRecords=visible.nodes.filter(node=>node.kind==='memory');
    return h('section',{className:'dfg-explorer','aria-label':'记忆宫殿','data-motion':animated?'active':'paused'},
      h('header',{className:'dfg-header',inert:panel?'':undefined,'aria-hidden':panel?true:undefined},h(Button,{icon:'arrow-left',variant:'quiet','aria-label':'返回工作区',className:'dfg-back',onClick:onClose},h('span',null,'返回工作区')),
        h('div',{className:'dfg-brand'},h('img',{src:assetRoot+'icon.png',alt:'',width:36,height:36}),h('div',null,h('h1',null,'记忆宫殿'),h('p',null,'在相连的记忆里，找到彼此'))),
        h('label',{className:'dfg-search'},h(Icon,{name:'search',size:18}),h('input',{value:query,'aria-label':'搜索记忆关系网',placeholder:'搜索记忆、人物、主题…',maxLength:1000,onChange:event=>setQuery(event.target.value)}),query&&h(Button,{icon:'x',variant:'quiet','aria-label':'清空记忆搜索',onClick:()=>setQuery('')})),
        h('div',{className:'dfg-view-switch',role:'group','aria-label':'记忆展示方式'},h(Button,{icon:'network',className:view==='graph'?'is-active':'','aria-pressed':view==='graph',onClick:()=>setView('graph')},'关系图'),h(Button,{icon:'list',className:view==='list'?'is-active':'','aria-pressed':view==='list',onClick:()=>setView('list')},'列表')),
        h(Button,{icon:'plus',variant:'primary',className:'dfg-add',disabled:busy||!spaces.length,onClick:()=>{onNew();showPanel('editor');}},h('span',null,'记下一件事'))),
      h('div',{className:'dfg-main',inert:panel?'':undefined,'aria-hidden':panel?true:undefined},
        view==='graph'?h(Graph,{graph:visible,selectedId,onSelect:choose,query,searching,motion:animated,reducedMotion:systemReduced}):h('div',{className:'dfg-list',role:'region','aria-label':'记忆列表'},h('div',{className:'dfg-list-heading'},h('h2',null,query?'搜索结果':'记住的点滴'),h('span',null,matchRecords.length+' 条记忆')),matchRecords.length?matchRecords.map(node=>{const item=records.find(record=>record.id===node.recordId);return h('button',{type:'button',className:'dfg-list-row'+(selectedId===node.id?' is-selected':''),key:node.id,onClick:()=>choose(node.id)},h('i',{'data-group':node.group}),h('div',null,h('strong',null,node.label),h('p',null,item?.content||''),h('small',null,GROUPS[node.group]+' · '+date(item?.updatedAt))));}):h('p',{className:'dfg-empty'},searching?'正在检索完整记忆…':query?'没有匹配的记忆。':'相处的点滴，会慢慢留在这里。')),
        h('aside',{className:'dfg-detail','data-selected':!!selected,'aria-label':'记忆详情'},
          selected?h(React.Fragment,null,h('div',{className:'dfg-detail-top'},h(Button,{icon:'arrow-left',variant:'quiet',onClick:()=>choose('')},'返回全图'),h('small',null,selected.kind==='memory'?'一段记忆':selected.kind==='person'?'人物':'主题')),
            h('div',{className:'dfg-detail-title',key:'title:'+selected.id},h('span',{className:'dfg-detail-kind','data-group':selected.group},h('i'),GROUPS[selected.group]+(body?.predicate?' / '+body.predicate:'')),h('h2',null,selected.label),record&&h('time',{dateTime:record.updatedAt},date(record.updatedAt))),
            h('div',{className:'dfg-detail-scroll',key:'body:'+selected.id},record?h(React.Fragment,null,h('p',{className:'dfg-memory-body'},body?.content||body?.text||''),reading&&h('p',{className:'dfg-subtle',role:'status'},'正在读取完整记忆…'),readError&&h('div',{className:'dfg-inline-error',role:'alert'},readError,h(Button,{variant:'quiet',onClick:()=>setReadAttempt(value=>value+1)},'重试')),
              !reading&&!readError&&full?.id===record?.id&&h('div',{className:'dfg-provenance'},renderDetails(full))):h('p',{className:'dfg-group-note'},'沿着关联，看看这里记住了哪些事。'),
              h('section',{className:'dfg-related'},h('h3',null,'相连的记忆'),linked.length?linked.slice(0,40).map(node=>h('button',{type:'button',key:node.id,className:'dfg-related-row',onClick:()=>choose(node.id)},h('span',{className:'dfg-related-icon','data-group':node.group},h(Icon,{name:node.kind==='memory'?'file-text':node.kind==='person'?'user':'book',size:18})),h('span',null,h('strong',null,node.label),h('small',null,node.kind==='memory'?'查看记忆':(node.memberIds?.length??0)+' 条记忆')),h(Icon,{name:'chevron-down',size:14}))):h('p',{className:'dfg-subtle'},'更多关联，会随着相伴慢慢出现。'))),
            record&&h('div',{className:'dfg-detail-actions'},confirm===record.id?h('div',{className:'dfg-forget',role:'group','aria-label':'确认忘记这条记忆'},h('strong',null,'忘记这条记忆及其旧版本？'),h('p',null,'确认后将退出检索和后续使用，此操作无法在页面恢复。'),h('div',null,h(Button,{disabled:actionBusy,onClick:()=>setConfirm('')},'保留'),h(Button,{disabled:actionBusy||busy,className:'dfg-danger',onClick:forget},actionBusy?'正在忘记…':'确认忘记'))):h(React.Fragment,null,h(Button,{icon:'edit',disabled:busy||actionBusy,onClick:edit},actionBusy?'正在读取…':'编辑'),h(Button,{icon:'trash',className:'dfg-danger',disabled:busy||actionBusy,onClick:()=>setConfirm(record.id)},'忘记'))),actionError&&h('p',{className:'dfg-inline-error',role:'alert'},actionError)):
          h('div',{className:'dfg-welcome'},h('img',{src:assetRoot+'portrait.png',alt:'鲸鱼娘'}),h('h2',null,'每一段相伴，都有迹可循'),h('p',null,'点亮一个节点，看看人与事如何相连。'),h('p',{className:'dfg-subtle'},'关系来自记忆中已有的人物、主题与项目。')))),
      h('footer',{className:'dfg-footer',inert:panel?'':undefined,'aria-hidden':panel?true:undefined},h('div',{className:'dfg-legend'},...Object.entries(GROUPS).map(([key,label])=>h('span',{key},h('i',{'data-group':key}),label))),h('div',{className:'dfg-status',role:searchError?'alert':'status'},h('i',{'data-tone':summary?.tone}),h('span',null,searchError?'全文搜索暂不可用，当前仅按摘要筛选':searching?'正在检索完整记忆…':busy?'正在读取记忆…':summary?.text||'记忆已就绪'),h('span',null,(palace?.memoryCount??records.length)+' 条记忆'),query&&!searching&&h('span',null,matchRecords.length+' 条匹配')),h(Button,{icon:animated?'player-pause':'player-play',variant:'quiet',className:'dfg-motion-toggle','aria-label':motionEnabled?'暂停记忆动效':'开启记忆动效','aria-pressed':!motionEnabled,disabled:systemReduced,title:systemReduced?'系统已开启减少动态效果':'节点与连线动效',onClick:toggleMotion},h('span',null,motionEnabled?'暂停动效':'开启动效')),props.settingsAction&&h('div',{className:'dfg-settings-action'},props.settingsAction),h(Button,{icon:'settings',variant:'quiet','aria-label':'打开记忆管理',onClick:()=>showPanel('manage')})),
      panel&&h('div',{className:'dfg-sheet-backdrop',onClick:event=>{if(event.target===event.currentTarget)closePanel();}},h('section',{className:'dfg-sheet',role:'dialog','aria-modal':true,'aria-label':panel==='manage'?'记忆管理':props.memoryId?'编辑记忆':'留下一条记忆',onKeyDown:event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePanel();}
        if(event.key==='Tab'){const elements=[...event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')];const first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
      }},h('header',{className:'dfg-sheet-header'},h('div',null,h('span',null,'记忆宫殿'),h('h2',null,panel==='manage'?'记忆管理':props.memoryId?'编辑记忆':'留下一条记忆')),h(Button,{icon:'x',variant:'quiet',autoFocus:true,'aria-label':'关闭记忆面板',onClick:closePanel})),
        h('div',{className:'dfg-sheet-body'},panel==='manage'?management:editor),
        panel==='manage'?h('footer',{className:'dfg-sheet-footer'},h(Button,{variant:'quiet',onClick:onSettings},'前往配置中心')):h('footer',{className:'dfg-sheet-footer'},h(Button,{onClick:closePanel},'稍后再写'),h(Button,{icon:'check',variant:'primary',disabled:!props.canSave||busy,onClick:async()=>{if(await onSave())closePanel();}},busy?'正在保存…':'保存记忆')))));
  };
}
