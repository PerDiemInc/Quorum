import {
  compatibleFiles,
  handoffContext,
  isPreviewable,
  latestFiles,
  normalizeAgent,
  planBuild,
  promptWriter,
  slug,
  stageNames,
} from "/engine.js";
import type { Agent, Build, BuildKind, FileBlock, Meeting, ProjectFile } from "/engine.js";

/** What the "What next?" card needs from the page. */
export interface NextApp {
  node: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    text?: string,
    cls?: string,
  ) => HTMLElementTagNameMap[Tag];
  /** A model request, retried while another turn is finishing. */
  ask: <T>(path: string, data: object, signal: AbortSignal) => Promise<T>;
  /** The open meeting. */
  meeting: () => Meeting | null;
  /** Whether turns are being taken, or the microphone is on. */
  busy: () => boolean;
  save: () => void;
  /** A model's provider and name, as the room shows them. */
  label: (agent: Agent) => string;
  anotherRound: () => void;
  /** Take the remaining steps of the meeting's build. */
  build: () => void;
  preview: (files: readonly ProjectFile[], page: ProjectFile) => HTMLElement;
  card: (owner: object, block: FileBlock) => HTMLElement;
  actions: (files: ProjectFile[], whose: string) => HTMLElement;
}
interface Elements {
  "build-dialog": HTMLDialogElement;
  "build-start": HTMLButtonElement;
  "handoff-copy": HTMLButtonElement;
  "handoff-dialog": HTMLDialogElement;
  "handoff-download": HTMLButtonElement;
  "handoff-text": HTMLTextAreaElement;
  "handoff-write": HTMLButtonElement;
  "next-build": HTMLButtonElement;
  "next-prompt": HTMLButtonElement;
  "next-rebuild": HTMLButtonElement;
  "next-round": HTMLButtonElement;
}
const $ = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof Elements ? Elements[Id] : HTMLElement;
const stepNames: Record<BuildKind, string> = {
  design: "Design files",
  code: "Code",
  review: "Security review",
  fix: "Security fixes",
  summary: "Summary",
};
const MAX_PREVIEWS = 6;
/** How much has been said, without Quorum's own notes. */
const spoken = (meeting: Meeting) => meeting.transcript.filter((m) => m.speaker !== "Quorum").length;

