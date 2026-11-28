import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  canCreateFiles,
  isProvider,
  normalizeAgent,
  redactKeys,
  withoutKeys,
} from "./engine.ts";
import type { State } from "./engine.ts";
import { freshTurn } from "./turn.ts";
import type { TurnMeeting } from "./turn.ts";
import { transcribe, synthesize } from "./speech.ts";
import {
  modelSettings,
  installModel,
  chooseModel,
  claudeStatus,
} from "./models.ts";
import { addProductTeam, addStarterAgents } from "./agent-templates.ts";
import {
  listLocal,
  readLocal,
  listLibrary,
  readLibrary,
  listGitHub,
  readGitHub,
} from "./import.ts";
import {
  listWorkspace,
  readWorkspace,
  saveToWorkspace,
  readPreview,
  PREVIEW_HEADERS,
} from "./workspace.ts";
import { githubStatus, commitToGitHub, readGitHubFile } from "./github.ts";
import { addDraft, readDraft } from "./drafts.ts";
import { autoCommit, listRepository, readRepository } from "./branch.ts";
import { writeHandoff } from "./handoff.ts";

const port = Number(process.env.PORT ?? 4710);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const root = fileURLToPath(new URL("../public/", import.meta.url));
const dataDir = resolve(process.env.QUORUM_DATA ?? ".quorum");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, "quorum.sqlite"));
// Replaced rows are overwritten, so a removed key does not linger in the file.
db.exec("PRAGMA secure_delete = ON");
db.exec(
  "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
);
const select = db.prepare("SELECT value FROM state WHERE id=1");
const save = db.prepare(
  "INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
);
const assets = new Map<string, [file: string, type: string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.ts", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/heroui.css", ["heroui.css", "text/css; charset=utf-8"]],
  ["/engine.js", ["../src/engine.ts", "text/javascript; charset=utf-8"]],
  ["/import.js", ["import.ts", "text/javascript; charset=utf-8"]],
  ["/mentions.js", ["mentions.ts", "text/javascript; charset=utf-8"]],
  ["/files.js", ["files.ts", "text/javascript; charset=utf-8"]],
  ["/preview.js", ["preview.ts", "text/javascript; charset=utf-8"]],
  ["/next.js", ["next.ts", "text/javascript; charset=utf-8"]],
  ["/key.js", ["key.ts", "text/javascript; charset=utf-8"]],
  ["/repository.js", ["repository.ts", "text/javascript; charset=utf-8"]],
]);
// Docker listens on its network interface; the published port stays loopback-only.
const host: string = process.env.QUORUM_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "0.0.0.0"].includes(host))
  throw new Error("Invalid QUORUM_HOST");
const publicPort = Number(process.env.QUORUM_PUBLIC_PORT ?? port);
if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
  throw new Error("Invalid QUORUM_PUBLIC_PORT");
