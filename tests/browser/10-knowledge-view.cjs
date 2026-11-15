/**
 * العاشر: قسم المعرفة — التحقق الكامل (2026-11-06).
 *
 * يقيس كل وظيفة يراها المستخدم في الشاشة الأولى، لا وجود العناصر فقط:
 *   • العدّاد يطابق المكتبة (كان «0 / 0» و92 عنصراً).
 *   • البحث والفلترة والمسح تُغيّر القائمة فعلاً.
 *   • المحرّر يملأ المساحة (كان 74px والمعاينة 434px متراكبين) ويبدّل إلى معاينة.
 *   • الحفظ التلقائي يصل إلى القرص (قراءة عكسية من الـAPI).
 *   • تصنيف العنصر (النوع/الأهمية) يُحفظ ويُقرأ.
 *   • شارة نوع المعرفة (المادة 6) تظهر على العنصر.
 *   • لوحة التفاصيل تعرض مهام/مرتبطات/روابط/سجل/ثقة بعناوينها الصحيحة.
 *   • اللغتان: التبديل إلى الإنجليزية يترجم أدوات الشاشة.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const BASE = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [], bad = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });
  p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(BASE, '')); });

  await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  // انتظر امتلاء المكتبة — إقلاع الخادم البارد قد يتجاوز 3.5s (كان الاختبار يقيس صفراً)
  await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(900);
  R.c.push('══════ قسم المعرفة — تحقق وظيفي كامل ══════');

  // ── 1) العدّاد ────────────────────────────────────────────────
  const total = await p.evaluate(() => (window.S && window.S.notes ? window.S.notes.length : document.querySelectorAll('#library-list .tree-i').length));
  const counter = (await p.textContent('#notes-count')).trim();
  ok(counter === total + ' / ' + total, 'العدّاد يطابق عدد المكتبة', counter + ' (المكتبة ' + total + ')');

  // ── 2) البحث ─────────────────────────────────────────────────
  // رأس الشاشة: أربعة عناصر ظاهرة فقط، وزر المسح مخفي حتى يوجد فلتر
  const header = await p.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); return !!(e && e.offsetParent); };
    return {
      search: vis('#notes-search'), type: vis('#notes-type'), count: vis('#notes-count'),
      exportIcon: vis('#export-project-btn'), clear: vis('#notes-clear'),
      visible: [...document.querySelectorAll('#view-notes .view-tools > *')].filter((e) => e.offsetParent).length
    };
  });
  ok(header.search && header.type && header.count && header.exportIcon, 'عناصر المكتبة الأساسية ظاهرة', JSON.stringify(header));
  ok(header.clear === false, '«مسح الفلتر» مخفي بلا فلتر');
  ok(header.visible <= 4, 'رأس الشاشة بسيط (٤ عناصر كحد أقصى)', header.visible + ' عناصر');

  const firstTitle = await p.evaluate(() => (document.querySelector('#library-list .tree-i .t') || {}).textContent || '');
  await p.fill('#notes-search', firstTitle.slice(0, 6));
  await p.waitForTimeout(600);
  const searched = await p.evaluate(() => ({ shown: document.querySelectorAll('#library-list .tree-i').length, count: (document.querySelector('#notes-count') || {}).textContent }));
  ok(searched.shown > 0 && searched.shown <= total, 'البحث يرشّح القائمة', searched.shown + ' نتيجة');
  ok(searched.count !== total + ' / ' + total, 'العدّاد يتبع الفلتر', searched.count);
  await p.fill('#notes-search', 'zzz-no-such-item');
  await p.waitForTimeout(500);
  const none = await p.evaluate(() => ({ shown: document.querySelectorAll('#library-list .tree-i').length, hint: (document.querySelector('#library-list .hint') || {}).textContent || '' }));
  ok(none.shown === 0 && /لا نتائج|No results/i.test(none.hint), 'بحث بلا نتيجة يعلنها', none.hint.trim());

  // ── 3) فلتر النوع + المسح ────────────────────────────────────
  await p.click('#notes-clear');
  await p.waitForTimeout(500);
  const restored = await p.evaluate(() => document.querySelectorAll('#library-list .tree-i').length);
  ok(restored === total, '«مسح الفلتر» يعيد كل العناصر', restored + '/' + total);
  await p.selectOption('#notes-type', 'decision');
  await p.waitForTimeout(600);
  const byType = await p.evaluate(() => ({
    shown: document.querySelectorAll('#library-list .tree-i').length,
    clearVisible: !document.querySelector('#notes-clear').classList.contains('hidden'),
    groups: [...document.querySelectorAll('#library-list .tree-h')].map((h) => h.textContent.trim())
  }));
  ok(byType.shown > 0 && byType.shown < total, 'فلتر النوع يرشّح فعلاً', byType.shown + ' قراراً');
  ok(byType.clearVisible, 'زر المسح يظهر عند وجود فلتر');
  ok(byType.groups.length === 1, 'المكتبة تعرض المجموعة المطلوبة وحدها', JSON.stringify(byType.groups));
  await p.click('#notes-clear');
  await p.waitForTimeout(500);

  // ── 4) المحرّر: المساحة والوضعان ─────────────────────────────
  await p.evaluate(() => { const it = document.querySelector('#library-list .tree-i[data-id]'); if (it) it.click(); });
  await p.waitForTimeout(2000);
  const geo = await p.evaluate(() => {
    const h = (s) => { const e = document.querySelector(s); if (!e) return -1; return Math.round(e.getBoundingClientRect().height); };
    return { textarea: h('#note-content'), preview: h('#note-preview'), previewHidden: document.querySelector('#note-preview').classList.contains('hidden'), pills: [...document.querySelectorAll('#editor-tabs .vpill')].map((x) => x.dataset.mode) };
  });
  ok(geo.textarea > 300, 'منطقة الكتابة تملأ المساحة (كانت 74px)', geo.textarea + 'px');
  ok(geo.previewHidden, 'المعاينة لا تزاحم المحرّر في وضع التحرير');
  ok(geo.pills.length === 2 && geo.pills.includes('preview'), 'وضعا المحرّر معروضان', JSON.stringify(geo.pills));

  await p.click('#editor-tabs .vpill[data-mode="preview"]');
  await p.waitForTimeout(500);
  const prev = await p.evaluate(() => ({
    ta: document.querySelector('#note-content').classList.contains('hidden'),
    pv: !document.querySelector('#note-preview').classList.contains('hidden'),
    h: Math.round(document.querySelector('#note-preview').getBoundingClientRect().height)
  }));
  ok(prev.ta && prev.pv && prev.h > 300, '«معاينة» تعرض القراءة وحدها', prev.h + 'px');
  await p.click('#editor-tabs .vpill[data-mode="edit"]');
  await p.waitForTimeout(400);

  // ── 5) نوع المعرفة (المادة 6): عنصر يصير «قراراً» ⇒ الشارة تظهر ──
  const kindNoteId = await p.evaluate(() => (document.querySelector('#library-list .tree-i.active') || {}).dataset.id);
  await p.click('#doc-meta-toggle');
  await p.waitForTimeout(300);
  await p.selectOption('#type-select', 'decision');
  await p.click('#save-note-btn');
  await p.waitForTimeout(2000);
  const kindApi = await p.evaluate(async (id) => {
    const d = await (await fetch('/api/notes/' + encodeURIComponent(id))).json();
    return d.note ? d.note.knowledgeKind : null;
  }, kindNoteId);
  ok(kindApi === 'decided', 'الـAPI يحمل نوع المعرفة (المادة 6)', String(kindApi));
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(2600);
  await p.evaluate((id) => {
    const it = [...document.querySelectorAll('#library-list .tree-i[data-id]')].find((x) => x.dataset.id === id);
    if (it) it.click();
  }, kindNoteId);
  await p.waitForTimeout(1800);
  const chips = await p.evaluate(() => [...document.querySelectorAll('#note-meta-line .chip.kk')].map((c) => c.textContent.trim()));
  ok(chips.length > 0 && chips.some((c) => /معتمد|Decided/.test(c)), 'شارة نوع المعرفة ظاهرة في رأس العنصر', JSON.stringify(chips));

  // ── 6) الحفظ التلقائي ───────────────────────────────────────
  const noteId = await p.evaluate(() => (document.querySelector('#library-list .tree-i.active') || {}).dataset.id);
  const stamp = 'AUTOSAVE-' + Date.now();
  await p.fill('#note-content', 'محتوى اختبار الحفظ ' + stamp);
  await p.waitForTimeout(2400);
  const saved = await p.evaluate(async (id) => {
    const d = await (await fetch('/api/notes/' + encodeURIComponent(id))).json();
    return String((d.note && (d.note.body || d.note.content)) || '');
  }, noteId);
  ok(saved.includes(stamp), 'الحفظ التلقائي وصل إلى القرص', noteId);

  // ── 7) التصنيف (الأهمية) ────────────────────────────────────
  await p.click('#doc-meta-toggle');
  await p.waitForTimeout(300);
  await p.click('#editor-importance-seg [data-ui-importance="5"]');
  await p.click('#save-note-btn');
  await p.waitForTimeout(1800);
  const imp = await p.evaluate(async (id) => {
    const d = await (await fetch('/api/notes/' + encodeURIComponent(id))).json();
    return d.note && d.note.fm ? d.note.fm.importance : null;
  }, noteId);
  ok(Number(imp) === 5, 'الأهمية «حرِج» تُحفظ فعلاً', 'importance=' + imp);

  // ── 8) لوحة التفاصيل ────────────────────────────────────────
  const ctx = await p.evaluate(() => ({
    panels: [...document.querySelectorAll('#ctx-panels .ctx-col')].map((c) => c.id),
    labels: [...document.querySelectorAll('#ctx-panels .ctx-col')].map((c) => c.getAttribute('data-lbl') || ''),
    tasksLabel: (document.querySelector('#ctx-tasks') || {}).getAttribute ? document.querySelector('#ctx-tasks').getAttribute('data-lbl') : null,
    toggle: (document.querySelector('#ctx-details-toggle') || {}).textContent
  }));
  ok(ctx.panels.length === 6, 'اللوحات الست موجودة', ctx.panels.join(','));
  ok(ctx.labels.every((l) => l && l.trim().length > 0), 'كل لوحة تحمل عنواناً مترجَماً', JSON.stringify(ctx.labels));

  // ── 9) السجل ────────────────────────────────────────────────
  const hist = await p.evaluate(async () => {
    const list = (await (await fetch('/api/notes')).json()).notes || [];
    let best = null, n = 0;
    for (const note of list.slice(0, 40)) {
      const h = await (await fetch('/api/note-history/' + encodeURIComponent(note.id))).json().catch(() => ({}));
      const k = (h.entries || []).length;
      if (k > n) { n = k; best = note.id; }
    }
    return { best, n };
  });
  ok(hist.n > 0, 'سجل التغييرات موجود لعناصر', (hist.n || 0) + ' لقطة في ' + (hist.best || '—'));

  // ── 10) اللغتان ─────────────────────────────────────────────
  await p.click('#settings-btn');
  await p.waitForTimeout(400);
  await p.click('[data-ui-lang="en"]');
  await p.waitForTimeout(1200);
  await p.click('#close-settings-btn').catch(() => {});
  await p.waitForTimeout(500);
  const en = await p.evaluate(() => ({
    pills: [...document.querySelectorAll('#editor-tabs .vpill')].map((x) => x.textContent.trim()),
    searchPh: document.querySelector('#notes-search').placeholder,
    exportAria: document.querySelector('#export-project-btn').getAttribute('aria-label')
  }));
  ok(en.pills.every((t) => !/[\u0600-\u06FF]/.test(t)), 'أوضاع المحرّر تُترجم', JSON.stringify(en.pills));
  ok(!/[\u0600-\u06FF]/.test(en.searchPh), 'عنوان حقل البحث يُترجم', en.searchPh);
  ok(en.exportAria === 'Export', 'زر التصدير له اسم مفهوم بالإنجليزية', en.exportAria);
  await p.click('#settings-btn'); await p.waitForTimeout(400);
  await p.click('[data-ui-lang="ar"]'); await p.waitForTimeout(1000);
  await p.click('#close-settings-btn').catch(() => {});

  // ── 11) أخطاء ───────────────────────────────────────────────
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | ') || '—');
  ok(bad.length === 0, 'صفر ردود فاشلة', bad.slice(0, 3).join(' | ') || '—');

  console.log(R.c.join('\n'));
  console.log(`\nFIN_knowledge ${R.p} نجح · ${R.f} فشل`);
  await b.close();
  process.exit(R.f ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });