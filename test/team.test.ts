import test from "node:test";
import assert from "node:assert/strict";
import {
  addParticipant,
  advanceRound,
  buildAgent,
  buildTask,
  canCreateFiles,
  inTeamOrder,
  makePrompt,
  nextParticipant,
  normalizeAgent,
  orderMeeting,
  planBuild,
  promptWriter,
  removeParticipant,
  stageOf,
  turnContext,
} from "../src/engine.ts";
import type { Agent, Meeting, Stage } from "../src/engine.ts";
import { addProductTeam, starterAgents } from "../src/agent-templates.ts";

test("agents are classified from their names, specific roles before general words", () => {
  const cases: Record<Stage, string[]> = {
    product: ["Product Manager", "Product Owner", "Head of Product", "product-manager", "CPO"],
    design: ["Designer", "Product Designer", "UI/UX Designer", "UX Researcher", "Design Lead", "ui-ux-designer", "UX Architect"],
    engineering: ["Developer", "Software Architect", "AI Engineer", "DevOps Engineer", "Frontend Developer", "Product Engineer", "UI Developer", "Architect", "CTO", "backend-dev"],
    security: ["Security Engineer", "CISO", "security-auditor", "AppSec Lead", "Chief Information Security Officer", "Penetration Tester"],
    project: ["Project Manager", "project-manager", "Technical Program Manager", "Scrum Master", "Delivery Lead"],
    other: ["QA", "QA Engineer", "Test Engineer", "Business Developer", "Developer Advocate", "Sales", "Product Marketing Manager", "Marketing", "Customer Support", "Technical Writer", "Data Analyst", "Finance Partner", "Legal & Privacy", "Devil's Advocate", "Critic", "Production Planner", "Operations Lead"],
  };
  for (const [stage, names] of Object.entries(cases))
    for (const name of names) assert.equal(stageOf({ name }), stage, name);
  // A group helps only when the name says nothing, and the broad groups never decide.
  assert.equal(stageOf({ name: "Ada", category: "Security" }), "security");
  assert.equal(stageOf({ name: "Ada", category: "Design" }), "design");
  assert.equal(stageOf({ name: "Ada", category: "Engineering" }), "engineering");
  assert.equal(stageOf({ name: "Ada", category: "Product" }), "other");
  assert.equal(stageOf({ name: "Ada", category: "Build" }), "other");
  assert.equal(stageOf({ name: "QA", category: "Engineering" }), "other");
  const built = Object.fromEntries(starterAgents.map((a) => [a.name, stageOf(a)]));
  assert.equal(built["Technical Writer"], "other");
  assert.equal(built.Designer, "design");
});

const member = (name: string) => normalizeAgent({ id: name, name, provider: "demo" });
const team = ["Product Manager", "Designer", "Developer", "CISO", "Sales", "Project Manager"];
const room = (...names: string[]) => ({ participants: names.map(member), cursor: 0 }) as Meeting;
const names = (m: Pick<Meeting, "participants">) => m.participants.map((p) => p.name);
const next = (m: Pick<Meeting, "participants" | "cursor">) => nextParticipant(m.participants, m.cursor ?? 0).name;
/** Take rotation turns. @returns for each, whether it completed a round */
const take = (m: Meeting, count: number) =>
  Array.from({ length: count }, () => advanceRound(m, nextParticipant(m.participants, m.cursor ?? 0).id));

test("participants are put in speaking order, keeping the order within a stage", () => {
  const mixed = ["Project Manager", "Sales", "Developer", "QA", "CISO", "Software Architect", "Designer", "Product Manager"].map(member);
  assert.deepEqual(inTeamOrder(mixed).map((p) => p.name), [
    "Product Manager", "Designer", "Developer", "Software Architect", "CISO", "Sales", "QA", "Project Manager",
  ]);
});

test("a round is complete when every stage has spoken and the last one finishes", () => {
  const m = room(...team);
  assert.deepEqual(take(m, 6), [false, false, false, false, false, true]);
  assert.equal(m.rounds, 1);
  assert.equal(next(m), "Product Manager");
  assert.deepEqual(take(m, 6).at(-1), true);
  assert.equal(m.rounds, 2);
  // A rotation that started halfway does not count until it has been all the way round.
  const late = { ...room(...team), cursor: 3 };
  assert.ok(take(late, 3).every((done) => !done));
  assert.equal(late.rounds, undefined);
  assert.equal(take(late, 6).at(-1), true);
  // Two agents of one stage: either speaking covers the stage.
  const pair = room("Developer", "Software Architect");
  advanceRound(pair, "Developer", false);
  assert.equal(advanceRound(pair, "Software Architect"), true);
  // An agent that has never said anything leaves its stage uncovered.
  const silent = room("Product Manager", "Project Manager");
  advanceRound(silent, "Product Manager", false);
  assert.equal(advanceRound(silent, "Project Manager"), false);
});

