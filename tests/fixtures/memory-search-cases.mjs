// Synthetic facts for repeatable retrieval checks; no real user profile is used.
export const memorySearchFacts = [
  {id:'aurora-prod-port',entity:'晨星',scope:'生产',predicate:'服务端口',value:'8088'},
  {id:'aurora-test-port',entity:'晨星',scope:'测试',predicate:'服务端口',value:'18088'},
  {id:'tide-prod-port',entity:'晚潮',scope:'生产',predicate:'服务端口',value:'9099'},
  {id:'aurora-language',entity:'晨星',predicate:'开发语言',value:'Python'},
  {id:'tide-address',entity:'晚潮',scope:'生产',predicate:'服务地址',value:'https://example.org/tide'},
  {id:'aurora-name',entity:'晨星',predicate:'项目名称',value:'晨星'},
  {id:'tide-name',entity:'晚潮',predicate:'项目名称',value:'晚潮'},
  {id:'drink-tea',predicate:'饮品偏好',value:'热茶',content:'用户喜欢喝热茶'},
  {id:'drink-avoid',predicate:'饮品偏好',value:'不喝咖啡',content:'用户不喝咖啡'},
  {id:'color',predicate:'颜色偏好',value:'蓝色',content:'用户喜欢蓝色'},
  {id:'city-past',predicate:'曾经居住城市',value:'苏州',content:'用户以前住在苏州'},
  {id:'city-current',predicate:'居住城市',value:'杭州',content:'用户现在住在杭州'},
  {id:'language',predicate:'回复语言',value:'中文',content:'用户习惯使用中文交流'},
  {id:'occupation',predicate:'职业',value:'工程师',content:'用户从事工程师工作'},
];

export const memorySearchCases = [
  {query:'晨星生产环境的服务端口是多少',ids:['aurora-prod-port'],kind:'entity-scope'},
  {query:'晨星测试环境用哪个端口',ids:['aurora-test-port'],kind:'entity-scope'},
  {query:'晚潮线上用的端口是多少',ids:['tide-prod-port'],kind:'entity-scope'},
  {query:'生产环境的端口有哪些',ids:['aurora-prod-port','tide-prod-port'],kind:'entity-scope'},
  {query:'晨星和晚潮生产环境分别用什么端口',ids:['aurora-prod-port','tide-prod-port'],kind:'entity-scope'},
  {query:'晨星预发环境端口是多少',ids:[],kind:'abstention'},
  {query:'晨星项目用哪种开发语言',ids:['aurora-language'],kind:'attribute'},
  {query:'晚潮项目的服务地址是什么',ids:['tide-address'],kind:'attribute'},
  {query:'晨星项目叫什么名字',ids:['aurora-name'],kind:'attribute'},
  {query:'插件项目名称',ids:['aurora-name','tide-name'],kind:'attribute'},
  {query:'我偏爱哪种饮料',ids:['drink-tea','drink-avoid'],kind:'paraphrase'},
  {query:'我平时喝啥',ids:['drink-tea','drink-avoid'],kind:'paraphrase'},
  {query:'我不喝什么饮料',ids:['drink-avoid'],kind:'polarity'},
  {query:'我讨厌哪种饮品',ids:['drink-avoid'],kind:'polarity'},
  {query:'我最喜欢什么颜色',ids:['color'],kind:'attribute'},
  {query:'我现在住哪儿',ids:['city-current'],kind:'time'},
  {query:'我以前住在哪',ids:['city-past'],kind:'time'},
  {query:'我过去在哪个城市生活',ids:['city-past'],kind:'time'},
  {query:'用汉语和我交流',ids:['language'],kind:'paraphrase'},
  {query:'我从事什么职业',ids:['occupation'],kind:'attribute'},
  {query:'解释火箭发动机原理',ids:[],kind:'abstention'},
  {query:'明天会下雨吗',ids:[],kind:'abstention'},
];

export async function seedMemorySearchFacts(store) {
  for (const fact of memorySearchFacts) {
    const {id,...fields}=fact;
    await store.put({spaceId:'owner',subject:'用户',...fields,content:fields.content??[fields.entity,fields.scope,fields.predicate,fields.value].filter(Boolean).join(' · ')});
  }
}

export function evaluateMemorySearch(store) {
  let correct=0,returned=0,relevant=0,expected=0,hit=0,answerable=0;
  const rows=memorySearchCases.map(item=>{
    const actual=store.search(item.query,'owner',{limit:6}).map(record=>memorySearchFacts.find(fact=>fact.content===record.content||(!fact.content&&[fact.entity,fact.scope,fact.predicate,fact.value].filter(Boolean).join(' · ')===record.content))?.id);
    const matches=actual.filter(id=>item.ids.includes(id)).length,exact=actual.length===item.ids.length&&matches===item.ids.length;
    if(exact)correct++;returned+=actual.length;relevant+=matches;expected+=item.ids.length;
    if(item.ids.length){answerable++;if(actual.length&&item.ids.includes(actual[0]))hit++;}
    return {...item,actual,exact};
  });
  return {cases:rows.length,exactCases:correct,precisionAt6:returned?relevant/returned:1,recallAt6:expected?relevant/expected:1,hitAt1:answerable?hit/answerable:1,rows};
}
