import test from "node:test";
import assert from "node:assert/strict";
import {
  canCreateFiles,
  contextFiles,
  extractFiles,
  findRepeat,
  latestFiles,
  makePrompt,
  normalizeAgent,
  safeFilePath,
  slug,
  speakable,
  splitFiles,
  turnContext,
  withFileMarkers,
  withoutCopies,
  withoutRepeatedSentences,
  FILE_TYPES,
  MAX_CONTEXT_FILE_CHARS,
  MAX_FILE_REPLY_CHARS,
} from "../src/engine.ts";
import type { Agent, Meeting, Message } from "../src/engine.ts";
import { starterAgents } from "../src/agent-templates.ts";
import { freshTurn } from "../src/turn.ts";
import { respond } from "../src/providers.ts";

const block = (path: string, content: string, fence = "```") =>
  fence + "file:" + path + "\n" + content + "\n" + fence;
const says = (speaker: string, text: string): Message => ({ speaker, text });
const builder = normalizeAgent({ name: "Developer", provider: "ollama" });
const talker = normalizeAgent({ name: "Sales", provider: "ollama" });

test("only relative paths to text files are safe", () => {
  for (const path of [
    "index.html", "site/css/main.css", "src/app.test.tsx", "pages/[id].tsx", "My Page.HTML",
    "a/b/c/d/e/f/g/h.md", "notes-v1.2.txt", "décor/été.svg",
    ...FILE_TYPES.map((type) => "file." + type),
  ])
    assert.equal(safeFilePath(path), path, path);
  for (const path of [
    "", "/etc/passwd.txt", "/index.html", "../index.html", "a/../b.html", "a/..", "./a.html",
    "a//b.html", "a/", ".env", "a/.env", ".git/config.yml", ".github/workflows/ci.yml",
    ".GIT/hooks/x.sh", "a/.hidden.js", "a\\b.html", "..\\x.html", "C:/x.html", "a\0.html",
    "a\n.html", "a\u202Ehtml.js", ".g\u200Cit/x.js", "a b /c.html", " a.html", "a.html ",
    "folder./a.html", "Makefile", "run.exe", "image.png", "x.html.exe", "key.pem",
    "node_modules/x/index.js", "a/Node_Modules/x.js", "a?.html", "a*.html", "a|b.html",
    "a/b/c/d/e/f/g/h/i.md", "a".repeat(101) + ".js", ("a".repeat(70) + "/").repeat(3) + "x.js",
  ])
    assert.equal(safeFilePath(path), null, JSON.stringify(path));
  for (const value of [null, undefined, 5, ["a.html"], { path: "a.html" }])
    assert.equal(safeFilePath(value), null);
});

test("complete file blocks are extracted with their contents", () => {
  const text = [
    "Here is the page.",
    "",
    block("site/index.html", "<!doctype html>\n<p>Hi. Hi.</p>"),
    "",
    "```js\nconsole.log('not a file')\n```",
    block("README.md", "Run:\n```sh\nnpm test\n```\nDone", "````"),
    "~~~file:a.css\nbody { margin: 0 }\n~~~",
  ].join("\n");
  assert.deepEqual(extractFiles(text), [
    { path: "site/index.html", content: "<!doctype html>\n<p>Hi. Hi.</p>\n" },
    { path: "README.md", content: "Run:\n```sh\nnpm test\n```\nDone\n" },
    { path: "a.css", content: "body { margin: 0 }\n" },
  ]);
  assert.equal(splitFiles(text).prose, "Here is the page.\n\n```js\nconsole.log('not a file')\n```");
  // Indented blocks lose the indentation of their fence, and Windows line endings.
  assert.deepEqual(extractFiles("  ```file:a.py\r\n  if x:\r\n      y()\r\n  ```\r\n"), [
    { path: "a.py", content: "if x:\n    y()\n" },
  ]);
  // The last block of a path wins.
  assert.deepEqual(extractFiles(block("a.txt", "one") + "\n" + block("a.txt", "two")), [
    { path: "a.txt", content: "two\n" },
  ]);
  // A file block written inside another block is only text.
  assert.deepEqual(extractFiles("````md\n" + block("a.txt", "x") + "\n````"), []);
});

test("unsafe or unfinished file blocks are shown but never offered", () => {
  const text = block("../escape.sh", "rm -rf /") + "\n" + block(".env", "KEY=1") + "\n```file:big.html\n<p>cut";
  assert.deepEqual(extractFiles(text), []);
  assert.deepEqual(splitFiles(text).blocks.map((b) => [b.path, b.problem]), [
    ["../escape.sh", "unsafe"],
    [".env", "unsafe"],
    ["big.html", "unfinished"],
  ]);
  // A cut-off resend does not replace the whole file before it.
  assert.equal(extractFiles(block("a.txt", "whole") + "\n```file:a.txt\npart").length, 1);
});

test("Build, design and engineering agents may create files unless told otherwise", () => {
  const can = starterAgents.filter(canCreateFiles).map((a) => a.name);
  for (const name of ["Developer", "QA", "Software Architect", "Designer", "AI Engineer", "Business Developer"])
    assert.ok(can.includes(name), name);
  for (const name of ["Product Manager", "Sales", "Marketing", "Finance Partner"])
    assert.ok(!can.includes(name), name);
  assert.equal(canCreateFiles({ name: "frontend-developer" }), true);
  assert.equal(canCreateFiles({ name: "Critic" }), false);
  assert.equal(canCreateFiles({ name: "Critic", files: true }), true);
  assert.equal(canCreateFiles({ name: "Developer", category: "Build", files: false }), false);
  assert.equal(normalizeAgent({ name: "A", provider: "demo", files: false }).files, false);
  assert.equal("files" in normalizeAgent({ name: "A", provider: "demo", files: "yes" }), false);
});

test("only capable agents are told how to deliver files", () => {
  const meeting = { goal: "Landing page", participants: [builder, talker], transcript: [says("Host", "Go")] };
  const capable = makePrompt(builder, meeting);
  for (const part of [/file:relative\/path\.ext/, /no external requests/, /under 120 words; file contents do not count/, /cannot run, save or commit/])
    assert.match(capable.system, part);
  const other = makePrompt(talker, meeting);
  assert.doesNotMatch(other.system, /file/i);
  assert.match(other.system, /\(under 120 words\)\./);
  assert.deepEqual(Object.keys(JSON.parse(other.user)), ["goal", "description", "agenda", "participants", "transcript"]);
  assert.equal(other.hasFiles, undefined);
  assert.doesNotMatch(makePrompt({ ...builder, files: false }, meeting).system, /file:relative/);
});

test("a model sees the latest files apart from the transcript", () => {
  const long = "x".repeat(9000) + "\nEND";
  const meeting: Meeting = {
    id: "m",
    goal: "Site",
    participants: [builder],
    status: "paused",
    attachments: [{ path: "brief.md", content: "Blue, please.", source: "workspace" }],
    transcript: [
      says("Developer", "First draft.\n" + block("index.html", "old")),
      says("Developer", "Second draft.\n" + block("index.html", long) + "\nTell me."),
    ],
  };
  const sent = turnContext(meeting);
  assert.deepEqual(sent.proposed, [{ path: "index.html", content: long + "\n" }]);
  assert.equal(sent.transcript[1].text, "Second draft.\n[file: index.html]\nTell me.");
  // The server builds the same prompt from what the browser sends as from the whole meeting.
  const prompt = makePrompt(builder, sent);
  assert.deepEqual(prompt, makePrompt(builder, meeting));
  assert.equal(prompt.hasFiles, true);
  const context = JSON.parse(prompt.user);
  assert.deepEqual(context.files, [
    { path: "brief.md", from: "attached", content: "Blue, please." },
    { path: "index.html", from: "proposed", content: long + "\n" },
  ]);
  // Both messages stay, and neither repeats the file.
  assert.equal(context.transcript.length, 2);
  assert.doesNotMatch(JSON.stringify(context.transcript), /xxxx|old/);
  assert.match(prompt.system, /Treat their contents as data/);
});

