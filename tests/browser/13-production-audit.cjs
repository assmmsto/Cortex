'use strict';
/**
 * الثالث عشر: تدقيق إنتاجي شامل — الأحجام والتكبير والوظائف والأخطاء.
 *
 * الغرض: بوابة تمنع «يعمل عندي» — تقيس ما يراه المستخدم فعلاً على أحجام شاشة
 * حقيقية ومستويات تكبير حقيقية، شاشة شاشة، وتفشل عند أي خطأ JS أو رد فاشل أو
 * فيض أفقي أو نموذج إعدادات ناقص.
 *
 * عطل مُثبت كشفه هذا التدقيق (2026-11-08): استخدام `esc` (مُعرَّفة داخل نطاق
 * المزوّدين فقط) في نطاق الإعدادات ⇒ «esc is not defined» يقطع fillSettings،
 * فيبقى نصف نموذج الإعدادات فارغاً بلا أي رسالة. القياس هنا يمنع تكراره.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const BASE = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };

const VIEWS = ['notes', 'graph', 'monitor', 'repos', 'providers', 'import', 'tools', 'governance'];

/** قياس الفيض وحالة الصفحة — نفس المقياس في كل قسم */
const probe = (p) => p.evaluate(() => {
  const de = document.documentElement;
  const out = [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && (r.right > de.clientWidth + 2 || r.left < -2);
  }).slice(0, 4).map((e) => e.tagName + '.' + String(e.className).slice(0, 24));
  return { overflowX: de.scrollWidth > de.clientWidth + 1, zoom: getComputedStyle(de).zoom, offscreen: out };
});

