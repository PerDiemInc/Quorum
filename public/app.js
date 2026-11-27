import {
  providers,
  nextParticipant,
  canContinue,
  normalizeAgent,
  removeParticipant,
  voices,
  hostVoice,
  assignVoices,
  speakable,
  speechChunks,
  MAX_SKILLS,
  MAX_SKILL_CHARS,
} from "/engine.js";
import { createImport } from "/import.js";

const $ = (id) => document.getElementById(id);
const names = {
  demo: "Demo (no model)",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible / Hugging Face",
  claude: "Claude Code CLI",
  codex: "ChatGPT / Codex CLI",
};
// The provider new agents start on; chosen from what is actually connected.
let preferredProvider = "demo";
let state = { agents: [], meetings: [] },
  config = {},
  current = null,
  running = null,
  revision = 0,
  recording = null,
  /** @type {{id: string, turn: AbortController} | null} */
  speaker = null;
let saveQueue = Promise.resolve();
let stateVersion = 0;
function error(message = "") {
  $("error").textContent = message;
}
async function request(path, method = "GET", data, signal) {
  const res = await fetch(path, {
    method,
    signal,
    ...(data === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const json = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(json.error ?? "HTTP " + res.status), {
      status: res.status,
    });
  return json;
}
function save() {
  const snapshot = JSON.parse(JSON.stringify(state));
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const result = await request("/api/state", "PUT", {
        ...snapshot,
        _revision: stateVersion,
      });
      stateVersion = result.revision;
    })
    .catch((e) => error("Could not save: " + e.message));
  return saveQueue;
}
/** @param {{provider: string, model: string}} agent */
function modelLabel({ provider, model }) {
  if (provider === "demo") return names[provider];
  return names[provider] + " · " + (model || "Auto model");
}
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function button(text, fn, variant = "secondary") {
  const b = node("button", text, "button button--sm button--" + variant);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
/** Initials on a color that stays the same for a given name. */
function avatar(name) {
  const tone = [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6;
  const el = node("span", undefined, "avatar avatar--md tone-" + tone);
  el.setAttribute("aria-hidden", "true");
  el.append(
    node(
      "span",
      name
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0] ?? "")
        .join(""),
      "avatar__fallback",
    ),
  );
  return el;
}
function chip(text, tone) {
  return node(
    "span",
    text,
    "chip chip--sm" + (tone ? " chip--soft chip--" + tone : ""),
  );
}
function empty(title, text) {
  const el = node("div", undefined, "empty-state");
  el.append(node("strong", title), node("span", text));
  return el;
}
function agentInfo(agent, detail) {
  const el = node("span", undefined, "info");
  el.append(node("strong", agent.name), node("small", detail));
  return el;
}
function svg(paths, attributes = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  for (const [d, cls] of paths) {
    const shape = document.createElementNS(ns, "path");
    shape.setAttribute("d", d);
    if (cls) shape.setAttribute("class", cls);
    el.append(shape);
  }
  return el;
}
const icon = (path) => svg([[path, "fill"]]);
/** HeroUI checkbox markup around a native input, so forms and keyboards keep working. */
function checkbox(input, ...children) {
  const label = node("label", undefined, "checkbox"),
    content = node("span", undefined, "checkbox__content"),
    control = node("span", undefined, "checkbox__control"),
    indicator = node("span", undefined, "checkbox__indicator");
  input.type = "checkbox";
  input.className = "choice-input";
  indicator.append(
    svg([["M5 13l4 4L19 7"]], { "data-slot": "checkbox-default-indicator--checkmark" }),
  );
  control.append(indicator);
  content.append(control, ...children);
  label.append(input, content);
  label.dataset.selected = String(input.checked);
  return label;
}
/** HeroUI styles selection from an attribute; keep it in step with the native inputs. */
function syncChoices() {
  for (const el of document.querySelectorAll(".checkbox, .switch"))
    el.dataset.selected = String(el.querySelector("input").checked);
}
document.addEventListener("change", syncChoices);
/** Mark one tab or toggle in a HeroUI tab list as chosen. */
function setSelected(el, selected) {
  el.dataset.selected = String(selected);
  el.setAttribute("aria-pressed", String(selected));
}
const groupOf = (agent) => agent.category || (agent.source ? "Imported" : "Other");
const GROUPS = ["Build", "Product", "Grow", "Run", "Imported", "Other"];
const chosenGroup = { invite: "All", agent: "All" };
/** Buttons that narrow a list of agents to one group.
 * @param {'invite' | 'agent'} list @param {() => void} apply */
function renderFilters(list, apply) {
  const present = GROUPS.filter((g) => state.agents.some((a) => groupOf(a) === g));
  if (!present.includes(chosenGroup[list])) chosenGroup[list] = "All";
  $(list + "-filter").replaceChildren(
    ...(present.length > 1 ? ["All", ...present] : []).map((group) => {
      const active = group === chosenGroup[list];
      const el = button(
        group,
        () => {
          chosenGroup[list] = group;
          renderFilters(list, apply);
          apply();
          $(list + "-filter").querySelector("[aria-pressed=true]").focus();
        },
        active ? "primary" : "tertiary",
      );
      el.setAttribute("aria-pressed", String(active));
      return el;
    }),
  );
}
function matches(agent, list) {
  const query = $(list + "-search").value.trim().toLowerCase();
  return (
    (chosenGroup[list] === "All" || groupOf(agent) === chosenGroup[list]) &&
    [agent.name, agent.instructions, ...agent.skills.map((s) => s.name)].some((text) =>
      text.toLowerCase().includes(query),
    )
  );
}
/** Hidden choices stay selected, so searching never loses a pick. */
function filterInvite() {
  for (const label of $("invite").querySelectorAll(".checkbox")) {
    const agent = state.agents.find((a) => a.id === label.querySelector("input").value);
    label.hidden = !agent || !matches(agent, "invite");
  }
}
const voiceName = (id) =>
  voices.find(([voice]) => voice === id)?.[1] ?? id;
