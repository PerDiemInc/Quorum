import assert from "node:assert/strict";

/** Smoke-test the running app without changing the user's agents or meetings. */
const base = process.env.QUORUM_URL ?? "http://127.0.0.1:4710";
const model = process.env.SMOKE_MODEL ?? "qwen2.5:0.5b";
const headers = { "content-type": "application/json", origin: base };
assert.equal((await fetch(base + "/api/health")).status, 200);
assert.equal(
  (
    await fetch(base + "/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).status,
  403,
);
const settings = await (await fetch(base + "/api/models")).json();
assert.equal(settings.ollama.available, true);
assert.ok(
  settings.ollama.models.some((m) => m.name === model),
  "Pull the smoke model first",
);
const response = await fetch(base + "/api/turn", {
  method: "POST",
  headers,
  signal: AbortSignal.timeout(180_000),
  body: JSON.stringify({
    agent: {
      name: "Smoke test",
      provider: "ollama",
      model,
      instructions: "Answer in one short sentence.",
      skills: [],
    },
    meeting: {
      goal: "Say hello to the team.",
      participants: [{ name: "Smoke test" }],
      transcript: [],
    },
  }),
});
assert.equal(response.status, 200);
const result = await response.json();
assert.ok(result.text?.length > 0);
assert.ok(!result.text.includes("[Demo only]"));
console.log(
  "PASS: health, origin protection, model discovery, real model response.",
);
console.log(result.text);