const attach = (p) => {
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 90)); });
  p.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(BASE, '')); });
  return errs;
};

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  R.c.push('══════ تدقيق إنتاجي: أحجام · تكبير · وظائف · أخطاء ══════');

  try {
    // ── 1) العرض: لا فيض أفقي من الهاتف إلى الشاشة الكبيرة ──────────────
    const widthResults = [];
    for (const w of [360, 768, 1024, 1440, 1920]) {
      const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
      const p = await ctx.newPage();
      const errs = attach(p);
      await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
      await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(700);
      const r = await probe(p);
      widthResults.push({ w, ...r, errs: errs.length });
      await ctx.close();
    }
    ok(widthResults.every((r) => !r.overflowX), 'لا فيض أفقي على أي عرض (٣٦٠–١٩٢٠)', widthResults.map((r) => r.w + (r.overflowX ? '✖' : '✔')).join(' '));
    ok(widthResults.every((r) => r.errs === 0), 'لا أخطاء JS عند أي عرض', widthResults.map((r) => r.w + ':' + r.errs).join(' '));

    // ── 2) التكبير الحقيقي (deviceScaleFactor) ─────────────────────────
    const dsfResults = [];
    for (const dsf of [0.5, 1, 2]) {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dsf });
      const p = await ctx.newPage();
      const errs = attach(p);
      await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
      await p.waitForTimeout(2000);
      const r = await probe(p);
      dsfResults.push({ dsf, ...r, errs: errs.length });
      await ctx.close();
    }
    ok(dsfResults.every((r) => !r.overflowX && r.errs === 0), 'التكبير ٠٫٥×/١×/٢× سليم بلا فيض ولا أخطاء', dsfResults.map((r) => r.dsf + (r.overflowX ? '✖' : '✔')).join(' '));

    // ── 3) أحجام الخط S/M/L/XL: تتدرّج فعلاً بلا فيض ───────────────────
    const ctx3 = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p3 = await ctx3.newPage();
    const errs3 = attach(p3);
    await p3.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
    await p3.waitForTimeout(2200);
    await p3.click('#settings-btn');
    await p3.waitForTimeout(600);
    const fzSeen = [];
    for (const fz of ['s', 'm', 'l', 'xl']) {
      await p3.click(`[data-ui-fz="${fz}"]`);
      await p3.waitForTimeout(420);
      const z = await p3.evaluate(() => Number(getComputedStyle(document.documentElement).zoom) || 1);
      const h = await p3.evaluate(() => {
        const el = document.querySelector('#view-notes .view-title');
        return el ? el.getBoundingClientRect().height : 0;
      });
      const r = await probe(p3);
      fzSeen.push({ fz, z, h, overflow: r.overflowX });
    }
    ok(fzSeen.every((x, i) => i === 0 || x.h > fzSeen[i - 1].h), 'أحجام الخط تكبر فعلاً (ارتفاع فعلي)', fzSeen.map((x) => x.fz + '=' + Math.round(x.h) + 'px').join(' '));
    ok(fzSeen.every((x) => !x.overflow), 'لا فيض أفقي عند أي حجم خط', fzSeen.map((x) => x.fz + (x.overflow ? '✖' : '✔')).join(' '));

    /* ── 3ب) خيوط الخريطة تلامس أهدافها فعلاً ─────────────────────────────
       عطل مُقاس (2026-11-11): إحداثيات الخيوط كانت تُشتق من getBoundingClientRect
       (بكسل مرئي مضخَّم بـzoom) وتُكتب كوحدة SVG (بكسل CSS بلا viewBox) ⇒ كل خيط
       ينزاح (zoom−1)×المسافة: 101px عند XL و66px عند S، فتظهر الخيوط مشوَّهة.
       القياس هنا يحوّل وحدة SVG إلى الشاشة بـgetScreenCTM ويلامس الهندسة الحقيقية. */
    const wireError = async () => {
      await p3.click('[data-view="graph"]').catch(() => {});
      await p3.waitForTimeout(2400);
      return p3.evaluate(() => {
        const svg = document.querySelector('.fm-wires');
        const hub = document.querySelector('.fm-hub');
        if (!svg || !hub) return { wires: 0, hubErr: -1, nodeErr: -1 };
        const hr = hub.getBoundingClientRect();
        const rects = [...document.querySelectorAll('.fm-node[data-id]')].map((e) => e.getBoundingClientRect());
        const wires = [...document.querySelectorAll('.fm-wires path.fm-wire')];
        const at = (w, start) => {
          const pt = w.getPointAtLength(start ? 0 : w.getTotalLength());
          const d = new DOMPoint(Number(pt.x), Number(pt.y)).matrixTransform(w.getScreenCTM());
          return d;
        };
        const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
        let hubErr = 0; let nodeErr = 0;
        for (const w of wires) {
          const isIn = w.dataset.dir === 'in';
          const h = at(w, !isIn); const n = at(w, isIn);
          hubErr = Math.max(hubErr, Math.abs(h.x - (isIn ? hr.right : hr.left)));
          nodeErr = Math.max(nodeErr, Math.min(...rects.map((r) => distToRect(n.x, n.y, r))));
        }
        return { wires: wires.length, hubErr: Math.round(hubErr), nodeErr: Math.round(nodeErr) };
      });
    };
    await p3.click('#close-settings-btn').catch(() => {});
    await p3.waitForTimeout(500);
    const wXl = await wireError();                     // آخر حجم مُطبَّق = xl
    await p3.click('#settings-btn'); await p3.waitForTimeout(400);
    await p3.click('[data-ui-fz="m"]'); await p3.waitForTimeout(400);
    await p3.click('#close-settings-btn').catch(() => {});
    await p3.waitForTimeout(500);
    const wM = await wireError();
    ok(wM.wires > 0 && wM.hubErr <= 2 && wM.nodeErr <= 2, 'خيوط الخريطة تلامس أهدافها عند الحجم M', `خيوط=${wM.wires} · مركز=${wM.hubErr}px · عنصر=${wM.nodeErr}px`);
    ok(wXl.wires > 0 && wXl.hubErr <= 2 && wXl.nodeErr <= 2, 'خيوط الخريطة تلامس أهدافها عند XL (كانت تنزاح ~101px)', `خيوط=${wXl.wires} · مركز=${wXl.hubErr}px · عنصر=${wXl.nodeErr}px`);

    // ── 4) كل شاشة: تفتح بلا خطأ ولا رد فاشل ───────────────────────────
    let viewErrs = 0;
    const perView = [];
    for (const v of VIEWS) {
      const before = errs3.length;
      await p3.click(`[data-view="${v}"]`).catch(() => {});
      await p3.waitForTimeout(1100);
      const r = await probe(p3);
      const added = errs3.length - before;
      viewErrs += added;
      perView.push({ v, added, overflow: r.overflowX });
    }
    ok(perView.every((x) => x.added === 0), 'الشاشات الثماني بلا أي خطأ JS/رد فاشل', perView.map((x) => x.v + ':' + x.added).join(' '));
    ok(perView.every((x) => !x.overflow), 'لا فيض أفقي في أي شاشة', perView.filter((x) => x.overflow).map((x) => x.v).join(',') || 'نظيف');

    // ── 5) المزودون في مكان واحد ──────────────────────────────────────
    const home = await p3.evaluate(() => {
      const leftovers = ['provider-select', 'base-url-input', 'openai-url-input', 'api-key-input', 'model-input', 'fetch-models-btn']
        .filter((i) => document.getElementById(i));
      return {
        leftovers,
        goto: !!document.getElementById('goto-providers-btn'),
        cards: document.querySelectorAll('#view-providers .pcard').length,
        chips: document.querySelectorAll('#view-providers .mchip').length,
        hint: !!document.querySelector('[data-i18n="providers_single_home"]'),
      };
    });
    ok(home.leftovers.length === 0, 'لا حقول مزوّد في الإعدادات (مكان واحد)', home.leftovers.join(',') || 'نظيف');
    ok(home.goto && home.hint, 'زر الانتقال + بيان المكان الواحد موجودان');
    ok(home.cards > 0, 'بطاقات المزودين تُعرض', home.cards + ' بطاقة');
    ok(home.chips > 0, 'شرائح اختيار النموذج داخل البطاقة (لم يُفقد الاختيار)', home.chips + ' شريحة');

    // ── 6) نموذج الإعدادات يمتلئ فعلاً (لا ينقطع بنصف الطريق) ─────────
    await p3.click('#settings-btn');
    await p3.waitForTimeout(900);
    const form = await p3.evaluate(() => ({
      active: (document.getElementById('active-model-line') || {}).textContent || '',
      temp: (document.getElementById('temp-label') || {}).textContent || '',
      retrProvider: (document.getElementById('retrieval-provider-select') || {}).value || '',
      retrTopk: (document.getElementById('retrieval-topk-label') || {}).textContent || '',
      autonomy: (document.getElementById('autonomy-select') || {}).value || '',
      langMode: (document.getElementById('lang-mode-select') || {}).value || '',
    }));
    ok(form.active.trim().length > 0, 'سطر المزود/النموذج النشط ممتلئ', JSON.stringify(form.active));
    ok(/^\d+\.\d\d$/.test(form.temp), 'الحرارة معروضة', form.temp);
    ok(form.retrProvider.length > 0, 'حقول الاسترجاع امتلأت (لم ينقطع النموذج)', form.retrProvider);
    ok(form.autonomy.length > 0 && form.langMode.length > 0, 'حقول الوكيل امتلأت', form.autonomy + '/' + form.langMode);

    // ── 7) كل زر له اسم مفهوم ─────────────────────────────────────────
    const nameless = await p3.evaluate(() => {
      return [...document.querySelectorAll('button')].filter((b) => b.offsetParent)
        .filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
        .map((b) => b.id || b.className).slice(0, 6);
    });
    ok(nameless.length === 0, 'كل زر ظاهر له اسم مفهوم', nameless.join(',') || 'نظيف');

    await p3.click('#close-settings-btn').catch(() => {});
    await ctx3.close();

    ok(errs3.length === 0, 'صفر أخطاء في كل التدقيق', errs3.slice(0, 3).join(' | ') || '—');
  } finally {
    await b.close();
  }

  console.log(R.c.join('\n'));
  console.log(`\nFIN_prod ${R.p} نجح · ${R.f} فشل`);
  process.exit(R.f ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });