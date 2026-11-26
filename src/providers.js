import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function runProcess(
  command,
  args,
  { input, cwd, signal, maxBytes = 2_000_000, includeStderr = false } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command, args, {
      cwd,
      signal,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "",
      size = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (chunk, stderr) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        child.kill();
        reject(new Error("Process output limit exceeded"));
        return;
      }
      if (stderr) err += chunk;
      else out += chunk;
    };
    child.stdout.on("data", (c) => collect(c, false));
    child.stderr.on("data", (c) => collect(c, true));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolve(includeStderr ? out + err : out);
      else
        reject(
          new Error(
            command +
              " failed (exit " +
              code +
              "). Check the local terminal and configuration.",
          ),
        );
    });
    child.stdin.end(input);
  });
}
async function requestJSON(url, payload, signal, token) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error("Model endpoint returned HTTP " + response.status);
  return response.json();
}
function endpoint(base, path) {
  return base.replace(/\/+$/, "") + path;
}
export async function respond(agent, prompt, signal) {
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  let answer;
  switch (agent.provider) {
    case "demo":
      return (
        "[Demo only] " +
        agent.name +
        ": Let us identify a concrete next step and ask the host what evidence would make the outcome satisfactory."
      );
    case "ollama": {
      const result = await requestJSON(
        endpoint(
          process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
          "/api/chat",
        ),
        {
          model: agent.model,
          messages,
          stream: false,
          options: { num_predict: 700 },
        },
        signal,
      );
      answer = result.message?.content;
      break;
    }
    case "openai-compatible": {
      const result = await requestJSON(
        endpoint(
          process.env.QUORUM_OPENAI_URL ?? "http://127.0.0.1:8080/v1",
          "/chat/completions",
        ),
        { model: agent.model, messages, max_tokens: 700, stream: false },
        signal,
        process.env.QUORUM_OPENAI_KEY,
      );
      answer = result.choices?.[0]?.message?.content;
      break;
    }
    case "claude":
    case "codex": {
      if (process.env.QUORUM_CLI_BRIDGE_URL) {
        const result = await requestJSON(
          endpoint(process.env.QUORUM_CLI_BRIDGE_URL, "/respond"),
          { agent, prompt },
          signal,
          process.env.QUORUM_CLI_BRIDGE_TOKEN,
        );
        answer = result.text;
        break;
      }
      if (process.env.QUORUM_ENABLE_CLI !== "1")
        throw new Error(
          "CLI providers are disabled. Set QUORUM_ENABLE_CLI=1 only if you trust your installed CLI and skills.",
        );
      const cwd = await mkdtemp(join(tmpdir(), "quorum-agent-"));
      const input = prompt.system + "\n\nMeeting data:\n" + prompt.user;
      try {
        if (agent.provider === "claude") {
          answer = await runProcess(
            "claude",
            [
              "-p",
              "--tools",
              "",
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              ...(agent.model ? ["--model", agent.model] : []),
            ],
            { cwd, input, signal },
          );
        } else {
          answer = await runProcess(
            "codex",
            [
              "exec",
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "--ephemeral",
              ...(agent.model ? ["--model", agent.model] : []),
              "-",
            ],
            { cwd, input, signal },
          );
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
      break;
    }
    default:
      throw new Error("Unsupported provider");
  }
  if (typeof answer !== "string" || !answer.trim())
    throw new Error("The model returned no text");
  return answer.trim().slice(0, 16000);
}
