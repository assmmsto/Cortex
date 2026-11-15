/**
 * C7 — حارس بوابتي الإطلاق: `tasks_recoverable` و`rollback_proven`.
 *
 * العطل المُثبت (2026-11-15، قياس حيّ): بعد إصلاح نضارة البوابات ظهرت حمراء:
 *   • tasks_recoverable — «لا مسار استعادة: store.requeuePending غير متاح»
 *     السبب: `refreshGatesIfStale` كانت تُنادي `g.checkGates(db)` **بلا** `store`،
 *     والفحص (cortex-gates.js:334) يشترط `opts.store` لإثبات الاستعادة.
 *   • rollback_proven — «لم يُقدَّم دليل التراجع»
 *     السبب: المسبار كان موجوداً في `/api/gates/check` فقط، لا في التقييم التلقائي.
 *
 * القاعدة: التقييم التلقائي يقيس ما يقيسه الزر اليدوي — لا بوابتان بمسارين.
 * ومبدأ §45 يبقى: لا نجاح بلا دليل مقروء (الفحص يكتب ثم يتراجع ثم يتحقق).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

/** يسجّل بوابة بقيمة قديمة قديمة لإجبار التجديد عند أول طلب. */
async function forceStale(SRV) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(SRV.root, 'data', 'cortex.db'));
  try {
    const old = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
    const gates = db.prepare('SELECT DISTINCT gate FROM release_gates').all().map(r => r.gate);
    for (const g of gates) db.prepare('INSERT INTO release_gates(at, gate, passed, detail, evidence) VALUES (?,?,?,?,?)').run(old, g, 1, 'stale', null);
    return gates;
  } finally { db.close(); }
}

test('C7 · التقييم التلقائي يُمرّر store فيقيس tasks_recoverable بدليل', async (t) => {
  const { startLiveServer } = await import('./_live-server.mjs');
  const SRV = await startLiveServer({ provider: 'mock', autonomy: 'supervised' });
  t.after(async () => { await SRV.stop(); });

  await forceStale(SRV);
  const j = await (await fetch(SRV.base + '/api/gates')).json();
  const gate = j.gates.find(g => g.key === 'tasks_recoverable');
  assert.ok(gate, 'البوابة موجودة');
  assert.ok(gate.fresh, 'البوابة قِيست الآن لا من لقطة قديمة');
  assert.doesNotMatch(String(gate.detail || ''), /requeuePending غير متاح|requeuePending unavailable/,
    `البوابة ما زالت تفشل لأن store لم يُمرَّر: ${gate.detail}`);
});

test('C7 · rollback_proven يُقاس تلقائياً بدليل لا «لم يُقدَّم دليل»', async (t) => {
  const { startLiveServer } = await import('./_live-server.mjs');
  const SRV = await startLiveServer({ provider: 'mock', autonomy: 'supervised' });
  t.after(async () => { await SRV.stop(); });

  await forceStale(SRV);
  const j = await (await fetch(SRV.base + '/api/gates')).json();
  const gate = j.gates.find(g => g.key === 'rollback_proven');
  assert.ok(gate, 'البوابة موجودة');
  assert.ok(gate.fresh, 'البوابة قِيست الآن');
  assert.doesNotMatch(String(gate.detail || ''), /لم يُقدَّم دليل التراجع|no rollback evidence/i,
    `التقييم التلقائي لا يمرّر مسبار التراجع: ${gate.detail}`);
  assert.equal(gate.passed, true, `التراجع يجب أن يُثبت على عنصر حقيقي: ${gate.detail}`);
});

test('C7 · المسبار يزيل صفّه ولا يترك أثراً في agent_tasks', async (t) => {
  const { startLiveServer } = await import('./_live-server.mjs');
  const SRV = await startLiveServer({ provider: 'mock', autonomy: 'supervised' });
  t.after(async () => { await SRV.stop(); });
  await forceStale(SRV);
  await fetch(SRV.base + '/api/gates');

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(SRV.root, 'data', 'cortex.db'), { readOnly: true });
  try {
    const left = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE id LIKE '__rollback_probe_%'").get().n;
    assert.equal(left, 0, `صفوف مسبار متروكة في القاعدة: ${left}`);
  } finally { db.close(); }
});
