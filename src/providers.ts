import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, MeetingContext, Prompt } from "./engine.ts";

/** CLAUDE_BIN covers a claude that is not on the server's PATH. */
export const cliBin = (command: string) =>
  command === "claude" ? process.env.CLAUDE_BIN || "claude" : command;

interface RunOptions {
  input?: string;
  cwd?: string;
  signal?: AbortSignal;
  maxBytes?: number;
  includeStderr?: boolean;
}
export function runProcess(
  command: string,
  args: string[],
  { input, cwd, signal, maxBytes = 2_000_000, includeStderr = false }: RunOptions = {},
): Promise<string> {
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
    const collect = (chunk: string, stderr: boolean) => {
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
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") return reject(error);
      reject(
        Object.assign(
          new Error(
            command +
              " was not found. Install it or configure its path, then restart Quorum.",
          ),
          { code: "ENOENT" },
        ),
      );
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolve(includeStderr ? out + err : out);
      else {
        // CLIs report problems such as an unknown model on stdout, so keep both streams.
        const detail = [out, err]
          .map((text) => text.trim().slice(-600))
          .filter(Boolean)
          .join("\n");
        reject(
          new Error(
            command +
              " failed (exit " +
              code +
              "). " +
              (detail || "Check the local terminal and configuration."),
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}
async function requestJSON(
  url: string,
  payload: unknown,
  signal?: AbortSignal,
  token?: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.json().then(
      (body) => (body as { error?: unknown } | null)?.error,
      () => null,
    );
    throw Object.assign(
      new Error(
        "Model endpoint returned HTTP " +
          response.status +
          (typeof detail === "string" ? ": " + detail.slice(0, 1300) : ""),
      ),
      // A busy endpoint stays distinguishable so the browser can retry the turn.
      response.status === 409 ? { status: 409 } : {},
    );
  }
  return response.json();
}
// Placeholders that differ from turn to turn, so a demo meeting reads as a sequence.
const DEMO_LINES = [
  "Let us identify a concrete next step and ask the host what evidence would make the outcome satisfactory.",
  "Which assumption are we least sure about? I suggest we name it before going further.",
  "I propose one owner and a date for the next step, then we check what changed.",
  "What would make us stop? Agreeing on that now keeps the plan honest.",
  "Host, which constraint matters most here: time, cost or quality?",
];
function endpoint(base: string, path: string) {
  return base.replace(/\/+$/, "") + path;
}
/** @param options a later attempt asks local models for more variety */
export async function respond(
  agent: Pick<Agent, "name" | "provider" | "model">,
  prompt: Prompt,
  signal?: AbortSignal,
  { attempt = 0 }: { attempt?: number } = {},
): Promise<string> {
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  let answer: unknown;
  switch (agent.provider) {
    case "demo": {
      const context = JSON.parse(prompt.user) as MeetingContext;
      const turn = (context.transcript?.length ?? 0) % DEMO_LINES.length;
      return "[Demo only] " + agent.name + ": " + DEMO_LINES[turn];
    }
    case "ollama": {
      const result = (await requestJSON(
        endpoint(
          process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
          "/api/chat",
        ),
        {
          model: agent.model,
          messages,
          stream: false,
          options: {
            num_predict: 700,
            // The default window can cut off the instructions of a long meeting.
            num_ctx: 8192,
            temperature: 0.8 + attempt * 0.2,
            repeat_penalty: 1.15,
            repeat_last_n: 512,
          },
        },
        signal,
      )) as { message?: { content?: unknown } };
      answer = result.message?.content;
      break;
    }
    case "openai-compatible": {
      const result = (await requestJSON(
        endpoint(
          process.env.QUORUM_OPENAI_URL ?? "http://127.0.0.1:8080/v1",
          "/chat/completions",
        ),
        {
          model: agent.model,
          messages,
          max_tokens: 700,
          stream: false,
          temperature: 0.8 + attempt * 0.2,
          frequency_penalty: 0.5,
        },
        signal,
        process.env.QUORUM_OPENAI_KEY,
      )) as { choices?: Array<{ message?: { content?: unknown } }> };
      answer = result.choices?.[0]?.message?.content;
      break;
    }
    case "claude":
    case "codex": {
      if (process.env.QUORUM_CLI_BRIDGE_URL) {
        const result = (await requestJSON(
          endpoint(process.env.QUORUM_CLI_BRIDGE_URL, "/respond"),
          { agent, prompt },
          signal,
          process.env.QUORUM_CLI_BRIDGE_TOKEN,
        ).catch((error) => {
          // fetch rejects with a TypeError only when it cannot connect at all.
          if (!(error instanceof TypeError)) throw error;
          throw new Error(
            "The Mac CLI bridge is not reachable. Start it with npm run bridge, then try again.",
          );
        })) as { text?: unknown };
        answer = result.text;
        break;
      }
      if (process.env.QUORUM_ENABLE_CLI !== "1")
        throw new Error(
          "CLI providers are disabled. Restart with npm run start:cli only if you trust your installed CLI and skills.",
        );
      const cwd = await mkdtemp(join(tmpdir(), "quorum-agent-"));
      try {
        if (agent.provider === "claude") {
          const systemFile = join(cwd, "system-prompt.txt");
          await writeFile(systemFile, prompt.system, { mode: 0o600 });
          answer = await runProcess(
            cliBin("claude"),
            [
              "-p",
              // No personal CLAUDE.md, skills, plugins or hooks in a meeting turn.
              "--safe-mode",
              "--no-session-persistence",
              "--system-prompt-file",
              systemFile,
              "--tools",
              "",
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              ...(agent.model ? ["--model", agent.model] : []),
            ],
            { cwd, input: "Meeting data:\n" + prompt.user, signal },
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
            {
              cwd,
              input: prompt.system + "\n\nMeeting data:\n" + prompt.user,
              signal,
            },
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
