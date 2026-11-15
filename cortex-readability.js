'use strict';
/**
 * cortex-readability — استخلاص المحتوى الرئيسي من صفحة HTML وتحويله إلى Markdown.
 *
 * الفكرة من مستودع **defuddle** (kepano/defuddle، رخصة MIT): «جرّد الصفحة إلى
 * Markdown نظيف ليقرأ الوكيل المقال لا الهوامش، ويستهلك رموزاً أقل». أعيدت
 * كتابتها هنا بالمكتبة القياسية **بلا أي اعتمادية** لأن Cortex لا يملك DOM ولا
 * يضيف حزماً (لا jsdom/linkedom/cheerio/turndown) — ولذلك بُني محلّل وسوم يدوي
 * وسلسلة Markdown يدوية، بدل cloneNode/DOM وTurndown.
 *
 * لماذا هذا الملف موجود (عطل مُقاس 2026-11-08):
 *   مسار استيراد الويب والملفات كان يكتب **HTML الخام كما هو** في متن الملاحظة
 *   (قياس: ratio = 1.000 أي 1137/1137 بايت، مع <script> و<style> و<nav> و<aside>
 *   وكود التتبّع، والعنوان من اسم الملف لا من <title>). فتتلوّث ذاكرة الوكيل
 *   وتنفجر تكلفة الرموز. هنا يُستخلص الجوهر ويُحوَّل إلى Markdown، بنسبة خفض
 *   مقاسة ≈ 0.2-0.4 بدل 1.0.
 *
 * قاعدة السلامة الحاكمة (شرط لا يُخالف): **لا تقليل صامت للمحتوى.**
 *   أي استخلاص ينجح شرط أن يثبت أنه لم يُسقط نصاً ظاهراً كان في المصدر
 *   (عنوان/فقرة/خلية جدول). إن فشل الشرط ⇒ تراجع إلى «تجريد الوسوم المحافظ»
 *   وهو نص كامل بلا وسوم — لا إلى HTML خام أبداً، ومع وسم extraction:'fallback'
 *   ليظهر السلوك للمستخدم ولا يبقى صامتاً.
 *
 * وحدة مستقلّة: لا تستدعي cortex-import (تجنّباً لدورة require)، ولا شبكة،
 * ولا تنفيذ أي شيء من الصفحة — معالجة نصّية بحتة.
 */

const MAX_HTML = 8 * 1024 * 1024;   // سقف معالجة: صفحة أكبر من هذا تُتجاوز للتراجع
const MIN_CONTENT_WORDS = 25;       // أقل من ذلك ⇒ لا محتوى موثوق ⇒ تراجع

// وسوم بلا إغلاق (لا تنتج عقدة ابن)
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// وسوم محتواها نصّي لا وسوم (يُقرأ حتى إغلاقها بلا تحليل وسوم داخلها)
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'xmp']);

// وسوم لا يُنتج محتواها نصاً ظاهراً (تُسقَط من الأساس ومن خط الأساس معاً)
const NON_RENDERED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'svg', 'canvas']);

// مدخلات المحتوى مرتّبة بالتفضيل — مستنسخة من ترتيب defuddle (ENTRY_POINT_ELEMENTS).
// الوزن = (الطول - الفهرس) * 40، أي أن أول محدد أقوى من كل الفروق الدقيقة في الترجيح.
const ENTRY_POINTS = [
  '#post', '.post-content', '.post-body', '.article-content', '#article-content',
  '.js-article-content', '.article_post', '.article-wrapper', '.entry-content',
  '.content-article', '.instapaper_body', '.post', '.markdown-body', 'article',
  '[role=article]', 'main', '[role=main]', '.article-body', '#content', 'body',
];

// إشارات «هذا ليس محتوى» على الرموز المفردة في class/id (مستنسخة من قائمة defuddle المختصرة)
const NEGATIVE_TOKENS = new Set([
  'ad', 'ads', 'advert', 'advertisement', 'banner', 'sponsor', 'sponsored', 'promo',
  'cookie', 'consent', 'gdpr', 'newsletter', 'subscribe', 'subscription', 'paywall',
  'share', 'sharing', 'social', 'comment', 'comments', 'disqus', 'reply', 'related',
  'recommend', 'recommended', 'recirc', 'sidebar', 'widget', 'breadcrumb', 'breadcrumbs',
  'pagination', 'pager', 'nav', 'navbar', 'navigation', 'menu', 'masthead', 'footer',
  'header', 'byline', 'meta', 'metadata', 'tags', 'taglist', 'toc', 'skip', 'modal',
  'popup', 'overlay', 'toolbar', 'drawer', 'offcanvas', 'search', 'searchbox',
  'author', 'date', 'rating', 'utility', 'login', 'signup', 'account',
]);