/** Fill a voice list. Voices other agents hold are labeled, or disabled when asked. */
function voiceOptions(select, selected, others, { lockUsed = false } = {}) {
  const ids = voices.map(([id]) => id);
  if (selected && !ids.includes(selected)) ids.push(selected);
  const options = ids.map((id) => {
    const owner = others.find((a) => a.voice === id),
      option = node(
        "option",
        voiceName(id) + (owner ? " (" + owner.name + ")" : ""),
      );
    option.value = id;
    option.disabled = lockUsed && Boolean(owner);
    return option;
  });
  if (!selected) {
    const automatic = node("option", "Automatic (unique)");
    automatic.value = "";
    options.unshift(automatic);
  }
  select.replaceChildren(...options);
  select.value = selected;
}

function modelOptions(select, selected) {
  select.replaceChildren(
    ...providers.map((p) => {
      const option = node("option", names[p]);
      option.value = p;
      option.disabled =
        !config.cli && ["claude", "codex"].includes(p) && p !== selected;
      return option;
    }),
  );
  select.value = selected;
}
function renderAgents() {
  const invite = $("invite");
  const picked = new Set(
    [...invite.querySelectorAll("input:checked")].map((x) => x.value),
  );
  invite.replaceChildren();
  for (const a of state.agents) {
    const input = node("input");
    input.name = "agent";
    input.value = a.id;
    input.checked = picked.has(a.id);
    invite.append(checkbox(input, avatar(a.name), agentInfo(a, modelLabel(a))));
  }
  $("agent-count").textContent = String(state.agents.length);
  renderFilters("invite", filterInvite);
  renderFilters("agent", renderAgentDirectory);
  filterInvite();
  renderAgentDirectory();
  voiceOptions($("agent-form").elements.voice, "", state.agents, {
    lockUsed: true,
  });
  updateInviteSelection();
  if (!state.agents.length)
    invite.append(empty("No agents available", "Create one to invite it."));
}
$("invite-search").addEventListener("input", filterInvite);
$("agent-search").addEventListener("input", () => renderAgentDirectory());
$("invite-shown").addEventListener("click", () => {
  let room = 12 - $("invite").querySelectorAll("input:checked").length;
  for (const label of $("invite").querySelectorAll(".checkbox:not([hidden])")) {
    const input = label.querySelector("input");
    if (!input.checked && room > 0) {
      input.checked = true;
      room--;
    }
  }
  syncChoices();
  updateInviteSelection();
});
$("invite-clear").addEventListener("click", () => {
  for (const input of $("invite").querySelectorAll("input")) input.checked = false;
  syncChoices();
  updateInviteSelection();
});
function renderHistory() {
  const list = $("history");
  const query = $("history-search").value.trim().toLowerCase();
  const meetings = state.meetings.filter((meeting) =>
    [meeting.goal, meeting.description, meeting.agenda, ...meeting.participants.map((agent) => agent.name)]
      .some((value) => value?.toLowerCase().includes(query)),
  );
  list.replaceChildren();
  if (!state.meetings.length)
    list.append(
      empty("A clean slate", "Your conversations will land here."),
    );
  else if (!meetings.length)
    list.append(empty("No matches", "No meetings match your search."));
  for (const m of meetings.toReversed()) {
    const item = node("button", undefined, "history-item");
    item.type = "button";
    if (m === current) item.setAttribute("aria-current", "true");
    item.addEventListener("click", () => openMeeting(m));
    item.append(
      node("strong", m.goal, "clamp"),
      node(
        "span",
        [
          m.status,
          m.createdAt && new Date(m.createdAt).toLocaleDateString(),
          m.participants.length + (m.participants.length === 1 ? " agent" : " agents"),
        ]
          .filter(Boolean)
          .join(" · "),
        "meta",
      ),
    );
    list.append(item);
  }
  updateInviteSelection();
}
$("history-search").addEventListener("input", renderHistory);

