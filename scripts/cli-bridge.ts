import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canCreateFiles, normalizeAgent } from "../src/engine.ts";
import type { Prompt } from "../src/engine.ts";
import { respond } from "../src/providers.ts";
import { checkCLI } from "../src/models.ts";

// Host-only service: fixed CLI adapters, no shell endpoint or arbitrary executable.
process.env.QUORUM_ENABLE_CLI = "1";
process.env.QUORUM_CLI_BRIDGE_URL = "";
const token = (await readFile(".quorum/bridge/token", "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error("Run npm run bridge:setup first");
const expected = Buffer.from("Bearer " + token);
const port = Number(process.env.QUORUM_BRIDGE_PORT ?? 4712);
let busy = false;
const server = createServer(async (req, res) => {
  const json = (status: number, data: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const supplied = Buffer.from(req.headers.authorization ?? "");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return json(401, { error: "Bridge authentication required" });
  if (req.method === "GET" && req.url === "/status") {
    const [claude, codex] = await Promise.all([
      checkCLI("claude"),
      checkCLI("codex"),
    ]);
    return json(200, { claude, codex });
  }
  if (req.method !== "POST" || req.url !== "/respond")
    return json(404, { error: "Not found" });
  if (busy) return json(409, { error: "A host CLI turn is already running" });
  if (!req.headers["content-type"]?.startsWith("application/json"))
    return json(415, { error: "Expected JSON" });
  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const parts: Buffer[] = [];
    let length = 0;
    // No encoding is set on the request, so it yields bytes.
    for await (const part of req as AsyncIterable<Buffer>) {
      length += part.length;
      if (length > 2_000_000) throw new Error("Request too large");
      parts.push(part);
    }
    const data = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
      agent?: unknown;
      prompt?: Partial<Prompt>;
    };
    const agent = normalizeAgent(data.agent);
    if (!["claude", "codex"].includes(agent.provider))
      throw new Error(
        "Only Claude Code and Codex are supported by the host bridge",
      );
    if (
      typeof data.prompt?.system !== "string" ||
      typeof data.prompt?.user !== "string"
    )
      throw new Error("Prompt required");
    if (busy) return json(409, { error: "A host CLI turn is already running" });
    busy = true;
    try {
      // Writing whole files takes longer than a spoken turn.
      const limit = canCreateFiles(agent) ? 290_000 : 180_000;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(limit)]);
      const text = await respond(agent, data.prompt as Prompt, signal);
      if (!res.destroyed) json(200, { text });
    } finally {
      busy = false;
    }
  } catch (error) {
    if (!res.destroyed) json(400, { error: (error as Error).message });
  }
});
server.requestTimeout = 30_000;
server.listen(port, "127.0.0.1", () =>
  console.log(
    "Quorum CLI bridge listening on 127.0.0.1:" +
      port +
      " (authenticated; host CLI inference may use cloud services)",
  ),
);
