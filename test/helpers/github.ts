import type test from "node:test";
import { createHash } from "node:crypto";
import { blobId } from "../../src/branch.ts";

/** An in-memory stand-in for the GitHub REST API of one repository, acme/site. */
interface File {
  content: string;
  mode: string;
}
interface Commit {
  message: string;
  parents: string[];
  files: Map<string, File>;
}
export interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged_at: string | null;
  html_url: string;
}
export interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  authorization: string;
}

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");

export function fakeGitHub(t: test.TestContext, initial: Record<string, string> = { "README.md": "# Site\n" }) {
  const commits = new Map<string, Commit>();
  const trees = new Map<string, Map<string, File>>();
  const folders = new Map<string, unknown[]>();
  const blobs = new Map<string, string>();
  const refs = new Map<string, string>();
  const pulls: Pull[] = [];
  const calls: Call[] = [];
  /** Replace the answer for a "METHOD /path"; returning nothing keeps the usual one. */
  const answers = new Map<string, () => Response | undefined>();

  /** Keep a snapshot and each of its folders. @returns the root tree's id */
  function storeTree(files: Map<string, File>): string {
    const folder = (prefix: string): string => {
      const entries = new Map<string, Record<string, unknown>>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        if (rest.length)
          entries.set(name, { path: name, mode: "040000", type: "tree", sha: folder(prefix + name + "/") });
        else {
          const sha = blobId(file.content);
          blobs.set(sha, file.content);
          entries.set(name, { path: name, mode: file.mode, type: "blob", sha, size: Buffer.byteLength(file.content) });
        }
      }
      const list = [...entries.values()];
      const sha = hash(list);
      folders.set(sha, list);
      return sha;
    };
    const root = folder("");
    trees.set(root, new Map(files));
    return root;
  }
  function addCommit(message: string, parents: string[], files: Map<string, File>) {
    storeTree(files);
    const sha = hash([message, parents, [...files], commits.size]);
    commits.set(sha, { message, parents, files: new Map(files) });
    return sha;
  }
  refs.set(
    "main",
    addCommit("Initial", [], new Map(Object.entries(initial).map(([p, content]) => [p, { content, mode: "100644" }]))),
  );

  const missing = () => Response.json({ message: "Not Found" }, { status: 404 });
  const refused = (message: string) => Response.json({ message }, { status: 422 });
  const descends = (sha: string, from: string): boolean =>
    sha === from || (commits.get(sha)?.parents.some((p) => descends(p, from)) ?? false);

  function answer(method: string, path: string, body: Record<string, unknown>): Response {
    const [route, query = ""] = path.split("?");
    let match: RegExpExecArray | null;
    if (method === "GET" && route === "") return Response.json({ default_branch: "main" });
    if (method === "GET" && (match = /^\/git\/ref\/heads\/(.+)$/.exec(route))) {
      const sha = refs.get(match[1]);
      return sha ? Response.json({ object: { sha } }) : missing();
    }
    if (method === "GET" && (match = /^\/git\/commits\/(\w+)$/.exec(route))) {
      const commit = commits.get(match[1]);
      return commit
        ? Response.json({ message: commit.message, tree: { sha: storeTree(commit.files) } })
        : missing();
    }
    if (method === "GET" && (match = /^\/git\/trees\/(\w+)$/.exec(route))) {
      if (query === "recursive=1")
        return Response.json({
          tree: [...(trees.get(match[1]) ?? [])].map(([p, f]) => ({
            path: p, mode: f.mode, type: "blob", sha: blobId(f.content), size: Buffer.byteLength(f.content),
          })),
        });
      const tree = folders.get(match[1]);
      return tree ? Response.json({ tree }) : missing();
    }
    if (method === "GET" && (match = /^\/git\/blobs\/(\w+)$/.exec(route))) {
      const content = blobs.get(match[1]);
      return content === undefined
        ? missing()
        : Response.json({ content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
    }
    if (method === "POST" && route === "/git/trees") {
      const files = new Map(trees.get(String(body.base_tree)));
      for (const entry of body.tree as Array<{ path: string; mode: string; content: string }>)
        files.set(entry.path, { content: entry.content, mode: entry.mode });
      return Response.json({ sha: storeTree(files) }, { status: 201 });
    }
    if (method === "POST" && route === "/git/commits") {
      const sha = addCommit(String(body.message), body.parents as string[], trees.get(String(body.tree))!);
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && route === "/git/refs") {
      const name = String(body.ref).replace("refs/heads/", "");
      if (refs.has(name)) return refused("Reference already exists");
      refs.set(name, String(body.sha));
      return Response.json({}, { status: 201 });
    }
    if (method === "PATCH" && (match = /^\/git\/refs\/heads\/(.+)$/.exec(route))) {
      const head = refs.get(match[1]);
      if (!head) return missing();
      if (body.force !== true && !descends(String(body.sha), head)) return refused("Update is not a fast forward");
      refs.set(match[1], String(body.sha));
      return Response.json({});
    }
    if (method === "GET" && route === "/pulls") {
      const head = new URLSearchParams(query).get("head")!.split(":")[1];
      return Response.json(pulls.filter((p) => p.head === head));
    }
    if (method === "POST" && route === "/pulls") {
      const number = pulls.length + 1;
      const pull: Pull = {
        number,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
        state: "open",
        merged_at: null,
        html_url: "https://github.com/acme/site/pull/" + number,
      };
      pulls.push(pull);
      return Response.json(pull, { status: 201 });
    }
    return missing();
  }

  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const prefix = "https://api.github.com/repos/acme/site";
    if (!url.startsWith(prefix)) throw new Error("unexpected request " + url);
    const path = url.slice(prefix.length);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body, authorization: (init.headers as Record<string, string>).authorization });
    // Lets two requests overlap, as they would over a network.
    await new Promise((resolve) => setImmediate(resolve));
    return answers.get(method + " " + path.split("?")[0])?.() ?? answer(method, path, body ?? {});
  });

  return {
    calls,
    pulls,
    refs,
    answers,
    head: (branch: string) => commits.get(refs.get(branch)!)!,
    commit: (sha: string) => commits.get(sha)!,
    /** What a file holds on a branch. */
    read: (branch: string, path: string) => commits.get(refs.get(branch)!)!.files.get(path)?.content,
    /** Someone else commits to a branch. */
    push(branch: string, path: string, content: string, mode = "100644") {
      const head = refs.get(branch) ?? refs.get("main")!;
      const files = new Map(commits.get(head)!.files).set(path, { content, mode });
      refs.set(branch, addCommit("Edit " + path, [head], files));
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
  };
}
