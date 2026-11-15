/**
 * H1 — حارس عزل البيانات: أي سكربت/اختبار في `tests/` يُنشئ قلب المنتج
 * (`createCore()` بلا `root`) يكتب في **خزنة المنتج الحيّة** — لا في بيئة اختبار.
 *
 * العطل المُثبت بالقياس (2026-11-15): تشغيل `tests/_probe-cost.cjs` غيّر
 * `data/audit.log` و`data/cortex.db` وأنشأ **20 ملاحظة `prof-note-*` حقيقية**
 * في `vault/` (369 ⇒ 389) في أقل من ثانية. والسبب: `createCore()` بلا جذر
 * يقرأ `root = process.cwd()` — أي مجلد المشروع، أي بيانات المستخدم.
 *
 * القاعدة: الاستدعاء بلا جذر مسموح فقط داخل تعليق (شرح السلوك)، لا في كود.
 * الاختبارات تُنشئ قلبها على جذر مؤقت صريح: `createCore({ root: tmp })`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TESTS_DIR = path.join(process.cwd(), 'tests');

/** يزيل تعليقات الكتلة والسطر قبل الفحص — كود فقط، لا نصوص شرح. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('H1 · لا سكربت في tests/ يُنشئ قلباً على جذر المنتج بلا root صريح', () => {
  const offenders = [];
  const files = fs.readdirSync(TESTS_DIR)
    .filter((f) => /\.(cjs|mjs|js)$/.test(f))
    .filter((f) => f !== 'isolation-guard.test.mjs');
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(TESTS_DIR, f), 'utf8'); } catch { continue; }
    const code = stripComments(src);
    if (/createCore\(\s*\)/.test(code)) offenders.push(f);
    if (/createProjectMemory\(\s*\{\s*\}\s*\)/.test(code)) offenders.push(`${f} (createProjectMemory)`);
  }
  assert.deepEqual(offenders, [], `سكربتات تكتب في بيانات المنتج: ${offenders.join(', ')}`);
});

test('H1 · createCore() بلا root يحلّ إلى cwd — سلوك مُوثَّق لا مضمون (قفل السبب الجذري)', () => {
  // إن تغيّر هذا السلوك في المستقبل، يصبح الحارس أعلاه غير ضروري — وهذا الاختبار
  // هو الذي يقول ذلك صراحةً بدل أن يبقى الحارس صامتاً بلا سبب.
  const src = fs.readFileSync(path.join(process.cwd(), 'cortex-core.js'), 'utf8');
  assert.match(src, /path\.resolve\(config\.root \|\| process\.cwd\(\)\)/, 'الجذر الافتراضي هو cwd');
});
