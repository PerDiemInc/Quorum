import {
  attachedFrom,
  compatibleFiles,
  directBranch,
  isAccessKey,
  MAX_FILE_BYTES,
  MAX_FILES,
  pendingFiles,
  proposedVersions,
  rememberWritten,
  writtenAt,
} from "/engine.js";
import type {
  Attachment,
  CommitResult,
  HeldFile,
  Meeting,
  PendingFile,
  Repository,
} from "/engine.js";
import { askForKey, closeKeyRequest, forgetKey, heldKey, holdKey, onKeyChange } from "/key.js";

/** What the repository panel needs from the page. */
export interface RepositoryApp {
  node: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    text?: string,
    cls?: string,
  ) => HTMLElementTagNameMap[Tag];
  button: (text: string, fn: () => void, variant?: string) => HTMLButtonElement;
  checkbox: (input: HTMLInputElement, ...children: Node[]) => HTMLElement;
  request: <T>(path: string, method?: string, data?: object) => Promise<T>;
  /** The open meeting. */
  meeting: () => Meeting | null;
  find: (id: string) => Meeting | undefined;
  save: () => void;
  /** Put a note of Quorum's in a meeting's conversation. */
  note: (meeting: Meeting, text: string, links: Array<{ label: string; url: string }>) => void;
  attach: (meeting: Meeting, files: Attachment[]) => void;
  /** Start a message to the room for the host to finish or send. */
  draft: (text: string) => void;
}
interface Listing {
  repo: string;
  ref: string;
  files: Array<{ path: string; size: number }>;
  truncated: boolean;
}
interface Elements {
  "connect-destination-direct": HTMLInputElement;
  "connect-destination-pull": HTMLInputElement;
  "connect-dialog": HTMLDialogElement;
  "connect-form": HTMLFormElement & {
    readonly elements: HTMLFormControlsCollection & {
      repo: HTMLInputElement;
      key: HTMLInputElement;
      auto: HTMLInputElement;
    };
  };
  "connect-submit": HTMLButtonElement;
  "direct-cancel": HTMLButtonElement;
  "direct-confirm": HTMLButtonElement;
  "direct-dialog": HTMLDialogElement;
  "repo-add": HTMLButtonElement;
  "repo-attach": HTMLButtonElement;
  "repo-auto": HTMLInputElement;
  "repo-commit": HTMLButtonElement;
  "repo-destination-direct": HTMLInputElement;
  "repo-destination-pull": HTMLInputElement;
  "repo-dialog": HTMLDialogElement;
  "repo-pull": HTMLAnchorElement;
  "repo-search": HTMLInputElement;
}
const $ = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof Elements ? Elements[Id] : HTMLElement;
// The same entry the push window remembers the repository under.
const REPOSITORY_KEY = "quorum-repository";
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");
const onGitHub = (url: string) => url.startsWith("https://github.com/");

