import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {localAssetPath} from '../lib/local-assets.js';

test('local personal media is selected from the private asset directory without exposing other files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-local-assets-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'audio'));await writeFile(join(root,'audio/head.wav'),'custom audio');await writeFile(join(root,'role-preview.png'),'custom image');await writeFile(join(root,'config.json'),'private config');
  assert.equal(await localAssetPath(root,'audio/head.wav'),await realpath(join(root,'audio/head.wav')));
  assert.equal(await localAssetPath(root,'role-preview.png'),await realpath(join(root,'role-preview.png')));
  for(const name of ['config.json','../config.json','audio/../config.json','audio/%2e%2e/config.json','/etc/passwd','role-preview.png?x=y','other.png'])assert.equal(await localAssetPath(root,name),null);
  assert.equal(await localAssetPath(root,'audio/missing.wav'),null);
});

test('local media cannot follow a symlink outside its media root',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-local-assets-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'local');await mkdir(local);await writeFile(join(root,'private.png'),'private');await symlink(join(root,'private.png'),join(local,'role-preview.png'));
  assert.equal(await localAssetPath(local,'role-preview.png'),null);
});
