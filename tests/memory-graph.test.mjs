import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMemoryGraph,connectedNodeIds,filterMemoryGraph} from '../assets/memory-graph.js';

const fact=(id,fields={})=>({id,spaceId:'owner',status:'active',subject:'主人',predicate:'饮品偏好',value:'拿铁',content:'主人喜欢拿铁',tags:['饮品'],...fields});
const node=(graph,id)=>graph.nodes.find(value=>value.id===id);

test('empty and malformed inventories produce an empty graph rather than invented memories',()=>{
  for(const records of [undefined,null,{},[],[null,{},'text',fact('',{}),fact('blank',{content:'',value:''}),fact('wrong-space',{spaceId:'unknown'})]]){
    const graph=buildMemoryGraph(records);assert.equal(graph.totalRecords,0);assert.deepEqual(graph.nodes,[]);assert.deepEqual(graph.edges,[]);
  }
});

test('space membership, subjects and metadata have explicit typed edges without a fabricated shared root',()=>{
  const graph=buildMemoryGraph([fact('latte'),fact('story',{spaceId:'self',subject:'大肥鱼',predicate:'初次相伴',tags:['回忆'],content:'第一次相伴的经历'})]);
  assert.equal(node(graph,'person:owner').label,'主人');assert.equal(node(graph,'person:self').label,'鲸鱼娘');
  assert.equal(graph.nodes.filter(value=>value.kind==='memory').length,2);
  assert.ok(graph.edges.some(edge=>edge.source==='person:owner'&&edge.target==='memory:latte'&&edge.kind==='space'));
  assert.ok(graph.edges.some(edge=>edge.source==='topic:'+encodeURIComponent('饮品')&&edge.target==='memory:latte'&&edge.kind==='tag'));
  assert.equal(graph.nodes.some(value=>value.label==='共同经历'),false);
  assert.equal(graph.edges.some(edge=>edge.source==='person:owner'&&edge.target==='person:self'),false);
});

test('matching topic metadata aggregates across spaces while preserving person/topic identity',()=>{
  const graph=buildMemoryGraph([fact('a',{subject:'咖啡',tags:['咖啡','咖啡']}),fact('b',{spaceId:'self',subject:'鲸鱼娘',tags:['咖啡']})]);
  const coffee=graph.nodes.filter(value=>value.fullLabel==='咖啡');assert.equal(coffee.length,2);
  const topic=coffee.find(value=>value.kind==='topic');assert.equal(topic.group,'shared');assert.deepEqual(topic.memberIds,['a','b']);
  assert.equal(graph.edges.filter(edge=>edge.source===topic.id&&edge.target==='memory:a'&&edge.kind==='tag').length,1);
  assert.notEqual(topic.id,coffee.find(value=>value.kind==='person').id);
});

test('entity-scoped nodes preserve project boundaries and meaningful symbols',()=>{
  const graph=buildMemoryGraph([fact('a',{entity:'项目甲',scope:'生产',tags:['C++']}),fact('b',{entity:'项目乙',scope:'生产',tags:['C#']})]);
  const scopes=graph.nodes.filter(value=>value.fullLabel.includes(' · 生产'));assert.equal(scopes.length,2);assert.notEqual(scopes[0].id,scopes[1].id);
  assert.equal(graph.nodes.filter(value=>value.fullLabel==='C++'||value.fullLabel==='C#').length,2);
  const aScope=scopes.find(value=>value.fullLabel==='项目甲 · 生产');assert.deepEqual(aScope.memberIds,['a']);
});

test('superseded and test-only records are excluded and duplicate IDs select the current version',()=>{
  const graph=buildMemoryGraph([fact('old',{status:'superseded'}),fact('hidden',{testOnly:true}),fact('a',{updatedAt:'2026-10-28',predicate:'旧属性'}),fact('a',{updatedAt:'2026-10-29',predicate:'当前属性'})]);
  assert.equal(graph.totalRecords,1);assert.equal(node(graph,'memory:a').label,'当前属性');assert.equal(node(graph,'memory:old'),undefined);
});

test('memory labels use meaningful titles, bound long text and do not use internal record IDs',()=>{
  const id='private-record-identifier-001',long='一'.repeat(50000),graph=buildMemoryGraph([fact(id,{predicate:'',content:'# 这是一条手工记忆。后续内容',tags:[long,{},null]}),fact('long',{predicate:long})]);
  assert.equal(node(graph,'memory:'+id).label,'这是一条手工记忆');
  for(const entry of graph.nodes){assert.ok(Array.from(entry.label).length<=18);assert.notEqual(entry.label,id);assert.ok(Number.isFinite(entry.x)&&Number.isFinite(entry.y));}
});

