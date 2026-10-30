import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
const source=fs.readFileSync(new URL('../vendor/widget/lib/index.js',import.meta.url),'utf8');
function helper(){const start=source.indexOf('function mediaFileCandidates(');assert.ok(start>=0,'local media path resolver must exist');const end=source.indexOf('\n}',start)+2;return runInNewContext('('+source.slice(start,end)+')',{path,LOCAL_WIDGET_ASSET_ROOT:'/fixture/home/assets/widget',PACKAGE_ROOT:'/fixture/package'});}
test('custom media precedes the same packaged fallback',()=>{const result=helper()('DSniang1.png');assert.equal(result[0],'/fixture/home/assets/widget/DSniang1.png');assert.equal(result[1],'/fixture/package/assets/DSniang1.png');});
test('executable names and path traversal never become local media overrides',()=>{const resolve=helper();for(const name of ['whale-widget.js','../config.json','../image.png','image.png?x=1','file:///tmp/a.gif','a/b.png'])assert.equal(resolve(name).length,0);});
test('all shipped route media use the resolver while executable widget sources stay packaged',()=>{for(const name of ['DSniang1.png','DSniang02.png','Ya1.mp3','Ya2.mp3','D1.mp3','D2.mp3','rua.gif','minecraft-exp-orb.wav','task-end-a.wav','cost-default.wav','ask-default.wav','approve-default.wav'])assert.ok(source.includes("mediaFileCandidates('"+name+"')"),name);const start=source.indexOf('const WIDGET_FILE_CANDIDATES = [');const end=source.indexOf(']',start);assert.doesNotMatch(source.slice(start,end),/LOCAL_WIDGET|mediaFileCandidates/);assert.match(source,/function bubbleImgFileCandidates\(file\)\s*\{\s*return mediaFileCandidates\(file\)/);});
