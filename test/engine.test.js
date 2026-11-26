import test from 'node:test';
import assert from 'node:assert/strict';
import { nextParticipant, canContinue, normalizeAgent, makePrompt } from '../src/engine.js';
test('participants take turns in order and repeat', () => {
  const p = [{name:'A'},{name:'B'}];
  assert.equal(nextParticipant(p,0).name,'A');
  assert.equal(nextParticipant(p,1).name,'B');
  assert.equal(nextParticipant(p,2).name,'A');
  assert.throws(()=>nextParticipant([],0));
});
test('only host acceptance ends the meeting, budget pauses it', () => {
  assert.equal(canContinue({status:'paused'},0,12),true);
  assert.equal(canContinue({status:'accepted'},0,12),false);
  assert.equal(canContinue({status:'running'},12,12),false);
  assert.equal(canContinue({status:'running'},60,999),false);
});
test('model override preserves identity and skill instructions', () => {
  const a = normalizeAgent({name:'CTO',provider:'ollama',model:'qwen',skills:[{name:'Architecture',text:'Evaluate tradeoffs'}]});
  const m = {goal:'Design API',agenda:'Latency',participants:[a],transcript:[{speaker:'Host',text:'Use queues'}]};
  const first = makePrompt(a,m);
  const second = makePrompt({...a,provider:'codex',model:'other'},m);
  assert.deepEqual(first,second);
  assert.match(first.system,/Evaluate tradeoffs/);
  assert.match(first.user,/Use queues/);
});
test('invalid agents and missing model names are rejected',()=>{
  assert.throws(()=>normalizeAgent({name:'',provider:'demo'}));
  assert.throws(()=>normalizeAgent({name:'A',provider:'ollama'}));
});
