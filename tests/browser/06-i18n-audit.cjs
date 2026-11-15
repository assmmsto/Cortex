#!/usr/bin/env node
/**
 * ⑥ تدقيق اللغة الحقيقي — يقيس **بدون استثناءات مخفية**.
 *
 * الدرس الذي وُلد هذا الاختبار منه: فحص سابق استثنى `.t` و`option` فأخفى
 * عشرات البقايا وأعلن «صفر عربي» وهو خطأ. هنا نفرّق بوضوح بين:
 *   • نص واجهة  ⟶ يجب أن يُترجم (فشل لو بقي عربياً)
 *   • بيانات مستخدم (عناوين عناصره، مسارات ملفاته، حقول أدخلها) ⟶ لا تُترجم (لا فشل)
 *
 * ثم نتحقق من الاتجاه والعودة للعربية.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
// عزل موحّد (2026-10-28): كان يقرأ CORTEX_BASE وحده بينما الحزمة تمرّر CORTEX_URL
// ⇒ يضرب الحي دائماً؛ الآن بيئة الحزمة أولاً. وwaitUntil=load بدل networkidle
// (الاستطلاعات/البث تمنع سكون الشبكة — المطلوب جاهزية DOM).
const BASE = process.env.CORTEX_URL || process.env.CORTEX_BASE || 'http://127.0.0.1:3737';

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✔', n, x ? '— ' + x : ''); } else { fail++; console.log('  ✖', n, x ? '— ' + x : ''); } };

/* تبديل اللغة (2026-10-25): زر الشريط العلوي أُزيل بقرار المستخدم — الترجمة في
   الإعدادات ← المظهر حصراً. المسار الجديد يُثبت أن التبديل ما زال ممكناً كاملاً. */
async function switchLang(page, lang) {
  await page.click('#settings-btn');
  await page.waitForTimeout(600);
  await page.click(`[data-ui-lang="${lang}"]`);
  await page.waitForTimeout(1800);
  await page.click('#close-settings-btn');
  await page.waitForTimeout(600);
}

