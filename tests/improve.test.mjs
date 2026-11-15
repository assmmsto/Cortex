import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const schema = require('../cortex-schema');
const improve = require('../cortex-improve');

// ── قاعدة اختبار حقيقية في الذاكرة: نفس هجرة المشروع، بلا بيانات مصنوعة يدوياً ──
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT)');
  db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
  db.exec('CREATE TABLE tasks(id TEXT)');
  schema.migrate(db);
  return db;
}

const AT = '2026-01-01T00:00:00.000Z';

function addTask(db, { id, status = 'done', role = 'builder', attempts = 0, startedAt = null, finishedAt = null, runId = 'run-1' }) {
  db.prepare(
    'INSERT INTO agent_tasks(id, run_id, role, goal, status, attempts, created_at, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, runId, role, `هدف ${id}`, status, attempts, AT, startedAt, finishedAt);
}

// أثر أداة فعلي في السجل — هو الدليل الوحيد المعتبر (دستور §8 «الدليل أو لا شيء»)
function addToolEvidence(db, taskId, tool = 'search_notes', at = AT) {
  db.prepare('INSERT INTO agent_events(run_id, task_id, type, payload, at) VALUES (?,?,?,?,?)')
    .run('run-1', taskId, 'tool_result', JSON.stringify({ tool, ok: true }), at);
}

function addMcpCall(db, { server = 'fs', tool, needsApproval = 0, ok = 1 }) {
  db.prepare('INSERT INTO mcp_calls(at, server, tool, args, result, ok, changed_files, needs_approval) VALUES (?,?,?,?,?,?,?,?)')
    .run(AT, server, tool, '{}', '{}', ok, null, needsApproval);
}

function tableCounts(db, tables) {
  const out = {};
  for (const t of tables) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { out[t] = -1; }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  1) التقييم الذاتي — قياس حتمي من الجداول
// ═══════════════════════════════════════════════════════════════════

test('تقييم قاعدة فارغة: لا يرمي ويعيد مقاييس صفرية ويحفظ صف self_eval', () => {
  const db = freshDb();
  const r = improve.evaluate(db, { scope: 'empty' });

  assert.equal(r.ok, true);
  const m = r.metrics;
  assert.equal(m.tasks, 0);
  assert.equal(m.done, 0);
  assert.equal(m.failed, 0);
  assert.equal(m.successRate, 0);
  assert.equal(m.successRatePct, 0);
  assert.equal(m.avgDurationMs, 0);
  assert.equal(m.tasksWithoutEvidence, 0);
  assert.equal(m.noEvidenceRatio, 0);
  assert.equal(m.retriedTasks, 0);
  assert.equal(m.mcpApprovalTools, 0);

  assert.ok(Array.isArray(r.weaknesses) && Array.isArray(r.proposals));
  assert.equal(r.proposals.length, 0, 'لا اقتراح بلا دليل');
  assert.ok(r.weaknesses.some(w => w.code === 'no_data'), 'ضعف «لا بيانات» معلن');

  const row = db.prepare('SELECT scope, metrics, weaknesses, proposals FROM self_eval ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.scope, 'empty');
  assert.equal(JSON.parse(row.metrics).tasks, 0);
  assert.equal(Array.isArray(JSON.parse(row.proposals)), true);
});

test('تقييم قاعدة فيها مهام: المقاييس صحيحة (2 done و1 failed ⇒ نجاح 66.67%)', () => {
  const db = freshDb();
  addTask(db, { id: 't1', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' });
  addTask(db, { id: 't2', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:03.000Z' });
  addTask(db, { id: 't3', status: 'failed' });
  addToolEvidence(db, 't1');
  addToolEvidence(db, 't2');
  addToolEvidence(db, 't3');

  const m = improve.evaluate(db, { scope: 'metrics' }).metrics;
  assert.equal(m.tasks, 3);
  assert.equal(m.done, 2);
  assert.equal(m.failed, 1);
  assert.equal(m.pending, 0);
  assert.ok(Math.abs(m.successRatePct - 66.67) < 0.01, `نسبة النجاح 66.67% — وُجد ${m.successRatePct}`);
  assert.ok(Math.abs(m.successRate - 0.6667) < 0.0001, `الكسر 0.6667 — وُجد ${m.successRate}`);
  assert.equal(m.timedTasks, 2);
  assert.equal(m.avgDurationMs, 2000, 'متوسط (1000+3000)/2 = 2000ms');
  assert.equal(m.tasksWithoutEvidence, 0, 'كل المهام لها أثر');
  assert.equal(m.retriedTasks, 0);
  assert.equal(m.runs, 1);

  // نجاح 66.67% أقل من الحد 80% ⇒ ضعف معلن واقتراح مشتق منه
  assert.ok(m.successRatePct < 80);
  const r = improve.evaluate(db, { scope: 'metrics' });
  assert.ok(r.weaknesses.some(w => w.code === 'low_success_rate'));
  const prop = r.proposals.find(p => p.metric === 'successRate');
  assert.ok(prop, 'اقتراح مشتق من ضعف نسبة النجاح');
  assert.equal(prop.target, 'agent:orchestrator');
  assert.equal(typeof prop.acceptance, 'string');
  assert.ok(prop.reason.length > 5);
});

test('مؤشر «مهام بلا أثر أداة» يُحتسب — مهمة done بلا tool_result', () => {
  const db = freshDb();
  addTask(db, { id: 'e1', status: 'done' });
  addTask(db, { id: 'e2', status: 'done' });
  addTask(db, { id: 'e3', status: 'done' });
  addToolEvidence(db, 'e1');
  addToolEvidence(db, 'e2');
  // e3 وحدها بلا أثر ⇒ 1/3

  const r = improve.evaluate(db, { scope: 'evidence' });
  assert.equal(r.metrics.tasksWithoutEvidence, 1);
  assert.ok(Math.abs(r.metrics.noEvidenceRatio - 0.3333) < 0.0001, `1/3 = 0.3333 — وُجد ${r.metrics.noEvidenceRatio}`);
  assert.ok(Math.abs(r.metrics.noEvidencePct - 33.33) < 0.01);

  // 33.33% > 20% ⇒ ضعف إلزامي واقتراح بإلزام أداة لكل مهمة
  assert.ok(r.weaknesses.some(w => w.code === 'evidence_gap'));
  const prop = r.proposals.find(p => p.id === 'improv-evidence');
  assert.ok(prop, 'اقتراح «إلزام أداة لكل مهمة» مشتق من الضعف');
  assert.equal(prop.target, 'agent:role-brief');
  assert.equal(prop.metric, 'noEvidenceRatio');
  assert.ok(['id', 'title', 'target', 'acceptance', 'reason', 'metric'].every(k => prop[k] != null), 'شكل الاقتراح كامل');
});

test('مقاييس إضافية: إعادة المحاولة وأدوات MCP المحتاجة موافقة', () => {
  const db = freshDb();
  addTask(db, { id: 'r1', status: 'done', attempts: 3 });
  addTask(db, { id: 'r2', status: 'done', attempts: 1 });
  addTask(db, { id: 'r3', status: 'failed', attempts: 2 });
  addMcpCall(db, { tool: 'write_file', needsApproval: 1 });
  addMcpCall(db, { tool: 'write_file', needsApproval: 1 });
  addMcpCall(db, { tool: 'run_shell', needsApproval: 1 });
  addMcpCall(db, { tool: 'search_notes', needsApproval: 0 });

  const m = improve.evaluate(db, { scope: 'extra' }).metrics;
  assert.equal(m.retriedTasks, 2, 'محاولات > 1 في مهمتين');
  assert.equal(m.mcpApprovalTools, 2, 'أداتان مستقلّتان تحتاجان موافقة');
  assert.equal(m.mcpApprovalCalls, 3);
  assert.equal(m.mcpCalls, 4);
});

test('القواعد حتمية: نفس القاعدة ⇒ نفس المقاييس والاقتراحات', () => {
  const db = freshDb();
  addTask(db, { id: 'd1', status: 'done' });
  addTask(db, { id: 'd2', status: 'done' });
  addToolEvidence(db, 'd1');
  const a = improve.evaluate(db, { scope: 'det' });
  const b = improve.evaluate(db, { scope: 'det' });
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.proposals.map(p => [p.id, p.impact]), b.proposals.map(p => [p.id, p.impact]));
});

// ═══════════════════════════════════════════════════════════════════
//  2) حارس الأمان — المحرم الدستوري المطلق
// ═══════════════════════════════════════════════════════════════════

test('guard يرفض أي مقترح يمسّ سياسة أمان أو صلاحية', () => {
  const bad = [
    { id: 'b1', title: 'تعديل سياسة الأمان', target: 'policy:core', acceptance: 'السماح بحرية أوسع' },
    { id: 'b2', title: 'توسيع صلاحيات الأدوات', target: 'agent:role-brief', acceptance: 'منح صلاحيات أوسع لكل أداة' },
    { id: 'b3', title: 'تخطي التحقق', target: 'auth:token', acceptance: 'bypass the permission check' },
    { id: 'b4', title: 'رفع حدود الوصول', target: 'security:gate', acceptance: 'تجاوز صلاحيات المستخدم' },
  ];
  for (const p of bad) {
    const g = improve.guard(p);
    assert.equal(g.allowed, false, `${p.id} يجب أن يُرفض`);
    assert.match(g.reason, /مساس بالأمان ممنوع/, `${p.id}: سبب الرفض الصريح`);
  }
});

test('guard يقبل المقترح العادي ولا يخترع أسباب رفض', () => {
  const good = {
    id: 'g1', title: 'إلزام أداة لكل مهمة', target: 'agent:role-brief',
    acceptance: 'كل مهمة مكتملة تحمل أثر أداة واحداً على الأقل',
  };
  const g = improve.guard(good);
  assert.equal(g.allowed, true);
  assert.equal(g.reason, '');
});

test('المقترح المرفوض أمنياً يُخزَّن rejected ويُرفض الاعتماد والتجربة عليه', async () => {
  const db = freshDb();
  const out = improve.admitProposal(db, {
    id: 'sec1', title: 'تعديل سياسة الصلاحيات', target: 'policy:tools',
    acceptance: 'منح الأدوات صلاحيات أوسع', metric: 'mcpApprovalTools',
  });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /مساس بالأمان ممنوع/);

  const row = db.prepare('SELECT verdict, trial_result FROM improvement_trials WHERE id=?').get(out.trialId);
  assert.equal(row.verdict, 'rejected');
  assert.match(row.trial_result, /مساس بالأمان ممنوع/);

  const t = await improve.runTrial(db, out.trialId, { baselineValue: 1, measure: () => 0 });
  assert.equal(t.ok, false, 'لا تجربة على مقترح مرفوض أمنياً');

  const d = improve.decide(db, out.trialId, { accept: true, by: 'omar' });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, 'rejected');

  const a = improve.markApplied(db, out.trialId);
  assert.equal(a.ok, false, 'لا تطبيق لمقترح مرفوض');
});

test('خطط المشروع لا تولّد أي مقترح يمسّ الأمان', () => {
  const db = freshDb();
  addTask(db, { id: 'p1', status: 'failed', attempts: 3 });
  addTask(db, { id: 'p2', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z' });
  addMcpCall(db, { tool: 'write_file', needsApproval: 1 });
  const p = improve.plan(db, { scope: 'rules' });
  assert.ok(p.proposals.length >= 3, `اقتراحات متعددة — وُجد ${p.proposals.length}`);
  for (const prop of p.proposals) {
    assert.equal(improve.guard(prop).allowed, true, `${prop.id} يجب أن يمرّ من الحارس`);
    assert.equal(prop.allowed, true);
  }
  assert.equal(p.rejected.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
//  3) الخطة والتجربة والاعتماد — الدورة المنضبطة
// ═══════════════════════════════════════════════════════════════════

function seedEvidenceGap(db) {
  addTask(db, { id: 'c1', status: 'done' });
  addTask(db, { id: 'c2', status: 'done' });
  addTask(db, { id: 'c3', status: 'done' });
  addToolEvidence(db, 'c1');
  addToolEvidence(db, 'c2');
  // c3 بلا أثر ⇒ 1/3 = 33.33% > 20%
}

test('plan يشغّل evaluate ويخزّن التجارب بحالة proposed مرتّبة بالأثر', () => {
  const db = freshDb();
  seedEvidenceGap(db);
  const p = improve.plan(db, { scope: 'plan' });

  assert.equal(p.ok, true);
  assert.equal(p.metrics.noEvidencePct, 33.33);
  assert.ok(p.trials.length >= 1);
  assert.equal(p.proposals[0].id, 'improv-evidence', 'الأعلى أثراً أولاً');

  for (const t of p.trials) {
    assert.equal(t.verdict, 'proposed');
    assert.equal(t.applied, false);
  }
  const impacts = p.proposals.map(x => x.impact);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a), 'ترتيب تنازلي بالأثر');

  const stored = db.prepare('SELECT COUNT(*) AS n FROM improvement_trials').get().n;
  assert.equal(stored, p.trials.length);
});

test('decide يرفض الاعتماد قبل التجربة', () => {
  const db = freshDb();
  seedEvidenceGap(db);
  const p = improve.plan(db, { scope: 'pre' });
  const trialId = p.proposals[0].trialId;

  const d = improve.decide(db, trialId, { accept: true, by: 'omar' });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, 'proposed');
  assert.match(d.error, /قبل التجربة/);

  const a = improve.markApplied(db, trialId);
  assert.equal(a.ok, false, 'لا تطبيق قبل الاعتماد');
  assert.equal(db.prepare('SELECT applied FROM improvement_trials WHERE id=?').get(trialId).applied, 0);
});

test('دورة كاملة: plan ⇒ runTrial (أفضل من الأساس) ⇒ decide(accept) ⇒ markApplied', async () => {
  const db = freshDb();
  seedEvidenceGap(db);

  const watched = ['agent_tasks', 'agent_events', 'notes', 'note_links', 'mcp_calls', 'model_usage'];
  const beforeCycle = tableCounts(db, watched);

  // 1) الخطة
  const p = improve.plan(db, { scope: 'cycle' });
  const prop = p.proposals[0];
  assert.equal(prop.id, 'improv-evidence');
  assert.equal(prop.allowed, true);
  const trialId = prop.trialId;
  assert.ok(Number.isInteger(trialId));

  // 2) التجربة المعزولة: القياس يُحقن، والأساس يُقرأ من الاقتراح
  let receivedCtx = null;
  const trial = await improve.runTrial(db, trialId, {
    measure: (ctx) => { receivedCtx = ctx; return 0.05; }, // 33.33% ⇒ 5%
  });
  assert.equal(trial.ok, true);
  assert.equal(trial.verdict, 'trialed');
  assert.equal(trial.trialResult.isolation, 'ok');
  assert.equal(trial.trialResult.passed, true, '5% ≤ نصف الأساس ⇒ تحقّق معيار القبول');
  assert.equal(trial.trialResult.better, true);
  assert.ok(trial.delta.gain > 0);
  assert.equal(receivedCtx.metric, 'noEvidenceRatio');
  assert.equal(receivedCtx.baseline, p.metrics.noEvidenceRatio);
  assert.equal(Object.isFrozen(receivedCtx), true, 'سياق التجربة مجمّد — عزل');

  // 3) الاعتماد
  const d = improve.decide(db, trialId, { accept: true, by: 'omar' });
  assert.equal(d.ok, true);
  assert.equal(d.verdict, 'accepted');
  assert.equal(d.decidedBy, 'omar');
  assert.ok(d.decidedAt);

  // 4) التطبيق
  const a = improve.markApplied(db, trialId);
  assert.equal(a.ok, true);
  assert.equal(a.applied, true);

  const row = db.prepare('SELECT verdict, decided_by, applied, trial_result FROM improvement_trials WHERE id=?').get(trialId);
  assert.equal(row.verdict, 'accepted');
  assert.equal(row.decided_by, 'omar');
  assert.equal(row.applied, 1);
  assert.equal(JSON.parse(row.trial_result).passed, true);

  // الوحدة لا تكتب إلا في جداول التحسين + audit_log: لا مساس بأي شيء آخر
  assert.deepEqual(tableCounts(db, watched), beforeCycle, 'لا تغيير في جداول التشغيل أو المعرفة');
  const auditTypes = db.prepare('SELECT type FROM audit_log').all().map(r => r.type);
  assert.ok(auditTypes.includes('improvement_proposed'), 'أثر الاقتراح مسجّل');
  assert.ok(auditTypes.includes('improvement_trial'), 'أثر التجربة مسجّل');
  assert.ok(auditTypes.includes('improvement_decision'), 'أثر القرار مسجّل');
  assert.ok(auditTypes.includes('improvement_applied'), 'أثر التطبيق مسجّل');

  // التاريخ يعرض الحالة النهائية
  const h = improve.history(db, 10);
  assert.ok(Array.isArray(h) && h.length >= 1);
  const head = h.find(x => x.id === trialId);
  assert.equal(head.verdict, 'accepted');
  assert.equal(head.applied, true);
  assert.equal(head.title, prop.title);
});

test('decide يرفض الاعتماد إذا كانت التجربة أسوأ من الأساس', async () => {
  const db = freshDb();
  seedEvidenceGap(db);
  const p = improve.plan(db, { scope: 'worse' });
  const trialId = p.proposals[0].trialId;

  const trial = await improve.runTrial(db, trialId, { measure: () => 0.9 }); // أسوأ
  assert.equal(trial.ok, true, 'التجربة نُفّذت فعلاً');
  assert.equal(trial.trialResult.passed, false);
  assert.equal(trial.trialResult.better, false);
  assert.equal(trial.verdict, 'trialed');

  const d = improve.decide(db, trialId, { accept: true, by: 'omar' });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, 'trialed', 'تبقى قيد التجربة — لا اعتماد');
  assert.match(d.error, /ليست أفضل من الأساس/);
  assert.equal(db.prepare('SELECT verdict FROM improvement_trials WHERE id=?').get(trialId).verdict, 'trialed');
  assert.equal(improve.markApplied(db, trialId).ok, false, 'لا تطبيق بلا اعتماد');

  // التراجع مسار مشروع: verdict='reverted' ويُسجَّل صاحبه
  const r = improve.decide(db, trialId, { accept: false, by: 'sara' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'reverted');
  assert.equal(db.prepare('SELECT decided_by FROM improvement_trials WHERE id=?').get(trialId).decided_by, 'sara');
});

test('معيار القبول يُحكم بكود: اتجاه up يحتاج عشر نقاط، ولا يكفيه تحسّن ضئيل', async () => {
  const db = freshDb();
  addTask(db, { id: 's1', status: 'done' });
  addTask(db, { id: 's2', status: 'failed' });
  addTask(db, { id: 's3', status: 'failed' });
  addToolEvidence(db, 's1');
  addToolEvidence(db, 's2');
  addToolEvidence(db, 's3');

  const p = improve.plan(db, { scope: 'up' });
  const prop = p.proposals.find(x => x.id === 'improv-success');
  assert.ok(prop, 'اقتراح نسبة النجاح موجود');
  assert.equal(prop.metric, 'successRate');

  // +5 نقاط فقط ⇒ أقل من العشر المطلوبة
  const weak = await improve.runTrial(db, prop.trialId, { baselineValue: 0.3333, measure: () => 0.3833 });
  assert.equal(weak.trialResult.passed, false, 'تحسّن 5 نقاط لا يستوفي 10');

  const db2 = freshDb();
  addTask(db2, { id: 's1', status: 'done' });
  addTask(db2, { id: 's2', status: 'failed' });
  addTask(db2, { id: 's3', status: 'failed' });
  addToolEvidence(db2, 's1');
  addToolEvidence(db2, 's2');
  addToolEvidence(db2, 's3');
  const p2 = improve.plan(db2, { scope: 'up2' });
  const prop2 = p2.proposals.find(x => x.id === 'improv-success');
  const strong = await improve.runTrial(db2, prop2.trialId, { baselineValue: 0.3333, measure: () => 0.4334 });
  assert.equal(strong.trialResult.passed, true, '10.01 نقطة تستوفي المعيار');
  assert.equal(improve.decide(db2, prop2.trialId, { accept: true, by: 'omar' }).verdict, 'accepted');
});

test('العزل مُثبَت: قياس يغيّر حالة القاعدة يُرفض ولا يُعتمد', async () => {
  const db = freshDb();
  seedEvidenceGap(db);
  const p = improve.plan(db, { scope: 'iso' });
  const trialId = p.proposals[0].trialId;

  const out = await improve.runTrial(db, trialId, {
    measure: () => {
      // دالة القياس تحاول الكتابة في جداول التشغيل — عزل مكسور
      addTask(db, { id: 'sneaky', status: 'done' });
      return 0.01;
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /انتهاك العزل/);
  assert.equal(out.trialResult.isolation, 'violated');
  assert.equal(db.prepare('SELECT verdict FROM improvement_trials WHERE id=?').get(trialId).verdict, 'proposed');
  assert.equal(improve.decide(db, trialId, { accept: true, by: 'omar' }).ok, false);
});

test('لا تجربة على تجربة محسومة، ولا حكم بلا رقم', async () => {
  const db = freshDb();
  seedEvidenceGap(db);
  const p = improve.plan(db, { scope: 'guard2' });
  const trialId = p.proposals[0].trialId;

  assert.equal((await improve.runTrial(db, trialId, { measure: 'not-a-function' })).ok, false);
  assert.equal((await improve.runTrial(db, 99999, { measure: () => 1 })).ok, false);

  await improve.runTrial(db, trialId, { measure: () => 0.01 });
  improve.decide(db, trialId, { accept: true, by: 'omar' });
  const again = await improve.runTrial(db, trialId, { measure: () => 0.0 });
  assert.equal(again.ok, false, 'التجربة المحسومة لا تُعاد');

  const db2 = freshDb();
  seedEvidenceGap(db2);
  const p2 = improve.plan(db2, { scope: 'nan' });
  const nan = await improve.runTrial(db2, p2.proposals[0].trialId, { measure: () => null });
  assert.equal(nan.ok, false);
  assert.match(nan.error, /قياس غير رقمي/);
});

// ═══════════════════════════════════════════════════════════════════
//  4) سجل التدقيق محمي (دستور §38)
// ═══════════════════════════════════════════════════════════════════

test('محاولة تعديل أو حذف audit_log تُرفض — الحماية من المحرّك', () => {
  const db = freshDb();
  improve.evaluate(db, { scope: 'audit' }); // يولّد أثراً حقيقياً
  const row = db.prepare('SELECT id, type FROM audit_log ORDER BY id DESC LIMIT 1').get();
  assert.ok(row, 'سجل التدقيق مكتوب');

  assert.throws(() => {
    db.prepare('UPDATE audit_log SET type=? WHERE id=?').run('tampered', row.id);
  }, 'التعديل يجب أن يُرفض');

  assert.throws(() => {
    db.prepare('DELETE FROM audit_log WHERE id=?').run(row.id);
  }, 'الحذف يجب أن يُرفض');

  const still = db.prepare('SELECT type FROM audit_log WHERE id=?').get(row.id);
  assert.equal(still.type, row.type, 'الصف لم يتغيّر');
});