test('search includes matching records and their metadata without expanding unrelated same-topic records',()=>{
  const graph=buildMemoryGraph([fact('latte'),fact('tea',{content:'主人喜欢乌龙茶',value:'乌龙茶'}),fact('work',{predicate:'工作',value:'代码',tags:['编程'],content:'在项目中写代码'})]);
  const found=filterMemoryGraph(graph,'拿铁');assert.equal(found.visibleRecords,1);
  assert.ok(node(found,'memory:latte'));assert.equal(node(found,'memory:tea'),undefined);assert.ok(node(found,'person:owner'));
  const retained=new Set(found.nodes.map(value=>value.id));assert.ok(found.edges.every(edge=>retained.has(edge.source)&&retained.has(edge.target)));
  const topicResult=filterMemoryGraph(graph,'饮品');assert.equal(topicResult.visibleRecords,2);
  const absent=filterMemoryGraph(graph,'不存在的词');assert.deepEqual(absent.nodes,[]);assert.deepEqual(absent.edges,[]);assert.equal(absent.visibleRecords,0);
  assert.equal(filterMemoryGraph(graph,'   ').nodes.length,graph.nodes.length);
});

test('direct-neighbour selection returns only the local neighbourhood and does not mutate the graph',()=>{
  const graph=buildMemoryGraph([fact('a'),fact('b',{tags:['不同主题']})]),before=JSON.stringify(graph);
  const connected=connectedNodeIds(graph,'memory:a');assert.ok(connected.has('person:owner'));assert.ok(connected.has('memory:a'));assert.equal(connected.has('memory:b'),false);
  assert.equal(connectedNodeIds(graph,'missing').size,0);filterMemoryGraph(graph,'拿铁');assert.equal(JSON.stringify(graph),before);
});

test('authoritative full-text IDs retain a memory whose excerpt does not contain the search terms',()=>{
  const graph=buildMemoryGraph([fact('long',{content:'只有开头摘要',value:'只有开头摘要'}),fact('other',{content:'也有这个主题',value:'另一个值'})]);
  assert.equal(filterMemoryGraph(graph,'尾部关键词').visibleRecords,0);
  const result=filterMemoryGraph(graph,'尾部关键词',{recordIds:['long']});
  assert.equal(result.visibleRecords,1);assert.ok(node(result,'memory:long'));assert.equal(node(result,'memory:other'),undefined);
  assert.ok(node(result,'person:owner'));assert.ok(result.matchedNodeIds.includes('memory:long'));
  const retained=new Set(result.nodes.map(entry=>entry.id));assert.ok(result.edges.every(edge=>retained.has(edge.source)&&retained.has(edge.target)));
});

test('authoritative empty results remain empty despite matching local labels or excerpts',()=>{
  const graph=buildMemoryGraph([fact('a'),fact('b')]);
  for(const query of ['饮品','主人','拿铁','']){
    const result=filterMemoryGraph(graph,query,{recordIds:[]});assert.equal(result.visibleRecords,0);assert.deepEqual(result.nodes,[]);assert.deepEqual(result.edges,[]);assert.deepEqual(result.matchedNodeIds,[]);
  }
  const result=filterMemoryGraph(graph,'饮品',{recordIds:['a']});assert.equal(result.visibleRecords,1);assert.equal(node(result,'memory:b'),undefined);assert.ok(result.nodes.some(entry=>entry.kind==='topic'&&entry.fullLabel==='饮品'));
});

test('authoritative IDs cannot create absent records, include metadata IDs, or revive filtered records',()=>{
  const graph=buildMemoryGraph([fact('current'),fact('old',{status:'superseded'})]),before=JSON.stringify(graph);
  const invalid=['missing','old','person:owner','memory:current','__proto__',null,{},42];
  const absent=filterMemoryGraph(graph,'饮品',{recordIds:invalid});assert.equal(absent.visibleRecords,0);assert.deepEqual(absent.nodes,[]);assert.deepEqual(absent.edges,[]);
  const result=filterMemoryGraph(graph,'服务端已解析的多词 查询',{recordIds:[...invalid,'current','current']});assert.equal(result.visibleRecords,1);assert.ok(node(result,'memory:current'));assert.equal(JSON.stringify(graph),before);
});

