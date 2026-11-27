import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

test("host bridge requires a token and restricts calls to its fixed CLI adapters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "quorum-bridge-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise((resolve) => socket.close(resolve));
  await mkdir(join(root, ".quorum/bridge"), { recursive: true });
  const token = "a".repeat(64);
  await writeFile(join(root, ".quorum/bridge/token"), token);
  await mkdir(join(root, "bin"));
  // Test doubles avoid using real CLI accounts or issuing cloud requests in CI.
  for (const command of ["claude", "codex"])
    await writeFile(
      join(root, "bin", command),
      `#!/bin/sh
case "$*" in
  --version) echo 'test-cli 1.0' ;;
  'auth status') echo '{"loggedIn":true}' ;;
  'login status') echo 'Logged in using ChatGPT' >&2 ;;
  *) cat >/dev/null; echo 'Hello from the test CLI' ;;
esac
`,
      { mode: 0o755 },
    );
  const child = spawn(process.execPath, [resolve("scripts/cli-bridge.ts")], {
    cwd: root,
    env: {
      ...process.env,
      QUORUM_BRIDGE_PORT: String(port),
      PATH: join(root, "bin") + ":" + process.env.PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw new Error("Bridge exited");
    }),
  ]);
  const base = "http://127.0.0.1:" + port;
  assert.equal((await fetch(base + "/status")).status, 401);
  assert.equal(
    (
      await fetch(base + "/status", {
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
  };
  const status = (await (await fetch(base + "/status", { headers })).json()) as Record<
    "claude" | "codex",
    { authenticated: boolean }
  >;
  assert.equal(status.claude.authenticated, true);
  assert.equal(status.codex.authenticated, true);
  const payload = {
    agent: { name: "Test", provider: "claude", model: "", skills: [] },
    prompt: { system: "Say hello", user: "hello" },
  };
  const response = await fetch(base + "/respond", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.match(((await response.json()) as { text: string }).text, /test CLI/);
  payload.agent.provider = "demo";
  assert.equal(
    (
      await fetch(base + "/respond", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + "/exec", { method: "POST", headers, body: "{}" }))
      .status,
    404,
  );
});
