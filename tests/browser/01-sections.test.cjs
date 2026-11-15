#!/usr/bin/env node
/**
 * مدخل قياسي باسم المهمة (2026-10-27) لقسمَي ① المعرفة و② الخريطة.
 *
 * الفحص الفعلي في `01-notes-graph.cjs` بجانب هذا الملف — مصدر واحد للحقيقة.
 *
 * لماذا معزول افتراضياً: هذا القسم **يكتب** بحكم تصميمه (يعدّل محتوى أول عنصر
 * ثم ينشئ عنصراً ويحذفه ذاتياً). تشغيله على خادم المنتج يستبدل محتوى عنصر حقيقي
 * من خزنة المستخدم — لذلك يقلع هذا المدخل خادماً معزولاً حتمياً بأرضية مزروعة
 * (نفس آلية `run.cjs` و`_isolate.cjs`) ما لم يُمرَّر `CORTEX_URL` صراحةً.
 *
 * التشغيل:  node tests/browser/01-sections.test.cjs
 *           CORTEX_URL=http://127.0.0.1:3737 node tests/browser/01-sections.test.cjs
 *           (التمرير الصريح = مسؤوليتك: سيعدّل عنصراً على ذلك الخادم)
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
  const external = process.env.CORTEX_URL || '';
  let iso = null;
  let base = external;
  if (!external) {
    iso = await require('./_isolate.cjs').start();
    base = iso.base;
    console.log(`⋯ خادم معزول: ${base} (أرضية حتمية — خزنة المنتج لا تُلمس)\n`);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, '01-notes-graph.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, CORTEX_URL: base }
  });
  if (iso) {
    await iso.stop();
    console.log('\n⋯ أُغلق الخادم المعزول.');
  }
  process.exit(r.status || 0);
})().catch((e) => { console.error('فشل الجري:', e && e.message ? e.message : e); process.exit(1); });
