import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Message } from '../src/engine.ts';
import { nextParticipant, canContinue, normalizeAgent, makePrompt, removeParticipant, assignVoices, speakable, speechChunks, hostVoice, voices, findRepeat, withoutCopies, withoutRepeatedSentences, findMentions, mentionAt, suggestMentions, addParticipant, MAX_PARTICIPANTS } from '../src/engine.ts';
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
  const second = makePrompt({...a,provider:'codex',model:'other'} as Agent,m);
  assert.deepEqual(first,second);
  assert.match(first.system,/Evaluate tradeoffs/);
  assert.match(first.user,/Use queues/);
});
test('invalid agents are rejected and a blank model means automatic',()=>{
  assert.throws(()=>normalizeAgent({name:'',provider:'demo'}));
  assert.equal(normalizeAgent({name:'A',provider:'ollama'}).model,'');
});
test('removing a participant keeps the next speaker', () => {
  const meeting = (cursor: number) => ({cursor, participants: ['a','b','c'].map(id => ({id}))});
  const next = (m: ReturnType<typeof meeting>) => nextParticipant(m.participants, m.cursor).id;
  // Cursor 4 means b is next (or speaking now).
  for (const [removed, expected] of [['a','b'], ['b','c'], ['c','b']]) {
    const m = meeting(4);
    assert.equal(removeParticipant(m, removed)!.id, removed);
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
  const crowd = Array.from({ length: voices.length + 3 }, (): { voice?: string } => ({}));
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
const plan = 'We should run a two week pilot with fifty cups and measure how many come back each day.';
const says = (speaker: string, text: string): Message => ({ speaker, text });
test('a reply that mostly copies an earlier agent message is a repeat', () => {
  const history = [says('Host', 'Where do we start?'), says('Sales', plan)];
  assert.equal(findRepeat(plan, history), history[1]);
  assert.equal(findRepeat('I agree. ' + plan + ' Thanks.', history), history[1]);
  assert.equal(findRepeat('Who empties the return bin during the morning rush, and what happens when it is full?', history), null);
  // Quoting the host, or using the same topic words, is not a repeat.
  assert.equal(findRepeat('Where do we start?', history), null);
  assert.equal(findRepeat('A pilot is fine, but fifty cups may run out before the dishwasher finishes its first cycle.', history), null);
  assert.equal(findRepeat('Yes.', [says('QA', 'yes')])!.speaker, 'QA');
});
test('copies are left out of the prompt and sentences are not doubled', () => {
  const history = [says('A', plan), says('B', plan), says('Host', plan), says('C', 'Something entirely different about who washes the cups and when they do it.')];
  assert.deepEqual(withoutCopies(history).map(m => m.speaker), ['A', 'Host', 'C']);
  const agent = normalizeAgent({ name: 'B', provider: 'ollama' });
  assert.equal(JSON.parse(makePrompt(agent, { goal: 'g', participants: [], transcript: history }).user).transcript.length, 3);
  assert.equal(withoutRepeatedSentences('We need a clear owner for this. We need a clear owner for this. Who is it?'), 'We need a clear owner for this. Who is it?');
  assert.equal(withoutRepeatedSentences('Line one is long enough here.\n\nLine two is also long enough.'), 'Line one is long enough here.\n\nLine two is also long enough.');
});
test('tags match whole names, the longest first, and ignore addresses', () => {
  const people = ['Product', 'Product Manager', 'QA', "Devil's Advocate"].map(name => ({ name }));
  const names = (text: string) => findMentions(text, people).map(p => p.name);
  assert.deepEqual(names('@qa then @Product Manager, and @QA again'), ['QA', 'Product Manager']);
  assert.deepEqual(names("(@Devil's Advocate) @Product?"), ["Devil's Advocate", 'Product']);
  assert.deepEqual(names('mail me@qa.example, ask @QAx or @Nobody'), []);
  assert.equal(speakable('@QA please check'), 'QA please check');
});
test('autocomplete follows the tag being typed', () => {
  assert.deepEqual(mentionAt('hi @prod', 8), { start: 3, query: 'prod' });
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.equal(mentionAt('me@qa', 5), null);
  assert.equal(mentionAt('@qa\nmore', 8), null);
  const people = ['Product Manager', 'Project Manager', 'Customer Success'].map(name => ({ name }));
  const found = (q: string) => suggestMentions(q, people).map(p => p.name);
  assert.deepEqual(found('pro'), ['Product Manager', 'Project Manager']);
  assert.deepEqual(found('man'), ['Product Manager', 'Project Manager']);
  assert.deepEqual(found('Product Manager '), []);
});
test('a directly tagged agent is told to answer, once', () => {
  const agent = normalizeAgent({ name: 'QA', provider: 'claude' });
  const meeting = (transcript: Message[]) => ({ goal: 'g', participants: [agent], transcript });
  assert.match(makePrompt(agent, meeting([says('Host', '@QA what breaks?')])).system, /addressed you directly/);
  assert.doesNotMatch(makePrompt(agent, meeting([says('Host', '@QA what breaks?'), says('QA', 'The bin.')])).system, /addressed you directly/);
  assert.doesNotMatch(makePrompt(agent, meeting([says('Host', 'What breaks?')])).system, /addressed you directly/);
});
test('adding a participant keeps the next speaker', () => {
  // Cursor 4 of three means b is next (or speaking now).
  const meeting = { cursor: 4, participants: ['a', 'b', 'c'].map(id => ({ id, name: id })) };
  addParticipant(meeting, { id: 'd', name: 'd' });
  assert.equal(nextParticipant(meeting.participants, meeting.cursor).id, 'b');
  assert.deepEqual(meeting.participants.map(p => p.id), ['a', 'b', 'c', 'd']);
  // The one who left and returns is also last, and the rotation reaches them.
  removeParticipant(meeting, 'a');
  addParticipant(meeting, { id: 'a', name: 'a' });
  assert.equal(nextParticipant(meeting.participants, meeting.cursor).id, 'b');
});
test('a meeting refuses duplicates, shared names and a thirteenth agent', () => {
  const meeting = { participants: [{ id: 'a', name: 'QA' }] };
  assert.throws(() => addParticipant(meeting, { id: 'a', name: 'Other' }), /already/);
  assert.throws(() => addParticipant(meeting, { id: 'b', name: 'qa' }), /already/);
  for (let i = 1; i < MAX_PARTICIPANTS; i++) addParticipant(meeting, { id: 'n' + i, name: 'N' + i });
  assert.throws(() => addParticipant(meeting, { id: 'z', name: 'Z' }), /at most 12/);
  assert.equal(meeting.participants.length, MAX_PARTICIPANTS);
});
