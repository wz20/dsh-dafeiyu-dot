import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
function target(name,fallback){
 const value=process.env[name];if(value===undefined)return fallback;
 if(!value.trim())throw Error(name+' must be a non-empty path');
 return resolve(value);
}
const output=target('DAFEIYU_STICKER_OUTPUT',join(root,'assets/stickers'));
const preview=target('DAFEIYU_STICKER_PREVIEW',join(root,'docs/screenshots/sticker-sheet.png'));
const navy='#26345e',skin='#fff0e8',hair='#6681e5';
const font="'Hiragino Sans GB','PingFang SC',sans-serif";
const items=[
 {id:'warm',title:'贴贴～',emotion:'warm',tags:['贴贴','亲近','喜欢','爱心','warm','generic']},
 {id:'joyful',title:'嘿嘿！',emotion:'joyful',tags:['开心','高兴','嘿嘿','好耶','joyful','generic']},
 {id:'soothing',title:'抱抱你',emotion:'soothing',tags:['抱抱','安慰','陪伴','辛苦','soothing','generic']},
 {id:'playful',title:'本鱼超乖',emotion:'playful',tags:['撒娇','俏皮','乖巧','得意','playful','generic']},
 {id:'concerned',title:'本鱼在呢',emotion:'concerned',tags:['在呢','关心','倾听','陪着','concerned','generic']},
 {id:'apologetic',title:'本鱼错啦',emotion:'apologetic',tags:['道歉','对不起','错啦','抱歉','apologetic','generic']},
 {id:'sad',title:'委屈巴巴',emotion:'sad',tags:['委屈','难过','伤心','眼泪','sad','generic']},
 {id:'sleepy',title:'晚安啦',emotion:'warm',tags:['晚安','睡觉','困了','月亮','sleepy']},
 {id:'surprised',title:'欸？！',emotion:'playful',tags:['惊讶','意外','欸','震惊','surprised']},
 {id:'angry',title:'哼！',emotion:'playful',tags:['哼','生气','傲娇','气鼓鼓','angry']},
];
const path=(d,fill,extra='')=>`<path d="${d}" fill="${fill}" ${extra}/>`;
const heart=(x,y,size=1,color='#ff93ba',rotate=0)=>`<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${size})">${path('M0 10 C-25-9-45 12-34 30 L0 63 L34 30 C45 12 25-9 0 10Z',color,'stroke-width="4"')}</g>`;
const star=(x,y,s=1,color='#ffe084',rotate=0)=>`<path transform="translate(${x} ${y}) rotate(${rotate}) scale(${s})" d="M0-28 8-9 29-7 13 7 17 28 0 17-17 28-13 7-29-7-8-9Z" fill="${color}" stroke-width="4"/>`;
const sparkle=(x,y,s=1,color='#b5caff')=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0-24 Q3-3 19 0 Q3 3 0 24 Q-3 3-19 0 Q-3-3 0-24Z" fill="${color}" stroke-width="3"/>`;
function eye(x,y,{wide=false,tear=false}={}){
 const rx=wide?22:25,ry=wide?32:34;
 return `<g transform="translate(${x} ${y})"><ellipse cy="0" rx="${rx}" ry="${ry}" fill="white"/><ellipse cy="2" rx="${rx-4}" ry="${ry-2}" fill="url(#iris)" stroke-width="3"/><ellipse cy="1" rx="10" ry="20" fill="#304781" stroke="none"/><ellipse cx="-8" cy="-12" rx="7" ry="9" fill="white" stroke="none"/><circle cx="9" cy="16" r="5" fill="#e6f8ff" stroke="none"/>${tear?'<path d="M-22 18 Q0 6 22 18 L22 36 Q0 52-22 36Z" fill="#9ce3ff" stroke="#669dd7" stroke-width="3"/><circle cx="-9" cy="24" r="4" fill="white" stroke="none"/>':''}<path d="M-${rx+4}-${ry-9} Q-2-${ry+10} ${rx+1}-${ry-8}" fill="none" stroke-width="8"/><path d="M-${rx+2}-${ry-8} l-9-8" fill="none" stroke-width="5"/></g>`;
}
function eyes(id){
 if(id==='joyful')return '<path d="M165 226 Q187 198 209 225 M296 225 Q319 198 341 224" fill="none" stroke-width="9"/>';
 if(id==='soothing')return '<path d="M164 225 Q186 247 209 224 M297 224 Q320 247 342 222" fill="none" stroke-width="8"/>';
 if(id==='sleepy')return '<path d="M162 229 Q186 245 210 229 M295 228 Q319 244 344 227" fill="none" stroke-width="7"/><path d="M170 238 l-5 5 M200 239 l4 5 M304 237 l-5 5 M334 236 l5 5" fill="none" stroke-width="3"/>';
 if(id==='playful')return eye(188,227)+'<path d="M297 222 Q319 200 342 222 M300 226 l-6 4" fill="none" stroke-width="8"/>';
 if(id==='apologetic')return '<path d="M163 229 Q186 249 209 229 M297 229 Q320 249 343 229" fill="none" stroke-width="7"/>';
 if(id==='angry')return '<path d="M164 220 l44 14-43 12 M344 220 l-44 14 43 12" fill="none" stroke-width="8"/>';
 if(id==='sad')return eye(188,228,{tear:true})+eye(319,228,{tear:true})+'<path d="M161 185 l43-9 M301 176 l43 9" fill="none" stroke-width="6"/>';
 if(id==='surprised')return eye(188,225,{wide:true})+eye(319,225,{wide:true})+'<path d="M165 172 Q188 164 208 175 M300 174 Q319 161 342 171" fill="none" stroke-width="6"/>';
 if(id==='concerned')return eye(188,227)+eye(319,227)+'<path d="M166 185 Q187 173 205 181 M300 181 Q320 172 340 184" fill="none" stroke-width="5"/>';
 return eye(188,227)+eye(319,227);
}
function mouth(id){
 if(id==='joyful')return '<path d="M229 272 Q255 287 282 269 Q278 310 253 310 Q234 306 229 272Z" fill="#92517c"/><path d="M238 296 Q253 286 273 295 Q261 315 244 306Z" fill="#ffb3c2" stroke="none"/>';
 if(id==='surprised')return '<ellipse cx="255" cy="285" rx="13" ry="19" fill="#a86a8b"/>';
 if(id==='angry')return '<path d="M236 281 Q253 270 273 282 Q254 299 236 281Z" fill="#ffb1bb"/><path d="M236 280 l-5 5 M274 281 l5 4" fill="none" stroke-width="3"/>';
 if(id==='sad')return '<path d="M237 291 Q254 278 274 291" fill="none" stroke-width="6"/>';
 if(id==='apologetic')return '<path d="M239 287 Q246 280 253 286 Q260 293 271 286" fill="none" stroke-width="5"/>';
 if(id==='sleepy')return '<path d="M246 285 Q255 291 264 284" fill="none" stroke-width="5"/>';
 if(id==='playful')return '<path d="M234 275 Q258 299 280 274" fill="#ffb4c3"/><path d="M263 283 l0 12" fill="none" stroke-width="3"/>';
 if(id==='concerned')return '<path d="M243 282 Q254 277 267 282" fill="none" stroke-width="5"/>';
 return '<path d="M234 276 Q253 294 276 275" fill="none" stroke-width="6"/>';
}
function hairAndHead(id){
 const angle=({warm:-5,joyful:-8,soothing:5,playful:7,concerned:0,apologetic:-3,sad:-5,sleepy:10,surprised:0,angry:-5})[id];
 const ruffles=Array.from({length:9},(_,i)=>{const a=(196+i*18)*Math.PI/180,x=256+139*Math.cos(a),y=186+113*Math.sin(a);return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="24" ry="29" transform="rotate(${(i-4)*15} ${x} ${y})" fill="url(#cap)" stroke-width="4"/>`;}).join('');
 return `<g transform="rotate(${angle} 255 237)">
  <path d="M123 155 Q106 89 181 65 Q258 25 341 66 Q417 87 400 181 Q432 280 387 339 Q405 382 359 397 L317 351 189 359 Q154 413 113 376 Q92 352 117 327 Q80 263 123 155Z" fill="url(#hair)"/>
  <path d="M120 218 Q64 209 48 233 Q66 273 119 278 Q110 252 120 218Z" fill="#b6c6ff"/><path d="M65 237 Q86 254 114 257" fill="none" stroke="#7287d7" stroke-width="3"/>
  <path d="M392 219 Q448 208 465 232 Q447 275 394 278 Q403 251 392 219Z" fill="#b6c6ff"/><path d="M450 237 Q429 254 398 257" fill="none" stroke="#7287d7" stroke-width="3"/>
  <path d="M121 267 Q95 295 121 323 Q83 346 114 374 Q141 399 162 359 L181 306Z" fill="#647cdb"/><path d="M390 269 Q417 296 389 323 Q426 348 393 376 Q367 399 347 357 L329 305Z" fill="#647cdb"/>
  <path d="M114 329 Q145 318 157 345 M111 356 Q136 348 151 366 M394 329 Q365 318 351 346 M396 358 Q373 348 358 367" fill="none" stroke="#a0b9ff" stroke-width="6"/>
  <path d="M145 169 Q159 116 254 116 Q350 116 367 170 L366 249 Q357 317 256 333 Q152 320 144 251Z" fill="${skin}"/>
  <ellipse cx="162" cy="266" rx="23" ry="10" fill="#ffb5c5" opacity=".7" stroke="none"/><ellipse cx="346" cy="266" rx="23" ry="10" fill="#ffb5c5" opacity=".7" stroke="none"/>
  ${eyes(id)}${mouth(id)}
  <path d="M130 155 Q135 84 220 81 Q315 48 382 127 Q403 178 381 230 L355 263 Q363 208 318 160 Q296 183 275 198 Q274 164 253 141 Q231 195 203 210 Q211 180 201 165 Q160 201 140 243 Q123 211 130 155Z" fill="url(#bang)"/>
  <path d="M202 102 Q170 133 151 184 M252 93 Q237 124 221 150 M284 94 Q318 105 348 146 M357 174 Q373 205 365 223" fill="none" stroke="#b0c6ff" stroke-width="7" opacity=".8"/>
  <path d="M134 143 Q148 65 248 58 Q346 53 380 143" fill="none" stroke="#354e9d" stroke-width="16"/>
  ${ruffles}
  <path d="M137 141 Q160 92 252 85 Q339 85 376 143" fill="none" stroke="#eef0ff" stroke-width="9"/>
  <path d="M217 64 Q181 6 237 14 Q286 20 257 66" fill="none" stroke="#394a91" stroke-width="12"/><path d="M218 61 Q190 17 237 19" fill="none" stroke="#9cb8ff" stroke-width="5"/>
  <path d="M121 182 Q98 155 95 187 L106 213 88 236 Q119 249 129 215Z" fill="#344a92"/><path d="M390 183 Q413 155 417 188 L407 214 424 237 Q395 250 385 216Z" fill="#344a92"/>
  <circle cx="113" cy="208" r="9" fill="#5e78c9"/><circle cx="399" cy="208" r="9" fill="#5e78c9"/>
 </g>`;
}
const hand=(d)=>path(d,skin,'stroke-width="5"');
function body(id,front=false){
 const base='<path d="M177 318 Q151 340 144 397 Q252 437 367 397 Q361 340 333 319 Q261 349 177 318Z" fill="#34477f"/><path d="M203 328 Q253 351 305 328 L322 405 Q255 423 187 405Z" fill="url(#cap)"/><path d="M220 341 L255 358 289 341 275 371 236 371Z" fill="#dfe7ff"/><path d="M254 358 L225 346 Q207 371 242 380 L254 367 269 382 Q302 375 285 346Z" fill="#4262b1"/><circle cx="255" cy="363" r="8" fill="#9cc6ff"/>';
 let arms='';
 if(id==='warm')arms=hand('M170 365 Q158 343 174 331 Q187 324 201 341 L226 361 Q242 369 232 385 Q223 393 208 383Z')+hand('M338 364 Q351 343 337 331 Q323 326 309 341 L286 361 Q269 369 280 385 Q291 393 305 383Z')+heart(255,329,.7,'#ff9bbe');
 if(id==='joyful')arms='<path d="M179 343 L130 290 110 305 151 370Z" fill="#465d9e"/><path d="M331 343 L382 288 400 306 360 371Z" fill="#465d9e"/>'+hand('M128 292 Q110 287 101 272 L89 245 Q83 229 93 224 Q104 219 111 242 L118 255 113 226 Q111 213 122 212 Q134 210 135 231 L138 250 Q159 247 162 261 Q164 278 145 292Z')+hand('M382 291 Q402 286 413 271 L425 246 Q431 231 420 225 Q410 220 402 242 L396 254 400 228 Q401 214 390 213 Q379 213 377 233 L374 251 Q355 248 352 263 Q352 278 368 292Z');
 if(id==='soothing')arms='<path d="M169 348 Q134 350 148 387 Q174 419 240 395 L247 366 185 370Z" fill="#526db6"/><path d="M342 349 Q377 350 363 387 Q336 417 271 395 L267 365 327 370Z" fill="#526db6"/>'+heart(255,334,1.0,'#ffa7c9')+hand('M181 375 Q194 360 208 371 L237 386 Q250 399 232 406 Q213 410 181 391Z')+hand('M329 375 Q315 362 302 371 L274 386 Q260 399 277 405 Q298 411 330 391Z');
 if(id==='playful')arms='<path d="M176 351 Q142 342 144 311 L168 286 190 312Z" fill="#4c64ab"/>'+hand('M159 309 Q139 293 147 282 L162 260 157 236 Q156 224 167 224 Q177 225 177 239 L181 254 194 227 Q201 214 211 221 Q219 226 211 239 L197 268 Q214 269 214 282 Q211 298 188 312Z')+hand('M331 354 Q346 347 353 366 L354 390 Q345 411 322 401 L298 388 Q291 375 304 370 L325 374Z');
 if(id==='concerned')arms='<path d="M176 350 Q150 340 148 370 L171 404 229 394 228 371Z" fill="#526ab0"/><path d="M334 350 Q360 340 362 370 L340 404 283 394 284 371Z" fill="#526ab0"/>'+hand('M184 368 Q191 350 206 353 L239 363 Q252 373 241 387 Q228 393 199 382Z')+hand('M327 368 Q320 349 305 353 L272 363 Q260 374 271 387 Q284 392 311 382Z');
 if(id==='apologetic')arms='<path d="M177 351 Q151 345 160 377 L208 408 240 385Z" fill="#526ab0"/><path d="M335 351 Q361 345 351 377 L304 408 272 385Z" fill="#526ab0"/>'+hand('M208 380 Q214 368 226 375 L249 389 248 405 Q239 412 225 400Z')+hand('M302 380 Q295 368 285 375 L261 389 262 405 Q272 413 285 401Z')+'<path d="M247 395 L265 395" fill="none" stroke-width="5"/>';
 if(id==='sad')arms=hand('M170 357 Q154 342 148 361 L146 382 Q152 399 172 393 L199 382 Q210 370 196 365 L179 369Z')+hand('M341 356 Q357 341 364 360 L364 382 Q356 399 338 393 L311 382 Q299 369 313 365 L331 369Z');
 if(id==='sleepy')arms='<rect x="155" y="345" width="213" height="66" rx="27" fill="#d1ddff"/><path d="M181 365 Q252 348 340 366" fill="none" stroke="#a5b9f4" stroke-width="3"/>'+hand('M205 342 Q190 327 178 342 Q173 360 192 368 L230 366 Q244 357 231 348Z')+hand('M307 341 Q323 327 335 343 Q339 360 321 368 L283 366 Q269 356 282 348Z');
 if(id==='surprised')arms='<path d="M174 350 Q146 342 135 318 L153 284 178 308 199 355Z" fill="#526ab0"/><path d="M335 350 Q365 342 377 317 L358 284 333 308 312 355Z" fill="#526ab0"/>'+hand('M149 294 Q133 279 138 259 L146 243 Q154 235 162 244 L165 262 177 246 Q184 240 191 249 Q198 267 183 284 L178 302Z')+hand('M362 294 Q378 279 374 259 L366 243 Q358 235 350 244 L347 262 335 246 Q328 240 321 249 Q315 267 330 284 L335 302Z');
 if(id==='angry')arms='<path d="M172 353 Q145 355 160 385 Q219 419 307 373 L300 350 220 376Z" fill="#526ab0"/><path d="M341 353 Q367 355 352 384 Q292 418 205 372 L213 350 293 376Z" fill="#5872ba"/>'+hand('M209 362 Q196 345 181 358 Q169 371 185 382 L225 389 242 376Z')+hand('M303 362 Q316 345 330 358 Q342 371 328 382 L288 389 270 376Z');
 return `<g>${front?'':base}${arms}</g>`;
}
function decorations(id){
 if(id==='warm')return heart(69,110,.75,'#ffacd0',-18)+heart(422,128,.45,'#ffc2db',19)+sparkle(444,304,.6);
 if(id==='joyful')return star(68,126,.75,'#ffe18b',-12)+star(435,111,.7,'#ffe18b',18)+sparkle(76,356,.65)+sparkle(441,342,.6);
 if(id==='soothing')return heart(76,132,.52,'#ffbad5',-13)+heart(427,141,.62,'#ffbad5',18)+'<path d="M67 323 Q78 308 92 324 M420 324 Q435 307 446 323" fill="none" stroke="#b5caff" stroke-width="7"/>';
 if(id==='playful')return star(424,131,.75,'#ffdf8c',12)+sparkle(69,141,.72,'#c5b8ff')+'<path d="M425 324 Q440 304 452 318 M429 340 l18-4" fill="none" stroke="#9b99e3" stroke-width="6"/>';
 if(id==='concerned')return heart(77,134,.5,'#ffbdd8',-15)+'<path d="M424 129 Q444 139 440 157 M436 113 Q464 131 459 159" fill="none" stroke="#b8c9ff" stroke-width="6"/>'+sparkle(430,345,.55);
 if(id==='apologetic')return '<path d="M86 109 Q70 134 86 145 Q101 133 86 109Z M424 128 Q408 154 424 165 Q441 151 424 128Z" fill="#a8ddff" stroke="#6d8fbf" stroke-width="4"/><path d="M97 335 l-15 13 M413 335 l15 13" fill="none" stroke="#b3c4f4" stroke-width="6"/>';
 if(id==='sad')return '<path d="M77 119 Q57 149 76 162 Q94 148 77 119Z M433 127 Q412 158 432 170 Q453 156 433 127Z" fill="#a6e0ff" stroke="#709bc8" stroke-width="4"/><path d="M126 282 Q113 310 128 320 Q144 305 131 282 M381 282 Q369 310 382 320 Q398 304 386 282Z" fill="#a6e0ff" stroke="#709bc8" stroke-width="3"/>';
 if(id==='sleepy')return '<path d="M418 74 Q393 105 421 128 Q445 143 461 119 Q424 128 428 78Z" fill="#ffe6a1"/>'+star(79,131,.48,'#d1c3ff',8)+star(437,211,.33,'#d1c3ff',12)+'<text x="75" y="104" font-family="sans-serif" font-size="27" font-weight="900" fill="#8b90d8" stroke="white" stroke-width="5" paint-order="stroke fill">Z</text><text x="100" y="78" font-family="sans-serif" font-size="35" font-weight="900" fill="#8b90d8" stroke="white" stroke-width="5" paint-order="stroke fill">Z</text>';
 if(id==='surprised')return '<path d="M62 102 l10 50 M73 168 l1 2 M442 95 l-8 49 M433 163 l-1 3" fill="none" stroke="#d893b3" stroke-width="10"/>'+star(439,336,.45,'#ffe3a5',12);
 return '<path d="M408 102 l0 17 q0 9-11 9 l-15 0 M426 102 l0 17 q0 9 11 9 l15 0 M408 147 l0-6 q0-9-11-9 l-15 0 M426 147 l0-6 q0-9 11-9 l15 0" fill="none" stroke="#ec91ab" stroke-width="6"/>'+star(71,146,.46,'#d0c4ff',8)+'<path d="M79 332 l-15-10 M84 348 l-19 0 M429 332 l15-10 M424 348 l19 0" fill="none" stroke="#a3aee1" stroke-width="5"/>';
}
function svg(item){return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs>
<linearGradient id="hair" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7189ed"/><stop offset=".55" stop-color="#6d7bdd"/><stop offset="1" stop-color="#a2b4ff"/></linearGradient>
<linearGradient id="bang" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#7796f3"/><stop offset=".6" stop-color="#6b80df"/><stop offset="1" stop-color="#b4c5ff"/></linearGradient>
<linearGradient id="iris" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#4969c5"/><stop offset="1" stop-color="#9be0ff"/></linearGradient>
<linearGradient id="cap" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#e4e6ff"/></linearGradient>
<filter id="sticker" x="-15%" y="-15%" width="130%" height="135%"><feMorphology in="SourceAlpha" operator="dilate" radius="7" result="expanded"/><feFlood flood-color="#fff"/><feComposite in2="expanded" operator="in" result="border"/><feMerge><feMergeNode in="border"/><feMergeNode in="SourceGraphic"/></feMerge><feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#26345e" flood-opacity=".16"/></filter></defs>
<g stroke="${navy}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" filter="url(#sticker)">${decorations(item.id)}${body(item.id)}${hairAndHead(item.id)}${body(item.id,true)}</g>
<text x="256" y="477" text-anchor="middle" font-family="${font}" font-size="55" font-weight="900" letter-spacing="2" fill="#344779" stroke="white" stroke-width="14" stroke-linejoin="round" paint-order="stroke fill">${item.title}</text></svg>`;}
function validRows(rows){
 if(!Array.isArray(rows)||rows.length>32)throw Error('Sticker catalog must contain at most 32 entries');
 const ids=new Set();
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(row.id)||ids.has(row.id))throw Error('Sticker catalog must contain valid, unique ids');
  ids.add(row.id);
 }
 return rows;
}
const catalogPath=join(output,'catalog.json');
let catalog;
try{catalog=JSON.parse(await readFile(catalogPath,'utf8'));}
catch(error){if(error?.code==='ENOENT')catalog={version:1,stickers:[]};else throw Error('Existing sticker catalog could not be read as valid JSON',{cause:error});}
if(!catalog||typeof catalog!=='object'||Array.isArray(catalog)||catalog.version!==1)throw Error('Sticker catalog must use version 1');
const owned=new Set(items.map(item=>item.id));
const preserved=validRows(catalog.stickers).filter(item=>!owned.has(item.id));
const merged=validRows([...items.map(item=>({...item,file:item.id+'.png',mime:'image/png'})),...preserved]);
const catalogText=JSON.stringify({...catalog,version:1,stickers:merged},null,2)+'\n';
if(Buffer.byteLength(catalogText)>32768)throw Error('Sticker catalog exceeds the 32KiB runtime limit');
const sharp=(await import(process.env.DAFEIYU_SHARP_MODULE||'sharp')).default;
await mkdir(output,{recursive:true});await mkdir(dirname(preview),{recursive:true});
const buffers=[];
for(const item of items){
 const image=await sharp(Buffer.from(svg(item)),{density:192}).resize(512,512).png({compressionLevel:9}).toBuffer();
 if(image.length>1024*1024)throw Error(item.id+' exceeds 1MiB');
 const meta=await sharp(image).metadata();if(meta.width!==512||meta.height!==512||!meta.hasAlpha)throw Error(item.id+' has invalid dimensions or transparency');
 await writeFile(join(output,item.id+'.png'),image);buffers.push(image);
}
const temporaryCatalog=join(output,`.catalog-${process.pid}.tmp`);
try{await writeFile(temporaryCatalog,catalogText,{flag:'wx'});await rename(temporaryCatalog,catalogPath);}
finally{await rm(temporaryCatalog,{force:true});}
const W=1900,H=1052,tw=352,th=426,gap=18,margin=34,top=144;
const background=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#f5f8ff"/><stop offset="1" stop-color="#e9edfb"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/><text x="42" y="65" font-family="${font}" font-weight="900" font-size="42" fill="#2c3c68">大肥鱼 · 情绪表情包</text><text x="43" y="106" font-family="${font}" font-size="23" fill="#7c89ab">蓝发鲸鱼娘的小心情　/　10 张透明贴纸</text>${items.map((item,i)=>{const x=margin+(i%5)*(tw+gap),y=top+Math.floor(i/5)*(th+gap);return `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="26" fill="white" stroke="#dce4f5" stroke-width="2"/><text x="${x+tw/2}" y="${y+th-18}" font-family="${font}" font-size="18" fill="#8995b3" text-anchor="middle">${String(i+1).padStart(2,'0')} · ${item.id}</text>`;}).join('')}</svg>`;
const sheet=await sharp(Buffer.from(background)).composite(await Promise.all(buffers.map(async(input,i)=>({input:await sharp(input).resize(338,338).toBuffer(),left:margin+(i%5)*(tw+gap)+7,top:top+Math.floor(i/5)*(th+gap)+15})))).png({compressionLevel:9}).toBuffer();
await writeFile(preview,sheet);
console.log(JSON.stringify({stickers:merged.length,generated:items.length,preserved:preserved.length,dimensions:[512,512],transparent:true,files:items.map((item,i)=>({id:item.id,bytes:buffers[i].length})),sheet:preview}));
