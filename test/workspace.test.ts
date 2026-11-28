import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import {
  checkFiles,
  listWorkspace,
  readPreview,
  readWorkspace,
  saveToWorkspace,
  workspaceRoot,
  PREVIEW_HEADERS,
} from "../src/workspace.ts";

const POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

/** A workspace in a temporary folder, with a folder outside it that must stay untouched. */
async function sandbox(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "quorum-workspace-test-"));
  const root = join(base, "workspace"),
    outside = join(base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "private");
  await writeFile(join(outside, "secret.css"), "private{}");
  const before = process.env.QUORUM_WORKSPACE;
  process.env.QUORUM_WORKSPACE = root;
  t.after(async () => {
    if (before === undefined) delete process.env.QUORUM_WORKSPACE;
    else process.env.QUORUM_WORKSPACE = before;
    await rm(base, { recursive: true, force: true });
  });
  return { root, outside };
}
const file = (path: string, content = "x") => ({ path, content });

test("the workspace defaults to a folder in the home directory", () => {
  const { HOME, QUORUM_WORKSPACE } = process.env;
  delete process.env.QUORUM_WORKSPACE;
  process.env.HOME = "/nowhere/home";
  try {
    // Only the name is computed; nothing is read or created.
    assert.equal(workspaceRoot(), "/nowhere/home/quorum-workspace");
  } finally {
    process.env.HOME = HOME;
    if (QUORUM_WORKSPACE !== undefined) process.env.QUORUM_WORKSPACE = QUORUM_WORKSPACE;
  }
});

test("files are saved into one folder and read back", async (t) => {
  const { root } = await sandbox(t);
  assert.deepEqual((await listWorkspace()).files, []);
  const saved = await saveToWorkspace({
    folder: "menu",
    files: [file("index.html", "<p>é</p>"), file("css/a.css", "p{}")],
  });
  assert.equal(saved.folder, join(root, "menu"));
  assert.deepEqual(saved.files, [
    { path: "menu/index.html", size: 9, preview: true },
    { path: "menu/css/a.css", size: 3, preview: false },
  ]);
  assert.equal(await readFile(join(root, "menu/index.html"), "utf8"), "<p>é</p>");
  assert.deepEqual((await readWorkspace(["menu/css/a.css"])).files, [file("menu/css/a.css", "p{}")]);
  assert.deepEqual((await listWorkspace()).files.map((f) => f.path), ["menu/css/a.css", "menu/index.html"]);
  // The deepest allowed file stays usable inside its folder.
  await saveToWorkspace({ folder: "deep", files: [file("a/b/c/d/e/f/g/h.txt")] });
  assert.equal((await readWorkspace(["deep/a/b/c/d/e/f/g/h.txt"])).files.length, 1);
});

test("unsafe folders and paths are refused before anything is written", async (t) => {
  const { root, outside } = await sandbox(t);
  for (const folder of ["", "..", ".", "a/b", "/tmp", ".git", "a\\b", "node_modules", 7, undefined])
    await assert.rejects(saveToWorkspace({ folder, files: [file("a.txt")] }), /folder name/, String(folder));
  for (const path of ["../a.txt", "/tmp/a.txt", ".env", ".github/workflows/x.yml", "a/../../b.txt", "x.exe"])
    await assert.rejects(saveToWorkspace({ folder: "ok", files: [file("good.txt"), file(path)] }), /not allowed/, path);
  await assert.rejects(readdir(root), /ENOENT/);
  for (const path of ["../outside/secret.txt", "/etc/hosts", join(outside, "secret.txt"), ".env", "a/.b.txt"])
    await assert.rejects(readWorkspace([path]), /not allowed/, path);
});

test("file counts, sizes and clashing names are limited", async () => {
  assert.throws(() => checkFiles([]), /between 1 and 20/);
  assert.throws(() => checkFiles(Array.from({ length: 21 }, (_, i) => file(i + ".txt"))), /between 1 and 20/);
  assert.equal(checkFiles([file("a.txt", "x".repeat(200_000))]).length, 1);
  assert.throws(() => checkFiles([file("a.txt", "x".repeat(200_001))]), /larger than 200 KB/);
  // The limit counts bytes, not characters.
  assert.throws(() => checkFiles([file("a.txt", "é".repeat(100_001))]), /larger than 200 KB/);
  for (const pair of [["a.txt", "a.txt"], ["a.txt", "A.TXT"], ["a.js", "a.js/b.js"], ["a.js/b.js", "A.js"]])
    assert.throws(() => checkFiles(pair.map((p) => file(p))), /same place/, pair.join(" "));
  assert.throws(() => checkFiles([{ path: "a.txt" }]), /no text content/);
  assert.throws(() => checkFiles([null]), /not allowed/);
});

