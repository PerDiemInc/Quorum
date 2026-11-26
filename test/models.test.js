import test from "node:test";
import assert from "node:assert/strict";
import { installModel, modelSettings } from "../src/models.js";
import { transcribe } from "../src/speech.js";

test("model downloads validate names, serialize jobs, and report streamed completion", async (t) => {
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/api/pull")) {
      assert.deepEqual(JSON.parse(options.body), {
        model: "qwen2.5:0.5b",
        stream: true,
      });
      await ready;
      return new Response(
        '{"total":100,"completed":100}\n{"status":"success"}\n',
      );
    }
    return new Response('{"models":[],"data":[]}');
  });
  for (const name of ["", "../bad", "model;echo hi", "https://evil.test/model"])
    assert.throws(() => installModel(name));
  assert.equal(installModel("qwen2.5:0.5b").status, "downloading");
  assert.throws(() => installModel("another"), { status: 409 });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { pull } = await modelSettings();
  assert.equal(pull.status, "complete");
  assert.equal(pull.completed, 100);
});

test("failed model streams surface an error and allow retry", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url) =>
      new Response(
        String(url).endsWith("/api/pull")
          ? '{"error":"model not found"}\n'
          : "{}",
      ),
  );
  installModel("missing:tag");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await modelSettings()).pull.error, "model not found");
  assert.doesNotThrow(() => installModel("retry:tag"));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("container transcription preserves audio type and validates the response", async (t) => {
  const original = process.env.WHISPER_URL;
  process.env.WHISPER_URL = "http://whisper:8000/v1/";
  t.after(() => {
    if (original === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = original;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://whisper:8000/v1/audio/transcriptions");
    assert.equal(options.body.get("file").type, "audio/mp4");
    assert.equal(options.body.get("response_format"), "json");
    return new Response('{"text":" hello "}');
  });
  assert.equal(
    await transcribe(
      Buffer.from("audio"),
      new AbortController().signal,
      "audio/mp4",
    ),
    "hello",
  );
});
