const path = require('path');
const { chromium } = require('playwright-core');
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2800);

  const shot = (n) => p.screenshot({ path: path.join(SHOTS, n) });

  // ① المعرفة — مع عنصر مفتوح
  await p.locator('#library-list .tree-i').first().click();
  await p.waitForTimeout(2500);
  await shot('01-knowledge.png');

  // ② الخريطة
  await p.locator('#rail .rail-btn[data-view="graph"]').click();
  await p.waitForTimeout(4200);
  await shot('02-graph.png');

  // ③ سطح الوكيل الواحد (لوحة ✦ + تبويب الخلفية)
  await p.locator('#ai-open-btn').click();
  await p.waitForTimeout(1200);
  await p.locator('#ai-panel .atab[data-atab="bg"]').click();
  await p.waitForTimeout(1200);
  await shot('03-agent-panel.png');

  // ④ المراقبة
  await p.locator('#rail .rail-btn[data-view="monitor"]').click();
  await p.waitForTimeout(2600);
  await shot('04-monitor.png');

  // ⑤ المستودعات (بعد فهرسة الجذر)
  await p.locator('#rail .rail-btn[data-view="repos"]').click();
  await p.waitForTimeout(1600);
  await p.locator('#repo-path').fill('.');
  await p.locator('#repo-index').click();
  await p.waitForTimeout(16000);
  await shot('05-repos.png');

  // ⑥ المزودون
  await p.locator('#rail .rail-btn[data-view="providers"]').click();
  await p.waitForTimeout(1800);
  await shot('06-providers.png');

  // ⑦ الاستيراد
  await p.locator('#rail .rail-btn[data-view="import"]').click();
  await p.waitForTimeout(1800);
  await shot('07-import.png');

  // ⑧ الأدوات
  await p.locator('#rail .rail-btn[data-view="tools"]').click();
  await p.waitForTimeout(2200);
  await shot('08-tools.png');

  console.log('✅ 8 صور في tests/browser/shots');
  await b.close();
})();
