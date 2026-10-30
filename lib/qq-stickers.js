import {open,realpath} from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_IMAGE_BYTES=4*1024*1024;
const MAX_CATALOG_BYTES=32768;
const ID=/^[a-z][a-z0-9_-]{0,63}$/;
const FILE=/^[a-z0-9][a-z0-9_-]{0,79}\.(png|gif|webp|jpg)$/;
const MIMES={png:'image/png',gif:'image/gif',webp:'image/webp',jpg:'image/jpeg'};

export class QQStickerError extends Error {
  constructor(message,status=503){super(message);this.name='QQStickerError';this.status=status;}
}
const unavailable=()=>new QQStickerError('QQ内置表情暂时无法读取，请稍后重试。');
const invalidId=()=>new QQStickerError('请选择当前目录中的表情。',400);
function label(value,max) {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/u.test(value)||/(?:https?|file):\/\//iu.test(value))throw unavailable();
  return value.trim();
}
function catalogEntry(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!ID.test(value.id)||typeof value.file!=='string'||!FILE.test(value.file))throw unavailable();
  const expected=MIMES[value.file.slice(value.file.lastIndexOf('.')+1)];
  if(value.mime!==expected||!Array.isArray(value.tags)||value.tags.length>8||typeof value.emotion!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(value.emotion))throw unavailable();
  return {id:value.id,title:label(value.title,120),emotion:value.emotion,tags:value.tags.map(tag=>label(tag,80)),file:value.file,mime:expected};
}
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function png(bytes) {
  if(bytes.length<57||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
  let offset=8,sawData=false,sawHeader=false;
  while(offset+12<=bytes.length){
    const size=bytes.readUInt32BE(offset),end=offset+12+size;
    if(end>bytes.length)return false;
    const type=bytes.toString('ascii',offset+4,offset+8);
    if(!/^[a-z]{4}$/i.test(type)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))return false;
    if(!sawHeader){if(type!=='IHDR'||size!==13)return false;const width=bytes.readUInt32BE(offset+8),height=bytes.readUInt32BE(offset+12);if(!width||!height||width>8192||height>8192||width*height>64_000_000)return false;sawHeader=true;}
    else if(type==='IHDR')return false;
    if(type==='IDAT')sawData=true;
    if(type==='IEND')return size===0&&sawData&&end===bytes.length;
    offset=end;
  }
  return false;
}
function mimeOf(bytes) {
  if(png(bytes))return 'image/png';
  if(bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0&&bytes.at(-1)===0x3b)return 'image/gif';
  if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)===bytes.length-8){
    let offset=12,sawImage=false;
    while(offset+8<=bytes.length){const type=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),end=offset+8+size+(size%2);if(end>bytes.length)return undefined;if(['VP8 ','VP8L','VP8X'].includes(type)&&size>0)sawImage=true;offset=end;}
    if(offset===bytes.length&&sawImage)return 'image/webp';
  }
  if(bytes.length>=12&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9)return 'image/jpeg';
}
async function limitedFile(path,limit) {
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const info=await handle.stat();if(!info.isFile()||!info.size||info.size>limit)throw unavailable();
    const bytes=Buffer.alloc(limit+1);let length=0;
    while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;if(length>limit)throw unavailable();}
    return Buffer.from(bytes.subarray(0,length));
  }
  finally{await handle.close();}
}

/** The host selects a local custom catalog or the bundled public catalog. */
export function createQQStickers({assetRoot=new URL('../assets/stickers/',import.meta.url),localAssetRoot}={}) {
  let root;
  try{root=resolve(typeof localAssetRoot==='string'&&existsSync(join(localAssetRoot,'catalog.json'))?localAssetRoot:assetRoot instanceof URL?fileURLToPath(assetRoot):assetRoot);}catch{throw unavailable();}
  let pending;
  const load=()=>pending??=(async()=>{
    try{
      const base=await realpath(root),body=await limitedFile(join(base,'catalog.json'),MAX_CATALOG_BYTES),manifest=JSON.parse(body.toString('utf8'));
      if(manifest?.version!==1||!Array.isArray(manifest.stickers)||manifest.stickers.length>32)throw unavailable();
      const entries=new Map();for(const value of manifest.stickers){const entry=catalogEntry(value);if(entries.has(entry.id))throw unavailable();entries.set(entry.id,entry);}
      return {base,entries};
    }catch{pending=undefined;throw unavailable();}
  })();
  return {
    async list(){const {entries}=await load();return [...entries.values()].map(({id,title,emotion,tags})=>({id,title,emotion,tags:[...tags]}));},
    async read(id,{signal}={}){
      signal?.throwIfAborted();if(typeof id!=='string'||!ID.test(id))throw invalidId();
      try{
        const {base,entries}=await load();signal?.throwIfAborted();const entry=entries.get(id);if(!entry)throw invalidId();
        const path=join(base,entry.file),actual=await realpath(path);signal?.throwIfAborted();if(dirname(actual)!==base)throw unavailable();
        const bytes=await limitedFile(path,MAX_IMAGE_BYTES);signal?.throwIfAborted();if(mimeOf(bytes)!==entry.mime)throw unavailable();
        return {id:entry.id,bytes,mime:entry.mime,summary:entry.title};
      }catch(error){signal?.throwIfAborted();if(error instanceof QQStickerError)throw error;throw unavailable();}
    }
  };
}
