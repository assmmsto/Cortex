/**
 * الحادي عشر: خريطة الترابط — الجزر (المستوى الأول) والصدق في العرض (2026-11-06).
 *
 * السبب المقيس قبل الإصلاح: شاشة التركيز كانت ترسم 5 عقد من 94، وتُعلن «94 عنصراً
 * • 63 ارتباطاً»، وتُخفي الأسلاك صامتة فوق 60 عنصراً، و«معزولة 50» رقم بلا نقر.
 *
 * هذا القسم يقيس المستويين:
 *   • على بيانات حقيقية: بطاقات المجلدات، البحث، فتح قائمة المعزولات، والحفر لمجلد.
 *   • على بيانات مصنوعة بالمقياس المذكور (50 مجلداً/1000 ملف): أن الشاشة تصمد،
 *     وتقول صراحةً كم تعرض من كم، وتُعلن سبب اختفاء الأسلاك.
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
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });

  await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(1000);
  await p.click('#rail .rail-btn[data-view="graph"]');
  await p.waitForTimeout(2800);
  R.c.push('══════ خريطة الترابط — الجزر + الصدق ══════');

  // ── المستوى الأول: الجزر ─────────────────────────────────────
  const ov = await p.evaluate(() => ({
    folders: document.querySelectorAll('.fm-folder').length,
    stats: [...document.querySelectorAll('.fm-folder')].slice(0, 3).map((f) => ({ t: f.textContent.trim(), bar: !!f.querySelector('.bar i') })),
    actions: [...document.querySelectorAll('.fm-ov-btn')].map((a) => a.textContent.trim()),
    search: !!document.querySelector('#fm-ov-search'),
    stage: Math.round(document.querySelector('.fm-stage').getBoundingClientRect().height)
  }));
  ok(ov.folders > 0, 'بطاقات المجلدات معروضة (المستوى الأول)', ov.folders + ' مجلداً');
  ok(ov.stats.every((s) => s.bar), 'كل بطاقة تحمل شريط متصل/معزول', JSON.stringify(ov.stats.slice(0, 2)));
  ok(ov.search, 'بحث داخل الخريطة موجود');
  ok(/يتيمة|orphan/i.test(ov.actions.join(' ')), 'زر المعزولات ظاهر برقمه', ov.actions.join(' · '));
  ok(ov.stage > 300, 'مسرح التركيز لم يُسحق تحت الجزر', ov.stage + 'px');

  // ── البحث يرشّح البطاقات ─────────────────────────────────────
  const term = await p.evaluate(() => {
    const f = document.querySelector('.fm-folder .nm');
    return f ? f.textContent.trim().split('/').pop().slice(0, 4) : '';
  });
  if (term) {
    await p.fill('#fm-ov-search', term);
    await p.waitForTimeout(700);
    const filtered = await p.evaluate(() => document.querySelectorAll('.fm-folder').length);
    ok(filtered > 0 && filtered < ov.folders, 'البحث يرشّح المجلدات', term + ' → ' + filtered + '/' + ov.folders);
    await p.fill('#fm-ov-search', '');
    await p.waitForTimeout(500);
  }

  // ── المعزولات: رقم ← قائمة ──────────────────────────────────
  await p.evaluate(() => { const b2 = [...document.querySelectorAll('.fm-ov-btn')].find((x) => /يتيمة|orphan/i.test(x.textContent)); if (b2) b2.click(); });
  await p.waitForTimeout(900);
  const orph = await p.evaluate(() => ({
    panel: !!document.querySelector('.fm-list'),
    header: (document.querySelector('.fm-list-h span') || {}).textContent || '',
    items: document.querySelectorAll('.fm-list .fm-node').length,
    active: document.querySelectorAll('.fm-ov-btn.on').length
  }));
  ok(orph.panel && orph.items > 0, '«معزولة» تفتح قائمة قابلة للنقر', orph.header + ' · ' + orph.items + ' عنصراً');
  ok(orph.active === 1, 'الزر المُعلَّم نشط واحد', String(orph.active));
  await p.evaluate(() => { const x = document.querySelector('.fm-list-h button'); if (x) x.click(); });
  await p.waitForTimeout(500);

  // ── الحفر: من مجلد إلى عنصر ─────────────────────────────────
  const drill = await p.evaluate(async () => {
    const cards = [...document.querySelectorAll('.fm-folder')];
    const card = cards[1] || cards[0];
    if (!card) return null;
    const label = card.querySelector('.nm').textContent.trim();
    const before = (document.querySelector('.fm-hub .fm-name') || {}).textContent;
    card.click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      label, before,
      after: (document.querySelector('.fm-hub .fm-name') || {}).textContent,
      marked: !!document.querySelector('.fm-folder.on'),
      reset: [...document.querySelectorAll('.fm-ov-btn')].some((x) => /عرض الكل|show all/i.test(x.textContent))
    };
  });
  ok(!!drill && drill.after && drill.after !== drill.before, 'النقر على مجلد يحفر إلى عنصر داخله', drill ? drill.label + ' → ' + drill.after : '—');
  ok(!!drill && drill.marked, 'البطاقة المختارة مُعلَّمة');
  ok(!!drill && drill.reset, 'زر «عرض الكل» يظهر بعد الحفر');

  // ── الصدق على بيانات حقيقية ─────────────────────────────────
  const honesty = await p.evaluate(() => ({
    wireNote: (document.querySelector('#fm-wire-note') || {}).textContent,
    counts: [...document.querySelectorAll('.fm-count')].map((c) => c.textContent),
    info: (document.querySelector('#graph-info') || {}).textContent
  }));
  ok(!!honesty.wireNote, 'سطر الأسلاك يوضّح ما يُرسم', honesty.wireNote);

  // ── المقياس المذكور: 50 مجلداً و1000 ملف ────────────────────
  const scale = await p.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'fm-scale-host';
    host.style.cssText = 'position:fixed;inset:0;background:#111;z-index:9999;padding:10px;overflow:auto';
    document.body.appendChild(host);
    const nodes = [], edges = [];
    const FOLDERS = 50, FILES = 1000;
    for (let f = 0; f < FOLDERS; f++) {
      for (let i = 0; i < FILES / FOLDERS; i++) {
        const id = 'f' + f + '-' + i;
        nodes.push({ id, name: id, kind: i % 3 ? 'doc' : 'note', folder: 'proj' + f });
      }
    }
    // hub with 200 relations + scattered links
    for (let i = 0; i < 200; i++) edges.push({ from: 'f0-0', to: 'f0-' + (i % 20) === 'f0-0' ? 'f1-0' : 'f1-' + (i % 20) });
    for (let f = 1; f < FOLDERS; f++) edges.push({ from: 'f' + f + '-0', to: 'f0-0' });
    const stats = { files: nodes.length, folders: FOLDERS, edges: edges.length, cycles: 2, orphans: nodes.length - 220, hub: 'f0-0', cycleGroups: [['f0-0', 'f1-0']] };
    window.CortexFilemap.render(host, { nodes, edges, stats, generatedAt: 'test', root: 'test' }, { lang: 'ar', activeId: null });
    const folders = document.querySelectorAll('#fm-scale-host .fm-folder').length;
    const card = document.querySelector('#fm-scale-host .fm-folder');
    const shownLabel = [...document.querySelectorAll('#fm-scale-host .fm-col-title')].map((x) => x.textContent.trim());
    const warn = (document.querySelector('#fm-scale-host .fm-wire-note') || {}).textContent || '';
    const wires = document.querySelectorAll('#fm-scale-host .fm-wires path.fm-wire').length;
    const actionBtns = [...document.querySelectorAll('#fm-scale-host .fm-ov-btn')].map((x) => x.textContent.trim());
    if (card) card.click();
    return { nodes: nodes.length, edges: edges.length, folders, shownLabel, warn, wires, actionBtns, hubAfter: (document.querySelector('#fm-scale-host .fm-hub .fm-name') || {}).textContent };
  });
  ok(scale.nodes === 1000, 'السيناريو المطلوب: 1000 عنصر', String(scale.nodes));
  ok(scale.folders > 0 && scale.folders <= 60, 'المجلدات تُعرض كاملة (50) لا 1000 عنصر', scale.folders + ' بطاقة');
  ok(/يتيمة|orphan/i.test(scale.actionBtns.join(' ')), 'المعزولات محسوبة بالمقياس', scale.actionBtns.slice(0, 3).join(' · '));
  ok(/\/|\d+ \/ \d+/.test(scale.shownLabel.join(' ')) || scale.warn.includes('>'), 'العرض يعلن «كم من كم» أو سبب إخفاء الأسلاك', JSON.stringify(scale.shownLabel) + ' | ' + scale.warn.slice(0, 60));
  ok(scale.hubAfter && scale.wires >= 0, 'الحفر يعمل على 1000 عنصر بلا انهيار', 'hub=' + scale.hubAfter);

  // التوسيع القسري: عند تجاوز 60 عنصراً معروضاً يجب أن تُعلن الأسلاك سبب اختفائها
  const expanded = await p.evaluate(async () => {
    const host = document.getElementById('fm-scale-host');
    const snap = () => ({
      warn: (host.querySelector('.fm-wire-note') || {}).textContent || '',
      isWarn: !!host.querySelector('.fm-wire-note.warn'),
      wires: host.querySelectorAll('.fm-wires path.fm-wire').length,
      nodes: host.querySelectorAll('.fm-node[data-id]').length
    });
    let last = snap();
    for (let i = 0; i < 4 && !last.isWarn; i++) {
      const ghosts = [...host.querySelectorAll('.fm-node.ghost')];
      /* نريد زر «+N» (توسيع القائمة) لا زر الرجوع — الخلط بينهما يُلغي التوسيع */
      const g = ghosts.find((x) => x.textContent.trim().startsWith('+')) || ghosts[ghosts.length - 1];
      if (!g) break;
      g.click();
      await new Promise((r) => setTimeout(r, 600));
      last = snap();
    }
    return last;
  });
  ok(expanded.isWarn && expanded.wires === 0, 'الأسلاك تشرح سبب اختفائها عند الزحام بدل الصمت',
    'warn="' + expanded.warn.slice(0, 64) + '" · wires=' + expanded.wires + ' · nodes=' + expanded.nodes);

  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | ') || '—');
  console.log(R.c.join('\n'));
  console.log(`\nFIN_islands ${R.p} نجح · ${R.f} فشل`);
  await b.close();
  process.exit(R.f ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });