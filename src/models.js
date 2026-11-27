import { readFile } from "node:fs/promises";
import { cliBin, runProcess } from "./providers.js";

/** @typedef {{name: string, status: string, completed?: number, total?: number, error?: string}} ModelPull */
/** @type {ModelPull | null} */
let pull = null;
const ollamaURL = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

/** Models used for CLI agents that have no pinned model. */
const cliModels = { claude: "sonnet", codex: "gpt-6.2-sol" };
// Larger weights are impractically slow, or do not fit, on container CPU inference.
const AUTO_MAX_BYTES = 8e9;
const openaiURL = () =>
  (process.env.QUORUM_OPENAI_URL ?? "http://127.0.0.1:8080/v1").replace(
    /\/+$/,
    "",
  );

/** Read a server-configured model list, or null when it cannot be read. */
async function listModels(url, key, signal, token) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    if (!response.ok) return null;
    const models = (await response.json())[key];
    return Array.isArray(models) ? models : null;
  } catch {
    return null;
  }
}

/** Largest local chat model within the size limit, otherwise the smallest one.
 * Embedding models cannot chat, and cloud models would send meeting data off this machine.
 */
function bestOllamaModel(models) {
  const local = models
    .filter(
      (m) =>
        !m.remote_host &&
        !/[:-]cloud$/.test(m.name) &&
        (m.capabilities
          ? m.capabilities.includes("completion")
          : !/embed/i.test(m.name)),
    )
    .sort((a, b) => b.size - a.size);
  return (local.find((m) => m.size <= AUTO_MAX_BYTES) ?? local.at(-1))?.name;
}

/** Decide which model answers a turn. A blank agent model means automatic.
 * @param {{provider: string, model: string}} agent
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
export async function chooseModel({ provider, model }, signal) {
  if (provider === "demo") return "";
  if (provider === "claude" || provider === "codex")
    return model || cliModels[provider];
  if (provider === "ollama") {
    const installed = await listModels(
      ollamaURL() + "/api/tags",
      "models",
      signal,
    );
    if (!installed) {
      if (model) return model;
      throw new Error(
        "Cannot choose a model because Ollama is unavailable. Start it and try again.",
      );
    }
    const tagged = (name) =>
      name.split("/").at(-1).includes(":") ? name : name + ":latest";
    // A saved model that is no longer installed falls back to automatic selection.
    if (model && installed.some((m) => tagged(m.name) === tagged(model)))
      return model;
    const best = bestOllamaModel(installed);
    if (!best)
      throw new Error(
        "No local Ollama chat model is installed. Download one in Settings.",
      );
    return best;
  }
  // Compatible endpoints may serve models they do not list, so keep a pinned name.
  if (model) return model;
  const served = await listModels(
    openaiURL() + "/models",
    "data",
    signal,
    process.env.QUORUM_OPENAI_KEY,
  );
  const first = served?.find((m) => !/embed/i.test(m.id))?.id;
  if (!first)
    throw new Error(
      "Cannot choose a model because the compatible endpoint lists none. Check that it is running.",
    );
  return first;
}

/** Probe each provider independently so one offline service cannot hide the others. */
export async function modelSettings() {
  const probe = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return { available: true, data: await response.json() };
    } catch {
      return { available: false, data: null };
    }
  };
  const [ollama, inference, localClaude, localCodex] = await Promise.all([
    probe(ollamaURL() + "/api/tags"),
    probe(openaiURL() + "/models"),
    checkCLI("claude"),
    checkCLI("codex"),
  ]);
  let claude = localClaude,
    codex = localCodex,
    cliBridge = false;
  if (process.env.QUORUM_CLI_BRIDGE_URL) {
    try {
      const response = await fetch(
        process.env.QUORUM_CLI_BRIDGE_URL + "/status",
        {
          headers: {
            authorization: "Bearer " + process.env.QUORUM_CLI_BRIDGE_TOKEN,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("Bridge unavailable");
      const status = await response.json();
      claude = status.claude;
      codex = status.codex;
      cliBridge = true;
    } catch {
      /* The Settings UI must not imply access when the bridge is offline. */
    }
  }
  let hostAccess = null;
  try {
    hostAccess = JSON.parse(
      await readFile(
        process.env.QUORUM_HOST_ACCESS ?? ".quorum/host/access.json",
        "utf8",
      ),
    );
  } catch {
    /* Host checks are optional, never inferred from container state. */
  }
  return {
    hostAccess,
    cliBridge,
    ollama: { available: ollama.available, models: ollama.data?.models ?? [] },
    inference: {
      available: inference.available,
      models: inference.data?.data ?? [],
    },
    claude,
    codex,
    pull,
  };
}

/** Start one bounded download. The URL is server-configured, never supplied by the browser.
 * @param {string} name
 * @returns {ModelPull}
 */
export function installModel(name) {
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(name) ||
    name.length > 150 ||
    name.includes("..")
  ) {
    throw Object.assign(
      new Error("Enter an Ollama model name, for example qwen2.5:0.5b"),
      { status: 400 },
    );
  }
  if (pull?.status === "downloading")
    throw Object.assign(new Error("A model download is already running"), {
      status: 409,
    });
  pull = { name, status: "downloading" };
  const job = pull;
  void (async () => {
    try {
      const response = await fetch(ollamaURL() + "/api/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name, stream: true }),
        signal: AbortSignal.timeout(3_600_000),
      });
      if (!response.ok)
        throw new Error("Ollama returned HTTP " + response.status);
      let pending = "";
      const consume = (line) => {
        if (!line.trim()) return;
        const progress = JSON.parse(line);
        if (progress.error) throw new Error(progress.error);
        if (progress.total) {
          job.total = progress.total;
          job.completed = progress.completed ?? 0;
        }
        if (progress.status === "success") job.status = "complete";
      };
      for await (const chunk of response.body.pipeThrough(
        new TextDecoderStream(),
      )) {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) consume(line);
      }
      consume(pending);
      if (job.status !== "complete")
        throw new Error("Download ended before Ollama confirmed success");
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
    }
  })();
  return job;
}