test("symbolic links are never followed", async (t) => {
  const { root, outside } = await sandbox(t);
  await mkdir(join(root, "meeting"), { recursive: true });
  await symlink(outside, join(root, "folder-link"));
  await symlink(outside, join(root, "meeting/sub"));
  await symlink(join(outside, "secret.txt"), join(root, "meeting/file.txt"));
  await symlink(join(outside, "new.txt"), join(root, "meeting/dangling.txt"));
  for (const overwrite of [false, true]) {
    for (const [folder, path] of [
      ["folder-link", "a.txt"],
      ["meeting", "sub/a.txt"],
      ["meeting", "file.txt"],
      ["meeting", "dangling.txt"],
    ])
      await assert.rejects(
        saveToWorkspace({ folder, files: [file("first.txt"), file(path)], overwrite }),
        /symbolic link/,
        folder + "/" + path,
      );
  }
  // Nothing was written, inside or outside.
  assert.deepEqual((await readdir(outside)).sort(), ["secret.css", "secret.txt"]);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
  assert.ok(!(await readdir(join(root, "meeting"))).includes("first.txt"));
  for (const path of ["folder-link/secret.txt", "meeting/file.txt", "meeting/sub/secret.txt"])
    await assert.rejects(readWorkspace([path]), /symbolic link/, path);
  assert.deepEqual((await listWorkspace()).files, []);
  await symlink(join(outside, "secret.txt"), join(root, "page.html"));
  await assert.rejects(readPreview("page.html"), /symbolic link/);
});

test("a workspace the host linked elsewhere still works", async (t) => {
  const { root, outside } = await sandbox(t);
  await symlink(outside, root);
  await saveToWorkspace({ folder: "m", files: [file("a.txt", "ok")] });
  assert.equal(await readFile(join(outside, "m/a.txt"), "utf8"), "ok");
});

test("existing files are replaced only on request, and links are not written through", async (t) => {
  const { root, outside } = await sandbox(t);
  await saveToWorkspace({ folder: "m", files: [file("a.txt", "one")] });
  await assert.rejects(
    saveToWorkspace({ folder: "m", files: [file("b.txt", "b"), file("a.txt", "two")] }),
    (error: Error & { status?: number; conflicts?: string[] }) => {
      assert.equal(error.status, 409);
      assert.deepEqual(error.conflicts, ["a.txt"]);
      return true;
    },
  );
  // Only the exact value true overwrites.
  await assert.rejects(saveToWorkspace({ folder: "m", files: [file("a.txt")], overwrite: "yes" }), /already exist/);
  assert.deepEqual(await readdir(join(root, "m")), ["a.txt"]);
  await saveToWorkspace({ folder: "m", files: [file("a.txt", "two")], overwrite: true });
  assert.equal(await readFile(join(root, "m/a.txt"), "utf8"), "two");
  // A hard link to a file outside is replaced, leaving the other file alone.
  await link(join(outside, "secret.txt"), join(root, "m/hard.txt"));
  await saveToWorkspace({ folder: "m", files: [file("hard.txt", "new")], overwrite: true });
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
  assert.deepEqual((await readdir(join(root, "m"))).sort(), ["a.txt", "hard.txt"]);
  // A folder is never replaced by a file, nor a file by a folder.
  await mkdir(join(root, "m/dir.js"));
  await assert.rejects(saveToWorkspace({ folder: "m", files: [file("dir.js")], overwrite: true }), /already a folder/);
  await assert.rejects(saveToWorkspace({ folder: "m", files: [file("a.txt/b.txt")], overwrite: true }), /not a folder/);
});

test("the list skips hidden files, node_modules, other types and large files", async (t) => {
  const { root } = await sandbox(t);
  for (const dir of [".hidden", "node_modules/x", "app"]) await mkdir(join(root, dir), { recursive: true });
  for (const path of [".env", ".hidden/a.txt", "node_modules/x/a.js", "app/ok.ts", "app/photo.png", "key.pem"])
    await writeFile(join(root, path), "x");
  await writeFile(join(root, "app/big.txt"), "x".repeat(200_001));
  await writeFile(join(root, "app/binary.txt"), Buffer.from([0, 255, 254]));
  const listed = await listWorkspace();
  assert.deepEqual(listed.files.map((f) => f.path), ["app/binary.txt", "app/ok.ts"]);
  assert.equal(listed.truncated, false);
  await assert.rejects(readWorkspace(["app/binary.txt"]), /not a text file/);
  await assert.rejects(readWorkspace(["app/big.txt"]), /larger than/);
  await assert.rejects(readWorkspace(["app/missing.txt"]), /no file/);
  await mkdir(join(root, "many"));
  await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(join(root, "many", i + ".txt"), "x")));
  const long = await listWorkspace();
  assert.equal(long.files.length, 500);
  assert.equal(long.truncated, true);
});

