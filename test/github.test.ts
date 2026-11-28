import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToGitHub, githubStatus, readGitHubFile } from "../src/github.ts";
import { respond } from "../src/providers.ts";

// Built here so that secret scanners see no key in the repository.
const TOKEN = "github_pat_" + "TESTONLY1234567890";
const saved = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), "quorum-github-test-"));
beforeEach(() => {
  for (const name of ["QUORUM_GITHUB_TOKEN", "QUORUM_GITHUB_CLI", "QUORUM_GITHUB_WRITE", "QUORUM_GITHUB_REPOS", "GH_TOKEN", "GITHUB_TOKEN"])
    delete process.env[name];
  // No real gh can be found or run by these tests.
  process.env.PATH = directory;
});
after(async () => {
  process.env = saved;
  await rm(directory, { recursive: true, force: true });
});
async function fakeCommand(name: string, script: string) {
  await writeFile(join(directory, name), script);
  await chmod(join(directory, name), 0o755);
}

const sha = (c: string) => c.repeat(40);
interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  redirect?: string;
}
type Answers = Record<string, () => Response>;
const defaults: Answers = {
  "GET ": () => Response.json({ default_branch: "main" }),
  "GET /git/ref/heads/main": () => Response.json({ object: { sha: sha("a") } }),
  ["GET /git/commits/" + sha("a")]: () => Response.json({ tree: { sha: sha("b") } }),
  "POST /git/trees": () => Response.json({ sha: sha("c") }, { status: 201 }),
  "POST /git/commits": () => Response.json({ sha: sha("d") }, { status: 201 }),
  "POST /git/refs": () => Response.json({}, { status: 201 }),
  "POST /pulls": () => Response.json({ html_url: "https://github.com/acme/site/pull/7", number: 7 }, { status: 201 }),
};
function github(t: test.TestContext, answers: Answers = {}) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      url,
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const key = method + " " + url.replace("https://api.github.com/repos/acme/site", "");
    const answer = { ...defaults, ...answers }[key];
    assert.ok(answer, "unexpected request " + method + " " + url);
    return answer();
  });
  return calls;
}
const request = {
  repo: "acme/site",
  message: "Add the landing page\n\nFrom the meeting.",
  files: [{ path: "site/index.html", content: "<p>Hi</p>\n" }],
};

test("writing is off unless a token or the GitHub CLI is turned on", async (t) => {
  const calls = github(t);
  assert.deepEqual(githubStatus(), { available: false, source: null, repos: null });
  process.env.QUORUM_GITHUB_CLI = "0";
  assert.equal(githubStatus().available, false);
  process.env.GH_TOKEN = process.env.GITHUB_TOKEN = TOKEN;
  assert.equal(githubStatus().available, false);
  await assert.rejects(commitToGitHub(request), /Committing to GitHub is off/);
  assert.equal(calls.length, 0);
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  assert.deepEqual(githubStatus(), { available: true, source: "token", repos: null });
  assert.doesNotMatch(JSON.stringify(githubStatus()), /TESTONLY/);
});

test("a commit goes to a new branch and opens a pull request", async (t) => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  const calls = github(t);
  const done = await commitToGitHub(request);
  assert.match(done.branch, /^quorum\/add-the-landing-page-\d{17}$/);
  assert.deepEqual([done.repo, done.number, done.url], ["acme/site", 7, "https://github.com/acme/site/pull/7"]);
  assert.doesNotMatch(JSON.stringify(done), /TESTONLY/);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "GET", "POST", "POST", "POST", "POST"]);
  for (const call of calls) {
    assert.ok(call.url.startsWith("https://api.github.com/repos/acme/site"), call.url);
    assert.equal(call.headers.authorization, "Bearer " + TOKEN);
    assert.equal(call.redirect, "manual");
  }
  const [tree, commit, ref, pull] = calls.slice(3).map((c) => c.body!);
  assert.deepEqual(tree, {
    base_tree: sha("b"),
    tree: [{ path: "site/index.html", mode: "100644", type: "blob", content: "<p>Hi</p>\n" }],
  });
  assert.deepEqual(commit, { message: request.message, tree: sha("c"), parents: [sha("a")] });
  assert.deepEqual(ref, { ref: "refs/heads/" + done.branch, sha: sha("d") });
  assert.deepEqual([pull.title, pull.head, pull.base], ["Add the landing page", done.branch, "main"]);
  assert.match(String(pull.body), /From the meeting\.[\s\S]*- `site\/index\.html`/);
});

