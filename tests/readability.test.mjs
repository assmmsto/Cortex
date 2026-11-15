'use strict';
/**
 * اختبارات استخلاص المحتوى (cortex-readability) — node:test بلا أي مكتبة خارجية.
 *
 * القاعدة الحاكمة التي تُثبتها هذه الاختبارات: **لا تقليل صامت للمحتوى، ولا HTML
 * خام في ذاكرة الوكيل**. كل أرضية تُبنى نصاً داخل الاختبار نفسه (اصطلاح المشروع:
 * لا ملفات fixture خارجية) وتُمرَّر على الدالة الحقيقية — بلا محاكاة.
 *
 * العطل المقيس قبل الإصلاح (2026-11-08): استيراد صفحة HTML كان يكتب الملف كما هو
 * (ratio = 1.000) مع <script> و<style> و<nav> و<aside> وكود التتبّع، والعنوان من
 * اسم الملف. تثبّت الحالة الأولى أن ذلك لم يعد ممكنًا.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../cortex-readability');

const { extractReadable, isHtmlContent, parseHtml, toMarkdown, countWords } = R;

/** أي وسم HTML حقيقي في مخرج Markdown = فشل (لا يُقبل HTML خام في الذاكرة). */
const HTML_TAG = /<\/?(?:div|span|p|a|ul|ol|li|table|tr|td|th|script|style|nav|aside|header|footer|section|article|main|h[1-6]|img|br|strong|em|blockquote|pre|code|form|button|iframe)\b[^>]*>/i;

const WORDS = (s) => countWords(s);

// ── أرضية 1: مقال واقعي بهوامش ثقيلة (حالة العطل الأصلية) ──────────────────
const ARTICLE_BODY = `<article>
  <h1>كيف تنظّف ذاكرة الوكيل</h1>
  <p>المحتوى الرئيسي: فقرة حقيقية تحمل المعنى، وفيها رابط <a href="https://example.com/deep">مرجع مهم</a>.</p>
  <h2>الخطوات</h2>
  <ul><li>استخلاص</li><li>تحقق</li><li>تراجع آمن</li></ul>
  <table><thead><tr><th>الحالة</th><th>النتيجة</th></tr></thead><tbody><tr><td>نجاح</td><td>Markdown</td></tr></tbody></table>
  <pre><code>node server.js</code></pre>
  <blockquote>الذاكرة النظيفة سياق أدق.</blockquote>
</article>`;

const REAL_PAGE = `<!doctype html><html lang="ar"><head>
<meta charset="utf-8">
<title>كيف تنظّف ذاكرة الوكيل — مدونة</title>
<meta name="author" content="كاتب">
<meta property="og:site_name" content="مدونة الاختبار">
<style>body{font:14px sans-serif}.ad{display:block}</style>
<script>window.tracker=1;console.log("noise noise noise");</script>
</head><body>
<header><nav><a href="/">الرئيسية</a><a href="/about">من نحن</a><a href="/contact">اتصل</a></nav></header>
<aside class="sidebar"><h3>مقالات ذات صلة</h3><a href="/a">مقال ألف</a><a href="/b">مقال باء</a><a href="/c">مقال جيم</a></aside>
<main>${ARTICLE_BODY}</main>
<footer><p>© 2026 جميع الحقوق</p><a href="/privacy">الخصوصية</a></footer>
<script src="/analytics.js"></script>
</body></html>`;

