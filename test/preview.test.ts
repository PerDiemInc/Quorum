import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { addDraft, MAX_DRAFT_BYTES, MAX_DRAFTS, readDraft } from "../src/drafts.ts";
import { compatibleFiles, MAX_FILE_BYTES, previewFiles } from "../src/engine.ts";
import { renderPreview } from "../src/workspace.ts";
import { startServer } from "./helpers/server.ts";

const POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";
const file = (path: string, content: string) => ({ path, content });
const gone = (error: Error & { status?: number }) => error.status === 404;

test("a draft is shown with its own stylesheets and nothing from outside", async () => {
  const page = [
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="../shared.css?v=1">',
    '<link rel="stylesheet" href="../../x.css">',
    '<link rel="preconnect" href="https://evil.test">',
    '<link data-a="<" rel="preconnect" href="https://evil.test">',
    '<LINK/rel=dns-prefetch href=//evil.test>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<meta HTTP-EQUIV = refresh content="0;url=https://evil.test">',
    "<p>Hi</p>",
  ].join("\n");
  const { id } = addDraft({
    files: [file("site/index.html", page), file("site/styles.css", "p{color:red}"), file("shared.css", "body{margin:0}")],
  });
  const shown = await readDraft(id + "/site/index.html");
  assert.equal(shown.type, "text/html; charset=utf-8");
  assert.match(shown.content, /<style>\np\{color:red\}\n<\/style>/);
  assert.match(shown.content, /<style>\nbody\{margin:0\}\n<\/style>/);
  assert.doesNotMatch(shown.content, /<link[\s/>]/i);
  assert.doesNotMatch(shown.content, /[\s"]http-equiv\s*=/i);
});

test("an SVG cannot hint at a connection either", async () => {
  const svg = '<!DOCTYPE svg [<!ENTITY a "&#60;html:link/>">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:link rel="preconnect" href="https://evil.test"/></svg>';
  const shown = await renderPreview("a.svg", svg, () => "");
  assert.equal(shown.type, "image/svg+xml; charset=utf-8");
  assert.doesNotMatch(shown.content, /<h:link|<!ENTITY/);
});

test("drafts have unguessable ids and are checked like files being saved", async () => {
  const files = [file("index.html", "<p>one</p>")];
  const { id } = addDraft({ files });
  assert.match(id, /^[A-Za-z0-9_-]{32}$/);
  // The same files are held once.
  assert.equal(addDraft({ files }).id, id);
  assert.notEqual(addDraft({ files: [file("index.html", "<p>two</p>")] }).id, id);
  for (const path of ["../x.html", "/x.html", ".env.html", "a/.git/x.html", "x.exe", "node_modules/x.html", "a\\b.html"])
    assert.throws(() => addDraft({ files: [file(path, "")] }), /not allowed/, path);
  assert.throws(() => addDraft({ files: [file("a.html", "x".repeat(MAX_FILE_BYTES + 1))] }), /larger than/);
  assert.throws(() => addDraft({ files: Array.from({ length: 21 }, (_, i) => file(i + ".html", "")) }), /between 1 and 20/);
  assert.throws(() => addDraft({}), /between 1 and 20/);
  addDraft({ files: [file("a.html", "a"), file("a.css", "b"), file("notes.md", "n")] });
  for (const address of [
    id, id + "/", id + "/missing.html", "nope/index.html", id + "/..%2Findex.html", id + "/%2e%2e/index.html",
    id + "/a%2Fb.html", id + "/%E0%A4%A.html", "", "../index.html",
  ])
    await assert.rejects(readDraft(address), gone, address);
  const other = addDraft({ files: [file("a.css", "b"), file("b.html", "x")] }).id;
  await assert.rejects(readDraft(other + "/a.css"), gone);
});

test("old drafts are dropped to stay within the count and size limits", async () => {
  const first = addDraft({ files: [file("first.html", "first")] }).id;
  const kept = addDraft({ files: [file("kept.html", "kept")] }).id;
  for (let i = 0; i < MAX_DRAFTS - 1; i++) {
    addDraft({ files: [file("n.html", "n" + i)] });
    // Reading a draft counts as using it.
    await readDraft(kept + "/kept.html");
  }
  await assert.rejects(readDraft(first + "/first.html"), gone);
  await readDraft(kept + "/kept.html");
  const big = (n: number) =>
    addDraft({
      files: Array.from({ length: 20 }, (_, i) => file(i + ".html", String(n).padEnd(MAX_FILE_BYTES, "x"))),
    }).id;
  const ids = Array.from({ length: Math.floor(MAX_DRAFT_BYTES / (20 * MAX_FILE_BYTES)) + 1 }, (_, i) => big(i));
  await assert.rejects(readDraft(ids[0] + "/0.html"), gone);
  await readDraft(ids.at(-1)! + "/0.html");
});

test("a preview takes the page and stylesheets that can sit together", () => {
  const files = [file("a.css", "1"), file("page.html", "2"), file("other.html", "3"), file("A.CSS", "4")];
  assert.deepEqual(previewFiles(files, files[1]).map((f) => f.path), ["A.CSS", "page.html"]);
  const many = Array.from({ length: 30 }, (_, i) => file(i + ".css", ""));
  const chosen = previewFiles([...many, file("p.html", "")], file("p.html", ""));
  assert.equal(chosen.length, 20);
  assert.equal(chosen.at(-1)!.path, "p.html");
  assert.deepEqual(
    compatibleFiles([file("a.md", "old"), file("A.md", "new"), file("a.md/b.js", "newest")]).map((f) => f.path),
    ["a.md/b.js"],
  );
});

test("the server serves drafts sandboxed, framed only by the app, and writes nothing", async (t) => {
  const server = await startServer(t);
  const files = [file("site/index.html", "<p>Hello</p>")];
  for (const origin of ["http://evil.test", "null"])
    assert.equal((await server.send("/api/draft", { files }, { origin })).status, 403);
  assert.equal((await server.send("/api/draft", { files: [file("../x.html", "")] })).status, 400);
  const made = await server.send("/api/draft", { files });
  assert.equal(made.status, 200);
  const { id } = (await made.json()) as { id: string };
  const shown = await fetch(server.url + "/draft/" + id + "/site/index.html");
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-security-policy"), POLICY);
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shown.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(shown.headers.get("x-dns-prefetch-control"), "off");
  assert.equal(await shown.text(), "<p>Hello</p>");
  const missing = await fetch(server.url + "/draft/guess/site/index.html");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-security-policy"), POLICY);
  // The app itself still cannot be framed.
  assert.match((await fetch(server.url + "/")).headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  const foreign = await new Promise((resolve, reject) =>
    request({ host: "127.0.0.1", port: server.port, path: "/draft/" + id + "/site/index.html", headers: { host: "evil.test" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end(),
  );
  assert.equal(foreign, 403);
  await assert.rejects(readdir(server.workspace), /ENOENT/);
});