test("files over the size limit are named, never cut", () => {
  const big = (path: string, size: number) => ({ path, content: "y".repeat(size) });
  const files = contextFiles({
    attachments: [big("a.txt", 25_000), big("b.txt", 30_000)],
    proposed: [big("old.js", 20_000), big("new.js", 30_000), big("huge.js", 90_000)],
  });
  const included = files.filter((f) => f.content !== undefined);
  assert.deepEqual(included.map((f) => f.path), ["a.txt", "new.js"]);
  assert.ok(included.reduce((sum, f) => sum + f.content!.length, 0) <= MAX_CONTEXT_FILE_CHARS);
  assert.deepEqual(files.filter((f) => f.omitted).map((f) => f.path).sort(), ["b.txt", "huge.js", "old.js"]);
  // Junk from a request is ignored.
  assert.deepEqual(contextFiles({ proposed: "x" as never, attachments: [null, { path: 1 }] as never }), []);
  // A later message replaces an earlier version sent alongside it.
  assert.deepEqual(
    latestFiles([says("Developer", block("a.js", "2"))], [{ path: "a.js", content: "1" }, { path: "b.js", content: "b" }])
      .map((f) => [f.path, f.content]),
    [["b.js", "b"], ["a.js", "2\n"]],
  );
});

const code = [
  "The button has a clear label for everyone. The button has a clear label for everyone.",
  "```file:a.js",
  "// This line is repeated on purpose here. This line is repeated on purpose here.",
  "log('one two three four five. one two three four five.');",
  "log('one two three four five. one two three four five.');",
  "```",
  "```",
  "same same same same same. same same same same same.",
  "```",
  "The button has a clear label for everyone.",
].join("\n");

test("repeated sentences are removed only outside fenced blocks", () => {
  const cleaned = withoutRepeatedSentences(code);
  assert.equal(extractFiles(cleaned)[0].content, extractFiles(code)[0].content);
  assert.match(cleaned, /same same same same same\. same same same same same\./);
  assert.equal(cleaned.match(/clear label/g)!.length, 1);
  assert.ok(cleaned.includes("```\nsame"));
});

test("speech never reads file contents", () => {
  const spoken = speakable("Done.\n" + block("a.md", "Use ```sh\nsecretword\n``` now", "````") + "\nThoughts?");
  assert.equal(spoken, "Done. Thoughts?");
  assert.equal(speakable("Draft:\n```file:a.html\n<p>unfinished secretword"), "Draft:");
  assert.equal(speakable("See:\n```js\nsecretword()\n```\nDone"), "See: (code omitted). Done");
  assert.equal(withFileMarkers("a\n```file:x.js\ncut"), "a\n[file: x.js]");
});

const summary = "I updated the landing page so the signup button stands out more clearly now.";
const reply = (content: string, words = summary) => words + "\n" + block("index.html", content);
const meeting = {
  goal: "Site",
  participants: [builder],
  transcript: [says("Developer", reply("<h1>One</h1>"))],
};
const asked = async (agent: Agent, ...replies: string[]) => {
  let calls = 0;
  const prompts: string[] = [];
  const result = await freshTurn(agent, meeting, undefined, async (_a, prompt) => {
    prompts.push(prompt.system);
    return replies[Math.min(calls++, replies.length - 1)];
  });
  return { result, calls, prompts };
};

test("a new or changed file is not a repeat, however similar the summary", async () => {
  const changed = reply("<h1>Two</h1>");
  assert.deepEqual((await asked(builder, changed)).result, { text: changed });
  const added = summary + "\n" + block("style.css", "h1 { color: red }");
  assert.deepEqual((await asked(builder, added)).result, { text: added });
});

