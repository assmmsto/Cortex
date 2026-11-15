#!/usr/bin/env node
/**
 * ⑩ المعرفة (الأهمية) + لوحة الوكيل (الإدخال والخطوة التالية) — اختبار حيّ دائم.
 *
 * قرارات دورة الأدوار المُثبتة هنا:
 *  - شريحة الأهمية تُرى في صفوف المكتبة قبل فتح العنصر.
 *  - خانة الإدخال ملتصقة أسفل اللوحة دائماً (لا تُدفن خلف الرسائل الطويلة).
 *  - «الخطوة التالية» زر فعلي لا نص مدفون.
 *  - التبويبات تعمل، واللوحة تترجم كاملة.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
// عزل موحّد (2026-10-28): CORTEX_URL أولاً — كان CORTEX_BASE وحده فيضرب الحيّ.
const BASE = process.env.CORTEX_URL || process.env.CORTEX_BASE || 'http://127.0.0.1:3737';

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✔', n, x ? '— ' + x : ''); } else { fail++; console.log('  ✖', n, x ? '— ' + x : ''); } };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log('══════ ⑩ المعرفة + لوحة الوكيل ══════');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // شريحة الأهمية في المكتبة
  const totalRows = await page.locator('#library-list .tree-i').count();
  const impMarks = await page.locator('#library-list .imp-mark').count();
  ok(totalRows > 0, 'المكتبة تعرض صفوفاً', totalRows + ' صف');
  ok(impMarks > 0, 'شريحة الأهمية تظهر في الصفوف', impMarks + ' شريحة');

  // لوحة الوكيل
  const openBtn = await page.$('#ai-open-btn');
  if (openBtn) { await openBtn.click(); await page.waitForTimeout(900); }
  ok(await page.locator('#ai-panel:not(.hidden)').count() > 0, 'لوحة الوكيل تُفتح');

  // التخطيط: الإدخال ملتصق أسفل، الرسائل متمدّدة
  const layout = await page.evaluate(() => {
    const inp = document.getElementById('chat-input');
    const panel = document.getElementById('ai-panel');
    const msgs = document.getElementById('chat-messages');
    if (!inp || !panel || !msgs) return null;
    const pr = panel.getBoundingClientRect(), ir = inp.getBoundingClientRect(), mr = msgs.getBoundingClientRect();
    return { gap: Math.round(pr.bottom - ir.bottom), msgsH: Math.round(mr.height), visible: ir.height > 0 && ir.width > 0, hasNextBar: !!document.getElementById('next-action-bar') };
  });
  ok(layout && layout.visible, 'خانة الإدخال مرئية');
  ok(layout && layout.gap < 100, 'الإدخال ملتصق أسفل اللوحة (لا مدفون خلف الرسائل)', layout ? layout.gap + 'px' : '');
  ok(layout && layout.msgsH > 80, 'منطقة الرسائل متمدّدة فعلاً', layout ? layout.msgsH + 'px' : '');
  ok(layout && layout.hasNextBar, 'شريط الخطوة التالية موجود في البنية');

  // شاشة AGENT (2026-10-30): بلا تبويبات — الخطوات والمحادثة في السطح نفسه دائماً
  const stepsOn = await page.evaluate(() => { const e = document.getElementById('agent-steps'); return !!e && !e.hidden; });
  const chatOn = await page.evaluate(() => { const e = document.getElementById('chat-messages'); return !!e && !e.hidden; });
  const atabN = await page.locator('#ai-panel .atab').count();
  ok(stepsOn && chatOn && atabN === 0, 'بلا تبويبات — الخطوات والمحادثة في السطح نفسه', 'atab=' + atabN);

  // زر الخطوة التالية يشتغل فعلاً — المقياس: ظهور جواب جديد (بطاقة .tl-answer) لا «نمو العدّ»
  // لأن تشغيل mock ينتج بطاقتين بالضبط (نيّتك + الجواب) وقد يساوي عددهما العناصر المؤقتة.
  const ANSWER = '#chat-messages .tl-answer, #chat-messages .chat-bubble.ai';
  const waitAnswer = async () => {
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(600);
      if (await page.locator(ANSWER).count() > 0) return true;
    }
    return false;
  };
  // 2026-10-30 (قرار المستخدم «وكيل حقيقي = أكتب جملتي»): أزرار الأوامر الجاهزة أُزيلت.
  // الفحص الآن يقيس مسار المستخدم الحقيقي بعينه: كتابة جملة في الحقل ← «نفّذ» ← جواب فعلي.
  ok((await page.$('#q-next2')) === null && (await page.$('#q-gaps2')) === null, 'لا أزرار أوامر جاهزة على سطح المحادثة');
  const ta = await page.$('#chat-input');
  const sb = await page.$('#send-chat-btn');
  ok(!!ta && !!sb, 'حقل الكتابة وزر التنفيذ موجودان');
  if (ta && sb) {
    await ta.fill('كم ملاحظة عندي؟ اذكر العدد فقط');
    await sb.click();
    const got = await waitAnswer();
    ok(got, 'جملة مكتوبة تشغّل الوكيل فعلاً وتعيد جواباً', got ? 'ظهر الجواب' : 'لا جواب خلال المهلة');
  }

  // ترجمة اللوحة — التبديل عبر الإعدادات (زر اللغة العلوي أُزيل 2026-10-25 بقرار المستخدم)
  const switchLang = async (lang) => {
    await page.click('#settings-btn');
    await page.waitForTimeout(600);
    await page.click(`[data-ui-lang="${lang}"]`);
    await page.waitForTimeout(1600);
    await page.click('#close-settings-btn');
    await page.waitForTimeout(500);
  };
  await switchLang('en');
  /* الاستوديو (2026-10-28): بيانات التشغيل في الخط الزمني/الشريط الحيّ ليست نص واجهة
     (هدف المستخدم وجواب الخادم)، وعناوين العناصر في تبويب المصادر (.t) بيانات
     كعناوين المكتبة — نفس مبدأ 06 حرفياً. */
  const isPanelData = (el) => !!(el.closest && (
    el.closest('.tl-user') || el.closest('.tl-answer') || el.closest('.tl-obs') || el.closest('.tl-thought') ||
    el.closest('.tl-artifact') || el.closest('.al-goal') || el.closest('.na-text') ||
    (el.tagName === 'SPAN' && el.classList.contains('t')) || el.classList.contains('cchip')
  ));
  const arLeft = await page.evaluate((src) => {
    const isData = new Function('el', 'return (' + src + ')(el)');
    let n = 0;
    document.querySelectorAll('#ai-panel span, #ai-panel button').forEach((el) => {
      if (el.children.length) return;
      const tx = (el.textContent || '').trim();
      if (!/[\u0600-\u06FF]/.test(tx)) return;
      if (el.classList.contains('mono') || el.tagName === 'SMALL') return;
      if (isData(el)) return;
      n++;
    });
    return n;
  }, isPanelData.toString());
  ok(arLeft === 0, 'لوحة الوكيل تترجم بالإنجليزي', arLeft + ' بقية');
  await switchLang('ar');

  const realErrors = errors.filter((e) => !/favicon|Failed to fetch|404/.test(e));
  ok(realErrors.length === 0, 'صفر أخطاء JS', realErrors.slice(0, 2).join(' | ') || 'نظيف');

  await page.screenshot({ path: path.join(process.cwd(), 'tests', 'browser', 'shots', '20-knowledge-agent.png') });
  await browser.close();
  console.log(`\n═══ القسم ⑩: ${pass} نجح · ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('فشل الجري:', e.message); process.exit(1); });