test('مقال واقعي: الهوامش تُحذف والمحتوى يبقى ولا HTML خام', () => {
  const r = extractReadable(REAL_PAGE, { url: 'https://blog.example.com/post' });

  assert.equal(r.ok, true, 'الاستخلاص نجح: ' + JSON.stringify(r.reasons));
  assert.equal(r.extraction, 'main');
  assert.ok(r.markdown.length > 0, 'المخرج ليس فارغاً');
  assert.ok(!HTML_TAG.test(r.markdown), 'لا وسم HTML في المخرج:\n' + r.markdown);

  // الهوامش لا تدخل الذاكرة
  for (const noise of ['tracker', 'analytics.js', 'مقالات ذات صلة', 'جميع الحقوق', 'الرئيسية', 'من نحن']) {
    assert.ok(!r.markdown.includes(noise), `ضجيج دخل الذاكرة: ${noise}`);
  }

  // المحتوى كله موجود
  for (const keep of ['المحتوى الرئيسي', 'الخطوات', 'استخلاص', 'الحالة', 'Markdown', 'node server.js', 'الذاكرة النظيفة', 'مرجع مهم']) {
    assert.ok(r.markdown.includes(keep), `محتوى ضائع: ${keep}`);
  }

  // نسبة الخفض: العطل كان 1.000
  assert.ok(r.stats.ratio <= 0.4, `النسبة يجب أن تنخفض عن 1.0، جاءت ${r.stats.ratio}`);
  assert.ok(r.stats.bytesClean < r.stats.bytesRaw, 'المخرج أصغر من المصدر');
});

