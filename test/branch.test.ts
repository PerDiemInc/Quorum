import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { autoCommit, blobId, listRepository, readRepository } from "../src/branch.ts";
import {
  attachedFrom,
  directBranch,
  pendingFiles,
  proposedVersions,
  rememberWritten,
  writtenAt,
  turnContext,
  KEY_REMOVED,
} from "../src/engine.ts";
import type { Meeting, Repository } from "../src/engine.ts";
import { fakeGitHub } from "./helpers/github.ts";

// Built here so that secret scanners see no key in the repository.
const KEY = "github_pat_" + "FAKEBRANCHKEY0123456789";
const OTHER = "ghp_" + "Fake0".repeat(8);
const saved = { ...process.env };
beforeEach(() => {
  for (const name of ["QUORUM_GITHUB_TOKEN", "QUORUM_GITHUB_CLI", "QUORUM_GITHUB_WRITE", "QUORUM_GITHUB_REPOS"])
    delete process.env[name];
  process.env.PATH = "/nonexistent";
});
after(() => (process.env = saved));

const meeting = { id: "11111111-2222-3333-4444-555555555555", goal: "Build the cup site @team fixes #12" };
const file = (path: string, content: string, seen: string[] = []) => ({ path, content, seen });
const commit = (files: unknown[], extra: object = {}) =>
  autoCommit({ repo: "acme/site", meeting, files, agents: ["Developer"], key: KEY, ...extra });

