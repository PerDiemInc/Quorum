import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  handoffContext,
  hasKey,
  isAccessKey,
  KEY_REMOVED,
  makePrompt,
  normalizeAgent,
  redactKeys,
  takeKeys,
  turnContext,
  withoutKeys,
} from "../src/engine.ts";
import type { Meeting } from "../src/engine.ts";
import { commitToGitHub } from "../src/github.ts";
import { respond } from "../src/providers.ts";
import { fakeModel, startServer } from "./helpers/server.ts";

// Every key here is fake, and built so that secret scanners see none in the repository.
const filler = "Fake0".repeat(8);
const KEY = "github_pat_" + "FAKE_0123456789_" + filler;
const KEYS = [KEY, ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((prefix) => prefix + filler),
  "ghs_" + "123456_eyJ" + filler + "." + filler + "." + filler];
const LEGACY = "0123456789abcdef".repeat(2) + "01234567";
/** Nothing that came from a key, however it was cut. */
const clean = (text: string, what = "") => assert.doesNotMatch(text, /Fake0/, what);

const saved = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), "quorum-key-test-"));
beforeEach(() => {
  for (const name of ["QUORUM_GITHUB_TOKEN", "QUORUM_GITHUB_CLI", "QUORUM_GITHUB_WRITE", "QUORUM_GITHUB_REPOS", "QUORUM_CLI_BRIDGE_URL"])
    delete process.env[name];
  process.env.PATH = directory;
});
after(async () => {
  process.env = saved;
  await rm(directory, { recursive: true, force: true });
});

test("every GitHub key format is recognized and replaced", () => {
  for (const key of KEYS) {
    assert.ok(isAccessKey(key), key.slice(0, 4));
    assert.equal(redactKeys("a " + key + ", b"), "a " + KEY_REMOVED + ", b");
    assert.equal(redactKeys(JSON.stringify({ x: "line\n" + key })), JSON.stringify({ x: "line\n" + KEY_REMOVED }));
    assert.deepEqual(withoutKeys({ a: [key], b: { c: key } }), { a: [KEY_REMOVED], b: { c: KEY_REMOVED } });
  }
  assert.equal(redactKeys(KEYS.join(" ")).includes("Fake0"), false);
  // Ordinary words and names are left alone.
  for (const text of ["ghp_your_token_here", "github_pat_...", "high_water_mark_of_the_queue", LEGACY, "ghs_short"])
    assert.equal(redactKeys(text), text);
  assert.ok(isAccessKey(LEGACY));
  for (const value of ["", "password", "ghp_ " + filler, KEY + "\nX-Evil: 1", "x".repeat(40), "ghp_" + "a".repeat(2000)])
    assert.equal(isAccessKey(value), false, value.slice(0, 20));
});

test("a key typed in the chat is taken out of the words around it", () => {
  assert.deepEqual(takeKeys(KEY), { text: "", key: KEY });
  assert.deepEqual(takeKeys("`" + KEY + "`"), { text: "", key: KEY });
  assert.deepEqual(takeKeys("Use " + KEY + " and push it"), { text: "Use and push it", key: KEY });
  assert.deepEqual(takeKeys(KEY + " @Developer go"), { text: "@Developer go", key: KEY });
  assert.deepEqual(takeKeys("Ship it today"), { text: "Ship it today" });
  // A key without a prefix is only recognized once one was asked for, and only on its own.
  assert.deepEqual(takeKeys(LEGACY), { text: LEGACY });
  assert.deepEqual(takeKeys(" " + LEGACY + " ", true), { text: "", key: LEGACY });
  assert.deepEqual(takeKeys("see " + LEGACY, true), { text: "see " + LEGACY });
  assert.deepEqual(takeKeys("sk_" + "Zz9".repeat(10), true), { text: "", unusable: true });
  assert.deepEqual(takeKeys("internationalization", true), { text: "internationalization" });
  assert.deepEqual(takeKeys("yes", true), { text: "yes" });
});

const agent = normalizeAgent({
  id: "a", name: "Developer", provider: "ollama", model: "fake",
  instructions: "Token " + KEY, skills: [{ name: "s " + KEYS[1], text: "use " + KEYS[2] }],
});
const meeting: Meeting = {
  id: "meeting-1",
  goal: "Ship " + KEY,
  description: "d " + KEYS[1],
  agenda: "a " + KEYS[2],
  participants: [agent],
  status: "paused",
  attachments: [{ path: "env.md", content: "T=" + KEYS[3], source: "workspace" }],
  transcript: [
    { speaker: "Host", text: "x".repeat(3980) + " " + KEY },
    { speaker: "Developer", text: "```file:a.js\nconst k = '" + KEYS[4] + "';\n```" },
  ],
};

test("no key reaches a model prompt, whatever it was built from", () => {
  for (const context of [meeting, turnContext(meeting), handoffContext(meeting)]) {
    const prompt = makePrompt(agent, context);
    clean(prompt.system + prompt.user);
    assert.doesNotMatch(prompt.system + prompt.user, /github_pat_|gh[pousr]_/);
    assert.ok(prompt.user.includes(KEY_REMOVED));
  }
});

