import {
  providers,
  nextParticipant,
  canContinue,
  normalizeAgent,
  defaultModels,
  voices,
  hostVoice,
  assignVoices,
  speakable,
  speechChunks,
} from "/engine.js";

const $ = (id) => document.getElementById(id);
const names = {
  demo: "Demo (no model)",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible / Hugging Face",
  claude: "Claude Code CLI",
  codex: "ChatGPT / Codex CLI",
};
// Local entries are replaced with an installed model once the server reports them.
const defaults = { ...defaultModels };
// The provider new agents start on; chosen from what is actually connected.
let preferredProvider = "demo";
let state = { agents: [], meetings: [] },
  config = {},
  current = null,
  running = null,
  revision = 0,
  recording = null;
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
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function button(text, fn) {
  const b = node("button", text, "secondary");
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
/** Initials on a color that stays the same for a given name. */
function avatar(name) {
  const tone = [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6;
  const el = node(
    "span",
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] ?? "")
      .join(""),
    "avatar tone-" + tone,
  );
  el.setAttribute("aria-hidden", "true");
  return el;
}
function chip(text, tone) {
  const el = node("span", text, "chip");
  if (tone) el.dataset.tone = tone;
  return el;
}
function empty(title, text) {
  const el = node("div", undefined, "empty");
  el.append(node("strong", title), node("span", text));
  return el;
}
function agentInfo(agent, detail) {
  const el = node("div", undefined, "agent-info");
  el.append(node("strong", agent.name), node("small", detail));
  return el;
}
function icon(path) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("class", "fill");
  svg.append(shape);
  return svg;
}
const model = (agent) =>
  names[agent.provider] + (agent.model ? " · " + agent.model : "");

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
  const list = $("agents"),
    invite = $("invite");
  const picked = new Set(
    [...invite.querySelectorAll("input:checked")].map((x) => x.value),
  );
  list.replaceChildren();
  invite.replaceChildren();
  for (const a of state.agents) {
    const card = node("div", undefined, "agent"),
      info = agentInfo(a, model(a));
    info.append(
      node("small", a.skills.map((s) => s.name).join(", ") || "No skills"),
      button("View agent", () => viewAgent(a)),
    );
    card.append(avatar(a.name), info);
    list.append(card);
    const label = node("label", undefined, "check"),
      input = node("input");
    input.type = "checkbox";
    input.name = "agent";
    input.value = a.id;
    input.checked = picked.has(a.id);
    label.append(input, avatar(a.name), agentInfo(a, model(a)));
    invite.append(label);
  }
  $("agent-count").textContent = String(state.agents.length);
  renderAgentDirectory();
  voiceOptions($("agent-form").elements.voice, "", state.agents, {
    lockUsed: true,
  });
  updateInviteSelection();
  if (!state.agents.length) {
    list.append(empty("No agents yet", "Create your first agent."));
    invite.append(empty("No agents available", "Create one to invite it."));
  }
}
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
    const item = node("div", undefined, "history-item");
    const open = button(m.goal, () => openMeeting(m));
    if (m === current) open.setAttribute("aria-current", "true");
    item.append(
      open,
      node("p", [m.status, m.createdAt && new Date(m.createdAt).toLocaleDateString(), m.participants.map((agent) => agent.name).join(", ")].filter(Boolean).join(" · "), "muted small"),
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
  updateInviteSelection();
});
function renderTeam() {
  $("team").replaceChildren();
  if (!current) return;
  for (const a of current.participants) {
    const card = node("div", undefined, "participant");
    card.dataset.agent = a.id;
    card.append(
      avatar(a.name),
      node("strong", a.name),
      node(
        "small",
        a.skills.map((s) => s.name).join(" · ") || "No skills",
        "muted",
      ),
    );
    const select = node("select"),
      model = node("input");
    modelOptions(select, a.provider);
    select.setAttribute("aria-label", a.name + " provider");
    model.value = a.model;
    model.placeholder = "Model name";
    model.setAttribute("aria-label", a.name + " model");
    select.addEventListener("change", () => {
      a.provider = select.value;
      a.model = defaults[a.provider];
      model.value = a.model;
      void save();
    });
    model.addEventListener("change", () => {
      a.model = model.value.trim() || defaults[a.provider];
      model.value = a.model;
      void save();
    });
    const voice = node("select");
    voice.setAttribute("aria-label", a.name + " voice");
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
    card.append(select, model, voice);
    $("team").append(card);
  }
}
function renderTranscript() {
  $("transcript").replaceChildren();
  if (!current) return;
  for (const m of current.transcript) {
    const host = m.speaker === "Host",
      row = node("article", undefined, host ? "message host" : "message"),
      content = node("div", undefined, "message-body"),
      meta = node("div", undefined, "meta"),
      line = node("div", undefined, "bubble-line"),
      listen = node("button", undefined, "play");
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
  $("status").dataset.status = current.status;
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
  if (current.status === "running") current.status = "paused";
  $("new-panel").hidden = true;
  $("meeting-panel").hidden = false;
  document.body.classList.add("meeting-active");
  renderMode();
  $("goal").textContent = m.goal;
  $("meeting-description").textContent = m.description || "No description";
  $("agenda").textContent = m.agenda || "No agenda";
  $("meeting-agents").textContent = m.participants.map((agent) => agent.name).join(", ");
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
  pause();
  current = null;
  document.body.classList.remove("meeting-active");
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
      const result = await request(
        "/api/turn",
        "POST",
        { agent, meeting: context },
        ctrl.signal,
      );
      if (token !== revision || ctrl.signal.aborted) break;
      addMessage(
        agent.name,
        result.text,
        names[agent.provider] + (agent.model ? " / " + agent.model : ""),
      );
      m.cursor = (m.cursor ?? 0) + 1;
      turns++;
      void save();
      if ($("voice-output").checked) {
        renderStatus(agent.name + " is speaking");
        try {
          await speak(result.text, agent.voice, ctrl.signal);
        } catch (e) {
          if (!ctrl.signal.aborted) $("audio-note").textContent = e.message;
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
  const f = e.currentTarget,
    data = new FormData(f);
  try {
    const skills = [];
    for (const file of f.elements.skills.files) {
      if (file.size > 12000)
        throw new Error("Skill files must be under 12 KB for this version.");
      skills.push({ name: file.name, text: await file.text() });
    }
    if (String(data.get("skillText")).trim())
      skills.push({ name: "Custom skill", text: data.get("skillText") });
    const agent = normalizeAgent({
      id: crypto.randomUUID(),
      name: data.get("name"),
      provider: data.get("provider"),
      model:
        String(data.get("model")).trim() || defaults[data.get("provider")],
      voice: data.get("voice"),
      instructions: data.get("instructions"),
      skills,
    });
    state.agents.push(agent);
    assignVoices(state.agents);
    f.reset();
    resetAgentModel();
    $("create-agent").open = false;
    renderAgents();
    await save();
  } catch (e) {
    error(e.message);
  }
});
$("agent-form").elements.provider.addEventListener("change", (e) => {
  $("agent-form").elements.model.value = defaults[e.target.value];
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
    // Agents saved without a model get the default, so the choice is always visible.
    for (const agent of [
      ...state.agents,
      ...state.meetings.flatMap((m) => m.participants),
    ])
      agent.model ||= defaults[agent.provider] ?? "";
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
function resetAgentModel() {
  const { provider, model } = $("agent-form").elements;
  modelOptions(provider, preferredProvider);
  model.value = defaults[preferredProvider];
}
/** Start new agents on a connected provider and an installed model. */
async function chooseDefaults() {
  const result = await request("/api/models").catch(() => null);
  if (!result) return;
  const installed = result.ollama.models.map((m) => m.name);
  if (installed.length && !installed.includes(defaults.ollama))
    defaults.ollama = installed[0];
  const served = result.inference.models.map((m) => m.id);
  if (served.length && !served.includes(defaults["openai-compatible"]))
    defaults["openai-compatible"] = served[0];
  const connected = (cli) => config.cli && cli?.authenticated;
  preferredProvider = connected(result.claude)
    ? "claude"
    : connected(result.codex)
      ? "codex"
      : installed.length
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
      config.whisper ? "success" : "",
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
  for (const item of ["meetings", "agents", "settings"]) {
    $("nav-" + item).classList.toggle("selected", item === view);
    $("nav-" + item).setAttribute("aria-pressed", String(item === view));
  }
  clearTimeout(modelPoll);
  if (view === "settings") void refreshModels();
}
function renderAgentDirectory() {
  $("undo-delete").hidden = !state.deletedAgents?.length;
  $("agent-directory").replaceChildren();
  for (const agent of state.agents) {
    const card = node("article", undefined, "provider-card");
    card.append(
      node("strong", agent.name),
      node(
        "p",
        names[agent.provider] + (agent.model ? " · " + agent.model : ""),
      ),
      node("p", agent.instructions || "No instructions yet."),
      button("View details ↗", () => viewAgent(agent)),
    );
    $("agent-directory").append(card);
  }
  if (!state.agents.length)
    $("agent-directory").append(
      node("p", "No agents yet. Create one to assemble your team.", "muted"),
    );
}
/** @param {{id:string,name:string,provider:string,model:string,voice:string,instructions:string,skills:Array<{name:string,text:string}>}} agent */
function viewAgent(agent) {
  viewedAgentId = agent.id;
  $("agent-detail-name").textContent = agent.name;
  $("agent-detail").replaceChildren();
  const detail = (title, text) =>
    $("agent-detail").append(node("h3", title), node("p", text));
  detail(
    "MODEL",
    names[agent.provider] + (agent.model ? " / " + agent.model : ""),
  );
  detail("INSTRUCTIONS", agent.instructions || "No instructions.");
  detail("VOICE", agent.voice ? voiceName(agent.voice) : "Default local voice");
  for (const skill of agent.skills) detail(skill.name, skill.text);
  $("agent-dialog").showModal();
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
  $("create-agent").open = true;
  $("agent-library").scrollIntoView({ block: "start" });
  $("agent-form").elements.name.focus();
});
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
    const card = (title, description) => {
      const el = node("div", undefined, "provider-card");
      el.append(node("strong", title), node("p", description));
      $("provider-status").append(el);
    };
    card(
      "Ollama",
      result.ollama.available
        ? "Connected · local model service"
        : "Unavailable · start the Ollama service",
    );
    card(
      "Hugging Face / compatible",
      result.inference.available
        ? "Connected · inference service"
        : "Offline · optional inference profile is not running",
    );
    for (const [key, title] of [
      ["codex", "ChatGPT / Codex CLI"],
      ["claude", "Claude Code CLI"],
    ]) {
      const cli = result[key];
      card(
        title,
        !cli.installed
          ? "Not installed in this Quorum runtime"
          : !cli.authenticated
            ? "Installed · login not verified"
            : !cli.enabled
              ? "Authenticated · CLI access disabled"
              : result.cliBridge
                ? "Authenticated · connected through Mac CLI bridge"
                : "Authenticated · CLI access enabled",
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
          (host?.authenticated
            ? "Authenticated on host"
            : host?.installed
              ? "Installed; login not verified"
              : "Not installed") +
            " · checked " +
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
      " roles added. These use qwen2.5:3b; install it in Settings if needed.";
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
  $("mode-chat").setAttribute("aria-pressed", String(!voice));
  $("mode-voice").setAttribute("aria-pressed", String(voice));
  $("voice-host").hidden = !voice;
  $("voice-output").checked = voice;
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
