import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionToken } from './_session.mjs';
import { deterministicEnv } from './_live-server.mjs';
// §34: الرمز يُقرأ لحظياً من نفس خندق الواجهة (data/session.token أو /api/session)
// — بدل الاعتماد على متغير نطاقي يغيب عن الدوال العامة.
// العطل: __sess كانت تقرأ الرمز من 3737 الحيّ بلا علاقة بخادم هذا الاختبار.
const __BASE__ = process.env.CORTEX_BASE || 'http://127.0.0.1:3737';
let __TOKEN_CACHE = null;
async function __sess() {
  if (__TOKEN_CACHE) return { 'X-Cortex-Session': __TOKEN_CACHE };
  __TOKEN_CACHE = await sessionToken({ base: __BASE__ });
  return __TOKEN_CACHE ? { 'X-Cortex-Session': __TOKEN_CACHE } : {};
}


const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arabic = s => /[\u0600-\u06FF]/.test(String(s || ''));

// القاعدة: لغة واحدة كاملة حسب المستخدم — إنجليزي خالص أو عربي خالص، بلا خلط
test('Agent speaks exactly one language: English chain has zero Arabic, Arabic chain unchanged', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-biling-'));
  const port = 3975 + (process.pid % 1000);
  const child = spawn('node', ['server.js'], { cwd: projectDir, env: deterministicEnv(root, port), stdio: 'ignore' });
  t.after(async () => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  /* §33/§35: `autonomy` يُقرأ من **إعدادات الخادم** لا من حمولة الطلب (منع
     التصعيد عمداً)، وreadSettings يُنفَّذ لكل طلب. فالاختبار الذي يقيس التنفيذ
     المستقل يضبط الوضع في إعدادات جذر الخادم بعد الإقلاع. العطل المُثبت 2026-10-20:
     كان يطلب `autonomy:'autonomous'` في الحمولة فيُتجاهل ⇒ الكتابة مسودة ⇒
     «task actually added» يفشل بلا أي عطل في الوكيل. */
  await writeFile(path.join(root, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', temperature: 0.2 },
    agent: { defaultMode: 'project', autonomy: 'autonomous' }, lang: 'ar',
  }, null, 1));
  const base = `http://127.0.0.1:${port}`;

  const TOKEN = await sessionToken({ base, appRoot: root });
  const createdProbe = await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ title: 'Agent Probe', type: 'doc', project: 'Probe', content: '# Agent Probe\n\nProject: Probe\n\n## Goals\n- [ ] something @omar\n' })
  }).then(async r => r.json());
  // العطل الأصلي: افتراض noteId='agent-probe' بينما الخادم يولّد المعرّف ⇒ الوكيل
  // لا يجد الملاحظة فلا تُسجَّل أي طفرة (فشل كاذب). نقرأ المعرّف المُعاد فعلاً.
  const probeId = (createdProbe && (createdProbe.id || (createdProbe.note && createdProbe.note.id))) || 'agent-probe';
  // مشروع بلا قرارات/مخاطر — ليولد فجوات فعلية يفحصها الاختبار في المسارين اللغويين
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ title: 'Probe Charter', type: 'project', project: 'Probe', content: '# Probe Charter\n\nProject: Probe\n' })
  }).then(r => r.json());

  const run = async (p2) => fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) }, body: JSON.stringify(p2) }).then(x => x.text());
  const done = txt => txt.split('\n\n').filter(c => c.startsWith('data:')).map(c => c.slice(5).trim()).filter(Boolean).map(JSON.parse).find(m2 => m2.type === 'agent_done');

  // 1) هدف إنجليزي (كشف آلي) — تنفيذ مستقل: الرد والسطر المكتوب في الملاحظة بلا أي حرف عربي
  const en = done(await run({ goal: 'Add task "review mapper schema" for @sara', project: 'Probe', noteId: probeId, lang: 'en', autonomy: 'autonomous' }));
  assert.ok(en, 'agent_done received');
  assert.equal(en.result.lang, 'en');
  assert.equal(arabic(en.result.answer), false, 'no Arabic in the English answer');
  assert.equal((en.result.mutations || []).length, 1, 'task actually added');
  const note = await fetch(`${base}/api/notes/${probeId}`).then(r => r.json());
  assert.match(note.note.body, /- \[ \] review mapper schema @sara/, 'owner captured, English task line written');
  const preExisting = note.note.body.split('\n').filter(l2 => arabic(l2));
  assert.equal(preExisting.length, 0, 'no Arabic introduced into the note body');

  // 2) مسودة إنجليزية خالصة في الوضع الخاضع.
  // الوضع يُقرأ من إعدادات الخادم (§33: لا تصعيد من الحمولة) ⇒ نعيده supervised
  // قبل هذا الهدف صراحةً، وإلا نُفِّذت الكتابة مباشرةً فبدت «لا مسودة» (عطل اختبار).
  await writeFile(path.join(root, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', temperature: 0.2 },
    agent: { defaultMode: 'project', autonomy: 'supervised' }, lang: 'ar',
  }, null, 1));
  const en2 = done(await run({ goal: 'Add task "second governance probe" for @omar', project: 'Probe', noteId: probeId }));
  assert.equal(en2.result.lang, 'en');
  assert.equal((en2.result.pending || []).length, 1);
  assert.equal(arabic(JSON.stringify(en2.result.pending)), false, 'draft card summary fully English');

  // 3) هدف عربي كشفًا آليًا — يبقى بالعربية كاملة
  const ar = done(await run({ goal: 'ما الناقص في المشروع؟ اكتشف الفجوات فقط', project: 'Probe' }));
  assert.equal(ar.result.lang, 'ar');
  assert.ok(arabic(ar.result.answer), 'Arabic answer for Arabic goal');
  const arGaps = ar.result.steps?.find(s2 => s2.tool === 'find_gaps')?.result?.gaps || [];
  assert.ok(arGaps.length >= 1, 'gaps actually detected in the Arabic chain');
  assert.ok(arabic(arGaps[0].message), 'gap findings text is Arabic in the Arabic chain');

  // 4) تفضيل صريح في الإعدادات يفرض الإنجليزية حتى على هدف عربي (اقتباس نص المستخدم استثناء موثق)
  const s = await fetch(`${base}/api/settings`).then(x => x.json());
  const saved = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) }, body: JSON.stringify({ ...s, agent: { ...(s.agent || {}), language: 'en' } }) }).then(async x => x.json());
  assert.equal(saved.agent?.language, 'en', 'language preference persisted');
  const forced = done(await run({ goal: 'ما الناقص في المشروع؟ اكتشف الفجوات فقط', project: 'Probe' }));
  assert.equal(forced.result.lang, 'en');
  const forcedGaps = JSON.stringify(forced.result.steps?.find(s2 => s2.tool === 'find_gaps')?.result?.gaps || []);
  assert.ok(forced.result.steps?.find(s2 => s2.tool === 'find_gaps')?.result?.gaps?.length >= 1, 'gaps detected in the forced-English chain');
  assert.equal(arabic(forcedGaps), false, 'gap findings are English under the English preference');
  const answerLines = String(forced.result.answer || '').split('\n').filter(l2 => arabic(l2));
  assert.ok(answerLines.every(l2 => l2.includes('"')), 'the only Arabic left is the quoted original goal text');
});

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
