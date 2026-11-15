import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const schema = require('../cortex-schema');
const gates = require('../cortex-gates');

// ملاحظة: الجداول الأساسية (notes/note_links/tasks) تُنشأ قبل الترحيل كما في بقية الاختبارات.
// نضيف عمود project للملاحظات ليتسنّى اختبار عزل المشاريع فعلياً.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT, project TEXT)');
  db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
  db.exec('CREATE TABLE tasks(id TEXT)');
  schema.migrate(db);
  return db;
}

const insertTask = (db, id, { runId = 'r1', role = 'scout', goal = 'هدف', status = 'queued', key = null, createdAt = null } = {}) =>
  db.prepare(
    'INSERT INTO agent_tasks(id, run_id, role, goal, status, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, runId, role, goal, status, key, createdAt);

// ─────────────────────────── الاختبارات ───────────────────────────

test('المراحل الثماني مزروعة ومقفلة', async () => {
  const db = makeDb();
  const rows = db.prepare('SELECT stage, n, status FROM stage_state ORDER BY n').all();
  assert.equal(rows.length, 8, 'يجب زرع ثماني مراحل');
  assert.deepEqual(rows.map((r) => r.stage), schema.STAGES.map((s) => s.key));
  assert.ok(rows.every((r) => r.status === 'locked'), 'كل المراحل تبدأ مقفلة');

  const state = gates.evaluateStage(db);
  assert.equal(state.stages.length, 8);
  assert.equal(state.proven, 0);
  assert.equal(state.complete, false);
  assert.ok(state.stages.every((s) => s.proven === false));
  assert.equal(state.next, schema.STAGES[0].key, 'المفتوحة التالية هي المرحلة 1');
  assert.equal(state.stages[0].canOpen, true);
  assert.ok(state.stages.slice(1).every((s) => s.canOpen === false), 'لا مرحلة لاحقة تُفتح');
});

test('لا يجوز إثبات المرحلة 2 قبل المرحلة 1 (يرفض)', async () => {
  const db = makeDb();
  const st2 = schema.STAGES[1];
  assert.throws(
    () => gates.proveStage(db, st2.key, { evidence: 'دليل مبكر غير مشروع' }),
    /السابقة|قبل إثبات/,
    'يجب الرفض برسالة واضحة'
  );
  const row = db.prepare('SELECT status FROM stage_state WHERE stage = ?').get(st2.key);
  assert.equal(row.status, 'locked', 'تبقى المرحلة 2 مقفلة');
});

test('إثبات المرحلة 1 ثم 2 ينجح بالترتيب ويفتح التالية', async () => {
  const db = makeDb();
  const [s1, s2] = schema.STAGES;

  const r1 = gates.proveStage(db, s1.key, { evidence: 'قاعدة المعرفة مهاجَرة ومختبرة', now: '2026-10-19T00:00:00.000Z' });
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 'proven');

  let state = gates.evaluateStage(db);
  assert.equal(state.stages[0].status, 'proven');
  assert.equal(state.proven, 1);
  assert.equal(state.next, s2.key);

  const r2 = gates.proveStage(db, s2.key, { evidence: 'خريطة العلاقات مبنية', now: '2026-10-19T00:01:00.000Z' });
  assert.equal(r2.ok, true);

  state = gates.evaluateStage(db);
  assert.equal(state.proven, 2);
  assert.equal(state.next, schema.STAGES[2].key);

  const row = db.prepare('SELECT status, evidence, proven_at FROM stage_state WHERE stage = ?').get(s2.key);
  assert.equal(row.status, 'proven');
  assert.equal(row.evidence, 'خريطة العلاقات مبنية');
  assert.equal(row.proven_at, '2026-10-19T00:01:00.000Z');
});

