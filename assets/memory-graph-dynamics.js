/** Deterministic animation of an existing graph. Coordinates remain in graph/world units. */
const POSITION_LIMIT=1_000_000;
const SPRING=160,DAMPING=26,POSITION_EPSILON=.018,VELOCITY_EPSILON=.035;
const clamp=value=>Math.max(-POSITION_LIMIT,Math.min(POSITION_LIMIT,value));
const coordinate=value=>typeof value==='number'&&Number.isFinite(value)?clamp(value):0;
function phase(id){let hash=2166136261;for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),16777619);return (hash>>>0)/4294967296*Math.PI*2;}

/**
 * step(dtSeconds,timeSeconds) mutates nodes and returns whether another frame is useful.
 * This module owns no timer; the renderer chooses its requestAnimationFrame lifecycle.
 */
export function createGraphDynamics(graph,{reducedMotion=false}={}) {
  const nodes=new Map(),originals=new Map(),centres=new Map(),indices=new Map(),dragOrigins=new Map();
  const inventory=Array.isArray(graph?.nodes)?graph.nodes:[];
  for(const input of inventory){
    if(!input||typeof input.id!=='string'||!input.id||nodes.has(input.id))continue;
    const x=coordinate(input.x),y=coordinate(input.y);
    const state={...input,x,y,vx:0,vy:0,anchorX:x,anchorY:y,dragging:false};
    nodes.set(state.id,state);originals.set(state.id,{x,y});
    if(state.kind==='person'&&(!centres.has(state.group)||state.id==='person:'+state.group))centres.set(state.group,{x,y});
  }
  const states=[...nodes.values()],neighbors=states.map(()=>[]),phases=states.map(node=>phase(node.id));
  const grouped=new Map();
  for(let i=0;i<states.length;i++){
    const node=states[i];indices.set(node.id,i);
    const group=grouped.get(node.group)||{x:0,y:0,count:0};group.x+=node.x;group.y+=node.y;group.count++;grouped.set(node.group,group);
  }
  for(const [name,group] of grouped)if(!centres.has(name))centres.set(name,{x:group.x/group.count,y:group.y/group.count});
  if(grouped.has('shared')){
    const people=[centres.get('owner'),centres.get('self')].filter(Boolean);
    if(people.length)centres.set('shared',{x:people.reduce((sum,item)=>sum+item.x,0)/people.length,y:people.reduce((sum,item)=>sum+item.y,0)/people.length});
  }
  for(const node of states){
    const center=centres.get(node.group),original=originals.get(node.id);
    const root=node.kind==='person'&&center.x===original.x&&center.y===original.y;
    if(!reducedMotion&&!root){node.x=center.x+(original.x-center.x)*.08;node.y=center.y+(original.y-center.y)*.08;}
  }
  // A unique adjacency list bounds linked motion to the actual supplied edges.
  const pairs=new Set();
  for(const edge of Array.isArray(graph?.edges)?graph.edges:[]){
    const a=indices.get(edge?.source),b=indices.get(edge?.target);
    if(a===undefined||b===undefined||a===b)continue;
    const key=a<b?a+':'+b:b+':'+a;if(pairs.has(key))continue;pairs.add(key);
    neighbors[a].push(b);neighbors[b].push(a);
  }
  const offsetsX=new Float64Array(states.length),offsetsY=new Float64Array(states.length);
  const targetsX=new Float64Array(states.length),targetsY=new Float64Array(states.length);
  let enabled=true,disposed=false,lastTime=0,age=0;

  function active(){
    if(disposed||!states.length)return false;
    if(enabled&&!reducedMotion||dragOrigins.size)return true;
    return states.some(node=>Math.abs(node.x-node.anchorX)>POSITION_EPSILON||Math.abs(node.y-node.anchorY)>POSITION_EPSILON||Math.abs(node.vx)>VELOCITY_EPSILON||Math.abs(node.vy)>VELOCITY_EPSILON);
  }
  function step(dtSeconds,timeSeconds){
    if(disposed||!states.length)return false;
    const dt=Number.isFinite(dtSeconds)?Math.min(.064,Math.max(0,dtSeconds)):0;
    if(!dt)return active();
    const time=Number.isFinite(timeSeconds)?timeSeconds:lastTime+dt;lastTime=time;age+=dt;
    offsetsX.fill(0);offsetsY.fill(0);
    for(const [id,start] of dragOrigins){
      const dragged=nodes.get(id),index=indices.get(id),dx=dragged.x-start.x,dy=dragged.y-start.y;
      for(const neighbor of neighbors[index]){
        if(states[neighbor].dragging)continue;
        const strength=states[neighbor].kind==='person'?.045:.14;
        offsetsX[neighbor]+=dx*strength;offsetsY[neighbor]+=dy*strength;
      }
    }
    for(let i=0;i<states.length;i++){
      const node=states[i],limit=node.kind==='person'?13:38;
      const length=Math.hypot(offsetsX[i],offsetsY[i]),factor=length>limit?limit/length:1;
      // The tiny, deterministic drift is independent of the navigation camera.
      const motion=enabled&&!reducedMotion?Math.min(1,age/.7):0;
      const amplitude=node.kind==='person'?.4:1.55,p=phases[i];
      targetsX[i]=clamp(node.anchorX+offsetsX[i]*factor+Math.sin(time*.39+p)*amplitude*motion);
      targetsY[i]=clamp(node.anchorY+offsetsY[i]*factor+Math.cos(time*.33+p*1.37)*amplitude*.8*motion);
    }
    if(reducedMotion){
      for(let i=0;i<states.length;i++){const node=states[i];if(node.dragging)continue;node.x=targetsX[i];node.y=targetsY[i];node.vx=0;node.vy=0;}
      return dragOrigins.size>0;
    }
    // Substeps cap integration work and keep a late/background frame stable.
    const iterations=Math.max(1,Math.ceil(dt/(1/120))),h=dt/iterations;
    for(let iteration=0;iteration<iterations;iteration++)for(let i=0;i<states.length;i++){
      const node=states[i];if(node.dragging)continue;
      node.vx+=(SPRING*(targetsX[i]-node.x)-DAMPING*node.vx)*h;
      node.vy+=(SPRING*(targetsY[i]-node.y)-DAMPING*node.vy)*h;
      node.x=clamp(node.x+node.vx*h);node.y=clamp(node.y+node.vy*h);
      if(Math.abs(targetsX[i]-node.x)<POSITION_EPSILON&&Math.abs(node.vx)<VELOCITY_EPSILON){node.x=targetsX[i];node.vx=0;}
      if(Math.abs(targetsY[i]-node.y)<POSITION_EPSILON&&Math.abs(node.vy)<VELOCITY_EPSILON){node.y=targetsY[i];node.vy=0;}
    }
    return active();
  }
  function beginDrag(id){
    const node=nodes.get(id);if(disposed||!node)return false;
    if(!dragOrigins.has(id))dragOrigins.set(id,{x:node.x,y:node.y});
    node.dragging=true;node.vx=0;node.vy=0;return true;
  }
  function dragTo(id,x,y){
    const node=nodes.get(id);
    if(disposed||!node?.dragging||!Number.isFinite(x)||!Number.isFinite(y))return false;
    node.x=clamp(x);node.y=clamp(y);node.vx=0;node.vy=0;return true;
  }
  function endDrag(id){
    const node=nodes.get(id);if(disposed||!node?.dragging)return false;
    node.dragging=false;node.anchorX=node.x;node.anchorY=node.y;node.vx=0;node.vy=0;dragOrigins.delete(id);return true;
  }
  function reset(){
    if(disposed)return;
    dragOrigins.clear();
    for(const node of states){
      const original=originals.get(node.id);node.dragging=false;node.anchorX=original.x;node.anchorY=original.y;
      if(reducedMotion){node.x=original.x;node.y=original.y;node.vx=0;node.vy=0;}
    }
  }
  function setMotion(value){enabled=!!value;return enabled&&!reducedMotion;}
  function dispose(){disposed=true;dragOrigins.clear();for(const node of states)node.dragging=false;}
  return {nodes,step,beginDrag,dragTo,endDrag,reset,setMotion,dispose};
}
