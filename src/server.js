import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeAgent, makePrompt } from './engine.js';
import { respond } from './providers.js';
import { transcribe, synthesize } from './speech.js';

const port = Number(process.env.PORT ?? 4710);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const dataDir = resolve(process.env.QUORUM_DATA ?? '.quorum');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'quorum.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
const select = db.prepare('SELECT value FROM state WHERE id=1');
const save = db.prepare('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
const assets = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/styles.css',['styles.css','text/css; charset=utf-8']], ['/engine.js',['../src/engine.js','text/javascript; charset=utf-8']]]);
const hosts = new Set(['localhost:' + port, '127.0.0.1:' + port]);
function json(res, status, data) { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); }
async function body(req, limit) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function parseJSON(req, limit = 2_000_000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  try { return JSON.parse((await body(req, limit)).toString('utf8')); }
  catch (err) { if (err.status) throw err; throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
let activeTurn = false;
const server = createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
  if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Local host required' });
  if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== 'http://' + req.headers.host) return json(res, 403, { error: 'Same-origin browser required' });
  const path = new URL(req.url, 'http://localhost').pathname;
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
  try {
    if (req.method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      res.writeHead(200, {'content-type':type}); res.end(await readFile(join(root,file))); return;
    }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, JSON.parse(select.get()?.value ?? '{"agents":[],"meetings":[]}'));
    if (req.method === 'PUT' && path === '/api/state') {
      const data = await parseJSON(req, 12_000_000);
      if (!Array.isArray(data?.agents) || !Array.isArray(data?.meetings)) return json(res, 400, {error:'Invalid state'});
      save.run(JSON.stringify(data)); return json(res, 200, {ok:true});
    }
    if (req.method === 'GET' && path === '/api/config') return json(res,200,{whisper:Boolean(process.env.WHISPER_MODEL),kokoro:Boolean(process.env.KOKORO_URL),cli:process.env.QUORUM_ENABLE_CLI==='1'});
    if (req.method === 'POST' && path === '/api/turn') {
      if (activeTurn) return json(res, 409, {error:'Another model turn is still running. Try again shortly.'});
      const data = await parseJSON(req);
      const agent = normalizeAgent(data.agent);
      if (!data.meeting?.goal || !Array.isArray(data.meeting.transcript) || !Array.isArray(data.meeting.participants)) return json(res,400,{error:'Meeting goal and context required'});
      if (activeTurn) return json(res,409,{error:'Another model turn is running'});
      activeTurn = true;
      try { const text = await respond(agent, makePrompt(agent,data.meeting),signal); if (!abort.signal.aborted) return json(res,200,{text}); }
      finally { activeTurn = false; }
      return;
    }
    if (req.method === 'POST' && path === '/api/transcribe') {
      if (!req.headers['content-type']?.startsWith('audio/')) return json(res,415,{error:'Expected audio'});
      const audio = await body(req,20_000_000);
      if (!audio.length) return json(res,400,{error:'No audio recorded'});
      const text = await transcribe(audio,signal);
      return json(res,200,{text});
    }
    if (req.method === 'POST' && path === '/api/speech') {
      const data = await parseJSON(req,100_000);
      const audio = await synthesize(String(data.text ?? '').slice(0,16000),String(data.voice ?? '').slice(0,100),signal);
      res.writeHead(200,{'content-type':'audio/mpeg'}); res.end(audio); return;
    }
    return json(res,404,{error:'Not found'});
  } catch (err) {
    if (!res.destroyed && !res.headersSent) json(res,err.status ?? 400,{error:err.message || 'Request failed'});
    else if (!res.destroyed) res.end();
  }
});
server.listen(port,'127.0.0.1',()=>console.log('Quorum is listening at http://127.0.0.1:' + port));
