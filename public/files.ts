import { MAX_CONTEXT_FILE_CHARS, MAX_FILES, extractFiles, slug } from "/engine.js";
import type { Attachment, FileBlock, Meeting, Message, ProjectFile } from "/engine.js";

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
  available: boolean;
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
    };
  };
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
  const { node, button, checkbox, chip, request } = app;
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

  /** Cards that are open, so a new message does not close them. */
  const opened = new WeakMap<Message, Set<string>>();
  function card(message: Message, block: FileBlock) {
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
    el.open = Boolean(opened.get(message)?.has(key));
    el.addEventListener("toggle", () => {
      const open = opened.get(message) ?? new Set<string>();
      if (el.open) open.add(key);
      else open.delete(key);
      opened.set(message, open);
    });
    return el;
  }
  function cards(message: Message, blocks: FileBlock[]) {
    const el = node("div", undefined, "files");
    el.append(...blocks.map((block) => card(message, block)));
    const files = extractFiles(message.text);
    if (files.length) {
      // Saving changes nothing in the meeting, so an accepted one allows it too.
      const save = button("Save to folder", () => openSave(files)),
        commit = button("Commit to GitHub", () => void openCommit(files), "tertiary"),
        actions = node("div", undefined, "actions");
      const whose = " " + plural(files.length, "file") + " from " + message.speaker;
      save.setAttribute("aria-label", "Save to folder:" + whose);
      commit.setAttribute("aria-label", "Commit to GitHub:" + whose);
      actions.append(save, commit);
      el.append(actions);
    }
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

  // ---- Committing to GitHub ----

  let toCommit: ProjectFile[] = [];
  let commitRound = 0,
    committing = false;
  async function openCommit(files: ProjectFile[]) {
    const round = ++commitRound,
      form = $("commit-form");
    toCommit = files;
    committing = false;
    // A tag copied into a commit message would notify a GitHub user of that name.
    const goal = (app.meeting()?.goal ?? "").replace(/@/g, "").split("\n")[0].trim();
    let repository = "";
    try {
      repository = localStorage.getItem(REPOSITORY_KEY) ?? "";
    } catch {
      /* The field then starts empty. */
    }
    form.elements.repo.value = repository;
    form.elements.message.value = "Add files from Quorum: " + goal.slice(0, 60);
    form.hidden = true;
    $("commit-setup").hidden = true;
    $("commit-files").replaceChildren(...files.map((f) => row(f.path, textSize(f.content))));
    $("commit-link").hidden = true;
    $("commit-submit").disabled = false;
    status("commit-status");
    status("commit-check", "Checking GitHub access…");
    $("commit-dialog").showModal();
    try {
      const github = await request<GitHubStatus>("/api/github");
      if (round !== commitRound) return;
      status("commit-check");
      form.hidden = !github.available;
      $("commit-setup").hidden = github.available;
      $("commit-allowed").textContent = github.repos
        ? "Allowed repositories: " + (github.repos.join(", ") || "none")
        : "";
      if (github.available) form.elements.repo.focus();
    } catch (error) {
      if (round === commitRound) status("commit-check", (error as Error).message, true);
    }
  }
  // After a commit the button rests until something changes, so one press makes one request.
  $("commit-form").addEventListener("input", () => {
    $("commit-submit").disabled = committing;
  });
  $("commit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { repo, message } = $("commit-form").elements,
      round = commitRound;
    committing = true;
    $("commit-submit").disabled = true;
    $("commit-link").hidden = true;
    status("commit-status", "Committing…");
    try {
      localStorage.setItem(REPOSITORY_KEY, repo.value.trim());
    } catch {
      /* The repository is then typed again next time. */
    }
    try {
      const done = await request<Committed>("/api/github/commit", "POST", {
        repo: repo.value.trim(),
        message: message.value,
        files: toCommit,
      });
      if (round !== commitRound) return;
      committing = false;
      status(
        "commit-status",
        "Committed to the new branch " + done.branch + " in " + done.repo + ".",
      );
      const url = done.url.startsWith("https://github.com/") ? done.url : "";
      $("commit-link").hidden = !url;
      $("commit-link").href = url;
      $("commit-link").textContent = "Open pull request #" + done.number;
    } catch (error) {
      if (round !== commitRound) return;
      committing = false;
      status("commit-status", (error as Error).message, true);
      $("commit-submit").disabled = false;
    }
  });
  $("commit-close").addEventListener("click", () => $("commit-dialog").close());

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
    const key = (f: Attachment) => f.source + "\n" + f.path;
    const files = new Map((meeting.attachments ?? []).map((f) => [key(f), f]));
    for (const file of added) files.set(key(file), file);
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
    status("attach-status", "Attached " + added.map((f) => f.path).join(", ") + ".");
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

  return { cards, renderAttachments };
}
