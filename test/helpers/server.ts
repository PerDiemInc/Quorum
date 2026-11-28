import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No real credential, workspace or model may reach a server a test starts.
const PRIVATE = [
  "QUORUM_GITHUB_TOKEN", "QUORUM_GITHUB_CLI", "QUORUM_GITHUB_WRITE", "QUORUM_GITHUB_REPOS",
  "GITHUB_TOKEN", "GH_TOKEN", "QUORUM_HOST", "QUORUM_PUBLIC_PORT", "QUORUM_CLI_BRIDGE_URL",
  "QUORUM_ENABLE_CLI", "KOKORO_URL", "WHISPER_URL",
];

async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address() as AddressInfo;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** A Quorum server on its own port, data folder and workspace, stopped after the test. */
export async function startServer(
  t: test.TestContext,
  env: NodeJS.ProcessEnv = {},
  { data, args = [] }: { data?: string; args?: string[] } = {},
) {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "quorum-test-"));
  const dataDir = data ?? join(directory, "data");
  const workspace = join(directory, "workspace");
  const base = { ...process.env };
  for (const name of PRIVATE) delete base[name];
  const child = spawn(process.execPath, [...args, "src/server.ts"], {
    env: { ...base, PORT: String(port), QUORUM_DATA: dataDir, QUORUM_WORKSPACE: workspace, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw new Error("Server exited: " + output);
    }),
  ]);
  const url = "http://127.0.0.1:" + port;
  const send = (path: string, body: unknown, { method = "POST", origin = url } = {}) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  return { url, port, send, directory, dataDir, workspace, output: () => output };
}

/** A stand-in for Ollama that records every request and answers with `reply`. */
export async function fakeModel(t: test.TestContext, reply: () => string | Promise<string>) {
  const requests: string[] = [];
  const server = createHttp(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    if (req.url === "/api/chat") requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(
      req.url === "/api/chat" ? { message: { content: await reply() } } : { models: [{ name: "fake", size: 1 }] },
    ));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: "http://127.0.0.1:" + (server.address() as AddressInfo).port, requests };
}
