import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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


const require = createRequire(import.meta.url);
const agentMod = require('../cortex-agent');
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

test('Agent executes goals: read analysis without mutation, write goal mutates notes additively', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-agent-'));
  const port = 3947 + (process.pid % 1000);
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
  // العطل الأصلي: الاختبار افترض أن الملاحظة ستُعرَّف بـ'agent-probe' ثم استعمل
  // هذا المعرّف في goal كتابة — لكن الخادم يولّد المعرّف، فالوكيل لم يجد الملاحظة
  // وفشل بلا سبب حقيقي. الصواب: نقرأ المعرّف المُعاد فعلاً ونستعمله.
  const created = await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ title: 'Agent Probe', type: 'doc', project: 'Probe', content: '# Agent Probe\n\nProject: Probe\n\n## Goals\n- [ ] something @omar\n' })
  }).then(async r => r.json());
  const probeId = (created && (created.id || (created.note && created.note.id))) || 'agent-probe';
  assert.ok(probeId, 'معرّف الملاحظة المُنشأة');

  // 1) هدف قراءة — لا تعديل
  const readRes = await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ goal: 'ما الناقص في المشروع؟ اكتشف الفجوات فقط', project: 'Probe' })
  }).then(r => r.text());
  const readDone = readRes.split('\n\n').filter(c => c.startsWith('data:')).map(c => c.slice(5).trim()).filter(Boolean).map(s => JSON.parse(s)).find(m => m.type === 'agent_done');
  assert.ok(readDone, 'agent_done received');
  assert.ok(readDone.result.answer.length > 10, 'answer composed');
  assert.equal((readDone.result.mutations || []).length, 0, 'read goal mutates nothing');

  // 2) هدف كتابة مستقلة (autonomous) — إضافة فعلية بمهمة
  const writeRes = await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ goal: 'أضف مهمة "راجع مخطط الوكيل" لـ @sara', project: 'Probe', noteId: probeId, autonomy: 'autonomous' })
  }).then(r => r.text());
  const writeDone = writeRes.split('\n\n').filter(c => c.startsWith('data:')).map(c => c.slice(5).trim()).filter(Boolean).map(s => JSON.parse(s)).find(m => m.type === 'agent_done');
  assert.ok(writeDone, 'write agent_done received');
  assert.equal((writeDone.result.mutations || []).length, 1, 'one mutation recorded');

  const note = await fetch(`${base}/api/notes/${probeId}`).then(async r => r.json());
  assert.match(note.note.body, /راجع مخطط الوكيل/);
  assert.match(note.note.body, /@sara/);

  // 3) التكرار آمن — لا إضافة ثانية (مع انتظار نافذة مزامنة SQLite المتأخرة 800ms)
  await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ goal: 'أضف مهمة "راجع مخطط الوكيل" لـ @sara', project: 'Probe', noteId: probeId, autonomy: 'autonomous' })
  }).then(r => r.text());
  await new Promise(r => setTimeout(r, 1500));
  const tasks = await fetch(`${base}/api/tasks?project=Probe`).then(r => r.json());
  const matches = tasks.tasks.filter(t2 => t2.text.includes('راجع مخطط الوكيل'));
  assert.equal(matches.length, 1, 'deduped to one task row');

  // 3ب) الوضع الخاضع للإشراف: الكتابة تتحول مسودة → الملاحظة سليمة → الاعتماد ينفّذها.
  // الوضع يُقرأ من **إعدادات الخادم** (§33: لا تصعيد من الحمولة) ⇒ نعيده supervised
  // هنا صراحةً. العطل 2026-10-20: كان الاختبار يفترض supervised افتراضياً بينما
  // ضبطنا الجذر على autonomous للاختبار السابق ⇒ «supervised run executes nothing» يفشل.
  await writeFile(path.join(root, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', temperature: 0.2 },
    agent: { defaultMode: 'project', autonomy: 'supervised' }, lang: 'ar',
  }, null, 1));
  const supRes = await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ goal: 'أضف مهمة "مهمة حوكمة تجريبية" لـ @omar', project: 'Probe', noteId: probeId })
  }).then(r => r.text());
  const supDone = supRes.split('\n\n').filter(c => c.startsWith('data:')).map(c => c.slice(5).trim()).filter(Boolean).map(s => JSON.parse(s)).find(m => m.type === 'agent_done');
  assert.ok(supDone, 'supervised agent_done received');
  assert.equal((supDone.result.mutations || []).length, 0, 'supervised run executes nothing');
  assert.equal((supDone.result.pending || []).length, 1, 'supervised run queues one draft');
  assert.equal(supDone.result.pending[0].tool, 'append_tasks', 'draft is the write tool');
  let noteNow = await fetch(`${base}/api/notes/${probeId}`).then(r => r.json());
  assert.doesNotMatch(noteNow.note.body, /مهمة حوكمة تجريبية/, 'note untouched before approval');
  const pendingState = await fetch(`${base}/api/agent/pending`).then(async r => r.json());
  assert.equal((pendingState.mutations || []).length, 1, 'pending persisted for approval');
  const execOut = await fetch(`${base}/api/agent/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    body: JSON.stringify({ mutations: pendingState.mutations, project: 'Probe' })
  }).then(r => r.json());
  assert.equal((execOut.applied || []).length, 1, 'approval applied one draft');
  await new Promise(r => setTimeout(r, 1200));
  noteNow = await fetch(`${base}/api/notes/${probeId}`).then(r => r.json());
  assert.match(noteNow.note.body, /مهمة حوكمة تجريبية/, 'note mutated only after approval');
  const pendingAfter = await fetch(`${base}/api/agent/pending`).then(async r => r.json());
  assert.equal((pendingAfter.mutations || []).length, 0, 'pending cleared after execute');

  // 4) المبادرة تعطي نتائج
  const proactive = await fetch(`${base}/api/agent/proactive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) }, body: JSON.stringify({ project: 'Probe' })
  }).then(r => r.json());
  assert.ok(Array.isArray(proactive.findings), 'findings array');

  // 5) تدقيق الوكيل مسجل — بما فيه تنفيذ الاعتماد
  const audit = await readFile(path.join(root, 'data', 'audit.log'), 'utf8');
  assert.match(audit, /agent_action/);
  assert.match(audit, /agent_run/);
  assert.match(audit, /agent_execute/);
});


