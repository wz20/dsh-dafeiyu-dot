import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentPreset, isRoot, requireWhale } from './session.js';
import { validateExtractedFacts, memoryEventTime } from './memory-lifecycle.js';
import { userMessageText } from './user-message.js';
const names=['dafeiyu_memory_search','dafeiyu_memory_save','dafeiyu_memory_forget','dafeiyu_memory_index','dafeiyu_memory_read'];
function currentUserSource(agent) {
  const events=agent.session.snapshotEvents();let start=-1;
  for(let i=events.length-1;i>=0;i--){if(events[i].type==='turn/end')break;if(events[i].type==='turn/start'){start=i;break;}}
  if(start<0)throw Error('请仅根据当前回合的真实用户消息保存记忆。');
  let current;
  for(const event of events.slice(start+1))if(event.type==='user/message'&&event.data?.source?.kind==='user')current=event;
  const text=userMessageText(current?.data?.content);
  if(!text.trim()||text.length>32000)throw Error('当前回合没有可核验的用户消息，暂时不能保存这条事实。');
  const observedAt=memoryEventTime(current)??memoryEventTime(events[start]);
  if(!observedAt)throw Error('当前用户消息缺少可靠的来源时间，请重新发送需要记住的事实。');
  return {sessionId:agent.id,userEventId:String(current.data.id??current.id??'seq:'+current.seq),userText:text,observedAt};
}
function saveArguments(args) {
  if(!args||typeof args!=='object'||!['owner','self'].includes(args.spaceId)||['predicate','value','evidence'].some(k=>typeof args[k]!=='string'||!args[k].trim()))throw Error('保存记忆需要分区、事实属性、确切值和当前用户消息中的连续原文证据。');
  const candidate=Object.fromEntries(['spaceId','predicate','value','evidence','entity','scope','operation'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
  return {...candidate,subject:args.spaceId==='owner'?'用户':'共同经历'};
}
export function installMemory(ctx,store,getConfig,{resolveStore,additionalGroupTools=[]}={}) {
  const groupTools=[...new Set(Array.isArray(additionalGroupTools)?additionalGroupTools.filter(value=>typeof value==='string'&&value):[])];
  function selectedStore(agent) {
    if(resolveStore){try{return resolveStore(agent)??null;}catch{return null;}}
    return currentPreset(agent?.session)==='whale'?store:null;
  }
  function admit(exec,expectedStore) {
    const agent=exec?.agent;
    requireWhale(agent);
    if(!getConfig().memory.enabled)throw Error('陪伴记忆已关闭。');
    const selected=selectedStore(agent);
    if(!selected||(expectedStore&&selected!==expectedStore))throw Error('当前会话的记忆空间尚未就绪或已经改变，请重新核对后再操作。');
    return selected;
  }
  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  const definitions=[
    {name:names[0],description:'按关键词或中文近义表达，在记忆宫殿中检索当前有效片段。只把查到的当前事实当作过去的记忆。需要全文时再调用read。',parameters:{query:{type:'string',description:'简短关键词或相关主题'},spaceId:{type:'string',description:'self 鲸鱼娘自己的，owner 我眼里的主人'}},output,execute:async(args,exec)=>{
      const store=admit(exec);
      const memories=store.search(args.query??'',args.spaceId,{limit:8,maxChars:900}).map(r=>Object.fromEntries(['id','spaceId','content','truncated','contentLength','subject','predicate','entity','scope','operation','tags','updatedAt','source','score'].map(k=>[k,r[k]])));
      return {memories,hasMore:memories.length===8};
    }},
    {name:names[1],description:'从当前回合真实用户消息中保存一条有连续原文证据的长期事实。owner只保存用户本人的明确事实，self只保存用户明确确认的共同经历。确切值须逐字出现在证据中，后台会核验来源、否定、假设和不保存要求。只在收到saved或merged成功回执后说记住了。',parameters:{spaceId:{type:'string',required:true,description:'owner 用户本人；self 用户明确确认的共同经历'},predicate:{type:'string',required:true,description:'稳定、具体的事实属性，如称呼、职业、饮品偏好。更新沿用原属性'},value:{type:'string',required:true,description:'用户原文明示的确切值，逐字保留否定和限定，不从角色回复推断'},evidence:{type:'string',required:true,description:'当前最新用户消息中逐字连续的原文，4到240字，完整保留否定、更正或假设含义'},entity:{type:'string',description:'证据原文明示的项目或事物名称，无则不填'},scope:{type:'string',description:'证据原文明示的环境或范围，无则不填'},operation:{type:'string',description:'add补充独立事实；update只用于用户明确更正或单值属性的新值'}},output,execute:async(args,exec)=>{
      const store=admit(exec),candidate=saveArguments(args),source=currentUserSource(exec.agent),validated=validateExtractedFacts({facts:[candidate]},source);
      if(!validated.facts.length)return {saved:null,status:'skipped',reason:validated.reason??'当前用户原文不足以支持这条事实。'};
      const result=await store.consolidate(validated.facts,source,{admit:()=>{admit(exec,store);const latest=currentUserSource(exec.agent);if(latest.userEventId!==source.userEventId||latest.userText!==source.userText)throw Error('当前用户消息已更新，请重新核验原文后保存。');}}),saved=result.saved[0]??result.merged[0];
      if(saved)return {saved,status:result.saved.length?'saved':'merged'};
      const reason=result.skipped[0]?.reason;
      return {saved:null,status:'skipped',reason:reason==='forgotten'?'这条事实已被要求忘记，自动保存不会恢复它。':reason==='stale-source'?'已经有更新的用户事实，这次来源没有覆盖它。':'这条事实未通过记忆宫殿的证据检查。'};
    }},
    {name:names[2],description:'忘记用户要求删除的指定记忆及其更正链。先搜索确认精确ID。',parameters:{id:{type:'string',required:true,description:'要忘记的记忆ID'}},output,execute:async(args,exec)=>{const store=admit(exec);return await store.remove(args.id,{admit:()=>admit(exec,store)});}},
    {name:names[3],description:'查阅记忆宫殿的人物、主题或时间索引。先定位相关分区，再搜索和按ID精读，避免将整个记忆库装进上下文。',parameters:{section:{type:'string',description:'people 人物、topics 主题、dates 时间；默认topics'},query:{type:'string',description:'可选：筛选索引名称'},offset:{type:'number',description:'分页起点，默认0'}},output,execute:async(args,exec)=>{
      const store=admit(exec),section=['people','topics','dates'].includes(args.section)?args.section:'topics';const catalog=store.index();
      const groups=catalog[section].filter(g=>!args.query||String(g.name??g.date).includes(args.query));const offset=Math.max(0,Math.trunc(args.offset??0));
      return {section,total:groups.length,entries:groups.slice(offset,offset+30).map(g=>({...g,ids:g.ids.slice(0,12),hasMore:g.ids.length>12})),nextOffset:offset+30<groups.length?offset+30:null,spaces:catalog.spaces};
    }},
    {name:names[4],description:'按索引ID精读一条记忆的当前有效版本；长文分页，不向上下文加载整座宫殿。',parameters:{id:{type:'string',required:true,description:'记忆ID'},offset:{type:'number',description:'正文字符起点，默认0'}},output,execute:async(args,exec)=>{
      const store=admit(exec);let r=store.getRecord(args.id);const seen=new Set();while(r?.status==='superseded'&&r.supersededBy&&!seen.has(r.id)){seen.add(r.id);r=store.getRecord(r.supersededBy);}
      if(!r||r.testOnly||r.status!=='active')return {found:false};const offset=Math.max(0,Math.trunc(args.offset??0));
      return {found:true,id:r.id,spaceId:r.spaceId,status:r.status,entity:r.entity,scope:r.scope,operation:r.operation,content:r.content.slice(offset,offset+6000),source:r.source,updatedAt:r.updatedAt,totalChars:r.content.length,nextOffset:offset+6000<r.content.length?offset+6000:null};
    }}
  ];
  for(const definition of definitions)ctx.tools.register(defineTool(definition));
  const forks=new Map();
  const reconcile=agent=>{
    forks.get(agent)?.dispose();
    const group=currentPreset(agent.session)==='whale-group';
    const ready=isRoot(agent)&&['whale','whale-group'].includes(currentPreset(agent.session))&&!!selectedStore(agent);
    const allowed=ready&&getConfig().memory.enabled;
    const fork=agent.ctx.plugin({name:'dafeiyu-memory-scope',apply(scoped){
      if(group)scoped.tools.restrict({allow:ready?[...(allowed?names:[]),...groupTools]:[]});
      else if(!allowed)scoped.tools.restrict({deny:names});
      if(allowed)scoped.inject(['systemPrompt'],p=>p.systemPrompt.section({name:'dafeiyu:memory-guidance',order:150,text:group?'你有当前群、当前成员专用的持久记忆宫殿。owner记录当前成员本人，self记录当前成员在当前群明确确认的共同经历。对方是当前群成员，使用成员的昵称或自然称呼。涉及过去的约定、偏好或经历时，先调用dafeiyu_memory_index或dafeiyu_memory_search，再按需调用dafeiyu_memory_read。只把工具返回的当前有效事实当作回忆，没有结果就坦诚说明。长期事实必须来自当前成员最新真实消息的连续原文证据；立即保存后等待saved或merged成功回执。先搜索避免重复，保留确切值、否定、限定和来源；不保存问题、假设、临时验收信息、密钥、原始对话或猜测。用户更正时以新事实为准，要求忘记时调用forget处理对应更正链。不要凭其他成员的发言或角色自己的回复替当前成员填写事实。':'你在工作区有持久的记忆宫殿。self「鲸鱼娘自己的」保存共同经历，owner「我眼里的主人」保存对用户的了解。涉及以前的约定、偏好或经历时，应先查 dafeiyu_memory_index 或 dafeiyu_memory_search，再用 dafeiyu_memory_read 按需精读相关条目。只把查询返回的当前有效事实当作回忆；没有查到就坦诚说明，不借历史角色或旧版本猜测。不要把整个宫殿加载到上下文。每轮结束后后台整理器会从用户明确陈述中提取可追溯事实；需要立即可靠记住时，可用 dafeiyu_memory_save 提交属性、确切值及当前最新用户消息中的连续原文证据，并等待saved或merged成功回执。用户只提出问题、假设或仅回答“对”时，不从旧回复拼接事实。先搜索避免重复，不保存临时验收暗号、测试数据、密钥、原始对话或猜测。用户纠正时以新事实为准；用户要求忘记时使用forget删除对应更正链。'}));
    }});
    forks.set(agent,fork);
  };
  ctx.effect(()=>{
    const created=ctx.on('agent/created',({agent})=>reconcile(agent));
    const selected=ctx.on('agent-preset/selected',id=>{const agent=ctx.agents.get(id);if(agent)reconcile(agent);});
    const disposed=ctx.on('agent/disposed',({agent})=>{forks.get(agent)?.dispose();forks.delete(agent);});
    for(const agent of ctx.agents.list())reconcile(agent);
    return ()=>{created();selected();disposed();for(const fork of forks.values())fork.dispose();forks.clear();};
  });
  return ()=>{for(const agent of ctx.agents.list())reconcile(agent);};
}
