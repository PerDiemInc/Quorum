import {
  KEY_REMOVED,
  MAX_CONTEXT_FILE_CHARS,
  MAX_FILES,
  extractFiles,
  isAccessKey,
  isPreviewable,
  latestFiles,
  slug,
} from "/engine.js";
import type { Attachment, FileBlock, Meeting, Message, ProjectFile } from "/engine.js";
import { askForKey, closeKeyRequest, forgetKey, heldKey, holdKey, onKeyChange, scrub } from "/key.js";

/** What the files dialogs need from the page. */
export interface FilesApp {
  node: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    text?: string,
    cls?: string,
  ) => HTMLElementTagNameMap[Tag];
  button: (text: string, fn: () => void, variant?: string) => HTMLButtonElement;
  checkbox: (input: HTMLInputElement, ...children: Node[]) => HTMLElement;
  chip: (text: string, tone?: string) => HTMLElement;
  /** A live preview of one HTML or SVG file, styled by the files beside it. */
  preview: (files: readonly ProjectFile[], page: ProjectFile) => HTMLElement;
  /** A refused save carries the paths that already exist. */
  request: <T>(path: string, method?: string, data?: object) => Promise<T>;
  /** The open meeting. */
  meeting: () => Meeting | null;
  save: () => void;
}
interface Listing {
  root: string;
  files: Array<{ path: string; size: number }>;
  truncated: boolean;
}
interface Saved {
  folder: string;
  files: Array<{ path: string; size: number; preview: boolean }>;
}
interface GitHubStatus {
  /** Whether Quorum was started with a credential it may push with. */
  available: boolean;
  source: "token" | "cli" | null;
  repos: string[] | null;
}
interface Committed {
  repo: string;
  branch: string;
  url: string;
  number: number;
}

/** The elements in index.html that are used as more than an HTMLElement. */
interface Elements {
  "attach-add": HTMLButtonElement;
  "attach-dialog": HTMLDialogElement;
  "attach-github": HTMLFormElement & {
    readonly elements: HTMLFormControlsCollection & { url: HTMLInputElement };
  };
  "attach-search": HTMLInputElement;
  attach: HTMLButtonElement;
  "commit-dialog": HTMLDialogElement;
  "commit-form": HTMLFormElement & {
    readonly elements: HTMLFormControlsCollection & {
      repo: HTMLInputElement;
      message: HTMLTextAreaElement;
      key: HTMLInputElement;
    };
  };
  "commit-chat": HTMLButtonElement;
  "commit-forget": HTMLButtonElement;
  "commit-link": HTMLAnchorElement;
  "commit-submit": HTMLButtonElement;
  "save-dialog": HTMLDialogElement;
  "save-form": HTMLFormElement & {
    readonly elements: HTMLFormControlsCollection & { folder: HTMLInputElement };
  };
  "save-submit": HTMLButtonElement;
}
const $ = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof Elements ? Elements[Id] : HTMLElement;
const REPOSITORY_KEY = "quorum-repository";
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");
function fileSize(bytes: number) {
  return bytes < 1000 ? bytes + " bytes" : (bytes / 1000).toFixed(1) + " KB";
}
const textSize = (content: string) => fileSize(new TextEncoder().encode(content).length);