test("no existing reference is ever updated", async (t) => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  const calls = github(t, {
    "POST /git/refs": () => Response.json({ message: "Reference already exists" }, { status: 422 }),
  });
  await assert.rejects(commitToGitHub(request), /Reference already exists/);
  // The failure ends the commit: no retry, no update, no pull request.
  assert.equal(calls.at(-1)!.url.endsWith("/git/refs"), true);
  const source = await readFile(new URL("../src/github.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /PATCH|PUT|DELETE|force/);
  for (const call of calls) {
    assert.ok(["GET", "POST"].includes(call.method));
    if (call.body?.ref) assert.match(String(call.body.ref), /^refs\/heads\/quorum\//);
    assert.doesNotMatch(call.url, /\/git\/refs\/./);
  }
});

test("files already on the default branch create nothing", async (t) => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  const calls = github(t, { "POST /git/trees": () => Response.json({ sha: sha("b") }) });
  await assert.rejects(commitToGitHub(request), /nothing to commit/);
  assert.ok(!calls.some((c) => c.url.endsWith("/git/commits") && c.method === "POST"));
  assert.ok(!calls.some((c) => c.url.endsWith("/git/refs")));
});

test("repositories, messages and files are checked before GitHub or gh is used", async (t) => {
  process.env.QUORUM_GITHUB_CLI = "1";
  await fakeCommand("gh", "#!/bin/sh\necho ran > " + join(directory, "ran") + "\n");
  const calls = github(t);
  for (const repo of ["", "acme", "acme/site/extra", "../site", "acme/..", "acme/.", "acme/site.git",
    "https://github.com/acme/site", "acme/si te", "acme/site?x", "acme/%2e%2e", "-a/site", 5])
    await assert.rejects(commitToGitHub({ ...request, repo }), /owner\/name/, String(repo));
  for (const message of ["", "   ", "a\u0000b", "x".repeat(5001), 4])
    await assert.rejects(commitToGitHub({ ...request, message }), /commit message/);
  for (const path of ["../x.js", "/x.js", ".github/workflows/x.yml", ".env", "a\\b.js", "a.exe", ".git/config.txt"])
    await assert.rejects(commitToGitHub({ ...request, files: [{ path, content: "" }] }), /not allowed/, path);
  await assert.rejects(commitToGitHub({ ...request, files: [] }), /between 1 and 20/);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(join(directory, "ran")), /ENOENT/);
});

test("QUORUM_GITHUB_REPOS limits which repositories are written to", async (t) => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  const calls = github(t);
  process.env.QUORUM_GITHUB_REPOS = "other/repo, Acme/Site";
  assert.equal((await commitToGitHub(request)).number, 7);
  assert.deepEqual(githubStatus().repos, ["other/repo", "acme/site"]);
  calls.length = 0;
  for (const list of ["other/repo", "acme/site-two", ",", "acme"]) {
    process.env.QUORUM_GITHUB_REPOS = list;
    await assert.rejects(commitToGitHub(request), /not in QUORUM_GITHUB_REPOS/, list);
  }
  assert.equal(calls.length, 0);
});

test("GitHub's refusals are explained and never contain the token", async (t) => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  let answers: Answers = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const key = (init.method ?? "GET") + " " + url.replace("https://api.github.com/repos/acme/site", "");
    return { ...defaults, ...answers }[key]();
  });
  const echo = (status: number, headers: Record<string, string> = {}) => () =>
    Response.json(
      { message: "Bad thing with " + TOKEN, errors: [{ message: TOKEN }] },
      { status, headers },
    );
  const cases: Array<[Answers, number, RegExp]> = [
    [{ "GET ": echo(404) }, 404, /could not find acme\/site/],
    [{ "GET ": echo(401) }, 403, /rejected the token/],
    [{ "POST /git/trees": echo(403) }, 403, /No permission/],
    [{ "GET ": echo(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }) }, 429, /rate limit.*2027-/],
    [{ "GET ": echo(429) }, 429, /rate limit/],
    [{ "GET /git/ref/heads/main": echo(409) }, 409, /refused the change/],
    [{ "GET ": () => new Response("", { status: 301, headers: { location: "https://evil.test" } }) }, 404, /has moved/],
    [{ "GET ": echo(500) }, 502, /HTTP 500/],
    [{ "GET ": () => new Response("not json " + TOKEN) }, 502, /could not read/],
    [{ "GET /git/ref/heads/main": () => Response.json({ object: { sha: "../x" } }) }, 502, /could not read/],
    [{ "POST /pulls": echo(403) }, 403, /branch quorum\/\S+ was created.*pull request could not be opened/],
    [{ "POST /pulls": () => Response.json({ html_url: "javascript:alert(1)" }) }, 502, /no pull request address/],
    [{ "GET ": () => { throw new TypeError("invalid header Bearer " + TOKEN); } }, 502, /could not be reached/],
  ];
  for (const [next, status, pattern] of cases) {
    answers = next;
    await assert.rejects(commitToGitHub(request), (error: Error & { status?: number }) => {
      assert.match(error.message, pattern);
      assert.equal(error.status, status, error.message);
      const everything = error.message + error.stack + JSON.stringify(error) + String(error.cause);
      assert.doesNotMatch(everything, /TESTONLY/);
      return true;
    });
  }
});

