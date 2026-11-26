import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { get } from "node:http";

test("container binding retains host/origin protection and persists SQLite across restart", async (t) => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "quorum-test-"));
  let child;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  };
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        QUORUM_PUBLIC_PORT: "4789",
        QUORUM_HOST: "0.0.0.0",
        QUORUM_DATA: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Server exited");
      }),
    ]);
  };
  await start();
  const base = "http://127.0.0.1:" + port;
  assert.equal((await fetch(base + "/api/health")).status, 200);
  // node:http can set Host explicitly; fetch normalizes it back to the URL host.
  const hostStatus = (host) =>
    new Promise((resolve, reject) =>
      get(base + "/api/health", { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject),
    );
  assert.equal(await hostStatus("evil.test"), 403);
  assert.equal(await hostStatus("localhost:4789"), 200);
  assert.equal(
    (
      await fetch(base + "/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  const state = { agents: [], meetings: [], initialized: true };
  assert.equal(
    (
      await fetch(base + "/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(state),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(state),
      })
    ).status,
    409,
  );
  await stop();
  await start();
  assert.deepEqual(await (await fetch(base + "/api/state")).json(), {
    ...state,
    _revision: 1,
  });
});