test('identical tag, predicate and entity identities share one topic and one record connection',()=>{
  const graph=buildMemoryGraph([fact('a',{predicate:'语音',entity:'语音',tags:['语音','  语音  ']})]);
  const topics=graph.nodes.filter(entry=>entry.kind==='topic'&&entry.fullLabel==='语音');assert.equal(topics.length,1);
  assert.equal(graph.edges.filter(edge=>edge.source===topics[0].id&&edge.target==='memory:a').length,1);
  assert.equal(topics[0].count,1);
});

test('tagged records use their existing index topics while preserving predicate titles and entity/scope links',()=>{
  const graph=buildMemoryGraph([fact('a',{predicate:'一起调试语音',tags:['语音','共同经历'],entity:'语音搭子',scope:'本机'})]);
  assert.equal(node(graph,'memory:a').label,'一起调试语音');
  assert.equal(graph.nodes.some(entry=>entry.kind==='topic'&&entry.fullLabel==='一起调试语音'),false);
  for(const label of ['语音','共同经历','语音搭子','语音搭子 · 本机'])assert.ok(graph.nodes.some(entry=>entry.kind==='topic'&&entry.fullLabel===label));
  assert.ok(graph.edges.some(edge=>edge.kind==='entity'));assert.ok(graph.edges.some(edge=>edge.kind==='scope'));
  assert.equal(filterMemoryGraph(graph,'一起调试语音').visibleRecords,1);
});

test('untagged records use a nonempty predicate as their topic fallback',()=>{
  for(const tags of [undefined,[],['  ',null,{}]]){
    const graph=buildMemoryGraph([fact('a',{predicate:'日常偏好',tags})]);
    const topic=graph.nodes.find(entry=>entry.kind==='topic'&&entry.fullLabel==='日常偏好');assert.ok(topic);
    assert.ok(graph.edges.some(edge=>edge.source===topic.id&&edge.target==='memory:a'&&edge.kind==='predicate'));
  }
});

test('sparse layouts use the canvas around both people and reserve room for labels',()=>{
  const records=Array.from({length:5},(_,index)=>fact('record-'+index,{spaceId:index>2?'self':'owner',subject:index>2?'鲸鱼娘':'主人',predicate:'属性'+index,tags:['主题'+index,'标签'+index],content:'记忆正文'+index}));
  const graph=buildMemoryGraph(records),xs=graph.nodes.map(entry=>entry.x),ys=graph.nodes.map(entry=>entry.y);
  assert.ok(Math.min(...ys)<=105);assert.ok(Math.max(...ys)>=650);assert.ok(Math.max(...xs)-Math.min(...xs)>=700);
  assert.equal(node(graph,'person:owner').x,330);assert.equal(node(graph,'person:self').x,790);
  assert.equal(node(graph,'person:owner').r,34);assert.ok(graph.nodes.filter(entry=>entry.kind==='topic').every(entry=>entry.r>=20));
  for(const entry of graph.nodes){assert.ok(entry.x-entry.r>=0&&entry.x+entry.r<=1100);assert.ok(entry.y-entry.r>=0&&entry.y+entry.r<=760);}
  let overlaps=0;
  const box=entry=>entry.kind==='memory'?{left:entry.x-entry.r-5,right:entry.x+145,top:entry.y-18,bottom:entry.y+18}:{left:entry.x-(entry.kind==='person'?80:66),right:entry.x+(entry.kind==='person'?80:66),top:entry.y-entry.r-5,bottom:entry.y+entry.r+58};
  for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){
    const a=box(graph.nodes[i]),b=box(graph.nodes[j]);if(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom)overlaps++;
  }
  assert.equal(overlaps,0);
});

test('large inventory layouts are deterministic, bounded, finite and separated',()=>{
  const records=Array.from({length:220},(_,index)=>fact('record-'+String(index).padStart(3,'0'),{spaceId:index%3?'owner':'self',subject:index%3?'主人':'鲸鱼娘',predicate:'属性'+index%12,tags:['主题'+index%8],content:'第'+index+'条真实记录'}));
  const graph=buildMemoryGraph(records),reordered=buildMemoryGraph([...records].reverse());assert.deepEqual(graph,reordered);assert.equal(graph.totalRecords,220);
  for(const entry of graph.nodes){assert.ok(entry.x>=0&&entry.x<=1100);assert.ok(entry.y>=0&&entry.y<=760);assert.ok(entry.r>0);}
  let overlapping=0;
  for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){const a=graph.nodes[i],b=graph.nodes[j];if(Math.hypot(a.x-b.x,a.y-b.y)<a.r+b.r+2)overlapping++;}
  assert.equal(overlapping,0);
});
