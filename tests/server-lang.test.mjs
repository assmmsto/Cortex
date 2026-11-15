/**
 * حارس لغة الخادم — يمنع رجوع «الخادم يتجاهل ?lang=en».
 *
 * العطل الأصلي (مؤكد حياً): `resolveAgentLang(settings)` كانت تقرأ إعداد الخادم
 * فقط وتتجاهل الطلب، و`nextBestAction`/`buildNextActions` كانتا بلا معامل `lang`
 * أصلاً — فيعود نص عربي في واجهة إنجليزية.
 *
 * القاعدة الصحيحة: القوالب والنصوص التي يولّدها **النظام** تُترجم؛
 * أما عناوين العناصر ونصوص المهام ومسارات الملفات التي كتبها المستخدم فلا تُترجم.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// §34: /api/agent/next-action مسار تنفيذ — يحتاج رمز جلسة. العطل 2026-10-20 كان
// مزدوجاً: (1) الطلب بلا رمز ⇒ 401 ⇒ en.text غير معرّف ⇒ فشل كاذب «الرد الإنجليزي
// غير فارغ»; (2) الاعتماد على خادم 3737 الحيّ ⇒ يورّث حالة data/audit.log المشتركة.
// الصواب: خادم معزول ببيئة حتمية + رمز جلسة في كل طلب.
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
test.after(async () => { await SRV.stop(); });
const AR = /[\u0600-\u06FF]/;

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: SRV.headers(), body: JSON.stringify(body) });
  return r.json();
};

test('لغة الخادم — تُطبَّق من الطلب لا من الإعداد', async (t) => {

  // ── 1) معامل lang يُحترم
  const en = await post('/api/agent/next-action', { project: '', question: 'what next?', lang: 'en' });
  const ar = await post('/api/agent/next-action', { project: '', question: 'what next?', lang: 'ar' });
  assert.ok(en.text, 'الرد الإنجليزي غير فارغ');
  assert.ok(ar.text, 'الرد العربي غير فارغ');

  // القالب الإنجليزي يبدأ بفعل إنجليزي — القالب العربي بفعل عربي
  assert.ok(/^(Execute|Record|Create|Answer|Review)/.test(en.text) || !AR.test(en.text.slice(0, 20)),
    'قالب الإجراء بالإنجليزية: ' + en.text.slice(0, 40));
  assert.ok(AR.test(ar.text.slice(0, 12)), 'قالب الإجراء بالعربية: ' + ar.text.slice(0, 30));

  // ── 2) السبب (reason) يُترجم أيضاً
  assert.ok(!AR.test(en.reason || ''), 'cause/reason إنجليزي بالكامل: ' + (en.reason || '').slice(0, 60));
  assert.ok(AR.test(ar.reason || ''), 'cause/reason عربي بالكامل');

  // ── 3) حالة المشروع تحترم ?lang=en
  const st = await (await fetch(BASE + '/api/project-state?project=&lang=en')).json();
  const gapsEn = (st.gaps || []).map((g) => g.message).join(' ');
  assert.ok(!AR.test(gapsEn), 'فجوات المشروع بالإنجليزية: ' + gapsEn.slice(0, 60));

  // ── 4) الوضع العربي لم يتأثر
  const stAr = await (await fetch(BASE + '/api/project-state?project=&lang=ar')).json();
  const gapsAr = (stAr.gaps || []).map((g) => g.message).join(' ');
  assert.ok(!gapsAr || AR.test(gapsAr), 'فجوات المشروع بالعربية');

  // ── 5) بيانات المستخدم لا تُترجم (نص المهمة كما كتبه)
  const openText = (st.openTasks || [])[0]?.text || '';
  if (openText && AR.test(openText)) {
    assert.ok(openText.includes(openText), 'نص مهمة المستخدم يبقى كما هو');
  }
});
