import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function runProcess(command, args, { input, cwd, signal, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, { cwd, signal, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', size = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk, stderr) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) { child.kill(); reject(new Error('Process output limit exceeded')); return; }
      if (stderr) err += chunk; else out += chunk;
    };
    child.stdout.on('data', c => collect(c, false));
    child.stderr.on('data', c => collect(c, true));
    child.on('error', error => reject(error.code === 'ENOENT'
      ? Object.assign(new Error(command + ' was not found. Install it or configure its path, then restart Quorum.'), { code: 'ENOENT' })
      : error));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (code === 0) { resolve(out); return; }
      // CLIs report errors on either stream, so keep the end of both.
      const detail = [out, err].map(text => text.trim().slice(-600)).filter(Boolean).join('\n');
      reject(Object.assign(new Error(command + ' failed (exit ' + code + '). ' + (detail || 'It printed no output.')), { stdout: out }));
    });
    child.stdin.end(input);
  });
}
const claudeBin = () => process.env.CLAUDE_BIN ?? 'claude';
export async function claudeStatus(signal = AbortSignal.timeout(5000)) {
  let output;
  try { output = await runProcess(claudeBin(), ['auth', 'status', '--json'], { signal }); }
  catch (error) {
    if (error.code === 'ENOENT') return { ready: false, message: 'Claude Code was not found. Install it or set CLAUDE_BIN.' };
    output = error.stdout;
  }
  // Only the signed-in flag leaves this function; the rest of the status holds account details.
  try {
    const { loggedIn } = JSON.parse(output);
    if (loggedIn === true) return { ready: true };
    if (loggedIn === false) return { ready: false, message: 'Claude Code is not signed in. Run: claude auth login' };
  } catch {}
  return { ready: false, message: 'Claude Code status could not be checked. Run: claude auth status' };
}
async function runClaude(model, prompt, cwd, signal) {
  // A file keeps large skill sets clear of command-line length limits.
  const systemFile = join(cwd, 'system-prompt.txt');
  await writeFile(systemFile, prompt.system, { mode: 0o600 });
  return runProcess(claudeBin(), [
    '-p',
    '--safe-mode',
    '--no-session-persistence',
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(model ? ['--model', model] : []),
  ], { cwd, signal, input: 'Meeting data:\n' + prompt.user });
}
async function requestJSON(url, payload, signal, token) {
  const response = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Model endpoint returned HTTP ' + response.status);
  return response.json();
}
function endpoint(base, path) { return base.replace(/\/+$/, '') + path; }
export async function respond(agent, prompt, signal) {
  const messages = [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];
  let answer;
  switch (agent.provider) {
    case 'demo':
      return '[Demo only] ' + agent.name + ': Let us identify a concrete next step and ask the host what evidence would make the outcome satisfactory.';
    case 'ollama': {
      const result = await requestJSON(endpoint(process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', '/api/chat'),
        { model: agent.model, messages, stream: false, options: { num_predict: 700 } }, signal);
      answer = result.message?.content;
      break;
    }
    case 'openai-compatible': {
      const result = await requestJSON(endpoint(process.env.QUORUM_OPENAI_URL ?? 'http://127.0.0.1:8080/v1', '/chat/completions'),
        { model: agent.model, messages, max_tokens: 700, stream: false }, signal, process.env.QUORUM_OPENAI_KEY);
      answer = result.choices?.[0]?.message?.content;
      break;
    }
    case 'claude':
    case 'codex': {
      if (process.env.QUORUM_ENABLE_CLI !== '1') throw new Error('CLI providers are disabled. Restart with npm run start:cli (sets QUORUM_ENABLE_CLI=1) only if you trust your installed CLI and skills.');
      const cwd = await mkdtemp(join(tmpdir(), 'quorum-agent-'));
      try {
        if (agent.provider === 'claude') {
          answer = await runClaude(agent.model, prompt, cwd, signal);
        } else {
          const input = prompt.system + '\n\nMeeting data:\n' + prompt.user;
          answer = await runProcess('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', ...(agent.model ? ['--model', agent.model] : []), '-'], { cwd, input, signal });
        }
      } finally { await rm(cwd, { recursive: true, force: true }); }
      break;
    }
    default: throw new Error('Unsupported provider');
  }
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('The model returned no text');
  return answer.trim().slice(0, 16000);
}