/** The id git gives these contents. */
async function blobId(content: string) {
  const bytes = new TextEncoder().encode(content);
  const head = new TextEncoder().encode("blob " + bytes.length + "\0");
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A meeting's connection to a GitHub repository. While it is connected and automatic,
 * agents' files are committed as they are proposed, one commit at a time, to a branch of
 * the meeting's own. The access key comes from /key.js and is never saved.
 */
export function createRepository(app: RepositoryApp) {
  const { node, button, checkbox, request } = app;
  const status = (id: string, message = "", failed = false) => {
    $(id).textContent = message;
    $(id).classList.toggle("failed", failed);
  };
  /** Whether Quorum was started with a credential of its own, so no key is needed. */
  let ownCredential = false;
  const canCommit = () => Boolean(heldKey()) || ownCredential;
  const key = () => (heldKey() ? { key: heldKey() } : {});
  async function checkCredential() {
    ownCredential = await request<{ available: boolean }>("/api/github").then(
      (github) => github.available,
      () => false,
    );
  }
  /** Meetings being committed, and why the last attempt for one failed. */
  const busy = new Set<string>();
  const failures = new Map<string, string>();
  /** Meetings whose last direct commit was refused, which are offered a pull request. */
  const refusedDirect = new Set<string>();
  /** Meetings that have been offered a connection since the page loaded. */
  const offered = new Set<string>();

  /** Forget a rejected key and ask for another. */
  function refused(error: unknown, purpose: "connect" | "commit", resume: () => void) {
    if ((error as { keyRejected?: boolean }).keyRejected) {
      forgetKey();
      askForKey(purpose, resume);
      return (error as Error).message + " The key was forgotten.";
    }
    return (error as Error).message;
  }

  // ---- Committing ----

  // One commit at a time, so two turns can never race.
  let queue: Promise<unknown> = Promise.resolve();
  /** Which commit to make. */
  interface Job {
    /** The last message to take files from. */
    upTo?: number;
    /** A held file the host said to replace. */
    approved?: HeldFile;
    /** Set when no button asked for it, so the switch decides. */
    automatic?: boolean;
  }
  /** Commit what a meeting has waiting, after anything already under way. */
  function commit(id: string, job: Job = {}) {
    queue = queue.then(() => commitWaiting(id, job)).catch(() => {});
  }
  async function commitWaiting(id: string, { upTo, approved, automatic }: Job) {
    // Each round commits at most one request's worth of files.
    for (let round = 0; round < 10; round++) {
      const meeting = app.find(id),
        repository = meeting?.repository;
      if (!meeting || !repository?.connected || (automatic && !repository.auto)) return;
      const waiting = approved
        ? proposedVersions(meeting, approved.at).filter(
            (f) => f.path === approved.path && f.at === approved.at,
          )
        : pendingFiles(meeting, upTo);
      if (!waiting.length) return;
      // Straight to the default branch takes a key entered here, whatever else Quorum has.
      if (!canCommit() || (directBranch(repository) && !heldKey())) {
        askForKey("commit", () => commit(id));
        render();
        return;
      }
      const large = waiting.filter(
        (f) => new TextEncoder().encode(f.content).length > MAX_FILE_BYTES,
      );
      for (const file of large)
        hold(repository, {
          path: file.path,
          at: file.at,
          reason: "size",
          why: "it is larger than " + MAX_FILE_BYTES / 1000 + " KB",
        });
      const batch = compatibleFiles(waiting.filter((f) => !large.includes(f)));
      if (!batch.length) {
        app.save();
        render();
        continue;
      }
      busy.add(id);
      refusedDirect.delete(id);
      render();
      const direct = directBranch(repository);
      try {
        const files = await Promise.all(
          batch.map(async (file) => ({
            path: file.path,
            content: file.content,
            // What the repository may hold now for this file to take its place.
            seen: [
              ...writtenAt(repository, file.path),
              approved?.current,
              ...(await Promise.all(attachedFrom(meeting, repository.repo, file).map(blobId))),
            ].filter(Boolean),
          })),
        );
        const result = await request<CommitResult>("/api/github/auto-commit", "POST", {
          repo: repository.repo,
          meeting: { id: meeting.id, goal: meeting.goal },
          ...(direct ? { direct: true, confirmedBranch: direct } : { branch: repository.branch }),
          files,
          agents: [...new Set(batch.map((f) => f.agent))],
          ...key(),
        });
        failures.delete(id);
        const now = app.find(id);
        if (now?.repository?.repo !== repository.repo) return;
        record(now, now.repository, batch, result);
      } catch (error) {
        if ((error as { directRefused?: boolean }).directRefused) refusedDirect.add(id);
        failures.set(id, "Not committed. " + refused(error, "commit", () => commit(id)));
        return;
      } finally {
        busy.delete(id);
        render();
      }
      if (approved) return;
    }
  }
  function hold(repository: Repository, file: HeldFile) {
    repository.held = [...(repository.held ?? []).filter((h) => h.path !== file.path), file];
  }
  /** Keep what a commit did, and say it in the conversation. */
  function record(meeting: Meeting, repository: Repository, batch: PendingFile[], result: CommitResult) {
    const version = (path: string) => batch.find((f) => f.path === path)!.at;
    // Whatever is on the branch, written now or already there, has been dealt with.
    for (const { path, sha } of [...result.written, ...result.unchanged]) {
      repository.done[path] = version(path);
      rememberWritten(repository, path, result.branch ?? result.compared, sha);
      repository.held = repository.held?.filter((h) => h.path !== path);
    }
    for (const held of result.held)
      hold(repository, { ...held, at: version(held.path), compared: result.compared });
    // The meeting's own branch and pull request are kept apart from direct commits.
    if (result.branch && !result.direct) repository.branch = result.branch;
    if (result.commit && result.direct)
      app.note(
        meeting,
        "Committed straight to " + result.branch + " of " + result.repo +
          ", with no pull request: " + result.written.map((f) => f.path).join(", ") + ".",
        [{ label: "Commit " + result.commit.sha.slice(0, 7), url: result.commit.url }],
      );
    else if (result.commit) {
      repository.pull = result.pull;
      const started =
        result.started === "deleted"
          ? " The earlier branch was deleted, so this is a new one."
          : result.started === "merged" || result.started === "closed"
            ? " The earlier pull request was " + result.started +
              ", so this is a new branch. Files committed before are not repeated on it."
            : "";
      app.note(
        meeting,
        "Committed " + result.written.map((f) => f.path).join(", ") + " to " + result.branch +
          " in " + result.repo + "." + started + (result.warning ? " " + result.warning : ""),
        [
          { label: "Commit " + result.commit.sha.slice(0, 7), url: result.commit.url },
          ...(result.pull ? [{ label: "Pull request #" + result.pull.number, url: result.pull.url }] : []),
        ],
      );
    }
    if (result.held.length)
      app.note(
        meeting,
        "Not committed to " + result.repo + ": " +
          result.held.map((f) => f.path + ", because " + f.why).join("; ") + ".",
        [],
      );
    app.save();
  }

  // ---- The panel ----

  /** What the list of held files was drawn from, so it keeps focus between updates. */
  let drawn = "";
  function renderHeld(meeting: Meeting) {
    const held = meeting.repository?.connected ? (meeting.repository.held ?? []) : [];
    const accepted = meeting.status === "accepted";
    const signature = JSON.stringify([meeting.id, accepted, held]);
    if (signature === drawn) return;
    drawn = signature;
    $("repo-held").replaceChildren(
      ...held.map((file) => {
        const item = node("li"),
          actions = node("div", undefined, "actions");
        item.append(node("span", file.path + " was held back: " + file.why + ".", "small"), actions);
        const setAside = () => {
          const repository = app.find(meeting.id)?.repository;
          if (!repository) return;
          repository.held = repository.held?.filter((h) => h.path !== file.path);
          repository.done[file.path] = file.at;
          app.save();
          render();
        };
        if (file.reason === "exists") {
          if (!accepted) {
            const attach = button("Attach current version", () => void attachCurrent(meeting.id, file, setAside));
            attach.setAttribute("aria-label", "Attach the current version of " + file.path);
            actions.append(attach);
          }
          const replace = button(
            "Replace it",
            () => commit(meeting.id, { approved: file }),
            "danger-soft",
          );
          replace.setAttribute("aria-label", "Replace " + file.path + " in the repository");
          actions.append(replace);
        }
        const dismiss = button("Leave it", setAside, "ghost");
        dismiss.setAttribute("aria-label", "Leave " + file.path + " uncommitted");
        actions.append(dismiss);
        return item;
      }),
    );
  }
  /** Give the room the repository's version of a held file, so the change can be redone. */
  async function attachCurrent(id: string, file: HeldFile, setAside: () => void) {
    const meeting = app.find(id),
      repository = meeting?.repository;
    if (!meeting || !repository) return;
    if (!canCommit()) return askForKey("commit", () => commit(id));
    const author = meeting.transcript[file.at]?.speaker;
    try {
      const { files } = await request<{ files: Attachment[] }>("/api/github/read", "POST", {
        repo: repository.repo,
        branch: file.compared,
        paths: [file.path],
        ...key(),
      });
      app.attach(meeting, files);
      setAside();
      app.draft(
        (author ? "@" + author + " " : "") + "I attached the current version of " + file.path +
          " from the repository. Please make your change again on top of it.",
      );
    } catch (error) {
      failures.set(id, "Not attached. " + refused(error, "commit", () => commit(id)));
      render();
    }
  }
  function render() {
    const meeting = app.meeting();
    if (!meeting) return;
    const repository = meeting.repository,
      connected = Boolean(repository?.connected);
    const waiting = connected ? pendingFiles(meeting).length : 0;
    const failure = failures.get(meeting.id) ?? "";
    const direct = directBranch(repository);
    // Shown for as long as commits go straight to the default branch.
    $("direct-banner").hidden = !direct;
    $("direct-banner-text").textContent = direct
      ? "Direct mode: agents' code is committed straight to " + direct + " of " + repository!.repo +
        ", with no pull request" + (repository!.auto ? "." : ", when you press Commit.")
      : "";
    $("repo-destination").hidden = !connected;
    $("repo-destination-direct").checked = Boolean(direct);
    $("repo-destination-pull").checked = !direct;
    $("repo-direct-label").textContent = direct
      ? "Directly to " + direct
      : "Directly to the default branch";
    $("repo-use-pull").hidden = !direct || !refusedDirect.has(meeting.id);
    $("repo-summary").textContent = connected
      ? "GitHub: " + repository!.repo +
        (direct
          ? " · straight to " + direct
          : repository!.branch
            ? " · " + repository!.branch
            : " · no branch yet")
      : proposedVersions(meeting).length
        ? "Agents have proposed code. Connect a GitHub repository to have it committed as they write."
        : "No GitHub repository is connected.";
    const pull = connected && !direct ? repository!.pull : undefined;
    $("repo-pull").hidden = !pull || !onGitHub(pull.url);
    if (pull && onGitHub(pull.url)) {
      $("repo-pull").href = pull.url;
      $("repo-pull").textContent = "Pull request #" + pull.number;
    }
    $("repo-auto-switch").hidden = !connected;
    $("repo-auto").checked = Boolean(repository?.auto);
    $("repo-auto-switch").dataset.selected = String($("repo-auto").checked);
    $("repo-connect").hidden = connected;
    $("repo-disconnect").hidden = !connected;
    $("repo-attach").hidden = !connected || meeting.status === "accepted";
    $("repo-commit").hidden = !connected || !waiting || busy.has(meeting.id);
    $("repo-commit").textContent = failure ? "Retry" : "Commit " + plural(waiting, "file") + " now";
    status(
      "repo-status",
      !connected
        ? ""
        : busy.has(meeting.id)
          ? "Committing…"
          : failure
            ? failure
            : !canCommit()
              ? "Enter the access key again to commit" +
                (waiting ? "; " + plural(waiting, "file") + " waiting." : ".")
              : waiting
                ? plural(waiting, "file") + " not committed yet."
                : "",
      Boolean(failure),
    );
    renderHeld(meeting);
  }
  onKeyChange(render);

  $("repo-auto").addEventListener("change", () => {
    const meeting = app.meeting();
    if (!meeting?.repository) return;
    meeting.repository.auto = $("repo-auto").checked;
    app.save();
    // Switching it on asks for what is waiting to be committed too.
    if (meeting.repository.auto) commit(meeting.id, { automatic: true });
    render();
  });
  $("repo-commit").addEventListener("click", () => {
    const meeting = app.meeting();
    if (!meeting) return;
    failures.delete(meeting.id);
    commit(meeting.id);
    render();
  });
  $("repo-disconnect").addEventListener("click", () => {
    const meeting = app.meeting();
    if (!meeting?.repository) return;
    meeting.repository.connected = false;
    meeting.repository.auto = false;
    delete meeting.repository.direct;
    failures.delete(meeting.id);
    refusedDirect.delete(meeting.id);
    closeKeyRequest();
    app.note(meeting, "Disconnected from " + meeting.repository.repo + ". Nothing more will be committed.", []);
    app.save();
    render();
    $("repo-connect").focus();
  });

  // ---- Straight to the default branch ----

  /** The host's second, explicit yes. Only the button in this window gives it. */
  function confirmDirect(repo: string, branch: string, waiting: number) {
    return new Promise<boolean>((resolve) => {
      const dialog = $("direct-dialog");
      $("direct-target").textContent = "Repository " + repo + ", branch " + branch + ".";
      $("direct-waiting").textContent = waiting
        ? "Confirming commits " + plural(waiting, "waiting file") + " to it at once."
        : "";
      $("direct-confirm").textContent = "Commit straight to " + branch;
      dialog.returnValue = "";
      $("direct-confirm").onclick = () => dialog.close("confirmed");
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirmed"), {
        once: true,
      });
      dialog.showModal();
      // The safe choice has the focus.
      $("direct-cancel").focus();
    });
  }
  $("direct-cancel").addEventListener("click", () => $("direct-dialog").close());
  $("direct-close").addEventListener("click", () => $("direct-dialog").close());
  async function chooseDirect(id: string) {
    const meeting = app.find(id),
      repository = meeting?.repository;
    // Nothing changes until the host confirms.
    render();
    if (!meeting || !repository?.connected) return;
    if (!heldKey()) return askForKey("commit", () => void chooseDirect(id));
    try {
      // Asked now, so the host confirms the branch that is the default today.
      const { ref } = await request<Listing>("/api/github/tree", "POST", {
        repo: repository.repo,
        ...key(),
      });
      const waiting = repository.auto ? pendingFiles(meeting).length : 0;
      if (app.meeting()?.id !== id || !(await confirmDirect(repository.repo, ref, waiting))) return;
      const now = app.find(id);
      if (!now?.repository?.connected || now.repository.repo !== repository.repo) return;
      now.repository.direct = { repo: repository.repo, branch: ref };
      failures.delete(id);
      app.note(
        now,
        "You turned on direct commits: agents' code now goes straight to " + ref + " of " +
          repository.repo + ", with no pull request. Files committed earlier are not repeated there.",
        [],
      );
      app.save();
      if (now.repository.auto) commit(id, { automatic: true });
    } catch (error) {
      failures.set(id, "Direct commits were not turned on. " + refused(error, "commit", () => commit(id)));
    } finally {
      render();
    }
  }
  /** Back to a branch with a pull request, which never needs confirming. */
  function usePullRequest() {
    const meeting = app.meeting();
    if (!meeting?.repository?.direct) return false;
    delete meeting.repository.direct;
    failures.delete(meeting.id);
    refusedDirect.delete(meeting.id);
    app.note(meeting, "Commits now go to a branch with a pull request.", []);
    app.save();
    render();
    return true;
  }
  $("repo-destination-direct").addEventListener("change", () => {
    const meeting = app.meeting();
    if (meeting) void chooseDirect(meeting.id);
  });
  $("repo-destination-pull").addEventListener("change", () => void usePullRequest());
  $("direct-banner-pull").addEventListener("click", () => {
    if (usePullRequest()) $("repo-destination-pull").focus();
  });
  $("repo-use-pull").addEventListener("click", () => {
    const meeting = app.meeting();
    // The host asked for this commit to go the other way.
    if (meeting && usePullRequest()) commit(meeting.id);
  });

  // ---- Connecting ----

  /** The meeting the connect window is for. */
  let connecting = "";
  let connectRound = 0;
  function describeConnect() {
    const meeting = app.find(connecting);
    if (!meeting) return;
    const count = proposedVersions(meeting).length;
    $("connect-now").textContent = !$("connect-form").elements.auto.checked
      ? "Nothing is committed until you switch automatic commits on or press Commit."
      : count
        ? "Connecting commits the " + plural(count, "file") + " proposed so far."
        : "The first commit happens when an agent proposes a file.";
    $("connect-key-optional").textContent = canCommit() ? "(optional)" : "";
  }
  async function openConnect(id: string) {
    const meeting = app.find(id);
    if (!meeting || meeting !== app.meeting()) return;
    connecting = id;
    const round = ++connectRound,
      form = $("connect-form");
    let remembered = "";
    try {
      remembered = localStorage.getItem(REPOSITORY_KEY) ?? "";
    } catch {
      /* The field then starts empty. */
    }
    form.elements.repo.value = meeting.repository?.repo ?? remembered;
    form.elements.key.value = "";
    form.elements.auto.checked = true;
    form.elements.auto.dispatchEvent(new Event("change", { bubbles: true }));
    // Every connection starts on the pull request, whatever was chosen before.
    $("connect-destination-pull").checked = true;
    status("connect-status");
    $("connect-submit").disabled = false;
    describeConnect();
    $("connect-dialog").showModal();
    form.elements.repo.focus();
    await checkCredential();
    if (round !== connectRound) return;
    describeConnect();
    if (!canCommit()) askForKey("connect", () => void openConnect(id));
  }
  $("repo-connect").addEventListener("click", () => {
    const meeting = app.meeting();
    if (meeting) void openConnect(meeting.id);
  });
  $("connect-form").elements.auto.addEventListener("change", describeConnect);
  $("connect-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { repo, key: field, auto } = $("connect-form").elements,
      round = connectRound,
      id = connecting;
    const typed = field.value.trim();
    field.value = "";
    const name = repo.value.trim();
    if (!REPOSITORY_NAME.test(name)) {
      status("connect-status", "Enter the repository as owner/name.", true);
      return repo.focus();
    }
    if (typed && !isAccessKey(typed)) {
      status("connect-status", "That does not look like a GitHub access key.", true);
      return field.focus();
    }
    if (typed) holdKey(typed);
    if (!canCommit()) {
      status("connect-status", "Enter a GitHub access key.", true);
      return field.focus();
    }
    if ($("connect-destination-direct").checked && !heldKey()) {
      status("connect-status", "Enter an access key: committing straight to the default branch needs one.", true);
      return field.focus();
    }
    $("connect-submit").disabled = true;
    status("connect-status", "Checking the repository…");
    try {
      // Reading the file list shows that the repository is allowed and the key can see it.
      const { ref } = await request<Listing>("/api/github/tree", "POST", { repo: name, ...key() });
      if (round !== connectRound) return;
      const direct = $("connect-destination-direct").checked;
      // What connecting would commit at once: everything not already dealt with there.
      const asked = app.find(id);
      const earlierSame = asked?.repository?.repo.toLowerCase() === name.toLowerCase();
      const waiting = !asked || !auto.checked
        ? 0
        : pendingFiles(earlierSame ? asked : { transcript: asked.transcript }).length;
      if (direct && !(await confirmDirect(name, ref, waiting))) {
        status("connect-status", "Direct commits were not confirmed, so nothing was connected.", true);
        $("connect-submit").disabled = false;
        return;
      }
      const meeting = app.find(id);
      if (round !== connectRound || !meeting) return;
      const earlier =
        meeting.repository?.repo.toLowerCase() === name.toLowerCase() ? meeting.repository : undefined;
      meeting.repository = {
        ...(earlier ?? { written: {}, done: {} }),
        repo: name,
        connected: true,
        auto: auto.checked,
        held: [],
        // Never carried over from an earlier connection.
        direct: direct ? { repo: name, branch: ref } : undefined,
      };
      refusedDirect.delete(id);
      try {
        localStorage.setItem(REPOSITORY_KEY, name);
      } catch {
        /* The repository is then typed again next time. */
      }
      failures.delete(id);
      closeKeyRequest();
      $("connect-dialog").close();
      app.note(
        meeting,
        "Connected to " + name + ". " +
          (direct
            ? "You turned on direct commits: agents' code goes straight to " + ref +
              ", with no pull request" + (auto.checked ? "." : ", when you press Commit.")
            : auto.checked
              ? "Agents' code is now committed automatically to a branch for this meeting."
              : "Automatic commits are off."),
        [],
      );
      app.save();
      if (auto.checked) commit(id, { automatic: true });
      render();
    } catch (error) {
      const message = refused(error, "connect", () => void openConnect(id));
      if (round !== connectRound) return;
      status("connect-status", message, true);
      $("connect-submit").disabled = false;
    }
  });
  $("connect-close").addEventListener("click", () => $("connect-dialog").close());
  $("connect-dialog").addEventListener("close", () => ($("connect-form").elements.key.value = ""));

  // ---- Attaching files from the repository ----

  let listing: Listing | null = null;
  const picked = new Set<string>();
  let pickRound = 0;
  function renderList() {
    const query = $("repo-search").value.trim().toLowerCase();
    const shown = (listing?.files ?? []).filter((f) => f.path.toLowerCase().includes(query));
    $("repo-list").replaceChildren(
      ...shown.map((file) => {
        const input = node("input"),
          text = node("span", undefined, "info");
        input.value = file.path;
        input.checked = picked.has(file.path);
        input.addEventListener("change", () => {
          if (input.checked) picked.add(file.path);
          else picked.delete(file.path);
          $("repo-add").disabled = !picked.size || picked.size > MAX_FILES;
        });
        text.append(node("strong", file.path), node("small", (file.size / 1000).toFixed(1) + " KB"));
        return checkbox(input, text);
      }),
    );
    if (listing && !shown.length)
      $("repo-list").append(
        node("p", listing.files.length ? "No files match your search." : "No text files found.", "muted"),
      );
    $("repo-add").disabled = !picked.size || picked.size > MAX_FILES;
  }
  async function openPicker(id: string) {
    const meeting = app.find(id),
      repository = meeting?.repository;
    if (!meeting || meeting !== app.meeting() || !repository?.connected) return;
    const round = ++pickRound;
    listing = null;
    picked.clear();
    $("repo-search").value = "";
    $("repo-source").textContent = "";
    $("repo-list").replaceChildren(node("p", "Reading the repository…", "muted"));
    $("repo-add").disabled = true;
    status("repo-dialog-status");
    $("repo-dialog").showModal();
    $("repo-search").focus();
    $("repo-add").onclick = async () => {
      $("repo-add").disabled = true;
      status("repo-dialog-status", "Reading…");
      try {
        const { files } = await request<{ files: Attachment[] }>("/api/github/read", "POST", {
          repo: repository.repo,
          branch: directBranch(repository) ? undefined : repository.branch,
          paths: [...picked],
          ...key(),
        });
        if (round !== pickRound) return;
        app.attach(meeting, files);
        status("repo-dialog-status", "Attached " + files.map((f) => f.path).join(", ") + ".");
        picked.clear();
        renderList();
      } catch (error) {
        const message = refused(error, "commit", () => commit(id));
        if (round !== pickRound) return;
        status("repo-dialog-status", message, true);
        $("repo-add").disabled = !picked.size;
      }
    };
    try {
      await checkCredential();
      // Straight to the default branch takes a key entered here, whatever else Quorum has.
      if (!canCommit() || (directBranch(repository) && !heldKey())) {
        askForKey("commit", () => commit(id));
        throw new Error("Paste the access key into the message box first, then open this again.");
      }
      const found = await request<Listing>("/api/github/tree", "POST", {
        repo: repository.repo,
        branch: directBranch(repository) ? undefined : repository.branch,
        ...key(),
      });
      if (round !== pickRound) return;
      listing = found;
      $("repo-source").textContent =
        found.repo + " at " + found.ref + (found.truncated ? ". The list is shortened." : "");
      renderList();
    } catch (error) {
      const message = refused(error, "commit", () => commit(id));
      if (round !== pickRound) return;
      renderList();
      status("repo-dialog-status", message, true);
    }
  }
  $("repo-attach").addEventListener("click", () => {
    const meeting = app.meeting();
    if (meeting) void openPicker(meeting.id);
  });
  $("repo-search").addEventListener("input", renderList);
  $("repo-dialog-close").addEventListener("click", () => $("repo-dialog").close());

  return {
    render,
    /** Called when a meeting is opened, which includes the first time after a reload. */
    async opened(meeting: Meeting) {
      if (!meeting.repository?.connected) return;
      await checkCredential();
      if (app.meeting() !== meeting) return;
      if (!canCommit()) askForKey("commit", () => commit(meeting.id));
      render();
    },
    /** Called after each agent's reply. */
    async afterTurn(meeting: Meeting) {
      const at = meeting.transcript.length - 1;
      if (!proposedVersions(meeting, at).some((f) => f.at === at)) return;
      if (meeting.repository?.connected) {
        commit(meeting.id, { upTo: at, automatic: true });
      } else if (!offered.has(meeting.id)) {
        offered.add(meeting.id);
        await checkCredential();
        if (app.meeting() === meeting && !canCommit())
          askForKey("connect", () => void openConnect(meeting.id));
      }
      render();
    },
  };
}