function updateInviteSelection() {
  const count = $("invite").querySelectorAll("input:checked").length;
  $("selection-count").textContent = count ? count + " / 12 selected" : "Choose at least one agent";
  $("meeting-form").querySelector('button[type="submit"]').disabled = count === 0 || count > 12;
  const availableIds = new Set(state.agents.map((agent) => agent.id));
  $("reuse-team").hidden = !state.meetings.at(-1)?.participants.some((agent) => availableIds.has(agent.id));
}
$("invite").addEventListener("change", updateInviteSelection);
$("reuse-team").addEventListener("click", () => {
  // Reuse library selections; each new meeting saves its own participant snapshots.
  const ids = new Set((state.meetings.at(-1)?.participants ?? []).map((agent) => agent.id));
  for (const input of $("invite").querySelectorAll("input")) input.checked = ids.has(input.value);
  syncChoices();
  updateInviteSelection();
});
/** Participants whose settings are open, so re-rendering does not close them. */
const openSettings = new Set();
function field(labelText, control) {
  const label = node("label", undefined, "field");
  control.className = "input input--secondary input--full-width";
  label.append(node("span", labelText, "label"), control);
  return label;
}
function renderTeam() {
  $("team").replaceChildren();
  if (!current) return;
  for (const a of current.participants) {
    const card = node("div", undefined, "participant card"),
      head = node("div", undefined, "participant__head"),
      info = agentInfo(a, modelLabel(a)),
      settings = node("details", undefined, "participant__settings"),
      toggle = node("summary", "Settings", "button button--ghost button--sm");
    card.dataset.agent = a.id;
    card.classList.toggle("active", speaker?.id === a.id);
    info.append(node("small", a.voice ? voiceName(a.voice).split(" · ")[0] + " voice" : ""));
    head.append(avatar(a.name), info);
    toggle.setAttribute("aria-label", a.name + " settings");
    settings.open = openSettings.has(a.id);
    settings.addEventListener("toggle", () => {
      if (settings.open) openSettings.add(a.id);
      else openSettings.delete(a.id);
    });
    const select = node("select"),
      model = node("input");
    modelOptions(select, a.provider);
    model.value = a.model;
    model.placeholder = "Auto model";
    model.disabled = a.provider === "demo";
    const describe = () => (info.querySelector("small").textContent = modelLabel(a));
    select.addEventListener("change", () => {
      a.provider = select.value;
      a.model = model.value = "";
      model.disabled = a.provider === "demo";
      describe();
      void save();
    });
    model.addEventListener("change", () => {
      a.model = model.value.trim();
      describe();
      void save();
    });
    const voice = node("select");
    voiceOptions(
      voice,
      a.voice,
      current.participants.filter((p) => p !== a),
    );
    voice.addEventListener("change", () => {
      // Picking a voice someone else has swaps the two, so each stays unique.
      const other = current.participants.find(
        (p) => p !== a && p.voice === voice.value,
      );
      if (other) other.voice = a.voice;
      a.voice = voice.value;
      stopPlayback();
      renderTeam();
      void save();
    });
    const remove = button("Remove from call", () => removeFromCall(a.id), "danger-soft");
    remove.classList.add("remove-agent");
    remove.setAttribute("aria-label", "Remove " + a.name + " from call");
    const fields = [
      field("Provider", select),
      field("Model (blank for automatic)", model),
      field("Voice", voice),
    ];
    settings.append(toggle, ...fields, remove);
    card.append(head, settings);
    $("team").append(card);
  }
}
function renderMeetingAgents() {
  $("meeting-agents").textContent = current.participants
    .map((agent) => agent.name)
    .join(", ");
}
/** Take an agent out of the open meeting; the library and transcript are untouched. */
function removeFromCall(id) {
  if (!current || current.status === "accepted") return;
  if (current.participants.length === 1) return;
  const removed = removeParticipant(current, id);
  if (!removed) return;
  (current.removedParticipants ??= []).push(removed);
  // Only the removed agent's turn is cancelled; the discussion keeps running.
  if (speaker?.id === id) {
    speaker.turn.abort();
    speaker = null;
  }
  addMessage("Quorum", removed.name + " left the call.");
  renderTeam();
  renderMeetingAgents();
  renderHistory();
  renderStatus(removed.name + " was removed from the call.");
  $("goal").focus({ preventScroll: true });
}
function renderTranscript() {
  $("transcript").replaceChildren();
  if (!current) return;
  for (const m of current.transcript) {
    if (m.speaker === "Quorum" && !m.model) {
      $("transcript").append(node("p", m.text, "chip chip--sm notice-line"));
      continue;
    }
    const host = m.speaker === "Host",
      row = node("article", undefined, host ? "message host" : "message"),
      content = node("div", undefined, "message-body"),
      meta = node("div", undefined, "meta"),
      line = node("div", undefined, "bubble-line"),
      listen = node("button", undefined, "play button button--ghost button--sm button--icon-only");
    meta.append(node("strong", m.speaker));
    if (m.model) meta.append(node("span", m.model));
    if (m.at)
      meta.append(
        node(
          "time",
          new Date(m.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        ),
      );
    listen.type = "button";
    listen.message = m;
    listen.addEventListener("click", () => void play(m));
    showPlayState(listen);
    line.append(node("p", m.text, "bubble"), listen);
    content.append(meta, line);
    row.append(avatar(m.speaker), content);
    $("transcript").append(row);
  }
  if (!current.transcript.length)
    $("transcript").append(
      empty(
        "No messages yet",
        "Start the discussion, or add the first thought yourself.",
      ),
    );
  $("transcript").scrollTop = $("transcript").scrollHeight;
}
/** The message being read aloud from its play button, if any. */
let playback = null;
function showPlayState(el) {
  const active = playback?.message === el.message;
  el.classList.toggle("playing", active);
  el.replaceChildren(
    icon(active ? "M7 7h10v10H7Z" : "M8 5.5v13l10.5-6.5Z"),
  );
  el.title = active ? "Stop reading" : "Read aloud";
  el.setAttribute(
    "aria-label",
    (active ? "Stop reading " : "Read aloud ") +
      el.message.speaker +
      "'s message",
  );
}
function updatePlayButtons() {
  for (const el of $("transcript").querySelectorAll(".play")) showPlayState(el);
}
function stopPlayback() {
  playback?.ctrl.abort();
  playback = null;
  updatePlayButtons();
}
async function play(message) {
  if (playback?.message === message) {
    stopPlayback();
    return;
  }
  if (recording) {
    error("Finish recording first.");
    return;
  }
  // Two voices at once would be unintelligible, so a spoken discussion pauses first.
  if (running && $("voice-output").checked) pause();
  stopPlayback();
  error();
  const ctrl = new AbortController();
  playback = { message, ctrl };
  updatePlayButtons();
  const voice =
    message.speaker === "Host"
      ? hostVoice
      : (current.participants.find((a) => a.name === message.speaker)?.voice ??
        "");
  try {
    await speak(message.text, voice, ctrl.signal);
  } catch (e) {
    if (!ctrl.signal.aborted) error(e.message);
  } finally {
    if (playback?.ctrl === ctrl) {
      playback = null;
      updatePlayButtons();
    }
  }
}
function renderStatus(message = "") {
  if (!current) return;
  $("status").textContent = current.status;
  $("status").className =
    "chip chip--soft chip--" +
    { running: "accent", accepted: "success", paused: "warning" }[current.status];
  $("meeting-panel").dataset.busy = String(Boolean(running));
  $("mic-state").textContent = recording
    ? "Microphone on · recording"
    : "Microphone off";
  $("voice-host").classList.toggle("recording", Boolean(recording));
  $("progress").textContent = message;
  $("resume").disabled =
    Boolean(running) || Boolean(recording) || current.status === "accepted";
  $("pause").disabled = !running;
  $("accept").disabled = current.status === "accepted" || Boolean(recording);
  for (const remove of $("team").querySelectorAll(".remove-agent")) {
    const last = current.participants.length === 1;
    remove.disabled = last || current.status === "accepted";
    remove.title = last ? "A meeting needs at least one agent" : "";
  }
  $("record").disabled = current.status === "accepted" || !config.whisper;
  $("message-form").querySelector("button[type=submit]").disabled =
    current.status === "accepted" || Boolean(recording);
}
function clearSpeaker() {
  for (const card of $("team").children) card.classList.remove("active");
}
function pause() {
  stopPlayback();
  revision++;
  if (running) running.abort();
  running = null;
  speaker = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (current && current.status === "running") current.status = "paused";
  clearSpeaker();
  renderStatus();
  void save();
}
function openMeeting(m) {
  if (recording) {
    error("Finish recording first.");
    return;
  }
  showView("meetings");
  pause();
  current = m;
  openSettings.clear();
  document.querySelector(".meeting-details").open = false;
  if (current.status === "running") current.status = "paused";
  $("new-panel").hidden = true;
  $("meeting-panel").hidden = false;
  renderMode();
  $("goal").textContent = m.goal;
  $("meeting-description").textContent = m.description || "No description";
  $("agenda").textContent = m.agenda || "No agenda";
  renderMeetingAgents();
  $("goal").focus();
  $("message-form").elements.message.value = "";
  error();
  renderTeam();
  renderTranscript();
  renderStatus();
  renderHistory();
}
function newMeeting() {
  if (recording) {
    error("Finish recording first.");
    return;
  }
  showView("meetings");
  pause();
  current = null;
  $("new-panel").hidden = false;
  $("meeting-panel").hidden = true;
  $("meeting-form").elements.goal.focus();
  renderHistory();
  error();
}
function addMessage(speaker, text, model) {
  current.transcript.push({
    speaker,
    text,
    model,
    at: new Date().toISOString(),
  });
  renderTranscript();
  void save();
}
function localSpeak(text, voice, signal) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis || signal.aborted) {
      resolve();
      return;
    }
    const voices = window.speechSynthesis
      .getVoices()
      .filter((v) => v.localService);
    if (!voices.length) {
      reject(
        new Error(
          "No local browser voices are available. Configure Kokoro or disable speech.",
        ),
      );
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    // The first listed voice is often a novelty voice, so prefer the default one.
    utterance.voice =
      voices.find((v) => v.name === voice) ??
      voices.find((v) => v.default) ??
      voices.find((v) => v.lang === navigator.language) ??
      voices[0];
    const finish = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      window.speechSynthesis.cancel();
      finish();
    };
    utterance.onend = finish;
    utterance.onerror = (e) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) resolve();
      else reject(new Error("Speech playback: " + e.error));
    };
    signal.addEventListener("abort", stop, { once: true });
    window.speechSynthesis.speak(utterance);
  });
}
async function speak(text, voice, signal) {
  const spoken = speakable(text);
  if (!spoken) return;
  if (!config.kokoro) return localSpeak(spoken, voice, signal);
  const synthesize = async (part) => {
    const res = await fetch("/api/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: part, voice }),
      signal,
    });
    if (!res.ok)
      throw new Error(
        "Natural voices are not available. Start them with npm run services.",
      );
    return res.blob();
  };
  const parts = speechChunks(spoken);
  let next = synthesize(parts[0]);
  try {
    await next;
  } catch (e) {
    if (signal.aborted) return;
    $("audio-note").textContent = e.message + " Using a browser voice.";
    return localSpeak(spoken, voice, signal);
  }
  for (let i = 0; i < parts.length && !signal.aborted; i++) {
    const audio = await next;
    // Prepare the following sentences while these ones play.
    if (i + 1 < parts.length) {
      next = synthesize(parts[i + 1]);
      next.catch(() => {});
    }
    await playAudio(audio, signal);
  }
}
async function playAudio(blob, signal) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", stop);
      const stop = () => {
        audio.pause();
        cleanup();
        resolve();
      };
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error("Audio playback failed"));
      };
      audio.play().catch((e) => {
        cleanup();
        reject(e);
      });
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
/** A just-cancelled turn can take a moment to release the model, so retry while busy. */
async function requestTurn(data, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request("/api/turn", "POST", data, signal);
    } catch (e) {
      if (e.status !== 409 || attempt >= 10) throw e;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
async function run() {
  if (!current || running || recording || current.status === "accepted") return;
  stopPlayback();
  const m = current,
    token = ++revision,
    ctrl = new AbortController();
  running = ctrl;
  m.status = "running";
  error();
  void save();
  renderHistory();
  const limit = Math.min(
    60,
    Math.max(1, Math.floor(Number($("limit").value) || 12)),
  );
  let turns = 0;
  try {
    while (token === revision && canContinue(m, turns, limit)) {
      const agent = normalizeAgent(
        nextParticipant(m.participants, m.cursor ?? 0),
      );
      renderStatus(
        agent.name + " is thinking · " + (turns + 1) + " / " + limit,
      );
      const turn = new AbortController(),
        signal = AbortSignal.any([ctrl.signal, turn.signal]);
      speaker = { id: agent.id, turn };
      clearSpeaker();
      [...$("team").children]
        .find((el) => el.dataset.agent === agent.id)
        ?.classList.add("active");
      const context = {
        goal: m.goal,
        description: m.description,
        agenda: m.agenda,
        participants: m.participants.map((p) => ({ name: p.name })),
        transcript: m.transcript
          .slice(-30)
          .map((x) => ({ speaker: x.speaker, text: x.text.slice(0, 4000) })),
      };
      let result;
      try {
        result = await requestTurn({ agent, meeting: context }, signal);
      } catch (e) {
        if (turn.signal.aborted && !ctrl.signal.aborted) continue;
        throw e;
      }
      if (token !== revision || ctrl.signal.aborted) break;
      if (turn.signal.aborted) continue;
      addMessage(
        agent.name,
        result.text,
        names[agent.provider] + (result.model ? " / " + result.model : ""),
      );
      m.cursor = (m.cursor ?? 0) + 1;
      turns++;
      void save();
      if ($("voice-output").checked) {
        renderStatus(agent.name + " is speaking");
        try {
          await speak(result.text, agent.voice, signal);
        } catch (e) {
          if (!signal.aborted) $("audio-note").textContent = e.message;
        }
      }
      if (agent.provider === "demo")
        await new Promise((resolve) => setTimeout(resolve, 600));
    }
  } catch (e) {
    if (token === revision && !ctrl.signal.aborted) error(e.message);
  } finally {
    if (token === revision) {
      running = null;
      speaker = null;
      if (m.status === "running") m.status = "paused";
      clearSpeaker();
      renderStatus(
        turns >= limit
          ? "Turn budget reached. Accept the outcome or continue."
          : "Paused.",
      );
      renderHistory();
      void save();
    }
  }
}
$("agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  error();
  $("create-status").textContent = "";
  const f = e.currentTarget,
    data = new FormData(f);
  try {
    const skills = [...pendingSkills];
    for (const file of f.elements.skills.files) {
      if (file.size > MAX_SKILL_CHARS)
        throw new Error("Skill files must be under 32 KB.");
      skills.push({ name: file.name, text: await file.text() });
    }
    if (String(data.get("skillText")).trim())
      skills.push({ name: "Custom skill", text: data.get("skillText") });
    if (skills.length > MAX_SKILLS)
      throw new Error("An agent can have at most " + MAX_SKILLS + " skills.");
    const agent = normalizeAgent({
      id: crypto.randomUUID(),
      name: data.get("name"),
      provider: data.get("provider"),
      model: data.get("model"),
      voice: data.get("voice"),
      instructions: data.get("instructions"),
      skills,
    });
    state.agents.push(agent);
    assignVoices(state.agents);
    pendingSkills = [];
    renderPendingSkills();
    f.reset();
    resetAgentModel();
    $("create-agent").close();
    renderAgents();
    await save();
  } catch (e) {
    // The toast sits behind an open dialog, so say it inside.
    $("create-status").textContent = e.message;
  }
});
$("agent-form").elements.provider.addEventListener("change", (e) => {
  // A model name from another provider is never carried over.
  $("agent-form").elements.model.value = "";
  $("agent-form").elements.model.disabled = e.target.value === "demo";
});
$("meeting-form").addEventListener("submit", (e) => {
  e.preventDefault();
  error();
  const f = e.currentTarget,
    d = new FormData(f),
    ids = d.getAll("agent");
  if (!ids.length) {
    error("Choose at least one agent.");
    return;
  }
  const participants = state.agents
    .filter((a) => ids.includes(a.id))
    .map((a) => structuredClone(a));
  if (participants.length > 12) {
    error("Choose at most 12 participants.");
    return;
  }
  const m = {
    id: crypto.randomUUID(),
    goal: String(d.get("goal")).trim(),
    description: String(d.get("description")).trim(),
    createdAt: new Date().toISOString(),
    agenda: String(d.get("agenda")).trim(),
    participants,
    transcript: [],
    cursor: 0,
    status: "paused",
    mode: d.get("mode") === "voice" ? "voice" : "chat",
  };
  assignVoices(m.participants, state.agents);
  if (!m.goal) {
    error("Enter a meeting goal.");
    return;
  }
  state.meetings.push(m);
  openMeeting(m);
  f.reset();
  syncChoices();
  filterInvite();
  updateInviteSelection();
  void save();
});
$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!current || recording || current.status === "accepted") return;
  const input = e.currentTarget.elements.message,
    text = input.value.trim();
  if (!text) return;
  pause();
  addMessage("Host", text);
  input.value = "";
  renderStatus("Feedback added. Continue when ready.");
});
$("resume").addEventListener("click", () => void run());
$("pause").addEventListener("click", pause);
$("accept").addEventListener("click", () => {
  if (!current || recording) return;
  pause();
  current.status = "accepted";
  renderStatus("Outcome accepted by host.");
  renderHistory();
  void save();
});
$("new").addEventListener("click", newMeeting);
$("record").addEventListener("click", async () => {
  if (recording) {
    if (recording.state === "recording") recording.stop();
    return;
  }
  if (!current || current.status === "accepted") return;
  pause();
  error();
  const m = current;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (current !== m || m.status === "accepted") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const rec = new MediaRecorder(stream);
    recording = rec;
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      recording = null;
      $("record-label").textContent =
        current?.mode === "voice" ? "Turn mic on" : "Record voice";
      renderStatus();
      error("Microphone recording failed.");
    };
    const timer = setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, 60000);
    rec.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      $("record-label").textContent = "Transcribing…";
      $("record").disabled = true;
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (current === m) $("message-form").elements.message.value = data.text;
      } catch (e) {
        error(e.message);
      } finally {
        recording = null;
        $("record-label").textContent =
          current?.mode === "voice" ? "Turn mic on" : "Record voice";
        renderStatus("Review your transcription and send it.");
      }
    };
    rec.start();
    $("record-label").textContent = "Stop & transcribe";
    renderStatus("Recording…");
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    recording = null;
    renderStatus();
    error(e.message);
  }
});
async function init() {
  try {
    [state, config] = await Promise.all([
      request("/api/state"),
      request("/api/config"),
    ]);
    stateVersion = state._revision ?? 0;
    renderConnection();
    // Checking the CLI takes a moment, so the page does not wait for it.
    void request("/api/claude")
      .then(renderConnection)
      .catch(() => {});
    resetAgentModel();
    void chooseDefaults();
    if (!state.agents.length && !state.initialized) {
      for (const [name, instructions] of [
        ["Architect", "Consider architecture and tradeoffs."],
        ["Critic", "Challenge assumptions and identify risks."],
      ])
        state.agents.push(
          normalizeAgent({
            id: crypto.randomUUID(),
            name,
            provider: "demo",
            instructions,
            skills: [],
          }),
        );
      void save();
    }
    assignVoices(state.agents);
    for (const m of state.meetings) assignVoices(m.participants, state.agents);
    state.initialized = true;
    void save();
    for (const m of state.meetings)
      if (m.status === "running") m.status = "paused";
    renderAgents();
    renderHistory();
    $("audio-note").textContent = config.kokoro
      ? "Natural voices by Kokoro, running on this computer."
      : "Speech uses available local browser voices unless Kokoro is configured.";
    if (window.speechSynthesis) window.speechSynthesis.getVoices();
  } catch (e) {
    $("connection").replaceChildren(chip("Disconnected", "danger"));
    error(e.message);
  }
}
/** A fresh form: the connected provider, with the model left to automatic. */
/** Skills imported for the agent that is still being created. */
let pendingSkills = [];
function renderPendingSkills() {
  $("new-agent-skills").replaceChildren(
    ...pendingSkills.map((skill) => {
      const item = node("li");
      const remove = button(
        "Remove",
        () => {
          pendingSkills = pendingSkills.filter((s) => s !== skill);
          renderPendingSkills();
        },
        "ghost",
      );
      remove.setAttribute("aria-label", "Remove " + skill.name);
      item.append(node("span", skill.name), remove);
      return item;
    }),
  );
}
/** Add skills, replacing ones with the same name so a re-import updates them. */
function mergeSkills(existing, added) {
  const merged = new Map(existing.map((s) => [s.name, s]));
  for (const { name, text, source } of added)
    merged.set(name, { name, text, source });
  if (merged.size > MAX_SKILLS)
    throw new Error("An agent can have at most " + MAX_SKILLS + " skills.");
  return [...merged.values()];
}
async function addImportedSkills(target, skills) {
  const agent = state.agents.find((a) => a.id === target);
  if (!agent) {
    pendingSkills = mergeSkills(pendingSkills, skills);
    renderPendingSkills();
    return "the new agent";
  }
  agent.skills = mergeSkills(agent.skills, skills);
  renderAgents();
  await save();
  return agent.name;
}
/** Turn imported profiles into agents. Importing one again updates it in place. */
async function addImportedAgents(profiles, provider) {
  let added = 0,
    updated = 0;
  for (const profile of profiles) {
    const existing = state.agents.find(
      (a) => a.source === profile.source && a.importedName === profile.name,
    );
    let name = existing?.name ?? profile.name;
    for (let n = 2; !existing && state.agents.some((a) => a.name === name); n++)
      name = profile.name.slice(0, 76) + " " + n;
    // A profile's Claude model is kept only when the agent runs on Claude.
    const claudeModel =
      provider === "claude" && /^(sonnet|opus|haiku|claude-)/.test(profile.model);
    const agent = {
      ...normalizeAgent({
        id: existing?.id ?? crypto.randomUUID(),
        name,
        provider: existing?.provider ?? provider,
        model: existing?.model ?? (claudeModel ? profile.model : ""),
        voice: existing?.voice ?? "",
        instructions: profile.instructions,
        skills: mergeSkills(existing?.skills ?? [], profile.skills),
      }),
      source: profile.source,
      importedName: profile.name,
    };
    if (existing) {
      state.agents[state.agents.indexOf(existing)] = agent;
      updated++;
    } else {
      state.agents.push(agent);
      added++;
    }
  }
  assignVoices(state.agents);
  renderAgents();
  await save();
  return { added, updated };
}
const openImport = createImport({
  node,
  checkbox,
  setSelected,
  chip,
  request,
  agents: () => state.agents,
  providerChoices: (select) => modelOptions(select, preferredProvider),
  addSkills: addImportedSkills,
  addAgents: addImportedAgents,
});
$("new-agent-import").addEventListener("click", () => openImport("", "library"));
$("import-agents").addEventListener("click", () =>
  openImport(state.agents[0]?.id ?? "", "github"),
);
$("detail-import").addEventListener("click", () => {
  $("agent-dialog").close();
  openImport(viewedAgentId, "library");
});
function resetAgentModel() {
  const { provider, model } = $("agent-form").elements;
  modelOptions(provider, preferredProvider);
  model.value = "";
  model.disabled = preferredProvider === "demo";
}
/** Start new agents on a provider that is connected. */
async function chooseDefaults() {
  const result = await request("/api/models").catch(() => null);
  if (!result) return;
  const connected = (cli) => config.cli && cli?.authenticated;
  preferredProvider = connected(result.claude)
    ? "claude"
    : connected(result.codex)
      ? "codex"
      : result.ollama.models.length
        ? "ollama"
        : "demo";
  // Leave the form alone if someone has started filling it in.
  if (!$("create-agent").open) resetAgentModel();
}
function renderConnection(claude) {
  const chips = [
    chip("Local workspace", "success"),
    chip(
      config.whisper ? "Voice input on" : "Voice input off",
      config.whisper ? "success" : "default",
    ),
  ];
  if (config.kokoro) chips.push(chip("Natural voices", "success"));
  if (claude) {
    const status = chip(
      claude.ready
        ? "Claude ready"
        : claude.disabled
          ? "Claude disabled"
          : "Claude unavailable",
      claude.ready ? "success" : "warning",
    );
    status.title = claude.message ?? "";
    chips.push(status);
  }
  $("connection").replaceChildren(...chips);
}
$("voice-output").addEventListener("change", (e) => {
  if (running && e.target.checked) stopPlayback();
});
$("dismiss").addEventListener("click", () => error());
/** Dark unless this browser has chosen light. The button names the mode it switches to.
 * @param {'light' | 'dark'} theme */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-label").textContent =
    theme === "dark" ? "Light mode" : "Dark mode";
}
try {
  setTheme(localStorage.getItem("quorum-theme") === "light" ? "light" : "dark");
} catch {
  setTheme("dark");
}
$("theme").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(theme);
  try {
    localStorage.setItem("quorum-theme", theme);
  } catch {
    /* The choice then lasts until the page is reloaded. */
  }
});
void init();

