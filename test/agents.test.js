import test from "node:test";
import assert from "node:assert/strict";
import { addStarterAgents, starterAgents } from "../src/agent-templates.js";
import { normalizeAgent, makePrompt } from "../src/engine.js";

test("ten distinct specialist roles normalize and keep referenced skills in prompts", () => {
  assert.equal(starterAgents.length, 10);
  assert.equal(new Set(starterAgents.map((a) => a.id)).size, 10);
  for (const template of starterAgents) {
    const agent = normalizeAgent(template);
    assert.equal(agent.skills.length, 2);
    assert.equal(agent.provider, "ollama");
    const prompt = makePrompt(agent, {
      goal: "Review a launch",
      participants: [],
      transcript: [],
    });
    assert.ok(prompt.system.includes(agent.skills[0].text));
    assert.ok(prompt.system.includes("never pretend to use them"));
  }
});

test("starter team preserves customization, archived roles and meeting snapshots", () => {
  const developer = {
    ...structuredClone(starterAgents[0]),
    instructions: "Custom instructions",
  };
  const archived = structuredClone(starterAgents[1]);
  const meeting = { participants: [structuredClone(developer)] };
  const state = {
    agents: [developer],
    deletedAgents: [archived],
    meetings: [meeting],
  };
  assert.equal(addStarterAgents(state), 8);
  assert.equal(addStarterAgents(state), 0);
  assert.equal(state.agents[0].instructions, "Custom instructions");
  assert.equal(state.meetings[0], meeting);
  assert.equal(
    state.agents.some((a) => a.id === archived.id),
    false,
  );
});
