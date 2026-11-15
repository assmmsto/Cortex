import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sessionToken } from './_session.mjs';
import { deterministicEnv, freePort } from './_live-server.mjs';
// §34: الرمز يُقرأ لحظياً من نفس خندق الواجهة (data/session.token أو /api/session)
// — بدل الاعتماد على متغير نطاقي يغيب عن الدوال العامة.
let __TOKEN_CACHE = null;
async function __sess() {
  if (__TOKEN_CACHE) return { 'X-Cortex-Session': __TOKEN_CACHE };
  __TOKEN_CACHE = await sessionToken({ base: process.env.CORTEX_BASE || 'http://127.0.0.1:3737' });
  return __TOKEN_CACHE ? { 'X-Cortex-Session': __TOKEN_CACHE } : {};
}


const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// المنفذ من تجمّع النظام (listen(0)) لا من نطاق عشوائي:
// نطاقات 49152–51126 محجوزة فعلياً على هذا الجهاز (netsh show excludedportrange)
// و↦RANDOM_PORT في 40000–54999 كان يسقط فيها فيموت الخادم قبل الإقلاع (سباق بيئي مقيس).
// كل خادم يأخذ منفذاً حرّاً لحظة إنشائه.

async function waitFor(url, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

const jpost = async (base, p, body, t = 60000) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(await __sess()) },
  body: JSON.stringify(body), signal: AbortSignal.timeout(t)
});

// خادم NDJSON MCP حقيقي بسيط — نتحقق بالقدرة الفعلية لا بالادّعاء
const NDJSON_MCP = `'use strict';
// خادم MCP بسيط بنمط NDJSON (سطر JSON لكل رسالة) للتحقق من مسار الاستدعاء الحقيقي
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  if (msg.method === 'tools/list') return reply({ tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'echo:' + String((msg.params && msg.params.arguments && msg.params.arguments.text) || '') }] });
  if (msg.method === 'ping') return reply({});
  reply({});
});
`;

test('تكامل الطبقات: الإقلاع والهجرة', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await waitFor(`http://127.0.0.1:${port}/api/status`);

  // الهجرة تُضيف الجداول الجديدة فعلياً في قاعدة الخادم
  const db = new DatabaseSync(path.join(root, 'data', 'cortex.db'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const want of ['document_versions', 'repos', 'repo_deps', 'project_lifecycle', 'agent_tasks', 'agent_events', 'model_usage', 'mcp_calls', 'audit_log']) {
    assert.ok(tables.includes(want), `جدول ${want} مفقود بعد الهجرة`);
  }
  const noteCols = db.prepare('PRAGMA table_info(notes)').all().map(c => c.name);
  for (const c of ['kind', 'knowledge_kind', 'source', 'fingerprint']) {
    assert.ok(noteCols.includes(c), `عمود notes.${c} مفقود بعد الهجرة`);
  }
  db.close();
});

test('تكامل الطبقات: الاستيراد الحقيقي وصيغة غير مدعومة', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  const TOKEN = await sessionToken({ base, appRoot: root });
  await waitFor(`${base}/api/status`);

  // ملف حقيقي داخل جذر مسموح (مجلد القالب المؤقت + ملف مصدر حقيقي في المشروع)
  const srcFile = path.join(projectDir, 'cortex-policy.js');
  const r1 = await jpost(base, '/api/import', { path: srcFile, project: 'Cortex' });
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.equal(j1.ok, true);
  assert.equal(j1.ext, '.js');
  assert.match(j1.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(j1.note && j1.note.id, 'لم تُنشأ ملاحظة للمستورد');

  // الملاحظة حقيقية وقابلة للقراءة من الـ vault، بحقل source وبصمة
  const notes = await (await fetch(`${base}/api/notes`)).json();
  const created = notes.notes.find(n => n.id === j1.note.id);
  assert.ok(created, 'المستورد غير ظاهر في قائمة الملاحظات');

  // صيغة غير مدعومة ⇒ خطأ واضح بلا ادعاء نجاح
  const un = path.join(root, 'unsupported.binzz');
  await writeFile(un, 'binary-ish payload', 'utf8');
  const r2 = await jpost(base, '/api/import', { path: un });
  const j2 = await r2.json();
  assert.equal(r2.status, 400);
  assert.ok(j2.error, 'يجب إعادة خطأ واضح');
  assert.ok(Array.isArray(j2.supported) || typeof j2.error === 'string');

  // امتدادات مدعومة معلنة فعلاً
  const sup = await (await fetch(`${base}/api/import/supported`)).json();
  assert.ok(Array.isArray(sup.extensions) && sup.extensions.includes('.md') && sup.extensions.includes('.js'));
});

