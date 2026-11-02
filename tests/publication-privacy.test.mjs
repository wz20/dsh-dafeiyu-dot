import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('publication checks reject a Breeze-shaped key in source and identify an intentional test fixture',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-publication-privacy-'));
 try{
  const key='brz_'+'synthetic'.repeat(4);
  await writeFile(join(root,'index.js'),'export const key='+JSON.stringify(key)+';');
  await mkdir(join(root,'tests'));await writeFile(join(root,'tests','fixture.mjs'),'const key='+JSON.stringify(key)+';');
  const result=spawnSync('python3',[fileURLToPath(new URL('../scripts/check-release-privacy.py',import.meta.url)),root,'--fail-on-risk'],{encoding:'utf8'});
  assert.equal(result.status,1);const report=JSON.parse(result.stdout);
  assert.equal(report.riskCount,1);assert.equal(report.reviewCount,1);
  assert.ok(report.findings.some(item=>item.path==='index.js'&&item.category==='credential-shaped-text'));
  assert.ok(report.findings.some(item=>item.path==='tests/fixture.mjs'&&item.category==='synthetic-credential-review'));
  assert.doesNotMatch(result.stdout,new RegExp(key));
 }finally{await rm(root,{recursive:true,force:true});}
});
