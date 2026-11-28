import { hasKey, isAccessKey, KEY_REMOVED, MAX_FILE_BYTES, slug } from "./engine.ts";
import type { Attachment } from "./engine.ts";
import { parseGitHubURL } from "./import.ts";
import { runProcess } from "./providers.ts";
import { checkFiles, decodeText } from "./workspace.ts";

/**
 * Commits files the host approved to a new branch and opens a pull request. No existing
 * branch is ever updated: the only reference written is one that did not exist before.
 * Writing needs an access key the host enters for that push, or a credential the person
 * running Quorum turned on. Either is used for the calls to GitHub and nothing else: it is
 * not stored, logged or repeated in an answer.
 */
const API = "https://api.github.com";
const MAX_MESSAGE_CHARS = 5000;

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
/** An error whose message is safe to show, with the HTTP status to answer with. */
export { fail };
/** A failure that means the host's key should be forgotten and replaced. */
const rejected = (message: string) => Object.assign(fail(message, 403), { keyRejected: true });

// Anything shaped like a GitHub credential, whether or not it is the one in use.
const KEY_SHAPE = /github_pat_[A-Za-z0-9_]+|gh[a-z]_[A-Za-z0-9_.-]{16,}/g;
const redact = (text: string, token: string) =>
  (token ? text.replaceAll(token, "[token]") : text).replace(KEY_SHAPE, "[token]");

/** What a failure says beyond its message and status. */
export interface Failure extends Error {
  status?: number;
  keyRejected?: boolean;
  /** Set when the repository's rules refused a change to a branch. */
  protected?: boolean;
  /** Set when a commit straight to the default branch was refused. */
  directRefused?: boolean;
}

/** Whatever failed, no credential leaves in the explanation. */
export async function guarded<T>(key: string, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const cause = error as Failure;
    throw Object.assign(
      fail(redact(cause.message, key), cause.status ?? 502),
      cause.keyRejected ? { keyRejected: true } : {},
      cause.directRefused ? { directRefused: true } : {},
    );
  }
}

/** The key the host entered for this push, or "" when there is none. */
export function suppliedKey(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  const key = typeof value === "string" ? value.trim() : "";
  // The value is not quoted back: it may be a real credential with a stray character.
  if (!isAccessKey(key)) throw rejected("That does not look like a GitHub access key.");
  return key;
}

/** Repositories writing is limited to, or null for no limit. */
function allowedRepositories(): string[] | null {
  const value = process.env.QUORUM_GITHUB_REPOS?.trim();
  // A list with no usable name allows nothing rather than everything.
  return value
    ? value.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)
    : null;
}

/** Writing is a choice of its own: a token may have been set only to read private files. */
export function tokenSource() {
  const cli = process.env.QUORUM_GITHUB_CLI === "1";
  if (!process.env.QUORUM_GITHUB_TOKEN) return cli ? "cli" : null;
  return cli || process.env.QUORUM_GITHUB_WRITE === "1" ? "token" : null;
}

/** What the browser may know: whether committing is on, never the credential. */
export function githubStatus() {
  const source = tokenSource();
  return { available: source !== null, source, repos: allowedRepositories() };
}

/** Errors here must never carry the token or anything a command printed. */
export async function writeToken(signal?: AbortSignal) {
  const source = tokenSource();
  let token = process.env.QUORUM_GITHUB_TOKEN ?? "";
  if (source === "cli")
    token = await runProcess("gh", ["auth", "token", "--hostname", "github.com"], {
      signal,
      maxBytes: 10_000,
    }).catch(() => {
      throw fail(
        "The GitHub CLI gave no token. Install gh and run gh auth login, then try again.",
        403,
      );
    });
  token = token.trim();
  // Anything else could break a header, and a header error quotes its value.
  if (!/^[\x21-\x7e]{1,500}$/.test(token))
    throw fail("The GitHub token is not in a usable format.", 403);
  return token;
}

export function checkRepository(value: unknown) {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(
    typeof value === "string" ? value.trim() : "",
  );
  const [name = "", owner = "", repo = ""] = match ?? [];
  if (!match || repo === "." || repo === ".." || /\.git$/i.test(repo))
    throw fail("Enter the repository as owner/name.");
  const allowed = allowedRepositories();
  if (allowed && !allowed.includes(name.toLowerCase()))
    throw fail(name + " is not in QUORUM_GITHUB_REPOS, so Quorum will not write to it.", 403);
  return { owner, repo, name };
}

function checkMessage(value: unknown) {
  const message = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  // Control characters other than line breaks and tabs have no place in a message.
  if (!message || message.length > MAX_MESSAGE_CHARS || /[^\P{Cc}\n\t]/u.test(message))
    throw fail("Enter a commit message of up to " + MAX_MESSAGE_CHARS + " characters.");
  return message;
}