// إشارات «هذا محتوى» — تُعفي من الحذف بالتنقيط (isLikelyContent في defuddle)
const POSITIVE_TOKENS = new Set([
  'article', 'content', 'entry', 'post', 'story', 'main', 'body', 'text', 'prose',
  'markdown', 'read', 'page', 'chapter', 'lesson', 'docs', 'documentation',
]);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const KEEP_INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'code', 'span', 'sub', 'sup', 'mark', 'del', 's', 'strike', 'u', 'small', 'abbr', 'time', 'kbd', 'samp', 'var', 'q', 'cite', 'br', 'img', 'wbr']);
// حاويات بنيوية فقط يجوز التعميق عبرها — التعميق داخل <p> أو <ul> يقتل الأشقاء
// (عطل مُقاس 2026-11-08: مقال قصير تعمّق إلى فقرته الطويلة فضاع عنوانه وقائمته وجدوله).
const STRUCTURAL_TAGS = new Set(['div', 'section', 'article', 'main', 'td', 'li', 'blockquote', 'figure', 'dd', 'body']);


// ────────────────────────────── 1) كيانات HTML ──────────────────────────────

function unescapeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _; })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _; })
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…').replace(/&middot;/g, '·')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const escapeMd = (s) => String(s).replace(/([\\`*_[\]])/g, '\\$1');

// ────────────────────────────── 2) محلّل الوسوم ──────────────────────────────

function parseAttrs(raw) {
  const attrs = Object.create(null);
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(name in attrs)) attrs[name] = unescapeEntities(val);
  }
  return attrs;
}

/**
 * يبني شجرة عقد من HTML بلا DOM: {tag, attrs, children, parent} أو {text}.
 * المحلّل متسامح عمداً: HTML الواقع غير مكتمل، فلا نرفض مستنداً لوسم ناقص.
 */
