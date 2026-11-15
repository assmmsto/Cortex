'use strict';
/**
 * i18n live checker - Cortex UI language round-trip.
 * Switches via Settings -> Appearance (2026-10-25: the top-bar #lang-toggle was
 * removed by user decision; language lives in Settings only). Sweeps every view,
 * scans the whole DOM for Arabic codepoints (\u0600-\u06FF), classifies each hit
 * as either SERVER/USER data (titles, gaps, wire payloads - allowed to stay
 * Arabic) or a genuine UI i18n remnant (target: 0). Round-trips back to Arabic,
 * rescans, captures screenshots + a JSON report. Run: node tests/browser/_i18n_check.cjs
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const SHOTS = path.join(__dirname, 'shots');
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- classification ---------- */
const UI_PATH_HINTS = [
  '#retrieval-status', '#sb-notes', '#status-badge', '#status-health',
  '#graph-info', '#graph-legend', '#sp-project', '#mon-updated', '#gov-updated',
  '#ai-open-btn'
];
const UI_SERVER_TRIGGER_WORDS = ['الفهرس جاهز', 'index ready'];
// [marker, ar, en] of labels the app itself paints from live server data
const SERVER_PREFIXES = [
  ['seg-b[data-ui-lang="ar"]', 'العربية', 'Arabic'],
  ['#q-tasks', null, null]
];
/* server-sent Arabic content: governance evidence/details/labels, stage
   names, privacy notes, weaknesses, proposals, gate details, agent output */
const SERVER_HINTS = [
  'gov-stages', 'gov-gates', 'gov-privacy', 'gov-weaknesses', 'gov-proposals',
  'gov-connections', 'gov-quarantine', 'gov-rollback', 'gov-relations', 'gov-audit',
  'gov-usage', 'gov-eval', 'mcp-config', 'purl'
];

