import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function waitFor(url, ms = 7000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

test('Cortex API exposes brain, resolver, agent, backup and dashboard flows', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-api-'));
  const port = 3838 + (process.pid % 1000);
  const child = spawn('node', ['server.js'], { cwd: projectDir, env: { ...process.env, APP_ROOT: root, APP_PORT: String(port) } });
  t.after(async () => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  const base = `http://127.0.0.1:${port}`;
  const TOKEN = await sessionToken({ base: base, appRoot: root });

  let r = await fetch(`http://127.0.0.1:${port}/api/status`);
  let j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.version, '5.0.0');

  const projectNote = await fetch(`http://127.0.0.1:${port}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ title: 'Project Atlas', type: 'project', project: 'Atlas', content: '# Project Atlas\n\nProject: Atlas\n\nRoadmap and direction.' })
  }).then(async r => r.json());
  const docNote = await fetch(`http://127.0.0.1:${port}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ title: 'Atlas API Spec', type: 'doc', project: 'Atlas', content: '# Atlas API Spec\n\nProject: Atlas\n\nSpec for Gateway and Auth Service.\n\n[[Project Atlas]]' })
  }).then(async r => r.json());
  const taskNote = await fetch(`http://127.0.0.1:${port}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ title: 'Atlas Open Tasks', type: 'task', project: 'Atlas', content: '# Atlas Open Tasks\n\nProject: Atlas\n\n- [ ] Ship gateway\n- [ ] Review auth token rotation' })
  }).then(r => r.json());

  assert.equal(projectNote.note.projectName, 'Atlas');
  assert.equal(docNote.note.isDocument, true);
  assert.equal(taskNote.note.classification.primaryType, 'task');

  r = await fetch(`http://127.0.0.1:${port}/api/notes/${docNote.note.id}`);
  j = await r.json();
  assert.equal(j.note.id, docNote.note.id);
  assert.equal(j.note.documentType, 'spec');

  r = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  j = await r.json();
  assert.ok(j.workspace.noteCount >= 3);
  assert.ok(j.projects.some(p => p.name === 'Atlas'));
  assert.ok(j.recentDocuments.some(async d => d.id === docNote.note.id));

  r = await fetch(`http://127.0.0.1:${port}/api/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ query: 'افتح المستند', activeProject: 'Atlas' })
  });
  j = await r.json();
  assert.equal(j.resolved.title, 'Atlas API Spec');
  assert.equal(j.resolved.isDocument, true);

  r = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('gateway auth spec')}`);
  j = await r.json();
  assert.equal(j.mode, 'hybrid-memory');
  assert.ok(j.results.some(x => x.title === 'Atlas API Spec'));

  r = await fetch(`http://127.0.0.1:${port}/api/project-state?project=Atlas`);
  j = await r.json();
  assert.ok(j.healthScore >= 0);
  assert.ok(j.openTasks.length >= 2);

  r = await fetch(`http://127.0.0.1:${port}/api/brain/map`);
  j = await r.json();
  assert.ok(j.projects.some(p => p.name === 'Atlas'));
  assert.ok(j.documents.some(async d => d.title === 'Atlas API Spec'));

  r = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ project: 'Atlas', noteId: docNote.note.id, messages: [{ role: 'user', content: 'افتح المستند الذي كنا نعمل عليه' }] })
  });
  j = await r.json();
  assert.ok(j.resolved?.resolved?.title === 'Atlas API Spec');
  assert.ok(Array.isArray(j.context));
  assert.match(j.answer, /Atlas API Spec|العنصر الأقرب|mock/i);

  /* §34 — كان هذا السطر يبرهن الثغرة: POST /api/backup بلا رمز جلبة 200.
     بعد إغلاق الثغرة (2026-10-20) صار النداء بلا رمز = 401.
     نُثبّت السلوك الصحيح هنا: الرفض بلا رمز، والنجاح بالرمز. */
  r = await fetch(`http://127.0.0.1:${port}/api/backup`, { method: 'POST' });
  assert.strictEqual(r.status, 401, 'نسخة احتياطية بلا رمز جلسة يجب أن تُرفض');

  r = await fetch(`http://127.0.0.1:${port}/api/backup`, { method: 'POST', headers: { ...(await __sess()) } });
  j = await r.json();
  assert.match(j.fileName, /cortex-backup/);
});
