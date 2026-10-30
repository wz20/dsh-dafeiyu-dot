import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createGraphDynamics} from '../assets/memory-graph-dynamics.js';

const makeGraph=()=>({nodes:[
  {id:'person:owner',kind:'person',group:'owner',label:'主人',x:150,y:320,r:34},
  {id:'topic:voice',kind:'topic',group:'owner',label:'语音',x:370,y:180,r:22},
  {id:'memory:a',kind:'memory',group:'owner',label:'相伴',x:550,y:350,r:9},
],edges:[{source:'person:owner',target:'memory:a'},{source:'topic:voice',target:'memory:a'}]});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function advance(engine,seconds,{start=0,step=1/60}={}){for(let t=step;t<=seconds+1e-8;t+=step)engine.step(step,start+t);}

test('nodes unfold from their person group over multiple frames and converge to the original layout',()=>{
  const graph=makeGraph(),before=structuredClone(graph),engine=createGraphDynamics(graph);
  engine.setMotion(false);
  const node=engine.nodes.get('memory:a'),initial={x:node.x,y:node.y};
  assert.ok(distance(initial,graph.nodes[0])<80,'initial memory should belong visibly to its person cluster');
  assert.equal(engine.nodes.get('person:owner').x,150);
  engine.step(1/60,1/60);const first={x:node.x,y:node.y};
  assert.ok(distance(first,initial)>0,'the unfolding must have a visible intermediate frame');
  assert.ok(distance(first,graph.nodes[2])>20,'the first frame must not jump to its final position');
  advance(engine,.7,{start:1/60});
  assert.ok(distance(node,graph.nodes[2])<8,'the main expansion should complete in about 0.7 seconds');
  advance(engine,1,{start:.8});
  assert.ok(distance(node,graph.nodes[2])<.1);
  assert.deepEqual(graph,before,'layout and relation inputs stay unchanged');
});

test('dragging follows the pointer immediately, gives neighbours a bounded elastic response and retains the new anchor',()=>{
  const engine=createGraphDynamics(makeGraph());engine.setMotion(false);advance(engine,2);
  const memory=engine.nodes.get('memory:a'),topic=engine.nodes.get('topic:voice'),before={x:topic.x,y:topic.y};
  assert.equal(engine.beginDrag('memory:a'),true);
  assert.equal(engine.dragTo('memory:a',760,440),true);
  assert.equal(memory.x,760);assert.equal(memory.y,440);assert.equal(memory.vx,0);assert.equal(memory.vy,0);
  assert.equal(memory.anchorX,550,'the release commits the anchor, rather than each pointer update');
  advance(engine,.3,{start:2});
  assert.ok(topic.x>before.x+1,'a real adjacent topic should respond to the drag');
  assert.ok(distance(topic,before)<=45,'linked motion stays controlled');
  assert.equal(memory.x,760,'physics must not pull a held node away from the pointer');
  assert.equal(engine.endDrag('memory:a'),true);
  assert.equal(memory.anchorX,760);assert.equal(memory.anchorY,440);
  advance(engine,2,{start:2.3});
  assert.ok(distance(memory,{x:760,y:440})<.05,'a released node keeps its chosen location');
  assert.ok(distance(topic,before)<.1,'its neighbour softly returns to its own anchor');
});

test('reduced motion starts at rest, keeps pointer dragging and resets directly',()=>{
  const graph=makeGraph(),engine=createGraphDynamics(graph,{reducedMotion:true});
  for(const original of graph.nodes)assert.equal(distance(engine.nodes.get(original.id),original),0);
  advance(engine,3);engine.setMotion(true);advance(engine,3,{start:3});
  for(const original of graph.nodes)assert.equal(distance(engine.nodes.get(original.id),original),0,'reduced motion wins over ambient motion');
  engine.beginDrag('memory:a');engine.dragTo('memory:a',720,490);engine.step(1/60,6.1);
  assert.equal(engine.nodes.get('memory:a').x,720);
  engine.endDrag('memory:a');engine.reset();
  for(const original of graph.nodes)assert.equal(distance(engine.nodes.get(original.id),original),0);
});

