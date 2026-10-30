import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../lib/group-persona.js';

test('group execution guard blocks inherited local tools as well as filesystem and delegation capabilities',()=>{
  let guard,presentation;const sections=[];
  apply({tools:{guard:fn=>guard=fn,presentAs:mode=>presentation=mode},systemPrompt:{section:s=>sections.push(s)}});
  assert.equal(presentation,'native');assert.equal(typeof guard,'function');
  for(const name of ['bash','read','qqbot_send_file','working_directory','spawn_teammate','send_message','run_code','unknown_future_tool'])
    assert.equal(typeof guard({name,arguments:{name:'dafeiyu_memory_search'}}),'string',name);
  for(const name of ['dafeiyu_memory_search','dafeiyu_memory_save','dafeiyu_memory_forget','dafeiyu_memory_index','dafeiyu_memory_read','dafeiyu_qq_stickers','dafeiyu_qq_sticker'])
    assert.equal(guard({name}),undefined,name);
  assert.equal(sections.length,1);
});