function parseHtml(html) {
  const src = String(html).slice(0, MAX_HTML);
  const root = { tag: '#root', attrs: Object.create(null), children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (t) => { if (t) top().children.push({ text: unescapeEntities(t), parent: top() }); };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    // تعليق أو doctype أو تعليمة
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e === -1 ? n : e + 1; continue; }

    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(src.slice(lt, lt + 80));
    if (!m) { pushText('<'); i = lt + 1; continue; }

    // نهاية الوسم مع احترام علامات التنصيص داخل السمات
    let j = lt + m[0].length;
    let quote = 0;
    while (j < n) {
      const c = src[j];
      if (quote) { if (c === quote) quote = 0; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tagEnd = Math.min(j, n);
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(src.slice(lt, tagEnd));

    if (closing) {
      // إغلاق: نصعد لأقرب عقدة بنفس الوسم (يتجاهل الإغلاق الزائد)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      i = tagEnd + 1;
      continue;
    }

    const node = { tag, attrs: parseAttrs(src.slice(lt + m[0].length, tagEnd)), children: [], parent: top() };
    top().children.push(node);

    if (RAW_TEXT_TAGS.has(tag)) {
      // محتوى نصّي: نقرأ حتى الإغلاق بلا تحليل (script/style/title)
      const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
      const rest = src.slice(tagEnd + 1);
      const cm = closeRe.exec(rest);
      const inner = cm ? rest.slice(0, cm.index) : rest;
      if (inner) node.children.push({ text: inner, parent: node });
      i = cm ? tagEnd + 1 + cm.index + cm[0].length : n;
      continue;
    }

    if (!VOID_TAGS.has(tag) && !selfClosed) stack.push(node);
    i = tagEnd + 1;
  }
  return root;
}

// ────────────────────────────── 3) أدوات الشجرة ──────────────────────────────

function walk(node, fn) {
  for (const c of node.children || []) {
    if (c.tag) { fn(c); walk(c, fn); }
  }
}

function textOf(node, opts = {}) {
  const parts = [];
  const visit = (nd) => {
    for (const c of (nd.children || [])) {
      if (c.tag) {
        if (NON_RENDERED_TAGS.has(c.tag) && !opts.keepNonRendered) continue;
        visit(c);
      } else if (c.text) parts.push(c.text);
    }
  };
  visit(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  const t = String(text || '');
  if (!t.trim()) return 0;
  // اللغات بلا مسافات (CJK): كل محرف كلمة
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
  const latin = t.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  return latin + cjk;
}

const wordsOf = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

function countTag(node, tag) {
  let k = 0;
  walk(node, (c) => { if (c.tag === tag) k++; });
  return k;
}

function classIdTokens(node) {
  const raw = `${node.attrs?.class || ''} ${node.attrs?.id || ''}`;
  return raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchesHints(node, set) {
  return classIdTokens(node).some((t) => set.has(t));
}

/** هل العنصر مخفي بتوصيف HTML/CSS متاح بلا getComputedStyle؟ (defuddle: hidden.ts) */
function isHidden(node) {
  const a = node.attrs || {};
  if ('hidden' in a) return true;
  if (String(a['aria-hidden'] || '').toLowerCase() === 'true') return true;
  const style = String(a.style || '').toLowerCase().replace(/\s+/g, '');
  if (/(^|;)(display:none|visibility:hidden|opacity:0)(;|$)/.test(style)) return true;
  if (/(^|;)(display:none|visibility:hidden)(;|$)/.test(style)) return true;
  const toks = classIdTokens(node);
  if (toks.includes('hidden') || toks.includes('invisible') || toks.includes('d-none')) return true;
  return false;
}

const linkTextOf = (node) => (node.children || []).reduce((acc, c) => acc + (c.tag === 'a' ? textOf(c).length : 0), 0);

// ────────────────────────────── 4) الترجيح (defuddle scoring) ──────────────────────────────

/** scoreElement: كلمات + فقرات*10 + فواصل - صور/كلمات*3 + إشارات، ثم مضاعِف كثافة الروابط. */
function scoreElement(node) {
  const text = textOf(node);
  const words = countWords(text);
  if (!words) return 0;

  let score = words;
  score += countTag(node, 'p') * 10;
  score += (text.match(/[,،;؛]/g) || []).length;
  score -= (countTag(node, 'img') / Math.max(words, 1)) * 3;

  const style = String(node.attrs?.style || '') + ' ' + String(node.attrs?.align || '');
  if (/float\s*:\s*right|text-align\s*:\s*right/i.test(style)) score += 5;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i.test(text)) score += 10;
  if (/\b(by|written by|author|posted by)\b|بقلم|الكاتب/i.test(text)) score += 10;
  if (matchesHints(node, POSITIVE_TOKENS)) score += 15;
  if (/(^|\s)\[\d+\]/.test(text)) score += 10;          // مراجع الحواشي
  score -= countTag(node, 'table') * 5;

  // مضاعِف كثافة الروابط: نص الروابط لا يجوز أن يهيمن على العنصر
  const linkLen = collectLinks(node).reduce((a, l) => a + l.text.length, 0);
  score *= (1 - Math.min(linkLen / Math.max(text.length, 1), 0.5));
  return score;
}

/** scoreNonContentBlock: تنقيط سالب للهوامش؛ الحذف عند score < 0. */
function scoreNonContentBlock(node) {
  const text = textOf(node);
  const words = countWords(text);
  if (words < 3) return 0;

  let score = 0;
  score += (text.match(/[,،;؛]/g) || []).length;
  score -= matchesHints(node, NEGATIVE_TOKENS) ? 8 : 0;

  const links = countTag(node, 'a');
  const linkLen = collectLinks(node).reduce((a, l) => a + l.text.length, 0);
  if (links / Math.max(words, 1) > 0.5) score -= 15;
  if (links > 1 && words < 80 && linkLen / Math.max(text.length, 1) > 0.8) score -= 15;
  if (links > countTag(node, 'li') * 3 && links > 3) score -= 10;
  if (links > 0 && words < 80 && /(^|\s)(facebook|twitter|x\.com|instagram|linkedin|youtube|t\.me|whatsapp)\b/i.test(String(node.attrs?.href || '') + text)) score -= 15;
  if (/\bby\s+[A-Z]|بقلم/i.test(text) && words < 15) score -= 10;
  return score;
}

/** isLikelyContent: إعفاء يمنع حذف محتوى حقيقي يشبه الهوامش. */
function isLikelyContent(node) {
  const a = node.attrs || {};
  const role = String(a.role || '').toLowerCase();
  if (role === 'article' || role === 'main' || role === 'contentinfo') return true;
  if (matchesHints(node, POSITIVE_TOKENS)) return true;
  const inner = (node.children || []).map((c) => c.tag).filter(Boolean);
  if (inner.includes('pre') || inner.includes('table') || inner.includes('figure') || inner.includes('picture')) return true;
  const words = countWords(textOf(node));
  if (words > 100) return true;
  if (words > 50 && (countTag(node, 'p') + countTag(node, 'li')) > 1) return true;
  if (words > 30 && countTag(node, 'blockquote') > 0) return true;
  if (words >= 10 && /[.?!؟]/.test(textOf(node)) && collectLinks(node).length === 0) return true;
  return false;
}

function collectLinks(node) {
  const out = [];
  walk(node, (c) => {
    if (c.tag !== 'a') return;
    const text = textOf(c);
    const href = String(c.attrs?.href || '').trim();
    if (text && href && !/^javascript:/i.test(href)) out.push({ text, href, node: c });
  });
  return out;
}

// ────────────────────────────── 5) اختيار المحتوى ──────────────────────────────

function selectorMatch(node, sel) {
  if (sel === 'body') return node.tag === 'body';
  if (sel.startsWith('#')) return node.attrs?.id === sel.slice(1);
  if (sel.startsWith('.')) {
    const want = sel.slice(1);
    return String(node.attrs?.class || '')
      .split(/\s+/)
      .some((c) => c.toLowerCase() === want || c.toLowerCase().startsWith(want + '-') || c.toLowerCase().endsWith('-' + want));
  }
  const rm = /^\[role=([a-z]+)\]$/.exec(sel);
  if (rm) return String(node.attrs?.role || '').toLowerCase() === rm[1];
  return node.tag === sel;
}

/** findMainContent: ترتيب المحدد يتفوّق على الترجيح، ثم تعميق نحو أكثف حاوٍ بنيوي. */
function findMainContent(root) {
  const all = [];
  walk(root, (c) => all.push(c));

  let best = null;
  let bestScore = 0;
  ENTRY_POINTS.forEach((sel, index) => {
    for (const node of all) {
      if (!selectorMatch(node, sel)) continue;
      const words = countWords(textOf(node));
      if (words < MIN_CONTENT_WORDS) continue;
      const score = (ENTRY_POINTS.length - index) * 40 + scoreElement(node);
      if (score > bestScore) { bestScore = score; best = node; }
    }
  });

  if (!best) {
    // بديل: أعلى ترجيح بين الكتل (findContentByScoring)
    let scored = null;
    let scoredBest = 0;
    for (const node of all) {
      if (!['div', 'section', 'article', 'main', 'td'].includes(node.tag)) continue;
      if (countWords(textOf(node)) < MIN_CONTENT_WORDS) continue;
      const s = scoreElement(node);
      if (s > scoredBest) { scoredBest = s; scored = node; }
    }
    if (scored) return { region: scored, node: scored, strategy: 'scored-block' };
    const body = all.find((x) => x.tag === 'body');
    if (body && countWords(textOf(body)) >= MIN_CONTENT_WORDS) return { region: body, node: body, strategy: 'body' };
    return { region: null, node: null, strategy: 'none' };
  }

  /* `region` = نقطة الدخول كما هي، وهي **مرجع بوابة السلامة**: ما يجب أن يظهر في
     المخرج. أما `node` فيجوز أن يكون أعمق منها — لكن لا يجوز أن يُسقط شيئاً من
     محتوى المنطقة، وإلا كشفت البوابة الفرق وتراجعت (سلّم المحاولات أدناه). */
  const region = best;
  let node = best;
  for (let depth = 0; depth < 6; depth++) {
    const parentWords = countWords(textOf(node));
    let deeper = null;
    let deeperDensity = 0;
    for (const c of (node.children || [])) {
      // حاويات بنيوية فقط: النزول إلى <p>/<ul>/<table> يقتل الأشقاء
      if (!c.tag || !STRUCTURAL_TAGS.has(c.tag) || NON_RENDERED_TAGS.has(c.tag)) continue;
      const w = countWords(textOf(c));
      if (w < 50 || w < parentWords * 0.6) continue;
      const density = w / Math.max(1, countTag(c, 'div') + countTag(c, 'section') + countTag(c, 'p') + 1);
      if (density > deeperDensity) { deeperDensity = density; deeper = c; }
    }
    if (!deeper) break;
    node = deeper;
  }
  return { region, node, strategy: node === region ? 'entry-point' : 'entry-point-deep' };
}

// ────────────────────────────── 6) التنظيف ──────────────────────────────

const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button',
  'input', 'select', 'textarea', 'label', 'nav', 'aside', 'footer', 'dialog',
  'menu', 'video', 'audio', 'object', 'embed', 'map', 'area',
]);