/** Claude readiness for the header chip. It never includes account details.
 * @returns {Promise<{ready: boolean, disabled?: boolean, message?: string}>}
 */
export async function claudeStatus() {
  const unavailable = (message) => ({ ready: false, message });
  let cli;
  if (process.env.QUORUM_CLI_BRIDGE_URL) {
    try {
      const response = await fetch(
        process.env.QUORUM_CLI_BRIDGE_URL + "/status",
        {
          headers: {
            authorization: "Bearer " + process.env.QUORUM_CLI_BRIDGE_TOKEN,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("Bridge unavailable");
      cli = (await response.json()).claude;
    } catch {
      return unavailable(
        "The Mac CLI bridge is not reachable. Start it with npm run bridge.",
      );
    }
  } else if (process.env.QUORUM_ENABLE_CLI !== "1")
    return {
      ready: false,
      disabled: true,
      message: "Restart with npm run start:cli to use Claude.",
    };
  else cli = await checkCLI("claude");
  if (!cli?.installed)
    return unavailable("Claude Code was not found. Install it or set CLAUDE_BIN.");
  if (!cli.authenticated)
    return unavailable("Claude Code is not signed in. Run claude auth login.");
  return { ready: true };
}

/** @param {'claude' | 'codex'} command */
export async function checkCLI(command) {
  try {
    const version = await runProcess(cliBin(command), ["--version"], {
      signal: AbortSignal.timeout(4000),
    });
    // Authentication checks read status only; never start an inference or expose credentials.
    let authenticated = false;
    try {
      const status = await runProcess(
        cliBin(command),
        command === "claude" ? ["auth", "status"] : ["login", "status"],
        { signal: AbortSignal.timeout(4000), includeStderr: true },
      );
      authenticated =
        command === "claude"
          ? JSON.parse(status).loggedIn === true
          : /Logged in/i.test(status);
    } catch {
      /* Missing/expired login is a distinct state from a missing executable. */
    }
    return {
      installed: true,
      authenticated,
      enabled: process.env.QUORUM_ENABLE_CLI === "1",
      version: version.trim().slice(0, 120),
    };
  } catch {
    return { installed: false, authenticated: false, enabled: false };
  }
}