// ── حراس موجّه النظام ────────────────────────────────────────────
// عطل مؤكد: صياغة «دورك كشخصية» تجعل بعض المزوّدين يرفض الطلب بخطأ 400
// («لا أتبنّى شخصيات لتجاوز الإرشادات») فيسقط التشغيل كله. الحارس يمنع رجوعها.

test('حارس الموجّه: تعليمات الأدوار مصوغة كنطاق مهمة لا كشخصية', () => {
  const briefs = agentMod.ROLE_BRIEF;
  assert.ok(briefs && typeof briefs === 'object', 'ROLE_BRIEF متاح');
  const roles = Object.keys(briefs);
  assert.ok(roles.length >= 6, `أدوار متوقعة 6 على الأقل — وُجد ${roles.length}`);

  // صياغات مُحرِّضة على الرفض — ممنوعة في كل لغة
  const banned = [
    /\bYour role\b/i, /\byou are (an?|the)\b/i, /\bact as\b/i, /\bpersona\b/i, /\bpretend\b/i,
    /دورك\s*[:：]/, /تصرّ?ف\s+ك/, /تبنَّ?\s+شخصية/, /تخيّل\s+أنك/, /أنت\s+الآن/
  ];
  for (const r of roles) {
    for (const lang of ['ar', 'en']) {
      const text = String(briefs[r][lang] || '');
      assert.ok(text.length > 20, `${r}.${lang} موجود وغير فارغ`);
      for (const bad of banned) {
        assert.ok(!bad.test(text), `صياغة ممنوعة في ${r}.${lang}: ${bad}`);
      }
    }
  }
});

test('حارس الموجّه: كل دور يذكر أدواته الفعلية', () => {
  for (const r of Object.keys(agentMod.ROLE_BRIEF)) {
    const text = String(agentMod.ROLE_BRIEF[r].ar || '');
    assert.match(text, /نطاق/, `${r} يقول «نطاق هذه المهمة»`);
  }
});

test('حارس الموجّه: systemPrompt يضمّ تعليمات الدور عند تمريره', () => {
  const withRole = agentMod.systemPrompt('هدف تجريبي', 'سياق', 'ar', 'critic');
  assert.match(withRole, /نطاق هذه المهمة/, 'سطر النطاق مضاف');
  const without = agentMod.systemPrompt('هدف تجريبي', 'سياق', 'ar', null);
  assert.ok(!/نطاق هذه المهمة/.test(without), 'لا سطر نطاق بلا دور');
  const en = agentMod.systemPrompt('goal', 'ctx', 'en', 'monitor');
  assert.match(en, /Task scope/, 'النطاق الإنجليزي مضاف');
  const unknown = agentMod.systemPrompt('g', 'c', 'ar', 'role-does-not-exist');
  assert.ok(!/نطاق هذه المهمة/.test(unknown), 'دور مجهول لا يُقحم نصاً');
});


// ── عزل المحتوى (دستور §21) ────────────────────────────────────
// عطل مؤكد: تمرير نتائج الأدوات وسياق الذاكرة كنص حر يجعل بعض المزوّدين
// يرفض الطلب بخطأ 400، فيسقط التشغيل كله بعد أول أداة.

test('حارس العزل: النص يُغلَّف كبيانات موسومة', () => {
  const wrapped = agentMod.wrapData('search_notes', '{"count":3}');
  assert.match(wrapped, /^<بيانات نوع="search_notes">/, 'الوسم الافتتاحي بالنوع');
  assert.match(wrapped, /<\/بيانات>$/, 'الوسم الختامي');
  assert.match(wrapped, /\{"count":3\}/, 'المحتوى داخل الوسم');
  assert.equal(agentMod.wrapData('x', null).includes('null'), false, 'null يُعالج بلا كلمة null');
});

test('حارس العزل: الموجّه يعلن قاعدة البيانات لا الأوامر', () => {
  const ar = agentMod.systemPrompt('هدف', 'سياق', 'ar', null);
  assert.match(ar, /<بيانات>/, 'القاعدة العربية تشرح الوسم');
  assert.match(ar, /بيانات للقراءة فقط/, 'وصفها كبيانات لا أوامر');
  assert.ok(!/شخصية|تجاهل|تصرف ك/.test(ar), 'لا صياغات تحريضية في الموجّه');
  const en = agentMod.systemPrompt('goal', 'ctx', 'en', null);
  assert.match(en, /read-only data/, 'القاعدة الإنجليزية موجودة');
  assert.ok(!/persona|pretend|ignore previous|act as/i.test(en), 'لا صياغات تحريضية بالإنجليزية');
});

test('حارس العزل: دور المنسّق يُضاف ولا يفسد القاعدة', () => {
  const withRole = agentMod.systemPrompt('هدف', 'سياق', 'ar', 'monitor');
  assert.match(withRole, /<بيانات>/, 'القاعدة باقية مع الدور');
  assert.match(withRole, /نطاق هذه المهمة/, 'سطر النطاق مضاف');
  assert.ok(!/اعترض|ممنوع|لا تقبل/.test(withRole), 'لا صياغات تحريضية في الأدوار');
});