/* وسوم تُفكّ (يُحتفظ بأبنائها) لا تُحذف: حذفها كان يُسقط **محتوى حقيقياً**
   (عطل مُقاس 2026-11-08: كل <figure><img><figcaption> كان يُحذف كاملاً ⇒ صورة
   المقال وشرحها يضيعان صامتين، والبوابة لا تفحص الصور). */
const UNWRAP_TAGS = new Set(['figure', 'figcaption']);

/** حذف العناصر غير المحتوى: حتمي بالوسوم والسمات، ثم بالتنقيط السالب مع الإعفاء. */
function cleanTree(selected) {
  const clone = JSON.parse(JSON.stringify(selected, (k, v) => (k === 'parent' ? undefined : v)));
  const prune = (parent) => {
    const kept = [];
    for (const c of (parent.children || [])) {
      if (!c.tag) {
        // نص أبيض بين الوسوم يُهمَل كي لا ينتج Markdown فارغاً
        if (String(c.text || '').trim()) kept.push(c);
        continue;
      }
      if (isHidden(c)) continue;
      /* <header> داخل المقال يحمل عنوانه غالباً؛ حذفه العام كان يُسقط العنوان.
         نُفكّه إن حمل عنواناً (h1-h4)، وإلا فهو ترويسة موقع ⇒ يُحذف. */
      if (c.tag === 'header') {
        const hasHeading = (c.children || []).some((x) => x.tag && HEADING_TAGS.has(x.tag))
          || (function anyH(nd) { return (nd.children || []).some((x) => (x.tag && HEADING_TAGS.has(x.tag)) || (x.tag && anyH(x))); })(c);
        if (!hasHeading) continue;
      } else if (DROP_TAGS.has(c.tag)) continue;

      const role = String(c.attrs?.role || '').toLowerCase();
      if (role === 'navigation' || role === 'complementary' || role === 'dialog' || role === 'banner') continue;
      // الحذف بالتنقيط — إلا إن كان العنصر محتوى بالأدلة (isLikelyContent)
      if (scoreNonContentBlock(c) < 0 && !isLikelyContent(c)) continue;
      prune(c);
      if (!textOf(c) && !hasMedia(c)) continue;

      if (UNWRAP_TAGS.has(c.tag)) { kept.push(...c.children); continue; }
      kept.push(c);
    }
    parent.children = kept;
  };
  prune(clone);
  return clone;
}

/** هل يحمل العنصر محتوى غير نصّي يستحق البقاء (صورة/أثر/فاصل)؟ */
function hasMedia(node) {
  let found = false;
  walk(node, (c) => { if (c.tag === 'img' || c.tag === 'hr') found = true; });
  return found || node.tag === 'img' || node.tag === 'hr';
}

// ────────────────────────────── 7) Markdown ──────────────────────────────

/* صورة ⇒ Markdown. دالة مستقلة لأن inlineMd يُسلسِل **أبناء** العقدة لا العقدة
   نفسها؛ فاستدعاؤه على <img> مباشرةً كان يعيد '' ⇒ صورة المقال تُفقد صامتة
   (كشفه اختبار 2026-11-08 بعد فكّ <figure>). */