test("an agent added mid-meeting takes its place and the next speaker stays right", () => {
  const start = () => {
    const m = room("Product Manager", "Developer", "Project Manager");
    take(m, 2);
    return m;
  };
  // Last spoke the developer, next is the project manager.
  const between = start();
  addParticipant(between, member("CISO"));
  assert.deepEqual(names(between), ["Product Manager", "Developer", "CISO", "Project Manager"]);
  assert.equal(next(between), "CISO");
  // A place already passed this round waits for the next one.
  const passed = start();
  addParticipant(passed, member("Designer"));
  assert.deepEqual(names(passed), ["Product Manager", "Designer", "Developer", "Project Manager"]);
  assert.equal(next(passed), "Project Manager");
  // The end and the start of the order are the same place in the loop.
  const wrapped = room("Developer", "CISO");
  take(wrapped, 2);
  addParticipant(wrapped, member("Product Manager"));
  assert.equal(next(wrapped), "Product Manager");
  const after = room("Product Manager", "Developer");
  take(after, 2);
  addParticipant(after, member("Project Manager"));
  assert.equal(next(after), "Project Manager");
  // Before anyone has spoken, the order starts at the top.
  const fresh = room("Developer", "CISO");
  addParticipant(fresh, member("Project Manager"));
  assert.equal(next(fresh), "Developer");
  addParticipant(fresh, member("Product Manager"));
  assert.equal(next(fresh), "Product Manager");
  // While an agent is thinking it keeps its turn, and the newcomer follows if it fits there.
  const busy = start();
  addParticipant(busy, member("CISO"), "Project Manager");
  assert.equal(next(busy), "Project Manager");
  const following = start();
  take(following, 1);
  take(following, 1);
  addParticipant(following, member("Designer"), "Product Manager");
  advanceRound(following, "Product Manager");
  assert.equal(next(following), "Designer");
});

test("removing an agent keeps the order, and can close the round", () => {
  const m = room("Product Manager", "Developer", "Project Manager");
  take(m, 2);
  removeParticipant(m, "Project Manager");
  assert.equal(next(m), "Product Manager");
  assert.equal(m.rounds, 1);
  const other = room("Product Manager", "Developer", "Project Manager");
  take(other, 1);
  removeParticipant(other, "Developer");
  assert.equal(next(other), "Project Manager");
  assert.equal(other.rounds, undefined);
});

test("an older meeting is reordered once without losing whose turn it is", () => {
  const old = (cursor: number, speakers: string[]) =>
    ({
      id: "m",
      goal: "g",
      status: "paused",
      cursor,
      participants: ["Project Manager", "Developer", "Product Manager", "Designer"].map(member),
      transcript: speakers.map((speaker) => ({ speaker, text: "hello" })),
    }) as Meeting;
  // Project manager and developer have spoken; the product manager was next.
  const m = old(6, ["Project Manager", "Developer"]);
  orderMeeting(m);
  assert.deepEqual(names(m), ["Product Manager", "Designer", "Developer", "Project Manager"]);
  assert.equal(next(m), "Product Manager");
  assert.equal(m.ordered, true);
  const middle = old(3, ["Project Manager", "Developer", "Product Manager"]);
  orderMeeting(middle);
  assert.equal(next(middle), "Designer");
  assert.deepEqual(middle.round, ["product"]);
  // Once only: a second call changes nothing.
  middle.cursor = 3;
  orderMeeting(middle);
  assert.equal(middle.cursor, 3);
  const untouched = old(0, []);
  orderMeeting(untouched);
  assert.equal(next(untouched), "Product Manager");
  const accepted = { ...old(1, ["Project Manager"]), status: "accepted" as const };
  orderMeeting(accepted);
  assert.equal(accepted.participants[0].name, "Project Manager");
});