/** @type {string | null} */
let viewedAgentId = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let modelPoll;
let settingsLoading = false;

/** @param {'meetings' | 'agents' | 'settings'} view */
function showView(view) {
  const workspace = document.querySelector(".workspace");
  workspace.classList.toggle("settings-open", view === "settings");
  workspace.classList.toggle("agents-open", view === "agents");
  $("settings-panel").hidden = view !== "settings";
  $("agents-panel").hidden = view !== "agents";
  for (const item of ["meetings", "agents", "settings"])
    setSelected($("nav-" + item), item === view);
  clearTimeout(modelPoll);
  if (view === "settings") void refreshModels();
}
function renderAgentDirectory() {
  $("undo-delete").hidden = !state.deletedAgents?.length;
  const shown = state.agents.filter((agent) => matches(agent, "agent"));
  $("agent-directory").replaceChildren(
    ...shown.map((agent) => {
      const card = node("article", undefined, "card agent-card"),
        head = node("div", undefined, "agent-card__head"),
        footer = node("div", undefined, "agent-card__footer"),
        view = button("View details", () => viewAgent(agent), "tertiary");
      view.setAttribute("aria-label", "View " + agent.name);
      head.append(avatar(agent.name), agentInfo(agent, modelLabel(agent)));
      footer.append(chip(groupOf(agent)), view);
      card.append(
        head,
        node("p", agent.instructions || "No instructions yet.", "clamp"),
        node(
          "p",
          agent.skills.length
            ? agent.skills.map((s) => s.name).join(", ")
            : "No skills",
          "small clamp",
        ),
        footer,
      );
      return card;
    }),
  );
  if (!shown.length)
    $("agent-directory").append(
      state.agents.length
        ? empty("No matches", "No agents match your search.")
        : empty("No agents yet", "Create one to assemble your team."),
    );
}
/** @param {{id:string,name:string,provider:string,model:string,voice:string,instructions:string,skills:Array<{name:string,text:string}>}} agent */
function viewAgent(agent) {
  viewedAgentId = agent.id;
  $("agent-detail-name").textContent = agent.name;
  $("agent-detail").replaceChildren();
  const detail = (title, text) =>
    $("agent-detail").append(node("h3", title), node("p", text));
  detail("MODEL", modelLabel(agent));
  detail("INSTRUCTIONS", agent.instructions || "No instructions.");
  if (agent.source) detail("IMPORTED FROM", agent.source);
  detail("VOICE", agent.voice ? voiceName(agent.voice) : "Default local voice");
  $("agent-detail").append(node("h3", "SKILLS"));
  if (!agent.skills.length)
    $("agent-detail").append(node("p", "No skills yet."));
  for (const skill of agent.skills) {
    const item = node("details"),
      remove = button(
        "Remove skill",
        async () => {
          agent.skills = agent.skills.filter((s) => s !== skill);
          renderAgents();
          viewAgent(agent);
          await save();
        },
        "danger-soft",
      );
    item.append(node("summary", skill.name, "button button--secondary button--sm"));
    if (skill.source)
      item.append(node("p", "Imported from " + skill.source, "muted small"));
    item.append(node("p", skill.text), remove);
    $("agent-detail").append(item);
  }
  if (!$("agent-dialog").open) $("agent-dialog").showModal();
}
$("close-agent").addEventListener("click", () => $("agent-dialog").close());
$("delete-agent").addEventListener("click", async () => {
  const agent = state.agents.find((a) => a.id === viewedAgentId);
  if (
    !agent ||
    !window.confirm(
      "Delete " +
        agent.name +
        " from your agent library? Existing meetings are kept.",
    )
  )
    return;
  (state.deletedAgents ??= []).push(agent);
  state.agents = state.agents.filter((a) => a.id !== agent.id);
  $("agent-dialog").close();
  renderAgents();
  await save();
});
$("undo-delete").addEventListener("click", async () => {
  const agent = state.deletedAgents?.pop();
  if (!agent) return;
  state.agents.push(agent);
  assignVoices(state.agents);
  renderAgents();
  await save();
});
$("add-agent").addEventListener("click", () => {
  $("create-status").textContent = "";
  $("create-agent").showModal();
  $("agent-form").elements.name.focus();
});
$("create-close").addEventListener("click", () => $("create-agent").close());
for (const view of ["meetings", "agents", "settings"])
  $("nav-" + view).addEventListener("click", () => showView(view));