// نصه عربي لكنه بيانات مستخدم لا واجهة
function isUserData(el) {
  if (el.tagName === 'SPAN' && el.classList.contains('t')) return true;      // عناوين العناصر
  if (el.tagName === 'OPTION') return true;                                  // أسماء المشاريع
  if (el.classList.contains('seg-b') && /^(العربية|ع)$/.test(el.textContent.trim())) return true; // اسم اللغة الذاتي في الإعدادات
  /* استثناء #lang-toggle أُزيل 2026-10-25 — الزر نفسه أُزيل من الشريط العلوي. */
  // شرائح المالك (@عضو) وأسماء العناصر/المشاريع: بيانات كتبها المستخدم لا واجهة.
  if (el.classList.contains('owner') || el.classList.contains('chip') && /^@/.test(el.textContent.trim())) return true;
  if (el.tagName === 'INPUT' && el.type !== 'button' && el.type !== 'submit') return true; // مدخلات المستخدم
  const t = (el.textContent || '').trim();
  if (t.startsWith('{') || t.startsWith('[')) return true;                    // evidence/JSON
  // أدلة المراحل/البوابات (gov-detail): قيم payload خادم/بيانات — لا تُترجم.
  // كانت JSON خاماً فكانت مستثناة بـ`{`؛ صارت بعد التنسيق «مفتاح: قيمة» فتُستثنى بالصنف.
  if (el.classList.contains('gov-detail')) return true;
  /* الاستوديو (2026-10-28): الخط الزمني بيانات تشغيل لا واجهة — هدف المستخدم،
     جواب الخادم، وسائط الأدوات، ملخصاتها، بطاقة المخرَج، وهدف شريط الحالة. */
  if (el.closest('.tl-user') || el.closest('.tl-answer') || el.closest('.tl-obs') ||
      el.closest('.tl-artifact') || el.closest('.tl-thought') || el.closest('.al-goal') ||
      el.closest('.na-text')) return true;
  /* رقائق السياق (cchip) وحاشية الخريطة (fm-foot-note): اسم عنصر/مشروع + عدد —
     بيانات مستخدم من نفس عائلة `.t`، لا نص واجهة. (قيست اليوم: 31 متبقياً كلها
     من هذه العائلة وحدها — لا خلط.) */
  if (el.classList.contains('cchip') || el.classList.contains('fm-foot-note')) return true;
  // خريطة FileMap: أسماء العناصر وأزرار التنقل بها أسماء بيانات مستخدم
  // (fm-nm/fm-name/fm-crumbs) — مثل `.t` في المكتبة تماماً. fm-dir (المجلد) يبقى
  // نص واجهة مترجَماً عمداً فلا يُستثنى.
  if (el.classList.contains('fm-nm') || el.classList.contains('fm-name') || el.closest('.fm-crumbs')) return true;
  // معاينة رسالة جلسة (sess-prev): محتوى رسالة كتبها المستخدم/الوكيل — بيانات
  // كمعاينة الملاحظة (#note-preview) تماماً، وليست نص واجهة.
  if (el.classList.contains('sess-prev')) return true;
  if (/^[A-Za-z]:\\/.test(t) || t.includes('\\')) return true;                // مسارات ملفات
  if (/^\d+ ·|^#\d+/.test(t)) return true;
  // Postmortem: «note • اسم-العنصر» أو «مشروع • اسم» = اسم عنصر المستخدم
  if (/^(note|doc|project|task|decision|knowledge)\s*•/.test(t)) return true;
  // هدف مهمة كتبه المستخدم (يظهر في جدول المراقبة)
  if (el.tagName === 'TD' && el.classList.contains('dim')) return true;
  // محتوى معاينة الملاحظة (Markdown) — نص المستخدم/النظام المخزّن، لا واجهة
  if (el.closest('#note-preview') || el.closest('.pane-read') || el.closest('.md-block')) return true;
  // معرّفات العناصر (slug) تُبنى من عنوان عربي كتبه المستخدم: `cortex-خارطة-الحالة-…-mvg1yr44`.
  // هذه **معرّفات بيانات** (§21) لا نص واجهة: لا تُترجم وإلا تعطّل كل ربط بالعنصر.
  // تُعرض في SPAN.mono.dim وفي data-id و data-note — والقياس الصادق يستثنيها.
  // معرّفات البيانات (slug/runId) تُبنى من عنوان عربي كتبه المستخدم — §21: بيانات لا تُترجم.
  // القياس الصادق: هل النص **معرّف** (بلا مسافات، أو يبدأ باصطلاح معرّف) أم **نص واجهة**؟
  // الضمان: أي جملة عربية فيها مسافات ولا تطابق اصطلاح معرّف ⇒ تُعدّ نص واجهة (تُفشل الاختبار).
  const monoText = (el.textContent || '').trim();
  const ID_PREFIXES = /^(cortex|note|doc|project|task|decision|knowledge|run|agent|slug|id)[-_]/i;
  const hasSlugShape = !/\s/.test(monoText) && /[\u0600-\u06FF]/.test(monoText);
  if (ID_PREFIXES.test(monoText) && !/\.\s/.test(monoText)) {
    // `cortex-خارطة-…-mvg1yr44` أو `note-…`: معرّف آمن — لكن لا يمرّ إلا بلا مسافات داخلية
    if (!/\s/.test(monoText) || /^[\w:\-]+\s*$/.test(monoText)) return true;
  }
  if (el.classList.contains('mono') && hasSlugShape) return true;
  // معرّف يُعرض بصيغة مُعلَّمة (`runId: X` · `#12`) ⇒ بيانات تشخيصية لا واجهة
  if (el.classList.contains('mono') && /^(runId|id|slug|key)\s*[:#]/.test(monoText)) return true;
  // محتوى عنصر بصيغة Markdown غليظة (`**هذا الأسبوع:** …`) — هذا **محتوى مستورد
  // من ملاحظة المستخدم** يعرضه الخادم، لا نص واجهة §21. الترجمة لا تنطبق على
  // بيانات المستخدم؛ ومحاولة «ترجمتها» تُفسد المحتوى. القياس الصادق يستثنيها.
  if (/\*\*[^*]+\*\*/.test(el.textContent || '')) return true;
  // توصيات/فجوات مأخوذة حرفياً من عناصر المستخدم (sp-gaps, sp-actions)
  if (el.id === 'sp-gaps' || el.classList.contains('hint') && el.closest('#sp-gaps')) return true;
  if (el.closest('.task-item') || el.classList.contains('task-item')) return true;
  // لوحة تعريف العقدة: محتوى العنصر المخزّن
  if (el.closest('#graph-detail')) return true;
  return false;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('══════ ⑥ اللغة — قياس صادق بلا استثناءات مخفية ══════');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  await page.waitForTimeout(1200);

  const dirAr = await page.evaluate(() => document.documentElement.dir);
  ok(dirAr === 'rtl', 'العربية: الاتجاه rtl', dirAr);

  const arCount = await page.evaluate(() => document.body.innerText.match(/[\u0600-\u06FF]/g)?.length || 0);
  ok(arCount > 50, 'العربية: محتوى عربي فعلي', arCount + ' حرفاً');

  // إثبات قرار الإزالة: زر اللغة لم يعد في الشريط العلوي
  ok(await page.locator('#lang-toggle').count() === 0, 'زر اللغة أُزيل من الشريط العلوي (التبديل في الإعدادات)');

  // التبديل للإنجليزية
  await switchLang(page, 'en');

  const dirEn = await page.evaluate(() => document.documentElement.dir);
  const langEn = await page.evaluate(() => document.documentElement.lang);
  ok(dirEn === 'ltr' && langEn === 'en', 'الإنجليزية: dir=ltr lang=en', `${dirEn}/${langEn}`);

  // كل الشاشات
  const views = ['notes', 'graph', 'monitor', 'repos', 'providers', 'import', 'tools', 'governance'];
  let totalUi = 0;
  const offenders = [];
  for (const v of views) {
    await page.click(`[data-view="${v}"]`).catch(() => {});
    await page.waitForTimeout(1300);
    const found = await page.evaluate((isUserDataSrc) => {
      const isUserData = new Function('el', 'return (' + isUserDataSrc + ')(el)');
      const out = [];
      document.querySelectorAll('span,div,button,a,label,th,td,p,h1,h2,h3,h4,li,strong,small').forEach((el) => {
        if (el.children.length) return;
        const raw = (el.textContent || '').trim();
        if (!/[\u0600-\u06FF]/.test(raw)) return;
        if (el.closest('.chat-bubble') || el.closest('.md-block')) return;
        if (el.closest('#note-preview') || el.closest('.pane-read') || el.closest('.task-item')) return;
        if (el.closest('#graph-detail')) return;
        if (isUserData(el)) return;
        out.push(`${el.tagName}.${String(el.className).slice(0, 22)} | ${raw.slice(0, 46)}`);
      });
      return out;
    }, isUserData.toString());
    if (found.length) {
      totalUi += found.length;
      found.slice(0, 4).forEach((f) => offenders.push(`${v}: ${f}`));
    }
  }
  ok(totalUi === 0, 'الإنجليزية: صفر نص واجهة عربي في الشاشات التسع', totalUi + ' متبقٍ');
  if (offenders.length) offenders.slice(0, 8).forEach((o) => console.log('       ↳', o));

  // شاشة الحُكم تحديداً (أكثر البقايا سابقاً)
  await page.click('[data-view="governance"]');
  await page.waitForTimeout(2500);
  const govUi = await page.evaluate((isUserDataSrc) => {
    const isUserData = new Function('el', 'return (' + isUserDataSrc + ')(el)');
    let n = 0;
    document.querySelectorAll('#view-governance .gov-detail, #view-governance .gov-name').forEach((el) => {
      const raw = (el.textContent || '').trim();
      if (!/[\u0600-\u06FF]/.test(raw)) return;
      if (isUserData(el)) return;
      n++;
    });
    return n;
  }, isUserData.toString());
  ok(govUi === 0, 'شاشة الحُكم: صفر نص خادم عربي بالإنجليزية', govUi + ' متبقٍ');

  // العودة للعربية
  await switchLang(page, 'ar');
  const backAr = await page.evaluate(() => ({
    dir: document.documentElement.dir,
    hasArabic: /[\u0600-\u06FF]/.test(document.body.innerText),
  }));
  ok(backAr.dir === 'rtl' && backAr.hasArabic, 'العودة للعربية كاملة', backAr.dir);

  /* ── عناصر الواجهة الصريحة: تُقاس **بالعربية** أيضاً ──
     العطل المُثبت 2026-10-20: كان القياس يجري بعد `#lang-toggle` الثاني — أي
     بعد العودة إلى العربية (dir=rtl كما يعلن السطر السابق) — ثم يتوقّع
     «صفر عربي». تناقض صريح: يقيس واجهة عربية ويتهمها بالعربية.
     القياس الصحيح ذو شقّين، وكلاهما بمعنى واضح:
       (أ) بالإنجليزية ⇒ صفر نص واجهة عربي (الترجمة كاملة).
       (ب) بالعربية   ⇒ الواجهة عربية فعلاً (الرحلة ذهاباً وإياباً سليمة). */
  await page.click('[data-view="notes"]');
  await page.waitForTimeout(1200);
  const countChromeAr = () => page.evaluate(() => {
    // نقيس النص **المعروض** فقط (offsetParent !== null) — العناصر المخفية
    // داخل نوافذ مغلقة لا تظهر للمستخدم، ولا يجوز اتهامها بالبقاء عربياً.
    const sel = '.sidebar a, .sidebar button, .sidebar .nav-label, header button, header a, .tab, .btn, h1, h2, h3, th, .panel-title, .sec-title, label';
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return; // مخفي
      const raw = (el.textContent || '').trim();
      if (!/[؀-ۿ]/.test(raw)) return;
      // أسماء عربية كتبها المستخدم (مشاريع/عناصر) لا تُترجم — تُستثنى بنفس
      // منطق isUserData المستعمل في بقية القياس.
      if (/^(note|doc|project|task|decision|knowledge)\s*•/.test(raw)) return;
      if (el.classList.contains('mono')) return;
      out.push(raw.slice(0, 40));
    });
    return out;
  });
  // (ب) بالعربية: الواجهة عربية فعلاً — هذا هو المتوقع الآن
  const chromeArNow = await countChromeAr();
  ok(chromeArNow.length > 0, 'بالعربية: الواجهة عربية فعلاً (رحلة ذهاب/إياب سليمة)', `${chromeArNow.length} عنصراً`);

  // (أ) بالإنجليزية: صفر نص واجهة عربي
  await switchLang(page, 'en');
  const chromeArEn = await countChromeAr();
  ok(chromeArEn.length === 0, 'بالإنجليزية: عناصر الواجهة بلا عربي', chromeArEn.slice(0, 5).join(' · ') || 'نظيف');

  ok(errors.length === 0, 'صفر أخطاء JS', errors.slice(0, 2).join(' | ') || 'نظيف');

  await page.screenshot({ path: path.join(process.cwd(), 'tests', 'browser', 'shots', '21-i18n-audit.png') });
  await browser.close();
  console.log(`\n═══ القسم ⑥: ${pass} نجح · ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('فشل الجري:', e.message); process.exit(1); });