test("the first commit creates the meeting's branch and a pull request", async (t) => {
  const github = fakeGitHub(t);
  const main = github.refs.get("main")!;
  const result = await commit([file("site/index.html", "<p>1</p>\n"), file("site/styles.css", "p{}\n")]);
  assert.match(result.branch!, /^quorum\/build-the-cup-site-team-fixes-12-[0-9a-f]{8}$/);
  assert.equal(result.started, "first");
  assert.equal(result.pull!.number, 1);
  assert.equal(result.commit!.url, "https://github.com/acme/site/commit/" + result.commit!.sha);
  assert.deepEqual(result.written.map((f) => f.path), ["site/index.html", "site/styles.css"]);
  assert.equal(result.written[0].sha, blobId("<p>1</p>\n"));
  assert.deepEqual(github.writes().map((c) => c.method + " " + c.path), [
    "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls",
  ]);
  const head = github.head(result.branch!);
  assert.deepEqual(head.parents, [main]);
  assert.match(head.message, /^Developer: add site\/index\.html, site\/styles\.css\n/);
  assert.match(head.message, /\nQuorum-Meeting: 11111111-2222-3333-4444-555555555555$/);
  assert.equal(github.refs.get("main"), main);
  assert.equal(github.pulls[0].base, "main");
  // Nobody is mentioned and no issue is closed by the words of a goal.
  assert.doesNotMatch(github.pulls[0].title + github.pulls[0].body, /@team|#12/);
  assert.ok(github.calls.every((c) => c.authorization === "Bearer " + KEY));
  assert.doesNotMatch(JSON.stringify([result, github.writes().map((c) => c.body)]), /FAKEBRANCHKEY/);
});

test("later commits step the same branch forward, never forcing it", async (t) => {
  const github = fakeGitHub(t);
  const first = await commit([file("a.js", "1\n")]);
  const branch = first.branch!;
  // Someone else adds to the branch; the next commit builds on their work.
  github.push(branch, "theirs.md", "Mine\n");
  const theirs = github.refs.get(branch)!;
  github.calls.length = 0;
  const second = await commit([file("a.js", "2\n", [first.written[0].sha]), file("b.js", "b\n")], {
    branch,
    agents: ["Developer", "CISO"],
  });
  assert.equal(second.branch, branch);
  assert.equal(second.started, undefined);
  assert.equal(second.pull!.number, 1);
  assert.deepEqual(github.head(branch).parents, [theirs]);
  assert.match(github.head(branch).message, /^Developer, CISO: add b\.js; update a\.js\n/);
  assert.equal(github.read(branch, "theirs.md"), "Mine\n");
  const writes = github.writes();
  assert.deepEqual(writes.map((c) => c.method + " " + c.path), [
    "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/" + branch,
  ]);
  assert.deepEqual(writes[2].body, { sha: second.commit!.sha, force: false });
  assert.equal(github.pulls.length, 1);
  const source = await readFile(new URL("../src/branch.ts", import.meta.url), "utf8");
  assert.equal(source.match(/"PATCH"/g)!.length, 1);
  assert.doesNotMatch(source, /force: true|"PUT"|"DELETE"/);
});

test("a branch that moves during a commit is not overwritten", async (t) => {
  const github = fakeGitHub(t);
  const first = await commit([file("a.js", "1\n")]);
  github.answers.set("PATCH /git/refs/heads/" + first.branch, () =>
    Response.json({ message: "Update is not a fast forward" }, { status: 422 }));
  await assert.rejects(commit([file("b.js", "b\n")], { branch: first.branch }), /not a fast forward/);
  assert.equal(github.read(first.branch!, "b.js"), undefined);
});

test("commits made at the same time follow one another", async (t) => {
  const github = fakeGitHub(t);
  const first = await commit([file("a.js", "1\n")]);
  const extra = { branch: first.branch };
  const [b, c] = await Promise.all([commit([file("b.js", "b\n")], extra), commit([file("c.js", "c\n")], extra)]);
  assert.deepEqual(github.commit(c.commit!.sha).parents, [b.commit!.sha]);
  assert.equal(github.read(first.branch!, "b.js"), "b\n");
});

test("the default branch and branches Quorum did not make are refused", async (t) => {
  const github = fakeGitHub(t);
  const first = await commit([file("a.js", "1\n")]);
  const short = first.branch!.slice(-8);
  const main = github.refs.get("main");
  github.calls.length = 0;
  for (const branch of [
    "main", "feature/x", "quorum/other-00000000", "quorum/../main", "quorum/a b-" + short,
    "refs/heads/quorum/x-" + short, "quorum/x-" + short + "/../main", "quorum/X-" + short, 5,
  ])
    await assert.rejects(commit([file("b.js", "b\n")], { branch }), /branch it made for this meeting/, String(branch));
  assert.equal(github.writes().length, 0);
  // A branch with the right shape of name that someone else made is left alone.
  github.push("quorum/by-hand-" + short, "x.md", "x\n");
  const before = github.refs.get("quorum/by-hand-" + short);
  await assert.rejects(commit([file("b.js", "b\n")], { branch: "quorum/by-hand-" + short }), /not made by Quorum/);
  assert.equal(github.refs.get("quorum/by-hand-" + short), before);
  assert.equal(github.refs.get("main"), main);
  assert.equal(github.writes().length, 0);
  // Even one that is the default branch of the repository.
  github.answers.set("GET ", () => Response.json({ default_branch: first.branch }));
  await assert.rejects(commit([file("b.js", "b\n")], { branch: first.branch }), /default branch/);
  assert.equal(github.writes().length, 0);
});

test("a name taken by someone else gets a number instead", async (t) => {
  const github = fakeGitHub(t);
  const probe = await commit([file("a.js", "1\n")]);
  const name = probe.branch!;
  github.refs.delete(name);
  github.pulls.length = 0;
  github.push(name, "x.md", "x\n");
  const result = await commit([file("a.js", "1\n")]);
  assert.equal(result.branch, name + "-2");
  assert.equal(github.read(name, "a.js"), undefined);
});

test("files the meeting has not seen are held back, until seen or approved", async (t) => {
  const github = fakeGitHub(t, { "app.js": "original\n", "docs/guide.md": "guide\n", "run.sh": "old\n", "lib.js": "x\n" });
  github.push("main", "run.sh", "old\n", "100755");
  const blind = await commit([file("app.js", "mine\n"), file("new.js", "new\n")]);
  assert.deepEqual(blind.written.map((f) => f.path), ["new.js"]);
  assert.deepEqual(blind.held.map((f) => [f.path, f.reason, f.current]), [["app.js", "exists", blobId("original\n")]]);
  assert.equal(github.read(blind.branch!, "app.js"), "original\n");
  // Only held files: no commit at all.
  github.calls.length = 0;
  const only = await commit([file("app.js", "mine\n", [blobId("something else\n")])], { branch: blind.branch });
  assert.equal(only.commit, undefined);
  assert.equal(github.writes().length, 0);
  // Having seen the current contents, or approving them, allows the replacement.
  const seen = await commit(
    [file("app.js", "mine\n", [blobId("original\n")]), file("run.sh", "new\n", [blobId("old\n")])],
    { branch: blind.branch },
  );
  assert.deepEqual(seen.held, []);
  assert.equal(github.read(blind.branch!, "app.js"), "mine\n");
  assert.equal(github.head(blind.branch!).files.get("run.sh")!.mode, "100755");
  // A change made on the branch by someone else is protected again.
  github.push(blind.branch!, "app.js", "their fix\n");
  const again = await commit([file("app.js", "mine 2\n", [blobId("mine\n")])], { branch: blind.branch });
  assert.equal(again.held[0].reason, "exists");
  assert.equal(github.read(blind.branch!, "app.js"), "their fix\n");
});

test("nothing is written where it would remove or shadow something", async (t) => {
  const github = fakeGitHub(t, { "data.json": "{}\n", "web.js/index.js": "x\n", "README.md": "r\n" });
  const result = await commit([
    file("data.json/inner.js", "a\n"),
    file("web.js", "b\n"),
    file("readme.md", "c\n"),
  ]);
  assert.deepEqual(result.held.map((f) => f.reason), ["blocked", "blocked", "blocked"]);
  assert.equal(result.commit, undefined);
  assert.equal(github.writes().length, 0);
});

test("unchanged files make no commit", async (t) => {
  const github = fakeGitHub(t, { "README.md": "# Site\n" });
  const none = await commit([file("README.md", "# Site\n")]);
  assert.deepEqual([none.commit, none.branch, none.unchanged.length], [undefined, undefined, 1]);
  const first = await commit([file("a.js", "1\n")]);
  github.calls.length = 0;
  const same = await commit([file("a.js", "1\n"), file("README.md", "# Site\n")], { branch: first.branch });
  assert.deepEqual(same.unchanged.map((f) => f.path), ["a.js", "README.md"]);
  assert.equal(same.commit, undefined);
  assert.equal(github.writes().length, 0);
});

test("a deleted branch or a finished pull request starts a new branch", async (t) => {
  const github = fakeGitHub(t);
  const first = await commit([file("a.js", "1\n")]);
  github.refs.delete(first.branch!);
  const deleted = await commit([file("b.js", "b\n")], { branch: first.branch });
  assert.deepEqual([deleted.started, deleted.branch], ["deleted", first.branch + "-2"]);
  assert.equal(github.read(deleted.branch!, "a.js"), undefined);
  for (const [why, merged] of [["merged", "2026-01-01T00:00:00Z"], ["closed", null]] as const) {
    const previous = github.pulls.at(-1)!;
    previous.state = "closed";
    previous.merged_at = merged;
    const old = github.refs.get(previous.head);
    const result = await commit([file(why + ".js", "x\n")], { branch: previous.head });
    assert.equal(result.started, why);
    assert.notEqual(result.branch, previous.head);
    assert.equal(github.refs.get(previous.head), old);
    assert.equal(github.pulls.at(-1)!.head, result.branch);
  }
});

test("a pull request that fails to open is tried again with the next commit", async (t) => {
  const github = fakeGitHub(t);
  github.answers.set("POST /pulls", () => Response.json({ message: "Nope " + KEY }, { status: 403 }));
  const first = await commit([file("a.js", "1\n")]);
  assert.match(first.warning!, /pull request could not be opened/);
  assert.doesNotMatch(first.warning!, /FAKEBRANCHKEY/);
  assert.equal(first.pull, undefined);
  github.answers.clear();
  const second = await commit([file("b.js", "b\n")], { branch: first.branch });
  assert.equal(second.branch, first.branch);
  assert.equal(second.pull!.number, 1);
});

test("every automatic commit is checked, and the key never comes back", async (t) => {
  const github = fakeGitHub(t);
  const refusals: Array<[unknown[], object, RegExp]> = [
    [[file(".github/workflows/x.yml", "x")], {}, /not allowed/],
    [[file("../x.js", "x")], {}, /not allowed/],
    [[file("a.exe", "x")], {}, /not allowed/],
    [[file("a.js", "x".repeat(200_001))], {}, /larger than/],
    [Array.from({ length: 21 }, (_, i) => file(i + ".js", "x")), {}, /between 1 and 20/],
    [[file("a.js", "x")], { agents: [KEY] }, /GitHub key appears/],
    [[file("a.js", "x")], { meeting: { id: "../x", goal: "g" } }, /not identified/],
    [[file("a.js", "x")], { repo: "acme/site/../other" }, /owner\/name/],
    [[file("a.js", "x")], { key: "not a key" }, /does not look like/],
    [[file("a.js", "x")], { key: "" }, /Enter a GitHub access key/],
  ];
  for (const [files, extra, pattern] of refusals)
    await assert.rejects(commit(files, extra), pattern);
  process.env.QUORUM_GITHUB_REPOS = "acme/other";
  await assert.rejects(commit([file("a.js", "x")]), /QUORUM_GITHUB_REPOS/);
  await assert.rejects(listRepository({ repo: "acme/site", key: KEY }), /QUORUM_GITHUB_REPOS/);
  assert.equal(github.calls.length, 0);
  delete process.env.QUORUM_GITHUB_REPOS;
  const secrets = await commit([
    file("a.js", "const t = '" + OTHER + "';"),
    file("b.js", KEY_REMOVED),
    file("c.js", "clean\n"),
  ]);
  assert.deepEqual(secrets.held.map((f) => [f.path, f.reason]), [["a.js", "secret"], ["b.js", "secret"]]);
  assert.deepEqual(secrets.written.map((f) => f.path), ["c.js"]);
  assert.doesNotMatch(JSON.stringify(secrets), /Fake0|FAKEBRANCHKEY/);
  assert.doesNotMatch(JSON.stringify(github.writes()[0].body), /Fake0|FAKEBRANCHKEY/);
  for (const status of [401, 403, 404, 500]) {
    github.answers.set("GET ", () => Response.json({ message: "Bad " + KEY }, { status }));
    await assert.rejects(commit([file("d.js", "d")]), (error: Error & { keyRejected?: boolean }) => {
      assert.doesNotMatch(error.message + error.stack + JSON.stringify(error), /FAKEBRANCHKEY/);
      assert.equal(Boolean(error.keyRejected), status === 401 || status === 403, String(status));
      return true;
    });
  }
  // Without a key and without a credential of its own, nothing is asked of GitHub.
  github.calls.length = 0;
  await assert.rejects(autoCommit({ repo: "acme/site", meeting, files: [file("a.js", "x")] }), /Enter a GitHub access key/);
  assert.equal(github.calls.length, 0);
});

const direct = { direct: true, confirmedBranch: "main" };

test("nothing goes straight to the default branch unless the request says so and names it", async (t) => {
  const github = fakeGitHub(t);
  const main = github.refs.get("main");
  // Off by default: even a request that only names the branch gets a branch of its own.
  const usual = await commit([file("a.js", "1\n")], { confirmedBranch: "main" });
  assert.equal(usual.direct, undefined);
  assert.match(usual.branch!, /^quorum\//);
  const off = await commit([file("b.js", "b\n")], { direct: false, confirmedBranch: "main", branch: usual.branch });
  assert.equal(off.branch, usual.branch);
  await assert.rejects(commit([file("a.js", "1\n")], { branch: "main" }), /never to the default branch/);
  github.push("release", "x.md", "x\n");
  github.calls.length = 0;
  for (const extra of [
    { direct: true }, { direct: true, confirmedBranch: "release" }, { direct: true, confirmedBranch: usual.branch },
    { direct: true, confirmedBranch: "Main" }, { direct: true, confirmedBranch: "refs/heads/main" },
    { direct: true, branch: "main" }, { direct: true, confirmedBranch: ["main"] },
  ])
    await assert.rejects(commit([file("c.js", "c\n")], extra), (error: Error & { directRefused?: boolean }) => {
      assert.match(error.message, /not the branch confirmed/);
      return error.directRefused === true;
    });
  for (const value of ["true", 1, {}])
    await assert.rejects(commit([file("c.js", "c\n")], { direct: value, confirmedBranch: "main" }), /true or false/);
  assert.equal(github.writes().length, 0);
  assert.equal(github.refs.get("main"), main);
  // The default branch was renamed after the host confirmed it.
  github.answers.set("GET ", () => Response.json({ default_branch: "release" }));
  await assert.rejects(commit([file("c.js", "c\n")], direct), /default branch of acme\/site is release/);
  assert.equal(github.writes().length, 0);
});

test("a confirmed direct commit steps the default branch forward, with no pull request", async (t) => {
  const github = fakeGitHub(t, { "app.js": "original\n" });
  const main = github.refs.get("main")!;
  // Another branch named in the request is not touched.
  const result = await commit([file("new.js", "n\n"), file("app.js", "mine\n")], {
    ...direct, branch: "quorum/anything",
  });
  assert.deepEqual([result.direct, result.branch, result.pull, result.started], [true, "main", undefined, undefined]);
  assert.deepEqual(github.head("main").parents, [main]);
  assert.deepEqual(github.writes().map((c) => c.method + " " + c.path), [
    "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/main",
  ]);
  assert.deepEqual(github.writes()[2].body, { sha: result.commit!.sha, force: false });
  assert.equal(github.pulls.length, 0);
  // The same protections hold: unseen files, secrets and places that would remove something.
  assert.deepEqual(result.held.map((f) => [f.path, f.reason]), [["app.js", "exists"]]);
  assert.equal(github.read("main", "app.js"), "original\n");
  const checked = await commit([file("k.js", OTHER), file("app.js/x.js", "x")], direct);
  assert.deepEqual(checked.held.map((f) => f.reason), ["secret", "blocked"]);
  assert.equal(checked.commit, undefined);
  await assert.rejects(commit([file(".github/workflows/x.yml", "x")], direct), /not allowed/);
  process.env.QUORUM_GITHUB_REPOS = "acme/other";
  await assert.rejects(commit([file("c.js", "c")], direct), /QUORUM_GITHUB_REPOS/);
  delete process.env.QUORUM_GITHUB_REPOS;
  const approved = await commit([file("app.js", "mine\n", [blobId("original\n")])], direct);
  assert.equal(github.read("main", "app.js"), "mine\n");
  assert.equal(approved.direct, true);
});

test("a default branch that moved is compared again and tried once more", async (t) => {
  const github = fakeGitHub(t, { "app.js": "original\n" });
  const patches = () => github.calls.filter((c) => c.method === "PATCH");
  let moves = 1;
  const move = (path: string) => () => {
    if (moves-- > 0) github.push("main", path, "theirs " + moves + "\n");
    return undefined;
  };
  github.answers.set("PATCH /git/refs/heads/main", move("other.md"));
  const result = await commit([file("new.js", "n\n")], direct);
  assert.equal(patches().length, 2);
  assert.equal(github.read("main", "other.md"), "theirs 0\n");
  assert.equal(github.read("main", "new.js"), "n\n");
  assert.deepEqual(github.commit(result.commit!.sha).parents.length, 1);
  // What moved was the file itself, which the meeting has therefore not seen.
  moves = 1;
  github.calls.length = 0;
  github.answers.set("PATCH /git/refs/heads/main", move("app.js"));
  const held = await commit([file("app.js", "mine\n", [blobId("original\n")])], direct);
  assert.deepEqual([held.commit, held.held[0].reason], [undefined, "exists"]);
  assert.equal(patches().length, 1);
  assert.equal(github.read("main", "app.js"), "theirs 0\n");
  // A branch that keeps moving is reported, never forced.
  moves = 5;
  github.calls.length = 0;
  github.answers.set("PATCH /git/refs/heads/main", move("other.md"));
  await assert.rejects(commit([file("late.js", "l\n")], direct), /kept moving/);
  assert.equal(patches().length, 2);
  assert.ok(patches().every((c) => c.body!.force === false));
  assert.equal(github.read("main", "late.js"), undefined);
});

test("a protected default branch is reported, and nothing switches by itself", async (t) => {
  const github = fakeGitHub(t);
  const main = github.refs.get("main");
  for (const [status, message] of [
    [422, "Protected branch update failed for refs/heads/main."],
    [403, "Repository rule violations found for refs/heads/main. Changes must be made through a pull request."],
    [422, "Something else GitHub refused"],
  ] as const) {
    github.calls.length = 0;
    github.answers.set("PATCH /git/refs/heads/main", () => Response.json({ message }, { status }));
    await assert.rejects(commit([file("a.js", "1\n")], direct), (error: Error & { directRefused?: boolean; keyRejected?: boolean }) => {
      assert.match(error.message, /would not take a commit straight to main[\s\S]*Nothing was committed/);
      assert.ok(error.message.includes(message));
      return error.directRefused === true && !error.keyRejected;
    });
    assert.equal(github.calls.filter((c) => c.method === "PATCH").length, 1);
    assert.ok(!github.calls.some((c) => c.method === "POST" && /^\/(pulls|git\/refs)/.test(c.path)));
  }
  assert.equal(github.refs.get("main"), main);
});

test("a direct choice holds only for the repository it was confirmed for", () => {
  const repository: Repository = { repo: "acme/site", connected: true, auto: true, written: {}, done: {} };
  assert.equal(directBranch(repository), null);
  assert.equal(directBranch(undefined), null);
  repository.direct = { repo: "Acme/Site", branch: "main" };
  assert.equal(directBranch(repository), "main");
  assert.equal(directBranch({ ...repository, repo: "acme/other" }), null);
  assert.equal(directBranch({ ...repository, connected: false }), null);
});

test("changing destination or merging does not hold back the meeting's own work", async (t) => {
  const github = fakeGitHub(t);
  const repository: Repository = { repo: "acme/site", connected: true, auto: true, written: {}, done: {} };
  const send = async (content: string, extra: object) => {
    const result = await commit([file("a.js", content, writtenAt(repository, "a.js"))], extra);
    assert.deepEqual(result.held, [], content);
    for (const { path, sha } of result.written) rememberWritten(repository, path, result.branch!, sha);
    return result;
  };
  const first = await send("1\n", {});
  await send("2\n", direct);
  await send("3\n", { branch: first.branch });
  // The pull request is merged: the next branch starts from what Quorum wrote.
  github.push("main", "a.js", "3\n");
  github.pulls[0].state = "closed";
  github.pulls[0].merged_at = "2026-01-01T00:00:00Z";
  const next = await send("4\n", { branch: first.branch });
  assert.equal(next.started, "merged");
  assert.equal(github.read(next.branch!, "a.js"), "4\n");
  assert.deepEqual(writtenAt(repository, "constructor"), []);
});

test("the connected repository's text files can be listed and read", async (t) => {
  const github = fakeGitHub(t, { "src/a.js": "a\n", ".env": "SECRET=1\n", "logo.png": "x", "keys.md": OTHER });
  const listed = await listRepository({ repo: "acme/site", key: KEY });
  assert.deepEqual(listed.files.map((f) => f.path), ["src/a.js", "keys.md"]);
  assert.equal(listed.ref, "main");
  const read = await readRepository({ repo: "acme/site", paths: ["src/a.js"], key: KEY });
  assert.deepEqual(read.files, [{ path: "src/a.js", content: "a\n", source: "github.com/acme/site@main" }]);
  const first = await commit([file("src/a.js", "b\n", [blobId("a\n")])]);
  // While the meeting's branch exists, its version is the current one.
  const after = await readRepository({ repo: "acme/site", branch: first.branch, paths: ["src/a.js"], key: KEY });
  assert.equal(after.files[0].content, "b\n");
  assert.equal(after.files[0].source, "github.com/acme/site@" + first.branch);
  await assert.rejects(readRepository({ repo: "acme/site", paths: [".env"], key: KEY }), /not allowed/);
  await assert.rejects(readRepository({ repo: "acme/site", paths: ["none.js"], key: KEY }), /no file/);
  assert.equal(github.writes().filter((c) => c.method === "PATCH").length, 0);
});

test("only agents' newest unhandled files wait to be committed", () => {
  const block = (path: string, content: string) => "```file:" + path + "\n" + content + "\n```";
  const repository: Repository = { repo: "acme/site", connected: true, auto: true, written: {}, done: {} };
  const room: Meeting = {
    id: "m", goal: "g", participants: [], status: "paused", repository,
    transcript: [
      { speaker: "Developer", text: block("a.js", "1") },
      { speaker: "Host", text: block("host.js", "h") },
      { speaker: "Sales", text: block("off.js", "o"), unasked: true },
      { speaker: "Quorum", text: "note", links: [] },
      { speaker: "CISO", text: block("a.js", "2") + "\n" + block("b.js", "b") },
    ],
  };
  assert.deepEqual(pendingFiles(room).map((f) => [f.path, f.content, f.at, f.agent]), [
    ["a.js", "2\n", 4, "CISO"], ["b.js", "b\n", 4, "CISO"],
  ]);
  assert.deepEqual(pendingFiles(room, 0).map((f) => f.content), ["1\n"]);
  repository.done = { "a.js": 4 };
  repository.held = [{ path: "b.js", at: 4, reason: "exists", why: "" }];
  assert.deepEqual(pendingFiles(room), []);
  assert.deepEqual(pendingFiles(room, 0), []);
  assert.equal(proposedVersions(room).length, 2);
  // Only a version attached from that repository, before the proposal, counts as seen.
  room.attachments = [
    { path: "a.js", content: "seen", source: "github.com/Acme/Site@main", after: 4 },
    { path: "a.js", content: "late", source: "github.com/acme/site@main", after: 5 },
    { path: "a.js", content: "elsewhere", source: "github.com/acme/site-two@main", after: 0 },
    { path: "a.js", content: "local", source: "workspace", after: 0 },
  ];
  assert.deepEqual(attachedFrom(room, "acme/site", { path: "a.js", at: 4 }), ["seen"]);
  // Notes about commits are not sent to the agents.
  assert.ok(!turnContext(room).transcript.some((m) => m.speaker === "Quorum"));
});

test("a credential Quorum was started with never writes the default branch", async (t) => {
  const github = fakeGitHub(t);
  const main = github.refs.get("main");
  process.env.QUORUM_GITHUB_TOKEN = OTHER;
  process.env.QUORUM_GITHUB_WRITE = "1";
  await assert.rejects(commit([file("a.js", "1\n")], { ...direct, key: undefined }), /needs an access key entered in the page/);
  assert.equal(github.writes().length, 0);
  assert.equal(github.refs.get("main"), main);
  // The same credential may still use the branch with a pull request.
  const usual = await commit([file("a.js", "1\n")], { key: undefined });
  assert.match(usual.branch!, /^quorum\//);
  assert.equal(github.refs.get("main"), main);
});
