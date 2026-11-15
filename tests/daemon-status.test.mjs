/**
 * شفافية الخلفية (2026-11-06) — المجدول والحارس كانا يعملان بلا أي سطح.
 *
 * المشكلة المقيسة: النبض الدوري يعمل كل 6 ساعات، والحارس عملية منفصلة تعيد
 * تشغيل الخادم عند التجمّد، ولا شيء في الواجهة أو الـAPI يقول: هل النبض مفعّل؟
 * متى القادم؟ هل نجح الأخير؟ هل الحارس حيّ؟ أي أن سلوكاً كاملاً يحدث بلا إعلان.
 *
 * هذا الاختبار يثبت أن الحالة تُنشر وتتغيّر فعلياً مع الإعداد، لا أنها ثابتة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLiveServer } from './_live-server.mjs';

const SIX_H = 6 * 3600;

test('state/daemon: المجدول يعلن موعده ونتيجته والحارس يعلن حياته', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });
  const headers = { 'X-Cortex-Session': srv.token, 'Content-Type': 'application/json' };

  const st = await (await fetch(srv.base + '/api/status')).json();
  assert.equal(st.ok, true);
  const d = st.daemon;
  assert.ok(d && d.scheduler && d.watchdog, 'حالة الخلفية غير منشورة في /api/status');
  assert.equal(typeof d.uptimeSec, 'number');
  assert.ok(d.uptimeSec >= 0);

  // الافتراضي 6 ساعات: مفعّل، وموعده في المستقبل داخل النافذة
  assert.equal(d.scheduler.hours, 6, 'الافتراضي 6 ساعات');
  assert.equal(d.scheduler.enabled, true);
  assert.ok(d.scheduler.nextAt, 'nextAt مفقود — لا يمكن للمستخدم معرفة متى الفحص القادم');
  assert.ok(d.scheduler.nextInSec > SIX_H - 120 && d.scheduler.nextInSec <= SIX_H, `nextInSec=${d.scheduler.nextInSec}`);

  // الحارس: في وضع الاختبار لا يُقلع (CORTEX_NO_WATCHDOG=1) لكن الحقل يجب أن يكون صريحاً
  assert.equal(typeof d.watchdog.managed, 'boolean');
  assert.equal(typeof d.watchdog.alive, 'boolean');

  // تغيير الإعداد يعيد التسليح فوراً — الحالة تتبع السلوك لا العكس
  const set2 = await (await fetch(srv.base + '/api/agent/schedule', {
    method: 'POST', headers, body: JSON.stringify({ schedule_hours: 2 }),
  })).json();
  assert.equal(set2.ok, true, JSON.stringify(set2));
  const d2 = (await (await fetch(srv.base + '/api/status')).json()).daemon;
  assert.equal(d2.scheduler.hours, 2);
  assert.ok(d2.scheduler.nextInSec > 2 * 3600 - 120 && d2.scheduler.nextInSec <= 2 * 3600, `nextInSec=${d2.scheduler.nextInSec}`);

  // 0 = تعطيل صريح: لا موعد، والحالة تقول ذلك
  await fetch(srv.base + '/api/agent/schedule', {
    method: 'POST', headers, body: JSON.stringify({ schedule_hours: 0 }),
  });
  const d3 = (await (await fetch(srv.base + '/api/status')).json()).daemon;
  assert.equal(d3.scheduler.hours, 0);
  assert.equal(d3.scheduler.enabled, false, 'المعطّل يجب أن يُعلن تعطيله');
  assert.equal(d3.scheduler.nextAt, null);
});

test('state/daemon: آخر فحص يُسجّل نتيجته بعد نبضة إقلاع', async (t) => {
  const srv = await startLiveServer({ env: { CORTEX_SCHED_DRY: '1' } });
  t.after(async () => { await srv.stop(); });

  /* النبضة الأولى تُجدول بعد 1500ms من الإقلاع؛ ننتظر **اكتمالها** لا بدايتها.
     عطل مُقاس 2026-11-13: `lastTickAt` يُضبط في بداية النبضة و`lastOk` في نهايتها،
     فانتظار `lastTickAt` وحده كان يقرأ في منتصف النبضة فيرى `lastOk = null`
     (الاختبار سقط على «نتيجة آخر فحص يجب أن تُعلن» بلا عطل في المنتج). */
  let d = null;
  for (let i = 0; i < 40; i++) {
    d = (await (await fetch(srv.base + '/api/status')).json()).daemon;
    if (d && d.scheduler && d.scheduler.lastTickAt && d.scheduler.lastOk !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(d.scheduler.lastTickAt, 'lastTickAt لم يُسجّل بعد نبضة الإقلاع');
  assert.equal(d.scheduler.lastReason, 'startup', 'سبب آخر فحص يجب أن يُعلن');
  assert.equal(typeof d.scheduler.lastOk, 'boolean', 'نتيجة آخر فحص يجب أن تُعلن بعد اكتمال النبضة');
  assert.ok(d.scheduler.ticks >= 1, 'عدّاد النبضات لم يزد');
});