test("the last step before a model replaces keys, in and out, bridge included", async (t) => {
  const model = await fakeModel(t, () => "Your key is " + KEY);
  process.env.OLLAMA_URL = model.url;
  const answer = await respond(agent, { system: "s " + KEY, user: JSON.stringify({ goal: KEYS[1] }) });
  assert.equal(answer, "Your key is " + KEY_REMOVED);
  clean(model.requests[0]);
  let bridged = "";
  const bridge = createServer(async (req, res) => {
    for await (const part of req) bridged += part;
    res.end(JSON.stringify({ text: "ok" }));
  });
  bridge.listen(0, "127.0.0.1");
  await once(bridge, "listening");
  t.after(() => {
    bridge.closeAllConnections();
    bridge.close();
  });
  process.env.QUORUM_CLI_BRIDGE_URL = "http://127.0.0.1:" + (bridge.address() as AddressInfo).port;
  await respond({ ...agent, provider: "claude" }, { system: KEY, user: KEY });
  assert.match(bridged, /Developer/);
  clean(bridged);
});

async function databaseBytes(folder: string) {
  const files = await readdir(folder);
  return (await Promise.all(files.map((f) => readFile(join(folder, f), "latin1")))).join("");
}

test("the server never saves, sends on or answers with a key", async (t) => {
  const model = await fakeModel(t, () => "Noted " + KEY);
  const server = await startServer(t, { OLLAMA_URL: model.url });
  const state = {
    agents: [agent],
    meetings: [meeting],
    initialized: true,
  };
  assert.equal((await server.send("/api/state", state, { method: "PUT" })).status, 200);
  const stored = await (await fetch(server.url + "/api/state")).text();
  clean(stored, "state");
  assert.ok(stored.includes(KEY_REMOVED));
  clean(await databaseBytes(server.dataDir), "database");
  for (const path of ["/api/agents/starter-team", "/api/agents/product-team"])
    clean(await (await server.send(path, { provider: KEY })).text(), path);

  for (const path of ["/api/turn", "/api/prompt"]) {
    const response = await server.send(path, { agent, meeting });
    assert.equal(response.status, 200, path);
    clean(await response.text(), path);
  }
  assert.equal(model.requests.length, 2);
  model.requests.forEach((request) => clean(request, "model request"));

  const files = [{ path: "a.js", content: "k = " + KEY }];
  const message = "m";
  const refusals: Array<[string, object, RegExp]> = [
    ["/api/workspace/save", { folder: "m", files }, /a\.js contains a GitHub key/],
    ["/api/github/commit", { repo: "acme/site", message, files, key: KEYS[1] }, /a\.js contains a GitHub key/],
    ["/api/github/commit", { repo: "acme/site", message: KEY, files: [{ path: "a.js", content: "" }], key: KEY }, /key appears/],
    ["/api/github/commit", { repo: KEY, message, files: [{ path: "a.js", content: "" }], key: KEYS[1] }, /key appears/],
    ["/api/github/commit", { repo: "acme/site", message, files: [{ path: KEY + "/.x", content: "" }] }, /off without/],
    ["/api/github/commit", { repo: "acme/site", message, files, key: KEY + " " }, /key appears/],
    ["/api/github/commit", { repo: "acme/site", message, files, key: KEY + "\n!" }, /does not look like/],
    ["/api/draft", { files: [{ path: KEY + "/../x.html", content: "" }] }, /not allowed/],
    ["/api/workspace/read", { paths: ["../" + KEY] }, /not allowed/],
    ["/api/github/file", { url: "https://github.com/" + KEY }, /./],
  ];
  for (const [path, body, pattern] of refusals) {
    const response = await server.send(path, body);
    assert.ok(response.status >= 400, path);
    const text = await response.text();
    clean(text, path);
    assert.match((JSON.parse(text) as { error: string }).error, pattern, path);
  }
  await assert.rejects(readdir(server.workspace), /ENOENT/);
  clean(server.output(), "log");
});

test("keys saved before this protection are removed when the server starts", async (t) => {
  const data = await mkdtemp(join(directory, "data-"));
  const db = new DatabaseSync(join(data, "quorum.sqlite"));
  db.exec("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  db.prepare("INSERT INTO state(id,value) VALUES(1,?)").run(
    JSON.stringify({ agents: [], meetings: [meeting], _revision: 3 }),
  );
  db.close();
  const server = await startServer(t, {}, { data });
  clean(await databaseBytes(data), "database");
  const state = (await (await fetch(server.url + "/api/state")).json()) as { _revision: number };
  assert.equal(state._revision, 3);
  clean(JSON.stringify(state));
});

