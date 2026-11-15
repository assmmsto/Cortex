import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionToken } from './_session.mjs';
// §34: الرمز يُقرأ لحظياً من نفس خندق الواجهة (data/session.token أو /api/session)
// — بدل الاعتماد على متغير نطاقي يغيب عن الدوال العامة.
let __TOKEN_CACHE = null;
async function __sess() {
  if (__TOKEN_CACHE) return { 'X-Cortex-Session': __TOKEN_CACHE };
  __TOKEN_CACHE = await sessionToken({ base: process.env.CORTEX_BASE || 'http://127.0.0.1:3737' });
  return __TOKEN_CACHE ? { 'X-Cortex-Session': __TOKEN_CACHE } : {};
}


const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function norm(vec) {
  const mag = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map(x => x / mag);
}
function embedText(text) {
  const t = String(text || '').toLowerCase();
  const words = t.split(/[^a-z0-9\u0600-\u06ff]+/).filter(Boolean);
  const count = (arr) => words.filter(w => arr.includes(w)).length;
  return norm([
    count(['gateway','api']),
    count(['auth','jwt','token','tokens']),
    count(['retry','retries','backoff']),
    count(['ui','theme','design']),
    count(['memory','retrieval','embedding','embeddings']),
    count(['project','roadmap','plan','sprint']),
    count(['risk','risks']),
    words.length || 1
  ]);
}
function startMockEmbeddingServer(port) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'mock-embed-v1' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const data = input.map((text, index) => ({ object: 'embedding', index, embedding: embedText(text) }));
      return res.end(JSON.stringify({ object: 'list', data, model: body.model || 'mock-embed-v1' }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
async function waitFor(url, ms = 7000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${url}`);
}
function startCortex(root, port) {
  // خادم تمثيلات وهمي محلي في هذا الاختبار فقط — باب الاستثناء المحدود للمضيف المحلي
  return spawn('node', ['server.js'], { cwd: projectDir, env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_ALLOW_LOCAL_URL: '1' } });
}

test('Retrieval engine uses persistent configurable embeddings with rebuild and restart persistence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-retrieval-'));
  const embedPort = 3940;
  const appPort = 3941;
  const embedServer = await startMockEmbeddingServer(embedPort);
  t.after(() => embedServer.close());

  let child = startCortex(root, appPort);
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${appPort}/api/status`);
  // §34: الرمز من الخادم المؤقت نفسه (كل اختبار يقلع خادمه)
  const TOKEN = await sessionToken({ base: `http://127.0.0.1:${appPort}`, appRoot: root });

  const settingsPayload = {
    ai: { provider: 'mock', model: 'cortex-mock', baseUrl: 'http://localhost:11434', openaiBaseUrl: 'https://api.openai.com', apiKey: '', temperature: 0.2 },
    memory: {
      retrieval: {
        provider: 'openai-compatible',
        model: 'mock-embed-v1',
        baseUrl: `http://127.0.0.1:${embedPort}`,
        apiKey: 'test-key',
        chunkSize: 500,
        chunkOverlap: 50,
        topK: 6,
        rerankStrategy: 'mmr'
      }
    }
  };
  let r = await fetch(`http://127.0.0.1:${appPort}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify(settingsPayload)
  });
  let j = await r.json();
  assert.equal(j.memory.retrieval.model, 'mock-embed-v1');

  const notes = [
    { title: 'API Gateway Reliability', content: '# API Gateway Reliability\n\nProject: sprint\n\nUse gateway retries with auth token refresh and backoff.\n\n- [ ] Validate gateway retry policy' },
    { title: 'Auth Service Tokens', content: '# Auth Service Tokens\n\nProject: sprint\n\nJWT auth tokens should rotate safely.\n\nRisk: stale auth token invalidation.' },
    { title: 'UI Theme Polish', content: '# UI Theme Polish\n\nProject: design\n\nImprove UI theme contrast and spacing.' }
  ];
  for (const note of notes) {
    r = await fetch(`http://127.0.0.1:${appPort}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await __sess()) },
      body: JSON.stringify(note)
    });
    j = await r.json();
    assert.ok(j.note.id);
  }

  r = await fetch(`http://127.0.0.1:${appPort}/api/retrieval/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ force: true })
  });
  j = await r.json();
  assert.equal(j.rebuilt, true);
  assert.equal(j.index.provider, 'openai-compatible');
  assert.equal(j.index.model, 'mock-embed-v1');
  assert.ok(j.index.entryCount >= 3);

  r = await fetch(`http://127.0.0.1:${appPort}/api/retrieval/status`);
  const status1 = await r.json();
  assert.equal(status1.dirty, false);
  assert.equal(status1.provider, 'openai-compatible');
  assert.equal(status1.model, 'mock-embed-v1');
  assert.ok(status1.builtAt);

  r = await fetch(`http://127.0.0.1:${appPort}/api/retrieval/search?q=${encodeURIComponent('gateway auth retries')}&project=sprint`);
  j = await r.json();
  assert.equal(j.mode, 'hybrid-memory');
  assert.equal(j.provider, 'openai-compatible');
  assert.equal(j.rerankStrategy, 'mmr');
  assert.ok(j.results.length >= 2);
  assert.equal(j.results[0].title, 'API Gateway Reliability');
  assert.ok(j.results.some(x => x.title === 'Auth Service Tokens'));
  assert.ok(j.results.every(x => typeof x.rerankScore === 'number'));

  const indexPath = path.join(root, 'data', 'vector-index.json');
  const indexRaw = await (await import('node:fs/promises')).readFile(indexPath, 'utf8');
  const indexJson = JSON.parse(indexRaw);
  assert.ok(indexJson.entryCount >= 3);
  const builtAtBefore = indexJson.builtAt;

  child.kill();
  await new Promise(r => setTimeout(r, 500));
  child = startCortex(root, appPort);
  await waitFor(`http://127.0.0.1:${appPort}/api/status`);

  r = await fetch(`http://127.0.0.1:${appPort}/api/retrieval/status`);
  const status2 = await r.json();
  assert.equal(status2.builtAt, builtAtBefore);
  assert.equal(status2.entryCount, indexJson.entryCount);
  assert.equal(status2.dirty, false);

  r = await fetch(`http://127.0.0.1:${appPort}/api/search?q=${encodeURIComponent('auth token')}&project=sprint`);
  j = await r.json();
  assert.ok(j.results.length >= 1);
  assert.ok(['API Gateway Reliability', 'Auth Service Tokens'].includes(j.results[0].title));

  await writeFile(path.join(root, 'vault', 'new-memory.md'), '# Retrieval Memory\n\nProject: sprint\n\nEmbeddings persistence note.\n', 'utf8');
  const started = Date.now();
  let dirty = false;
  while (Date.now() - started < 4000) {
    r = await fetch(`http://127.0.0.1:${appPort}/api/retrieval/status`);
    const s = await r.json();
    if (s.dirty) { dirty = true; break; }
    await new Promise(x => setTimeout(x, 120));
  }
  assert.equal(dirty, true);
});