export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Why GitHub refused, in terms the host can act on.
 * @param own whether the credential is a key the host entered
 */
async function refusal(response: Response, token: string, repository: string, own: boolean) {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    errors?: Array<{ message?: unknown }>;
  } | null;
  const answered = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : [])]
    .filter((text) => typeof text === "string")
    .join(". ");
  // Redacted before it is shortened, so no part of a credential survives the cut.
  const detail = redact(answered, token).slice(0, 300);
  const said = detail ? " GitHub said: " + detail : "";
  const { status, headers } = response;
  if (
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.has("retry-after") ||
        /rate limit/i.test(detail)))
  ) {
    const reset = Number(headers.get("x-ratelimit-reset"));
    return fail(
      "GitHub's rate limit was reached. Try again " +
        (reset ? "after " + new Date(reset * 1000).toISOString() + "." : "later."),
      429,
    );
  }
  // The key is fine here; the repository does not allow this change.
  if ([403, 409, 422].includes(status) && /protected branch|rule violation|status check|through a pull request/i.test(detail))
    return Object.assign(fail("The rules of " + repository + " refused the change." + said, 409), {
      protected: true,
    });
  if (status === 401)
    return own
      ? rejected("GitHub rejected the access key. Check that it is complete and has not expired.")
      : fail("GitHub rejected the token. Check QUORUM_GITHUB_TOKEN or run gh auth login.", 403);
  if (status === 403) {
    const message =
      "No permission to write to " + repository +
      ". The " + (own ? "access key" : "token") + " needs Contents and Pull requests write access." + said;
    return own ? rejected(message) : fail(message, 403);
  }
  if (status === 404)
    return fail(
      "GitHub could not find " + repository +
        ". Check the name, and that the " + (own ? "access key" : "token") + " can see and write to it." + said,
      404,
    );
  if (status >= 300 && status < 400)
    return fail(repository + " has moved. Use its current owner/name.", 404);
  if (status === 409 || status === 422)
    return fail("GitHub refused the change to " + repository + "." + said, 409);
  return fail("GitHub returned HTTP " + status + "." + said, 502);
}

/** One call to the GitHub REST API, which is the only place the token is sent. A call
 * with a body creates something unless it names another method. */
export function repositoryAPI(token: string, repository: string, signal?: AbortSignal, own = false) {
  return async <T>(path: string, body?: object, method = body ? "POST" : "GET"): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(API + "/repos/" + repository + path, {
        method,
        signal,
        // A redirect could point anywhere, including a repository that is not allowed.
        redirect: "manual",
        headers: {
          "user-agent": "quorum",
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // The cause is dropped on purpose: it may describe the request, token included.
      throw signal?.aborted
        ? fail("GitHub took too long to answer. Check the repository before trying again.", 504)
        : fail("GitHub could not be reached. Check your connection and try again.", 502);
    }
    if (!response.ok) throw await refusal(response, token, repository, own);
    return (await response.json().catch(() => {
      throw fail("GitHub sent an answer Quorum could not read.", 502);
    })) as T;
  };
}

/** An object id from GitHub, checked before it is used in an address or a request. */
export function objectId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value))
    throw fail("GitHub sent an answer Quorum could not read.", 502);
  return value;
}

interface CommitRequest {
  repo?: unknown;
  message?: unknown;
  files?: unknown;
  /** An access key for this push only. */
  key?: unknown;
}

/** Commit the files to a new quorum/ branch from the default branch and open a pull request. */
export async function commitToGitHub(request: CommitRequest, signal?: AbortSignal) {
  const key = suppliedKey(request.key);
  return guarded(key, () => pushBranch(request, key, signal));
}