async function refreshModels() {
  if (settingsLoading) return;
  settingsLoading = true;
  $("refresh-models").disabled = true;
  clearTimeout(modelPoll);
  try {
    const result = await request("/api/models");
    $("provider-status").replaceChildren();
    const card = (title, label, ready, description) => {
      const el = node("div", undefined, "card provider");
      el.append(
        node("h3", title, "card__title"),
        chip(label, ready ? "success" : "warning"),
        node("p", description, "card__description"),
      );
      $("provider-status").append(el);
    };
    card(
      "Ollama",
      result.ollama.available ? "Connected" : "Unavailable",
      result.ollama.available,
      result.ollama.available ? "Local model service." : "Start the Ollama service.",
    );
    card(
      "Hugging Face / compatible",
      result.inference.available ? "Connected" : "Offline",
      result.inference.available,
      result.inference.available
        ? "Inference service."
        : "The optional inference profile is not running.",
    );
    for (const [key, title] of [
      ["codex", "ChatGPT / Codex CLI"],
      ["claude", "Claude Code CLI"],
    ]) {
      const cli = result[key];
      const ready = cli.installed && cli.authenticated && cli.enabled;
      card(
        title,
        ready ? "Connected" : "Not ready",
        ready,
        !cli.installed
          ? "Not installed in this Quorum runtime."
          : !cli.authenticated
            ? "Installed, but the login is not verified."
            : !cli.enabled
              ? "Authenticated, but CLI access is disabled."
              : result.cliBridge
                ? "Connected through the Mac CLI bridge."
                : "Authenticated and enabled.",
      );
    }
    if (result.hostAccess) {
      for (const [key, title] of [
        ["codex", "Mac · Codex"],
        ["claude", "Mac · Claude Code"],
      ]) {
        const host = result.hostAccess[key];
        card(
          title,
          host?.authenticated ? "Signed in on host" : "Not signed in",
          Boolean(host?.authenticated),
          "Checked " +
            new Date(result.hostAccess.checkedAt).toLocaleString() +
            ". Host access is separate from container access.",
        );
      }
    }
    $("installed-models").replaceChildren();
    for (const model of result.ollama.models) {
      const row = node("div", undefined, "model-row");
      row.append(
        node("strong", model.name),
        node("span", (model.size / 1e9).toFixed(2) + " GB · Ollama", "muted"),
      );
      $("installed-models").append(row);
    }
    for (const model of result.inference.models) {
      const row = node("div", undefined, "model-row");
      row.append(
        node("strong", model.id),
        node("span", "Compatible endpoint", "muted"),
      );
      $("installed-models").append(row);
    }
    if (!$("installed-models").children.length)
      $("installed-models").append(
        node("p", "No models found. Download your first model below.", "muted"),
      );
    const job = result.pull;
    $("install-model-form").querySelector("button").disabled =
      !result.ollama.available || job?.status === "downloading";
    $("download-progress").textContent = job
      ? job.name +
        " · " +
        job.status +
        (job.status === "downloading" && job.total
          ? " · " + Math.round(((job.completed ?? 0) / job.total) * 100) + "%"
          : "") +
        (job.error ? " · " + job.error : "")
      : "";
    if (job?.status === "downloading" && !$("settings-panel").hidden)
      modelPoll = setTimeout(() => void refreshModels(), 1500);
  } catch (e) {
    error(e.message);
  } finally {
    settingsLoading = false;
    $("refresh-models").disabled = false;
  }
}
$("refresh-models").addEventListener("click", () => void refreshModels());
$("install-model-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  error();
  const button = e.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/models/pull", "POST", {
      name: e.currentTarget.elements.model.value.trim(),
    });
    await refreshModels();
  } catch (e) {
    error(e.message);
    button.disabled = false;
  }
});

