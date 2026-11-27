import test from 'node:test';
import assert from 'node:assert/strict';
import { nextParticipant, canContinue, normalizeAgent, makePrompt, removeParticipant } from '../src/engine.js';
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
test('invalid agents are rejected and a blank model means automatic',()=>{
  assert.throws(()=>normalizeAgent({name:'',provider:'demo'}));
  assert.equal(normalizeAgent({name:'A',provider:'ollama'}).model,'');
});
test('removing a participant keeps the next speaker', () => {
  const meeting = cursor => ({cursor, participants: ['a','b','c'].map(id => ({id}))});
  const next = m => nextParticipant(m.participants, m.cursor).id;
  // Cursor 4 means b is next (or speaking now).
  for (const [removed, expected] of [['a','b'], ['b','c'], ['c','b']]) {
    const m = meeting(4);
    assert.equal(removeParticipant(m, removed).id, removed);
    assert.equal(next(m), expected);
  }
  const last = meeting(2);
  removeParticipant(last, 'c');
  assert.equal(next(last), 'a');
});
test('unknown participants are ignored and the last one cannot be removed', () => {
  const m = {cursor: 0, participants: [{id:'a'}]};
  assert.equal(removeParticipant(m, 'missing'), null);
  assert.throws(() => removeParticipant(m, 'a'), /at least one/);
  assert.equal(m.participants.length, 1);
});
