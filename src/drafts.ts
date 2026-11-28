import { createHash, randomBytes } from "node:crypto";
import { isPreviewable } from "./engine.ts";
import { addressPath, checkFiles, renderPreview } from "./workspace.ts";

/**
 * Proposed files held in memory so the page can show a design before anything is saved.
 * They are checked like files being saved, served like saved previews, and never written
 * to disk. The oldest unused drafts are dropped to stay within the limits.
 */
export const MAX_DRAFTS = 50;
export const MAX_DRAFT_BYTES = 20_000_000;

interface Draft {
  files: Map<string, string>;
  bytes: number;
  /** A digest of the files, so the same ones are held once. */
  digest: string;
}
// Least recently used first.
const drafts = new Map<string, Draft>();
const ids = new Map<string, string>();
let held = 0;

const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Move a draft to the back of the line for removal. */
function keep(id: string, draft: Draft) {
  drafts.delete(id);
  drafts.set(id, draft);
}

/** Hold the files of one preview. @returns an id nobody can guess, for their addresses */
export function addDraft(request: { files?: unknown }) {
  const files = checkFiles(request.files);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const known = ids.get(digest);
  if (known) {
    keep(known, drafts.get(known)!);
    return { id: known };
  }
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  for (const [id, old] of drafts) {
    if (drafts.size < MAX_DRAFTS && held + bytes <= MAX_DRAFT_BYTES) break;
    drafts.delete(id);
    ids.delete(old.digest);
    held -= old.bytes;
  }
  const id = randomBytes(24).toString("base64url");
  drafts.set(id, { files: new Map(files.map((f) => [f.path, f.content])), bytes, digest });
  ids.set(digest, id);
  held += bytes;
  return { id };
}

/** An HTML or SVG draft, from the encoded part of a /draft/ address: an id, then a path. */
export async function readDraft(address: string) {
  const [id, ...parts] = address.split("/");
  const draft = drafts.get(id);
  const path = addressPath(parts);
  const content = path && isPreviewable(path) ? draft?.files.get(path) : undefined;
  if (!draft || !path || content === undefined)
    throw fail("That preview is no longer here. Open it again from the meeting.", 404);
  keep(id, draft);
  return renderPreview(path, content, (sheet) => {
    const found = draft.files.get(sheet);
    if (found === undefined) throw fail("There is no file at " + sheet + ".", 404);
    return found;
  });
}