async function pushBranch(request: CommitRequest, key: string, signal?: AbortSignal) {
  if (!key && !tokenSource())
    throw fail(
      "Committing to GitHub is off without an access key. Enter one, or start Quorum with QUORUM_GITHUB_CLI=1, or with QUORUM_GITHUB_TOKEN and QUORUM_GITHUB_WRITE=1.",
      403,
    );
  // A key pasted into the wrong box must not be published with the files.
  const typed = JSON.stringify([request.repo, request.message]);
  if (hasKey(typed) || (key && JSON.stringify([typed, request.files]).includes(key)))
    throw fail("A GitHub key appears in the repository name, message or files. Remove it before pushing.");
  const { owner, repo, name } = checkRepository(request.repo);
  const message = checkMessage(request.message);
  const files = checkFiles(request.files);
  // Refused rather than changed: the host approved these exact contents.
  const secret = files.find(
    (f) => hasKey(f.path + "\n" + f.content) || f.content.includes(KEY_REMOVED),
  );
  if (secret)
    throw fail(
      secret.path + " contains a GitHub key, or had one removed from it. Quorum will not push it. " +
        "Ask for the file without the key.",
    );
  // The host's key comes first: entering one is asking for it to be used.
  const token = key || (await writeToken(signal));
  const call = repositoryAPI(token, owner + "/" + repo, signal, Boolean(key));

  const { default_branch: base } = await call<{ default_branch?: unknown }>("");
  if (typeof base !== "string" || !base) throw fail("GitHub sent no default branch.", 502);
  const head = await call<{ object?: { sha?: unknown } }>("/git/ref/heads/" + encodePath(base));
  const parent = objectId(head.object?.sha);
  const parentCommit = await call<{ tree?: { sha?: unknown } }>("/git/commits/" + parent);
  const baseTree = objectId(parentCommit.tree?.sha);
  const tree = objectId(
    (
      await call<{ sha?: unknown }>("/git/trees", {
        base_tree: baseTree,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      })
    ).sha,
  );
  if (tree === baseTree)
    throw fail("These files are already on " + base + ", so there is nothing to commit.", 409);
  const commit = objectId(
    (await call<{ sha?: unknown }>("/git/commits", { message, tree, parents: [parent] })).sha,
  );
  const [title, ...rest] = message.split("\n");
  const words = slug(title.normalize("NFKD").replace(/[^\x20-\x7e]/g, ""), 40) || "files";
  const branch = "quorum/" + words + "-" + new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  // Creating a reference fails if it exists; Quorum never sends an update to one.
  await call("/git/refs", { ref: "refs/heads/" + branch, sha: commit });
  const description = [
    rest.join("\n").trim(),
    "Files proposed in a Quorum meeting and committed with the host's approval. Review them before merging.",
    files.map((f) => "- `" + f.path.replaceAll("`", "'") + "`").join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  let pull: { html_url?: unknown; number?: unknown };
  try {
    pull = await call("/pulls", { title: title.slice(0, 200), head: branch, base, body: description });
  } catch (error) {
    const cause = error as Error & { status?: number; keyRejected?: boolean };
    throw Object.assign(
      fail(
        "The branch " + branch + " was created in " + name +
          ", but the pull request could not be opened. " + cause.message,
        cause.status,
      ),
      cause.keyRejected ? { keyRejected: true } : {},
    );
  }
  const url = String(pull.html_url ?? "");
  if (!url.startsWith("https://github.com/") || redact(url, token) !== url)
    throw fail("The branch " + branch + " was created, but GitHub sent no pull request address.", 502);
  return { repo: name, branch, url, number: Number(pull.number) };
}

/** Read at most the size limit, so a huge file is not held in memory first. */
async function readLimited(response: Response, name: string) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > MAX_FILE_BYTES)
      throw fail(name + " is larger than " + MAX_FILE_BYTES / 1000 + " KB.", 413);
    parts.push(part);
  }
  return decodeText(Buffer.concat(parts), name);
}

/** One text file from a GitHub file address, to attach to a meeting. Nothing is written. */
export async function readGitHubFile(
  address: unknown,
  signal?: AbortSignal,
): Promise<{ file: Attachment }> {
  const { owner, repo, ref, path, file } = parseGitHubURL(address);
  if (!file || !path || path.length > 300)
    throw fail("Enter the address of one file, such as github.com/owner/repo/blob/main/README.md.");
  // The same optional token the import window reads with.
  const token = process.env.QUORUM_GITHUB_TOKEN?.trim();
  let response: Response;
  try {
    response = await fetch(
      "https://raw.githubusercontent.com/" +
        owner + "/" + repo + "/" + encodeURIComponent(ref) + "/" + encodePath(path),
      {
        signal,
        redirect: "error",
        headers: {
          "user-agent": "quorum",
          ...(token && /^[\x21-\x7e]+$/.test(token) ? { authorization: "Bearer " + token } : {}),
        },
      },
    );
  } catch {
    throw fail("GitHub could not be reached. Check your connection and try again.", 502);
  }
  if (response.status === 404)
    throw fail(
      "GitHub found no file there. Check the address; a private repository needs QUORUM_GITHUB_TOKEN.",
      404,
    );
  if (response.status === 403 || response.status === 429)
    throw fail("GitHub refused the request, usually because of its rate limit. Try later.", 429);
  if (!response.ok) throw fail("GitHub returned HTTP " + response.status + ".", 502);
  return {
    file: {
      path,
      content: await readLimited(response, path),
      source: "github.com/" + owner + "/" + repo + "@" + ref,
    },
  };
}