test('لا إثبات بلا دليل، وإعادة الإثبات مرفوضة', async () => {
  const db = makeDb();
  const s1 = schema.STAGES[0];
  assert.throws(() => gates.proveStage(db, s1.key, {}), /دليل/, 'الدليل إلزامي');
  assert.throws(() => gates.proveStage(db, s1.key, { evidence: '   ' }), /دليل/, 'الدليل الفارغ مرفوض');
  assert.throws(() => gates.proveStage(db, 'stage_9', { evidence: 'x' }), /غير معروفة/, 'مرحلة غير معروفة');
  gates.proveStage(db, s1.key, { evidence: 'دليل صالح' });
  assert.throws(() => gates.proveStage(db, s1.key, { evidence: 'دليل آخر' }), /مُثبتة مسبقاً/, 'إعادة الإثبات مرفوضة');
});

test('إثبات المراحل الثماني كاملةً ينتهي بلا مرحلة تالية', async () => {
  const db = makeDb();
  for (let i = 0; i < schema.STAGES.length; i++) {
    const s = schema.STAGES[i];
    const r = gates.proveStage(db, s.key, { evidence: `دليل المرحلة ${s.n}: ${s.key}` });
    assert.equal(r.ok, true, `إثبات ${s.key}`);
    const st = gates.evaluateStage(db);
    assert.equal(st.proven, i + 1);
    if (i + 1 < schema.STAGES.length) assert.equal(st.next, schema.STAGES[i + 1].key);
  }
  const fin = gates.evaluateStage(db);
  assert.equal(fin.next, null);
  assert.equal(fin.complete, true);
});

test('checkGates بلا فحوص: rollback_proven تفشل صراحةً ⇒ canRelease=false', async () => {
  const db = makeDb();
  const res = await gates.checkGates(db);

  assert.equal(res.canRelease, false, 'غياب دليل التراجع يمنع الإطلاق');
  assert.equal(res.gates.length, 9);

  const rb = res.gates.find((g) => g.key === 'rollback_proven');
  assert.ok(rb, 'البوابة موجودة');
  assert.equal(rb.pass, false);
  assert.match(rb.detail, /لم يُقدَّم دليل التراجع/, 'تفصيل الرفض صريح');

  // البوابتان المرتبطتان بالواقع تفشلان بلا دليل حقيقي — وهذا هو المطلوب (§45):
  // rollback_proven تحتاج دليل تراجع، وtasks_recoverable تحتاج store.requeuePending
  // لتُثبت الاستعادة بالقراءة. أي نجاح آخر على قاعدة نظيفة بلا إثبات = ادعاء.
  const needsProof = new Set(['rollback_proven', 'tasks_recoverable']);
  const others = res.gates.filter((g) => !needsProof.has(g.key));
  assert.ok(others.every((g) => g.pass === true), 'بقية البوابات تجتاز على قاعدة نظيفة');

  const rec = res.gates.find((g) => g.key === 'tasks_recoverable');
  assert.equal(rec.pass, false, 'استعادة بلا مسار store لا تُدَّعى');
  assert.match(rec.detail, /requeuePending/, 'الرفض يُسمّي السبب');
});

test('checkGates مع إحقان كل الفحوص ناجحة ⇒ canRelease=true', async () => {
  const db = makeDb();
  const probes = {};
  for (const g of schema.RELEASE_GATES) {
    probes[g.key] = () => ({ passed: true, detail: `فحص ${g.key} نجح`, evidence: `ev:${g.key}` });
  }
  const res = await gates.checkGates(db, probes);
  assert.equal(res.canRelease, true);
  assert.equal(res.gates.length, 9);
  assert.ok(res.gates.every((g) => g.pass === true));
});

test('بوابة واحدة فاشلة تُدرج في blocking', async () => {
  const db = makeDb();
  const probes = {};
  for (const g of schema.RELEASE_GATES) {
    probes[g.key] = () => ({ passed: true, detail: 'نجح' });
  }
  probes.no_double_execution = () => ({ passed: false, detail: 'تنفيذ مزدوج مرصود' });

  const res = await gates.canRelease(db, probes);
  assert.equal(res.release, false);
  assert.deepEqual(res.blocking, ['no_double_execution']);
});

