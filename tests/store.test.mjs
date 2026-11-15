import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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

function waitFor(url, ms = 8000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { const r = await fetch(url); if (r.ok) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}

test('SQLite store mirrors vault tasks with owner/due and records health history', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-store-'));
  const port = 3943 + (process.pid % 1000);
  const child = spawn('node', ['server.js'], { cwd: projectDir, env: { ...process.env, APP_ROOT: root, APP_PORT: String(port) }, stdio: 'ignore' });
  t.after(async () => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  const base = `http://127.0.0.1:${port}`;

  const TOKEN = await sessionToken({ base, appRoot: root });
  // ملاحظة PRD بمهام موسومة بصاحب وموعد
  const prd = await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ title: 'Atlas PRD', type: 'doc', project: 'Atlas', content: '# Atlas PRD\n\nProject: Atlas\n\n## Scope\n- [ ] Ship gateway @sara due:2026-01-02\n- [x] Write spec @omar\n\n## Summary\nالمتطلبات الأساسية.\n' })
  }).then(async r => r.json());
  assert.equal(prd.note.documentType, 'prd');

  // ملاحظة اجتماع بمهام أيضاً
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
    body: JSON.stringify({ title: 'Atlas Kickoff', type: 'meeting', project: 'Atlas', content: '# Atlas Kickoff\n\nProject: Atlas\n\nAttendees: sara, omar\n\n- [ ] Draft ADR @omar\n- [ ] Schedule review\n' })
  }).then(r => r.json());

  // تنتظر مزامنة المتجر (تُجدول بعد التغيير)
  await new Promise(r => setTimeout(r, 1400));

  const tasksResponse = await fetch(`${base}/api/tasks?project=Atlas`).then(r => r.json());
  const tasks = tasksResponse.tasks;
  assert.ok(tasks.length >= 4, `tasks=${tasks.length}`);
  const gateway = tasks.find(t => t.text.includes('Ship gateway'));
  assert.equal(gateway.owner, 'sara');
  assert.equal(gateway.due, '2026-01-02');
  assert.equal(gateway.status, 'open');
  const done = tasks.find(t => t.status === 'done');
  assert.ok(done, 'should contain one done task');
  assert.ok(tasks.find(t => t.text.includes('Draft ADR') && t.owner === 'omar'), 'meeting task exists');

  // نص المهمة نظيف من وسوم @ و due
  assert.equal(gateway.text, 'Ship gateway');

  // تاريخ صحة مشروع Atlas
  const health = await fetch(`${base}/api/health/history?project=Atlas`).then(r => r.json());
  assert.ok(health.history.length >= 1, 'health snapshot recorded');
  assert.ok(Number.isInteger(health.history[0].score) && health.history[0].score >= 0 && health.history[0].score <= 100, 'score is a valid 0..100 integer');

  // ملف قاعدة البيانات موجود فعلياً
  const dbFile = await readFile(path.join(root, 'data', 'cortex.db'));
  assert.ok(dbFile.length > 0);

  // فلتر الحالة
  const openTasks = await fetch(`${base}/api/tasks?project=Atlas&status=open`).then(r => r.json());
  assert.ok(openTasks.tasks.every(t2 => t2.status === 'open'));
});

// ─── إصلاح 2026-11-14: الإسقاطة كانت تمحو جدول العلاقات كله عند كل مزامنة ─────
test('REL-DUR: المزامنة تحفظ العلاقات المُستنتجة وتمحو صفوفها فقط', async () => {
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const { createStore } = require2('../cortex-store.js');
  const { DatabaseSync } = require2('node:sqlite');

  const dir = await mkdtemp(path.join(tmpdir(), 'cortex-store-rel-'));
  const store = createStore({ root: dir });
  // الترحيل هو ما يُضيف origin/confidence — وهو مسار الإقلاع الحقيقي
  const schema = require2('../cortex-schema.js');
  const { DatabaseSync: DS } = require2('node:sqlite');
  const mig = new DS(store.dbFile); schema.migrate(mig); mig.close();
  const notes = [{ id: 'a', title: 'A', type: 'note' }, { id: 'b', title: 'B', type: 'note' }];
  const links = [{ source: 'a', target: 'b', kind: 'wikilink' }];

  store.sync({ notes, tasks: [], links });

  // علاقة مُستنتجة + صف قديم بلا origin (تملكه الإسقاطة)
  let db = new DatabaseSync(store.dbFile);
  db.prepare("INSERT INTO note_links(source,target,kind,origin,confidence,extracted_at) VALUES ('a','c','depends_on','repo_deps',1.0,'2026-11-14')").run();
  db.prepare("INSERT INTO note_links(source,target,kind) VALUES ('x','y','wikilink')").run();
  db.close();

  // مزامنة ثانية — العطل القديم: كل شيء يُمحى ثم يُكتب wikilink واحد
  store.sync({ notes, tasks: [], links });

  db = new DatabaseSync(store.dbFile);
  const inferred = db.prepare("SELECT COUNT(*) c FROM note_links WHERE origin='repo_deps'").get().c;
  const wiki = db.prepare("SELECT COUNT(*) c FROM note_links WHERE kind='wikilink'").get().c;
  const stale = db.prepare("SELECT COUNT(*) c FROM note_links WHERE source='x'").get().c;
  assert.equal(inferred, 1, 'العلاقة المُستنتجة نجت من المزامنة');
  assert.equal(wiki, 1, 'wikilink لم يتضاعف');
  assert.equal(stale, 0, 'صف الإسقاطة القديم (بلا origin) أُعيد بناؤه');
  db.close();
  store.close();
});
