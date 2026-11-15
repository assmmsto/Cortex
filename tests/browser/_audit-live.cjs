'use strict';
/**
 * جولة تدقيق حيّة (2026-10-20) — تقيس أعطالاً مؤكدة بأدلة متصفح حقيقية.
 * لا قراءة كود: كل حكم من سلوك فعلي (console / DOM / قياس مستطيل).
 */
const path = require('path');
const { chromium } = require('playwright-core');
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();

const out = {
  consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [],
  bugs: [], uiElements: []
};
const rec = (name, ok, detail) => {
  out.uiElements.push({ name, ok, detail });
  if (!ok) out.bugs.push({ name, detail });
};

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });

  p.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === 'error') out.consoleErrors.push(txt);
    else if (t === 'warning') out.consoleWarnings.push(txt);
  });
  p.on('pageerror', (e) => out.pageErrors.push(String(e.message)));
  p.on('response', (r) => { if (r.status() >= 400) out.failedRequests.push(r.status() + ' ' + r.url().replace(B, '')); });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2800);

  /* ── 0) هل الصفحة رسمت؟ ── */
  const appH = await p.evaluate(() => Math.round(document.getElementById('app').getBoundingClientRect().height));
  rec('app rendered', appH > 400, appH + 'px');

  /* ── 1) العطل القديم: .side-block يبتلع الارتفاع ⇒ #library-list ارتفاع 0 ── */
  const lib = await p.evaluate(() => {
    const el = document.getElementById('library-list');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { h: Math.round(r.height), w: Math.round(r.width), display: cs.display, overflow: cs.overflowY, count: el.querySelectorAll('.tree-i').length };
  });
  rec('#library-list non-zero height', !!lib && lib.h > 60, lib ? `${lib.h}px · ${lib.count} عناصر · display=${lib.display}` : 'MISSING');

  /* العطل الأصلي: الشريط الجانبي كله لا يخرج تحت الحد */
  const side = await p.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('.side-block'));
    const vh = window.innerHeight;
    const below = blocks.filter((x) => x.getBoundingClientRect().bottom > vh + 1).length;
    return { blocks: blocks.length, belowViewport: below, heights: blocks.map((x) => Math.round(x.getBoundingClientRect().height)) };
  });
  rec('.side-block layout not overflowing viewport', side.belowViewport === 0, JSON.stringify(side));

  /* ── 2) العطل القديم: الإدخال غير ملتصق بالأسفل ── */
  const dock = await p.evaluate(() => {
    const input = document.getElementById('chat-input');
    const bar = document.getElementById('status-badge');
    if (!input) return null;
    const ri = input.getBoundingClientRect();
    const vh = window.innerHeight;
    return { inputBottom: Math.round(ri.bottom), vh, gap: Math.round(vh - ri.bottom), height: Math.round(ri.height) };
  });
  if (dock) rec('chat-input docked to bottom', dock.gap >= 0 && dock.gap < 90, JSON.stringify(dock));

  /* ── 3) العطل القديم: #next-action-bar بلا زر ── */
  const na = await p.evaluate(() => {
    const bar = document.getElementById('next-action-bar');
    const btn = document.getElementById('next-action-btn');
    if (!bar || !btn) return { bar: !!bar, btn: !!btn };
    const rb = btn.getBoundingClientRect();
    return { bar: true, btn: true, btnW: Math.round(rb.width), btnH: Math.round(rb.height), label: (document.getElementById('next-action-text') || {}).textContent || '' };
  });
  rec('#next-action-bar has a button', na.btn && na.btnW > 20 && na.btnH > 10, JSON.stringify(na));

  /* ── 4) العطل القديم: .imp-mark شريحة الأهمية ── */
  const imp = await p.evaluate(() => {
    const marks = Array.from(document.querySelectorAll('.imp-mark'));
    if (!marks.length) return { count: 0 };
    const first = marks[0];
    const r = first.getBoundingClientRect();
    const cs = getComputedStyle(first);
    return { count: marks.length, w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, display: cs.display };
  });
  rec('.imp-mark rendered with size', imp.count > 0 && imp.w > 2 && imp.h > 2, JSON.stringify(imp));

  /* ── 5) ctx-state / ctx-state-count / agent-session (معرّفات مشكوك بها) ── */
  const ctx = await p.evaluate(() => ({
    ctxState: !!document.getElementById('ctx-state'),
    ctxStateCount: !!document.getElementById('ctx-state-count'),
    ctxStateCountText: (document.getElementById('ctx-state-count') || {}).textContent || null,
    agentSession: !!document.getElementById('agent-session'),
    agentSessionClass: (document.getElementById('agent-session') || {}).className || null
  }));
  rec('ctx-state ids present in DOM', ctx.ctxState && ctx.ctxStateCount, JSON.stringify(ctx));

  /* ── 6) Ctrl+K يفتح اللوحة (⌘K على غير mac) ── */
  let ctrlK = false, ctrlKDetail = '';
  try {
    await p.keyboard.press('Control+KeyK');
    await p.waitForTimeout(500);
    ctrlK = await p.evaluate(() => {
      const el = document.getElementById('palette');
      return !!el && !el.classList.contains('hidden');
    });
    ctrlKDetail = 'palette visible=' + ctrlK;
  } catch (e) { ctrlKDetail = 'ERR ' + e.message; }
  rec('Ctrl+K opens command palette', ctrlK, ctrlKDetail);
  // typing filters
  if (ctrlK) {
    await p.locator('#palette-input').fill('Atlas');
    await p.waitForTimeout(900);
    const pr = await p.locator('#palette-results > *').count();
    rec('palette filters on input', pr > 0, pr + ' نتائج');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const closed = await p.evaluate(() => document.getElementById('palette').classList.contains('hidden'));
    rec('Escape closes palette', closed, 'hidden=' + closed);
  }

  /* ── 7) loadContext — الميزات الأربع (المهام/مرتبطات/روابط عكسية/السجل) ── */
  const r = await p.evaluate(() => {
    const el = document.querySelector('#library-list .tree-i');
    return el ? (el.dataset.id || el.getAttribute('data-id')) : '';
  });
  if (r) {
    await p.locator('#library-list .tree-i').first().click();
    await p.waitForTimeout(2600);
    const docOpen = await p.locator('#doc').isVisible();
    rec('document opens on click', docOpen, 'noteId=' + r);

    const ctxBtns = ['ctx-tasks-toggle', 'ctx-related-toggle', 'ctx-backlinks-toggle', 'ctx-history-toggle', 'ctx-confidence-toggle'];
    for (const id of ctxBtns) {
      const info = await p.evaluate((bid) => {
        const b = document.getElementById(bid);
        if (!b) return { exists: false };
        const cnt = b.querySelector('b');
        const rect = b.getBoundingClientRect();
        return { exists: true, label: b.textContent.trim(), count: cnt ? cnt.textContent : null, w: Math.round(rect.width), h: Math.round(rect.height) };
      }, id);
      rec('ctx button ' + id, info.exists && info.w > 20 && info.h > 10, JSON.stringify(info));
    }

    // اضغط أول زر سياقي وتحقق أن اللوحة تُملأ فعلاً (loadContext يعمل)
    const firstToggle = 'ctx-tasks-toggle';
    await p.locator('#' + firstToggle).click();
    await p.waitForTimeout(1800);
    const panel = await p.evaluate(() => {
      const wrap = document.getElementById('ctx-panels');
      const col = document.getElementById('ctx-tasks');
      const state = document.getElementById('ctx-state');
      const stateCount = document.getElementById('ctx-state-count');
      return {
        panelsHidden: wrap ? wrap.classList.contains('hidden') : null,
        tasksHtmlLen: col ? col.innerHTML.trim().length : null,
        tasksChildren: col ? col.children.length : null,
        stateText: stateCount ? stateCount.textContent : null,
        stateVisible: state ? state.getBoundingClientRect().height > 0 : null
      };
    });
    rec('loadContext fills ctx panels', panel.panelsHidden === false && panel.tasksChildren > 0, JSON.stringify(panel));
  } else {
    out.bugs.push({ name: 'no note opened', detail: 'library list empty' });
  }

  /* ── 8) agent-session يتحدث عند فتح الوكيل ── */
  try {
    await p.locator('#ai-open-btn').click();
    await p.waitForTimeout(1200);
    const aiOpen = await p.evaluate(() => {
      const panel = document.getElementById('ai-panel');
      const sess = document.getElementById('agent-session');
      return { open: panel && !panel.classList.contains('hidden'), sessionClass: sess ? sess.className : null, sessionText: sess ? sess.textContent : null };
    });
    rec('AI panel opens', aiOpen.open, JSON.stringify(aiOpen));
  } catch (e) { rec('AI panel opens', false, 'ERR ' + e.message); }

  await p.screenshot({ path: path.join(__dirname, 'shots', 'audit-live.png'), fullPage: false }).catch(() => {});
  await b.close();

  out.summary = {
    uiTested: out.uiElements.length,
    uiBroken: out.uiElements.filter((x) => !x.ok).length,
    consoleErrors: out.consoleErrors.length,
    pageErrors: out.pageErrors.length
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
