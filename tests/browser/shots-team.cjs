/**
 * يلتقط الفريق المتوازي أثناء عمله فعلاً (بطاقات حيّة + أثر الأدوات)،
 * ثم المراقبة الصارمة بحكمها بعد انتهاء التشغيل.
 */
const path = require('path');
const { chromium } = require('playwright-core');
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const SHOTS = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);

  await p.locator('#ai-open-btn').click();
  await p.waitForTimeout(1000);
  await p.locator('#chat-input').fill('اعملوا كفريق: اعرضوا ملاحظاتي وعددها ثم اختبروا صحتها');
  await p.locator('#send-chat-btn').click();

  // أثناء العمل: انتظر حتى تظهر بطاقات بأثر أدوات فعلي
  let shotMid = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    const chips = await p.locator('#team-live .tchip').count();
    const cards = await p.locator('#team-live .tcard').count();
    if (!shotMid && chips >= 3 && cards >= 2) {
      await p.screenshot({ path: path.join(SHOTS, '09-team-live.png') });
      shotMid = true;
      console.log(`صورة أثناء العمل: ${cards} بطاقة · ${chips} أثر`);
    }
    const s = await p.locator('#team-summary').innerText().catch(() => '');
    if (/النتيجة/.test(s)) break;
  }

  const summary = await p.locator('#team-summary').innerText().catch(() => '');
  console.log('الملخص:', summary.replace(/\n/g, ' ').slice(0, 140));
  await p.screenshot({ path: path.join(SHOTS, '10-team-done.png') });

  await p.locator('#rail .rail-btn[data-view="monitor"]').click();
  await p.waitForTimeout(3200);
  const verdict = await p.locator('#mon-verdict').innerText();
  const reasons = await p.locator('#mon-reasons').innerText();
  console.log('الحكم:', verdict, '|', reasons.slice(0, 90));
  await p.screenshot({ path: path.join(SHOTS, '11-monitor-verdict.png') });

  await b.close();
  console.log('✅ صور الفريق والمراقبة جاهزة');
})();