function imageMd(node) {
  const src = String(node.attrs?.src || node.attrs?.['data-src'] || '').trim();
  if (!src || /^data:/i.test(src)) return '';
  const alt = String(node.attrs?.alt || '').replace(/[\[\]]/g, '');
  return `![${alt}](${src})`;
}

function inlineMd(node) {
  let out = '';
  for (const c of (node.children || [])) {
    if (!c.tag) { out += escapeMd(c.text || ''); continue; }
    const t = c.tag;
    if (NON_RENDERED_TAGS.has(t) || t === 'button' || t === 'form') continue;
    if (t === 'br') { out += '\n'; continue; }
    if (t === 'img') { const im = imageMd(c); if (im) out += im; continue; }
    if (t === 'a') {
      const inner = inlineMd(c).trim();
      const href = String(c.attrs?.href || '').trim();
      if (!inner) continue;
      if (!href || /^javascript:/i.test(href)) { out += inner; continue; }
      out += `[${inner}](${href})`;
      continue;
    }
    if (t === 'code') { const s = inlineMd(c); if (s.trim()) out += '`' + s.replace(/`/g, '') + '`'; continue; }
    if (t === 'strong' || t === 'b') { const s = inlineMd(c).trim(); if (s) out += `**${s}**`; continue; }
    if (t === 'em' || t === 'i') { const s = inlineMd(c).trim(); if (s) out += `*${s}*`; continue; }
    if (t === 'del' || t === 's' || t === 'strike') { const s = inlineMd(c).trim(); if (s) out += `~~${s}~~`; continue; }
    out += inlineMd(c);
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
}

function serializeList(node, depth, ordered) {
  const lines = [];
  let i = 0;
  for (const li of (node.children || [])) {
    if (li.tag !== 'li') continue;
    i++;
    const marker = ordered ? `${i}. ` : '- ';
    // فقرات داخل li تُدمج في سطر واحد، والقوائم المتداخلة تُزاح
    const nested = [];
    const parts = [];
    const gather = (nd) => {
      for (const c of (nd.children || [])) {
        if (c.tag === 'ul' || c.tag === 'ol') { nested.push(c); continue; }
        if (c.tag === 'p' || c.tag === 'div') { const s = inlineMd(c).trim(); if (s) parts.push(s); continue; }
        if (!c.tag) { const s = String(c.text || '').trim(); if (s) parts.push(escapeMd(s)); continue; }
        const s = inlineMd(c).trim();
        if (s) parts.push(s);
      }
    };
    gather(li);
    lines.push('  '.repeat(depth) + marker + parts.join(' ').trim());
    for (const nest of nested) lines.push(serializeList(nest, depth + 1, nest.tag === 'ol'));
  }
  return lines.join('\n');
}

function serializeTable(node) {
  const rows = [];
  walk(node, (tr) => {
    if (tr.tag !== 'tr') return;
    const cells = (tr.children || []).filter((c) => c.tag === 'td' || c.tag === 'th');
    if (!cells.length) return;
    const vals = cells.map((c) => inlineMd(c).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
    let seen = 0;
    walk(tr, (x) => { if (x === tr) return; });
    for (const c of cells) seen += Math.max(1, Number(c.attrs?.colspan) || 1);
    while (vals.length < seen) vals.push('');
    rows.push({ vals, isHeader: cells.every((c) => c.tag === 'th') });
  });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.vals.length));
  const pad = (v) => { const a = v.slice(); while (a.length < width) a.push(''); return a; };
  const out = [];
  const head = pad(rows[0].vals);
  out.push('| ' + head.join(' | ') + ' |');
  out.push('| ' + head.map(() => '---').join(' | ') + ' |');
  for (const r of rows.slice(1)) out.push('| ' + pad(r.vals).join(' | ') + ' |');
  return out.join('\n');
}

function serializeBlock(node) {
  const t = node.tag;
  if (HEADING_TAGS.has(t)) {
    const lvl = Number(t[1]);
    const s = inlineMd(node).trim();
    return s ? `${'#'.repeat(lvl)} ${s}` : '';
  }
  if (t === 'p') return inlineMd(node).trim();
  if (t === 'hr') return '---';
  if (t === 'pre') {
    const codeNode = (node.children || []).find((c) => c.tag === 'code') || node;
    const raw = textOf(codeNode, { keepNonRendered: true }).replace(/\u00a0/g, ' ');
    const cls = String(codeNode.attrs?.class || '') + ' ' + String(node.attrs?.class || '');
    const langM = /(?:language|lang|highlight)[-_:]([a-z0-9+#]+)/i.exec(cls);
    const fence = '`'.repeat(Math.max(3, (raw.match(/`{3,}/g) || []).reduce((a, s) => Math.max(a, s.length), 2) + 1));
    return `${fence}${langM ? langM[1].toLowerCase() : ''}\n${raw.replace(/\n+$/, '')}\n${fence}`;
  }
  if (t === 'blockquote') {
    const inner = serializeChildren(node).trim();
    return inner ? inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') : '';
  }
  if (t === 'ul') return serializeList(node, 0, false);
  if (t === 'ol') return serializeList(node, 0, true);
  if (t === 'table') return serializeTable(node);
  if (t === 'dl') {
    const out = [];
    for (const c of (node.children || [])) {
      if (c.tag === 'dt') out.push(`**${inlineMd(c).trim()}**`);
      else if (c.tag === 'dd') out.push(inlineMd(c).trim());
    }
    return out.filter(Boolean).join('\n');
  }
  if (t === 'figure') { const inner = serializeChildren(node).trim(); return inner; }
  if (t === 'img') return imageMd(node);
  // حاوٍ: نسلسل أبناءه
  return serializeChildren(node);
}

function serializeChildren(node) {
  const blocks = [];
  let inlineRun = '';
  const flush = () => { const s = inlineRun.trim(); if (s) blocks.push(s); inlineRun = ''; };
  for (const c of (node.children || [])) {
    if (!c.tag) { inlineRun += escapeMd(c.text || '') + ' '; continue; }
    // <img> عقدة بلا أبناء: يجب تسلسلها بنفسها لا عبر inlineMd
    if (c.tag === 'img') { const im = imageMd(c); if (im) inlineRun += im + ' '; continue; }
    if (KEEP_INLINE.has(c.tag) && !HEADING_TAGS.has(c.tag)) { inlineRun += inlineMd(c) + ' '; continue; }
    flush();
    const s = serializeBlock(c);
    if (s && s.trim()) blocks.push(s.trim());
  }
  flush();
  return blocks.join('\n\n');
}

function toMarkdown(node) {
  return serializeChildren(node)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

// ────────────────────────────── 8) خط الأساس المحافظ ──────────────────────────────

/**
 * تجريد الوسوم المحافظ: كل النص المرئي بلا وسوم (يُسقط script/style/head فقط).
 * هذا هو **سقف الأمان**: لا يجوز أن يعطي الاستخلاص نصاً أقلّ منه إلا بعلم المستخدم.
 */
function conservativeText(root) {
  const parts = [];
  const visit = (nd) => {
    for (const c of (nd.children || [])) {
      if (c.tag) {
        if (NON_RENDERED_TAGS.has(c.tag)) continue;
        const block = HEADING_TAGS.has(c.tag) || ['p', 'div', 'section', 'li', 'tr', 'br', 'blockquote', 'pre', 'td', 'th'].includes(c.tag);
        if (block) parts.push('\n');
        visit(c);
        if (block) parts.push('\n');
      } else if (c.text) parts.push(c.text);
    }
  };
  visit(root);
  return parts.join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

// ────────────────────────────── 9) الميتاداتا ──────────────────────────────

function metaOf(root, docUrl) {
  const all = [];
  walk(root, (c) => all.push(c));
  const meta = (name) => {
    for (const m of all) {
      if (m.tag !== 'meta') continue;
      const key = String(m.attrs?.property || m.attrs?.name || m.attrs?.itemprop || '').toLowerCase();
      if (key === name && m.attrs?.content) return String(m.attrs.content).trim();
    }
    return '';
  };
  const firstTagText = (tag) => {
    const hit = all.find((c) => c.tag === tag);
    return hit ? textOf(hit).trim() : '';
  };
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(root.__raw || ''));
  const title = meta('og:title') || meta('twitter:title') || firstTagText('h1') || (titleM ? unescapeEntities(titleM[1]).trim() : '');
  const site = meta('og:site_name') || (docUrl ? safeHost(docUrl) : '');
  const author = meta('author') || meta('article:author') || meta('og:article:author') || '';
  const published = meta('article:published_time') || meta('date') || meta('datepublished') || '';
  const langHit = all.find((c) => c.tag === 'html' && c.attrs?.lang);
  return {
    title: title.slice(0, 300),
    site: site.slice(0, 120),
    author: author.slice(0, 120),
    published: published.slice(0, 40),
    lang: langHit ? String(langHit.attrs.lang).slice(0, 12) : '',
  };
}

function safeHost(u) {
  try { return new URL(String(u)).hostname; } catch { return ''; }
}

// ────────────────────────────── 10) بوابة السلامة ──────────────────────────────

function containsWords(hay, needle, threshold) {
  const want = wordsOf(needle);
  if (!want.length) return true;
  const have = new Set(wordsOf(hay));
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.length >= threshold;
}

/** إشارات المحتوى التي لا يجوز أن تُفقد صامتة (صور/جداول/كود/عناوين). */
function countSignals(node) {
  const sig = { images: 0, tables: 0, pres: 0, headings: 0, listItems: 0, figures: 0 };
  walk(node, (c) => {
    if (c.tag === 'img') {
      const src = String(c.attrs?.src || c.attrs?.['data-src'] || '').trim();
      if (src && !/^data:/i.test(src)) sig.images++;
    }
    else if (c.tag === 'table') sig.tables++;
    else if (c.tag === 'pre') sig.pres++;
    else if (c.tag === 'h2' || c.tag === 'h3' || c.tag === 'h4') sig.headings++;
    else if (c.tag === 'li') sig.listItems++;
    else if (c.tag === 'figure') sig.figures++;
  });
  if (node.tag === 'img') sig.images++;
  return sig;
}

/**
 * المحتوى المتوقَّع من **منطقة المحتوى الخام** (قبل التنظيف).
 *
 * هذا هو الفرق الجوهري عن النسخة الأولى: كانت تجمع من المنطقة **بعد** التنظيف،
 * فأي إفراط في التنظيف (حذف figure، أو header يحمل عنواناً) لا يظهر في `expected`
 * ⇒ لا تراه البوابة ⇒ فقدان صامت. الآن نجمع من الخام مع استثناء الهوامش وحدها
 * (المخفية والسالبة التنقيط)، فما يُحذف بـDROP_TAGS يبقى «متوقَّعاً» ⇒ تُكشف الزيادة.
 */
function collectExpected(region) {
  const expected = {
    headings: [], paragraphs: [], cells: [], lists: [],
    signals: { images: 0, tables: 0, pres: 0, headings: 0, listItems: 0, figures: 0 },
    imageSrcs: [],
  };
  if (!region) return expected;

  const skip = (nd) => {
    if (!nd.tag) return false;
    if (isHidden(nd)) return true;
    const role = String(nd.attrs?.role || '').toLowerCase();
    if (role === 'navigation' || role === 'complementary' || role === 'dialog' || role === 'banner') return true;
    // الهوامش وحدها تُستثنى (نفس منطق الحذف بالتنقيط) — لا وسوم المحتوى
    if (scoreNonContentBlock(nd) < 0 && !isLikelyContent(nd)) return true;
    return false;
  };

  const visit = (nd) => {
    for (const c of (nd.children || [])) {
      if (!c.tag) continue;
      if (NON_RENDERED_TAGS.has(c.tag)) continue;
      if (skip(c)) continue;

      // الإشارات
      if (c.tag === 'img') {
        const src = String(c.attrs?.src || c.attrs?.['data-src'] || '').trim();
        if (src && !/^data:/i.test(src)) { expected.signals.images++; if (expected.imageSrcs.length < 6) expected.imageSrcs.push(src); }
      } else if (c.tag === 'table') expected.signals.tables++;
      else if (c.tag === 'pre') expected.signals.pres++;
      else if (c.tag === 'figure') expected.signals.figures++;
      else if (c.tag === 'li') expected.signals.listItems++;
      else if (c.tag === 'h2' || c.tag === 'h3' || c.tag === 'h4') expected.signals.headings++;

      // النصوص الحاملة للمعنى
      if (HEADING_TAGS.has(c.tag) && expected.headings.length < 8 && countWords(textOf(c)) >= 1) expected.headings.push(textOf(c));
      else if (c.tag === 'p' && expected.paragraphs.length < 4 && countWords(textOf(c)) >= 8) expected.paragraphs.push(textOf(c));
      else if ((c.tag === 'td' || c.tag === 'th') && expected.cells.length < 4 && countWords(textOf(c)) >= 3) expected.cells.push(textOf(c));
      else if (c.tag === 'li' && expected.lists.length < 6 && countWords(textOf(c)) >= 1) expected.lists.push(textOf(c));

      visit(c);
    }
  };
  visit(region);
  return expected;
}

/**
 * لا تقليل صامت: كل ما كان يجب أن يظهر (expected) يجب أن يظهر فعلاً، والمراجع
 * لا تُفقد. أي فشل ⇒ تُجرَّب محاولة أوسع، ثم تراجع إلى خط الأساس المحافظ.
 */
function safetyGate(cleaned, markdown, expected, baseline) {
  const reasons = [];
  const mdWords = countWords(markdown);
  const selWords = countWords(textOf(cleaned));

  // (1) لا محتوى معقول
  if (mdWords < MIN_CONTENT_WORDS) reasons.push('too_short');

  // (2) كل عنوان في منطقة المحتوى يجب أن يظهر
  for (const h of expected.headings) if (!containsWords(markdown, h, 0.8)) reasons.push('heading_lost');
  // (3) الفقرات
  for (const p of expected.paragraphs) if (!containsWords(markdown, p, 0.7)) reasons.push('paragraph_lost');
  // (4) خلايا الجداول المرئية
  for (const c of expected.cells) if (!containsWords(markdown, c, 0.7)) reasons.push('cell_lost');
  // (5) عناصر القوائم
  for (const l of expected.lists) if (!containsWords(markdown, l, 0.7)) reasons.push('list_lost');

  /* (6) الصور: كانت تُحذف صامتة مع <figure> ولا شيء يفحصها.
     نتحقق أن مسار كل صورة متوقَّعة ظهر في المخرج (وفشل الصورة فقدان محتوى). */
  for (const src of expected.imageSrcs) if (!markdown.includes(src)) reasons.push('image_lost');

  /* (7) مقارنة إشارات المحتوى قبل التنظيف وبعده: تسدّ ثغرة «البوابة تحمي الاختيار
     لا التنظيف». العتبات متسامحة مع الهوامش المقصودة (روابط)، وصارمة مع ما لا
     يظهر في الهوامش عادةً (كود/جداول/عناوين/صور). */
  const after = countSignals(cleaned);
  const sig = expected.signals;
  const min = (before, ratio) => (before > 0 ? Math.ceil(before * ratio) : 0);
  if (sig.images > 0 && after.images < min(sig.images, 0.6)) reasons.push('signals_images');
  if (sig.tables > 0 && after.tables < min(sig.tables, 0.6)) reasons.push('signals_tables');
  if (sig.pres > 0 && after.pres < min(sig.pres, 0.6)) reasons.push('signals_code');
  if (sig.headings > 0 && after.headings < min(sig.headings, 0.6)) reasons.push('signals_headings');
  if (sig.figures > 0 && after.images === 0 && sig.images > 0) reasons.push('signals_figures');

  // (8) تغطية الكلمات مقابل ما اختَرناه (لا مقابل الصفحة كاملة، فالهوامش تُحذف عمداً)
  if (selWords > 60 && mdWords < selWords * 0.35) reasons.push('coverage_low');

  // (9) خط الأساس المحافظ: لا نقبل مخرجاً يقلّ عن خُمس نصّ الصفحة المرئي
  const baseWords = countWords(baseline);
  if (baseWords > 80 && mdWords < baseWords * 0.2) reasons.push('below_baseline');

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

// ────────────────────────────── 11) الواجهة العامة ──────────────────────────────

/** هل هذا المحتوى HTML يستحق الاستخلاص؟ */
function isHtmlContent(contentType, ext) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  const e = String(ext || '').toLowerCase();
  return e === '.html' || e === '.htm' || e === '.xhtml';
}

/**
 * يستخلص المحتوى الرئيسي.
 * @param {string} html
 * @param {{url?:string, contentType?:string}} [opts]
 * @returns {{ok:boolean, markdown:string, extraction:'main'|'fallback'|'none',
 *            reasons:string[], strategy:string, meta:object, stats:object}}
 */
function extractReadable(html, opts = {}) {
  const raw = typeof html === 'string' ? html : String(html == null ? '' : html);
  const bytesRaw = Buffer.byteLength(raw, 'utf8');

  const root = parseHtml(raw);
  root.__raw = raw;                                  // يُستعمل لقراءة <title> وحدها
  const baseline = conservativeText(root);

  // لا يبدو HTML أصلاً ⇒ لا نلمس شيئاً، والمستدعي يتصرّف
  if (!/<[a-z!/]/i.test(raw)) {
    return {
      ok: false, markdown: raw, extraction: 'none', reasons: ['not_html'], strategy: 'none',
      meta: {}, stats: baseStats(bytesRaw, raw),
    };
  }

  const picked = findMainContent(root);
  const meta = metaOf(root, opts.url);

  if (!picked.region) {
    const md = baseline;
    return {
      ok: false, markdown: md, extraction: 'fallback', reasons: ['no_content'], strategy: 'none',
      meta, stats: baseStats(bytesRaw, md, baseline),
    };
  }

  // المرجع يُجمَع من المنطقة **الخام** قبل التنظيف: كي يُكشف الإفراط في التنظيف نفسه
  const expected = collectExpected(picked.region);
  const withTitle = (md) => {
    if (!meta.title) return md;
    const firstLine = md.split('\n')[0] || '';
    return containsWords(firstLine, meta.title, 0.6) ? md : `# ${meta.title}\n\n${md}`;
  };

  /* سلّم المحاولات (فلسفة defuddle: relax ثم retry، ولا يُقبل التراجع إلا بضرورة):
     1) العقدة المعمَّقة (أدقّ)، 2) منطقة المحتوى كاملة (أوسع)، 3) خط الأساس المحافظ. */
  const tried = [];
  const candidates = picked.node && picked.node !== picked.region
    ? [{ node: picked.node, strategy: picked.strategy }, { node: picked.region, strategy: 'entry-point-wide' }]
    : [{ node: picked.region, strategy: picked.strategy }];

  let lastReasons = [];
  for (const cand of candidates) {
    const cleaned = cleanTree(cand.node);
    const markdown = withTitle(toMarkdown(cleaned));
    const gate = safetyGate(cleaned, markdown, expected, baseline);
    if (gate.ok) {
      return {
        ok: true, markdown, extraction: 'main', reasons: [], strategy: cand.strategy,
        meta, stats: baseStats(bytesRaw, markdown, baseline), tried,
      };
    }
    lastReasons = gate.reasons;
    tried.push({ strategy: cand.strategy, reasons: gate.reasons });
  }

  // تراجع آمن: نص كامل بلا وسوم — لا HTML خام أبداً، والسبب معلَن
  const fb = meta.title ? `# ${meta.title}\n\n${baseline}` : baseline;
  return {
    ok: false, markdown: fb, extraction: 'fallback', reasons: lastReasons,
    strategy: picked.strategy, meta, stats: baseStats(bytesRaw, fb, baseline), tried,
  };
}

function baseStats(bytesRaw, markdown, baseline) {
  const bytesClean = Buffer.byteLength(String(markdown || ''), 'utf8');
  return {
    bytesRaw,
    bytesClean,
    ratio: bytesRaw ? Number((bytesClean / bytesRaw).toFixed(4)) : 0,
    wordsClean: countWords(markdown),
    wordsBaseline: baseline === undefined ? countWords(markdown) : countWords(baseline),
  };
}

module.exports = {
  extractReadable,
  isHtmlContent,
  // مُصدَّرة للاختبار المباشر
  parseHtml,
  toMarkdown,
  cleanTree,
  findMainContent,
  conservativeText,
  collectExpected,
  safetyGate,
  scoreElement,
  scoreNonContentBlock,
  isLikelyContent,
  countWords,
  unescapeEntities,
  MIN_CONTENT_WORDS,
};