test("an entered key is used for that push alone, ahead of any other credential", async (t) => {
  const sent: string[] = [];
  const sha = "a".repeat(40);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sent.push((init.headers as Record<string, string>).authorization);
    clean(url + String(init.body ?? ""), "request");
    if (url.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/acme/site/pull/1", number: 1 });
    if (url.endsWith("/git/trees")) return Response.json({ sha: "b".repeat(40) });
    return Response.json({ default_branch: "main", object: { sha }, tree: { sha }, sha });
  });
  // A GitHub CLI that must not be run.
  await writeFile(join(directory, "gh"), "#!/bin/sh\necho ran > " + join(directory, "ran") + "\n");
  await chmod(join(directory, "gh"), 0o755);
  process.env.QUORUM_GITHUB_CLI = "1";
  const request = { repo: "acme/site", message: "Add", files: [{ path: "a.md", content: "a" }] };
  const done = await commitToGitHub({ ...request, key: "  " + KEY + "  " });
  clean(JSON.stringify(done));
  assert.ok(sent.length === 7 && sent.every((header) => header === "Bearer " + KEY));
  await assert.rejects(readFile(join(directory, "ran")), /ENOENT/);
  // Nothing remembers it: the next push without a key has none to use.
  delete process.env.QUORUM_GITHUB_CLI;
  sent.length = 0;
  await assert.rejects(commitToGitHub(request), /off without an access key/);
  // The allowlist applies to an entered key too.
  process.env.QUORUM_GITHUB_REPOS = "acme/other";
  await assert.rejects(commitToGitHub({ ...request, key: KEY }), /QUORUM_GITHUB_REPOS/);
  assert.equal(sent.length, 0);
  delete process.env.QUORUM_GITHUB_REPOS;
  for (const key of ["short", "ghp_bad key", 7, { toString: () => KEY }])
    await assert.rejects(commitToGitHub({ ...request, key }), (error: Error & { keyRejected?: boolean }) => {
      assert.equal(error.keyRejected, true);
      return !error.message.includes(String(key));
    });
  assert.equal(sent.length, 0);
});

test("through the server, a key appears in no answer, log or file", async (t) => {
  const log = join(await mkdtemp(join(directory, "log-")), "calls");
  await mkdir(join(directory, "preload"), { recursive: true });
  const preload = join(directory, "preload", "github.mjs");
  // Replaces fetch in the server process: nothing reaches GitHub.
  await writeFile(preload, `
    import { appendFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    globalThis.fetch = async (url, init = {}) => {
      const authorization = init.headers.authorization;
      appendFileSync(process.env.CALL_LOG, url + " " + createHash("sha256").update(authorization).digest("hex") + "\\n");
      if (url.includes("acme/denied")) return Response.json({ message: "Bad " + authorization }, { status: 401 });
      if (url.includes("acme/broken")) throw new TypeError("invalid " + authorization);
      if (url.endsWith("/pulls")) return Response.json({ html_url: "https://github.com/acme/site/pull/1", number: 1 });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "b".repeat(40) });
      const sha = "a".repeat(40);
      return Response.json({ default_branch: "main", object: { sha }, tree: { sha }, sha });
    };
  `);
  const server = await startServer(t, { CALL_LOG: log, QUORUM_GITHUB_REPOS: "acme/site,acme/denied,acme/broken" }, {
    args: ["--import", preload],
  });
  const request = { message: "Add", files: [{ path: "a.md", content: "a" }], key: KEY };
  const cases: Array<[string, number, boolean]> = [
    ["acme/site", 200, false], ["acme/denied", 403, true], ["acme/broken", 502, false], ["acme/forbidden", 403, false],
  ];
  for (const [repo, status, rejected] of cases) {
    const response = await server.send("/api/github/commit", { ...request, repo });
    assert.equal(response.status, status, repo);
    const text = await response.text();
    clean(text, repo);
    assert.equal(Boolean((JSON.parse(text) as { keyRejected?: boolean }).keyRejected), rejected, repo);
  }
  for (const path of ["/api/github/tree", "/api/github/read", "/api/github/auto-commit"]) {
    const response = await server.send(path, {
      repo: "acme/denied", key: KEY, paths: ["a.md"], files: request.files, meeting: { id: "m", goal: "g" },
    });
    assert.equal(response.status, 403, path);
    clean(await response.text(), path);
  }
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  const expected = createHash("sha256").update("Bearer " + KEY).digest("hex");
  assert.ok(calls.every((line) => line.endsWith(expected) && line.startsWith("https://api.github.com/")));
  assert.ok(!calls.some((line) => line.includes("forbidden")));
  // Seven calls for the one push that worked: the key was used for it and not again.
  assert.equal(calls.filter((line) => line.includes("acme/site")).length, 7);
  const before = calls.length;
  assert.equal((await server.send("/api/github/commit", { ...request, repo: "acme/site", key: undefined })).status, 403);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, before);
  clean(server.output(), "log");
  clean(await databaseBytes(server.dataDir), "database");
  assert.equal(hasKey(await databaseBytes(server.dataDir)), false);
});
