import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const schema = require('../cortex-schema');
const orc = require('../cortex-orchestrator');

function freshStore() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT)');
  db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
  db.exec('CREATE TABLE tasks(id TEXT)');
  schema.migrate(db);
  return { db, store: orc.createStore(db) };
}

// ═══════════════════════════════════════════════════════════
//  حراس الانحدار — يمنعون رجوع الأعطال المكتشفة والمُصلَحة
// ═══════════════════════════════════════════════════════════

test('حارس: تشغيلان متتاليان على نفس القاعدة ينجحان (عطل id الثابت)', async () => {
  const { store } = freshStore();
  const o = new orc.Orchestrator({ store, runAgent: async g => ({ answer: g }), maxParallel: 3 });

  const first = await o.run('حلل المشروع');
  // العدّ ديناميكي: عدد المهام يتبع التقسيم الحتمي الحالي (يتغيّر بإضافة أدوار).
  // الجوهر المُختبَر هو أن التشغيلين ينجحان معاً على نفس القاعدة، لا رقم ثابت.
  const expected = first.summary.total;
  assert.ok(expected >= 2, `التشغيل الأول يجب أن ينشئ مهام — total=${expected}`);
  assert.equal(first.summary.done, expected, `التشغيل الأول يجب أن ينجز — done=${first.summary.done}/${expected}`);

  // هذا ما كان يفشل: نفس القاعدة، مرة ثانية
  const second = await o.run('حلل المشروع');
  assert.equal(second.summary.total, expected, 'التشغيل الثاني يجب أن ينشئ نفس العدد');
  assert.equal(second.summary.done, expected, `التشغيل الثاني يجب أن ينجز — done=${second.summary.done}/${expected}`);
  assert.notEqual(first.runId, second.runId, 'كل تشغيل له معرّف مستقل');
});

test('حارس: المعرّفات المُشتقة لا تتصادم مع تشغيل سابق', async () => {
  const { db, store } = freshStore();
  const o = new orc.Orchestrator({ store, runAgent: async g => ({ answer: g }), maxParallel: 3 });

  let perRun = 0;
  for (let i = 0; i < 4; i++) {
    const out = await o.run('عدّل الملفات ثم شغّل الاختبارات');
    if (i === 0) perRun = out.summary.total;
    assert.equal(out.summary.total, perRun, `تشغيل ${i + 1} يجب أن ينشئ ${perRun} مهمة — وُجد ${out.summary.total}`);
    assert.ok(perRun >= 4, `هدف تعديلي+اختباري يجب أن يولّد 4 أدوار على الأقل — وُجد ${perRun}`);
    assert.equal(out.summary.failed, 0, `تشغيل ${i + 1} بلا فشل`);
    assert.equal(out.summary.blocked, 0, `تشغيل ${i + 1} بلا تعليق`);
  }

  // كل الصفوف محفوظة بمعرّفات فريدة
  const rows = db.prepare('SELECT id FROM agent_tasks').all();
  const ids = rows.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'كل معرّف فريد');
  assert.equal(ids.length, 4 * perRun, `4 تشغيلات × ${perRun} مهمة = ${4 * perRun} — وُجد ${ids.length}`);
});

test('حارس: تصادم غير مشروع في createTasks يُعلن ولا يُبتلع', () => {
  const { store } = freshStore();
  const base = { runId: 'run-x', role: 'analyst', goal: 'g', dependsOn: [] };

  store.createTasks([{ ...base, id: 'run-x-t1', idempotencyKey: 'k1' }]);

  // إدراج نفس المعرّف بتشغيل مختلف ومفتاح مختلف ⇒ تصادم id ⇒ يجب أن يرمي
  assert.throws(() => {
    store.createTasks([{ id: 'run-x-t1', runId: 'run-y', role: 'analyst', goal: 'g', dependsOn: [], idempotencyKey: 'k2' }]);
  }, /createTasks failed/, 'تصادم المعرّف يجب أن يُعلن');

  // إدراج نفس المفتاح لنفس التشغيل ⇒ تكرار مشروع ⇒ يُتجاهل بلا رمي
  assert.doesNotThrow(() => {
    store.createTasks([{ id: 'run-x-t1', runId: 'run-x', role: 'analyst', goal: 'g', dependsOn: [], idempotencyKey: 'k1' }]);
  }, 'التكرار لنفس التشغيل مسموح');
});

test('حارس: الفشل ينحدر على التبعيات ولا يترك شيئاً معلقاً', async () => {
  const { store } = freshStore();
  const o = new orc.Orchestrator({
    store,
    maxParallel: 2,
    runAgent: async (g) => { if (g.includes('تحليل')) throw new Error('فشل متعمد'); return { answer: g }; }
  });

  const out = await o.run('حلل المشروع');
  for (const t of out.tasks) {
    assert.ok(['done', 'failed', 'blocked'].includes(t.status),
      `لا مهمة معلقة — ${t.role} حالته ${t.status}`);
  }
  assert.equal(out.summary.verified, false, 'وجود فشل يمنع اعتبار التشغيل متحققاً');
});

test('حارس: المنسّق يمرّر صلاحيات الدور للوكيل', async () => {
  const { store } = freshStore();
  const seen = [];

  const o = new orc.Orchestrator({
    store,
    maxParallel: 3,
    runAgent: async (goal, subCtx) => {
      seen.push({ role: subCtx.role, scopes: subCtx.allowedScopes });
      return { answer: goal };
    }
  });

  await o.run('عدّل الملفات ثم شغّل الاختبارات');

  assert.ok(seen.length >= 3, 'يجب تشغيل عدة أدوار');
  for (const s of seen) {
    assert.ok(s.role, 'كل مهمة تحمل دورها');
    assert.ok(Array.isArray(s.scopes) && s.scopes.length > 0, `الدور ${s.role} يجب أن يحمل نطاقاته`);
    // حدود الصلاحيات تُفرض من الخارج — دستور §33
    assert.deepEqual(s.scopes, orc.ROLES[s.role].scopes, `نطاقات ${s.role} مطابقة لتعريف الدور`);
  }

  const builder = seen.find(s => s.role === 'builder');
  assert.ok(builder, 'الهدف التعديلي يجب أن يولّد دور builder');
  assert.ok(builder.scopes.includes('filesystem'), 'builder يحتاج نطاق الملفات');
  assert.equal(builder.scopes.includes('sandbox'), false, 'builder لا يملك نطاق التنفيذ');
});
