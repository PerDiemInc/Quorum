import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { MAX_FILE_BYTES, MAX_FILES, safeFilePath, safeSegment } from "./engine.ts";
import type { ProjectFile } from "./engine.ts";

/**
 * The one folder on this computer that Quorum reads and writes for meetings. Agents never
 * touch it: the host chooses what is attached and what is saved. Every path is checked
 * here, symbolic links below the folder are refused, and nothing outside it is reached.
 */
const MAX_LISTED = 500;
const MAX_VISITED = 5000;
const MAX_DEPTH = 9;
const MAX_STYLESHEETS = 20;

const fail = (message: string, status = 400, conflicts?: string[]) =>
  Object.assign(new Error(message), { status, ...(conflicts ? { conflicts } : {}) });
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

export const workspaceRoot = () =>
  resolve(process.env.QUORUM_WORKSPACE || join(homedir(), "quorum-workspace"));

/** The root with its own links resolved (the host chose it), or null before it exists. */
async function existingRoot() {
  try {
    return await realpath(workspaceRoot());
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw fail("The workspace folder cannot be opened: " + workspaceRoot());
  }
}

/** A safe file path, optionally inside one folder, which is how saved files are laid out. */
export function workspacePath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const [folder, ...rest] = path.split("/");
  return safeFilePath(path) || (safeSegment(folder) && safeFilePath(rest.join("/"))) ? path : null;
}

/** Files as a request sent them, all checked before any of them is used. */
export function checkFiles(value: unknown): ProjectFile[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES)
    throw fail("Choose between 1 and " + MAX_FILES + " files.");
  const seen: string[] = [];
  return (value as unknown[]).map((item) => {
    const { path, content } = (item ?? {}) as { path?: unknown; content?: unknown };
    const safe = safeFilePath(path);
    if (!safe) throw fail("This file path is not allowed: " + String(path).slice(0, 200));
    if (typeof content !== "string") throw fail(safe + " has no text content.");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw fail(safe + " is larger than " + MAX_FILE_BYTES / 1000 + " KB.", 413);
    // Some disks ignore letter case, and one name cannot be both a file and a folder.
    const key = safe.toLowerCase();
    if (seen.some((other) => (other + "/").startsWith(key + "/") || (key + "/").startsWith(other + "/")))
      throw fail("Two files would land in the same place: " + safe);
    seen.push(key);
    return { path: safe, content };
  });
}

/**
 * Look along a path below the root without following anything.
 * @returns the entry at the end, or null when it does not exist yet
 */
async function inspect(root: string, path: string): Promise<Stats | null> {
  const parts = path.split("/");
  let at = root;
  for (let i = 0; ; i++) {
    at = join(at, parts[i]);
    let entry: Stats;
    try {
      entry = await lstat(at);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw fail("That path cannot be opened: " + path);
    }
    const shown = parts.slice(0, i + 1).join("/");
    if (entry.isSymbolicLink())
      throw fail(shown + " is a symbolic link, which Quorum does not follow.");
    if (i === parts.length - 1) return entry;
    if (!entry.isDirectory()) throw fail(shown + " is a file, not a folder.", 409);
  }
}

/** Refuse anything that, after all links are resolved, is no longer under the root. */
async function inside(root: string, path: string) {
  const from = relative(root, await realpath(path));
  if (from === ".." || from.startsWith(".." + sep) || resolve(root, from) === root)
    throw fail("That path leads outside the workspace folder.");
}

/** Read one text file below the root. The path must already be checked. */
async function readText(root: string, path: string) {
  const entry = await inspect(root, path);
  if (!entry?.isFile()) throw fail("There is no file at " + path + ".", 404);
  const full = join(root, path);
  await inside(root, full);
  // O_NOFOLLOW also refuses a link put there since the check.
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw fail("There is no file at " + path + ".", 404);
    if (stats.size > MAX_FILE_BYTES)
      throw fail(path + " is larger than " + MAX_FILE_BYTES / 1000 + " KB.", 413);
    return decodeText(await handle.readFile(), path);
  } finally {
    await handle.close();
  }
}

/** UTF-8 text, refusing binary content. */
export function decodeText(bytes: Uint8Array, name: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return text;
  } catch {
    /* Not UTF-8: reported below. */
  }
  throw fail(name + " is not a text file.", 415);
}

/** Text files in the workspace, without hidden entries, node_modules or links. */
export async function listWorkspace() {
  const root = await existingRoot();
  const files: Array<{ path: string; size: number }> = [];
  let visited = 0,
    truncated = false;
  async function walk(directory: string, depth: number) {
    let entries;
    try {
      entries = await readdir(join(root!, directory), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (files.length >= MAX_LISTED || visited++ >= MAX_VISITED) {
        truncated = true;
        return;
      }
      const path = directory ? directory + "/" + entry.name : entry.name;
      // A link reports itself as neither a folder nor a file, so it is never followed.
      if (entry.isDirectory() && depth < MAX_DEPTH) await walk(path, depth + 1);
      else if (entry.isFile() && workspacePath(path)) {
        const size = await lstat(join(root!, path)).then((s) => s.size, () => Infinity);
        if (size <= MAX_FILE_BYTES) files.push({ path, size });
      }
    }
  }
  if (root) await walk("", 1);
  return { root: workspaceRoot(), files, truncated };
}

/** The contents of files the host picked from the list. */
export async function readWorkspace(paths: unknown) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES)
    throw fail("Choose between 1 and " + MAX_FILES + " files.");
  const checked = (paths as unknown[]).map((path) => {
    const safe = workspacePath(path);
    if (!safe) throw fail("This file path is not allowed: " + String(path).slice(0, 200));
    return safe;
  });
  const root = await existingRoot();
  if (!root) throw fail("The workspace folder is empty.", 404);
  const files: ProjectFile[] = [];
  for (const path of checked) files.push({ path, content: await readText(root, path) });
  return { files };
}

