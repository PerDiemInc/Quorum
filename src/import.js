import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, sep } from "node:path";
import { MAX_IMPORT, MAX_SKILL_CHARS, MAX_SKILLS } from "./engine.js";

/**
 * Imports agent profiles (Markdown with a name in its front matter, as Claude Code
 * subagents are written) and skills (SKILL.md). Only their text is imported: scripts and
 * files they refer to are left behind, because meeting agents cannot run tools.
 * @typedef {{name: string, description: string, text: string, source: string, truncated: boolean}} Skill
 * @typedef {{name: string, description: string, instructions: string, model: string,
 *   skills: Skill[], source: string, truncated: boolean}} Profile
 */

const MAX_LISTED = 500;
// Documentation that sits beside profiles but never is one.
const DOCS = /^(readme|license|licence|contributing|changelog|code_of_conduct|security|claude|agents|index|skill)\.md$/i;
const MAX_FILE_BYTES = 400_000;
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** Read the front matter of a profile or skill, and return the rest as its body. */
export function parseDocument(content) {
  const text = String(content).replace(/^﻿/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const fields = {};
  if (match) {
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const field = lines[i].match(/^(name|description|model|skills):[ \t]*(.*)$/);
      if (!field) continue;
      let value = field[2].trim();
      // Long values continue on indented lines, with or without a block marker.
      if (/^[>|][+-]?$/.test(value)) value = "";
      const list = field[1] === "skills";
      while ((list ? /^[ \t]*(-[ \t]|[ \t]\S)/ : /^[ \t]+\S/).test(lines[i + 1] ?? ""))
        value += (list ? "," : " ") + lines[++i].trim().replace(/^-[ \t]+/, "");
      fields[field[1]] = unquote(value.trim());
    }
  }
  return {
    name: (fields.name ?? "").slice(0, 200),
    description: (fields.description ?? "").slice(0, 600),
    model: (fields.model ?? "").slice(0, 100),
    skills: (fields.skills ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter(Boolean)
      .slice(0, MAX_SKILLS),
    body: (match ? text.slice(match[0].length) : text).trim(),
  };
}
const unquote = (value) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");

/** @returns {Skill} */
function toSkill(content, fallbackName, source) {
  const { name, description, body } = parseDocument(content);
  const text = body || description;
  return {
    name: name || fallbackName,
    description,
    text: text.slice(0, MAX_SKILL_CHARS),
    source,
    truncated: text.length > MAX_SKILL_CHARS,
  };
}

/**
 * @param {string} content
 * @param {string} source
 * @param {(names: string[]) => Promise<Skill[]>} findSkills looks up the skills a profile names
 * @returns {Promise<Profile | null>} null when the file is not an agent profile
 */
async function toProfile(content, source, findSkills) {
  const { name, description, model, skills, body } = parseDocument(content);
  const instructions = body || description;
  if (!name || !instructions) return null;
  return {
    // File-style names such as code-reviewer read better as Code Reviewer.
    name: (/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(name)
      ? name.replace(/(^|[-_])([a-z0-9])/g, (_, gap, c) => (gap ? " " : "") + c.toUpperCase())
      : name
    ).slice(0, 80),
    description,
    instructions: instructions.slice(0, MAX_SKILL_CHARS),
    model: model === "inherit" ? "" : model,
    skills: skills.length ? await findSkills(skills) : [],
    source,
    truncated: instructions.length > MAX_SKILL_CHARS,
  };
}

// ---- Claude agents and skills installed on this computer ----

function claudeRoots() {
  const custom = (value) => value.split(delimiter).filter(Boolean);
  const claude = join(homedir(), ".claude");
  return {
    skill: process.env.CLAUDE_SKILLS_DIR
      ? custom(process.env.CLAUDE_SKILLS_DIR)
      : [join(claude, "skills"), join(claude, "plugins")],
    agent: process.env.CLAUDE_AGENTS_DIR
      ? custom(process.env.CLAUDE_AGENTS_DIR)
      : [join(claude, "agents")],
  };
}

async function findFiles(directory, wanted, depth, seen, found) {
  if (depth > 8 || found.length >= MAX_LISTED * 2) return;
  let real, entries;
  try {
    // Skills are often symlinked in, so follow links but visit each folder once.
    real = await realpath(directory);
    if (seen.has(real)) return;
    seen.add(real);
    entries = await readdir(real, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (wanted(entry.name)) found.push(path);
    else if (entry.isDirectory() || entry.isSymbolicLink())
      await findFiles(path, wanted, depth + 1, seen, found);
  }
}

/** Every readable agent and skill, each with an id that stands in for its path. */
async function scanLocal() {
  const items = [],
    names = new Set(),
    seen = new Set();
  const roots = claudeRoots();
  for (const kind of ["agent", "skill"]) {
    const wanted =
      kind === "skill"
        ? (name) => name === "SKILL.md"
        : (name) => /\.md$/i.test(name) && !DOCS.test(name);
    for (const root of roots[kind]) {
      const files = [];
      await findFiles(root, wanted, 0, seen, files);
      for (const file of files) {
        try {
          if ((await stat(file)).size > MAX_FILE_BYTES) continue;
          const folders = relative(root, dirname(file)).split(sep);
          const source =
            kind === "agent"
              ? "Claude agent"
              : basename(root) === "plugins"
                ? "Claude plugin"
                : folders[0] === "synced"
                  ? "Synced Claude skill"
                  : "Claude skill";
          const content = await readFile(file, "utf8");
          const parsed = parseDocument(content);
          if (kind === "agent" && !parsed.name) continue;
          const name = parsed.name || basename(dirname(file));
          // Plugin folders keep several copies of one skill; list the first.
          const key = kind + "\n" + name + "\n" + parsed.description;
          if (names.has(key) || items.length >= MAX_LISTED) continue;
          names.add(key);
          const id = createHash("sha256").update(file).digest("hex").slice(0, 16);
          items.push({ id, kind, name, description: parsed.description, source, content });
        } catch {
          /* An unreadable file must not hide the others. */
        }
      }
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLocal() {
  const items = await scanLocal();
  return { items: items.map(({ content, ...item }) => item) };
}

/** Browsers choose by id, never by path, so only scanned files can be read. */
export async function readLocal(ids) {
  checkSelection(ids);
  const all = await scanLocal();
  const findSkills = async (wanted) =>
    wanted.flatMap((name) => {
      const found = all.find((i) => i.kind === "skill" && i.name === name);
      return found ? [toSkill(found.content, found.name, found.source)] : [];
    });
  const items = [],
    skipped = [];
  for (const id of ids) {
    const item = all.find((i) => i.id === id);
    if (!item) throw fail("That file is no longer there. Reload the list.", 404);
    if (item.kind === "skill")
      items.push({ kind: "skill", ...toSkill(item.content, item.name, item.source) });
    else {
      const profile = await toProfile(item.content, item.source, findSkills);
      if (profile) items.push({ kind: "agent", ...profile });
      else skipped.push(item.name);
    }
  }
  return { items, skipped };
}

function checkSelection(items) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > MAX_IMPORT ||
    items.some((item) => typeof item !== "string")
  )
    throw fail("Choose between 1 and " + MAX_IMPORT + " items.");
}

// ---- Agents and skills in GitHub repositories ----

const safeSegment = (part) =>
  // A decoded slash would let one segment smuggle in a path.
  part && part !== "." && part !== ".." && !/[\u0000-\u001f\\/]/.test(part);

/** Accept owner/repo or a github.com address, optionally pointing at a branch and folder. */
export function parseGitHubURL(input) {
  let text = String(input ?? "").trim();
  if (/^[\w-]+\/[\w.-]+$/.test(text)) text = "https://github.com/" + text;
  else if (/^github\.com\//i.test(text)) text = "https://" + text;
  let url, parts;
  try {
    url = new URL(text);
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw fail("Enter a GitHub repository, such as owner/repo or its web address.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port)
    throw fail("Only https://github.com addresses can be imported.");
  const [owner, name, kind, ref, ...path] = parts;
  const repo = name?.replace(/\.git$/, "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner ?? "") ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repo ?? "") ||
    !safeSegment(repo) ||
    (kind && !["tree", "blob"].includes(kind)) ||
    (kind && !/^[A-Za-z0-9._-]{1,200}$/.test(ref ?? "")) ||
    !path.every(safeSegment)
  )
    throw fail("That does not look like a repository, folder or file on GitHub.");
  return { owner, repo, ref: ref ?? "HEAD", path: path.join("/"), file: kind === "blob" };
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function github(url, signal) {
  // Public repositories need no token. Set one to read private repositories.
  const token = process.env.QUORUM_GITHUB_TOKEN;
  let response;
  try {
    response = await fetch(url, {
      signal,
      headers: {
        "user-agent": "quorum",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fail("GitHub could not be reached. Check your connection and try again.", 502);
  }
  if (response.status === 404)
    throw fail(
      "GitHub found nothing there. Check the address; a private repository needs QUORUM_GITHUB_TOKEN.",
      404,
    );
  if (response.status === 403 || response.status === 429)
    throw fail(
      "GitHub refused the request, usually because of its hourly limit. Try later or set QUORUM_GITHUB_TOKEN.",
      429,
    );
  if (!response.ok) throw fail("GitHub returned HTTP " + response.status, 502);
  return response;
}

const isSkill = (path) => /(^|\/)SKILL\.md$/i.test(path);
const folderName = (path) => path.split("/").at(-2);

async function repositoryFiles({ owner, repo, ref }, signal) {
  const tree = await (
    await github(
      "https://api.github.com/repos/" +
        owner + "/" + repo + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1",
      signal,
    )
  ).json();
  return {
    truncated: Boolean(tree.truncated),
    paths: (tree.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path),
  };
}

/** Pick out the profiles and skills among a repository's file paths. */
function classify(paths, folder, repo) {
  const within = paths.filter(
    (p) => /\.md$/i.test(p) && (!folder || p.startsWith(folder + "/")),
  );
  const skills = within.filter(isSkill);
  const skillFolders = skills.map((p) => p.slice(0, -"SKILL.md".length));
  // A skill's own helper prompts are part of the skill, not agents.
  const others = within.filter(
    (p) =>
      !DOCS.test(p.split("/").at(-1)) &&
      !skillFolders.some((prefix) => prefix && p.startsWith(prefix)),
  );
  let agents = others.filter((p) => /(^|\/)agents\//i.test(p));
  // Collections without an agents folder, or a folder you pointed at directly.
  // Commands, hooks and documentation are Markdown too, but are not agents.
  if (!agents.length && (folder || !skills.length))
    agents = others.filter(
      (p) => !/(^|\/)(\.github|docs|commands|hooks)\//i.test(p),
    );
  return [
    ...agents.map((path) => ({
      path,
      kind: "agent",
      name: path.split("/").at(-1).replace(/\.md$/i, ""),
    })),
    ...skills.map((path) => ({ path, kind: "skill", name: folderName(path) ?? repo })),
  ];
}

export async function listGitHub(address, signal) {
  const location = parseGitHubURL(address);
  const { owner, repo, ref, path, file } = location;
  const result = { repo: owner + "/" + repo, ref, truncated: false };
  if (file) {
    if (!/\.md$/i.test(path)) throw fail("Choose a Markdown file.");
    const kind = isSkill(path) ? "skill" : "agent";
    const name = kind === "skill" ? (folderName(path) ?? repo) : path.split("/").at(-1).replace(/\.md$/i, "");
    return { ...result, items: [{ path, kind, name }] };
  }
  const files = await repositoryFiles(location, signal);
  const items = classify(files.paths, path, repo);
  return {
    ...result,
    truncated: files.truncated || items.length > MAX_LISTED,
    items: items.slice(0, MAX_LISTED),
  };
}

export async function readGitHub(address, paths, signal) {
  const location = parseGitHubURL(address);
  const { owner, repo, ref } = location;
  checkSelection(paths);
  if (!paths.every((p) => /\.md$/i.test(p) && p.split("/").every(safeSegment)))
    throw fail("Only Markdown files inside the repository can be imported.");
  const source = "github.com/" + owner + "/" + repo;
  const download = async (path) => {
    const response = await github(
      "https://raw.githubusercontent.com/" +
        owner + "/" + repo + "/" + encodeURIComponent(ref) + "/" + encodePath(path),
      signal,
    );
    const content = await response.text();
    if (content.length > MAX_FILE_BYTES) throw fail(path + " is too large to import.");
    return content;
  };
  const skillFrom = async (path) =>
    toSkill(await download(path), folderName(path) ?? repo, source);
  let files;
  // Skills a profile names are taken from the same repository.
  const findSkills = async (wanted) => {
    files ??= await repositoryFiles(location, signal);
    const found = wanted.flatMap((name) => {
      const path = files.paths.find((p) => isSkill(p) && folderName(p) === name);
      return path ? [path] : [];
    });
    return Promise.all(found.map(skillFrom));
  };
  const items = [],
    skipped = [];
  for (const path of paths) {
    if (isSkill(path)) items.push({ kind: "skill", ...(await skillFrom(path)) });
    else {
      const profile = await toProfile(await download(path), source, findSkills);
      if (profile) items.push({ kind: "agent", ...profile });
      else skipped.push(path);
    }
  }
  return { items, skipped };
}