const hosts = new Set(
  [port, publicPort].flatMap((p) => ["localhost:" + p, "127.0.0.1:" + p]),
);
/** The saved workspace as JSON, or undefined before the first save. */
const storedState = () => select.get()?.value as string | undefined;
/** The only way the workspace is written, so no GitHub key is ever kept in it. */
const storeState = (state: unknown) => save.run(redactKeys(JSON.stringify(state)));
// A workspace saved before keys were removed on the way in is cleaned once.
const earlier = storedState();
if (earlier && redactKeys(earlier) !== earlier) save.run(redactKeys(earlier));
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  // No answer, an error included, repeats a GitHub key.
  res.end(redactKeys(JSON.stringify(data)));
}
async function body(req: IncomingMessage, limit: number) {
  const parts: Buffer[] = [];
  let size = 0;
  // No encoding is set on the request, so it yields bytes.
  for await (const part of req as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}
/** The result is unchecked: each route describes and validates the fields it reads. */
async function parseJSON(req: IncomingMessage, limit = 2_000_000): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw Object.assign(new Error("Expected JSON"), { status: 415 });
  try {
    return JSON.parse((await body(req, limit)).toString("utf8"));
  } catch (err) {
    if ((err as { status?: number }).status) throw err;
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}
// Twenty files of 200 KB, with room for JSON escaping.
const FILES_REQUEST_LIMIT = 10_000_000;
let activeTurn = false;
const server = createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
  );
  if (!hosts.has(req.headers.host ?? ""))
    return json(res, 403, { error: "Local host required" });
  if (
    !["GET", "HEAD"].includes(req.method ?? "") &&
    req.headers.origin !== "http://" + req.headers.host
  )
    return json(res, 403, { error: "Same-origin browser required" });
  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
  try {
    // A path such as "//" is not a valid address; failing here must not end the process.
    const path = new URL(req.url!, "http://localhost").pathname;
    if (req.method === "GET" && assets.has(path)) {
      const [file, type] = assets.get(path)!;
      res.writeHead(200, { "content-type": type });
      const content = await readFile(join(root, file));
      // Browser modules are TypeScript; Node removes the types, so there is no build step.
      res.end(
        file.endsWith(".ts")
          ? stripTypeScriptTypes(content.toString("utf8"))
          : content,
      );
      return;
    }
    if (req.method === "GET" && path === "/api/health") {
      db.prepare("SELECT 1").get();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/state")
      return json(
        res,
        200,
        JSON.parse(storedState() ?? '{"agents":[],"meetings":[]}'),
      );
    if (req.method === "PUT" && path === "/api/state") {
      // Meetings keep the files agents proposed, so the workspace can grow large.
      const data = (await parseJSON(req, 50_000_000)) as Partial<State> | null;
      if (!Array.isArray(data?.agents) || !Array.isArray(data?.meetings))
        return json(res, 400, { error: "Invalid state" });
      // Reject stale browser snapshots rather than silently losing another tab's edits.
      const stored = JSON.parse(storedState() ?? "{}") as Partial<State>;
      const version = stored._revision ?? 0;
      if ((data._revision ?? 0) !== version)
        return json(res, 409, {
          error:
            "This workspace changed in another tab. Reload before editing to preserve the latest agents and meetings.",
        });
      data._revision = version + 1;
      storeState(data);
      return json(res, 200, { ok: true, revision: data._revision });
    }
    if (req.method === "POST" && path === "/api/agents/starter-team") {
      const state = JSON.parse(
        storedState() ?? '{"agents":[],"meetings":[]}',
      ) as State;
      const added = addStarterAgents(state);
      state.initialized = true;
      state._revision = (state._revision ?? 0) + 1;
      storeState(state);
      return json(res, 200, { state, added });
    }
    if (req.method === "POST" && path === "/api/agents/product-team") {
      const data = (await parseJSON(req, 1000)) as { provider?: unknown } | null;
      const provider = String(data?.provider ?? "");
      const state = JSON.parse(
        storedState() ?? '{"agents":[],"meetings":[]}',
      ) as State;
      const result = addProductTeam(state, isProvider(provider) ? provider : undefined);
      state.initialized = true;
      state._revision = (state._revision ?? 0) + 1;
      storeState(state);
      return json(res, 200, { state, ...result });
    }
    if (req.method === "GET" && path === "/api/import/library")
      return json(res, 200, await listLibrary());
    if (req.method === "POST" && path === "/api/import/library") {
      const data = (await parseJSON(req, 10_000)) as { ids?: unknown };
      return json(res, 200, await readLibrary(data.ids));
    }
    if (req.method === "GET" && path === "/api/import/local")
      return json(res, 200, await listLocal());
    if (req.method === "POST" && path === "/api/import/local") {
      const data = (await parseJSON(req, 10_000)) as { ids?: unknown };
      return json(res, 200, await readLocal(data.ids));
    }
    if (req.method === "POST" && path === "/api/import/github") {
      const data = (await parseJSON(req, 2000)) as { url?: unknown };
      return json(res, 200, await listGitHub(data.url, signal));
    }
    if (req.method === "POST" && path === "/api/import/github/fetch") {
      const data = (await parseJSON(req, 40_000)) as {
        url?: unknown;
        paths?: unknown;
      };
      return json(res, 200, await readGitHub(data.url, data.paths, signal));
    }
    if (req.method === "GET" && path === "/api/workspace")
      return json(res, 200, await listWorkspace());
    if (req.method === "POST" && path === "/api/workspace/read") {
      const data = (await parseJSON(req, 20_000)) as { paths?: unknown } | null;
      return json(res, 200, await readWorkspace(data?.paths));
    }
    if (req.method === "POST" && path === "/api/workspace/save") {
      const data = await parseJSON(req, FILES_REQUEST_LIMIT);
      return json(res, 200, await saveToWorkspace(Object(data)));
    }
    // Saved files and drafts held in memory are shown under the same restrictions.
    const preview = /^\/(preview|draft)\/(.*)$/.exec(path);
    if (req.method === "GET" && preview) {
      // Set first, so a refusal is just as isolated as a page.
      for (const [name, value] of Object.entries(PREVIEW_HEADERS)) res.setHeader(name, value);
      const read = preview[1] === "draft" ? readDraft : readPreview;
      const { type, content } = await read(preview[2]);
      res.writeHead(200, { "content-type": type });
      res.end(content);
      return;
    }
    if (req.method === "POST" && path === "/api/draft") {
      const data = await parseJSON(req, FILES_REQUEST_LIMIT);
      return json(res, 200, addDraft(Object(data)));
    }
    if (req.method === "GET" && path === "/api/github")
      return json(res, 200, githubStatus());
    if (req.method === "POST" && path === "/api/github/commit") {
      const data = await parseJSON(req, FILES_REQUEST_LIMIT);
      // Not tied to the page: leaving halfway could strand a branch without its pull request.
      return json(res, 200, await commitToGitHub(Object(data), AbortSignal.timeout(60_000)));
    }
    if (req.method === "POST" && path === "/api/github/auto-commit") {
      const data = await parseJSON(req, FILES_REQUEST_LIMIT);
      // Not tied to the page, for the same reason as a push.
      return json(res, 200, await autoCommit(Object(data), AbortSignal.timeout(60_000)));
    }
    if (req.method === "POST" && path === "/api/github/tree") {
      const data = await parseJSON(req, 10_000);
      return json(res, 200, await listRepository(Object(data), signal));
    }
    if (req.method === "POST" && path === "/api/github/read") {
      const data = await parseJSON(req, 20_000);
      return json(res, 200, await readRepository(Object(data), signal));
    }
    if (req.method === "POST" && path === "/api/github/file") {
      const data = (await parseJSON(req, 2000)) as { url?: unknown } | null;
      return json(res, 200, await readGitHubFile(data?.url, signal));
    }
    if (req.method === "GET" && path === "/api/models")
      return json(res, 200, await modelSettings());
    if (req.method === "POST" && path === "/api/models/pull") {
      const data = (await parseJSON(req, 1000)) as { name?: unknown };
      return json(res, 202, installModel(data.name));
    }
    if (req.method === "GET" && path === "/api/config")
      return json(res, 200, {
        whisper: Boolean(process.env.WHISPER_MODEL || process.env.WHISPER_URL),
        kokoro: Boolean(process.env.KOKORO_URL),
        cli:
          process.env.QUORUM_ENABLE_CLI === "1" ||
          Boolean(process.env.QUORUM_CLI_BRIDGE_URL),
      });
    if (req.method === "GET" && path === "/api/claude")
      return json(res, 200, await claudeStatus());
    if (req.method === "POST" && (path === "/api/turn" || path === "/api/prompt")) {
      if (activeTurn)
        return json(res, 409, {
          error: "Another model turn is still running. Try again shortly.",
        });
      // Keys are replaced before anything is built from the request.
      const data = withoutKeys(await parseJSON(req, FILES_REQUEST_LIMIT)) as {
        agent?: unknown;
        meeting?: Partial<TurnMeeting>;
      };
      const agent = normalizeAgent(data.agent);
      if (
        !data.meeting?.goal ||
        !Array.isArray(data.meeting.transcript) ||
        !Array.isArray(data.meeting.participants)
      )
        return json(res, 400, { error: "Meeting goal and context required" });
      if (activeTurn)
        return json(res, 409, { error: "Another model turn is running" });
      activeTurn = true;
      try {
        const writing = path === "/api/prompt";
        // Writing whole files or a long prompt takes longer than a spoken turn.
        const turn = writing || canCreateFiles(agent)
          ? AbortSignal.any([abort.signal, AbortSignal.timeout(290_000)])
          : signal;
        const model = await chooseModel(agent, turn);
        // The goal, transcript and participants were checked above.
        const meeting = data.meeting as TurnMeeting;
        const answer = writing ? writeHandoff : freshTurn;
        const result = await answer({ ...agent, model }, meeting, turn);
        if (!abort.signal.aborted)
          return json(res, 200, { ...result, model });
      } finally {
        activeTurn = false;
      }
      return;
    }
    if (req.method === "POST" && path === "/api/transcribe") {
      if (!req.headers["content-type"]?.startsWith("audio/"))
        return json(res, 415, { error: "Expected audio" });
      const audio = await body(req, 20_000_000);
      if (!audio.length) return json(res, 400, { error: "No audio recorded" });
      const text = await transcribe(audio, signal, req.headers["content-type"]);
      return json(res, 200, { text });
    }
    if (req.method === "POST" && path === "/api/speech") {
      const data = (await parseJSON(req, 100_000)) as {
        text?: unknown;
        voice?: unknown;
      };
      const audio = await synthesize(
        redactKeys(String(data.text ?? "")).slice(0, 16000),
        String(data.voice ?? "").slice(0, 100),
        signal,
      );
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(audio);
      return;
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    const err = error as Error & {
      status?: number;
      conflicts?: string[];
      keyRejected?: boolean;
      directRefused?: boolean;
    };
    if (!res.destroyed && !res.headersSent)
      json(res, err.status ?? 400, {
        error: err.message || "Request failed",
        // Files a save would replace, so the page can ask first.
        ...(err.conflicts ? { conflicts: err.conflicts } : {}),
        // Tells the page to forget an access key GitHub would not take.
        ...(err.keyRejected ? { keyRejected: true } : {}),
        // Lets the page offer a pull request instead; it never switches by itself.
        ...(err.directRefused ? { directRefused: true } : {}),
      });
    else if (!res.destroyed) res.end();
  }
});
server.listen(port, host, () =>
  console.log("Quorum is listening at http://127.0.0.1:" + port),
);
