import test from "node:test";
import assert from "node:assert/strict";
import { freshTurn } from "../src/turn.ts";
import { normalizeAgent } from "../src/engine.ts";
import type { Agent, Prompt } from "../src/engine.ts";

const old = "We should run a two week pilot with fifty cups and measure how many come back each day.";
const fresh = "Who empties the return bin during the morning rush, and what happens once it is full?";
const agent = normalizeAgent({ name: "Ops", provider: "ollama" });
const meeting = { goal: "Cups", participants: [agent], transcript: [{ speaker: "Sales", text: old }] };
const script = (...replies: string[]) => {
  const calls: Array<{ prompt: Prompt; options: { attempt: number } }> = [];
  const ask = async (
    _agent: Agent,
    prompt: Prompt,
    _signal: AbortSignal | undefined,
    options: { attempt: number },
  ) => {
    calls.push({ prompt, options });
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  return { ask, calls };
};

test("a new reply is accepted at once", async () => {
  const { ask, calls } = script(fresh);
  assert.deepEqual(await freshTurn(agent, meeting, undefined, ask), { text: fresh });
  assert.equal(calls.length, 1);
});
test("a repeat is asked again with the reason and without the copied message", async () => {
  const { ask, calls } = script(old, fresh);
  assert.deepEqual(await freshTurn(agent, meeting, undefined, ask), { text: fresh });
  assert.equal(calls[1].options.attempt, 1);
  assert.match(calls[1].prompt.system, /refused because it repeated/);
  assert.equal(JSON.parse(calls[1].prompt.user).transcript.length, 0);
});
test("an agent that only repeats is skipped after three tries", async () => {
  const { ask, calls } = script(old);
  assert.deepEqual(await freshTurn(agent, meeting, undefined, ask), { skipped: true });
  assert.equal(calls.length, 3);
});
test("demo placeholders are never skipped", async () => {
  const { ask } = script(old);
  assert.deepEqual(await freshTurn({ ...agent, provider: "demo" }, meeting, undefined, ask), { text: old });
});