test("the GitHub CLI supplies the token only when enabled, and its output stays private", async (t) => {
  process.env.QUORUM_GITHUB_CLI = "1";
  const calls = github(t);
  assert.equal(githubStatus().source, "cli");
  await fakeCommand("gh", '#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] && echo ' + TOKEN + "\n");
  await commitToGitHub(request);
  assert.equal(calls[0].headers.authorization, "Bearer " + TOKEN);
  const failures = [
    "#!/bin/sh\necho " + TOKEN + "\necho " + TOKEN + " >&2\nexit 1\n",
    "#!/bin/sh\necho " + TOKEN + " with spaces\n",
    "#!/bin/sh\n",
  ];
  for (const script of failures) {
    await fakeCommand("gh", script);
    await assert.rejects(commitToGitHub(request), (error: Error) => {
      assert.match(error.message, /GitHub (CLI gave no token|token is not in a usable format)/);
      assert.doesNotMatch(error.message + error.stack + String(error.cause), /TESTONLY/);
      return true;
    });
  }
  process.env.QUORUM_GITHUB_TOKEN = "bad\n" + TOKEN;
  process.env.QUORUM_GITHUB_WRITE = "1";
  await assert.rejects(commitToGitHub(request), (error: Error) => !error.message.includes("TESTONLY"));
});

test("model CLIs are not given Quorum's secrets", async () => {
  await fakeCommand(
    "claude",
    "#!" + process.execPath + "\nconsole.log(Object.keys(process.env).filter((k) => /TOKEN|KEY/.test(k)).join(','))\n",
  );
  process.env.QUORUM_ENABLE_CLI = "1";
  delete process.env.QUORUM_CLI_BRIDGE_URL;
  process.env.CLAUDE_BIN = join(directory, "claude");
  const secrets = ["QUORUM_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "QUORUM_CLI_BRIDGE_TOKEN", "QUORUM_OPENAI_KEY"];
  for (const name of secrets) process.env[name] = TOKEN;
  process.env.KEPT_KEY = "1";
  const names = (await respond({ name: "A", provider: "claude", model: "" }, { system: "s", user: "u" })).split(",");
  assert.ok(names.includes("KEPT_KEY"));
  assert.deepEqual(secrets.filter((name) => names.includes(name)), []);
});

test("one text file can be attached from a GitHub address", async (t) => {
  const urls: string[] = [];
  let answer = () => new Response("# Brief\n");
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).authorization, undefined);
    return answer();
  });
  assert.deepEqual(await readGitHubFile("https://github.com/acme/site/blob/main/docs/My%20Brief.md"), {
    file: { path: "docs/My Brief.md", content: "# Brief\n", source: "github.com/acme/site@main" },
  });
  assert.deepEqual(urls, ["https://raw.githubusercontent.com/acme/site/main/docs/My%20Brief.md"]);
  urls.length = 0;
  for (const address of ["acme/site", "https://github.com/acme/site/tree/main/docs",
    "https://evil.test/acme/site/blob/main/a.md", "http://github.com/acme/site/blob/main/a.md",
    "https://raw.githubusercontent.com/acme/site/main/a.md", "file:///etc/passwd", ""])
    await assert.rejects(readGitHubFile(address), Error, address);
  assert.equal(urls.length, 0);
  const url = "github.com/acme/site/blob/main/a.md";
  answer = () => new Response("x".repeat(200_001));
  await assert.rejects(readGitHubFile(url), /larger than 200 KB/);
  answer = () => new Response(new Uint8Array([0, 1, 2]));
  await assert.rejects(readGitHubFile(url), /not a text file/);
  answer = () => new Response("", { status: 404 });
  await assert.rejects(readGitHubFile(url), /no file there/);
  answer = () => new Response("", { status: 403 });
  await assert.rejects(readGitHubFile(url), /rate limit/);
});

test("a token set only for reading does not turn committing on", async () => {
  process.env.QUORUM_GITHUB_TOKEN = TOKEN;
  delete process.env.QUORUM_GITHUB_WRITE;
  delete process.env.QUORUM_GITHUB_CLI;
  assert.equal(githubStatus().available, false);
  await assert.rejects(commitToGitHub({ repo: "acme/site", message: "m", files: [{ path: "a.md", content: "a" }] }), /is off/);
});
