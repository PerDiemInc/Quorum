import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { get } from "node:http";

test("container binding retains host/origin protection and persists SQLite across restart", async (t) => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise((resolve) => socket.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "quorum-test-"));
  let child: ChildProcess | undefined;
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
    child = spawn(process.execPath, ["src/server.ts"], {
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
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw new Error("Server exited");
      }),
    ]);
  };
  await start();
  const base = "http://127.0.0.1:" + port;
  // The browser asks for JavaScript and receives the TypeScript with its types removed.
  for (const name of ["app", "engine", "files", "import", "mentions", "preview", "next", "key", "repository"]) {
    const asset = await fetch(base + "/" + name + ".js");
    assert.equal(asset.status, 200, name);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    const code = await asset.text();
    assert.doesNotMatch(code, /^(export )?(interface|type) \w+/m, name);
    // Parses as a module: only the import and export statements differ from a script.
    new Function(code.replace(/^import[\s\S]*?;$/gm, "").replace(/^export /gm, "").replace(/\bawait\b/g, ""));
  }
  assert.equal((await fetch(base + "/api/health")).status, 200);
  // node:http can set Host explicitly; fetch normalizes it back to the URL host.
  const hostStatus = (host: string) =>
    new Promise((resolve, reject) =>
      get(base + "/api/health", { headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject),
    );
  // An unparsable path is refused and the server stays up.
  const rawStatus = (path: string) =>
    new Promise<number | undefined>((resolve, reject) =>
      get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject),
    );
  assert.equal(await rawStatus("//"), 400);
  assert.equal((await fetch(base + "/api/health")).status, 200);
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
  const state = {
    agents: [],
    meetings: [{
      id: "archive-example",
      goal: "Review the launch",
      description: "The pilot starts next week.",
      agenda: "Scope\nSuccess criteria",
      participants: [{ id: "archived-agent", name: "Product Manager", provider: "demo", model: "" }],
      transcript: [],
      status: "paused",
    }],
    initialized: true,
  };
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