function isUI(item) {
  const p = item.path, h = (item.hits[0] || '');
  if (p.indexOf('#') < 0 && p.indexOf('.') < 0) return false;
  // explicit live-status chips the app paints itself
  for (const u of UI_PATH_HINTS) if (p.indexOf(u) >= 0) return true;
  if (p.indexOf('seg-b') >= 0 && h.indexOf('العربية') >= 0) return true;   // "العربية" seg label
  if (p.indexOf('ai-open-btn') >= 0) return true;
  if (p.indexOf('#provider-list') >= 0) return true;                        // provider cards (app-painted)
  if (p.indexOf('fmt-card') >= 0 || p.indexOf('import-formats') >= 0) return true;
  if (p.indexOf('mcp-servers') >= 0 && h.indexOf('أداة') >= 0) return true; // "N أداة · جاهز"
  if (p.indexOf('#ctx-') >= 0 && h.indexOf('text:') === 0) {
    // ctx panels: app-painted empty-states are UI; task/backlink titles are data
    const empties = ['لا مهام', 'لا عناصر مرتبطة', 'لا روابط عكسية', 'لا لقطات', 'لا علاقات', 'لا نتائج'];
    if (empties.some((e) => h.indexOf(e) >= 0)) return true;
    return false;
  }
  if (p.indexOf('#graph-info') >= 0) return true;
  if (p.indexOf('graph-legend') >= 0) return true;
  if (p.indexOf('sp-tasks') >= 0 || p.indexOf('sp-actions') >= 0 || p.indexOf('sp-gaps') >= 0) return false;
  if (p.indexOf('#sp-project') >= 0) return true;
  if (p.indexOf('q-tasks') >= 0 && h.indexOf('title:') === 0) return true;   // tooltip the app paints
  if (SERVER_HINTS.some((s) => p.indexOf(s) >= 0)) {
    // gov structure labels the app paints: badges/buttons are UI, details are data
    if (h.indexOf('gov-badge') >= 0 || false) return true;
    if (item.label) return true;                                            // carries data-i18n => app-painted
    // button-ish hits
    if (p.indexOf('button') >= 0) return true;
    return false;                                                           // names/details/evidence = server data
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));

  await page.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2600);

  async function scanArabic() {
    return page.evaluate(() => {
      const AR = /[\\u0600-\\u06FF]/;
      const skipSel = 'svg, script, style, noscript, template';
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          if (el.closest(skipSel)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let el;
      while ((el = walker.nextNode())) {
        let direct = '';
        el.childNodes.forEach((nd) => { if (nd.nodeType === 3) direct += nd.textContent; });
        const ph = el.getAttribute ? el.getAttribute('placeholder') : null;
        const title = el.getAttribute ? el.getAttribute('title') : null;
        const tag = el.tagName.toLowerCase();
        if ((tag === 'input' && el.type !== 'button' && el.type !== 'submit') || tag === 'textarea') direct = '';
        const hits = [];
        if (direct && AR.test(direct)) hits.push('text:' + direct.trim().slice(0, 50));
        if (ph && AR.test(ph)) hits.push('ph:' + ph.trim().slice(0, 50));
        if (title && AR.test(title)) hits.push('title:' + title.trim().slice(0, 50));
        if (tag === 'option' && AR.test(el.textContent || '') && !el.hasAttribute('data-i18n')) {
          hits.push('option:' + (el.textContent || '').trim().slice(0, 50));
        }
        if (hits.length) {
          const trail = [];
          let cur = el, d = 0;
          while (cur && cur.tagName && d < 4) {
            trail.unshift(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : (cur.className && typeof cur.className === 'string' && cur.className ? '.' + String(cur.className).split(' ')[0] : '')));
            cur = cur.parentElement; d++;
          }
          out.push({
            path: trail.join(' > '),
            badge: el.className && typeof el.className === 'string' && el.className.indexOf('gov-badge') >= 0 ? 1 : 0,
            label: el.getAttribute('data-i18n') || el.getAttribute('data-i18n-ph') || el.getAttribute('data-i18n-title') || '',
            hits: hits
          });
        }
      }
      return out;
    });
  }

  async function sweepViews() {
    const views = ['notes', 'graph', 'agents', 'monitor', 'repos', 'providers', 'import', 'tools', 'governance'];
    for (const v of views) {
      await page.locator('#rail .rail-btn[data-view="' + v + '"]').click().catch(() => {});
      await page.waitForTimeout(1700);
    }
    await page.locator('#rail .rail-btn[data-view="notes"]').click().catch(() => {});
    await page.waitForTimeout(700);
  }

  console.log('== 1) Arabic baseline ==');
  await sweepViews();
  const arScan = await scanArabic();
  console.log('arabic elements (ui=ar baseline):', arScan.length);

  console.log('== 2) switch to EN via Settings -> Appearance ==');
  await page.click('#settings-btn');
  await page.waitForTimeout(600);
  await page.click('[data-ui-lang="en"]');
  await page.waitForTimeout(1600);
  await page.click('#close-settings-btn');
  await page.waitForTimeout(600);
  const dirNow = await page.evaluate(() => ({ dir: document.documentElement.getAttribute('dir'), lang: document.documentElement.getAttribute('lang'), title: document.title }));
  console.log('after toggle:', JSON.stringify(dirNow));
  await sweepViews();
  await page.locator('#rail .rail-btn[data-view="governance"]').click();
  await page.waitForTimeout(2600);
  await page.locator('#gov-refresh').click().catch(() => {});
  await page.waitForTimeout(2200);
  await page.locator('#rail .rail-btn[data-view="monitor"]').click();
  await page.waitForTimeout(2200);
  await page.locator('#mon-refresh').click().catch(() => {});
  await page.waitForTimeout(1400);

  const enScanAll = await scanArabic();
  const enUI = enScanAll.filter(isUI);
  const enData = enScanAll.filter((x) => !isUI(x));
  await page.screenshot({ path: path.join(SHOTS, 'i18n-en.png'), fullPage: false });

  console.log('');
  console.log('== EN scan ==');
  console.log('arabic elements total (en mode):', enScanAll.length);
  console.log('  - server/user data (allowed):', enData.length);
  console.log('  - UI STRINGS (target 0):', enUI.length);
  enUI.slice(0, 40).forEach((x) => console.log('  * ' + x.path + (x.label ? ' [' + x.label + ']' : '') + ' => ' + x.hits.join(' | ')));
  if (enUI.length > 40) console.log('  ... +' + (enUI.length - 40) + ' more');

  console.log('');
  console.log('== 3) back to Arabic ==');
  await page.click('#settings-btn');
  await page.waitForTimeout(600);
  await page.click('[data-ui-lang="ar"]');
  await page.waitForTimeout(1600);
  await page.click('#close-settings-btn');
  await page.waitForTimeout(1000);
  const dirBack = await page.evaluate(() => ({ dir: document.documentElement.getAttribute('dir'), lang: document.documentElement.getAttribute('lang') }));
  console.log('after restore:', JSON.stringify(dirBack));
  await sweepViews();
  const arScan2 = await scanArabic();
  console.log('arabic elements (ui=ar restored):', arScan2.length);
  await page.locator('#rail .rail-btn[data-view="governance"]').click();
  await page.waitForTimeout(1800);
  await page.locator('#rail .rail-btn[data-view="notes"]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'i18n-ar.png'), fullPage: false });

  console.log('');
  console.log('== 4) console health ==');
  console.log('console.errors:', consoleErrors.length);
  consoleErrors.slice(0, 10).forEach((e) => console.log('  x', e.slice(0, 160)));
  console.log('pageerrors:', pageErrors.length);
  pageErrors.slice(0, 10).forEach((e) => console.log('  x', e.slice(0, 160)));

  const okDir = dirNow.dir === 'ltr' && dirBack.dir === 'rtl';
  const okAr = arScan2.length > 50;
  const okConsole = consoleErrors.length === 0 && pageErrors.length === 0;
  const okUI = enUI.length === 0;
  console.log('');
  console.log('== verdict ==');
  console.log('dir ltr/rtl round-trip:', okDir ? 'PASS' : 'FAIL');
  console.log('arabic restored:', okAr ? 'PASS' : 'FAIL', '(' + arScan2.length + ')');
  console.log('console clean:', okConsole ? 'PASS' : 'FAIL');
  const ARre = /[\u0600-\u06FF]/;
  const realAr = enUI.filter((x) => ARre.test(x.hits.join(' ')));
  console.log('EN UI hits (classifier):', enUI.length, '| REAL arabic among them:', realAr.length, '| server/user data:', enData.length);
  realAr.forEach((x) => console.log('  REAL-AR:', x.path, '=>', x.hits.join(' | ')));
  fs.writeFileSync(path.join(SHOTS, 'i18n-report.json'), JSON.stringify({
    totalEn: enScanAll.length, serverData: enData.length, uiRemnants: enUI.length,
    uiRemnantList: enUI, arBaseline: arScan.length, arRestored: arScan2.length,
    consoleErrors: consoleErrors, pageErrors: pageErrors, dirNow: dirNow, dirBack: dirBack
  }, null, 2));
  const okReal = realAr.length === 0;
  console.log('zero real arabic UI strings in EN:', okReal ? 'PASS' : 'FAIL');
  console.log('dir ltr/rtl round-trip:', okDir ? 'PASS' : 'FAIL');
  process.exit(okDir && okAr && okConsole && okReal ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
