import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDocument,
  listLocal,
  readLocal,
  listLibrary,
  readLibrary,
  parseGitHubURL,
  listGitHub,
  readGitHub,
} from "../src/import.js";
import { normalizeAgent, MAX_SKILL_CHARS } from "../src/engine.js";

const saved = { ...process.env };
let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "quorum-skills-"));
  const skills = join(root, "skills");
  await mkdir(join(skills, "review"), { recursive: true });
  await writeFile(
    join(skills, "review/SKILL.md"),
    "---\nname: code-review\ndescription: >\n  Review a change\n  carefully.\n---\n# Review\nRead the diff.\n",
  );
  await mkdir(join(root, "elsewhere/long"), { recursive: true });
  await writeFile(join(root, "elsewhere/long/SKILL.md"), "x".repeat(MAX_SKILL_CHARS + 10));
  await symlink(join(root, "elsewhere/long"), join(skills, "long"));
  // A link back to the top must not make the scan loop.
  await symlink(skills, join(skills, "review/loop"));
  await writeFile(join(skills, "review/notes.md"), "not a skill");
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, "agents/reviewer.md"),
    "---\nname: pr-reviewer\ndescription: Reviews changes\nmodel: opus\nskills:\n  - code-review\n  - missing\n---\nYou review pull requests.\n",
  );
  await writeFile(join(root, "agents/README.md"), "---\nname: docs\n---\nAbout");
  await writeFile(join(root, "agents/plain.md"), "No front matter");
  process.env.CLAUDE_SKILLS_DIR = skills;
  process.env.CLAUDE_AGENTS_DIR = join(root, "agents");
});
after(async () => {
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});

test("front matter supplies the profile fields", () => {
  const parsed = parseDocument('---\nname: "A"\ndescription: One\n  two\nskills: [x, "y"]\nlicense: MIT\n---\nBody');
  assert.deepEqual(parsed, { name: "A", description: "One two", model: "", skills: ["x", "y"], body: "Body" });
  assert.equal(parseDocument("Just text").body, "Just text");
});

test("local Claude agents and skills are listed and read only by id", async () => {
  const { items } = await listLocal();
  assert.deepEqual(items.map((i) => [i.kind, i.name]), [
    ["skill", "code-review"], ["skill", "long"], ["agent", "pr-reviewer"],
  ]);
  assert.equal(items[0].description, "Review a change carefully.");
  assert.ok(!("content" in items[0]));
  const read = await readLocal(items.map((i) => i.id));
  const [review, long, agent] = read.items;
  assert.equal(review.text, "# Review\nRead the diff.");
  assert.equal(long.text.length, MAX_SKILL_CHARS);
  assert.equal(long.truncated, true);
  assert.equal(agent.name, "Pr Reviewer");
  assert.equal(agent.model, "opus");
  assert.equal(agent.instructions, "You review pull requests.");
  assert.deepEqual(agent.skills.map((s) => s.name), ["code-review"]);
  await assert.rejects(readLocal(["../../etc/passwd"]), /no longer there/);
  await assert.rejects(readLocal([]), /between 1 and/);
});

test("every included skill is listed with its source and can be added", async () => {
  delete process.env.QUORUM_SKILLS_DIR;
  const { items } = await listLibrary();
  assert.ok(items.length > 200, String(items.length));
  assert.ok(items.every((i) => i.kind === "skill" && /^github\.com\/[\w-]+\/[\w.-]+$/.test(i.source)));
  const marketing = items.find((i) => i.name === "pricing");
  const { items: [skill] } = await readLibrary([marketing.id]);
  assert.ok(skill.text.length > 500);
});

test("only GitHub addresses are accepted", () => {
  assert.deepEqual(parseGitHubURL("acme/skills"), {
    owner: "acme", repo: "skills", ref: "HEAD", path: "", file: false,
  });
  assert.deepEqual(parseGitHubURL("https://github.com/acme/skills.git/tree/main/a/b"), {
    owner: "acme", repo: "skills", ref: "main", path: "a/b", file: false,
  });
  for (const bad of [
    "",
    "http://github.com/acme/skills",
    "https://evil.test/acme/skills",
    "https://github.com.evil.test/acme/skills",
    "https://github.com:8443/acme/skills",
    "https://github.com/acme",
    "https://github.com/acme/skills/issues/1",
    "https://github.com/acme/skills/tree/main/%2e%2e%2fsecret",
    "file:///etc/passwd",
  ])
    assert.throws(() => parseGitHubURL(bad), undefined, bad);
});

test("a repository's profiles and skills are fetched from GitHub only", async (t) => {
  const calls = [];
  const blob = (path) => ({ type: "blob", path });
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://api.github.com/"))
      return Response.json({
        tree: [
          "README.md", "kit/agents/planner.md", "kit/agents/README.md", "kit/agents/notes.md",
          "kit/skills/plan/SKILL.md", "kit/skills/plan/agents/helper.md", "docs/guide.md",
        ].map(blob),
      });
    if (String(url).endsWith("planner.md"))
      return new Response("---\nname: planner\nmodel: inherit\nskills: plan\n---\nPlan first.");
    if (String(url).endsWith("notes.md")) return new Response("Just notes");
    return new Response("---\nname: planning\n---\nWrite the plan.");
  });
  const listed = await listGitHub("https://github.com/acme/kit/tree/main/kit");
  assert.deepEqual(listed.items.map((i) => [i.kind, i.path]), [
    ["agent", "kit/agents/planner.md"],
    ["agent", "kit/agents/notes.md"],
    ["skill", "kit/skills/plan/SKILL.md"],
  ]);
  calls.length = 0;
  const read = await readGitHub("acme/kit", ["kit/agents/planner.md", "kit/agents/notes.md"]);
  assert.deepEqual(read.skipped, ["kit/agents/notes.md"]);
  assert.equal(read.items[0].name, "Planner");
  assert.equal(read.items[0].model, "");
  assert.equal(read.items[0].source, "github.com/acme/kit");
  assert.deepEqual(read.items[0].skills.map((s) => s.name), ["planning"]);
  assert.ok(calls.every((c) => /^https:\/\/(api\.github|raw\.githubusercontent)\.com\//.test(c)));
  for (const paths of [["../x.md"], ["a/../../x.md"], ["run.sh"], []])
    await assert.rejects(readGitHub("acme/kit", paths));
});

test("a collection without an agents folder still lists its profiles", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      tree: ["README.md", "backend/api.md", ".github/pull.md", ".claude/commands/ship.md", "LICENSE.md"].map((path) => ({ type: "blob", path })),
    }),
  );
  const listed = await listGitHub("acme/agents");
  assert.deepEqual(listed.items.map((i) => i.path), ["backend/api.md"]);
});

test("GitHub failures explain what to do", async (t) => {
  let status = 404;
  t.mock.method(globalThis, "fetch", async () => new Response("", { status }));
  await assert.rejects(listGitHub("acme/private"), /QUORUM_GITHUB_TOKEN/);
  status = 403;
  await assert.rejects(listGitHub("acme/private"), /hourly limit/);
});

test("agents keep long skills and where they came from", () => {
  const agent = normalizeAgent({
    name: "A",
    provider: "claude",
    skills: [{ name: "s", text: "y".repeat(20_000), source: "github.com/acme/kit" }],
  });
  assert.equal(agent.skills[0].text.length, 20_000);
  assert.equal(agent.skills[0].source, "github.com/acme/kit");
});
