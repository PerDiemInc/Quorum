import { readFile } from "node:fs/promises";
import { cliBin, runProcess } from "./providers.js";

/** @typedef {{name: string, status: string, completed?: number, total?: number, error?: string}} ModelPull */
/** @type {ModelPull | null} */
let pull = null;
const ollamaURL = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

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
    probe(
      (process.env.QUORUM_OPENAI_URL ?? "http://127.0.0.1:8080/v1").replace(
        /\/+$/,
        "",
      ) + "/models",
    ),
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