test('تكامل الطبقات: اعتماديات المستودع وأثر التغيير', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const deps = await (await fetch(`${base}/api/repo/deps?path=${encodeURIComponent(projectDir)}`)).json();
  assert.ok(deps.internalEdges > 0, `لا حواف اعتماد: ${JSON.stringify(deps).slice(0, 200)}`);
  assert.ok(deps.filesScanned > 0);
  assert.ok(Array.isArray(deps.edges) && deps.edges.length > 0);

  const impact = await (await fetch(`${base}/api/repo/impact?path=${encodeURIComponent(projectDir)}&file=cortex-policy.js`)).json();
  assert.ok(impact.dependedByCount > 0, `لا ملفات معتمدة على cortex-policy.js: ${JSON.stringify(impact).slice(0, 200)}`);
  assert.ok(impact.dependedBy.length > 0);

  // مسار خارج الجذور المسموحة يُرفض صراحةً ولا يُنفَّذ
  const outside = await (await fetch(`${base}/api/repo/deps?path=${encodeURIComponent(path.join(root, 'nowhere'))}`)).json();
  assert.ok(outside.error || outside.internalEdges === 0);
});

test('تكامل الطبقات: مزودو النماذج لا يكشفون مفتاحاً كاملاً', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const SECRET = 'sk-live-SUPERSECRETVALUE0123456789';
  // نزرع مزوداً بمفتاح طويل مباشرة في الإعدادات
  const settingsPath = path.join(root, 'data', 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.providers = [{ name: 'seeded', baseUrl: 'https://example.invalid', apiKey: SECRET, enabled: true, models: ['m1'] }];
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  const res = await (await fetch(`${base}/api/models/providers`)).json();
  const text = JSON.stringify(res);
  assert.ok(!text.includes(SECRET), 'المفتاح الكامل تسرّب في الرد!');
  assert.equal(res.providers.length, 1);
  const p = res.providers[0];
  assert.equal(p.name, 'seeded');
  assert.ok(p.apiKey.length < SECRET.length, 'المفتاح المعاد ليس مموّهاً');
  assert.ok(p.apiKey.includes('...'), `صيغة الإخفاء غير صحيحة: ${p.apiKey}`);
});

test('تكامل الطبقات: إضافة مزود على عنوان ميت تفشل سريعاً بسبب واضح', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const t0 = Date.now();
  const r = await jpost(base, '/api/models/add-provider', { name: 'dead', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-abcdefghijklmnop', timeoutMs: 1500 }, 20000);
  const elapsed = Date.now() - t0;
  const j = await r.json();
  assert.equal(r.status, 400);
  assert.equal(j.ok, false);
  assert.ok(j.error && String(j.error).length, 'لا سبب واضح للفشل');
  assert.ok(elapsed < 15000, `الطلب تعلّق ${elapsed}ms بدل الفشل السريع`);
  assert.ok(!JSON.stringify(j).includes('sk-abcdefghijklmnop'), 'المفتاح تسرّب في رد الفشل');
});

test('تكامل الطبقات: نداء MCP على خادم فاشل يعيد خطأ بلا تعليق', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  // خادم مهيّأ لكن أمره غير موجود
  await writeFile(path.join(root, 'data', 'mcp-servers.json'), JSON.stringify({
    mcpServers: { broken: { command: 'definitely-not-a-real-binary-xyz', args: [], allowedTools: ['echo'], timeoutMs: 1500 } }
  }), 'utf8');

  const servers = await (await fetch(`${base}/api/mcp/servers`)).json();
  assert.equal(servers.count, 1);
  assert.equal(servers.servers[0].name, 'broken');

  const t0 = Date.now();
  /* §31: الحوكمة تعترض **قبل** محاولة الاتصال ⇒ النداء بلا اعتماد يعود 202
     مسودة، فلا يُقاس به «فشل سريع». نعتمد النداء صراحةً ليقيس الاختبار ما يقصده:
     سلوك الخادم الميت = 502 سريع بلا تعليق. (عطل اختبار مُثبت 2026-10-20.) */
  const r = await jpost(base, '/api/mcp/call', { server: 'broken', tool: 'echo', args: { text: 'hi' }, approved: true }, 20000);
  const elapsed = Date.now() - t0;
  const j = await r.json();
  assert.equal(r.status, 502);
  assert.equal(j.ok, false);
  assert.ok(j.error && String(j.error).length, 'لا سبب للفشل');
  assert.ok(elapsed < 15000, `الفشل استغرق ${elapsed}ms — السلوك المطلوب فشل سريع`);

  // الأداة خارج المسموح تُرفض قبل أي اتصال
  const denied = await jpost(base, '/api/mcp/call', { server: 'broken', tool: 'other_tool', args: {} }, 10000);
  assert.equal(denied.status, 403);

  // خادم غير مهيّأ
  const missing = await jpost(base, '/api/mcp/call', { server: 'nope', tool: 'x', args: {} }, 10000);
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
});

