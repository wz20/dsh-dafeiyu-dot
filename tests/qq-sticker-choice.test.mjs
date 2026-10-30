import test from 'node:test';
import assert from 'node:assert/strict';
const {rankQQStickerChoices}=await import('../lib/qq-sticker-choice.js').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const generic=(id,emotion=id)=>({id,title:id,emotion,tags:['generic']});
const special=(id,emotion,tags,title=id)=>({id,title,emotion,tags});
const catalog=[generic('warm'),generic('joyful'),generic('soothing'),generic('playful'),generic('concerned'),generic('apologetic'),generic('sad'),special('sleepy','warm',['晚安','睡觉'],'晚安啦'),special('hungry','warm',['饿了','吃饭'],'好饿呀'),special('angry','playful',['生气','气鼓鼓'],'哼！')];
function ids(options,rows=catalog){assert.equal(typeof rankQQStickerChoices,'function','automatic contextual sticker ranking must be available');return rankQQStickerChoices(rows,options).map(row=>row.id);}

test('ordinary warm dialogue uses generic emotion choices without selecting unrelated scenes',()=>{
 const ranked=ids({emotion:'warm',text:'主人，本鱼在这儿陪你说话呀。'});assert.equal(ranked[0],'warm');for(const id of ['sleepy','hungry','angry'])assert.equal(ranked.includes(id),false);
});
test('specific scenes require affirmative contextual wording and override the ordinary emotion pool',()=>{
 assert.equal(ids({emotion:'warm',text:'晚安啦，早点睡觉呀。'})[0],'sleepy');assert.equal(ids({emotion:'warm',text:'肚子饿了，一起吃饭吧。'})[0],'hungry');assert.equal(ids({emotion:'playful',text:'哼，本鱼有点生气啦。'})[0],'angry');
 const no=ids({emotion:'warm',text:'本鱼不生气，也不想睡觉，不用吃饭呀。'});for(const id of ['sleepy','hungry','angry'])assert.equal(no.includes(id),false);
});
test('an explicit controlled choice has priority and an unknown identifier cannot enter candidates',()=>{
 assert.equal(ids({emotion:'warm',text:'普通聊天。',preferredId:'angry',recent:['angry']})[0],'angry');assert.equal(ids({emotion:'joyful',text:'普通聊天。',preferredId:'../../private'})[0],'joyful');
});
test('actual voice emotion is preferred and text provides deterministic fallback without a model call',()=>{
 assert.equal(ids({emotion:'soothing',text:'本鱼认真听着呢。'})[0],'soothing');assert.equal(ids({text:'对不起呀，本鱼错啦。'})[0],'apologetic');assert.equal(ids({text:'嘿嘿，太开心啦！'})[0],'joyful');
});
test('recent repetition is avoided among suitable choices without pulling in unmatched scenes',()=>{
 assert.equal(ids({emotion:'warm',text:'你好呀。',recent:['warm-a']},[generic('warm-a','warm'),generic('warm-b','warm'),catalog[7]])[0],'warm-b');
 const ranked=ids({emotion:'warm',text:'你好呀。',recent:['warm','concerned','soothing']});assert.notEqual(ranked[0],'warm');assert.equal(ranked.includes('sleepy'),false);
});
test('legacy basic emotion entries remain usable while scene-only or malformed catalogs have no ordinary match',()=>{
 assert.deepEqual(ids({emotion:'warm',text:'你好呀。'},[special('warm','warm',['亲近'])]),['warm']);assert.deepEqual(ids({emotion:'warm',text:'你好呀。'},[catalog[7],catalog[8]]),[]);
 assert.deepEqual(ids({emotion:'warm'},[null,{id:'../escape',tags:['generic']},{id:'warm',emotion:'warm',tags:['generic']},{id:'warm',emotion:'warm',tags:['generic']}]),['warm']);
});
