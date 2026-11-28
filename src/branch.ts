import { createHash } from "node:crypto";
import { hasKey, KEY_REMOVED, MAX_FILE_BYTES, safeFilePath, slug } from "./engine.ts";
import type { CommitResult, HeldReason, ProjectFile } from "./engine.ts";
import {
  checkRepository,
  encodePath,
  fail,
  guarded,
  objectId,
  repositoryAPI,
  suppliedKey,
  tokenSource,
  writeToken,
} from "./github.ts";
import type { Failure } from "./github.ts";
import { checkFiles, decodeText } from "./workspace.ts";

/**
 * The commits a connected meeting makes as its agents write, and reading the files of that
 * repository. They go to a quorum/ branch made for the meeting, created from the default
 * branch, unless the request carries the host's choice to commit straight to the default
 * branch and names it. No other existing branch is ever written, and a branch only moves
 * forward from its own head. A file the meeting has not seen in its current state is left
 * alone, and nothing is ever deleted or renamed. Like a push, this keeps nothing between
 * requests.
 */
const MAX_LISTED = 500;
const MAX_NAMES = 20;

type API = ReturnType<typeof repositoryAPI>;
interface Entry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}
interface Tree {
  tree?: Entry[];
  truncated?: boolean;
}
interface Pull {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  merged_at?: unknown;
  body?: unknown;
  head?: { ref?: unknown };
}

const notFound = (error: unknown) => (error as { status?: number }).status === 404;

/** The credential for a request: the host's key first, else one Quorum was started with. */
async function connect(request: { repo?: unknown }, key: string, writing: boolean, signal?: AbortSignal) {
  // Reading may also use the token that was set only to read private files.
  const reader = writing ? "" : (process.env.QUORUM_GITHUB_TOKEN?.trim() ?? "");
  if (!key && !tokenSource() && !reader)
    throw fail("Enter a GitHub access key for this repository.", 403);
  const { owner, repo, name } = checkRepository(request.repo);
  const token = key || (tokenSource() ? await writeToken(signal) : reader);
  if (!/^[\x21-\x7e]+$/.test(token)) throw fail("The GitHub token is not in a usable format.", 403);
  return { owner, name, call: repositoryAPI(token, owner + "/" + repo, signal, Boolean(key)) };
}

async function defaultBranch(call: API) {
  const { default_branch: base } = await call<{ default_branch?: unknown }>("");
  if (typeof base !== "string" || !base) throw fail("GitHub sent no default branch.", 502);
  return base;
}

