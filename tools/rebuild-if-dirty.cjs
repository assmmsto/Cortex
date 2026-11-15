'use strict';
/**
 * بناء الفهرس **إن كان متسخاً فقط** — مصمَّم لمهمة مجدولة (Windows Task Scheduler /
 * cron)، لا للاستدعاء من داخل الخادم.
 *
 * لماذا خارج الخادم: القياس (2026-11-11) أن البناء الكامل يكلّف 48–141 ثانية على
 * 361 ملاحظة؛ تشغيله داخل العملية — ولو «في الخلفية» — يحجب الحلقة الواحدة فتتجمد
 * الطلبات. وتشغيله تلقائياً كعملية فرعية عند كل اتساخ أُجرِّب وأُلغي (2026-11-12):
 * تزاحم الأقفال وأطال مجموعة الاختبارات من 4:15 إلى أكثر من 13 دقيقة بلا نتيجة.
 *
 * الاستعمال:
 *   node tools/rebuild-if-dirty.cjs           # يبني فقط إن كان متسخاً
 *   node tools/rebuild-if-dirty.cjs --force   # يبني دائماً
 *
 * مهمة مجدولة مقترحة (كل 30 دقيقة):
 *   schtasks /create /tn "Cortex Index" /tr "node \"<path>\tools\rebuild-if-dirty.cjs\"" /sc minute /mo 30
 *
 * الخروج: 0 = نظيف أو بُني بنجاح · 1 = فشل البناء · 2 = بناء جارٍ بالفعل (قفل).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.env.APP_ROOT = process.env.APP_ROOT || ROOT;

const LOCK = path.join(ROOT, 'data', '.maintenance');

function lockHeld() {
  try {
    const raw = fs.readFileSync(LOCK, 'utf8');
    const { pid, at } = JSON.parse(raw || '{}');
    const age = Date.now() - Date.parse(at || 0);
    if (Number.isFinite(age) && age > 30 * 60 * 1000) return false; // قفل ميت
    if (pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
    return false;
  } catch { return false; }
}

(async () => {
  const force = process.argv.includes('--force');
  if (!force && lockHeld()) {
    console.log('بناء جارٍ بالفعل (قفل .maintenance) — لا تكرار.');
    process.exit(2);
  }
  const { createCore } = require(path.join(ROOT, 'cortex-core'));
  const core = await createCore({ root: process.env.APP_ROOT });

  const status = typeof core.getRetrievalStatus === 'function' ? await core.getRetrievalStatus() : null;
  if (!force && status && status.dirty === false) {
    console.log(`الفهرس نظيف (${status.noteCount} ملاحظة) — لا بناء.`);
    process.exit(0);
  }

  fs.writeFileSync(LOCK, JSON.stringify({ at: new Date().toISOString(), reason: 'scheduled_rebuild', pid: process.pid }), 'utf8');
  try {
    const t0 = Date.now();
    const out = await core.rebuildVectorIndex({ force });
    const idx = (out && out.index) || {};
    console.log(`✔ ${out && out.rebuilt === false ? 'لم يتغيّر' : 'أُعيد البناء'} في ${Date.now() - t0}ms — ${idx.noteCount ?? '—'} ملاحظة / ${idx.entryCount ?? '—'} مقطع`);
  } finally {
    try { fs.unlinkSync(LOCK); } catch { /* ذهب */ }
  }
})().catch(err => { console.error('فشل:', err.message); process.exit(1); });