/**
 * Write files into one folder of the workspace. Everything is checked before the first
 * write, and an existing file is replaced only when the request says so.
 */
export async function saveToWorkspace(request: {
  folder?: unknown;
  files?: unknown;
  overwrite?: unknown;
}) {
  const folder = typeof request.folder === "string" ? request.folder.trim() : "";
  if (!safeSegment(folder))
    throw fail("Choose a folder name without slashes that does not start with a dot.");
  const files = checkFiles(request.files);
  const overwrite = request.overwrite === true;
  await mkdir(workspaceRoot(), { recursive: true, mode: 0o700 });
  const root = await realpath(workspaceRoot());
  const conflicts: string[] = [];
  for (const file of files) {
    const entry = await inspect(root, folder + "/" + file.path);
    if (entry && !entry.isFile()) throw fail(file.path + " is already a folder.", 409);
    if (entry) conflicts.push(file.path);
  }
  const exists = (paths: string[]) =>
    fail("Some files already exist: " + paths.join(", "), 409, paths);
  if (conflicts.length && !overwrite) throw exists(conflicts);
  for (const file of files) {
    const parts = (folder + "/" + file.path).split("/");
    let directory = root;
    // One level at a time, so a link can never be created through.
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      await mkdir(directory).catch((error) => {
        if (codeOf(error) !== "EEXIST") throw error;
      });
      if (!(await lstat(directory)).isDirectory())
        throw fail(part + " is not a plain folder.", 409);
    }
    await inside(root, directory);
    const target = join(directory, parts.at(-1)!);
    if (overwrite) {
      // Renaming replaces the entry itself, so nothing is written through a link.
      const temporary = join(directory, ".quorum-" + randomUUID() + ".tmp");
      try {
        await writeFile(temporary, file.content, { flag: "wx" });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    } else
      // "wx" fails on anything already there, including a link.
      await writeFile(target, file.content, { flag: "wx" }).catch((error) => {
        throw codeOf(error) === "EEXIST" ? exists([file.path]) : error;
      });
  }
  return {
    folder: join(workspaceRoot(), folder),
    files: files.map((file) => ({
      path: folder + "/" + file.path,
      size: Buffer.byteLength(file.content),
      preview: isPreviewable(file.path),
    })),
  };
}

const isPreviewable = (path: string) => /\.(html|svg)$/i.test(path);

/** Sent with every preview: no scripts, no requests, and no access to the app. */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  // The policy above does not stop a browser looking up a linked host name early.
  "x-dns-prefetch-control": "off",
};

/** A saved HTML or SVG file, from the encoded part of a /preview/ address. */
export async function readPreview(address: string) {
  let parts: string[] = [];
  try {
    parts = address.split("/").map(decodeURIComponent);
  } catch {
    /* A malformed address names nothing. */
  }
  // A decoded slash would let one part smuggle in a path.
  const path = parts.some((part) => part.includes("/")) ? null : workspacePath(parts.join("/"));
  if (!path || !isPreviewable(path))
    throw fail("Only saved HTML and SVG files can be previewed.", 404);
  const root = await existingRoot();
  if (!root) throw fail("There is no file at " + path + ".", 404);
  const content = await readText(root, path);
  return /\.svg$/i.test(path)
    ? { type: "image/svg+xml; charset=utf-8", content }
    : { type: "text/html; charset=utf-8", content: await inlineStyles(root, path, content) };
}

/**
 * The preview policy blocks every request, so put the workspace stylesheets a page links
 * to into the page. Other link elements are removed, so none can hint at a connection.
 */
async function inlineStyles(root: string, page: string, html: string) {
  const styles = new Map<string, string>();
  for (const [tag] of html.matchAll(/<link\b[^<>]*>/gi)) {
    if (styles.size >= MAX_STYLESHEETS || styles.has(tag)) continue;
    const attributes = new Map(
      [...tag.slice(5).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(
        (m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""],
      ),
    );
    const href = attributes.get("href")?.split(/[?#]/)[0];
    if (!/\bstylesheet\b/i.test(attributes.get("rel") ?? "") || !href) continue;
    // An address with a scheme or a leading slash does not name a neighbouring file.
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) continue;
    try {
      const path = workspacePath(posix.join(posix.dirname(page), decodeURIComponent(href)));
      if (!path || !/\.css$/i.test(path)) continue;
      const media = attributes.get("media");
      styles.set(
        tag,
        "<style" +
          (media && /^[\w\s(),:.-]+$/.test(media) ? ' media="' + media + '"' : "") +
          ">\n" +
          // Text inside the sheet must not end the element early.
          (await readText(root, path)).replace(/<\/(style)/gi, "<\\/$1") +
          "\n</style>",
      );
    } catch {
      /* A missing or refused stylesheet leaves its link, which the policy blocks. */
    }
  }
  return html.replace(/<link\b[^<>]*>/gi, (tag) => styles.get(tag) ?? "");
}
