import { KEY_REMOVED, redactKeys, takeKeys } from "/engine.js";
import type { Taken } from "/engine.js";

/**
 * The GitHub access key the host gave this session, typed in the push window or posted in
 * the meeting chat. `held` is the only place the page keeps it: never browser storage, a
 * cookie, the meeting or the transcript. It is sent to the local Quorum server with a push
 * and with nothing else, and reloading the page forgets it.
 */
let held = "";
/** Whether the chat is asking for a key, because a push needs one. */
let asking = false;
/** What needs the key, and how to carry on with it. */
let wanted: { purpose: Purpose; resume: () => void } | null = null;
/** What was last done with a key posted in the chat. */
let notice = "";
export type Purpose = "push" | "connect" | "commit";
const requests: Record<Purpose, { reason: string; action: string }> = {
  push: { reason: "To push to GitHub", action: "Open Push to GitHub" },
  connect: {
    reason: "Agents have written code. To connect a repository and commit it",
    action: "Connect repository",
  },
  commit: { reason: "To commit this meeting's files to its repository", action: "Commit now" },
};
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((watcher) => watcher());
export const onKeyChange = (watcher: () => void) => void watchers.add(watcher);

export const heldKey = () => held;
export const askingForKey = () => asking;
export function holdKey(key: string) {
  held = key;
  asking = false;
  changed();
}
export function forgetKey() {
  held = "";
  notice = "";
  changed();
}
/** Ask in the meeting chat for the key something needs. */
export function askForKey(purpose: Purpose, resume: () => void) {
  asking = true;
  wanted = { purpose, resume };
  notice = "";
  changed();
}
/** Put the request and the notice away. A held key stays held. */
export function closeKeyRequest() {
  asking = false;
  wanted = null;
  notice = "";
  changed();
}
/** Text on its way anywhere but a push, with every key replaced. */
export function scrub(text: string) {
  // An old key has no prefix to know it by, so the held one is also matched whole.
  return redactKeys(held ? text.replaceAll(held, KEY_REMOVED) : text);
}
/**
 * Take any key out of text the host typed or said, and hold it.
 * @param chat whether this is the message box, where an asked-for key may have no prefix
 */
export function intercept(text: string, chat = false): Taken & { found: boolean } {
  const taken = takeKeys(text, chat && asking);
  const found = taken.key !== undefined || taken.unusable === true || taken.text !== text;
  if (taken.key) {
    notice =
      "GitHub key received (ends in " + taken.key.slice(-4) + "), held for this session.";
    holdKey(taken.key);
  } else if (found) {
    notice = taken.unusable
      ? "That was not sent or kept: it looks like a secret, but not like a GitHub key."
      : "Something that looks like part of a GitHub key was removed and not kept.";
    changed();
  }
  return { ...taken, text: scrub(taken.text), found };
}

/** The request for a key, and the answer to one, beside the message box. */
export function createKeyRequest() {
  const $ = (id: string) => document.getElementById(id)!;
  function render() {
    $("key-request").hidden = !asking && !notice;
    const request = requests[wanted?.purpose ?? "push"];
    $("key-request-text").textContent =
      notice ||
      request.reason + ", Quorum needs a GitHub access key. Paste it into the message box and send it, " +
        "or type it in the window that opens. Make a fine-grained key for only the target repository, " +
        "with Contents and Pull requests: read and write. It is held in this page for the session " +
        "and never posted to the conversation.";
    $("key-request-link").hidden = Boolean(held);
    $("key-request-action").hidden = !wanted;
    $("key-request-action").textContent = request.action;
    $("key-request-forget").hidden = !held;
    $("key-request-close").textContent = asking ? "Not now" : "Dismiss";
  }
  onKeyChange(render);
  $("key-request-action").addEventListener("click", () => {
    const resume = wanted?.resume;
    // With the key in hand there is nothing left to say here.
    if (held) closeKeyRequest();
    resume?.();
  });
  $("key-request-forget").addEventListener("click", () => {
    forgetKey();
    closeKeyRequest();
    document.getElementById("message")!.focus();
  });
  $("key-request-close").addEventListener("click", () => {
    closeKeyRequest();
    document.getElementById("message")!.focus();
  });
  // A key does not outlive the page, even when a browser keeps the page to go back to.
  window.addEventListener("pagehide", forgetKey);
  render();
}
