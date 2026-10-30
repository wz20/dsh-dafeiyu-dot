import {realpath,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

/** Personal media is loaded from the runtime data directory, outside the source tree. */
export async function localAssetPath(root,name){
  if(typeof root!=='string'||typeof name!=='string'||!(name==='role-preview.png'||/^audio\/[a-z0-9_-]+\.(wav|mp3|ogg)$/.test(name)))return null;
  try{
    const base=await realpath(root),file=await realpath(resolve(base,name));
    if(!file.startsWith(base+sep))return null;
    const info=await stat(file);
    return info.isFile()&&info.size>0&&info.size<=15_000_000?file:null;
  }catch{return null;}
}