/** The commit a branch points at, or null when there is no such branch. */
async function headOf(call: API, branch: string) {
  try {
    const ref = await call<{ object?: { sha?: unknown } }>("/git/ref/heads/" + encodePath(branch));
    return objectId(ref.object?.sha);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function commitAt(call: API, sha: string) {
  const commit = await call<{ message?: unknown; tree?: { sha?: unknown } }>("/git/commits/" + sha);
  return { message: String(commit.message ?? ""), tree: objectId(commit.tree?.sha) };
}

/** What sits at a path in a tree, read one folder at a time so size never hides a file. */
function finder(call: API, root: string) {
  const folders = new Map<string, Promise<Tree>>();
  const read = (sha: string) => {
    let tree = folders.get(sha);
    if (!tree) folders.set(sha, (tree = call<Tree>("/git/trees/" + sha)));
    return tree;
  };
  type Found =
    | { kind: "free" }
    | { kind: "file"; sha: string; mode: string }
    | { kind: "blocked"; why: string };
  return async (path: string): Promise<Found> => {
    const parts = path.split("/");
    let at = root;
    for (let i = 0; ; i++) {
      const { tree = [], truncated } = await read(at);
      const here = parts.slice(0, i + 1).join("/");
      const entry = tree.find((e) => e.path === parts[i]);
      if (!entry) {
        if (truncated) return { kind: "blocked", why: "its folder is too large to check" };
        const other = tree.find((e) => e.path.toLowerCase() === parts[i].toLowerCase());
        return other
          ? { kind: "blocked", why: "the repository has " + other.path + ", which differs only in letter case" }
          : { kind: "free" };
      }
      if (i < parts.length - 1) {
        // Writing below a file would remove it.
        if (entry.type !== "tree") return { kind: "blocked", why: here + " is a file in the repository" };
        at = objectId(entry.sha);
        continue;
      }
      // Writing over a folder, link or submodule would remove what is there.
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        return { kind: "blocked", why: here + " is a folder, link or submodule in the repository" };
      return { kind: "file", sha: objectId(entry.sha), mode: entry.mode };
    }
  };
}

/** The id git gives these contents, in a repository whose ids have this length. */
export function blobId(content: string, length = 40) {
  return createHash(length === 64 ? "sha256" : "sha1")
    .update("blob " + Buffer.byteLength(content) + "\0")
    .update(content)
    .digest("hex");
}

/** Words for a commit or pull request that mention no one and close nothing. */
function plain(value: unknown, size: number) {
  return String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/[@#<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, size);
}

interface Meeting {
  id: string;
  goal: string;
}
const marker = (meeting: Meeting) => "<!-- quorum-meeting: " + meeting.id + " -->";
const trailer = (meeting: Meeting) => "Quorum-Meeting: " + meeting.id;

function checkMeeting(value: unknown): Meeting {
  const { id, goal } = Object(value) as { id?: unknown; goal?: unknown };
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id))
    throw fail("The meeting is not identified.");
  return { id, goal: plain(String(goal ?? "").split("\n")[0], 150) };
}

/** The names this meeting's branches may have: its goal, then an id taken from the meeting's. */
function branchNames(meeting: Meeting) {
  const short = createHash("sha256").update(meeting.id).digest("hex").slice(0, 8);
  const words = slug(meeting.goal.normalize("NFKD").replace(/[^\x20-\x7e]/g, ""), 40) || "meeting";
  return {
    first: "quorum/" + words + "-" + short,
    ours: new RegExp("^quorum/[a-z0-9]+(?:-[a-z0-9]+)*-" + short + "(?:-[0-9]{1,2})?$"),
  };
}

async function pullsFrom(call: API, owner: string, branch: string) {
  const list = await call<Pull[]>(
    "/pulls?state=all&per_page=100&head=" + encodeURIComponent(owner + ":" + branch),
  );
  if (!Array.isArray(list)) throw fail("GitHub sent an answer Quorum could not read.", 502);
  // GitHub ignores a filter it does not understand, so the branch is checked again.
  return list.filter((p) => p.head?.ref === undefined || p.head.ref === branch);
}

function pullLink(pull: Pull) {
  const url = String(pull.html_url ?? "");
  const number = Number(pull.number);
  return url.startsWith("https://github.com/") && Number.isInteger(number)
    ? { number, url }
    : undefined;
}

type Branch =
  | { state: "free" }
  | { state: "open"; head: string; pull?: Pull }
  | { state: "gone"; why: "deleted" | "merged" | "closed" }
  | { state: "foreign" };

/** Whether a branch name can take this meeting's next commit. */
async function inspectBranch(call: API, owner: string, name: string, meeting: Meeting): Promise<Branch> {
  const head = await headOf(call, name);
  const pulls = await pullsFrom(call, owner, name);
  const marked = pulls.some((p) => String(p.body ?? "").includes(marker(meeting)));
  if (!head) return marked ? { state: "gone", why: "deleted" } : { state: "free" };
  // This meeting made it if its pull request or the commit at its head says so.
  if (!marked && !(await commitAt(call, head)).message.split("\n").includes(trailer(meeting)))
    return { state: "foreign" };
  const open = pulls.find((p) => p.state === "open");
  if (open) return { state: "open", head, pull: open };
  if (pulls.length)
    return { state: "gone", why: pulls.some((p) => p.merged_at) ? "merged" : "closed" };
  return { state: "open", head };
}

interface Target {
  name: string;
  /** The head to build on, or null to create the branch from the default branch. */
  head: string | null;
  pull?: Pull;
  started?: CommitResult["started"];
}

/** Choose the branch for a commit: the meeting's current one, or a new one if that is over. */
async function chooseBranch(
  call: API,
  owner: string,
  meeting: Meeting,
  current: unknown,
  base: string,
): Promise<Target> {
  const { first, ours } = branchNames(meeting);
  let started: CommitResult["started"] = "first";
  let old = "";
  if (current !== undefined && current !== null && current !== "") {
    if (typeof current !== "string" || !ours.test(current) || current === base)
      throw fail("Quorum commits only to a branch it made for this meeting, never to " +
        (current === base ? "the default branch." : "another one."), 403);
    const found = await inspectBranch(call, owner, current, meeting);
    if (found.state === "open") return { name: current, head: found.head, pull: found.pull };
    if (found.state === "foreign")
      throw fail("The branch " + current + " was not made by Quorum for this meeting, so it is left alone.", 403);
    started = found.state === "gone" ? found.why : "deleted";
    old = current;
  }
  for (let n = 1; n <= MAX_NAMES; n++) {
    const name = n === 1 ? first : first + "-" + n;
    if (name === old || name === base) continue;
    const found = await inspectBranch(call, owner, name, meeting);
    if (found.state === "free") return { name, head: null, started };
    // An earlier connection of this meeting may have left its branch behind.
    if (found.state === "open") return { name, head: found.head, pull: found.pull };
    if (found.state === "gone" && started === "first") started = found.why;
  }
  throw fail("Every branch name for this meeting is taken. Delete old quorum/ branches.", 409);
}

export interface AutoCommit {
  repo?: unknown;
  /** The meeting's id and goal. */
  meeting?: unknown;
  /** The branch the meeting last committed to. */
  branch?: unknown;
  /** True only when the host chose to commit straight to the default branch. */
  direct?: unknown;
  /** The default branch the host confirmed for that. */
  confirmedBranch?: unknown;
  /** Each with `seen`: ids of the contents of that path the meeting may replace. */
  files?: unknown;
  /** Who proposed the files. */
  agents?: unknown;
  key?: unknown;
}

// One commit at a time, so two can never build on the same head.
let queue: Promise<unknown> = Promise.resolve();

/** Commit what changed to the meeting's branch, holding back what must not be replaced. */
export async function autoCommit(request: AutoCommit, signal?: AbortSignal): Promise<CommitResult> {
  const key = suppliedKey(request.key);
  const turn = queue.then(() => guarded(key, () => commitChanges(request, key, signal)));
  queue = turn.catch(() => {});
  return turn;
}

/** A refusal to write straight to the default branch, which the host can act on. */
const directRefusal = (message: string) =>
  Object.assign(fail(message, 409), { directRefused: true });

/** Compare proposed files with a commit, deciding what to write, skip or hold back. */
async function compare(
  call: API,
  parent: string,
  files: ProjectFile[],
  seen: Map<string, string[]>,
  key: string,
) {
  const tree = (await commitAt(call, parent)).tree;
  const find = finder(call, tree);
  const written: CommitResult["written"] = [];
  const unchanged: CommitResult["unchanged"] = [];
  const held: CommitResult["held"] = [];
  const entries: Array<{ path: string; mode: string; type: "blob"; content: string }> = [];
  const changes: Record<"add" | "update", string[]> = { add: [], update: [] };
  for (const { path, content } of files) {
    const hold = (reason: HeldReason, why: string, current?: string) =>
      held.push({ path, reason, why, ...(current ? { current } : {}) });
    // Refused rather than changed, as with a push.
    if (hasKey(content) || content.includes(KEY_REMOVED) || (key && content.includes(key))) {
      hold("secret", "it contains a GitHub key, or had one removed from it");
      continue;
    }
    const found = await find(path);
    if (found.kind === "blocked") {
      hold("blocked", found.why);
      continue;
    }
    const id = blobId(content, parent.length);
    if (found.kind === "file") {
      if (found.sha === id) {
        unchanged.push({ path, sha: id });
        continue;
      }
      if (!seen.get(path)!.includes(found.sha)) {
        hold("exists", "it already exists with contents this meeting has not seen", found.sha);
        continue;
      }
    }
    written.push({ path, sha: id });
    changes[found.kind === "file" ? "update" : "add"].push(path);
    // An executable file stays executable.
    entries.push({ path, mode: found.kind === "file" ? found.mode : "100644", type: "blob", content });
  }
  return { tree, written, unchanged, held, entries, changes };
}

async function commitChanges(request: AutoCommit, key: string, signal?: AbortSignal): Promise<CommitResult> {
  if (!key && !tokenSource())
    throw fail("Enter a GitHub access key to commit.", 403);
  const meeting = checkMeeting(request.meeting);
  const files = checkFiles(request.files);
  const names = Array.isArray(request.agents)
    ? [...new Set(request.agents.map((name) => plain(name, 80)).filter(Boolean))].slice(0, 12)
    : [];
  // Nothing that names things may carry a key: it would be published.
  const labels = JSON.stringify([
    request.repo, request.meeting, request.branch, request.confirmedBranch, request.agents,
    files.map((f) => f.path),
  ]);
  if (hasKey(labels) || (key && labels.includes(key)))
    throw fail("A GitHub key appears in the repository, meeting or file names. Remove it first.");
  // Only the exact value counts: nothing merely truthy sends a commit to the default branch.
  if (request.direct !== undefined && typeof request.direct !== "boolean")
    throw fail("Say true or false for committing straight to the default branch.");
  const direct = request.direct === true;
  // A credential Quorum was started with is usable by any program on this computer, so it
  // never writes the default branch: that takes the key the host entered in the page.
  if (direct && !key)
    throw directRefusal(
      "Committing straight to the default branch needs an access key entered in the page. Nothing was committed.",
    );
  // A credential Quorum was started with is usable by any program on this computer, so it
  // never writes the default branch: that takes the key the host entered in the page.
  if (direct && !key)
    throw directRefusal(
      "Committing straight to the default branch needs an access key entered in the page. Nothing was committed.",
    );
  const seen = new Map(
    (request.files as Array<{ path: string; seen?: unknown }>).map((f) => [
      f.path,
      Array.isArray(f.seen) ? f.seen.filter((id) => typeof id === "string") : [],
    ]),
  );
  const { owner, name: repository, call } = await connect(request, key, true, signal);

  /** The default branch, which for a direct commit must be the one the host confirmed. */
  async function currentDefault() {
    const base = await defaultBranch(call);
    if (direct && request.confirmedBranch !== base)
      throw directRefusal(
        "The default branch of " + repository + " is " + base + ", which is not the branch confirmed " +
          "for direct commits. Nothing was committed.",
      );
    return base;
  }

  let base = await currentDefault();
  const target: Target = direct
    ? { name: base, head: await headOf(call, base) }
    : await chooseBranch(call, owner, meeting, request.branch, base);
  // A direct commit only ever moves a branch that exists.
  if (direct && !target.head) throw fail(repository + " has no commits yet. Add one first.", 409);
  // A direct commit that finds the branch moved is compared again, once.
  for (let attempt = 0; ; attempt++) {
    const parent = target.head ?? (await headOf(call, base));
    if (!parent) throw fail(repository + " has no commits yet. Add one first.", 409);
    const { tree: parentTree, written, unchanged, held, entries, changes } = await compare(
      call, parent, files, seen, key,
    );
    const result: CommitResult = {
      repo: repository,
      ...(direct ? { direct: true } : {}),
      // Which ref the files were compared with, so the current version can be fetched.
      compared: target.head ? target.name : base,
      ...(target.head ? { branch: target.name } : {}),
      ...(target.pull ? { pull: pullLink(target.pull) } : {}),
      written,
      unchanged,
      held,
    };
    if (!entries.length) return result;
    const tree = objectId(
      (await call<{ sha?: unknown }>("/git/trees", { base_tree: parentTree, tree: entries })).sha,
    );
    const what = (["add", "update"] as const)
      .filter((kind) => changes[kind].length)
      .map((kind) => kind + " " + changes[kind].map((p) => plain(p, 200)).join(", "))
      .join("; ");
    const message = [
      ((names.join(", ") || "Quorum") + ": " + what).slice(0, 200),
      "Proposed in a Quorum meeting and committed automatically.",
      trailer(meeting),
    ].join("\n\n");
    const commit = objectId(
      (await call<{ sha?: unknown }>("/git/commits", { message, tree, parents: [parent] })).sha,
    );
    // The last check before a branch moves: the confirmed default, or this meeting's own.
    const allowed = direct
      ? target.name === base && request.confirmedBranch === base
      : target.name !== base && branchNames(meeting).ours.test(target.name);
    if (!allowed) throw fail("Quorum will not write to the branch " + target.name + ".", 403);
    try {
      if (target.head)
        // Without force, GitHub refuses anything but a step forward from the current head.
        await call("/git/refs/heads/" + encodePath(target.name), { sha: commit, force: false }, "PATCH");
      else await call("/git/refs", { ref: "refs/heads/" + target.name, sha: commit });
    } catch (error) {
      const cause = error as Failure;
      if (!direct || !(cause.status === 409 || cause.protected)) throw error;
      const now = await headOf(call, target.name);
      if (now === parent)
        throw directRefusal(
          "GitHub would not take a commit straight to " + target.name + ", usually because of branch " +
            "protection or repository rules. Nothing was committed. " + cause.message,
        );
      if (attempt || !now)
        throw fail(target.name + " kept moving while Quorum was committing. Nothing was committed. Retry.", 409);
      base = await currentDefault();
      target.head = now;
      continue;
    }

    result.branch = target.name;
    if (target.started) result.started = target.started;
    result.commit = { sha: commit, url: "https://github.com/" + repository + "/commit/" + commit };
    if (!direct && !result.pull) {
      try {
        const pull = await call<Pull>("/pulls", {
          title: ("Quorum: " + (meeting.goal || "meeting")).slice(0, 200),
          head: target.name,
          base,
          body: [
            "Code proposed in a Quorum meeting and committed automatically as agents wrote it. " +
              "Nobody has reviewed each file: read the changes before merging.",
            meeting.goal ? "Meeting goal: " + meeting.goal : "",
            marker(meeting),
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        result.pull = pullLink(pull);
      } catch (error) {
        // The commit stands; the next one tries the pull request again.
        result.warning = "The pull request could not be opened. " + (error as Error).message;
      }
    }
    return result;
  }
}

/** The ref to read: the meeting's branch while it exists, else the default branch. */
async function readingRef(call: API, branch: unknown) {
  if (typeof branch === "string" && /^quorum\/[a-z0-9-]{1,80}$/.test(branch)) {
    const head = await headOf(call, branch);
    if (head) return { ref: branch, head };
  }
  const base = await defaultBranch(call);
  const head = await headOf(call, base);
  if (!head) throw fail("The repository has no commits yet.", 409);
  return { ref: base, head };
}

/** Text files of the connected repository, for the host to pick from. Nothing is written. */
export async function listRepository(
  request: { repo?: unknown; branch?: unknown; key?: unknown },
  signal?: AbortSignal,
) {
  const key = suppliedKey(request.key);
  return guarded(key, async () => {
    const { name, call } = await connect(request, key, false, signal);
    const { ref, head } = await readingRef(call, request.branch);
    const { tree } = await commitAt(call, head);
    const listing = await call<Tree>("/git/trees/" + tree + "?recursive=1");
    const usable = (listing.tree ?? []).filter(
      (e) =>
        e.type === "blob" && ["100644", "100755"].includes(e.mode) &&
        safeFilePath(e.path) && (e.size ?? Infinity) <= MAX_FILE_BYTES,
    );
    return {
      repo: name,
      ref,
      files: usable.slice(0, MAX_LISTED).map((e) => ({ path: e.path, size: e.size! })),
      truncated: Boolean(listing.truncated) || usable.length > MAX_LISTED,
    };
  });
}

/** The contents of files the host picked in the connected repository. */
export async function readRepository(
  request: { repo?: unknown; branch?: unknown; paths?: unknown; key?: unknown },
  signal?: AbortSignal,
) {
  const key = suppliedKey(request.key);
  return guarded(key, async () => {
    const paths = Array.isArray(request.paths) ? (request.paths as unknown[]) : [];
    if (!paths.length || paths.length > 20) throw fail("Choose between 1 and 20 files.");
    const checked = paths.map((path) => {
      const safe = safeFilePath(path);
      if (!safe) throw fail("This file path is not allowed: " + String(path).slice(0, 200));
      return safe;
    });
    const { name, call } = await connect(request, key, false, signal);
    const { ref, head } = await readingRef(call, request.branch);
    const find = finder(call, (await commitAt(call, head)).tree);
    const files: Array<{ path: string; content: string; source: string }> = [];
    for (const path of checked) {
      const found = await find(path);
      if (found.kind !== "file") throw fail("There is no file at " + path + " on " + ref + ".", 404);
      const blob = await call<{ content?: unknown; size?: unknown }>("/git/blobs/" + found.sha);
      if (Number(blob.size) > MAX_FILE_BYTES || typeof blob.content !== "string")
        throw fail(path + " is larger than " + MAX_FILE_BYTES / 1000 + " KB.", 413);
      const content = decodeText(Buffer.from(blob.content, "base64"), path);
      files.push({ path, content, source: "github.com/" + name + "@" + ref });
    }
    return { files };
  });
}