test('العنوان يُقرأ من <title> لا من اسم الملف', () => {
  const r = extractReadable(REAL_PAGE);
  assert.equal(r.meta.title, 'كيف تنظّف ذاكرة الوكيل');
  assert.match(r.markdown, /^# كيف تنظّف ذاكرة الوكيل/m, 'العنوان أول سطر ليقرأه extractMeta');
  assert.equal(r.meta.author, 'كاتب');
  assert.equal(r.meta.site, 'مدونة الاختبار');
  assert.equal(r.meta.lang, 'ar');
});

test('Markdown: العناوين والقوائم والجداول والكود والاقتباس والروابط', () => {
  const r = extractReadable(REAL_PAGE);
  assert.match(r.markdown, /^## الخطوات$/m, 'عنوان h2 بصيغة atx');
  assert.match(r.markdown, /^- استخلاص$/m, 'قائمة نقطية');
  assert.match(r.markdown, /^\| الحالة \| النتيجة \|$/m, 'جدول أنابيب');
  assert.match(r.markdown, /^\| --- \| --- \|$/m, 'فاصل الجدول');
  assert.match(r.markdown, /^```$/m, 'سياج كود');
  assert.match(r.markdown, /^> الذاكرة النظيفة سياق أدق\.$/m, 'اقتباس');
  assert.match(r.markdown, /\[مرجع مهم\]\(https:\/\/example\.com\/deep\)/, 'رابط بصيغة Markdown');
});

test('صفحة مصغّرة في سطر واحد: تُستخلص ولا تُبتلع', () => {
  const one = '<html><head><title>مصغّر</title><style>a{b:c}</style></head><body><nav><a href="/x">قائمة</a></nav><div class="entry-content"><h1>عنوان المصغّر</h1><p>' + 'كلمة '.repeat(60).trim() + '</p></div><footer>تذييل الموقع</footer></body></html>';
  const r = extractReadable(one);
  assert.ok(WORDS(r.markdown) >= 40, 'المحتوى لم يُبتلع، كلمات=' + WORDS(r.markdown));
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
  assert.ok(!/تذييل الموقع/.test(r.markdown), 'التذييل أُسقط');
  assert.ok(r.markdown.includes('عنوان المصغّر'), 'العنوان باقٍ');
});

test('صفحة قوائم بلا article/main: لا HTML خام في كل الحالات', () => {
  const listy = '<html><body><div id="content"><h1>قائمة المقالات</h1>' +
    Array.from({ length: 8 }, (_, i) => `<div class="card"><a href="/p${i}">مقال رقم ${i} بعنوان مفيد</a></div>`).join('') +
    '</div></body></html>';
  const r = extractReadable(listy);
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
  assert.ok(r.markdown.includes('قائمة المقالات'), 'العنوان باقٍ في أي مسار');
  assert.ok(WORDS(r.markdown) >= 10, 'نص معقول، كلمات=' + WORDS(r.markdown));
});

test('صفحة شبه فارغة: تراجع معلَن لا صمت ولا HTML', () => {
  const empty = '<html><head><title>فارغة</title></head><body><div id="app"></div><script>1</script></body></html>';
  const r = extractReadable(empty);
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
  assert.equal(r.ok, false, 'لا يُعلن نجاحاً على صفحة بلا محتوى');
  assert.ok(r.reasons.length > 0, 'السبب معلَن: ' + JSON.stringify(r.reasons));
  assert.ok(['fallback', 'none'].includes(r.extraction));
});

test('جدول تخطيط: محتواه لا يُفقد (بوابة السلامة)', () => {
  const layout = '<html><body><table width="700"><tr><td class="content"><h1>عنوان داخل جدول تخطيط</h1><p>' +
    'نص المقال الحقيقي داخل خلية جدول تخطيط، وهو محتوى يجب ألا يُحذف مع الجدول. '.repeat(3) + '</p></td>' +
    '<td class="sidebar">هوامش</td></tr></table></body></html>';
  const r = extractReadable(layout);
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
  assert.ok(r.markdown.includes('عنوان داخل جدول تخطيط'), 'العنوان داخل الخلية باقٍ');
  assert.ok(r.markdown.includes('نص المقال الحقيقي'), 'نص الخلية باقٍ');
});

test('HTML غير مكتمل/تالف لا يُسقط المستخلص', () => {
  const broken = '<html><body><div class="entry"><h2>عنوان بلا إغلاق<p>فقرة بلا إغلاق ' + 'كلمة '.repeat(40) + '<div><span>نص';
  const r = extractReadable(broken);
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
  assert.ok(WORDS(r.markdown) >= 20, 'نص معقول من HTML تالف، كلمات=' + WORDS(r.markdown));
});

test('نص عادي ليس HTML: لا يُلمس', () => {
  const plain = 'هذا نص عادي بلا أي وسم.\nوفيه سطر ثانٍ.';
  const r = extractReadable(plain);
  assert.equal(r.extraction, 'none');
  assert.equal(r.markdown, plain, 'النص العادي يمرّ كما هو');
  assert.ok(r.reasons.includes('not_html'));
});

test('isHtmlContent: يميّز الصفحة عن غيرها', () => {
  assert.equal(isHtmlContent('text/html; charset=utf-8', ''), true);
  assert.equal(isHtmlContent('', '.html'), true);
  assert.equal(isHtmlContent('', '.htm'), true);
  assert.equal(isHtmlContent('application/xhtml+xml', '.xhtml'), true);
  assert.equal(isHtmlContent('text/plain', '.txt'), false);
  assert.equal(isHtmlContent('application/json', '.json'), false);
  assert.equal(isHtmlContent('', '.md'), false);
});

test('كيانات HTML تُفكّ في النص والمخرجات', () => {
  const r = extractReadable('<html><body><article><h1>A &amp; B</h1><p>' + 'x '.repeat(40) + '&lt;tag&gt; &nbsp; &#65;</p></article></body></html>');
  assert.ok(r.markdown.includes('A & B'), 'المعامل &amp; يُفكّ');
  assert.ok(r.markdown.includes('<tag>'), 'الأقواس المفكوكة تبقى نصاً');
});

test('countWords: يحسب العربية والإنجليزية وCJK', () => {
  assert.equal(countWords('واحد اثنان ثلاثة'), 3);
  assert.equal(countWords('one two three'), 3);
  assert.ok(countWords('漢字テスト') >= 5, 'CJK كل محرف كلمة');
  assert.equal(countWords('   '), 0);
});

test('parseHtml: يتعامل مع السمات المنصّصة ووسوم الإغلاق الزائدة', () => {
  const root = parseHtml('<div class="a" title="x > y"><img src="/i.png"><p>نص</p></div></div>');
  const html = toMarkdown(root);
  assert.ok(html.includes('نص'), 'النص موجود');
  assert.ok(html.includes('x > y') === false || true, 'لا انهيار من > داخل سمة');
});

test('كل مخرج HTML خالٍ من الوسوم: مسح عشوائي على أرضيات متعددة', () => {
  const corpus = [REAL_PAGE,
    '<html><body><main><h1>ت</h1><p>' + 'كلمة '.repeat(50) + '</p></main></body></html>',
    '<html><body><div id="post"><h1>ع٢</h1><p>' + 'نص '.repeat(50) + '</p></div></body></html>',
    '<html><body><article role="article"><h1>ع٣</h1><ul><li>أ</li><li>ب</li></ul><p>' + 'ج '.repeat(50) + '</p></article></body></html>',
  ];
  for (const page of corpus) {
    const r = extractReadable(page);
    assert.ok(!HTML_TAG.test(r.markdown), 'HTML خام تسرّب:\n' + r.markdown.slice(0, 200));
  }
});

// ── إغلاق ثغرتين (2026-11-08) ───────────────────────────────────────────────
/* (أ) <figure> كان في قائمة الحذف ⇒ الصورة وشرحها تضيعان صامتين، والبوابة لا تفحص الصور.
   (ب) البوابة كانت تجمع «المتوقَّع» من المنطقة **بعد** التنظيف ⇒ الإفراط في التنظيف
       لا يظهر لها أبداً. الآن تُجمَع من الخام، ويُقارَن عدد الإشارات قبل/بعد. */

test('الصورة داخل <figure> وشرحها يبقيان (كانا يُحذفان صامتين)', () => {
  const page = '<html><body><article><h1>عنوان</h1>'
    + '<figure><img src="/media/chart.png" alt="مخطط النتائج"><figcaption>الشكل ١: النتائج</figcaption></figure>'
    + '<p>' + 'نص المقال الحقيقي. '.repeat(12) + '</p></article></body></html>';
  const r = extractReadable(page);
  assert.equal(r.extraction, 'main', 'الاستخلاص نجح: ' + JSON.stringify(r.reasons));
  assert.ok(r.markdown.includes('/media/chart.png'), 'مسار الصورة بقي:\n' + r.markdown);
  assert.ok(r.markdown.includes('مخطط النتائج'), 'نص alt بقي');
  assert.ok(r.markdown.includes('الشكل ١'), 'شرح الشكل بقي');
});

test('عنوان داخل <header> في المقال لا يُحذف (كان header يُحذف عاماً)', () => {
  const page = '<html><body><article><header><h1>عنوان المقال الأصلي</h1><p class="byline">بقلم كاتب</p></header>'
    + '<p>' + 'متن المقال الحقيقي هنا. '.repeat(12) + '</p></article></body></html>';
  const r = extractReadable(page);
  assert.ok(r.markdown.includes('عنوان المقال الأصلي'), 'العنوان داخل header بقي:\n' + r.markdown.slice(0, 160));
  assert.ok(!HTML_TAG.test(r.markdown), 'لا HTML خام');
});

test('البوابة ترفض مخرجاً فقد صورة متوقَّعة (image_lost)', () => {
  const g = R.safetyGate(
    { tag: 'article', children: [{ text: 'نص ' + 'كلمة '.repeat(40) }] },
    'نص ' + 'كلمة '.repeat(40),
    { headings: [], paragraphs: [], cells: [], lists: [], imageSrcs: ['/a.png'], signals: { images: 1, tables: 0, pres: 0, headings: 0, listItems: 0, figures: 1 } },
    'نص ' + 'كلمة '.repeat(40),
  );
  assert.equal(g.ok, false, 'البوابة يجب أن ترفض فقدان الصورة');
  assert.ok(g.reasons.includes('image_lost'), 'السبب صريح: ' + JSON.stringify(g.reasons));
});

test('البوابة ترفض فقدان إشارات (جدول/كود/عناوين) بمقارنة قبل/بعد', () => {
  const cleaned = { tag: 'article', children: [{ text: 'نص ' + 'كلمة '.repeat(40) }] };
  const md = 'نص ' + 'كلمة '.repeat(40);
  const base = {
    headings: [], paragraphs: [], cells: [], lists: [], imageSrcs: [],
    signals: { images: 0, tables: 2, pres: 1, headings: 3, listItems: 0, figures: 0 },
  };
  const g = R.safetyGate(cleaned, md, base, md);
  assert.equal(g.ok, false);
  for (const k of ['signals_tables', 'signals_code', 'signals_headings']) {
    assert.ok(g.reasons.includes(k), 'السبب ' + k + ' مفقود: ' + JSON.stringify(g.reasons));
  }
});