/** What the host can do once the team has been round: get a prompt, build, or go again. */
export function createNext(app: NextApp) {
  const { node } = app;
  const status = (message = "", failed = false) => {
    $("handoff-status").textContent = message;
    $("handoff-status").classList.toggle("failed", failed);
  };

  // ---- The card ----

  /** What the build result on screen was drawn from, so previews are not reloaded. */
  let drawn = "";
  function renderResult(meeting: Meeting | null) {
    const build = meeting?.build?.finished ? meeting.build : undefined;
    $("build-result").hidden = !build;
    // Quorum's own notes change no files.
    const key = build ? meeting!.id + "/" + spoken(meeting!) : "";
    if (key === drawn) return;
    drawn = key;
    $("build-result").replaceChildren();
    if (build) $("build-result").append(...result(meeting!, build));
  }
  /** The latest version of every proposed file, with previews of the designs. */
  function result(meeting: Meeting, build: Build) {
    const files = compatibleFiles(latestFiles(meeting.transcript));
    const heading = node("h4", "Build result");
    if (!files.length)
      return [
        heading,
        node("p", "No files were produced. Ask the engineer to send them, or build again.", "muted small"),
      ];
    const pages = files.filter((f) => isPreviewable(f.path)).reverse().slice(0, MAX_PREVIEWS);
    const previews = node("div", undefined, "build-result__previews");
    previews.append(...pages.map((page) => app.preview(files, page)));
    const list = node("div", undefined, "files");
    list.append(...files.map((file) => app.card(build, file)));
    return [
      heading,
      node(
        "p",
        "The latest version of each proposed file. Read them before saving or pushing.",
        "muted small",
      ),
      previews,
      list,
      app.actions(files, "the build result"),
    ];
  }
  function render() {
    const meeting = app.meeting();
    const accepted = meeting?.status === "accepted";
    const shown = Boolean(
      meeting && !app.busy() && (meeting.rounds || accepted || meeting.build || meeting.handoff),
    );
    $("next-steps").hidden = !shown;
    renderResult(meeting);
    if (!meeting || !shown) return;
    const { build } = meeting;
    const paused = Boolean(build && !build.finished);
    // An accepted meeting no longer changes, so only the prompt is offered.
    $("next-build").hidden = $("next-round").hidden = accepted;
    $("next-rebuild").hidden = accepted || !paused;
    $("next-build").textContent = paused ? "Continue build" : build ? "Build again" : "Build it here";
    $("next-round").textContent = meeting.round?.length ? "Finish this round" : "Another round";
    $("next-note").textContent = accepted
      ? "The outcome is accepted, so the discussion is closed. You can still get a prompt for Claude."
      : paused
        ? "The build is paused after " + build!.done + " of " + build!.steps.length + " steps."
        : build
          ? "The build is finished."
          : meeting.rounds
            ? "The team has been all the way round. Choose what happens next, or add your own thoughts first."
            : "Choose what happens next.";
  }

  // ---- Building ----

  function planDialog() {
    const meeting = app.meeting();
    if (!meeting || meeting.status === "accepted" || app.busy()) return;
    const plan = planBuild(meeting.participants);
    const who = (id: string) => meeting.participants.find((p) => p.id === id)!;
    $("build-steps").replaceChildren(
      ...plan.steps.map(({ id, kind }) => {
        const agent = who(id),
          words = kind !== "summary" && agent.files === false;
        return node("li", agent.name + ": " + stepNames[kind] + (words ? " (in words only)" : ""));
      }),
    );
    const notes: string[] = [];
    if (plan.allowed.length)
      notes.push(
        "For this build only, these agents may create files although their switch is off by default: " +
          plan.allowed.join(", ") + ".",
      );
    if (plan.refused.length)
      notes.push(
        "You turned Can create files off for " + plan.refused.join(", ") +
          ", so they reply in words only. To let them send files, turn it on in their Settings in the room first.",
      );
    if (plan.missing.length)
      notes.push(
        "Nobody here covers " + plan.missing.map((stage) => stageNames[stage]).join(", ") +
          ". Add an agent first to include that step.",
      );
    const demo = [...new Set(plan.steps.map((s) => who(s.id)).filter((a) => a.provider === "demo"))];
    if (demo.length)
      notes.push(demo.map((a) => a.name).join(", ") + ": demo agents call no model, so they produce no files.");
    if (!plan.possible)
      notes.push("Nothing can be built yet. The room needs a designer or an engineer who may create files.");
    $("build-notes").replaceChildren(...notes.map((text) => node("li", text)));
    $("build-start").disabled = !plan.possible;
    $("build-start").onclick = () => {
      if (app.meeting() !== meeting || app.busy()) return;
      meeting.build = { steps: plan.steps, done: 0 };
      app.save();
      $("build-dialog").close();
      app.build();
    };
    $("build-dialog").showModal();
  }
  $("next-build").addEventListener("click", () => {
    const build = app.meeting()?.build;
    if (build && !build.finished) app.build();
    else planDialog();
  });
  $("next-rebuild").addEventListener("click", planDialog);
  $("build-close").addEventListener("click", () => $("build-dialog").close());
  $("next-round").addEventListener("click", () => app.anotherRound());

  // ---- The prompt for Claude ----

  /** The request writing a prompt, which closing the dialog cancels. */
  let writing: AbortController | null = null;
  function showPrompt(meeting: Meeting) {
    const { handoff } = meeting;
    $("handoff-text").value = handoff?.text ?? "";
    $("handoff-text").hidden = !handoff;
    $("handoff-copy").disabled = $("handoff-download").disabled = !handoff;
    $("handoff-write").disabled = Boolean(writing);
    $("handoff-write").textContent = handoff ? "Write again" : "Try again";
    $("handoff-by").textContent = handoff
      ? "Written by " + handoff.writer + " on " + new Date(handoff.at).toLocaleString() + "." +
        (spoken(meeting) > handoff.messages
          ? " The discussion has moved on since; write it again to include that."
          : "")
      : "";
  }
  async function write(meeting: Meeting) {
    const writer = promptWriter(meeting.participants);
    if (!writer) return;
    writing?.abort();
    const mine = (writing = new AbortController());
    showPrompt(meeting);
    status(writer.name + " is writing the prompt. This can take a few minutes.");
    const messages = spoken(meeting);
    try {
      const { text, model } = await app.ask<{ text: string; model?: string }>(
        "/api/prompt",
        { agent: normalizeAgent(writer), meeting: handoffContext(meeting) },
        mine.signal,
      );
      if (mine.signal.aborted) return;
      meeting.handoff = {
        text,
        writer: writer.name + " (" + app.label({ ...writer, model: model ?? writer.model }) + ")",
        at: new Date().toISOString(),
        messages,
      };
      app.save();
      writing = null;
      showPrompt(meeting);
      status("The prompt is ready.");
      render();
    } catch (error) {
      if (mine.signal.aborted) return;
      writing = null;
      showPrompt(meeting);
      status((error as Error).message, true);
    }
  }
  $("next-prompt").addEventListener("click", () => {
    const meeting = app.meeting();
    if (!meeting || app.busy()) return;
    status();
    showPrompt(meeting);
    $("handoff-dialog").showModal();
    // A prompt already written is kept until the host asks for another.
    if (!meeting.handoff) void write(meeting);
  });
  $("handoff-write").addEventListener("click", () => {
    const meeting = app.meeting();
    if (meeting) void write(meeting);
  });
  $("handoff-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("handoff-text").value);
      status("Copied.");
    } catch {
      $("handoff-text").select();
      status("The browser would not copy. The text is selected, so copy it with your keyboard.", true);
    }
  });
  $("handoff-download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([$("handoff-text").value], { type: "text/markdown" }));
    const link = node("a");
    link.href = url;
    link.download = "claude-prompt-" + (slug(app.meeting()?.goal ?? "", 40) || "meeting") + ".md";
    link.click();
    // The download has the address by then.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  $("handoff-close").addEventListener("click", () => $("handoff-dialog").close());
  $("handoff-dialog").addEventListener("close", () => {
    writing?.abort();
    writing = null;
  });

  return { render };
}
