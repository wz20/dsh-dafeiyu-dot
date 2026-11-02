import test from 'node:test';
import assert from 'node:assert/strict';
import {posix,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveAssetPath} from '../lib/asset-path.js';

const windowsRoot=fileURLToPath(new URL('file:///C:/Plugins/%E5%A4%A7%E8%82%A5%E9%B1%BC/assets/'),{windows:true});
const cases=[['Windows',win32,windowsRoot],['POSIX',posix,'/opt/whale companion/assets/']];

for(const [platform,paths,root] of cases){
 test(platform+' serves bundled resources from a file URL directory with a trailing separator',()=>{
  for(const name of ['icon.png','icons/phone.svg','settings.css','memory-graph.js','audio/head.wav'])assert.equal(resolveAssetPath(root,name,paths),paths.resolve(root,name));
  assert.equal(resolveAssetPath(paths.resolve(root),'icons/phone.svg',paths),paths.resolve(root,'icons/phone.svg'));
 });
 test(platform+' blocks traversal, absolute paths and same-prefix sibling folders',()=>{
  for(const name of ['../private.svg','../assets-other/icon.png','icons/../../private.svg',paths.resolve(root,'icon.png'),'','.', 'icons/..','icon.png\0.svg'])assert.throws(()=>resolveAssetPath(root,name,paths),error=>error.status===404,name);
 });
 test(platform+' accepts a child directory whose name begins with dots',()=>{
  assert.equal(resolveAssetPath(root,'..theme/icon.png',paths),paths.resolve(root,'..theme/icon.png'));
 });
}

test('Windows handles URL slashes, filesystem slashes, Unicode and directory casing',()=>{
 for(const name of ['icons\\phone.svg','icons/phone.svg','icons\\nested/../phone.svg','../ASSETS/icons/phone.svg'])assert.equal(win32.relative(windowsRoot,resolveAssetPath(windowsRoot,name,win32)).toLowerCase(),'icons\\phone.svg');
});

test('Windows rejects drive-relative, rooted, cross-drive and UNC request names',()=>{
 for(const name of ['C:icons\\phone.svg','D:icons\\phone.svg','D:\\assets\\icon.png','\\icons\\phone.svg','\\\\server\\share\\icon.png','..\\private.svg','..\\assets-copy\\icon.png'])assert.throws(()=>resolveAssetPath(windowsRoot,name,win32),error=>error.status===404,name);
});

test('Windows supports an installation on a UNC share without accepting a different share',()=>{
 const root='\\\\server\\plugins\\assets\\';
 assert.equal(resolveAssetPath(root,'icons/phone.svg',win32),'\\\\server\\plugins\\assets\\icons\\phone.svg');
 assert.throws(()=>resolveAssetPath(root,'\\\\server\\other\\icon.png',win32),error=>error.status===404);
});

test('filesystem root directories retain the same relative-child rule',()=>{
 assert.equal(resolveAssetPath('/','icons/phone.svg',posix),'/icons/phone.svg');
 assert.equal(resolveAssetPath('C:\\','icons/phone.svg',win32),'C:\\icons\\phone.svg');
 for(const value of [null,undefined,42,[],{}])assert.throws(()=>resolveAssetPath(windowsRoot,value,win32),error=>error.status===404);
});
