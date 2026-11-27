import test from 'node:test';
import assert from 'node:assert/strict';
import { nextParticipant, canContinue, normalizeAgent, makePrompt, defaultModels, assignVoices, speakable, speechChunks, hostVoice, voices } from '../src/engine.js';
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
test('command-line agents saved without a model get the default', () => {
  assert.equal(normalizeAgent({ name: 'A', provider: 'claude', model: ' ' }).model, 'sonnet');
  assert.equal(normalizeAgent({ name: 'A', provider: 'codex' }).model, defaultModels.codex);
  assert.equal(normalizeAgent({ name: 'A', provider: 'claude', model: 'opus' }).model, 'opus');
  assert.equal(normalizeAgent({ name: 'A', provider: 'demo' }).model, '');
});
test('every agent gets its own voice and unique choices are kept', () => {
  const library = Array.from({ length: 12 }, (_, i) => ({ id: String(i), voice: i === 5 ? 'af_heart' : '' }));
  assignVoices(library);
  assert.equal(library[5].voice, 'af_heart');
  assert.equal(new Set(library.map(a => a.voice)).size, 12);
  assert.ok(!library.some(a => a.voice === hostVoice));
  const team = [{ id: '3', voice: '' }, { id: '7', voice: '' }, { id: '8', voice: library[3].voice }];
  assignVoices(team, library);
  assert.equal(team[1].voice, library[7].voice);
  assert.equal(new Set(team.map(a => a.voice)).size, 3);
  const crowd = Array.from({ length: voices.length + 3 }, () => ({}));
  assignVoices(crowd);
  assert.ok(crowd.every(a => a.voice));
});
test('speech drops Markdown and splits long text between sentences', () => {
  assert.equal(speakable('## Plan\n- **Relay**: use `v2.5`\n- See [the doc](http://x.test) at https://x.test/a.'), 'Plan. Relay: use v2.5. See the doc at link.');
  const text = 'One is here. Two follows it! Is three last? ' + 'word '.repeat(80);
  const parts = speechChunks(text.trim(), 30);
  assert.equal(parts.join(' '), text.trim());
  assert.equal(parts[0], 'One is here. Two follows it!');
});