test("each agent is told the order, its stage and what the stage adds", () => {
  const m = room(...team);
  m.goal = "Cups";
  m.transcript = [];
  const system = (name: string) => makePrompt(member(name), turnContext(m)).system;
  assert.match(system("Developer"), /1\. Product Manager \(Product\), 2\. Designer \(UI\/UX design\), 3\. Developer \(Engineering\)[\s\S]*You are number 3\./);
  assert.match(system("Product Manager"), /who the user is, the problem[\s\S]*scope[\s\S]*acceptance criteria/);
  assert.match(system("Designer"), /interface, and deliver or update the design files/);
  assert.match(system("Developer"), /plan how to build[\s\S]*write the code/);
  assert.match(system("CISO"), /risks[\s\S]*fix for each/);
  assert.match(system("Project Manager"), /decisions[\s\S]*owner[\s\S]*ready to build/);
  const task = makePrompt(member("Developer"), { ...turnContext(m), task: buildTask("code", true) });
  assert.match(task.system, /this is your build step\. Write the code/);
  assert.equal(task.system.includes("file:relative/path.ext"), true);
});

test("a build goes design, code, review, then summary, respecting the files switch", () => {
  const agents = (extra: Partial<Agent> = {}, who = "") =>
    ["Product Manager", "UX Researcher", "Designer", "Developer", "CISO", "Project Manager"].map((name) => ({
      ...member(name),
      ...(name === who ? extra : {}),
    }));
  const plan = planBuild(agents());
  assert.deepEqual(plan.steps.map((s) => [s.id, s.kind]), [
    ["Designer", "design"], ["Developer", "code"], ["CISO", "review"], ["Project Manager", "summary"],
  ]);
  assert.deepEqual([plan.refused, plan.missing, plan.possible], [[], [], true]);
  // Names that are off by default may create files for this pass, and the host is told.
  const quiet = planBuild(["Ada", "Developer"].map((name) => ({ ...member(name), category: name === "Ada" ? "Security" : "" })));
  assert.deepEqual(quiet.allowed, ["Ada"]);
  assert.deepEqual(quiet.missing, ["design", "project"]);
  assert.equal(canCreateFiles(buildAgent(member("Sales"), "review")), true);
  // A switch the host turned off stays off.
  const off = planBuild(agents({ files: false }, "CISO"));
  assert.deepEqual(off.refused, ["CISO"]);
  assert.deepEqual(off.steps.map((s) => s.kind), ["design", "code", "review", "fix", "summary"]);
  assert.equal(buildAgent({ ...member("CISO"), files: false }, "review").files, false);
  assert.equal(buildAgent(member("Project Manager"), "summary").files, undefined);
  assert.match(buildTask("review", false), /Do not send files/);
  assert.equal(planBuild([{ ...member("Developer"), files: false }]).possible, false);
  assert.equal(planBuild([member("Sales")]).possible, false);
});

test("engineering writes the prompt, else the project manager, else the first", () => {
  const pick = (...list: string[]) => promptWriter(list.map(member))!.name;
  assert.equal(pick("Product Manager", "Developer", "Project Manager"), "Developer");
  assert.equal(pick("Product Manager", "Project Manager"), "Project Manager");
  assert.equal(pick("Sales", "Designer"), "Sales");
});

test("the product team reuses the host's agents and creates the missing ones", () => {
  const mine = normalizeAgent({ id: "mine", name: "Frontend Developer", provider: "claude" });
  const demo = member("Architect");
  const deleted = structuredClone(starterAgents.find((a) => a.name === "Designer")!);
  const state = { agents: [demo, mine], deletedAgents: [deleted] };
  const first = addProductTeam(state, "claude");
  assert.deepEqual(first.added, ["Product Manager", "Designer", "CISO", "Project Manager"]);
  const chosen = first.team.map((id) => state.agents.find((a) => a.id === id)!);
  assert.deepEqual(chosen.map(stageOf), ["product", "design", "engineering", "security", "project"]);
  assert.equal(chosen[2].id, "mine");
  assert.ok(chosen.every((a) => a.provider === "claude"));
  // A deleted agent's id is not given out again.
  assert.notEqual(chosen[1].id, deleted.id);
  const again = addProductTeam(state, "claude");
  assert.deepEqual([again.added, again.team], [[], first.team]);
  // Without a connected provider the built-ins keep their own; a taken name gets a number.
  const named = { agents: [member("Developer")] };
  const result = addProductTeam(named, "demo");
  assert.ok(result.added.includes("Developer 2"));
  assert.ok(named.agents.slice(1).every((a) => a.provider === "ollama"));
});
