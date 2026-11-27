import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./providers.js";

/**
 * Container speech uses an OpenAI-compatible endpoint; native installs retain whisper.cpp.
 * @param {Buffer} audio
 * @param {AbortSignal} signal
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
export async function transcribe(audio, signal, mimeType = "audio/webm") {
  if (process.env.WHISPER_URL) {
    const form = new FormData();
    form.set("file", new Blob([audio], { type: mimeType }), "recording");
    form.set(
      "model",
      process.env.WHISPER_REMOTE_MODEL ?? "Systran/faster-whisper-tiny.en",
    );
    form.set("response_format", "json");
    const response = await fetch(
      process.env.WHISPER_URL.replace(/\/+$/, "") + "/audio/transcriptions",
      {
        method: "POST",
        body: form,
        signal,
      },
    );
    if (!response.ok)
      throw new Error("Whisper returned HTTP " + response.status);
    const result = await response.json();
    if (typeof result.text !== "string")
      throw new Error("Whisper returned an invalid transcription");
    return result.text.trim();
  }
  const model = process.env.WHISPER_MODEL;
  if (!model)
    throw new Error(
      "Set WHISPER_MODEL to a downloaded whisper.cpp model file and restart Quorum.",
    );
  const cwd = await mkdtemp(join(tmpdir(), "quorum-audio-"));
  try {
    const input = join(cwd, "recording");
    const wav = join(cwd, "recording.wav");
    const output = join(cwd, "transcript");
    await writeFile(input, audio, { mode: 0o600 });
    await runProcess(
      process.env.FFMPEG_BIN ?? "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      { cwd, signal },
    );
    await runProcess(
      process.env.WHISPER_BIN ?? "whisper-cli",
      ["-m", model, "-f", wav, "-l", "auto", "-otxt", "-of", output, "-nt"],
      { cwd, signal },
    );
    return (await readFile(output + ".txt", "utf8")).trim();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
export async function synthesize(text, voice, signal) {
  if (!process.env.KOKORO_URL) throw new Error("Kokoro is not configured");
  const response = await fetch(
    process.env.KOKORO_URL.replace(/\/+$/, "") + "/audio/speech",
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice: voice || "af_heart",
        response_format: "mp3",
      }),
    },
  );
  if (!response.ok) throw new Error("Kokoro returned HTTP " + response.status);
  return Buffer.from(await response.arrayBuffer());
}