/** The files a message proposes, saving and committing them, and attaching files to a meeting. */
export function createFiles(app: FilesApp) {
  const { node, button, checkbox, chip, request, preview } = app;
  const status = (id: string, message = "", failed = false) => {
    $(id).textContent = message;
    $(id).classList.toggle("failed", failed);
  };
  const row = (path: string, detail: string) => {
    const el = node("li");
    el.append(node("span", path), node("small", detail, "muted"));
    return el;
  };
  const link = (text: string, href: string, label: string) => {
    const el = node("a", text, "button button--secondary button--sm");
    el.href = href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.setAttribute("aria-label", label);
    return el;
  };

  // ---- File cards in the transcript ----

  /** Cards that are open, so drawing them again does not close them. */
  const opened = new WeakMap<object, Set<string>>();
  /** @param owner what the cards belong to, a message or a build */
  function card(owner: object, block: FileBlock) {
    const el = node("details", undefined, "file-card"),
      summary = node("summary"),
      content = node("pre"),
      key = (block.problem ?? "") + ":" + block.path;
    summary.append(
      node("strong", block.path || "Unnamed file"),
      node("span", textSize(block.content), "muted small"),
    );
    if (block.problem)
      summary.append(chip(block.problem === "unsafe" ? "Path not allowed" : "Cut off", "warning"));
    content.append(node("code", block.content));
    content.tabIndex = 0;
    content.setAttribute("aria-label", "Contents of " + block.path);
    el.append(summary);
    if (block.problem)
      el.append(
        node(
          "p",
          block.problem === "unsafe"
            ? "This file cannot be saved or committed. Ask for a relative path with a text file type and no hidden folders."
            : "The reply ended before the file did. Ask the agent to send it again.",
          "muted small",
        ),
      );
    el.append(content);
    el.open = Boolean(opened.get(owner)?.has(key));
    el.addEventListener("toggle", () => {
      const open = opened.get(owner) ?? new Set<string>();
      if (el.open) open.add(key);
      else open.delete(key);
      opened.set(owner, open);
    });
    return el;
  }
  /** Save and push buttons for a set of files. Neither changes the meeting. */
  function actions(files: ProjectFile[], whose: string) {
    const save = button("Save to folder", () => openSave(files)),
      push = button("Push to GitHub", () => void openCommit(files), "tertiary"),
      el = node("div", undefined, "actions");
    save.setAttribute("aria-label", "Save to folder: " + whose);
    push.setAttribute("aria-label", "Push to GitHub: " + whose);
    el.append(save, push);
    return el;
  }
  function cards(message: Message, blocks: FileBlock[]) {
    const el = node("div", undefined, "files");
    const files = extractFiles(message.text);
    const pages = files.filter((f) => isPreviewable(f.path));
    if (pages.length) {
      const meeting = app.meeting();
      // The design as it stood at this message, with stylesheets sent before it.
      const then = latestFiles(
        meeting?.transcript.slice(0, meeting.transcript.indexOf(message) + 1) ?? [message],
        meeting?.attachments,
      );
      el.append(...pages.map((page) => preview(then, page)));
    }
    el.append(...blocks.map((block) => card(message, block)));
    if (files.length)
      el.append(actions(files, plural(files.length, "file") + " from " + message.speaker));
    return el;
  }

  // ---- Saving to the workspace folder ----

  let toSave: ProjectFile[] = [];
  /** The folder whose existing files the host has agreed to replace once asked. */
  let replace: string | null = null;
  // Answers that arrive after the dialog moved on are ignored.
  let saveRound = 0;
  function askToReplace(folder: string | null) {
    replace = folder;
    $("save-submit").textContent = folder === null ? "Save files" : "Overwrite files";
    $("save-submit").classList.toggle("button--danger", folder !== null);
    $("save-submit").classList.toggle("button--primary", folder === null);
  }
  function openSave(files: ProjectFile[]) {
    saveRound++;
    toSave = files;
    askToReplace(null);
    $("save-form").elements.folder.value = slug(app.meeting()?.goal ?? "") || "meeting";
    $("save-files").replaceChildren(...files.map((f) => row(f.path, textSize(f.content))));
    $("save-result").replaceChildren();
    status("save-status");
    $("save-submit").disabled = false;
    $("save-dialog").showModal();
    $("save-form").elements.folder.focus();
  }
  $("save-form").elements.folder.addEventListener("input", () => {
    askToReplace(null);
    status("save-status");
  });
  $("save-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const folder = $("save-form").elements.folder.value.trim(),
      round = saveRound;
    $("save-submit").disabled = true;
    $("save-result").replaceChildren();
    status("save-status", "Saving…");
    try {
      const saved = await request<Saved>("/api/workspace/save", "POST", {
        folder,
        files: toSave,
        overwrite: replace === folder,
      });
      if (round !== saveRound) return;
      askToReplace(null);
      status(
        "save-status",
        "Saved " + plural(saved.files.length, "file") + " to " + saved.folder,
      );
      $("save-result").replaceChildren(
        ...saved.files.map((file) => {
          const el = row(file.path, fileSize(file.size));
          if (file.preview)
            el.append(
              link(
                "Preview",
                "/preview/" + file.path.split("/").map(encodeURIComponent).join("/"),
                "Preview " + file.path + " in a new tab",
              ),
            );
          return el;
        }),
      );
    } catch (error) {
      if (round !== saveRound) return;
      const { message, conflicts } = error as Error & { conflicts?: string[] };
      if (conflicts) {
        askToReplace(folder);
        status(
          "save-status",
          "Already in that folder: " + conflicts.join(", ") +
            ". Choose another folder name, or overwrite them.",
          true,
        );
      } else status("save-status", message, true);
    } finally {
      if (round === saveRound) $("save-submit").disabled = false;
    }
  });
  $("save-close").addEventListener("click", () => $("save-dialog").close());

  // ---- Pushing to GitHub ----

  let toCommit: ProjectFile[] = [];
  let commitRound = 0,
    committing = false;
  /** Whether Quorum can push without a key; null until it has said. */
  let ownCredential: boolean | null = null;
  function showKeyState() {
    const held = Boolean(heldKey());
    $("commit-key-state").textContent = held
      ? "This page holds your key for the session. Leave the field empty to use it."
      : "";
    $("commit-forget").hidden = !held;
    $("commit-chat").hidden = held || !app.meeting();
  }
  onKeyChange(showKeyState);
  async function openCommit(files: ProjectFile[]) {
    const round = ++commitRound,
      form = $("commit-form");
    toCommit = files;
    committing = false;
    ownCredential = null;
    // A tag copied into a commit message would notify a GitHub user of that name.
    const goal = (app.meeting()?.goal ?? "").replace(/@/g, "").split("\n")[0].trim();
    let repository = "";
    try {
      repository = localStorage.getItem(REPOSITORY_KEY) ?? "";
    } catch {
      /* The field then starts empty. */
    }
    form.elements.repo.value = app.meeting()?.repository?.repo ?? repository;
    form.elements.message.value = "Add files from Quorum: " + goal.slice(0, 60);
    form.elements.key.value = "";
    showKeyState();
    $("commit-key-optional").textContent = "";
    $("commit-allowed").textContent = "";
    $("commit-files").replaceChildren(...files.map((f) => row(f.path, textSize(f.content))));
    $("commit-link").hidden = true;
    $("commit-submit").disabled = false;
    status("commit-status");
    status("commit-check");
    $("commit-dialog").showModal();
    form.elements.repo.focus();
    try {
      const github = await request<GitHubStatus>("/api/github");
      if (round !== commitRound) return;
      ownCredential = github.available;
      $("commit-key-optional").textContent = github.available ? "(optional)" : "";
      status(
        "commit-check",
        github.available
          ? "Quorum can already push with " +
              (github.source === "cli" ? "your GitHub CLI login" : "the token it was started with") +
              ", so a key is optional."
          : "",
      );
      $("commit-allowed").textContent = github.repos
        ? "Allowed repositories: " + (github.repos.join(", ") || "none")
        : "";
      // The meeting chat asks too, so a key can be posted there.
      if (!github.available && !heldKey()) askForKey("push", () => void openCommit(files));
    } catch (error) {
      if (round === commitRound) status("commit-check", (error as Error).message, true);
    }
  }
  // After a push the button rests until something changes, so one press makes one request.
  $("commit-form").addEventListener("input", () => {
    $("commit-submit").disabled = committing;
  });
  $("commit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { repo, message, key } = $("commit-form").elements,
      round = commitRound;
    // The field is emptied at once, whatever happens next.
    const typed = key.value.trim();
    key.value = "";
    if (typed && !isAccessKey(typed)) {
      forgetKey();
      $("commit-submit").disabled = false;
      status(
        "commit-status",
        "That does not look like a GitHub access key. A fine-grained key starts with github_pat_.",
        true,
      );
      return key.focus();
    }
    if (typed) holdKey(typed);
    if (!heldKey() && ownCredential === false) {
      askForKey("push", () => void openCommit(toCommit));
      status("commit-status", "Enter a GitHub access key to push.", true);
      return key.focus();
    }
    const sent = heldKey();
    committing = true;
    $("commit-submit").disabled = true;
    $("commit-link").hidden = true;
    status("commit-status", "Pushing…");
    try {
      const done = await request<Committed>("/api/github/commit", "POST", {
        repo: repo.value.trim(),
        message: message.value,
        files: toCommit,
        ...(sent ? { key: sent } : {}),
      });
      closeKeyRequest();
      if (round !== commitRound) return;
      committing = false;
      // Stored only once GitHub has accepted it as a repository name.
      try {
        localStorage.setItem(REPOSITORY_KEY, done.repo);
      } catch {
        /* The repository is then typed again next time. */
      }
      status(
        "commit-status",
        "Pushed to the new branch " + done.branch + " in " + done.repo + ".",
      );
      const url = done.url.startsWith("https://github.com/") ? done.url : "";
      $("commit-link").hidden = !url;
      $("commit-link").href = url;
      $("commit-link").textContent = "Open pull request #" + done.number;
    } catch (error) {
      const refused = error as Error & { keyRejected?: boolean };
      const forgotten = Boolean(refused.keyRejected) && heldKey() === sent;
      if (forgotten) {
        forgetKey();
        const files = toCommit;
        askForKey("push", () => void openCommit(files));
      }
      if (round !== commitRound) return;
      committing = false;
      status(
        "commit-status",
        refused.message + (forgotten ? " The key was forgotten." : ""),
        true,
      );
      $("commit-submit").disabled = false;
    }
  });
  $("commit-chat").addEventListener("click", () => {
    const files = toCommit;
    askForKey("push", () => void openCommit(files));
    $("commit-dialog").close();
    document.getElementById("message")!.focus();
  });
  $("commit-forget").addEventListener("click", () => {
    forgetKey();
    $("commit-form").elements.key.value = "";
    $("commit-submit").disabled = committing;
    $("commit-form").elements.key.focus();
    $("commit-key-state").textContent = "Key forgotten.";
  });
  $("commit-close").addEventListener("click", () => $("commit-dialog").close());
  // A key typed but never used does not wait in the closed dialog.
  $("commit-dialog").addEventListener("close", () => ($("commit-form").elements.key.value = ""));

  // ---- Attaching files to a meeting ----

  let workspace: Listing["files"] = [];
  const picked = new Set<string>();
  let attachRound = 0;
  function renderAttachments() {
    const meeting = app.meeting();
    $("attachments").replaceChildren(
      ...(meeting?.attachments ?? []).map((file, index) => {
        const el = node("li", undefined, "attachment"),
          name = node("span", file.path),
          remove = button("×", () => detach(index), "ghost");
        name.title = file.path + " from " + file.source;
        remove.classList.add("button--icon-only", "remove-attachment");
        remove.setAttribute("aria-label", "Remove attached file " + file.path);
        remove.disabled = meeting!.status === "accepted";
        el.append(name, remove);
        return el;
      }),
    );
  }
  function detach(index: number) {
    const meeting = app.meeting();
    if (!meeting || meeting.status === "accepted") return;
    meeting.attachments = (meeting.attachments ?? []).filter((_, i) => i !== index);
    app.save();
    renderAttachments();
    // The button that had focus is gone, so keep the keyboard nearby.
    const left = $("attachments").querySelectorAll("button");
    (left[Math.min(index, left.length - 1)] ?? $("attach")).focus();
  }
  /** Add files to the meeting, replacing earlier copies. Throws when they do not fit. */
  function attach(meeting: Meeting, added: Attachment[]) {
    if (meeting !== app.meeting() || meeting.status === "accepted")
      throw new Error("This meeting can no longer be changed.");
    // A key in a file does not go into the meeting or to its agents.
    const clean = added.map((f) => ({
      ...f,
      content: scrub(f.content),
      source: scrub(f.source),
      // Later versions agents propose were written with this one in front of them.
      after: meeting.transcript.length,
    }));
    const keyed = clean.filter((f) => f.content.includes(KEY_REMOVED)).map((f) => f.path);
    const key = (f: Attachment) => f.source + "\n" + f.path;
    const files = new Map((meeting.attachments ?? []).map((f) => [key(f), f]));
    for (const file of clean) files.set(key(file), file);
    const next = [...files.values()];
    if (next.length > MAX_FILES)
      throw new Error("A meeting can have at most " + MAX_FILES + " attached files.");
    const total = next.reduce((sum, f) => sum + f.content.length, 0);
    if (total > MAX_CONTEXT_FILE_CHARS)
      throw new Error(
        "Attached files can total " + MAX_CONTEXT_FILE_CHARS.toLocaleString() +
          " characters, and these would make " + total.toLocaleString() + ". Remove or choose smaller files.",
      );
    meeting.attachments = next;
    app.save();
    renderAttachments();
    status(
      "attach-status",
      "Attached " + added.map((f) => f.path).join(", ") + "." +
        (keyed.length ? " A GitHub key was removed from " + keyed.join(", ") + "." : ""),
    );
  }
  function renderWorkspace() {
    const query = $("attach-search").value.trim().toLowerCase();
    const shown = workspace.filter((f) => f.path.toLowerCase().includes(query));
    $("attach-list").replaceChildren(
      ...shown.map((file) => {
        const input = node("input"),
          text = node("span", undefined, "info");
        input.value = file.path;
        input.checked = picked.has(file.path);
        input.addEventListener("change", () => {
          if (input.checked) picked.add(file.path);
          else picked.delete(file.path);
          $("attach-add").disabled = !picked.size;
        });
        text.append(node("strong", file.path), node("small", fileSize(file.size)));
        return checkbox(input, text);
      }),
    );
    if (!shown.length)
      $("attach-list").append(
        node(
          "p",
          workspace.length
            ? "No files match your search."
            : "No text files there yet. Save a proposed file, or copy files into the folder.",
          "muted",
        ),
      );
    $("attach-add").disabled = !picked.size;
  }
  $("attach").addEventListener("click", async () => {
    const meeting = app.meeting();
    if (!meeting || meeting.status === "accepted") return;
    const round = ++attachRound;
    workspace = [];
    picked.clear();
    $("attach-search").value = "";
    $("attach-github").elements.url.value = "";
    $("attach-root").textContent = "";
    $("attach-list").replaceChildren(node("p", "Looking in the workspace folder…", "muted"));
    $("attach-add").disabled = true;
    status("attach-status");
    $("attach-dialog").showModal();
    $("attach-search").focus();
    try {
      const listing = await request<Listing>("/api/workspace");
      if (round !== attachRound) return;
      workspace = listing.files;
      $("attach-root").textContent =
        "From " + listing.root + (listing.truncated ? ". The list is shortened." : "");
      renderWorkspace();
    } catch (error) {
      if (round !== attachRound) return;
      renderWorkspace();
      status("attach-status", (error as Error).message, true);
    }
  });
  $("attach-search").addEventListener("input", renderWorkspace);
  $("attach-add").addEventListener("click", async () => {
    const meeting = app.meeting(),
      round = attachRound;
    if (!meeting) return;
    $("attach-add").disabled = true;
    status("attach-status", "Reading…");
    try {
      const { files } = await request<{ files: ProjectFile[] }>("/api/workspace/read", "POST", {
        paths: [...picked],
      });
      if (round !== attachRound) return;
      attach(meeting, files.map((f) => ({ ...f, source: "workspace" })));
      picked.clear();
      renderWorkspace();
    } catch (error) {
      if (round !== attachRound) return;
      status("attach-status", (error as Error).message, true);
      $("attach-add").disabled = !picked.size;
    }
  });
  $("attach-github").addEventListener("submit", async (e) => {
    e.preventDefault();
    const meeting = app.meeting(),
      round = attachRound,
      url = $("attach-github").elements.url.value.trim(),
      submit = $("attach-github").querySelector("button")!;
    if (!meeting) return;
    if (!url) {
      status("attach-status", "Paste the address of a file on GitHub first.", true);
      return;
    }
    submit.disabled = true;
    status("attach-status", "Fetching from GitHub…");
    try {
      const { file } = await request<{ file: Attachment }>("/api/github/file", "POST", { url });
      if (round !== attachRound) return;
      attach(meeting, [file]);
      $("attach-github").elements.url.value = "";
    } catch (error) {
      if (round === attachRound) status("attach-status", (error as Error).message, true);
    } finally {
      submit.disabled = false;
    }
  });
  $("attach-close").addEventListener("click", () => $("attach-dialog").close());

  return { cards, card, actions, attach, renderAttachments };
}
