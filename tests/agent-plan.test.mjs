/**
 * الخطة المعلنة للوكيل (2026-11-06) — الفجوة الوحيدة في معايير الوكالة.
 *
 * كان الوكيل يخطط ضمنياً في كل خطوة (`thought`) ولا يُنتج خطة قابلة للمراجعة
 * قبل التنفيذ؛ وهي ما يفرّق وكيلاً عن منفّذ أدوات. الإصلاح لا يضيف نداء نموذج:
 * الخطة تُطلب في الرد الأول نفسه مع أول إجراء.
 *
 * نختبر الآلية لا الكلام: عقد المطالبة (باللغتين) + تطبيع الخطة على مدخلات
 * مشوّهة (نموذج يُرجع نصاً/كائنات/فراغات بدل قائمة نظيفة).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const agent = require('../cortex-agent.js');

test('المطالبة تطلب خطة معلنة في الرد الأول — بالعربية والإنجليزية', () => {
  const ar = agent.systemPrompt('راجع مستندي', '', 'ar');
  const en = agent.systemPrompt('review my doc', '', 'en');
  assert.match(ar, /"plan"/, 'لا يوجد طلب خطة في المطالبة العربية');
  assert.match(ar, /أول رد/, 'الطلب لا يحدد التوقيت (أول رد)');
  assert.match(en, /"plan"/, 'no plan request in the English prompt');
  assert.match(en, /first reply/i, 'the request does not fix the timing (first reply)');
  // الخطة تُطلب مع الإجراء نفسه — لا نداء إضافي
  assert.match(ar, /"action"/);
  assert.match(en, /"action"/);
});

test('normalizePlan: يقبل القائمة النظيفة ويحدّها', () => {
  const out = agent.normalizePlan(['اقرأ المستند', 'استخرج الفجوات', 'اكتب التقرير']);
  assert.deepEqual(out, ['اقرأ المستند', 'استخرج الفجوات', 'اكتب التقرير']);
  assert.equal(agent.normalizePlan(new Array(20).fill('خطوة')).length, 1, 'التكرار يُدمج');
  assert.equal(agent.normalizePlan(Array.from({ length: 20 }, (_, i) => 'خطوة رقم ' + i)).length, 8, 'السقف 8');
});

test('normalizePlan: يرفض المدخلات المشوّهة بدل عرض خطة وهمية', () => {
  assert.deepEqual(agent.normalizePlan(null), []);
  assert.deepEqual(agent.normalizePlan(undefined), []);
  assert.deepEqual(agent.normalizePlan([]), []);
  assert.deepEqual(agent.normalizePlan(['', '  ', 'ab']), [], 'خطوات قصيرة جداً تُهمل');
  assert.deepEqual(agent.normalizePlan(42), [], 'رقم ليس خطة');
  // نموذج يُرجع كائنات {step:...} شائعة في مخرجات LLM
  assert.deepEqual(agent.normalizePlan([{ step: 'افتح الملف' }, { text: 'اقرأه' }]), ['افتح الملف', 'اقرأه']);
  // نموذج يُرجع نصاً متعدد الأسطر بدل مصفوفة
  assert.deepEqual(agent.normalizePlan('أولاً اقرأ\nثانياً استخرج\nثالثاً اكتب'), ['أولاً اقرأ', 'ثانياً استخرج', 'ثالثاً اكتب']);
});

test('normalizePlan: يقلّم الطويل ويزيل التكرار بعد التطبيع', () => {
  const long = 'ا'.repeat(300);
  const out = agent.normalizePlan([long]);
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= 181, 'الطول ' + out[0].length);
  assert.deepEqual(agent.normalizePlan(['اقرأ   الملف', 'اقرأ الملف']), ['اقرأ الملف'], 'المسافات الزائدة تُطوى');
});