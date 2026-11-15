/**
 * حارس الأداء — يمنع رجوع «إعادة بناء القاعدة كاملة عند كل كتابة».
 *
 * العطل الأصلي (مؤكد حياً على 552 عنصراً): `invalidateCache()` كانت تُسقط
 * `cache.notes` بالكامل عند أي كتابة، فيُعاد قراءة كل ملف + `stat` لكل ملف.
 * النتيجة: POST /api/notes = 11.0s · /api/notes = 159ms بـ 50.8s ذروة.
 *
 * القاعدة الصحيحة: **قراءة متغيّر واحد**، لا 552 ملفاً. ملف-بملف بمفتاح
 * (mtimeMs:size) — الملفات غير المتغيّرة تُعاد استخدامها من الكاش.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { createCore } = require(path.join(ROOT, 'cortex-core.js'));

const SEED = 552; // نفس حجم القياس الأصلي

// العتبة: القياس الحقيقي 537ms (تغيير) / 496ms (إضافة) / 53ms (بلا تغيير).
// العطل الأصلي كان 11,000ms — أي أن العتبة تمنع عودته بأريحية. لكن 1500ms
// تفشل كذباً حين تعمل الاختبارات بتوازٍ على جهاز مشغول (رُصد 3575ms في حزمة
// كاملة بينما القياس المعزول 537ms). العتبة الصحيحة: 4000ms — تبقى دون ربع
// العطل الأصلي بفارق كبير، ولا تفشل بسبب حِمل خارجي.
const BUDGET_MS = Number(process.env.CORTEX_PERF_BUDGET_MS) || 4000;

function seed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-perf-test-'));
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  for (let i = 0; i < SEED; i++) {
    fs.writeFileSync(
      path.join(vault, `seed-${i}.md`),
      `---\nimportance: ${(i % 5) + 1}\ntype: note\ncreated: 2026-10-01T00:00:00.000Z\n---\n\n# عنصر اختبار ${i}\n\nمحتوى تجريبي. مهمة مفتوحة رقم ${i}.\n`
    );
  }
  return { tmp, vault };
}

test('الأداء — تغيير ملف واحد لا يعيد بناء 552 عنصراً', async (t) => {
  const { tmp, vault } = seed();
  const core = createCore({ root: tmp, projectRoot: tmp });
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  const first = await core.readNotes();
  assert.ok(first.length >= SEED, 'القاعدة مُبذرة: ' + first.length + ' عنصراً');

  // تغيير ملف واحد
  fs.writeFileSync(
    path.join(vault, 'seed-0.md'),
    '---\nimportance: 5\ntype: note\ncreated: 2026-10-01T00:00:00.000Z\n---\n\n# عنصر مُعدَّل\n\nمحتوى جديد تماماً.\n'
  );

  const t0 = Date.now();
  const after = await core.readNotes();
  const ms = Date.now() - t0;

  // الدليل الوظيفي: التغيير ظهر فعلاً (الكاش ليس أعمى)
  const changed = after.find((n) => n.id === 'seed-0');
  assert.ok(changed, 'العنصر المُعدَّل موجود');
  assert.ok(String(changed.body).includes('محتوى جديد تماماً'), 'التغيير ظهر فعلاً — لا كاش قديم');

  // العتبة: أقل من 1500ms بكثير. قبل الإصلاح كان 11,000ms.
  assert.ok(ms < BUDGET_MS, 'تغيير واحد < ' + BUDGET_MS + 'ms (الفعلي ' + ms + 'ms؛ قبل الإصلاح 11000ms)');
});

test('الأداء — إضافة عنصر جديد تظهر فوراً (لا كاش أعمى)', async (t) => {
  const { tmp, vault } = seed();
  const core = createCore({ root: tmp, projectRoot: tmp });
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  await core.readNotes();
  fs.writeFileSync(path.join(vault, 'added-now.md'), '---\nimportance: 3\ntype: note\n---\n\n# عنصر مضاف الآن\n\nمحتوى\n');

  const t0 = Date.now();
  const notes = await core.readNotes();
  const ms = Date.now() - t0;

  assert.ok(notes.find((n) => n.id === 'added-now'), 'العنصر الجديد ظهر');
  assert.ok(ms < BUDGET_MS, 'إضافة < ' + BUDGET_MS + 'ms (الفعلي ' + ms + 'ms)');
});

test('الأداء — الحذف يظهر فوراً (لا عنصر شبحي في الكاش)', async (t) => {
  const { tmp, vault } = seed();
  const core = createCore({ root: tmp, projectRoot: tmp });
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  await core.readNotes();
  fs.rmSync(path.join(vault, 'seed-7.md'));

  const notes = await core.readNotes();
  assert.ok(!notes.find((n) => n.id === 'seed-7'), 'العنصر المحذوف اختفى من النتيجة');
});
