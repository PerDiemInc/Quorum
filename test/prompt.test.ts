import test from "node:test";
import assert from "node:assert/strict";
import { appendFiles, handoffPrompt, MAX_APPENDED_CHARS } from "../src/handoff.ts";
import { handoffContext, normalizeAgent } from "../src/engine.ts";
import type { Meeting } from "../src/engine.ts";
import { fakeModel, startServer } from "./helpers/server.ts";

const writer = normalizeAgent({ id: "d", name: "Developer", provider: "ollama", model: "fake", files: false });
const meeting: Meeting = {
  id: "m",
  goal: "A reusable cup program",
  agenda: "Returns",
  participants: [writer],
  status: "paused",
  transcript: [
    { speaker: "Host", text: "Keep it under a week." },
    { speaker: "Developer", text: "Draft.\n```file:site/index.html\n<h1>Cups</h1>\n```" },
    { speaker: "Developer", text: "Better.\n```file:site/index.html\n<h1>Cups, returned</h1>\n```\n````file:README.md\n```sh\nnpm start\n```\n````" },
  ],
};

test("files are appended whole, fenced safely, and within a limit", () => {
  const files = [
    { path: "old.js", content: "o".repeat(MAX_APPENDED_CHARS) },
    { path: "a.md", content: "```\ninside\n````\n" },
    { path: "b.html", content: "<p>no newline</p>" },
  ];
  const text = appendFiles("Build it.\n```js\nunclosed", files);
  // A block the writer left open is closed before the files.
  assert.match(text, /^Build it\.\n```js\nunclosed\n```\n\n## Current versions/);
  assert.match(text, /### a\.md\n\n`````md\n```\ninside\n````\n`````/);
  assert.match(text, /### b\.html\n\n```html\n<p>no newline<\/p>\n```/);
  assert.match(text, /Left out because of their size[^\n]*old\.js/);
  assert.ok(!text.includes("ooooo"));
  assert.equal(appendFiles("Nothing to add.", []), "Nothing to add.");
});

test("the writer sees the newest discussion that fits, and is asked for a long reply", () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ speaker: "Host", text: i + " " + "word ".repeat(700) }));
  const prompt = handoffPrompt({ ...meeting, transcript: long });
  const sent = JSON.parse(prompt.user) as { transcript: Array<{ text: string }> };
  assert.ok(sent.transcript.length < 40);
  assert.match(sent.transcript.at(-1)!.text, /^39 /);
  assert.ok(prompt.user.length < 50_000);
  assert.equal(prompt.long, true);
  assert.match(prompt.system, /Goal, Context, Decisions, Requirements, Design direction, Constraints and security, Acceptance criteria/);
});

test("the prompt endpoint writes with the model, appends the files and runs one turn at a time", async (t) => {
  let release = () => {};
  let wait: Promise<void> | null = null;
  const model = await fakeModel(t, async () => {
    await wait;
    return "## Goal\nBuild the cup program.";
  });
  const server = await startServer(t, { OLLAMA_URL: model.url });
  const body = { agent: writer, meeting: handoffContext(meeting) };
  for (const origin of ["http://evil.test", "null"])
    assert.equal((await server.send("/api/prompt", body, { origin })).status, 403);
  assert.equal((await server.send("/api/prompt", { agent: writer, meeting: {} })).status, 400);
  assert.equal(model.requests.length, 0);

  const response = await server.send("/api/prompt", body);
  assert.equal(response.status, 200);
  const { text, model: used } = (await response.json()) as { text: string; model: string };
  assert.equal(used, "fake");
  assert.match(text, /^## Goal\nBuild the cup program\./);
  assert.match(text, /### site\/index\.html\n\n```html\n<h1>Cups, returned<\/h1>\n```/);
  assert.match(text, /### README\.md\n\n````md\n```sh\nnpm start\n```\n````/);
  assert.ok(!text.includes("<h1>Cups</h1>"));
  const sent = JSON.parse(model.requests[0]) as { options: { num_predict: number; num_ctx: number }; messages: Array<{ content: string }> };
  // Far more room than a spoken turn, although this agent may not create files.
  assert.equal(sent.options.num_predict, 8000);
  assert.ok(sent.options.num_ctx >= 12_288);
  assert.match(sent.messages[0].content, /one self-contained prompt/);

  wait = new Promise((resolve) => (release = resolve));
  const slow = server.send("/api/prompt", body);
  while (model.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await server.send("/api/prompt", body)).status, 409);
  assert.equal((await server.send("/api/turn", body)).status, 409);
  release();
  assert.equal((await slow).status, 200);
});
