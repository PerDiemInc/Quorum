import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respond, claudeStatus } from '../src/providers.js';

// A stand-in for the Claude CLI, so these tests need no install, login or network.
const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  const loggedIn = process.env.FAKE_LOGGED_IN === '1';
  console.log(JSON.stringify({ loggedIn, email: 'person@example.com' }));
  process.exit(loggedIn ? 0 : 1);
}
if (args.includes('bad-model')) {
  console.log('There is an issue with the selected model');
  console.error('warning from stderr');
  process.exit(1);
}
const system = fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
console.log(JSON.stringify({ args, system, input: fs.readFileSync(0, 'utf8') }));
`;
const saved = { ...process.env };
const agent = { name: 'CTO', provider: 'claude', model: '' };
const prompt = { system: 'You are CTO', user: '{"goal":"Design API"}' };
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-test-'));
  await writeFile(join(dir, 'claude'), fake);
  await chmod(join(dir, 'claude'), 0o755);
});
after(async () => {
  process.env = saved;
  await rm(dir, { recursive: true, force: true });
});
function enable() {
  process.env.QUORUM_ENABLE_CLI = '1';
  process.env.CLAUDE_BIN = join(dir, 'claude');
}

test('claude is refused unless CLI providers are enabled', async () => {
  delete process.env.QUORUM_ENABLE_CLI;
  await assert.rejects(respond(agent, prompt), /npm run start:cli/);
});
test('claude runs isolated, with the persona as its system prompt', async () => {
  enable();
  const call = JSON.parse(await respond(agent, prompt));
  assert.equal(call.system, 'You are CTO');
  assert.equal(call.input, 'Meeting data:\n{"goal":"Design API"}');
  for (const flag of ['-p', '--safe-mode', '--no-session-persistence', '--strict-mcp-config']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(!call.args.includes('--model'));
});
test('claude receives the chosen model', async () => {
  enable();
  const { args } = JSON.parse(await respond({ ...agent, model: 'sonnet' }, prompt));
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
});
test('claude failures show what the CLI printed', async () => {
  enable();
  await assert.rejects(respond({ ...agent, model: 'bad-model' }, prompt), /exit 1.*issue with the selected model\nwarning from stderr/);
});
test('a missing claude binary is named', async () => {
  enable();
  process.env.CLAUDE_BIN = join(dir, 'absent');
  await assert.rejects(respond(agent, prompt), /absent was not found/);
  assert.match((await claudeStatus()).message, /not found/);
});
test('status reports sign-in without account details', async () => {
  enable();
  process.env.FAKE_LOGGED_IN = '1';
  assert.deepEqual(await claudeStatus(), { ready: true });
  process.env.FAKE_LOGGED_IN = '0';
  const status = await claudeStatus();
  assert.equal(status.ready, false);
  assert.match(status.message, /claude auth login/);
  assert.doesNotMatch(JSON.stringify(status), /example\.com/);
});
