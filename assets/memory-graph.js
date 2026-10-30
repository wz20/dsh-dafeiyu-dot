/** A read-only graph of explicit memory metadata. Coordinates use a 1100 × 760 world. */
const WORLD = Object.freeze({width:1100,height:760});
const GROUPS = new Set(['owner','self']);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const text = (value,max=512) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max) : '';
const key = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
const short = (value,max=18) => { const points=Array.from(text(value));return points.length>max?points.slice(0,max-1).join('')+'…':points.join(''); };
const tokenId = (kind,value) => kind+':'+encodeURIComponent(key(value));
function hash(value) { let result=2166136261;for(let i=0;i<value.length;i++)result=Math.imul(result^value.charCodeAt(i),16777619);return result>>>0; }
function recordTitle(record) {
  const predicate=text(record.predicate),content=text(record.content || record.text || record.value);
  const line=content.split(/[。！？!?\n]/u)[0].replace(/^\s*[#>*\-]+\s*/,'');
  return short(predicate || line || '记忆');
}
function personIdentity(subject,spaceId) {
  const value=key(subject);
  if(['主人','用户'].includes(value)||(spaceId==='owner'&&['我','本人'].includes(value)))return 'person:owner';
  if(['鲸鱼娘','大肥鱼','本鱼'].includes(value)||(spaceId==='self'&&value==='你'))return 'person:self';
  return tokenId('person:subject',subject);
}
function placeSparseNodes(nodes,edges) {
  const byId=new Map(nodes.map(node=>[node.id,node])),twoPeople=byId.has('person:owner')&&byId.has('person:self');
  const center=group=>({x:twoPeople?(group==='owner'?330:group==='self'?790:560):550,y:375});
  const rings=new Map();
  for(const node of nodes){
    node.r=node.kind==='person'?34:node.kind==='topic'?22:9;
    const hub=center(node.group);
    if(node.id==='person:owner'||node.id==='person:self'){node.x=hub.x;node.y=hub.y;node.fixed=true;continue;}
    const ring=node.group+':'+node.kind;if(!rings.has(ring))rings.set(ring,[]);rings.get(ring).push(node);
  }
  function footprint(node){
    if(node.kind==='memory')return {left:node.r+5,right:145,top:18,bottom:18};
    return {left:node.kind==='person'?80:66,right:node.kind==='person'?80:66,top:node.r+5,bottom:node.r+58};
  }
  function move(node,x,y){
    if(node.fixed)return;
    const box=footprint(node);
    node.x=Math.max(22+box.left,Math.min(1078-box.right,node.x+x));
    node.y=Math.max(35+box.top,Math.min(727-box.bottom,node.y+y));
  }
  for(const list of rings.values())for(let index=0;index<list.length;index++){
    const node=list[index],hub=center(node.group),memory=node.kind==='memory';
    const angle=-Math.PI/2+(index+(memory ? .5 : 0))*Math.PI*2/list.length;
    const radiusX=node.group==='shared'?125:twoPeople?(memory?270:215):(memory?425:350),radiusY=memory?300:280;
    node.x=hub.x+Math.cos(angle)*radiusX;node.y=hub.y+Math.sin(angle)*radiusY;
    move(node,0,0);node.anchorX=node.x;node.anchorY=node.y;
  }
  function separateLabels(){
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
      const a=nodes[i],b=nodes[j];if(a.fixed&&b.fixed)continue;
      const ab=footprint(a),bb=footprint(b),ax=a.x+(ab.right-ab.left)/2,ay=a.y+(ab.bottom-ab.top)/2,bx=b.x+(bb.right-bb.left)/2,by=b.y+(bb.bottom-bb.top)/2;
      const overlapX=(ab.left+ab.right+bb.left+bb.right)/2+13-Math.abs(ax-bx),overlapY=(ab.top+ab.bottom+bb.top+bb.bottom)/2+13-Math.abs(ay-by);
      if(overlapX<=0||overlapY<=0)continue;
      const factor=a.fixed||b.fixed?1:.5;
      if(overlapX<overlapY){const shift=(overlapX+.25)*(ax>=bx?1:-1)*factor;move(a,shift,0);move(b,-shift,0);}
      else{const shift=(overlapY+.25)*(ay>=by?1:-1)*factor;move(a,0,shift);move(b,0,-shift);}
    }
  }
  // Long, weak springs preserve the semantic fan-out; anchors keep sparse graphs expansive.
  for(let iteration=0;iteration<55;iteration++){
    for(const edge of edges){
      const a=byId.get(edge.source),b=byId.get(edge.target),dx=b.x-a.x,dy=b.y-a.y,distance=Math.max(1,Math.hypot(dx,dy));
      const target=edge.kind==='space'?270:150,force=Math.max(-1,Math.min(1,(distance-target)*.002));
      move(a,dx/distance*force,dy/distance*force);move(b,-dx/distance*force,-dy/distance*force);
    }
    for(const node of nodes)if(!node.fixed)move(node,(node.anchorX-node.x)*.08,(node.anchorY-node.y)*.08);
    separateLabels();
  }
  for(let iteration=0;iteration<60;iteration++)separateLabels();
  for(const node of nodes){node.x=Math.round(node.x*100)/100;node.y=Math.round(node.y*100)/100;delete node.fixed;delete node.anchorX;delete node.anchorY;}
}
function placeNodes(nodes,edges) {
  if(!nodes.length)return;
  if(nodes.length<=48){placeSparseNodes(nodes,edges);return;}
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const hasOwner=byId.has('person:owner'),hasSelf=byId.has('person:self');
  const center=group=>group==='owner'?{x:hasSelf?320:550,y:375}:group==='self'?{x:hasOwner?780:550,y:375}:{x:550,y:375};
  const scale=Math.min(1,Math.sqrt(95/nodes.length)),counter={owner:0,self:0,shared:0};
  for(const node of nodes){
    node.r=(node.kind==='person'?34:node.kind==='topic'?22:9)*Math.max(.36,scale);
    const hub=center(node.group);
    if(node.id==='person:owner'||node.id==='person:self'){node.x=hub.x;node.y=hub.y;node.fixed=true;continue;}
    const index=counter[node.group]++,angle=index*2.399963229728653+(hash(node.id)%360)*Math.PI/180;
    const radius=85+Math.sqrt(index)*24*scale;
    node.x=Math.max(55,Math.min(1045,hub.x+Math.cos(angle)*radius));
    node.y=Math.max(60,Math.min(700,hub.y+Math.sin(angle)*radius*.85));
    node.anchorX=node.x;node.anchorY=node.y;
  }
  const move=(node,x,y)=>{if(!node.fixed){node.x=Math.max(42+node.r,Math.min(1058-node.r,node.x+x));node.y=Math.max(48+node.r,Math.min(712-node.r,node.y+y));}};
  function separate(padding){
    const grid=new Map(),cellSize=72;
    for(const node of nodes){
      const gx=Math.floor(node.x/cellSize),gy=Math.floor(node.y/cellSize);
      for(let x=gx-1;x<=gx+1;x++)for(let y=gy-1;y<=gy+1;y++)for(const other of grid.get(x+':'+y)||[]){
        let dx=node.x-other.x,dy=node.y-other.y,distance=Math.hypot(dx,dy);
        const minimum=node.r+other.r+padding;
        if(distance>=minimum)continue;
        if(distance<.001){const a=(hash(node.id+'|'+other.id)%6283)/1000;dx=Math.cos(a)*.01;dy=Math.sin(a)*.01;distance=.01;}
        const amount=(minimum-distance)*.53/(node.fixed||other.fixed ? .5 : 1),fx=dx/distance*amount,fy=dy/distance*amount;
        move(node,fx,fy);move(other,-fx,-fy);
      }
      const cell=gx+':'+gy;if(!grid.has(cell))grid.set(cell,[]);grid.get(cell).push(node);
    }
  }
  const iterations=nodes.length>700?36:70;
  for(let iteration=0;iteration<iterations;iteration++){
    for(const edge of edges){
      const a=byId.get(edge.source),b=byId.get(edge.target),dx=b.x-a.x,dy=b.y-a.y,distance=Math.max(1,Math.hypot(dx,dy));
      const target=(edge.kind==='space'?150:edge.kind==='subject'?120:85)*Math.max(.55,scale),strength=edge.kind==='space'?.007:.012;
      const force=Math.max(-2.8,Math.min(2.8,(distance-target)*strength));
      move(a,dx/distance*force,dy/distance*force);move(b,-dx/distance*force,-dy/distance*force);
    }
    for(const node of nodes)if(!node.fixed)move(node,(node.anchorX-node.x)*.016,(node.anchorY-node.y)*.016);
    separate(12*Math.max(.5,scale));
  }
  for(let pass=0;pass<35;pass++)separate(7*Math.max(.5,scale));
  for(const node of nodes){node.x=Math.round(node.x*100)/100;node.y=Math.round(node.y*100)/100;delete node.fixed;delete node.anchorX;delete node.anchorY;}
}

/**
 * Space membership, subjects, entities and scopes are explicit links.
 * Topic selection follows the memory index: tags first, predicate only as an untagged fallback.
 * A shared topic means it occurs in both spaces; it does not assert a shared experience.
 */
export function buildMemoryGraph(records,{spaces=[]}={}) {
  const inventory=new Map();
  for(const record of Array.isArray(records)?records:[]){
    if(!record||typeof record!=='object'||!GROUPS.has(record.spaceId)||record.testOnly===true||(record.status&&record.status!=='active'))continue;
    if(typeof record.id!=='string'||!record.id.trim()||record.id.length>1000||!text(record.content || record.text || record.value))continue;
    const previous=inventory.get(record.id);
    if(!previous||compare(text(record.updatedAt),text(previous.updatedAt))>0)inventory.set(record.id,record);
  }
  const ordered=[...inventory.values()].sort((a,b)=>compare(a.id,b.id)),nodeMap=new Map(),edgeMap=new Map();
  const spaceNames=new Map((Array.isArray(spaces)?spaces:[]).filter(x=>x&&GROUPS.has(x.id)).map(x=>[x.id,text(x.name)]));
  function addNode(id,kind,label,group,record){
    let node=nodeMap.get(id);
    if(!node){node={id,kind,label:short(label,kind==='memory'?18:16),fullLabel:text(label),group,memberIds:[],searchText:text(label,16000)};nodeMap.set(id,node);}
    if(record&&!node.memberIds.includes(record.id))node.memberIds.push(record.id);
    if(node.group!==group)node.group='shared';
    return node;
  }
  function addEdge(source,target,kind,label){const id=JSON.stringify([source,target,kind]);if(!edgeMap.has(id))edgeMap.set(id,{id,source,target,kind,label});}
  for(const record of ordered){
    const group=record.spaceId,personId='person:'+group,recordNodeId='memory:'+record.id;
    const root=addNode(personId,'person',group==='owner'?'主人':'鲸鱼娘',group,record);
    root.spaceName=spaceNames.get(group)||(group==='owner'?'我眼里的主人':'鲸鱼娘自己的');
    const memory=addNode(recordNodeId,'memory',recordTitle(record),group,record);memory.recordId=record.id;
    const tags=Array.isArray(record.tags)?[...new Set(record.tags.map(value=>text(value)).filter(Boolean))].sort(compare).slice(0,24):[];
    memory.searchText=[text(record.content,16000),text(record.text,16000),text(record.value,16000),text(record.subject),text(record.entity),text(record.scope),text(record.predicate),...tags].join(' ').normalize('NFKC').toLowerCase();
    addEdge(personId,recordNodeId,'space','记忆空间');
    const subject=text(record.subject);
    if(subject){const subjectId=personIdentity(subject,group);addNode(subjectId,'person',subject,group,record);if(subjectId!==personId)addEdge(subjectId,recordNodeId,'subject','关于');}
    const metadata=[...(text(record.entity)?[{label:text(record.entity),kind:'entity'}]:[]),...(!tags.length&&text(record.predicate)?[{label:text(record.predicate),kind:'predicate'}]:[]),...tags.map(label=>({label,kind:'tag'}))],seenTopics=new Set();
    for(const {label,kind} of metadata){const id=tokenId('topic',label);if(seenTopics.has(id))continue;seenTopics.add(id);addNode(id,'topic',label,group,record);addEdge(id,recordNodeId,kind,kind==='entity'?'项目归属':kind==='predicate'?'属性':'主题');}
    const scope=text(record.scope),entity=text(record.entity);
    if(scope){const label=entity?entity+' · '+scope:scope,id='topic:scope:'+JSON.stringify([key(entity),key(scope)]);addNode(id,'topic',label,group,record);addEdge(id,recordNodeId,'scope','范围');}
  }
  const nodes=[...nodeMap.values()].sort((a,b)=>compare(a.id,b.id)),edges=[...edgeMap.values()].sort((a,b)=>compare(a.id,b.id));
  for(const node of nodes){node.count=node.memberIds.length;node.memberIds.sort(compare);}
  placeNodes(nodes,edges);
  return {nodes,edges,width:WORLD.width,height:WORLD.height,totalRecords:ordered.length,visibleRecords:ordered.length,query:'',matchedNodeIds:[]};
}

/** Direct neighbours, including the selected node itself. */
export function connectedNodeIds(graph,nodeId) {
  const result=new Set();
  if(!graph?.nodes?.some(node=>node.id===nodeId))return result;
  result.add(nodeId);
  for(const edge of graph.edges||[]){if(edge.source===nodeId)result.add(edge.target);if(edge.target===nodeId)result.add(edge.source);}
  return result;
}

/**
 * Search retains matching records and their explicit metadata, without expanding neighbours' records.
 * Supplied recordIds are authoritative full-text results; local excerpts never add or remove hits.
 */
export function filterMemoryGraph(graph,query='',{recordIds}={}) {
  const normalized=text(query,4000).normalize('NFKC').toLowerCase(),terms=normalized.split(/\s+/).filter(Boolean);
  const authoritative=Array.isArray(recordIds);
  if(!terms.length&&!authoritative)return {...graph,query:'',matchedNodeIds:[],visibleRecords:graph?.totalRecords||0};
  const nodes=graph?.nodes||[],edges=graph?.edges||[],byId=new Map(nodes.map(node=>[node.id,node]));
  const localMatches=terms.length?nodes.filter(node=>terms.every(term=>(node.searchText||node.fullLabel||node.label||'').normalize('NFKC').toLowerCase().includes(term))):[];
  const requestedIds=authoritative?new Set(recordIds.filter(id=>typeof id==='string'&&id)):new Set(localMatches.flatMap(node=>node.recordId?[node.recordId]:node.memberIds||[]));
  const memories=nodes.filter(node=>node.kind==='memory'&&requestedIds.has(node.recordId)),hits=new Set(memories.map(node=>node.recordId));
  const retained=new Set(memories.map(node=>node.id));
  if(hits.size)for(const edge of edges){
    const source=byId.get(edge.source),target=byId.get(edge.target);
    if(source?.kind==='memory'&&hits.has(source.recordId)&&target?.kind!=='memory')retained.add(edge.target);
    if(target?.kind==='memory'&&hits.has(target.recordId)&&source?.kind!=='memory')retained.add(edge.source);
  }
  const matchedIds=new Set([...localMatches.filter(node=>retained.has(node.id)).map(node=>node.id),...authoritative?memories.map(node=>node.id):[]]);
  return {...graph,nodes:nodes.filter(node=>retained.has(node.id)),edges:edges.filter(edge=>retained.has(edge.source)&&retained.has(edge.target)),query:normalized,matchedNodeIds:[...matchedIds],visibleRecords:hits.size};
}