test('ambient drift is visibly alive but remains within three world pixels, and pause settles at the anchor',()=>{
  const engine=createGraphDynamics(makeGraph());advance(engine,3);
  const memory=engine.nodes.get('memory:a'),start={x:memory.x,y:memory.y};let greatest=0;
  for(let frame=1;frame<=600;frame++){
    engine.step(1/60,3+frame/60);
    greatest=Math.max(greatest,distance(memory,{x:memory.anchorX,y:memory.anchorY}));
  }
  assert.ok(greatest<=3,'ambient movement should never interfere with reading or hit targets');
  assert.ok(distance(memory,start)>.15,'ambient motion must actually change the rendered positions');
  engine.setMotion(false);advance(engine,2,{start:13});
  const paused={x:memory.x,y:memory.y};advance(engine,3,{start:15});
  assert.equal(distance(memory,paused),0,'a paused, settled graph must stop changing');
  engine.setMotion(true);advance(engine,1,{start:18});
  assert.ok(distance(memory,paused)>.05);
});

test('reset softly returns moved nodes to the supplied layout while keeping the same nodes and relationships',()=>{
  const graph=makeGraph(),engine=createGraphDynamics(graph);engine.setMotion(false);advance(engine,2);
  engine.beginDrag('memory:a');engine.dragTo('memory:a',830,550);engine.endDrag('memory:a');
  const memory=engine.nodes.get('memory:a'),moved={x:memory.x,y:memory.y},ids=[...engine.nodes.keys()];
  engine.reset();assert.equal(memory.anchorX,550);assert.equal(memory.anchorY,350);
  assert.equal(distance(memory,moved),0,'normal reset is an animated return');
  engine.step(1/60,2.1);assert.ok(distance(memory,graph.nodes[2])<distance(moved,graph.nodes[2]));
  advance(engine,1.5,{start:2.1});assert.ok(distance(memory,graph.nodes[2])<.1);
  assert.deepEqual([...engine.nodes.keys()],ids);assert.equal(graph.edges.length,2);
});

test('invalid gestures, bounded frame deltas and disposal keep positions finite and do not create nodes',()=>{
  const engine=createGraphDynamics(makeGraph());
  assert.equal(engine.beginDrag('unknown'),false);assert.equal(engine.dragTo('memory:a',2,3),false);
  engine.beginDrag('memory:a');assert.equal(engine.dragTo('memory:a',NaN,Infinity),false);
  assert.equal(engine.dragTo('memory:a',1e308,-1e308),true);engine.endDrag('memory:a');
  for(const dt of [0,-1,NaN,Infinity,3000,.016])engine.step(dt,Infinity);
  for(const node of engine.nodes.values())for(const field of ['x','y','vx','vy','anchorX','anchorY'])assert.ok(Number.isFinite(node[field]),field);
  assert.equal(engine.nodes.size,3);
  engine.dispose();const before=[...engine.nodes.values()].map(node=>({x:node.x,y:node.y}));
  assert.equal(engine.step(.016,100),false);assert.equal(engine.beginDrag('memory:a'),false);
  assert.deepEqual([...engine.nodes.values()].map(node=>({x:node.x,y:node.y})),before);
  assert.equal(createGraphDynamics({nodes:[],edges:[]}).step(.016,1),false);
});

test('five hundred nodes stay deterministic and finite through bounded animation work',()=>{
  const graph={nodes:Array.from({length:500},(_,i)=>({id:'n'+i,kind:i===0?'person':'memory',group:'owner',x:80+(i%25)*38,y:60+Math.floor(i/25)*31})),edges:Array.from({length:499},(_,i)=>({source:'n'+Math.floor(i/5),target:'n'+(i+1)}))};
  const a=createGraphDynamics(graph),b=createGraphDynamics(graph),started=performance.now();
  for(let frame=1;frame<=180;frame++){a.step(1/60,frame/60);b.step(1/60,frame/60);}
  const elapsed=performance.now()-started;
  assert.ok(elapsed<1500,'500 nodes should not require unbounded pairwise collision work; elapsed '+elapsed.toFixed(1)+'ms');
  assert.equal(a.nodes.size,500);
  for(const [id,node] of a.nodes){const other=b.nodes.get(id);assert.equal(node.x,other.x);assert.equal(node.y,other.y);assert.ok(Number.isFinite(node.x)&&Number.isFinite(node.y));}
});