// Flush pending edits before merging the server's current state with the curated team.
$("starter-team").addEventListener("click", async () => {
  $("starter-team").disabled = true;
  try {
    if (running || recording)
      throw new Error(
        "Pause the meeting and finish recording before adding the starter team.",
      );
    await saveQueue;
    const result = await request("/api/agents/starter-team", "POST", {});
    state = result.state;
    stateVersion = state._revision ?? 0;
    if (current)
      current =
        state.meetings.find((meeting) => meeting.id === current.id) ?? null;
    assignVoices(state.agents);
    renderAgents();
    await save();
    $("starter-team-status").textContent =
      result.added +
      (result.added === 1 ? " agent" : " agents") +
      " added. Models are chosen automatically from your installed Ollama models.";
  } catch (err) {
    error(err.message);
  } finally {
    $("starter-team").disabled = false;
  }
});

/** Update the room presentation without starting microphone capture. */
function renderMode() {
  const voice = current?.mode === "voice";
  $("meeting-panel").classList.toggle("voice-mode", voice);
  setSelected($("mode-chat"), !voice);
  setSelected($("mode-voice"), voice);
  $("voice-host").hidden = !voice;
  $("voice-output").checked = voice;
  syncChoices();
  $("transcript-heading").textContent = voice
    ? "Meeting transcript"
    : "Conversation";
  $("mode-note").textContent = voice
    ? config.whisper
      ? "Push-to-talk · click the mic to speak, then stop to review and send."
      : "Voice capture unavailable. Enable the speech service in Settings setup; text chat remains available."
    : "Text chat · voice notes are available when speech is configured.";
  if (!recording)
    $("record-label").textContent = voice ? "Turn mic on" : "Record voice";
}
for (const mode of ["chat", "voice"])
  $("mode-" + mode).addEventListener("click", () => {
    if (!current) return;
    if (recording) {
      error("Finish recording before changing room mode.");
      return;
    }
    pause();
    current.mode = mode;
    renderMode();
    void save();
  });
