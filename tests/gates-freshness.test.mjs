/**
 * C6 — حارس نضارة البوابات: لا يُعرض "كل البوابات خضراء" من تقييم قديم.
 *
 * العطل المُثبت (2026-11-15): `/api/gates` يقرأ **آخر تقييم مسجَّل** لكل بوابة
 * بلا حدّ عمر، ولا أحد يعيد التقييم تلقائياً — فآخر تقييم كان قبل يومين، و
 * `releaseAllowed:true` يعرض صفر إعادة قياس. البوابة الدالّة (`backup_restorable`)
 * كانت تصف نسخة عمرها 3 أيام بينما الخزنة تغيّرت.
 *
 * القاعدة: (1) لكل بوابة عمر معلن، (2) التقييم يتجدد تلقائياً عند النبضة/الطلب
 * إذا تجاوز عمره الحد، (3) التقرير يقيس ما قِيس اليوم لا ما قِيس أمس.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_MS = 60 * 60 * 1000; // ساعة: حدّ النضارة المعلن في /api/gates

async function boot() {
  const { startLiveServer } = await import('./_live-server.mjs');
  return startLiveServer({ provider: 'mock', autonomy: 'supervised' });
}

test('C6 · كل بوابة تحمل عمرها، والعمر المعلن صريح', async (t) => {
  const SRV = await boot();
  t.after(async () => { await SRV.stop(); });
  const r = await fetch(SRV.base + '/api/gates');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.gates) && j.gates.length > 0, 'قائمة البوابات موجودة');
  for (const g of j.gates) {
    assert.ok('ageMs' in g, `البوابة ${g.key} بلا عمر معلن`);
    assert.ok('fresh' in g, `البوابة ${g.key} بلا حكم نضارة`);
  }
  assert.ok('fresh' in (j.summary || {}), 'الملخص يحمل حكم النضارة');
});

test('C6 · تقييم قديم (أقدم من الحد) يُعاد تلقائياً عند الطلب', async (t) => {
  const SRV = await boot();
  t.after(async () => { await SRV.stop(); });

  // 1) أول طلب: يُقيَّم الآن (أو يُقيَّم فعلياً لأنه لا سجل بعد)
  const first = await (await fetch(SRV.base + '/api/gates')).json();
  const before = first.gates.map(g => g.at);

  // 2) نُقدم الطوابع الزمنية في القاعدة إلى ما قبل شهر (محاكاة تقييم قديم)
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(SRV.root, 'data', 'cortex.db'));
  try {
    db.prepare("UPDATE release_gates SET at = ? WHERE at IS NOT NULL").run(new Date(Date.now() - 30 * 24 * 3600e3).toISOString());
  } finally { db.close(); }

  // 3) الطلب التالي يجب أن يعيد التقييم (لا يخدم لقطة عمرها 30 يوماً)
  const second = await (await fetch(SRV.base + '/api/gates')).json();
  const freshAt = second.gates.map(g => g.at).filter(Boolean);
  const allOld = freshAt.length > 0 && freshAt.every(a => (Date.now() - Date.parse(a)) > MAX_AGE_MS);
  assert.equal(allOld, false, `البوابات ما زالت تُعرض بتقييم عمره > ساعة: ${freshAt.join(', ')}`);
  assert.notDeepEqual(freshAt, before, 'لم يحدث أي إعادة قياس');
});

test('C6 · وعند إعادة التشغيل لا يُعرض تقييم من قبل الإقلاع', async (t) => {
  const SRV = await boot();
  t.after(async () => { await SRV.stop(); });
  const j = await (await fetch(SRV.base + '/api/gates')).json();
  const fresh = j.gates.filter(g => g.checked !== false);
  assert.ok(fresh.length > 0, 'توجد بوابات مقيَّمة');
  const stale = fresh.filter(g => Number(g.ageMs) > MAX_AGE_MS);
  assert.equal(stale.length, 0, `بوابات قديمة عند الإقلاع: ${stale.map(g => g.key).join(', ')}`);
});

test('C6 · ملف الدليل موجود: البوابات لا تُقيَّم بلا مسار فعلي', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  assert.match(src, /refreshGatesIfStale|GATES_MAX_AGE_MS/, 'آلية النضارة يجب أن تكون في الخادم لا في الواجهة');
});
