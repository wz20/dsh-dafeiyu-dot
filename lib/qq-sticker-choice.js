const EMOTIONS=new Set(['warm','joyful','soothing','playful','concerned','apologetic','sad']);
const ID=/^[a-z][a-z0-9_-]{0,63}$/;
const compatible={warm:['concerned','soothing','joyful','playful'],joyful:['playful','warm','concerned'],playful:['joyful','warm','concerned'],soothing:['concerned','warm'],concerned:['soothing','warm'],apologetic:['concerned','warm','sad'],sad:['soothing','concerned','warm']};

function mentioned(text,term) {
  let offset=0,index;
  while((index=text.indexOf(term,offset))!==-1){
    const before=text.slice(Math.max(0,index-8),index);
    if(!/(?:不|别|没|无需|不用|不要|不能|并非|不是|不想|没有)[^\p{Punctuation}\s]{0,5}$/u.test(before))return true;
    offset=index+Math.max(1,term.length);
  }
  return false;
}
function textEmotion(text) {
  const hints=[['apologetic',['对不起','抱歉','本鱼错']],['sad',['难过','委屈','伤心','想哭']],['soothing',['抱抱','辛苦','安慰','慢慢来','别怕']],['joyful',['嘿嘿','好耶','开心','好棒','太好啦','唱好','清唱生成']],['playful',['超乖','撒娇','坏主人','气鼓鼓']],['concerned',['担心','在呢','认真听','还好吗','陪着你']]];
  return hints.find(([,terms])=>terms.some(term=>mentioned(text,term)))?.[0]??'warm';
}
function sceneScore(entry,text) {
  const title=typeof entry.title==='string'?entry.title.replace(/[^\p{Script=Han}]/gu,''):'';
  const terms=[...new Set([...(Array.isArray(entry.tags)?entry.tags:[]),title].filter(term=>typeof term==='string'&&/\p{Script=Han}/u.test(term)&&Array.from(term).length>=2))];
  return terms.reduce((score,term)=>score+(mentioned(text,term)?Math.min(6,Array.from(term).length):0),0);
}

/** Rank only controlled IDs. Special scenes require current affirmative wording. */
export function rankQQStickerChoices(catalog,{emotion,text='',preferredId,recent=[]}={}) {
  if(!Array.isArray(catalog))return [];
  const seen=new Set(),entries=catalog.filter(entry=>{
    if(!entry||typeof entry.id!=='string'||!ID.test(entry.id)||seen.has(entry.id))return false;
    seen.add(entry.id);return true;
  });
  const genericExists=entries.some(entry=>Array.isArray(entry.tags)&&entry.tags.includes('generic'));
  const words=typeof text==='string'?text.slice(0,4000):'';
  const selectedEmotion=EMOTIONS.has(emotion)?emotion:emotion==='neutral'?'warm':textEmotion(words);
  const nearby=compatible[selectedEmotion]??compatible.warm;
  const history=Array.isArray(recent)?recent.slice(0,3):[];
  return entries.map((entry,index)=>{
    const explicit=entry.id===preferredId;
    const generic=Array.isArray(entry.tags)&&entry.tags.includes('generic')||!genericExists&&EMOTIONS.has(entry.id);
    const context=sceneScore(entry,words);
    if(!explicit&&!generic&&!context)return null;
    const mood=entry.emotion===selectedEmotion?1000:nearby.includes(entry.emotion)?750-nearby.indexOf(entry.emotion)*50:100;
    const position=history.indexOf(entry.id),repeat=position<0?0:[600,240,120][position];
    return {entry,index,score:explicit?100000:(!generic?2000:0)+mood+context*15-repeat};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||a.index-b.index).map(result=>result.entry);
}