test("a preview carries its own stylesheets and nothing from outside", async (t) => {
  const { root, outside } = await sandbox(t);
  const page = [
    '<link rel="stylesheet" href="css/main.css?v=2" media="screen">',
    "<link href='../shared.css' rel='stylesheet'>",
    '<link rel="stylesheet" href="../../outside/secret.css">',
    '<link rel="stylesheet" href="%2e%2e/%2e%2e/outside/secret.css">',
    '<link rel="stylesheet" href="escape.css">',
    '<link rel="stylesheet" href="/css/main.css">',
    '<link rel="stylesheet" href="https://example.com/a.css">',
    '<link rel="icon" href="css/main.css">',
  ].join("\n");
  await saveToWorkspace({
    folder: "My Menu",
    files: [
      file("index.html", page),
      file("css/main.css", 'a::after { content: "$& </style><script>bad()</script>" }'),
      file("logo.svg", "<svg/>"),
      file("notes.md", "n"),
    ],
  });
  await writeFile(join(root, "shared.css"), "body{margin:0}");
  await symlink(join(outside, "secret.css"), join(root, "My Menu/escape.css"));
  const shown = await readPreview("My%20Menu/index.html");
  assert.equal(shown.type, "text/html; charset=utf-8");
  assert.match(shown.content, /<style media="screen">\na::after \{ content: "\$& <\\\/style>/);
  assert.match(shown.content, /<style>\nbody\{margin:0\}\n<\/style>/);
  assert.doesNotMatch(shown.content, /private/);
  // Every other link element is removed.
  assert.doesNotMatch(shown.content, /<link/);
  assert.equal(PREVIEW_HEADERS["x-dns-prefetch-control"], "off");
  assert.equal((await readPreview("My%20Menu/logo.svg")).type, "image/svg+xml; charset=utf-8");
  for (const address of [
    "My%20Menu/notes.md", "My%20Menu/css/main.css", "My%20Menu%2Findex.html", "..%2Foutside%2Fa.html",
    "%2e%2e/a.html", ".hidden.html", "%E0%A4%A.html", "", "missing.html",
  ])
    await assert.rejects(readPreview(address), (e: Error & { status?: number }) => e.status === 404, address);
  assert.equal(PREVIEW_HEADERS["content-security-policy"], POLICY);
});

test("the server isolates previews and guards the new endpoints", async (t) => {
  const { root } = await sandbox(t);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise((resolve) => socket.close(resolve));
  const data = await mkdtemp(join(tmpdir(), "quorum-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), QUORUM_DATA: data, QUORUM_WORKSPACE: root };
  // No real credential may reach this server.
  for (const name of ["QUORUM_GITHUB_TOKEN", "QUORUM_GITHUB_CLI", "QUORUM_GITHUB_WRITE", "QUORUM_GITHUB_REPOS", "QUORUM_HOST", "QUORUM_PUBLIC_PORT"])
    delete env[name];
  const child = spawn(process.execPath, ["src/server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    await rm(data, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout!, "data"),
    once(child, "exit").then(() => {
      throw new Error("Server exited");
    }),
  ]);
  const base = "http://127.0.0.1:" + port;
  const post = (path: string, body: unknown, origin = base) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  const files = [file("index.html", "<p>Hello</p>")];
  for (const path of ["/api/workspace/save", "/api/workspace/read", "/api/github/commit", "/api/github/file"]) {
    assert.equal((await post(path, {}, "http://evil.test")).status, 403, path);
    // A sandboxed preview has the origin "null".
    assert.equal((await post(path, {}, "null")).status, 403, path);
  }
  assert.equal((await post("/api/workspace/save", { folder: "m", files })).status, 200);
  const again = await post("/api/workspace/save", { folder: "m", files });
  assert.equal(again.status, 409);
  assert.deepEqual(((await again.json()) as { conflicts: string[] }).conflicts, ["index.html"]);
  assert.equal((await post("/api/workspace/save", { folder: "..", files })).status, 400);
  assert.equal((await post("/api/workspace/save", null)).status, 400);
  const listed = (await (await fetch(base + "/api/workspace")).json()) as { files: Array<{ path: string }> };
  assert.deepEqual(listed.files.map((f) => f.path), ["m/index.html"]);
  const preview = await fetch(base + "/preview/m/index.html");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-security-policy"), POLICY);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(preview.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await preview.text(), "<p>Hello</p>");
  const refused = await fetch(base + "/preview/m/missing.html");
  assert.equal(refused.status, 404);
  assert.equal(refused.headers.get("content-security-policy"), POLICY);
  // The host check covers previews and workspace reads. A raw request keeps the Host header.
  for (const path of ["/preview/m/index.html", "/api/workspace", "/api/github"]) {
    const status = await new Promise((resolve, reject) =>
      request({ host: "127.0.0.1", port, path, headers: { host: "evil.test" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject).end(),
    );
    assert.equal(status, 403, path);
  }
  // Writing to GitHub is off by default.
  assert.deepEqual(await (await fetch(base + "/api/github")).json(), {
    available: false,
    source: null,
    repos: null,
  });
  const off = await post("/api/github/commit", { repo: "a/b", message: "m", files });
  assert.equal(off.status, 403);
  assert.match(((await off.json()) as { error: string }).error, /off/);
});
