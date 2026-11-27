import test from "node:test";
import assert from "node:assert/strict";
import { addStarterAgents, starterAgents } from "../src/agent-templates.js";
import { normalizeAgent, makePrompt } from "../src/engine.js";

test("distinct specialist roles normalize and keep their skills in prompts", () => {
  assert.equal(starterAgents.length, 22);
  assert.equal(new Set(starterAgents.map((a) => a.id)).size, 22);
  assert.equal(new Set(starterAgents.map((a) => a.name)).size, 22);
  for (const template of starterAgents) {
    const agent = normalizeAgent(template);
    assert.equal(agent.skills.length, 2);
    assert.equal(agent.provider, "ollama");
    assert.ok(["Build", "Product", "Grow", "Run"].includes(agent.category), agent.name);
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
  delete developer.category;
  assert.equal(addStarterAgents(state), 20);
  assert.equal(developer.category, "Build");
  assert.equal(addStarterAgents(state), 0);
  assert.equal(state.agents[0].instructions, "Custom instructions");
  assert.equal(state.meetings[0], meeting);
  assert.equal(
    state.agents.some((a) => a.id === archived.id),
    false,
  );
});
