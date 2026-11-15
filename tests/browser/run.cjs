'use strict';
/**
 * مُشغِّل اختبارات المتصفح الحقيقية — يفتح Chrome ويقيس كل قسم بتدفقه الفعلي.
 *
 * يتطلب:
 *   1) الخادم يعمل:            npm start
 *   2) playwright-core مثبّتاً: npm i --no-save playwright-core
 *   3) Chrome/Chromium موجوداً (أو CHROME_PATH يشير إليه)
 *
 * التشغيل:
 *   node tests/browser/run.cjs              كل الأقسام
 *   node tests/browser/run.cjs 03           قسم واحد فقط (بادئة الاسم)
 *   CORTEX_URL=http://127.0.0.1:4000 node tests/browser/run.cjs
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/* القفل الموحّد (إصلاح جذري 2026-10-20) — يمنع تشغيل هذه الحزمة بالتوازي مع
   `npm test` أو مع جولة متصفح أخرى. الدليل الحاسم: تسع عمليات متصاحبة أعلنت
   خمسة أقسام «فاشلة» (03,04,05,06,07)، والمتتبَّع الحقيقي أن `FIN_browser`
   أعلن «56 نجح · 0 فشل» في الأقسام نفسها ثم حكم بفشل `04` — أي أن الإخفاق
   تلوّث من جولة منافسة على `data/`، لا عطل منتج. مفرداً: 0 فشل. */
let releaseSuite = () => {};
try {
  releaseSuite = require('../_suite-lock.cjs').acquire('browser', { waitMs: 0 });
} catch (e) {
  if (e && e.name === 'ConcurrentSuiteError') {
    console.error(`✖ ${e.message} — أوقفها أو استعمل CORTEX_ALLOW_CONCURRENT_TESTS=1`);
    process.exit(2);
  }
  throw e;
}
process.on('exit', () => releaseSuite());

const DIR = __dirname;
const filter = process.argv[2] || '';
const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.cjs') && /\d\d-/.test(f))
  /* مداخل `*.test.cjs` (أسماء قياسية 2026-10-27) تُشير إلى الاختبارات نفسها —
     تُشغَّل يدوياً باسمها؛ استثناؤها هنا يمنع تشغيل القسم مرتين في الجولة. */
  .filter((f) => !f.endsWith('.test.cjs'))
  .filter((f) => !filter || f.startsWith(filter))
  .sort();

if (!files.length) {
  console.error('لا ملفات اختبار مطابقة' + (filter ? ` لـ «${filter}»` : ''));
  process.exit(1);
}

const USE_ISOLATED = !process.env.CORTEX_URL;

(async () => {
  // ── العزل (إصلاح جذري 2026-10-20) ──
  // بلا `CORTEX_URL` خارجي، نقلع خادمنا المعزول ونزرع أرضية حتمية.
  // العطل المُثبت: الاختبارات كانت تستهدف خادم المنتج فتنمو `data/cortex.db`
  // بلا حد (179 → 239 → 255 عنصراً) وتُفسد القياسات المطلقة اللاحقة.
  let iso = null;
  if (USE_ISOLATED) {
    try {
      const { start } = require('./_isolate.cjs');
      console.log('⋯ أقلع خادماً معزولاً وأزرع أرضية حتمية…');
      iso = await start();
      console.log(`✔ خادم معزول: ${iso.base} (الجذر: ${iso.root})\n`);
    } catch (e) {
      console.error(`✖ تعذّر إقلاع الخادم المعزول: ${e.message}`);
      console.error('  (استعمل CORTEX_URL=http://127.0.0.1:3737 لاستهداف خادم قائم)');
      process.exit(1);
    }
  }
  const url = iso ? iso.base : process.env.CORTEX_URL;
  console.log(`Cortex — اختبار المتصفح الحقيقي\nالهدف: ${url}\nالملفات: ${files.join(', ')}\n`);

  const totals = { pass: 0, fail: 0, failed: [] };
  try {
    for (const f of files) {
      console.log('─'.repeat(62));
      console.log(`▶ ${f}`);
      const r = spawnSync(process.execPath, [path.join(DIR, f)], {
        stdio: 'inherit',
        env: { ...process.env, CORTEX_URL: url }
      });
      if (r.status !== 0) totals.failed.push(f);
    }
  } finally {
    if (iso) { await iso.stop(); console.log('\n⋯ أُغلق الخادم المعزول.'); }
  }

  console.log('\n' + '═'.repeat(62));
  if (totals.failed.length) {
    console.log(`✖ أقسام فاشلة: ${totals.failed.join(', ')}`);
    process.exit(1);
  }
  console.log('✅ كل أقسام المتصفح نجحت');
})();
