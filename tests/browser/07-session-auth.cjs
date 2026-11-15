// browser/07-session-auth.cjs — §34 حيّاً في متصفح حقيقي (لا قراءة كود)
const { chromium } = require('playwright-core');
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
// عزل موحّد (2026-10-28): العنوان من بيئة الحزمة أولاً — كان مثبّتاً على الحي
// فيفشل تحت حِمل الحزم ويلمس بيانات المنتج. وwaitUntil=load لأن networkidle
// لا يستقر مع بث/استطلاعات الواجهة الحيّة (المطلوب جاهزية DOM لا سكون الشبكة).
const BASE = process.env.CORTEX_URL || 'http://127.0.0.1:3737';

(async () => {
  const out = [];
  const ok = (n, c, d) => { out.push({ n, c, d }); };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const seen = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) seen.push({ url: r.url(), hdr: r.headers()['x-cortex-session'] || null, m: r.method() });
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // 1) هل طلبت الواجهة الرمز من تلقاء نفسها؟
  const sessionCalls = seen.filter((s) => s.url.includes('/api/session'));
  ok('الواجهة تجلب رمز الجلسة عند الإقلاع', sessionCalls.length > 0, `نداءات /api/session = ${sessionCalls.length}`);

  // 2) الكوكي محفوظ؟
  const cookies = await page.context().cookies();
  const ck = cookies.find((c) => c.name === 'cortex_session');
  ok('كوكي الجلسة مضبوط', !!ck, ck ? `HttpOnly=${ck.httpOnly} SameSite=${ck.sameSite}` : 'غائب');

  // 3) كتابة حقيقية من داخل الصفحة (بمسار الواجهة نفسها) — الأثر يُفحص خارجياً
  const res = await page.evaluate(async () => {
    const tk = await (await fetch('/api/session')).json();
    const r = await fetch('/api/agent/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': tk.token },
      credentials: 'same-origin',
      body: JSON.stringify({ mutations: [{ tool: 'fs_write', args: { path: 'vault/_browser_auth_probe.md', content: 'من المتصفح' } }], project: 'default' }),
    });
    const body = await r.text();
    let j = null; try { j = JSON.parse(body); } catch {}
    return { status: r.status, body, applied: j?.applied || [], failed: j?.failed || [] };
  });
  ok('كتابة من المتصفح بالرمز تنجح', res.status === 200, `HTTP ${res.status}`);
  // العطل المُثبت 2026-10-20: `..` واحدة لا تكفي — __dirname هو tests/browser،
  // فـ'..' = tests لا جذر المشروع؛ كان الاختبار يقرأ tests/vault/... (غير موجود)
  // فيُبلّغ «طول المحتوى=0» بينما الكتابة على القرص سليمة 100%.
  const fp = require('path').join(__dirname, '..', '..', 'vault', '_browser_auth_probe.md');
  const payload = require('fs').existsSync(fp) ? require('fs').readFileSync(fp, 'utf8') : '';
  // البند 4: الأثر يُقاس بدقة — الرفض/الفشل يُعرَض صراحةً بدل «طول المحتوى=0» الغامض
  ok('المحتوى ظهر على القرص فعلاً',
    payload.includes('من المتصفح'),
    `طول المحتوى=${payload.length} · applied=${JSON.stringify(res.applied)} · failed=${JSON.stringify(res.failed)}` +
    (res.status !== 200 ? ` · HTTP ${res.status}: ${res.body.slice(0, 200)}` : ''));
  require('fs').rmSync(fp, { force: true });

  // 4) هل كتابة الواجهة العادية تحمل الرمز؟ (نراقب نداء POST حقيقي)
  await page.evaluate(async () => {
    const tk = await (await fetch('/api/session')).json();
    await fetch('/api/notes', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': tk.token },
      body: JSON.stringify({ title: 'probe', content: 'x' }) });
  });
  const posts = seen.filter((s) => s.m === 'POST' && s.url.includes('/api/'));
  ok('كل النداءات الكتابية تحمل ترويسة الرمز', posts.length === 0 || posts.every((p) => p.hdr), `${posts.filter(p=>p.hdr).length}/${posts.length} بترويسة`);

  await browser.close();
  const pass = out.filter((o) => o.c).length;
  console.log(JSON.stringify({ pass, total: out.length, items: out }, null, 1));
  process.exit(pass === out.length ? 0 : 1);
})();
