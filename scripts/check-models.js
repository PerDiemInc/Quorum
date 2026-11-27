// Sends one short request to each model through a running Quorum server.
// Nothing is saved. Claude and Codex requests may count against your plan.

const base = process.env.QUORUM_URL ?? "http://127.0.0.1:4711";
const get = async (path) => {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(path + " returned HTTP " + response.status);
  return response.json();
};
const post = async (path, type, body) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { origin: base, "content-type": type },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "HTTP " + response.status);
  return result;
};

let state, config;
try {
  [state, config] = await Promise.all([get("/api/state"), get("/api/config")]);
} catch (error) {
  console.error(
    "Quorum is not reachable at " + base + " (" + error.message + "). Start it, or set QUORUM_URL.",
  );
  process.exit(1);
}

// Every model your agents and meetings use, plus each provider's automatic choice.
const models = new Map();
const add = (provider, model, use) => {
  if (provider === "demo") return;
  const key = provider + " " + (model || "");
  const entry = models.get(key) ?? { provider, model: model || "", uses: new Set() };
  entry.uses.add(use);
  models.set(key, entry);
};
for (const agent of state.agents) add(agent.provider, agent.model, "agents");
for (const meeting of state.meetings)
  for (const agent of meeting.participants)
    add(agent.provider, agent.model, "meetings");
for (const provider of ["ollama", "openai-compatible", "claude", "codex"])
  if (config.cli || !["claude", "codex"].includes(provider))
    add(provider, "", "automatic");

let failed = 0;
async function check(label, request) {
  const started = Date.now();
  try {
    const result = await request();
    console.log(
      "OK    " + label + (result?.model ? "  → " + result.model : "") + "  " + ((Date.now() - started) / 1000).toFixed(1) + "s",
    );
  } catch (error) {
    failed++;
    console.log("FAIL  " + label + "\n      " + error.message.replace(/\n/g, "\n      "));
  }
}
console.log("Checking models through " + base + "\n");
// One at a time: the server runs a single model turn at once.
for (const { provider, model, uses } of models.values())
  await check(provider + " / " + (model || "auto") + "  (" + [...uses].join(", ") + ")", () =>
    post(
      "/api/turn",
      "application/json",
      JSON.stringify({
        agent: { name: "Check", provider, model, instructions: "Reply with the single word OK.", skills: [] },
        meeting: { goal: "Connection check", participants: [{ name: "Check" }], transcript: [] },
      }),
    ),
  );
if (config.whisper)
  await check("voice transcription (Whisper)", () => {
    // One second of silence as a 16 kHz mono WAV: enough to prove the service answers.
    const wav = Buffer.alloc(44 + 32_000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + 32_000, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24);
    wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32_000, 40);
    return post("/api/transcribe", "audio/wav", wav);
  });
else console.log("SKIP  voice transcription is not configured");
if (config.kokoro)
  await check("natural voices (Kokoro)", async () => {
    const response = await fetch(base + "/api/speech", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ text: "Connection check.", voice: "af_heart" }),
      signal: AbortSignal.timeout(60_000),
    });
    const size = (await response.arrayBuffer()).byteLength;
    if (!response.ok || size < 1000)
      throw new Error("No audio returned (HTTP " + response.status + ")");
  });
else console.log("SKIP  natural voices are not configured");
console.log(failed ? "\n" + failed + " check(s) failed." : "\nAll models are connected.");
process.exitCode = failed ? 1 : 0;
