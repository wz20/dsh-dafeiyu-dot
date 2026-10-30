import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crc32} from 'node:zlib';
const loaded=await import('../lib/qq-stickers.js').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const entry=(changes={})=>({id:'warm',title:'本鱼在呢',emotion:'warm',tags:['陪伴'],file:'warm.png',mime:'image/png',...changes});
function paddedPNG(bytes) {
 const payload=bytes-PNG.length-12;assert.ok(payload>=0);
 const chunk=Buffer.alloc(12+payload);chunk.writeUInt32BE(payload,0);chunk.write('npAd',4);chunk.fill(0x78,8,8+payload);chunk.writeUInt32BE(crc32(chunk.subarray(4,8+payload)),8+payload);
 return Buffer.concat([PNG.subarray(0,33),chunk,PNG.subarray(33)]);
}
async function fixture(t,{stickers=[entry()],files={'warm.png':PNG},catalog}={}) {
 assert.equal(typeof loaded.createQQStickers,'function','controlled sticker service must be available');
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-stickers-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const assets=join(root,'assets');await mkdir(assets);
 await writeFile(join(assets,'catalog.json'),catalog??JSON.stringify({version:1,stickers}));
 for(const [name,bytes] of Object.entries(files))await writeFile(join(assets,name),bytes);
 return {root,assets,service:loaded.createQQStickers({assetRoot:assets})};
}

test('catalog exposes detached public metadata and only its declared image can be read',async t=>{
 const f=await fixture(t);const list=await f.service.list();
 assert.deepEqual(list,[{id:'warm',title:'本鱼在呢',emotion:'warm',tags:['陪伴']}]);
 list[0].title='changed';list[0].tags.push('changed');assert.equal((await f.service.list())[0].title,'本鱼在呢');assert.deepEqual((await f.service.list())[0].tags,['陪伴']);
 const image=await f.service.read('warm');assert.deepEqual(image.bytes,PNG);assert.equal(image.id,'warm');assert.equal(image.mime,'image/png');assert.equal(image.summary,'本鱼在呢');assert.deepEqual(Object.keys(image).sort(),['bytes','id','mime','summary']);
 await assert.rejects(f.service.read('missing'),e=>e.status===400&&!e.message.includes(f.root));
});

test('manifest refuses unbounded catalogs, duplicate ids and unsafe file or metadata fields',async t=>{
 const bad=[[entry({id:undefined})],[entry({id:null})],[entry({id:true})],Array.from({length:33},(_,i)=>entry({id:'warm_'+i})),[entry(),entry()], [entry({file:'../private.png'})],[entry({file:'/private/warm.png'})],[entry({file:'https://example.com/warm.png'})],[entry({file:'warm.svg'})],[entry({title:'unsafe\nline'})],[entry({tags:['x'.repeat(81)]})],[entry({mime:'text/html'})]];
 for(const stickers of bad){const f=await fixture(t,{stickers});await assert.rejects(f.service.list(),e=>e.status===503&&!e.message.includes(f.root));}
 for(const catalog of ['{broken',JSON.stringify({version:2,stickers:[]}),JSON.stringify({version:1,stickers:[]})+' '.repeat(65536)]){const f=await fixture(t,{catalog});await assert.rejects(f.service.list(),e=>e.status===503&&!e.message.includes(f.root));}
});

test('image data must match manifest MIME and have a complete recognizable container',async t=>{
 const ok=await fixture(t,{stickers:[entry({id:'wave',file:'wave.gif',mime:'image/gif'})],files:{'wave.gif':GIF}});assert.equal((await ok.service.read('wave')).mime,'image/gif');
 for(const bytes of [Buffer.from('<html>not an image</html>'),PNG.subarray(0,25),GIF]){const f=await fixture(t,{files:{'warm.png':bytes}});await assert.rejects(f.service.read('warm'),e=>e.status===503&&!e.message.includes(f.root));}
});

test('trusted built-in PNGs between one and four MiB retain exact bytes and the four MiB cap',async t=>{
 for(const bytes of [1024*1024+1,2*1024*1024,4*1024*1024]){
  const png=paddedPNG(bytes),f=await fixture(t,{files:{'warm.png':png}}),result=await f.service.read('warm');
  assert.equal(result.mime,'image/png');assert.equal(result.bytes.length,bytes);assert.deepEqual(result.bytes,png);
 }
 const tooLarge=await fixture(t,{files:{'warm.png':paddedPNG(4*1024*1024+1)}});
 await assert.rejects(tooLarge.service.read('warm'),e=>e.status===503&&!e.message.includes(tooLarge.root));
});

test('oversized images and symlinks cannot escape the controlled asset directory',async t=>{
 const big=await fixture(t,{files:{'warm.png':Buffer.alloc(4*1024*1024+1)}});await assert.rejects(big.service.read('warm'),e=>e.status===503&&!e.message.includes(big.root));
 const linked=await fixture(t,{files:{}});await writeFile(join(linked.root,'outside.png'),PNG);await symlink(join(linked.root,'outside.png'),join(linked.assets,'warm.png'));
 await assert.rejects(linked.service.read('warm'),e=>e.status===503&&!e.message.includes(linked.root));
 const unlisted=await fixture(t,{files:{'warm.png':PNG,'hidden.png':PNG}});await assert.rejects(unlisted.service.read('../hidden'),e=>e.status===400);
});

test('aborted reads preserve their signal reason and do not return image bytes',async t=>{
 const f=await fixture(t);await f.service.list();const before=new AbortController(),reason=Error('cancel');before.abort(reason);await assert.rejects(f.service.read('warm',{signal:before.signal}),e=>e===reason);
 const during=new AbortController();const promise=f.service.read('warm',{signal:during.signal});queueMicrotask(()=>during.abort(reason));await assert.rejects(promise,e=>e===reason);
});

test('the host-selected local catalog preserves local custom media with a public fallback for fresh installs',async t=>{
 const bundled=await fixture(t),local=await fixture(t,{stickers:[entry({title:'本机自定义贴纸'})]});
 const personal=loaded.createQQStickers({assetRoot:bundled.assets,localAssetRoot:local.assets});
 assert.equal((await personal.list())[0].title,'本机自定义贴纸');assert.equal((await personal.read('warm')).mime,'image/png');
 const fresh=loaded.createQQStickers({assetRoot:bundled.assets,localAssetRoot:join(local.root,'not-configured')});assert.equal((await fresh.list())[0].title,'本鱼在呢');
 await writeFile(join(local.assets,'catalog.json'),'{broken');
 await assert.rejects(loaded.createQQStickers({assetRoot:bundled.assets,localAssetRoot:local.assets}).list(),e=>e.status===503);
});
