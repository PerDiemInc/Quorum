import test from "node:test";
import assert from "node:assert/strict";
import { chooseModel } from "../src/models.js";

const signal = () => AbortSignal.timeout(2000);
const chat = (name, size, extra = {}) => ({
  name,
  size,
  capabilities: ["completion"],
  ...extra,
});

test("CLI and demo agents get a model without any lookup", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("no lookup"));
  const pick = (provider, model = "") =>
    chooseModel({ provider, model }, signal());
  assert.equal(await pick("demo", "stale"), "");
  assert.equal(await pick("claude"), "sonnet");
  assert.equal(await pick("codex"), "gpt-6.2-sol");
  assert.equal(await pick("claude", "opus"), "opus");
});

test("Ollama picks the largest suitable local chat model", async (t) => {
  let models = [
    chat("small:1b", 1e9),
    chat("medium:latest", 3e9),
    chat("huge:70b", 40e9),
    { name: "nomic-embed-text:latest", size: 5e9, capabilities: ["embedding"] },
    chat("hosted:cloud", 7e9),
    chat("proxied:7b", 6e9, { remote_host: "https://example.test" }),
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json({ models }));
  const pick = (model = "") =>
    chooseModel({ provider: "ollama", model }, signal());
  assert.equal(await pick(), "medium:latest");
  assert.equal(await pick("small:1b"), "small:1b");
  assert.equal(await pick("medium"), "medium");
  assert.equal(await pick("uninstalled:7b"), "medium:latest");
  models = [chat("huge:70b", 40e9), chat("large:30b", 20e9)];
  assert.equal(await pick(), "large:30b");
  models = [];
  await assert.rejects(pick(), /Download one in Settings/);
});

test("an unreachable Ollama keeps a pinned model and explains a blank one", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  const pick = (model) =>
    chooseModel({ provider: "ollama", model }, signal());
  assert.equal(await pick("pinned:1b"), "pinned:1b");
  await assert.rejects(pick(""), /Ollama is unavailable/);
});

test("compatible endpoints use their first chat model unless one is pinned", async (t) => {
  let data = [{ id: "text-embedding" }, { id: "local-hf" }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
  const pick = (model = "") =>
    chooseModel({ provider: "openai-compatible", model }, signal());
  assert.equal(await pick(), "local-hf");
  assert.equal(await pick("unlisted"), "unlisted");
  data = [];
  await assert.rejects(pick(), /lists none/);
});