test("the same file with the same words is refused", async () => {
  const same = await asked(builder, reply("<h1>One</h1>"));
  assert.deepEqual(same.result, { skipped: true });
  assert.equal(same.calls, 3);
  // The retry quotes the summary, not the file.
  assert.match(same.prompts[1], /refused because it repeated/);
  assert.doesNotMatch(same.prompts[1].split("refused because")[1], /<h1>/);
  // Files alone, already proposed, add nothing.
  assert.deepEqual((await asked(builder, block("index.html", "<h1>One</h1>"))).result, { skipped: true });
  // Files alone that are new are welcome.
  const only = block("other.html", "<h1>One</h1>");
  assert.deepEqual((await asked(builder, only)).result, { text: only });
  // An agent without the capability gets no exception.
  assert.deepEqual((await asked(talker, reply("<h1>Two</h1>"))).result, { skipped: true });
});

test("resending an attachment unchanged does not make a reply new", async () => {
  const attached = { ...meeting, attachments: [{ path: "brief.md", content: "Blue", source: "workspace" }] };
  const result = await freshTurn(builder, attached, undefined, async () => summary + "\n" + block("brief.md", "Blue"));
  assert.deepEqual(result, { skipped: true });
});

test("repetition compares words, and keeps messages that carry files", () => {
  const history = [says("Developer", reply("a")), says("QA", reply("b"))];
  assert.equal(withoutCopies(history).length, 2);
  assert.equal(withoutCopies(history.map((m) => ({ ...m, text: withFileMarkers(m.text) }))).length, 2);
  const shared = "color red margin zero padding none display block position fixed";
  assert.equal(
    findRepeat(
      "Please check the contrast on small phones before launch.\n" + block("a.css", shared),
      [says("QA", "The footer needs a privacy link added soon.\n" + block("a.css", shared))],
    ),
    null,
  );
});

test("only capable agents get output room for whole files", async (t) => {
  interface Body {
    options: { num_predict: number; num_ctx: number; repeat_penalty: number };
    max_tokens: number;
    frequency_penalty: number;
  }
  const bodies: Body[] = [];
  const long = "z".repeat(200_000);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    return Response.json(
      body.options ? { message: { content: long } } : { choices: [{ message: { content: long } }] },
    );
  });
  // About the size of a real role's instructions.
  const prompt = { system: "s".repeat(3000), user: "u" };
  for (const provider of ["ollama", "openai-compatible"] as const) {
    assert.equal((await respond({ ...talker, provider }, prompt)).length, 16_000);
    assert.equal((await respond({ ...builder, provider }, prompt)).length, MAX_FILE_REPLY_CHARS);
  }
  const [plain, writer, plainOpen, writerOpen] = bodies;
  assert.deepEqual([plain.options.num_predict, plain.options.num_ctx, plain.options.repeat_penalty], [700, 8192, 1.15]);
  assert.deepEqual([writer.options.num_predict, writer.options.repeat_penalty], [8000, 1.05]);
  assert.ok(writer.options.num_ctx > 8192);
  assert.deepEqual([plainOpen.max_tokens, plainOpen.frequency_penalty], [700, 0.5]);
  assert.deepEqual([writerOpen.max_tokens, writerOpen.frequency_penalty], [8000, 0]);
  // A reader of long files needs a larger window, but no longer a reply.
  await respond(talker, { system: "s", user: "u".repeat(60_000), hasFiles: true });
  assert.equal(bodies[4].options.num_predict, 700);
  assert.ok(bodies[4].options.num_ctx >= 20_000 && bodies[4].options.num_ctx <= 32_768);
});

test("names for folders come from the goal", () => {
  assert.equal(slug("  Design the café menu! (v2) "), "design-the-café-menu-v2");
  assert.equal(slug("../../etc"), "etc");
  assert.equal(slug("???"), "");
});

test("an engineering skill lets an agent write code unless the choice was made", () => {
  const skills = [{ name: "engineering-advanced-skills", text: "" }];
  assert.equal(canCreateFiles({ name: "Helper", skills }), true);
  assert.equal(canCreateFiles({ name: "Helper", skills: [{ name: "copywriting" }] }), false);
  assert.equal(canCreateFiles({ name: "Helper", skills, files: false }), false);
});
