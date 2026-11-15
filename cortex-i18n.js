'use strict';
/**
 * لغة الطلب — مصدر حقيقة واحد لكل نص يخرج من الخادم.
 *
 * المشكلة التي يُغلقها: كان كل نص عربي مكتوباً حرفياً في مسار ما، فتبديل اللغة
 * يغيّر الواجهة فقط ويترك رسائل الخادم عربية (قيست: 72+ نصاً في 15 مساراً).
 *
 * الطريقة: AsyncLocalStorage — تُحلّ اللغة مرة واحدة عند مدخل الطلب، فيقرأها أي
 * وحدة بعمق بلا تمرير معاملات. آمنة تحت التزامن، بخلاف متغير عام للوحدة.
 *
 * الأولوية: ملف الطلب (src.lang) ← الاستعلام (?lang=) ← إعدادات الخادم ← 'ar'.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function norm(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/** يُنفّذ دالة داخل سياق لغة — يورَّث عبر await تلقائياً. */
function runWithLang(lang, fn) {
  return als.run(norm(lang), fn);
}

/** اللغة الفعّالة الآن. */
function lang() {
  return als.getStore() || 'ar';
}

/**
 * يختار النص بلغة الطلب. `src` اختياري: إن حمل lang/language صريحاً فهو الأعلى أولوية
 * (جسم الطلب أدق من الاستعلام عند التعارض).
 */
function T(ar, en, src) {
  if (src && typeof src === 'object') {
    const own = src.lang || src.language;
    if (own) return norm(own) === 'en' ? en : ar;
  }
  return lang() === 'en' ? en : ar;
}

/** زوج مترجم {ar,en} للكتالوجات (مراحل، موصلات، سياسات) — يُقرأ بحسب اللغة. */
function pair(ar, en) {
  return { ar, en };
}

/** يعيد النص المناسب من زوج {ar,en} أو نصاً واحداً. */
function fromPair(v) {
  if (v && typeof v === 'object' && ('ar' in v || 'en' in v)) {
    return lang() === 'en' ? (v.en || v.ar || '') : (v.ar || v.en || '');
  }
  return typeof v === 'string' ? v : '';
}

module.exports = { runWithLang, lang, T, norm, pair, fromPair };
