import { MAX_FILE_BYTES, slug } from "./engine.ts";
import type { Attachment } from "./engine.ts";
import { parseGitHubURL } from "./import.ts";
import { runProcess } from "./providers.ts";
import { checkFiles, decodeText } from "./workspace.ts";

/**
 * Commits files the host approved to a new branch and opens a pull request. No existing
 * branch is ever updated: the only reference written is one that did not exist before.
 * Writing is off unless the person running Quorum turns it on, and the token stays here.
 */
const API = "https://api.github.com";
const MAX_MESSAGE_CHARS = 5000;

const fail = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });

/** Repositories writing is limited to, or null for no limit. */
function allowedRepositories(): string[] | null {
  const value = process.env.QUORUM_GITHUB_REPOS?.trim();
  // A list with no usable name allows nothing rather than everything.
  return value
    ? value.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)
    : null;
}

/** Writing is a choice of its own: a token may have been set only to read private files. */
function tokenSource() {
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
async function writeToken(signal?: AbortSignal) {
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

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Why GitHub refused, in terms the host can act on. */
async function refusal(response: Response, token: string, repository: string) {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    errors?: Array<{ message?: unknown }>;
  } | null;
  const detail = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : [])]
    .filter((text) => typeof text === "string")
    .join(". ")
    .replaceAll(token, "[token]")
    .slice(0, 300);
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
  if (status === 401)
    return fail("GitHub rejected the token. Check QUORUM_GITHUB_TOKEN or run gh auth login.", 403);
  if (status === 403)
    return fail(
      "No permission to write to " + repository +
        ". The token needs Contents and Pull requests write access." + said,
      403,
    );
  if (status === 404)
    return fail(
      "GitHub could not find " + repository +
        ". Check the name, and that the token can see and write to it." + said,
      404,
    );
  if (status >= 300 && status < 400)
    return fail(repository + " has moved. Use its current owner/name.", 404);
  if (status === 409 || status === 422)
    return fail("GitHub refused the change to " + repository + "." + said, 409);
  return fail("GitHub returned HTTP " + status + "." + said, 502);
}

/** One call to the GitHub REST API, which is the only place the token is sent. */
function repositoryAPI(token: string, repository: string, signal?: AbortSignal) {
  return async <T>(path: string, body?: object): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(API + "/repos/" + repository + path, {
        method: body ? "POST" : "GET",
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
    if (!response.ok) throw await refusal(response, token, repository);
    return (await response.json().catch(() => {
      throw fail("GitHub sent an answer Quorum could not read.", 502);
    })) as T;
  };
}

/** An object id from GitHub, checked before it is used in an address or a request. */
function objectId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value))
    throw fail("GitHub sent an answer Quorum could not read.", 502);
  return value;
}

/** Commit the files to a new quorum/ branch from the default branch and open a pull request. */
export async function commitToGitHub(
  request: { repo?: unknown; message?: unknown; files?: unknown },
  signal?: AbortSignal,
) {
  if (!tokenSource())
    throw fail(
      "Committing to GitHub is off. Start Quorum with QUORUM_GITHUB_CLI=1, or with QUORUM_GITHUB_TOKEN and QUORUM_GITHUB_WRITE=1.",
      403,
    );
  const { owner, repo, name } = checkRepository(request.repo);
  const message = checkMessage(request.message);
  const files = checkFiles(request.files);
  const token = await writeToken(signal);
  const call = repositoryAPI(token, owner + "/" + repo, signal);

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
    const cause = error as Error & { status?: number };
    throw fail(
      "The branch " + branch + " was created in " + name +
        ", but the pull request could not be opened. " + cause.message,
      cause.status,
    );
  }
  const url = String(pull.html_url ?? "");
  if (!url.startsWith("https://github.com/"))
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