test('تكامل الطبقات: نداء MCP ناجح على خادم NDJSON حقيقي', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const serverFile = path.join(root, 'data', 'ndjson-mcp.js');
  await writeFile(serverFile, NDJSON_MCP, 'utf8');
  await writeFile(path.join(root, 'data', 'mcp-servers.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [serverFile], cwd: root, allowedTools: ['echo'], timeoutMs: 8000 } }
  }), 'utf8');

  /* §31: كل أداة MCP مسودة تحتاج اعتماداً صريحاً — ولهذا الاختبار **مساران**:
     (أ) بلا اعتماد ⇒ 202 + needsApproval (لا تنفيذ)، (ب) باعتماد ⇒ 200 + أثر.
     العطل المُثبت 2026-10-20: الاختبار كان يتوقع 200 بلا approved، فيفشل على
     «أداة MCP مسجّلة كمسودة» — وهو سلوك صحيح دستورياً لا عطل. */
  const draft = await jpost(base, '/api/mcp/call', { server: 'fixture', tool: 'echo', args: { text: 'ping' } }, 20000);
  const draftJ = await draft.json();
  assert.equal(draft.status, 202, 'بلا اعتماد ⇒ 202 مسودة (لا تنفيذ)');
  assert.equal(draftJ.needsApproval, true, 'العلم needsApproval مرفوع');

  const r = await jpost(base, '/api/mcp/call', { server: 'fixture', tool: 'echo', args: { text: 'ping' }, approved: true }, 20000);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200));
  assert.equal(j.ok, true);
  assert.match(j.clean, /echo:ping/);
  assert.equal(j.policyKey, 'mcp__fixture__echo');
  assert.equal(j.level, 'read');

  // النداء سُجّل في mcp_calls فعلاً
  const db = new DatabaseSync(path.join(root, 'data', 'cortex.db'));
  const rows = db.prepare('SELECT server, tool, ok FROM mcp_calls ORDER BY id').all();
  db.close();
  // كل نداء يُسجَّل — المسودة والمعتمد معاً (§31: لا نداء بلا أثر)
  assert.equal(rows.length, 2, 'كل نداء سُجّل: مسودة + معتمد');
  assert.equal(rows[0].server, 'fixture');
  assert.equal(rows[0].tool, 'echo');
  assert.equal(rows[0].ok, 0, 'المسودة لم تُنفَّذ');
  assert.equal(rows[1].ok, 1, 'المعتمد نُفِّذ');
});

test('تكامل الطبقات: المنسّق ينفّذ هدفاً كاملاً بلا مهام معلّقة', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const r = await jpost(base, '/api/agent/orchestrate', { goal: 'حلل المشروع' }, 90000);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200));
  assert.ok(j.runId, 'لا runId');
  assert.ok(Array.isArray(j.tasks) && j.tasks.length > 0, 'لا مهام');

  // لا مهمة تبقى queued أو running — كلها بحالة نهائية
  const statuses = j.tasks.map(x => x.status);
  for (const s of statuses) {
    assert.ok(['done', 'failed', 'blocked'].includes(s), `حالة غير نهائية: ${s}`);
  }
  assert.ok(j.summary && j.summary.total === j.tasks.length);

  // الحالة الحقيقية في قاعدة البيانات تطابق الرد
  const tasksRes = await (await fetch(`${base}/api/agent/tasks?runId=${encodeURIComponent(j.runId)}`)).json();
  assert.equal(tasksRes.tasks.length, j.tasks.length);
  for (const row of tasksRes.tasks) {
    assert.ok(['done', 'failed', 'blocked'].includes(row.status), `صف غير نهائي في القاعدة: ${row.status}`);
  }

  // مسار بلا runId أو بلا هدف يرجّع JSON صالحاً بخطأ واضح
  const noRun = await (await fetch(`${base}/api/agent/tasks`)).json();
  assert.ok(noRun.error);
  const noGoal = await jpost(base, '/api/agent/orchestrate', {}, 10000);
  assert.equal(noGoal.status, 400);
  assert.ok((await noGoal.json()).error);
});

test('تكامل الطبقات: كل مسار جديد يرجّع JSON صالحاً حتى عند الخطأ', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-int-'));
  const port = await freePort();
  // بيئة حتمية: بلا CORTEX_ALLOWED_ROOTS يفشل استيراد المجلدات المؤقتة بـ403
// («خارج الجذور المسموحة») وبلا CORTEX_DAILY_* يُستهلك سقف fs اليومي — عطلان
// مُثبتان 2026-10-20 ليسا في الكود. deterministicEnv تزرعها (كما في run-suite).
    const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port) });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);

  const probes = [
    ['GET', '/api/import/supported', null],
    ['POST', '/api/import', { path: '' }],
    ['GET', '/api/repo/index', null],
    ['GET', '/api/repo/deps', null],
    ['GET', '/api/repo/impact', null],
    ['GET', '/api/models/providers', null],
    ['POST', '/api/models/add-provider', {}],
    ['GET', '/api/mcp/servers', null],
    ['POST', '/api/mcp/call', {}],
    ['GET', '/api/agent/tasks', null],
    ['POST', '/api/agent/orchestrate', {}],
  ];
  for (const [method, p, bodyVal] of probes) {
    const res = method === 'GET' ? await fetch(base + p) : await jpost(base, p, bodyVal, 20000);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('application/json'), `${method} ${p} لم يرجّع JSON (${ct})`);
    const text = await res.text();
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `${method} ${p} أرجأ JSON غير صالح: ${text.slice(0, 120)}`);
    assert.ok(parsed && typeof parsed === 'object', `${method} ${p} أرجأ قيمة غير كائنية`);
  }
});
