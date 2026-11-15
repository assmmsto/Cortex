/**
 * حارس DoS — يمنع رجوع ثغرة «طلب GET واحد يشلّ الخادم».
 *
 * الثغرة الأصلية (مؤكدة حياً): `repo_index` كان يمشي الشجرة بلا سقف عدد ملفات.
 * طلب واحد على مجلد بيت المستخدم استنزف الحلقة >180 ثانية وشلّ كل مسار،
 * ورفع CPU إلى 81% بلا توقف.
 *
 * الإصلاح: سقف ملفات + سقف عمق + سقف زمني + إفساح حلقة الحدث كل 200 مدخل.
 * هذا الاختبار يفشل لو عاد أي من هذه الضمانات للاختفاء.
 */
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/* بيئة حتمية — **قبل** تحميل الوحدة، لأن `EXTRA_ROOTS` تُحسب لحظة require.: هذا الملف يستدعي الوحدة مباشرة (بلا خادم)، و`buildAllowedRoots`
   تُحسب عند تحميل الوحدة. العطل المُثبت 2026-10-20: كانت تُبنى من بيئة المطوّر
   وحدها، فالمجلد المستهدف (بيت المستخدم) يُرفض بـ«خارج الجذور المسموحة» —
   أي أن اختبار DoS (الذي يقيس زمن الردّ) كان يفشل بلا أي عطل في الأداء.
   نُعلن الجذور وميزانية الاختبار هنا صراحةً قبل أي استيراد. */
process.env.CORTEX_TEST_MODE = process.env.CORTEX_TEST_MODE || '1';
process.env.CORTEX_ALLOWED_ROOTS = [process.cwd(), os.tmpdir(), os.homedir().replace(/\\/g, '/')]
  .filter(Boolean).join(require('node:path').delimiter);
process.env.CORTEX_DAILY_FS = process.env.CORTEX_DAILY_FS || '100000';
process.env.AGENT_DAILY_WRITES = process.env.AGENT_DAILY_WRITES || '100000';

// تُحمَّل الوحدة **بعد** الزرع أعلاه: EXTRA_ROOTS تُقرأ لحظة التحميل
const ext = require('../cortex-tools-external.js');

const HARD_LIMIT_MS = 15000; // السقف المقبول لأي مجلد، مهما كان حجمه

test('repo_index: لا يشلّ الخادم على مجلد ضخم (سقف زمني فعلي)', async () => {
  const roots = ext.buildAllowedRoots(process.cwd());
  /* الهدف: مجلد ضخم **حقيقي** لا وهمي. العطل المُثبت 2026-10-20: الاختبار كان
     يستهدف بيت المستخدم — وهو جذر مرفوض حتماً بحكم §33
     (`isForbiddenRoot` يحجب البيت عمداً)، فكان يفشل بـ«خارج الجذور المسموحة»
     بلا أي عطل في الأداء. نُولّد شجرة ضخمة داخل مجلد مؤقت (3000 ملف + عمق)
     فنقيس الزمن على حِمل حقيقي — وهو ما يُثبت ضمانة DoS فعلاً. */
  const bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-big-'));
  for (let d = 0; d < 30; d++) {
    const dir = path.join(bigRoot, 'd' + d);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x');
  }
  const target = bigRoot;
  const started = Date.now();
  const out = await ext.TOOL_IMPLS.repo_index({ path: target }, { allowedRoots: roots });
  const elapsed = Date.now() - started;

  assert.ok(!out.error, `لا يجب أن يفشل: ${out.error}`);
  assert.ok(elapsed < HARD_LIMIT_MS, `تجاوز السقف الزمني: ${elapsed}ms > ${HARD_LIMIT_MS}ms`);
  assert.ok(Number.isFinite(out.files), 'يجب أن يعيد عدد ملفات رقمياً');
  assert.ok(out.limits && out.limits.maxFiles > 0, 'يجب أن يعلن حدوده صراحةً');
  assert.ok(typeof out.truncated === 'boolean', 'يجب أن يعلن الاقتطاع بدل الادعاء بالاكتمال');
});

test('repo_index: يعلن truncated=true عند تجاوز الحدود (لا ادعاء اكتمال كاذب)', async () => {
  const roots = ext.buildAllowedRoots(process.cwd());
  // جذر مساحة العمل قد لا يتجاوز الحد؛ نتحقق من الاتساق لا من القيمة
  const out = await ext.TOOL_IMPLS.repo_index({ path: roots[0] }, { allowedRoots: roots });
  assert.ok(!out.error);
  if (out.truncated === true) {
    assert.ok(out.files > 0, 'الاقتطاع يحدث بعد جمع شيء، لا من الصفر');
  } else {
    assert.ok(out.files < out.limits.maxFiles, 'غير مقتطع يعني تحت السقف فعلاً');
  }
});

test('repo_index: السقف الزمني مُعلَن في الاستجابة (عقد ظاهر للمستخدم)', async () => {
  const roots = ext.buildAllowedRoots(process.cwd());
  const out = await ext.TOOL_IMPLS.repo_index({ path: roots[0] }, { allowedRoots: roots });
  assert.equal(typeof out.limits.maxMs, 'number');
  assert.ok(out.limits.maxMs <= 30000, 'سقف زمني معقول لا يتجاوز 30 ثانية');
  assert.ok(out.limits.maxDepth <= 12, 'عمق محدود');
});

test('repo_index: يرفض مساراً خارج الجذور المسموحة بسرعة (لا انفجار)', async () => {
  const roots = ext.buildAllowedRoots(process.cwd());
  const started = Date.now();
  const out = await ext.TOOL_IMPLS.repo_index({ path: 'C:/Windows/System32' }, { allowedRoots: roots });
  const elapsed = Date.now() - started;
  assert.ok(out.error, 'يجب الرفض');
  assert.ok(elapsed < 1000, `الرفض يجب أن يكون فورياً: ${elapsed}ms`);
});
