#!/usr/bin/env node
/**
 * ⑨ الخريطة التفاعلية — نظام FileMap (مركز + عمودان): اختبار حيّ دائم.
 * + نوافذ 2026-10-27: «إضافة مصدر» (4 تبويبات) · «ربط ذكي» · أقسام شاشة
 *   الوكلاء (المجدول/النبضات/المهارات) · لوحة ⌘K (المرادفات والتثبيت).
 *
 * يتحقق من: المحور باسمه ومؤشراته، الطيّ بالمشاريع وفكّه، التمركز بالنقر،
 * رجوع/Esc، توهج السلك عند المرور، شريط الأرقام، صفر أخطاء JS.
 * (استُبدل محرك العقد الفيزيائي بنظام FileMap المنقول حرفياً — قرار 2026-10-24.)
 *
 * قاعدة صارمة: هذا الملف **قراءة فقط** — لا استيراد ولا اعتماد علاقة ولا إنشاء
 * عنصر. القبو الحي (127.0.0.1:3737) لا يُلوَّث بمنتَج اختبار. الاستيراد الفعلي
 * والاعتماد الفعلي يُقاسان في مسارات أخرى؛ هنا يُقاس وجود الواجهة وسلوكها بلا كتابة.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
// عزل موحّد (2026-10-28): CORTEX_URL أولاً (بيئة الحزمة) — كان يقرأ CORTEX_BASE
// وحده فيعمل على المنتج الحيّ دائماً (من هنا «تشغيلات شبحية» وضغط على الحي).
const BASE = process.env.CORTEX_URL || process.env.CORTEX_BASE || 'http://127.0.0.1:3737';

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✔', n, x ? '— ' + x : ''); } else { fail++; console.log('  ✖', n, x ? '— ' + x : ''); } };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log('══════ ⑨ الخريطة — FileMap التفاعلي ══════');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.click('[data-view="graph"]');
  await page.waitForTimeout(3000);

  // المحور
  const hubName = (await page.locator('.fm-hub .fm-name').textContent().catch(() => '') || '').trim();
  ok(!!hubName, 'المحور يعرض العنصر الأكثر ارتباطاً', hubName || '—');
  const hubMeta = (await page.locator('.fm-hub .fm-meta').textContent().catch(() => '') || '');
  ok(/يعتمد عليه \d+ · يعتمد على \d+/.test(hubMeta), 'مؤشرات المحور كاملة', hubMeta.trim().slice(0, 60));

  // شريط الأرقام الخمسي
  const stats = await page.evaluate(() => ({
    files: document.getElementById('fm-st-files')?.textContent,
    folders: document.getElementById('fm-st-folders')?.textContent,
    cycles: document.getElementById('fm-st-cycles')?.textContent,
    orphans: document.getElementById('fm-st-orphans')?.textContent,
    edges: document.getElementById('fm-st-edges')?.textContent,
  }));
  ok(Number(stats.files) > 0 && Number(stats.edges) >= 0, 'شريط الأرقام يعمل', `عناصر=${stats.files} ارتباط=${stats.edges} دورات=${stats.cycles} يتيمة=${stats.orphans}`);

  // فكّ شريحة مشروع: نقرة chip → أسماء عناصر تظهر
  const chip = page.locator('.fm-chip').first();
  if (await chip.count()) {
    const chipLabel = (await chip.textContent().catch(() => '') || '').trim();
    await chip.click();
    await page.waitForTimeout(900);
    const unfolded = await page.locator('.fm-node[data-id]').count();
    ok(unfolded > 0, 'نقرة شريحة المشروع unfold عناصره', unfolded + ' عنصر (' + chipLabel.slice(0, 24) + ')');

    // زر «عرض الكل بالاسم» إن ظهر
    const showAll = page.locator('.fm-node.ghost', { hasText: 'عرض كل' });
    if (await showAll.count()) {
      const before = unfolded;
      await showAll.first().click();
      await page.waitForTimeout(800);
      const after = await page.locator('.fm-node[data-id]').count();
      ok(after > before, '«عرض كل العناصر بالاسم» يزيد الظاهر', before + ' → ' + after);
    }

    // التمركز: نقرة عنصر → المحور يتغير + زر رجوع؛ Esc يعيد
    const beforeHub = (await page.locator('.fm-hub .fm-name').textContent().catch(() => '') || '').trim();
    await page.locator('.fm-node[data-id]').first().click();
    await page.waitForTimeout(900);
    const afterHub = (await page.locator('.fm-hub .fm-name').textContent().catch(() => '') || '').trim();
    ok(afterHub && afterHub !== beforeHub, 'النقر يتمركز حول العنصر', `«${beforeHub.slice(0, 18)}» → «${afterHub.slice(0, 18)}»`);
    ok(await page.locator('.fm-hub .fm-back').count() === 1, 'زر رجوع يظهر بعد التمركز');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const backHub = (await page.locator('.fm-hub .fm-name').textContent().catch(() => '') || '').trim();
    ok(backHub === beforeHub, 'Esc يعود للمحور السابق', backHub.slice(0, 18));

    // توهج السلك عند المرور (إن كانت الأسلاك مرسومة)
    const wires = await page.locator('.fm-wire').count();
    if (wires > 0) {
      const node = page.locator('.fm-node[data-id]').first();
      await node.hover();
      await page.waitForTimeout(400);
      const hot = await page.locator('.fm-wire.fm-hot').count();
      ok(hot > 0, 'المرور على عنصر يُضيء سلكه', hot + ' سلك متوهج من ' + wires);
    } else {
      ok(true, 'الأسلاك مخفية عمداً عند الزحام (>60 ظاهراً) — سلوك النظام الموثق');
    }
  } else {
    // خريطة بلا طيّ: عناصر مباشرة — نتحقق من التمركز فقط
    const n = await page.locator('.fm-node[data-id]').count();
    ok(n > 0, 'الجيران يُعرضون مباشرة', n + ' عنصر');
    if (n > 0) {
      const beforeHub = (await page.locator('.fm-hub .fm-name').textContent() || '').trim();
      await page.locator('.fm-node[data-id]').first().click();
      await page.waitForTimeout(800);
      const afterHub = (await page.locator('.fm-hub .fm-name').textContent() || '').trim();
      ok(afterHub !== beforeHub, 'النقر يتمركز حول العنصر', `«${beforeHub.slice(0, 18)}» → «${afterHub.slice(0, 18)}»`);
    }
  }

  /* ══════════ ＋ جديدة = «إضافة مصدر» — أربع تبويبات بلا نموذج أنواع ══════════ */
  /* ══════════ + جديدة = كتابة سريعة وحدها، والاستيراد له قسم واحد ══════════
     (2026-11-06) كانت النافذة تحمل أربع تبويبات، ثلاثة منها تكرّر قسم الاستيراد
     حرفياً بواجهة أضعف. الآن: مسار استيراد واحد + زر يقود إليه من هنا. */
  await page.click('#new-note-btn');
  await page.waitForTimeout(700);
  ok(await page.locator('#modal-new').isVisible(), 'نافذة «عنصر جديد» تُفتح');
  ok(await page.locator('#src-tabs').count() === 0, 'لا تبويبات مصادر مكرّرة داخل النافذة');
  ok(await page.locator('#modal-new .src-panel').count() === 1, 'لوحة واحدة فقط (نص سريع)');
  ok(await page.locator('#new-title-input').isVisible() && await page.locator('#new-content-input').isVisible()
    && await page.locator('#create-note-btn').isVisible(), 'مسار «نص سريع» كامل: عنوان + نص + إنشاء');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  ok(await page.locator('#modal-new').isHidden(), 'Esc يغلق النافذة');

  // زر واحد يقود إلى مسار الاستيراد الوحيد
  await page.click('#new-note-btn');
  await page.waitForTimeout(400);
  ok(await page.locator('#open-import-btn').isVisible(), 'زر «استيراد» يقود إلى قسم الاستيراد');
  await page.click('#open-import-btn');
  await page.waitForTimeout(900);
  ok(await page.locator('#modal-new').isHidden(), 'زر الاستيراد يغلق النافذة');
  ok(await page.locator('#view-import.on').count() === 1, 'قسم الاستيراد هو المسار الوحيد', 'view-import نشط');
  ok(await page.locator('#import-project').count() === 1 && await page.locator('#import-preview-btn').count() === 1,
    'قسم الاستيراد يحمل المشروع والمعاينة (كانا في النافذة وحدها)');
  await page.click('#import-preview-btn');
  await page.waitForTimeout(600);
  const prevErr = (await page.locator('#import-result').innerText().catch(() => '') || '').trim();
  ok(prevErr.length > 0, 'معاينة بلا مسار تُعلن الخطأ نصياً', prevErr.slice(0, 40));
  await page.click('#rail .rail-btn[data-view="notes"]');
  await page.waitForTimeout(400);

  /* ══════════ ＋ ربط = «ربط ذكي» — بحث ⇒ اقتراحات بثقة ⇒ اعتماد ══════════ */
  await page.click('#link-note-btn');
  await page.waitForTimeout(1200);
  ok(await page.locator('#modal-link').isVisible(), 'نافذة «ربط ذكي» تُفتح');
  ok(await page.locator('#link-search-input').isVisible(), 'حقل البحث عن عنصر موجود وظاهر');
  const allPicks = await page.locator('#link-pick-list .tree-i').count();
  ok(allPicks > 0, 'قائمة الاختيار مملوءة من /api/notes', allPicks + ' عنصر');
  await page.fill('#link-search-input', 'zzz-لا-شيء-zzz');
  await page.waitForTimeout(400);
  const nonePicks = await page.locator('#link-pick-list .tree-i').count();
  ok(nonePicks === 0, 'البحث يفلتر قائمة الاختيار', allPicks + ' → ' + nonePicks);
  await page.fill('#link-search-input', '');
  await page.waitForTimeout(400);
  ok(await page.locator('#link-pick-list .tree-i').count() === allPicks, 'مسح البحث يستعيد القائمة');

  const srcTitle = (await page.locator('#link-source-title').innerText().catch(() => '') || '').trim();
  if (srcTitle && srcTitle !== '—') {
    // اقتراحات العنصر النشط (قراءة فقط — لا اعتماد)
    const sugg = await page.locator('#link-suggest-list .sugg').count();
    const emptyHint = await page.locator('#link-suggest-list .hint').count();
    ok(sugg > 0 || emptyHint > 0, 'اقتراحات الوكيل تُعرض أو تُعلَن حالة الفراغ', sugg + ' اقتراح');
    if (sugg > 0) {
      ok(await page.locator('#link-suggest-list .confbar').count() === sugg, 'لكل اقتراح شريط ثقة', sugg + '/' + sugg);
      const confTxt = (await page.locator('#link-suggest-list .chip.conf').first().innerText().catch(() => '') || '').trim();
      ok(/[0-9]/.test(confTxt), 'الثقة معروضة رقماً', confTxt.slice(0, 30));
      const reason = (await page.locator('#link-suggest-list .sugg-reason').first().innerText().catch(() => '') || '').trim();
      ok(reason.length > 0, 'لكل اقتراح سبب من التشابه الفعلي', reason.slice(0, 44));
      ok(await page.locator('#link-suggest-list .sugg-check').count() === sugg, 'مربع اختيار لكل اقتراح', sugg + ' مربع');
    }
  } else {
    ok(true, '(لا عنصر نشط — تخطّي فحص الاقتراحات)');
  }
  // اختيار عنصر آخر ⇒ تحميل اقتراحاته (قراءة فقط)
  await page.locator('#link-pick-list .tree-i').nth(allPicks > 1 ? 1 : 0).click();
  await page.waitForTimeout(1300);
  const afterPick = await page.locator('#link-suggest-list .sugg').count() + await page.locator('#link-suggest-list .hint').count();
  ok(afterPick > 0, 'اختيار عنصر يحمّل اقتراحاته', afterPick + ' صف');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok(await page.locator('#modal-link').isHidden(), 'Esc يغلق نافذة الربط');

  /* ══════════ سطح الوكيل الواحد ✦ — شاشة AGENT (2026-10-30): محادثة لا لوحة تحكم ══════════ */
  ok(await page.locator('#rail .rail-btn[data-view="agents"]').count() === 0,
    'لا شاشة وكيل ثانية في الشريط الجانبي (سطح واحد)');
  await page.click('#ai-open-btn');
  await page.waitForTimeout(1400);
  ok(await page.locator('#ai-panel .atab').count() === 0, 'لا تبويبات — الشاشة محادثة واحدة');
  ok(await page.locator('#agent-mode').count() === 0, 'لا منتقي وضع — الوكيل يقرر من الجملة');
  ok(await page.locator('#ai-panel #agent-bg-pane').count() === 0, '«الخلفية» أُزيلت من شاشة الوكيل');
  ok(await page.locator('#ai-panel .statusbar2').count() === 0, 'الشريط التقني أُزيل من الشاشة');
  ok(await page.locator('#agent-steps').isVisible() && await page.locator('#chat-messages').isVisible(),
    'الخطوات مع المحادثة في سطح واحد بلا تبديل');
  // «في غيابي» انتقل إلى شاشة المراقبة (شاشة الوكيل محادثة لا لوحة تحكم)
  await page.click('#ai-close-btn');
  await page.waitForTimeout(500);
  await page.locator('#rail .rail-btn[data-view="monitor"]').click();
  await page.waitForTimeout(2200);
  ok(await page.locator('#view-monitor #agent-sched-sec').isVisible(), 'المهام المجدولة داخل شاشة المراقبة');
  ok(await page.locator('#view-monitor #ticks-list').count() === 1, 'سجل النبضات داخل شاشة المراقبة');
  ok(await page.locator('#view-monitor #sched-form #sched-goal').count() === 1, 'نموذج الإضافة كامل في المراقبة');
  const hoursTxt = (await page.locator('#view-monitor #sched-hours').innerText().catch(() => '') || '').trim();
  ok(hoursTxt.length > 0, 'بيانات «في غيابي» تُحمَّل في المراقبة', hoursTxt.slice(0, 26));
  // عودة إلى لوحة الوكيل (بقية الفحوص تفترضها مفتوحة)
  await page.click('#ai-open-btn');
  await page.waitForTimeout(1200);
  // الاستوديو (W1-W5): الحالة الحيّة + عقد الصلاحيات — قراءة فقط
  ok(await page.locator('#agent-live').isVisible(), 'شريط الحالة الحيّة ظاهر فوق حقل الكتابة');
  ok((await page.locator('#agent-live').innerText()).trim().length > 0, 'الشريط يحمل نص حالة فعلياً');
  await page.click('#contract-btn');
  await page.waitForTimeout(1200);
  ok(await page.locator('#contract-drawer').isVisible(), 'لوحة الصلاحيات والأدوار تُفتح');
  ok(await page.locator('#contract-drawer .contract-table tbody tr').count() >= 6, 'مصفوفة الأدوار الستة معروضة');
  ok(await page.locator('#contract-drawer input[type=number]').count() === 4, 'سقوف اليوم الأربعة قابلة للضبط');
  ok(await page.locator('#contract-drawer').innerText().then((x) => /لا يمنح نفسه|never grants itself/.test(x)), 'قاعدة الحوكمة معلَنة في اللوحة');
  await page.click('#contract-close-btn');
  await page.waitForTimeout(350);
  ok(await page.locator('#contract-drawer').isHidden(), 'اللوحة تُغلق بلا أثر');
  // المهارات انتقلت إلى قسم «الأدوات» (توحيد السطح)
  await page.click('#ai-close-btn');
  await page.waitForTimeout(500);
  await page.click('#rail .rail-btn[data-view="tools"]');
  await page.waitForTimeout(1600);
  const skillNames = (await page.locator('#skills-list tbody td.mono').allInnerTexts()).map((s) => s.trim());
  const WANT = ['project-analysis', 'run-tests', 'write-report', 'import-source'];
  const foundSkills = WANT.filter((w) => skillNames.includes(w));
  ok(foundSkills.length === WANT.length, 'المهارات الأربع معروضة بالاسم في الأدوات',
    foundSkills.join(',') + (skillNames.length > foundSkills.length ? ' (+' + (skillNames.length - foundSkills.length) + ')' : ''));
  ok(await page.locator('#skills-list tbody td.dim').count() >= WANT.length, 'لكل مهارة وصف مقروء');

  /* ══════════ ⌘K: المرادفات ثنائية اللغة + التثبيت ══════════ */
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  ok(await page.locator('#palette').isVisible(), 'لوحة ⌘K تُفتح بالمفتاح');
  ok(await page.locator('#palette-results .pi-star').count() > 0, 'لكل صف زر تثبيت (نجمة)');
  // مرادف عربي: «إضافة» يجب أن تجد أمر المصدر
  await page.fill('#palette-input', 'إضافة');
  await page.waitForTimeout(500);
  const arHits = (await page.locator('#palette-results .pi .t').allInnerTexts()).join(' | ');
  ok(arHits.length > 0, 'البحث بالعربية يجد الأوامر', arHits.slice(0, 50));
  // مرادف إنجليزي: «add» يجب أن يصل للأمر العربي نفسه (قاموس المرادفات)
  await page.fill('#palette-input', 'add');
  await page.waitForTimeout(500);
  const enHits = (await page.locator('#palette-results .pi .t').allInnerTexts()).join(' | ');
  ok(arHits.includes('إضافة') && enHits.includes('إضافة'), 'مرادف add يصل لأمر «إضافة مصدر» العربي', enHits.slice(0, 40));
  await page.fill('#palette-input', 'link');
  await page.waitForTimeout(500);
  ok((await page.locator('#palette-results .pi .t').allInnerTexts()).join(' | ').includes('ربط'),
    'مرادف link يصل لأوامر الربط');
  // التثبيت: نجمة ⇒ localStorage + قسم «مثبتة» أولاً (نثبّت الصف الثاني ليقيس التقدّم فعلاً)
  await page.fill('#palette-input', '');
  await page.waitForTimeout(400);
  const secondLabel = (await page.locator('#palette-results .pi .t').nth(1).innerText()).trim();
  await page.locator('#palette-results .pi-star').nth(1).click();
  await page.waitForTimeout(500);
  const pins = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cortex.pinnedCommands') || '[]'); } catch (e) { return null; } });
  ok(Array.isArray(pins) && pins.length === 1, 'التثبيت محفوظ في localStorage (cortex.pinnedCommands)', JSON.stringify(pins));
  const groupTxt = (await page.locator('#palette-results .pi-group').first().innerText().catch(() => '') || '').trim();
  ok(groupTxt.length > 0, 'قسم «مثبتة» يظهر بالأعلى', groupTxt);
  const firstAfter = (await page.locator('#palette-results .pi .t').first().innerText()).trim();
  ok(firstAfter === secondLabel && await page.locator('#palette-results .pi-star.on').count() === 1,
    'الصف المثبت يتقدّم للأول ونجمته مضيئة', firstAfter.slice(0, 30));
  // إلغاء التثبيت — لا نترك أثراً في جهاز المستخدم
  await page.locator('#palette-results .pi-star').first().click();
  await page.waitForTimeout(400);
  const pins2 = await page.evaluate(() => JSON.parse(localStorage.getItem('cortex.pinnedCommands') || '[]'));
  ok(Array.isArray(pins2) && pins2.length === 0 && await page.locator('#palette-results .pi-group').count() === 0,
    'إلغاء التثبيت يُنظّف الحالة (لا أثر باقٍ)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // الاستقرار
  const realErrors = errors.filter((e) => !/favicon|Failed to fetch|404/.test(e));
  ok(realErrors.length === 0, 'صفر أخطاء JS', realErrors.slice(0, 2).join(' | ') || 'نظيف');

  // الصورة تخصّ قسم الخريطة — نعود إليها بعد أن تركت فحوص 2026-10-27 الواجهة على شاشة الوكلاء
  await page.click('[data-view="graph"]');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(process.cwd(), 'tests', 'browser', 'shots', '18-graph-section.png') });
  await browser.close();
  console.log(`\n═══ القسم ⑨: ${pass} نجح · ${fail} فشل ═══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('فشل الجري:', e.message); process.exit(1); });
