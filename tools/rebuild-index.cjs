'use strict';
/**
 * بناء فهرس الاسترجاع **خارج عملية الخادم**.
 *
 * السبب (عطل مُقاس 2026-11-11): البناء الكامل يكلّف 48–141 ثانية على خزنة 361
 * ملاحظة. تشغيله داخل الخادم — حتى «في الخلفية» — يحجب الحلقة الواحدة فتتجمد
 * كل الطلبات ويقتل الحارس الخادم. لذا صار البناء أداة مستقلة تُشغَّل عند الحاجة
 * (يدوياً أو من مهمة مجدولة ليلاً)، والخادم يخدم من الفهرس القائم ويُعلن indexStale.
 *
 * الاستعمال:  node tools/rebuild-index.cjs [--force]
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
process.env.APP_ROOT = process.env.APP_ROOT || ROOT;

const { createCore } = require(path.join(ROOT, 'cortex-core'));

(async () => {
  const t0 = Date.now();
  const core = await createCore({ root: process.env.APP_ROOT });
  const t1 = Date.now();

  // قفل صيانة: يمنع الحارس من اعتبار انشغال الخادم جموداً لو تزامن البناء معه
  const lock = path.join(core.dataDir, '.maintenance');
  try { require('fs').writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), reason: 'cli_rebuild', pid: process.pid }), 'utf8'); } catch { /* تحسيني */ }

  try {
    const force = process.argv.includes('--force');
    const out = await core.rebuildVectorIndex({ force });
    const ms = Date.now() - t1;
    const idx = (out && out.index) || {};
    console.log(`✔ فهرس الاسترجاع ${out && out.rebuilt === false ? 'لم يتغيّر (نظيف)' : 'أُعيد بناؤه'} في ${ms}ms`);
    console.log(`  إقلاع الوحدة: ${t1 - t0}ms · مدخلات: ${idx.entryCount ?? '—'} · ملاحظات: ${idx.noteCount ?? '—'} · builtAt: ${idx.builtAt ?? '—'}`);
    if (out && out.rebuilt === false) console.log('  (استعمل --force لإعادة البناء رغم نظافة الفهرس)');
  } finally {
    try { require('fs').unlinkSync(lock); } catch { /* ذهب */ }
  }
})().catch((e) => { console.error('فشل البناء:', e.message); process.exit(1); });