test('canRelease بلا فحوص يحجب لغياب دليل التراجع', async () => {
  const db = makeDb();
  const res = await gates.canRelease(db);
  assert.equal(res.release, false);
  assert.ok(res.blocking.includes('rollback_proven'));
});

test('الفحوص الافتراضية ترصد المخالفات من الجداول', async () => {
  const db = makeDb();

  // مشروعان يتقاسمان نفس البصمة ⇒ تسرّب عزل
  db.prepare('INSERT INTO notes(id, title, type, project, fingerprint) VALUES (?,?,?,?,?)')
    .run('n1', 'A', 'note', 'P1', 'FP-same');
  db.prepare('INSERT INTO notes(id, title, type, project, fingerprint) VALUES (?,?,?,?,?)')
    .run('n2', 'A', 'note', 'P2', 'FP-same');

  // تعارض بلا مسار حل
  db.prepare('INSERT INTO note_links(source, target, kind) VALUES (?,?,?)').run('n1', 'n2', 'contradicts');

  // ملف حرج غير ممسوح وبلا سبب معلوم ⇒ يكسر بوابتين
  db.prepare('INSERT INTO quarantine(at, path, reason, severity, scanned) VALUES (?,?,?,?,?)')
    .run('2026-10-19T00:00:00.000Z', 'C:/evil.exe', '', 'critical', 0);

  // مهمة running بلا created_at ⇒ غير قابلة للاستعادة
  insertTask(db, 't-run', { status: 'running', createdAt: null });

  // حالة غير معروفة ⇒ انتقالات فاسدة
  insertTask(db, 't-zombie', { status: 'zombie', key: null, createdAt: '2026-10-19T00:00:00.000Z' });

  const res = await gates.checkGates(db, {
    rollback_proven: () => ({ passed: true, detail: 'تراجع مُثبت بدليل', evidence: 'rollback:ok' }),
  });
  const byKey = Object.fromEntries(res.gates.map((g) => [g.key, g]));

  assert.equal(byKey.no_privilege_escape.pass, false, 'حرج غير ممسوح');
  assert.equal(byKey.valid_state_transitions.pass, false, 'حالة غير معروفة');
  assert.equal(byKey.project_isolation.pass, false, 'تسرّب مشاريع');
  assert.equal(byKey.quarantine_intact.pass, false, 'حجر بلا سبب');
  assert.equal(byKey.tasks_recoverable.pass, false, 'مهمة غير قابلة للاستعادة');
  assert.equal(byKey.conflicts_have_path.pass, false, 'تعارض بلا مسار حل');
  // قيد UNIQUE على idempotency_key يمنع التكرار أصلاً
  assert.equal(byKey.no_double_execution.pass, true, 'لا مفاتيح مكررة');
  assert.equal(byKey.rollback_proven.pass, true, 'التراجع مُثبت بالدليل المُحقَن');

  assert.equal(res.canRelease, false);
});

test('نتائج البوابات تُحفظ في release_gates وتقرأها history', async () => {
  const db = makeDb();
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM release_gates').get().n;

  assert.equal(count(), 0);
  await gates.checkGates(db);
  assert.equal(count(), schema.RELEASE_GATES.length, 'ثمانية صفوف بعد أول تقييم');
  await gates.checkGates(db);
  assert.equal(count(), schema.RELEASE_GATES.length * 2, 'ستة عشر بعد التقييم الثاني');

  // rollback_proven محفوظة كفاشلة بتفصيلها الصريح
  const rb = db.prepare("SELECT passed, detail FROM release_gates WHERE gate='rollback_proven' ORDER BY id DESC").get();
  assert.equal(rb.passed, 0);
  assert.match(rb.detail, /لم يُقدَّم دليل التراجع/);

  const h = gates.history(db, 8);
  assert.equal(h.length, 8);
  assert.ok(h.every((r) => typeof r.passed === 'boolean'), 'passed منطقي في التاريخ');
  assert.ok(h.every((r) => typeof r.at === 'string' && r.at), 'at مسجّل');
  assert.equal(gates.history(db, 8)[0].id > gates.history(db, 8)[7].id, true, 'الأحدث أولاً');
});
