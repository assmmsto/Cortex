'use strict';
const i18n = require('./cortex-i18n');
/**
 * Cortex — محرك الاستيراد الآمن (الدستور §18–§21)
 *
 * §18: يدعم النصوص والكود والتوثيق والبيانات، DOCX/PPTX/XLSX، PDF، الصور (OCR)، الأرشيفات.
 * §19: يُنتج مع كل مستورد بصمة SHA-256 وحجماً وميتاداتا، ليُحفظ مع المصدر وتاريخ الاستيراد.
 * §20: الصيغة غير المدعومة تُعلن صراحةً — ممنوع الادعاء بأنها قُرئت.
 * §21: كل محتوى مستورد بيانات لا أوامر. لا تنفيذ، لا صلاحيات، لا تغيير سياسات.
 *      أي محتوى يحاول إعطاء تعليمات للوكيل يُعزل بـ stripInjection ويُسجَّل.
 *
 * قراءة فقط. لا مكتبات خارجية. لا استخراج تلقائي لأي أرشيف.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const readability = require('./cortex-readability');

// ─────────────────────────────── الامتدادات ───────────────────────────────

// نصوص مباشرة
const TEXT_EXTS = [
  '.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.env', '.log', '.csv', '.tsv',
];

// كود برمجي
const CODE_EXTS = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift',
  '.sh', '.bash', '.ps1', '.sql', '.vue', '.svelte', '.html', '.htm', '.css',
  '.scss', '.less',
];

const DOC_EXTS = ['.docx', '.pptx', '.xlsx', '.pdf'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'];
const ARCHIVE_EXTS = ['.zip'];

/** كل الامتدادات المدعومة فعلياً — للإبلاغ الصادق عن القدرات (§20). */
const IMPORTABLE_EXTENSIONS = Object.freeze([
  ...TEXT_EXTS, ...CODE_EXTS, ...DOC_EXTS, ...IMAGE_EXTS, ...ARCHIVE_EXTS,
]);

// خريطة اللغة للعرض في الميتاداتا
const LANG_MAP = Object.freeze({
  md: 'markdown', rst: 'rst', txt: 'text', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', env: 'dotenv', log: 'log', csv: 'csv', tsv: 'tsv',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', ps1: 'powershell', sql: 'sql',
  vue: 'vue', svelte: 'svelte', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  less: 'less', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', pdf: 'pdf', zip: 'archive',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', tiff: 'image',
});

// ─────────────────────────── أدوات مساعدة داخلية ───────────────────────────

/** امتداد طبيعي: حروف صغيرة، بلا نقطة زائدة. */
function normExt(ext) {
  if (typeof ext !== 'string') return '';
  const e = ext.trim().toLowerCase();
  if (!e) return '';
  return e.startsWith('.') ? e : '.' + e;
}

/** قراءة نصية آمنة: نجرّب UTF-8، وإن بدت مشوّهة نجرّب latin1. */
async function readTextSafe(filePath) {
  const buf = await fsp.readFile(filePath);
  let text = buf.toString('utf8');
  // U+FFFD دلالة على تسلسل غير صالح لـ UTF-8
  if (text.includes('\uFFFD')) text = buf.toString('latin1');
  return text.replace(/^\uFEFF/, ''); // إزالة BOM
}

/** فك كيانات XML/HTML الأساسية. */
function unescapeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * تجريد وسوم XML إلى نص مقروء.
 * المصدر موثوق البنية (Office) لكن المحتوى غير موثوق — نتعامل معه كنص فقط.
 */
function stripTags(xml) {
  return unescapeEntities(
    String(xml)
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ──────────────────────── فك ZIP يدوياً (Central Directory) ────────────────────────

/**
 * فهرس أرشيف ZIP بقراءة الـ End Of Central Directory ثم الـ Central Directory.
 * لا نستخرج شيئاً — نقرأ الأسماء وحقولها فقط (§21: فحص المحتوى قبل المعالجة).
 */
function readZipIndex(buf) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const maxBack = Math.min(buf.length, 66000);

  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('أرشيف ZIP تالف: لم يُعثر على توقيع نهاية الفهرس');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) {
      throw new Error('فهرس ZIP تالف: إدخال غير صالح عند الإزاحة ' + off);
    }
    const method = buf.readUInt16LE(off + 10);
    const flags = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);

    const nameBuf = buf.subarray(off + 46, off + 46 + nameLen);
    // bit 11 = أسماء UTF-8؛ خلاف ذلك نفترض UTF-8 مع بديل latin1
    let name = nameBuf.toString('utf8');
    if (!(flags & 0x0800) && name.includes('\uFFFD')) name = nameBuf.toString('latin1');

    entries.push({
      name,
      method,
      crc32: crc.toString(16).padStart(8, '0'),
      compressedSize: compSize,
      size: rawSize,
      localOffset: localOff,
      isDirectory: name.endsWith('/'),
    });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** استخراج إدخال واحد من الأرشيف بالذاكرة (قراءة فقط، لا كتابة على القرص). */
function extractZipEntry(buf, entry) {
  const LOCAL_SIG = 0x04034b50;
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new Error('رأس محلي تالف للإدخال: ' + entry.name);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);              // مخزّن
  if (entry.method === 8) return zlib.inflateRawSync(data);      // Deflate
  throw new Error('طريقة ضغط ZIP غير مدعومة (' + entry.method + ') للإدخال: ' + entry.name);
}

/** فتح ZIP من ملف وإرجاع { buf, entries } — يُستخدم لكل معالجات Office. */
async function openZip(filePath) {
  const buf = await fsp.readFile(filePath);
  const entries = readZipIndex(buf);
  return { buf, entries };
}

/** إيجاد إدخال بمساره مع مرونة الفواصل. */
function findEntry(entries, wantedName) {
  const want = wantedName.replace(/\\/g, '/').toLowerCase();
  return entries.find((e) => e.name.replace(/\\/g, '/').toLowerCase() === want) || null;
}

// ────────────────────────────── معالجات الصيغ ──────────────────────────────

/** معالج نصوص/كود مشترك. */
async function textHandler(filePath) {
  return { text: await readTextSafe(filePath) };
}

/** DOCX → نص من word/document.xml */
async function docxHandler(filePath) {
  const { buf, entries } = await openZip(filePath);
  const doc = findEntry(entries, 'word/document.xml');
  if (!doc) return { unsupported: true, reason: 'DOCX تالف: لا يحتوي word/document.xml' };

  const parts = [stripTags(extractZipEntry(buf, doc).toString('utf8'))];

  // الحواشي والملاحظات الختامية جزء من المستند لا نُسقطه
  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const e = findEntry(entries, extra);
    if (e) {
      const t = stripTags(extractZipEntry(buf, e).toString('utf8'));
      if (t) parts.push(t);
    }
  }
  const text = parts.filter(Boolean).join('\n\n').trim();
  if (!text) return { unsupported: true, reason: 'DOCX لا يحتوي نصاً مستخرجاً' };
  return { text };
}

/** PPTX → نص من كل شرائح العرض بالترتيب الرقمي */
async function pptxHandler(filePath) {
  const { buf, entries } = await openZip(filePath);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name.replace(/\\/g, '/')))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/slide(\d+)\.xml$/i)[1], 10);
      const nb = parseInt(b.name.match(/slide(\d+)\.xml$/i)[1], 10);
      return na - nb;
    });

  if (!slides.length) return { unsupported: true, reason: 'PPTX تالف: لا يحتوي شرائح' };

  const parts = [];
  slides.forEach((s, i) => {
    const n = parseInt(s.name.match(/slide(\d+)\.xml$/i)[1], 10);
    const body = stripTags(extractZipEntry(buf, s).toString('utf8'));
    parts.push('## شريحة ' + n + '\n' + (body || '(فارغة)'));
  });
  return { text: parts.join('\n\n').trim() };
}

/** XLSX → جدول نصي مبني على SharedStrings + أوراق العمل */
async function xlsxHandler(filePath) {
  const { buf, entries } = await openZip(filePath);

  // السلاسل المشتركة
  const shared = [];
  const ss = findEntry(entries, 'xl/sharedStrings.xml');
  if (ss) {
    const xml = extractZipEntry(buf, ss).toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(stripTags(m[1]));
    }
  }

  // أسماء الأوراق من workbook.xml (لمطابقة الترتيب برقم الورقة)
  const names = [];
  const wb = findEntry(entries, 'xl/workbook.xml');
  if (wb) {
    const xml = extractZipEntry(buf, wb).toString('utf8');
    for (const m of xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) {
      names.push(unescapeEntities(m[1]));
    }
  }

  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name.replace(/\\/g, '/')))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/sheet(\d+)\.xml$/i)[1], 10);
      const nb = parseInt(b.name.match(/sheet(\d+)\.xml$/i)[1], 10);
      return na - nb;
    });

  if (!sheets.length) return { unsupported: true, reason: 'XLSX تالف: لا يحتوي أوراق عمل' };

  const out = [];
  sheets.forEach((s) => {
    const idx = parseInt(s.name.match(/sheet(\d+)\.xml$/i)[1], 10);
    const label = names[idx - 1] || ('ورقة' + idx);
    const xml = extractZipEntry(buf, s).toString('utf8');
    const rows = [];

    for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cM of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
        const attrs = cM[1] || cM[3] || '';
        const body = cM[2] || '';
        const typeM = attrs.match(/\bt="([^"]*)"/);
        const type = typeM ? typeM[1] : 'n';
        let val = '';
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        const isM = body.match(/<is>([\s\S]*?)<\/is>/);

        if (type === 's' && vM) {
          const vi = parseInt(vM[1], 10);
          val = shared[vi] !== undefined ? shared[vi] : '';
        } else if (type === 'inlineStr' && isM) {
          val = stripTags(isM[1]);
        } else if (vM) {
          val = unescapeEntities(vM[1]);
        }
        cells.push(String(val).replace(/[\t\r\n]+/g, ' '));
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }

    out.push('## ' + label);
    out.push(rows.length ? rows.join('\n') : '(فارغة)');
    out.push('');
  });

  return { text: out.join('\n').trim() };
}

/** تجريد مشغّلات PDF غير المضغوطة داخل قوسي BT..ET */
function decodePdfLiteral(lit) {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i];
    if (c !== '\\') { out += c; continue; }
    const n = lit[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'r' || n === '(' || n === ')' || n === '\\') out += n;
    else if (n === '\n') { /* استمرار سطر */ }
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(lit[i + 1] || '')) oct += lit[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;
  }
  return out;
}

/** استخراج النص من تدفق محتوى PDF (يعمل على النص المفوّك). */
function pdfContentToText(content) {
  const lines = [];
  const btRe = /BT\b([\s\S]*?)\bET\b/g;
  let bt;
  let found = false;

  while ((bt = btRe.exec(content)) !== null) {
    found = true;
    const seg = bt[1];
    let line = '';
    const tokRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dDmJj*]\b|\bTD\b|\bTf\b|\bTL\b/g;
    let t;
    while ((t = tokRe.exec(seg)) !== null) {
      const s = t[0];
      if (s[0] === '(') line += decodePdfLiteral(s.slice(1, -1));
      else if (s[0] === '<') {
        // سلسلة hex: UTF-16BE إن بدأت بـ FEFF، وإلا latin1
        const hex = s.slice(1, -1).replace(/\s+/g, '');
        if (hex.length >= 4 && hex.slice(0, 4).toLowerCase() === 'feff') {
          for (let i = 4; i + 3 < hex.length; i += 4) {
            line += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
          }
        } else {
          for (let i = 0; i + 1 < hex.length; i += 2) {
            line += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
          }
        }
      } else if (s === 'Td' || s === 'TD' || s === 'T*') line += '\n';
    }
    if (line.trim()) lines.push(line.trim());
  }

  return { text: lines.join('\n'), found };
}

/** PDF → نص من التدفقات المباشرة، مع محاولة فك FlateDecode */
async function pdfHandler(filePath) {
  const buf = await fsp.readFile(filePath);
  const raw = buf.toString('latin1');
  let out = pdfContentToText(raw);
  let sawFlate = /\/FlateDecode/.test(raw);
  let inflateFailed = false;
  let inflatedAny = false;

  if (!out.found || out.text.length < 8) {
    // نجرب فك كل التدفقات المضغوطة ونبحث فيها عن BT..ET
    const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
    const collected = [];
    let s;
    while ((s = streamRe.exec(raw)) !== null) {
      let data = Buffer.from(s[1], 'latin1');
      // اقتطاع محارف CR/LF الختامية التي ليست جزءاً من التدفق
      while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
        data = data.subarray(0, data.length - 1);
      }
      try {
        const inflated = zlib.inflateSync(data).toString('latin1');
        inflatedAny = true;
        const c = pdfContentToText(inflated);
        if (c.found && c.text.trim()) collected.push(c.text);
      } catch (_) {
        inflateFailed = true;
      }
    }
    if (collected.length) out = { text: collected.join('\n'), found: true };
  }

  const text = (out.text || '').replace(/\n{3,}/g, '\n\n').trim();

  if (!out.found || !text) {
    // تدفق فُكّ بنجاح لكنه لا يحوي BT/Tj ⇒ صور فقط (ممسوح)، لا «ترميز غير مدعوم»
    if (inflatedAny) {
      return { unsupported: true, reason: 'PDF لا يحتوي نصاً قابلاً للاستخراج (قد يكون صوراً ممسوحة)' };
    }
    if (sawFlate || inflateFailed) {
      return { unsupported: true, reason: 'PDF مضغوط بترميز غير مدعوم' };
    }
    return { unsupported: true, reason: 'PDF لا يحتوي نصاً قابلاً للاستخراج (قد يكون صوراً ممسوحة)' };
  }
  return { text };
}

/** هل tesseract متاح؟ */
function hasTesseract() {
  const r = spawnSync('tesseract', ['--version'], { encoding: 'utf8', timeout: 15000 });
  return !!r && r.error === undefined && r.status === 0;
}

/** الصور → OCR عبر tesseract إن توفّر، وإلا إعلان صريح بعدم الدعم (§20) */
async function imageHandler(filePath) {
  if (!hasTesseract()) {
    return {
      unsupported: true,
      /* رسالة قابلة للتنفيذ لا مجرد «غير مثبت»: المستخدم لا يعرف ماذا يفعل. */
      reason: i18n.T('الصور تحتاج OCR — ثبّت tesseract ثم أعد الاستيراد (Windows: winget install UB-Mannheim.TesseractOCR)',
        'Images need OCR — install tesseract then retry (Windows: winget install UB-Mannheim.TesseractOCR)'),
      needsOcr: true,
    };
  }

  // outputbase بلا امتداد ⇒ tesseract يكتب <base>.txt
  const outBase = path.join(
    path.dirname(filePath),
    '.cortex-ocr-' + crypto.randomBytes(6).toString('hex'),
  );
  const r = spawnSync(
    'tesseract',
    [filePath, outBase, '-l', 'ara+eng'],
    { encoding: 'utf8', timeout: 120000 },
  );

  if (!r || r.error || r.status !== 0) {
    return {
      unsupported: true,
      reason: 'فشل OCR: ' + scrubSystemText((r && (r.error && r.error.message || r.stderr)) || 'سبب غير معروف'),
      needsOcr: true,
    };
  }

  const txtPath = outBase + '.txt';
  try {
    const text = await fsp.readFile(txtPath, 'utf8');
    await fsp.unlink(txtPath).catch(() => {}); // تنظيف مخرج tesseract
    return { text: text.trim() };
  } catch (e) {
    return { unsupported: true, reason: 'OCR لم ينتج نصاً: ' + errnoMessage(e), needsOcr: true };
  }
}

/**
 * ZIP → قائمة محتويات فقط + تحذير أمني.
 * §21: لا استخراج تلقائي، لا كتابة على القرص، لا تنفيذ.
 */
async function zipHandler(filePath) {
  const { entries } = await openZip(filePath);

  const list = entries.map((e) => ({
    name: e.name,
    size: e.size,
    compressedSize: e.compressedSize,
    method: e.method === 0 ? 'stored' : e.method === 8 ? 'deflate' : 'method:' + e.method,
    crc32: e.crc32,
    dir: e.isDirectory,
  }));

  // مخاطر يُبلّغ عنها صراحةً قبل أي معالجة
  const risks = [];
  const has = (re) => list.some((e) => re.test(e.name.replace(/\\/g, '/')));
  if (has(/\.(exe|dll|bat|cmd|ps1|vbs|sh|msi|scr|com)$/i)) risks.push('يحتوي ملفات قابلة للتنفيذ');
  if (has(/(^|\/)\.\.(\/|$)/) || list.some((e) => path.isAbsolute(e.name) || /^[A-Za-z]:/.test(e.name))) {
    risks.push('يحتوي مسارات هروب (Zip Slip)');
  }
  if (list.some((e) => e.size > 512 * 1024 * 1024)) risks.push('يحتوي ملفات ضخمة');

  const header = [
    'أرشيف ZIP — فحص محتوى فقط، لم يُستخرج أي ملف (دستور §21).',
    'عدد الإدخالات: ' + list.length,
    risks.length ? 'تحذيرات أمنية: ' + risks.join(' — ') : 'لا تحذيرات أمنية ظاهرة.',
  ].join('\n');

  const listing = list
    .slice(0, 500)
    .map((e) => (e.dir ? '[مجلد] ' : '') + e.name + (e.dir ? '' : '  (' + e.size + ' بايت)'))
    .join('\n');

  return {
    text: header + '\n\n' + (listing || '(أرشيف فارغ)'),
    archive: { entries: list, count: list.length, risks, extracted: false },
  };
}

// ─────────────────────────── جدول المعالجات ───────────────────────────

/** HANDLERS: الامتداد ← دالة معالجة (async) */
const HANDLERS = Object.create(null);
for (const e of TEXT_EXTS) HANDLERS[e] = textHandler;
for (const e of CODE_EXTS) HANDLERS[e] = textHandler;
HANDLERS['.docx'] = docxHandler;
HANDLERS['.pptx'] = pptxHandler;
HANDLERS['.xlsx'] = xlsxHandler;
HANDLERS['.pdf'] = pdfHandler;
for (const e of IMAGE_EXTS) HANDLERS[e] = imageHandler;
HANDLERS['.zip'] = zipHandler;
Object.freeze(HANDLERS);

/** هل الامتداد مدعوم؟ */
function isSupported(ext) {
  const e = normExt(ext);
  if (!e) return { ok: false, reason: 'امتداد مفقود' };
  if (HANDLERS[e]) return { ok: true };
  return {
    ok: false,
    reason: 'صيغة غير مدعومة: ' + e + ' — النظام لا يدّعي قراءتها (دستور §20)',
  };
}

// ───────────────────────── العزل الأمني (دستور §21) ─────────────────────────

const ISOLATED = '[محتوى مُعزَل: محاولة تعليمات]';

/**
 * أنماط حقن التعليمات — بيانات تُقاس على المحتوى المستورد فقط.
 * كل نمط يُصلح بـ flags: 'gi' عند الاستخدام.
 */
const INJECTION_PATTERNS = Object.freeze([
  // تجاهل التعليمات السابقة (إنجليزي)
  { name: 'ignore-previous', re: /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directives?)/i },
  // تجاهل التعليمات السابقة (عربي)
  { name: 'ignore-previous-ar', re: /تجاهل\s+(?:كل\s+|جميع\s+)?(?:التعليمات|الأوامر|التوجيهات|القواعد)\s*(?:السابقة|أعلاه|أعلاه|سابقاً|الماضية)?/i },
  // تجاهل كل ما سبق
  { name: 'disregard', re: /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+|prior\s+|above\s+)?(?:instructions?|rules?|prompts?|directives?)/i },
  { name: 'disregard-ar', re: /تجاوز\s+(?:كل\s+|جميع\s+)?(?:التعليمات|الأوامر|القواعد|السياسات)/i },
  // أنت الآن
  { name: 'you-are-now', re: /you\s+are\s+now\b/i },
  // ملاحظة: \b في JS لا يعمل مع الحروف العربية (‏\w‏ إنجليزي فقط)، لذا نستخدم lookahead عربي
  { name: 'you-are-now-ar', re: /أنت\s+الآن(?![\u0600-\u06FF])/i },
  // تعليمات النظام / system prompt
  { name: 'system-prompt', re: /system\s*prompt/i },
  { name: 'system-prompt-ar', re: /(?:تعليمات|توجيهات)\s*النظام/i },
  { name: 'system-prompt-token', re: /(?:<system>|<\/system>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>)/i },
  // تعليمات جديدة
  { name: 'new-instructions', re: /new\s+instructions?\s*:/i },
  { name: 'new-instructions-ar', re: /(?:تعليمات|أوامر|توجيهات)\s+جديدة\s*[:：]?/i },
  // override instructions
  { name: 'override', re: /override\s+(?:the\s+|all\s+|any\s+)?(?:instructions?|rules?|prompts?|policy|policies|settings?)/i },
  { name: 'override-ar', re: /تجاوز\s+(?:\S+\s+){0,2}?(?:التعليمات|الأوامر|القواعد|السياسات|الأمان)/i },
  // صيغ أدوار شائعة في الحقن
  { name: 'role-tag', re: /(?:^|\n)\s*(?:###\s*)?(?:system|assistant)\s*:\s*(?:you|ignore|new|override|disregard)/i },
  { name: 'ai-instruct', re: /\b(?:as\s+an?\s+ai|instruction\s+for\s+the\s+(?:assistant|agent|model))\b/i },
  { name: 'ai-instruct-ar', re: /(?:تعليمات|توجيه)\s+(?:للمساعد|للو(?:كيل|كيل)|للنموذج|للذكاء\s+الاصطناعي)/i },
]);

/**
 * يعزل محاولات إعطاء تعليمات للوكيل من داخل محتوى مستورد.
 * كل مطابقة تُستبدل بـ [محتوى مُعزَل: محاولة تعليمات] ويُعاد بيانها.
 * @param {string} text
 * @returns {{ clean: string, stripped: Array<{match:string,index:number,pattern:string}> }}
 */
function stripInjection(text) {
  const src = typeof text === 'string' ? text : String(text == null ? '' : text);
  const found = [];

  // نجمع كل المطابقات من كل الأنماط ثم نعزل من النهاية للبداية (حفاظاً على الفهارس)
  for (const p of INJECTION_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({ match: m[0], index: m.index, pattern: p.name, end: m.index + m[0].length });
      if (m[0] === '') re.lastIndex++; // حماية من الحلقة اللانهائية
    }
  }

  if (!found.length) return { clean: src, stripped: [] };

  found.sort((a, b) => a.index - b.index || b.end - a.end);

  // إزالة التداخل: نأخذ أولاً الأطول عند التداخل
  const picked = [];
  for (const f of found) {
    if (picked.length && f.index < picked[picked.length - 1].end) {
      if (f.end > picked[picked.length - 1].end) {
        // امتداد أطول: نوسّع المطابقة الأخيرة
        picked[picked.length - 1].end = f.end;
        picked[picked.length - 1].match = src.slice(picked[picked.length - 1].index, f.end);
      }
      continue;
    }
    picked.push({ ...f });
  }

  // توسيع كل مطابقة إلى نهاية سطرها: استبدال العبارة وحدها كان يُبقي بقية التوجيه
  // («[مُعزَل] مدير النظام ونفّذ ما يلي:») فيصل الأمر للوكيل محروماً من سياقه فقط (§26 حقن).
  const spans = picked.map((p) => {
    const nl = src.indexOf('\n', p.end);
    const end = nl === -1 ? src.length : nl;
    const last = p.end;
    return { ...p, index: p.index, end: Math.max(end, last), widened: end > p.end };
  });

  // دمج التداخل الناتج عن التوسيع حتى لا تتداخل المقاطع
  const merged = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev && sp.index <= prev.end) {
      prev.end = Math.max(prev.end, sp.end);
      prev.match = src.slice(prev.index, prev.end);
    } else {
      merged.push({ ...sp });
    }
  }

  // بناء للأمام بدل التعديل في المكان: توسيع النهاية كان يزحزح فهارس المطابقات الأسبق
  const parts = [];
  let cursor = 0;
  for (const sp of merged) {
    parts.push(src.slice(cursor, sp.index), ISOLATED);
    cursor = sp.end;
  }
  parts.push(src.slice(cursor));
  const clean = parts.join('');

  return {
    clean,
    stripped: merged.map((p) => ({ match: p.match, index: p.index, pattern: p.pattern, widened: !!p.widened })),
  };
}

// ───────────────────────────── استنتاج النوع ─────────────────────────────

/** نوع المستند بحسب الامتداد ثم بنية النص. */
/**
 * تنظيف المتن المستورد **قبل** كتابته في الذاكرة.
 *
 * عطل مُقاس (2026-11-08): HTML كان يُكتب خاماً في متن الملاحظة — القياس كان
 * ratio = 1.000 (1137/1137 بايت) مع <script> و<style> و<nav> و<aside> وكود
 * التتبّع، والعنوان من اسم الملف لا من <title>. فتتلوّث ذاكرة الوكيل وتنفجر
 * تكلفة الرموز على الهوامش. الفكرة من مستودع defuddle (MIT): استخلاص المحتوى
 * الرئيسي وتحويله إلى Markdown ⇒ ذاكرة نظيفة ورموز أقل.
 *
 * القاعدتان الحاكمتان:
 *   1) **لا HTML خام في الذاكرة أبداً**: إن فشل الاستخلاص يُعاد تجريد الوسوم
 *      المحافظ (نص كامل بلا وسوم) لا المصدر الخام.
 *   2) **لا تقليل صامت**: السبب والنسبة يُعادان في extractionMeta ليُكتبا في
 *      ترويسة المستند فيرى المستخدم أن الاستخلاص تراجع ولماذا.
 *
 * @returns {{text:string, extraction:(null|'main'|'fallback'|'none'), extractionMeta:(null|object)}}
 */
function cleanImportedText(text, { ext = '', contentType = '', url = '' } = {}) {
  const src = typeof text === 'string' ? text : '';
  if (!readability.isHtmlContent(contentType, ext)) return { text: src, extraction: null, extractionMeta: null };

  const r = readability.extractReadable(src, { url });
  const m = r.meta || {};
  return {
    text: r.markdown,
    extraction: r.extraction,
    extractionMeta: {
      extraction: r.extraction,
      extractStrategy: r.strategy,
      ...(r.reasons.length ? { extractReasons: r.reasons } : {}),
      extractRatio: r.stats.ratio,
      bytesRaw: r.stats.bytesRaw,
      bytesClean: r.stats.bytesClean,
      ...(m.title ? { title: m.title } : {}),
      ...(m.author ? { author: m.author } : {}),
      ...(m.site ? { site: m.site } : {}),
      ...(m.published ? { published: m.published } : {}),
      ...(m.lang ? { language: m.lang } : {}),
    },
  };
}

function detectKind(ext, text) {
  const e = normExt(ext);
  if (IMAGE_EXTS.includes(e)) return 'image';
  if (ARCHIVE_EXTS.includes(e)) return 'archive';
  /* HTML: مستند إن كان فيه متن مقالي فعلي، وكود إن كان قالباً/هيكلاً بلا متن.
     (2026-11-13) التصنيف الأعمى «document» كان يخالف §21: قالب فيه {{title}}
     ليس مقالاً. العتبة على النص المستخرج بعد إزالة الوسوم — القالب يُخرج شيئاً
     تافهاً، والمقال الحقيقي يُخرج مئات الأحرف. */
  if (e === '.html' || e === '.htm') {
    return String(text || '').trim().length >= 200 ? 'document' : 'code';
  }
  if (CODE_EXTS.includes(e)) return 'code';
  if (DOC_EXTS.includes(e)) return 'document';

  // امتدادات بيانات بنيوية
  if (['.json', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.ini', '.cfg', '.env'].includes(e)) {
    return 'data';
  }
  if (e === '.md' || e === '.rst') return 'document';

  // بقية النصوص: نستنتج من المحتوى
  const t = String(text || '').trim();
  if (!t) return 'file';
  if (t.length > 4000) return 'document';
  return 'file';
}

// ─────────────────────────────── ميتاداتا ───────────────────────────────

/** عنوان + لغة + أسطر + محارف. */
function extractMeta(filePath, text) {
  const t = typeof text === 'string' ? text : '';
  const base = path.basename(String(filePath || ''));
  const ext = path.extname(base).replace('.', '').toLowerCase();

  let title = '';
  const h1 = t.match(/^\s*#\s+(.+?)\s*$/m); // أول عنوان ماركداون
  if (h1) title = h1[1].trim();
  if (!title) title = base ? base.replace(/\.[^.]+$/, '') : '(بلا اسم)';

  const lines = t === '' ? 0 : t.split(/\r\n|\r|\n/).length;

  return {
    title,
    language: LANG_MAP[ext] || (ext || 'unknown'),
    lines,
    chars: t.length,
  };
}

// ───────────────────────── فحوص المسار والأمان ─────────────────────────

/**
 * كود خطأ نظام → رسالة عربية ثابتة.
 * لا نص errno ولا مسار مطلق في أي رد (§20 «لا ادعاء»، §37 حدود الثقة):
 * رسالة Node الخام مثل «EPERM: operation not permitted, lstat 'C:\...'»
 * تسرّب بنية القرص للمستدعي، لذلك تُترجم هنا قبل مغادرة الوحدة.
 */
function errnoMessage(e) {
  const code = e && typeof e.code === 'string' ? e.code : '';
  switch (code) {
    case 'EPERM':
    case 'EACCES': return 'مسار محمي أو صلاحية مرفوضة';
    case 'ENOENT': return 'المسار غير موجود';
    case 'ENOTDIR': return 'جزء من المسار ليس مجلداً';
    case 'EISDIR': return 'المسار مجلد لا ملف';
    case 'ELOOP': return 'حلقة روابط رمزية مرفوضة';
    case 'EINVAL': return 'مسار غير صالح';
    case 'ENAMETOOLONG': return 'مسار أطول من الحد المسموح';
    case 'EBUSY': return 'المسار مشغول';
    default: return i18n.T('تعذّر الوصول إلى المسار', 'Cannot access the path');
  }
}

/**
 * شبكة أمان أخيرة: تنظيف أي نص قادم من رسالة نظام قبل إعادته للمستدعي.
 * تُبقي الكلام العربي وتُبدّل المسارات المطلقة ورموز errno بعناصر محايدة.
 */
function scrubSystemText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/[A-Za-z]:[\\/][^\s'"]*/g, '[مسار]');
  s = s.replace(/(^|[\s(<])\/(?:[^\s'")]+)/g, '$1[مسار]');
  s = s.replace(/\bE[A-Z]{2,}\b/g, '[رمز]');
  s = s.replace(/\b(?:operation not permitted|permission denied|no such file or directory|access is denied|invalid argument)\b/gi, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/** اسم الملف وحده للمرجع في الرد — لا مسار مطلق (§37). */
function publicName(p) {
  const s = String(p == null ? '' : p);
  if (!s.trim()) return '';
  return path.basename(s) || '';
}

/** يحل المسار ليكشف الروابط الرمزية، ويرفض البايت الصفري والأشباح. */
function safeResolve(filePath) {
  const p = String(filePath == null ? '' : filePath);
  if (!p.trim()) throw new Error('مسار مفقود');
  if (p.includes('\u0000')) throw new Error('مسار غير صالح: يحتوي بايتاً صفرياً');
  try {
    return fs.realpathSync(path.resolve(p)); // realpath يكشف الروابط الرمزية
  } catch (e) {
    if (e.code === 'ENOENT') {
      // غير موجود: نتحقق من أن الأب ليس رابطاً رمزياً، ثم نعيد المسار المحلول
      const dir = path.dirname(path.resolve(p));
      let realDir;
      try { realDir = fs.realpathSync(dir); } catch (_) { realDir = path.resolve(dir); }
      return path.join(realDir, path.basename(p));
    }
    // لا نمرّر نص النظام (EPERM + المسار المطلق) إلى طبقة الرد — §20/§37
    const clean = new Error(errnoMessage(e));
    clean.code = e && e.code;
    clean.clean = true;
    throw clean;
  }
}

/** هل المسار داخل أحد الجذور المسموحة؟ يرفض الهروب بـ .. */
function isInsideRoots(realPath, allowedRoots) {
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => {
      const abs = path.resolve(r);
      try { return fs.realpathSync(abs); } catch (_) { return abs; }
    });

  if (!roots.length) return { ok: false, reason: 'لا جذور مسموحة معرّفة (allowedRoots فارغة)' };

  const target = path.resolve(realPath);
  for (const root of roots) {
    const rel = path.relative(root, target);
    if (rel === '') return { ok: true };
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { ok: true };
  }
  return { ok: false, reason: 'المسار خارج الجذور المسموحة (محاولة هروب مرفوضة)' };
}

// ───────────────────────────── الاستيراد ─────────────────────────────

/** بصمة SHA-256 للملف. */
async function fingerprint(filePath) {
  const buf = await fsp.readFile(filePath);
  return { hash: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

/**
 * كشف تكرار الاستيراد (§19 «يُحفظ ما استُورد كاملاً» + منع التكرار الأعمى):
 * البصمة كانت تُحسَب وتُهمَل — نفس الملف مرتين كان يُنتج عنصرين.
 * القاعدة: البصمة تُستعلَم قبل أي إضافة، والقرار يُعاد صراحةً للمستدعي.
 * @returns {{duplicate:boolean, id?:string, source?:string, imported_at?:string}}
 */
function findDuplicate(db, fingerprint) {
  if (!db || !fingerprint) return { duplicate: false };
  try {
    const row = db.prepare(
      'SELECT id, source, imported_at, original_path FROM document_entities WHERE fingerprint = ? LIMIT 1'
    ).get(fingerprint);
    if (row && row.id) {
      // الحقول مُوحّدة مع ما يستهلكه الخادم (existingId/existingTitle/existingImportedAt)
      // — الاختلاف في الأسماء كان يُنتج «مكرر» بلا مُعرّف يُعلَن (تدقيق 2026-10-20).
      return {
        duplicate: true,
        existingId: row.id,
        existingTitle: null,
        existingImportedAt: row.imported_at || null,
        id: row.id,
        source: row.source || row.original_path || null,
        imported_at: row.imported_at || null,
      };
    }
  } catch { /* لا فهرس/جدول بعد — لا تكرار معروف */ }
  return { duplicate: false };
}

/**
 * الاستيراد الرئيسي — قراءة فقط، بلا تنفيذ وبلا منح صلاحيات (§21).
 * @param {{path:string, allowedRoots:string[]}} opts
 */
/* ملفات الأسرار: لا تُستورد إلى المعرفة (تقرير هجومي 2026-10-26 F13).
   السبب: الاستيراد ينسخ المحتوى إلى جدول الملاحظات، وقراءة الملاحظة لا تشترط
   رمز جلسة — فملف مفاتيح داخل المشروع يصير نصاً مكشوفاً بضغطة استيراد واحدة.
   الرفض صريح ومترجم، والاسم وحده يُذكر (لا محتوى ولا مسار مطلق). */
const SECRET_BASENAMES = /^(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|credentials\.json|secrets?\.(?:json|ya?ml|env|txt|ini))$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|pfx|p12|jks|keystore|asc|ppk)$/i;
function isSecretFile(filePath) {
  const base = path.basename(String(filePath || ''));
  return SECRET_BASENAMES.test(base) || SECRET_EXTENSIONS.test(base);
}

async function importFile(opts) {
  // غلاف الرفض: كل رد فاشل يحمل ok:false/rejected:true صراحةً.
  // كان الرد {error,name} فقط، فيُعاد كما هو من server.js:1520 بلا حقل ok
  // فيبدو للمستدعي كأنه نجاح (اختبار المسار المحمي كان يفشل على ok === false).
  const out = await importFileImpl(opts);
  if (out && out.error) {
    out.ok = false;
    out.rejected = true;
  }
  return out;
}

/** التنفيذ الفعلي — لا يُصدَّر ولا يُستدعى إلا عبر importFile. */
async function importFileImpl(opts) {
  try {
    const filePath = opts && opts.path;
    const allowedRoots = opts && opts.allowedRoots;

    // 1) تحقق المسار والنطاق
    let real;
    try {
      real = safeResolve(filePath);
    } catch (e) {
      return { error: i18n.T('مسار مرفوض: ', 'Path rejected: ') + errnoMessage(e), name: publicName(filePath) };
    }

    const scope = isInsideRoots(real, allowedRoots);
    if (!scope.ok) return { error: scope.reason, name: publicName(real) };

    // 2) تحقق الوجود وأنه ملف
    let st;
    try {
      st = await fsp.stat(real);
    } catch (e) {
      if (e.code === 'ENOENT') return { error: 'الملف غير موجود', name: publicName(real) };
      return { error: 'تعذّر قراءة الملف: ' + errnoMessage(e), name: publicName(real) };
    }
    if (!st.isFile()) return { error: 'المسار ليس ملفاً', name: publicName(real) };

    // 2.5) ملف أسرار — لا يدخل المعرفة أصلاً (F13)
    if (isSecretFile(real)) {
      return {
        error: i18n.T('ملف أسرار لا يُستورد إلى المعرفة: ', 'Secret files are not imported into knowledge: ') + publicName(real),
        name: publicName(real),
        secretRefused: true,
        rejected: true,
      };
    }

    // 3) الامتداد — رفض صادق بلا ادعاء قراءة (§20)
    const ext = normExt(path.extname(real));
    const sup = isSupported(ext);
    if (!sup.ok) {
      return {
        error: 'صيغة غير مدعومة',
        ext,
        supported: IMPORTABLE_EXTENSIONS,
        name: publicName(real),
      };
    }

    // 4) المعالج
    const handler = HANDLERS[ext];
    let res;
    try {
      res = await handler(real);
    } catch (e) {
      return { error: 'فشل معالجة الملف: ' + errnoMessage(e), name: publicName(real), ext };
    }

    // 5) نتيجة غير مدعومة من المعالج
    if (!res || res.unsupported) {
      return {
        error: scrubSystemText((res && res.reason) || 'المعالج لم يُنتج محتوى'),
        unsupported: true,
        needsOcr: !!(res && res.needsOcr),
        name: publicName(real),
        ext,
      };
    }

    // 6) البصمة
    const fp = await fingerprint(real);

    // 7) استخلاص المحتوى الرئيسي (HTML) ثم عزل الحقن
    // الترتيب مقصود: الاستخلاص **قبل** stripInjection، لأن عزل الحقن يوسّع المطابقة
    // إلى نهاية السطر — فمستند HTML مصغّر في سطر واحد كان يُستبدل كلّه بـ[مُعزَل].
    const rawText = typeof res.text === 'string' ? res.text : '';
    const { text, extraction, extractionMeta } = cleanImportedText(rawText, {
      ext, contentType: res.contentType || '',
    });
    const { clean, stripped } = stripInjection(text);

    return {
      ok: true,
      path: real,
      ext,
      // صفحة استُخلص مقالها = مستند؛ وملف HTML بلا مقال (قالب/كود) يبقى 'code'.
      kind: extraction === 'main' ? 'document' : detectKind(ext, text),
      fingerprint: fp.hash,
      size: fp.bytes,
      bytes: fp.bytes,
      // قائمة الأرشيف تُمرَّر أيضاً داخل meta: رد النجاح في server.js:1590-1598
      // لا ينسخ الحقل العلوي archive (يُحفظ في analysis فقط)، فبدونه لا يرى
      // المستدعي أي فهرسة. meta يُعاد كما هو (server.js:1592).
      meta: { ...(extractMeta(real, text) || {}), ...(extractionMeta || {}), ...(res.archive ? { archive: res.archive } : {}) },
      clean,
      stripped,
      strippedCount: stripped.length,
      unsupported: false,
      archive: res.archive || null, // قائمة المحتويات إن كان أرشيفاً (بلا استخراج)
    };

  } catch (e) {
    return { error: 'تعذّر إكمال الاستيراد: ' + errnoMessage(e) };
  }
}

// ─────────────────────────── الاستيراد الجماعي ───────────────────────────
//
// طبقة الدفعات: تجوال مجلد محلي، أو clone مستودع git إلى مجلد مؤقت ابن
// os.tmpdir() حصراً، ثم مرور واحد على كل ملف مؤهل عبر importFile نفسها
// (بصمة SHA-256 + stripInjection لكل ملف). لا shell:true مطلقاً،
// ولا تنفيذ للمحتوى المستورد — بيانات لا أوامر (دستور §21).

/** مجلدات مستبعدة من التجوال (تُقارن بحروف صغيرة). */
const WALK_SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next',
  '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache',
  'coverage', '.cache', '.idea', '.vscode',
]));

/** حد افتراضي لعدد الملفات في الدفعة الواحدة. */
const DEFAULT_MAX_FILES = 400;

/** حد أقصى مطلق — الرفض الصريح أفضل من حلقة لا تنتهي. */
const HARD_MAX_FILES = 5000;

/** عمق أقصى لشجرة التجوال. */
const MAX_WALK_DEPTH = 32;

/** ملف مؤهل بالامتداد وقواعد الاستبعاد (مجلدات النظام، المخفي، الصيغ غير المدعومة). */
function isCandidateFile(name, ignoredDirs) {
  const ext = normExt(path.extname(name));
  if (!ext || !IMPORTABLE_EXTENSIONS.includes(ext)) return false;
  if (ignoredDirs.has(name.toLowerCase())) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/**
 * يمشي شجرة مجلدات ويجمع الملفات المؤهلة (مسارات مطلقة حقيقية) حتى maxFiles.
 * - يقفز .git/node_modules والمجلدات المخفية، لا يتبع الروابط الرمزية للمجلدات،
 *   ويتحقق أن كل ملف يقع داخل أحد allowedRoots عبر isInsideRoots.
 * @returns {Promise<{files:string[], scannedDirs:number, considered:number, capped:boolean}>}
 */
async function walkFolder(rootDir, { maxFiles = DEFAULT_MAX_FILES, ignoredDirs = WALK_SKIP_DIRS, allowedRoots = [] } = {}) {
  const files = [];
  let scannedDirs = 0;
  let considered = 0;
  let overflow = 0; // تجاوزات سقف maxFiles وحدها — منفصلة عن المرفوض لسبب آخر
  // ميزانية مسح مستقلة عن السقف: تسمح بقياس التجاوز الحقيقي بلا مسح شجرة لا نهائية.
  const scanBudget = maxFiles * 2 + 64;
  let exhausted = false;

  async function recurse(dir, depth) {
    if (exhausted || depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // مجلد غير قابل للقراءة — يُتخطى ولا يُسقط الدفعة
    }
    scannedDirs++;
    for (const entry of entries) {
      if (considered >= scanBudget) { exhausted = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // ليس symlink ( entry.isDirectory === false للروابط على ويندوز/لينكس مع withFileTypes)
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.') || ignoredDirs.has(entry.name.toLowerCase())) continue;
        await recurse(full, depth + 1);
        if (exhausted) return;
      } else if (entry.isFile()) {
        if (entry.isSymbolicLink()) continue;
        if (!isCandidateFile(entry.name, ignoredDirs)) continue;
        considered++;
        let real = null;
        try { real = await fsp.realpath(full); } catch { continue; }
        if (allowedRoots.length && !isInsideRoots(real, allowedRoots).ok) continue;
        // الملف مؤهل فعلاً: إما يدخل الدفعة أو يُسجّل تجاوزاً صريحاً للسقف (§20 لا ادعاء)
        if (files.length < maxFiles) files.push(real);
        else overflow++;
      }
    }
  }

  await recurse(rootDir, 0);
  // capped صادق: لا يُعلن إلا عند وجود ملف مؤهل حقيقي أُسقط بسبب السقف،
  // لا بسبب realpath/الجذور/الامتداد (كان considered > files.length يخلط بينها).
  return { files, scannedDirs, considered, capped: overflow > 0, overflow };
}

/**
 * استيراد كل ملفات مجلد عبر importFile — نفس مسار الاستيراد الفردي لكل ملف:
 * بصمة SHA-256 + stripInjection + كشف النوع، والفحص والحجر في طبقة الخادم.
 * @param {{path:string, allowedRoots:string[], maxFiles?:number}} opts
 * @returns {Promise<object>} { rejected, reason?, root?, total, ok, error, skipped, capped, perFile }
 */
async function importFolder(opts) {
  let rootPath = null;
  try {
    rootPath = safeResolve(opts && opts.path);
  } catch (e) {
    // reason فقط — لا حقل path: الخادم يمرّره للمستدعي كما هو (server.js:1504)
    return { rejected: true, reason: i18n.T('مسار مرفوض: ', 'Path rejected: ') + errnoMessage(e), created: 0, skipped: 0, quarantined: 0, perFile: [] };
  }
  const allowedRoots = (opts && opts.allowedRoots) || [];
  const maxFiles = Math.max(1, Math.min(Number(opts && opts.maxFiles) || DEFAULT_MAX_FILES, HARD_MAX_FILES));

  const scope = isInsideRoots(rootPath, allowedRoots);
  if (!scope.ok) {
    return { rejected: true, reason: scope.reason, created: 0, skipped: 0, quarantined: 0, perFile: [] };
  }

  let st = null;
  try { st = await fsp.stat(rootPath); } catch {
    return { rejected: true, reason: 'المجلد غير موجود', created: 0, skipped: 0, quarantined: 0, perFile: [] };
  }
  if (!st.isDirectory()) {
    return { rejected: true, reason: 'المسار ليس مجلداً', created: 0, skipped: 0, quarantined: 0, perFile: [] };
  }

  const walk = await walkFolder(rootPath, { maxFiles, allowedRoots });
  const perFile = [];
  let ok = 0;
  let err = 0;
  for (const file of walk.files) {
    // مسار نسبي آمن للعرض: يميّز sub/c.md من c.md (اسم فقط كان يخلط الملفات المتشابهة)
    const rel = path.relative(rootPath, file).split(path.sep).join('/');
    const r = await importFile({ path: file, allowedRoots });
    if (r.ok) {
      ok++;
      perFile.push({
        path: rel,
        /* المسار المطلق للهوية والنسخ (§19): rel للعرض فقط — الاعتماد على path
           النسبي كان يُفشل نسخ الأصول بصمت (assetSaved=false مُقاس 2026-10-24). */
        abs: file,
        name: publicName(r.path), ext: r.ext, kind: r.kind, fingerprint: r.fingerprint,
        size: r.size, title: r.meta?.title || publicName(r.path),
        strippedCount: r.strippedCount || 0, clean: r.clean || '', meta: r.meta || null,
      });
    } else {
      err++;
      // فشل: المسار النسبي فقط بدل المسار المطلق (كان يمرّر r.path||file خاماً إلى الرد)
      perFile.push({ path: rel, name: publicName(r && r.name) || publicName(file), error: r.error || 'فشل غير معروف' });
    }
  }

  return {
    rejected: false,
    root: rootPath,
    total: walk.files.length,
    scanned: walk.considered, // كل ملف مؤهل رآه التجوال — أساس محاسبة created+skipped
    ok,
    error: err,
    // skipped: ما أُسقط بسبب سقف maxFiles فقط + ما رفضه importFile نفسه.
    // كان considered - files.length فيخلط المرفوض بالجذور/realpath مع المقتطع بالسقف.
    skipped: walk.overflow + err,
    capped: walk.capped,
    overflow: walk.overflow,
    perFile,
  };
}

// ───────────────────────── استيراد مستودع git ─────────────────────────

/** مضيفون لا يُستنسخون — محليون أو داخل شبكات خاصة/روابط سحابية داخلية. */
const FORBIDDEN_HOSTS = Object.freeze(new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0',
  'metadata', '169.254.169.254',
]));

/** توحيد شكل العنوان قبل الفحص.
 *  عطل مُقاس 2026-11-11: `new URL('https://[fd00::1]/').hostname` يعيد **`[fd00::1]`
 *  بأقواس**، فكل فحوص IPv6 النصّية (`startsWith('fc')`) كانت تفشل ⇒ المدخل يُقبل.
 *  ونفس العطل مع IPv4 المُغلَّف: `::ffff:127.0.0.1` لم يكن يُختصر إلى IPv4. */
function normalizeIp(input) {
  let h = String(input || '').toLowerCase().trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const mapped = h.match(/^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return mapped ? mapped[1] : h;
}

/** نطاقات IP المحجوزة (IPv4/IPv6) — SSRF حاجز ثانٍ بعد أسماء المضيفين. */
function isPrivateOrReservedIp(input) {
  const s = normalizeIp(input);
  if (!s) return true;
  if (s.includes(':')) {
    /* IPv6: يُسمح **فقط** بالنطاق العام 2000::/3. كل ما عداه (::1, fc00::/7,
       fe80::/10, ff00::/8, والمُغلَّف الذي لم يُختصر) محجوز أو خاص. القائمة
       السوداء النصّية السابقة كانت تفلت من كل صيغة غير مذكورة حرفياً. */
    if (s === '::1' || s === '::') return true;
    const first = parseInt(s.split(':')[0] || '0', 16);
    if (!Number.isFinite(first)) return true;
    return !(first >= 0x2000 && first <= 0x3fff);
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;   // ليس IPv4 ولا IPv6 ⇒ لا نعرف ما هو ⇒ نرفض
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;      // multicast + reserved
  if (a === 192 && b === 0) return true;  // 192.0.0.0/24 و 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/** حل الـ hostname كله قبل clone — منع DNS rebinding عبر التحقق من كل عنوان مُعاد. */
async function resolvePublicHost(hostname) {
  /* المضيف الحرفي: IPv4 (أرقام ونقاط) أو IPv6 (يحوي ':') — والفاحص نفسه يوحّد
     الأقواس والتغليف. (كان يقبل أي نص يحوي ':' كـ«حرفي» ثم لا يفحصه فعلياً.) */
  const isLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isLiteral) return isPrivateOrReservedIp(hostname) ? { ok: false, reason: `العنوان ${hostname} محجوز/خاص ولا يُستنسخ` } : { ok: true };
  let addrs = [];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `تعذّر حل المضيف ${hostname} — تأكد من الاتصال أو الاسم` };
  }
  if (!addrs.length) return { ok: false, reason: `لم يُعثر على عنوان للمضيف ${hostname}` };
  const bad = addrs.find((a) => isPrivateOrReservedIp(a.address));
  if (bad) return { ok: false, reason: `المضيف ${hostname} يحل إلى عنوان غير عام (${bad.address}) — مرفوض` };
  return { ok: true };
}

/**
 * تحقق أمني صارم لـ URL مستودع git: https حصراً، بلا معلومات دخول، مضيف غير
 * محجوز، ومسار نظيف من أي شكل من أشكال .. — فحص على ثلاث طبقات مستقلة:
 *   1) السلسلة الخام كما أُرسلت (قبل أي تحليل) — تصلب ضد الترميز التافه.
 *   2) المسار المفكوك الترميز من السلسلة الخام — يكشف %2e%2e و%252e وأي تركيب
 *      مزدوج قبل أن يُطبّع URL ما وصل من نقاط، لأن new URL يقضي على .. داخل
 *      pathname فيختفي من الطبقات التحليلية بعد التحليل.
 *   3) pathname بعد التحليل — أمان إضافي إن نقص شيء.
 * يرفض في أي طبقة: أي مقطع يساوي '..' أو يحوي '..'، أو بايت صفري، أو '\\'.
 *
 * ملاحظة صريحة: clone بمسار قرص محلي لا يمر من هنا — هذا المدقق للشبكة فقط.
 */
function validateGitUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, reason: i18n.T('عنوان المستودع مفقود', 'Repository address is missing') };

  // الطبقة 1: السلسلة الخام قبل أي تحليل
  if (url.includes('..')) return { ok: false, reason: 'العنوان يحتوي .. — تجوال مسار مرفوض' };
  if (url.includes('\0') || url.includes('\\')) {
    return { ok: false, reason: 'العنوان يحتوي بايت صفري أو فاصل ويندوز — مرفوض' };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, reason: 'بروتوكول غير آمن: https فقط مقبول' };
  }

  // الطبقة 2: فك ترميز السلسلة الخام كاملة — قبل أن يخفي URL النقاط بالتطبيع.
  let decodedRaw = url;
  for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(decodedRaw); i++) {
    try { decodedRaw = decodeURIComponent(decodedRaw); } catch { break; }
  }
  if (decodedRaw !== url) {
    if (decodedRaw.includes('..')) return { ok: false, reason: 'العنوان المفكوك يحتوي .. — تجوال مرفوض' };
    if (decodedRaw.includes('\0') || decodedRaw.includes('\\')) {
      return { ok: false, reason: 'العنوان المفكوك يحتوي بايت صفري أو فاصل ويندوز — مرفوض' };
    }
    if (!/^https:\/\//i.test(decodedRaw)) {
      return { ok: false, reason: 'العنوان المفكوك تغيّر بروتوكوله — مرفوض' };
    }
  }

  let u = null;
  try { u = new URL(url); } catch {
    return { ok: false, reason: 'عنوان url غير صالح' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'بروتوكول غير آمن: https فقط مقبول' };
  }
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'المضيف مفقود في العنوان' };
  if (FORBIDDEN_HOSTS.has(host) || FORBIDDEN_HOSTS.has(u.host.toLowerCase())) {
    return { ok: false, reason: `المضيف ${host} محجوز ولا يُستنسخ` };
  }
  if (url.includes('@')) {
    return { ok: false, reason: 'عنوان يحمل معلومات دخول (user@) مرفوض' };
  }

  // الطبقة 3: pathname بعد التحليل — أمان إضافي إن فاتنا شيء
  const rawPath = u.pathname || '';
  if (rawPath.split('/').includes('..')) {
    return { ok: false, reason: 'مسار المستودع يحتوي مقطع .. — مرفوض' };
  }

  return { ok: true, url, host, needsDnsCheck: !/^[\d.]+$/.test(host) && !host.includes(':') };
}

/**
 * يستنسخ مستودع git عبر spawnSync مصفوفية صارمة (بلا shell:true وبلا بناء أمر
 * نصي)، إلى مجلد مؤقت ابن os.tmpdir() حصراً، ثم يستورد ملفاته بمسار importFolder،
 * ثم يمسح المؤقت نهائياً حتى عند الفشل (finally).
 * في بيئة معزولة عن الإنترنت سيفشل clone الشبكي حتماً (تعذّر حل DNS أو وصول الشبكة) —
 * هذا فشل بيئة متوقع ومصرّح به في توثيق الاختبارات، لا عطل كود.
 */
/**
 * بيئة مصادقة git للمستودعات الخاصة (م18 «عامة وخاصة وفق الصلاحيات» — 2026-10-29).
 * كانت المصادقة معطلة قصداً (GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=echo) فلا مستودع
 * خاص يُستنسخ. الحل الآمن: إن وُضع CORTEX_GIT_TOKEN في بيئة الخادم يُمرَّر كترويسة
 * HTTP عبر GIT_CONFIG_* (بيئة، لا argv — لا يظهر في قائمة العمليات، ولا يُكتب على
 * قرص). بلا توكن: {} — السلوك القديم حرفياً (فشل فوري بلا مطالبات).
 */
function buildGitAuthEnv(env = {}) {
  const token = String(env.CORTEX_GIT_TOKEN || '').trim();
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

async function importGitRepo(opts) {
  const check = validateGitUrl(opts && opts.url);
  const maxFiles = Math.max(1, Math.min(Number(opts && opts.maxFiles) || DEFAULT_MAX_FILES, HARD_MAX_FILES));
  const depth = Math.min(Math.max(1, Number(opts && opts.depth) || 1), 16);

  if (!check.ok) {
    return { rejected: true, reason: check.reason, clonedInto: null, created: 0, skipped: 0, quarantined: 0, perFile: [] };
  }
  if (check.needsDnsCheck) {
    const dnsCheck = await resolvePublicHost(check.host);
    if (!dnsCheck.ok) {
      return { rejected: true, reason: dnsCheck.reason, clonedInto: null, created: 0, skipped: 0, quarantined: 0, perFile: [] };
    }
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-git-clone-'));
  try {
    const result = spawnSync('git', ['-c', 'credential.helper=', 'clone', '--depth', String(depth), check.url, tmpDir], {
      encoding: 'utf8',
      timeout: 120000,                 // سقف زمني صريح
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      shell: false,                    // بلا صدفة — لا تفسير محارف
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',      // لا مطالبات دخول — فشل فوري بدل التعليق
        GIT_ASKPASS: 'echo',
        // مصادقة المستودعات الخاصة (م18): توكن بيئي يُمرَّر عبر GIT_CONFIG_* على البيئة
        // لا في argv (لا يظهر في قائمة العمليات) ولا على القرص — ينشط فقط إن وُضع.
        ...buildGitAuthEnv(process.env),
      },
    });

    if (result.error || result.status !== 0) {
      // تطهير: لو مرّر المستخدم عنواناً يحمل توكن داخل URL، لا يظهر في رسالة الخطأ
      const stderr = String(result.stderr || '').trim().split('\n').slice(-3).join(' | ')
        .replace(/\/\/[^/@\s]+@/g, '//***@');
      return {
        rejected: true,
        reason: 'فشل git clone: ' + (result.error ? result.error.message : (stderr || `exit ${result.status}`)),
        clonedInto: tmpDir, created: 0, skipped: 0, quarantined: 0, perFile: [],
      };
    }

    const walk = await walkFolder(tmpDir, { maxFiles, allowedRoots: [tmpDir] });
    const perFile = [];
    let ok = 0;
    let err = 0;
    for (const file of walk.files) {
      const r = await importFile({ path: file, allowedRoots: [tmpDir] });
      if (r.ok) {
        ok++;
        const rel = path.relative(tmpDir, r.path).split(path.sep).join('/');
        perFile.push({
          path: rel || path.basename(r.path), ext: r.ext, kind: r.kind,
          fingerprint: r.fingerprint, size: r.size,
          title: r.meta?.title || path.basename(r.path),
          strippedCount: r.strippedCount || 0, clean: r.clean || '', meta: r.meta || null,
        });
      } else {
        err++;
        perFile.push({ path: path.relative(tmpDir, file).split(path.sep).join('/'), error: r.error || 'فشل غير معروف' });
      }
    }
    return {
      rejected: false,
      clonedInto: tmpDir,
      total: walk.files.length,
      ok, error: err,
      skipped: (walk.capped ? Math.max(0, walk.considered - walk.files.length) : 0) + err,
      capped: walk.capped,
      perFile,
    };
  } catch (e) {
    return {
      rejected: true,
      reason: errnoMessage(e) || 'خطأ غير معروف أثناء الاستنساخ',
      clonedInto: tmpDir, created: 0, skipped: 0, quarantined: 0, perFile: [],
    };
  } finally {
    // التنظيف النهائي المؤكد: مجلد الاستنساخ المؤقت يزول دائماً — نجاحاً وفشلاً
    try { await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* تنظيف نهائي تالف — لا يُسقط النتيجة */ }
  }
}

// ───────────────────────── استيراد من ويب (URL) ─────────────────────────
// §20: جلب محتوى من عنوان URL — https فقط، مضيف عام، لا إعادة توجيه، لا تنفيذ.
// لا يُدعى validateGitUrl (هو للمستودعات git فقط)؛ الفحص هنا مستقل بنفس strictness.
async function importWeb(opts) {
  const url = String(opts && opts.url || '').trim();
  const allowedRoots = (opts && opts.allowedRoots) || [];
  if (!url) return { error: i18n.T('العنوان مفقود', 'Address is missing'), path: null };

  // 1) بروتوكول آمن فقط
  if (!/^https:/i.test(url)) {
    return { error: 'بروتوكول غير آمن: https فقط مقبول', path: null, unsupported: true };
  }
  // 2) لا معلومات دخول في العنوان
  if (url.includes('@')) return { error: 'العنوان يحمل معلومات دخول (user@) — مرفوض', path: null };

  let u;
  try { u = new URL(url); } catch { return { error: 'عنوان url غير صالح', path: null }; }
  const host = u.hostname.toLowerCase();

  // 3) مضيف عام — منع الشبكات الخاصة / loopback المحلية / العناوين المحجوزة (SSRF)
  if (FORBIDDEN_HOSTS.has(host) || FORBIDDEN_HOSTS.has(u.host.toLowerCase())) {
    return { error: `المضيف ${host} محجوز ولا يُستورد`, path: null };
  }
  // IPv خاص: حل المضيف والتحقق من كل عنوان معاد — حاجز ضد DNS rebinding
  if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
    try {
      const addrs = await dns.lookup(host, { all: true, verbatim: true });
      const bad = addrs.find((a) => isPrivateOrReservedIp(a.address));
      if (bad) return { error: `المضيف يحل إلى عنوان غير عام (${bad.address}) — مرفوض`, path: null };
    } catch { /* DNS فشل → لا(address) يُمنع */ }
  }

  // 4)جلب بمهلة، redirect: 'error' — رفض أي إعادة توجيه (مسار الانحراف)
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: { 'User-Agent': 'Cortex/5.0 (import-web; local; no-execution)' },
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return { error: 'انتهت مهلة جلب العنوان — تأكد من الاتصال أو العنوان', path: null };
    }
    return { error: `تعذّر الوصول إلى العنوان (${url}): ${scrubSystemText(errnoMessage(e))}`, path: null };
  }

  if (!response.ok) {
    return { error: `الخادم أرجع ${response.status}: ${response.statusText}`, path: null };
  }

  const ct = response.headers.get('content-type') || '';
  const extFromUrl = path.extname(u.pathname).toLowerCase();
  // إذا لا امتداد في URL، اشتق من content-type
  let ext = extFromUrl || '';
  if (!ext) {
    if (ct.includes('text/html')) ext = '.html';
    else if (ct.includes('application/json')) ext = '.json';
    else if (ct.includes('text/plain')) ext = '.txt';
    else if (ct.includes('text/markdown')) ext = '.md';
    else ext = '.bin';
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const rawText = buf.toString('utf8');

  // 5) البصمة والميتاداتا (§19)
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  /* 6) استخلاص المحتوى الرئيسي ثم عزل الحقن — بنفس ترتيب مسار الملفات، وللسبب
     نفسه: العزل يوسّع المطابقة إلى نهاية السطر، فصفحة مصغّرة في سطر واحد كانت
     تُمحى كلها. والناتج Markdown نظيف لا HTML خام (عطل مُقاس ratio = 1.000). */
  const { text, extraction, extractionMeta } = cleanImportedText(rawText, {
    ext, contentType: ct, url,
  });
  const { clean, stripped } = stripInjection(text);

  // مسار افتراضي — لا يوجد ملف على القرص فعلياً؛ المسار هو عنوان URL فقط ولا يُسمح بالكتابة عليه
  const virtualPath = `__web__/${host}${u.pathname}${ext ? '' : ''}`;

  return {
    ok: true,
    path: virtualPath,
    ext,
    // صفحة استُخلص مقالها = مستند، لا كود
    kind: extraction === 'main' ? 'document' : detectKind(ext, text),
    fingerprint: hash,
    size: buf.length,
    bytes: buf.length,
    meta: {
      ...extractionMeta,
      // عنوان الملف الاحتياطي لا يسبق عنوان الصفحة الحقيقي
      title: (extractionMeta && extractionMeta.title) || path.basename(u.pathname) || 'imported-from-web',
      source: url,
      contentType: ct,
      fetchedAt: new Date().toISOString(),
      language: (extractionMeta && extractionMeta.language) || LANG_MAP[ext] || 'text',
    },
    clean,
    stripped,
    strippedCount: stripped.length,
    unsupported: false,
    archive: null,
  };
}

// ───────────────────────── مزامنة الملفات (مجلد→مجلد) ─────────────────────────
// §21: مزامنة دورية من مصدر خارجي إلى هدف محلي.
// يكشف التغييرات عبر mtim+الحجم ويُنقل فقط الجديد/المُعدّل. لا ينفّذ أي محتوى — بيانات لا أوامر.
async function syncFiles(opts) {
  const source = opts && opts.source;
  const target = opts && opts.target;
  const allowedRoots = (opts && opts.allowedRoots) || [];
  if (!source || !target) return { synced: 0, skipped: 0, error: i18n.T('المصدر والهدف مطلوبان', 'Source and destination are required'), files: [] };

  let srcReal, tgtReal;
  try { srcReal = safeResolve(source); } catch (e) { return { synced: 0, skipped: 0, error: 'مسار مصدر مرفوض: ' + errnoMessage(e), files: [] }; }
  try { tgtReal = safeResolve(target); } catch (e) { return { synced: 0, skipped: 0, error: 'مسار هدف مرفوض: ' + errnoMessage(e), files: [] }; }

  const sScope = isInsideRoots(srcReal, allowedRoots);
  const tScope = isInsideRoots(tgtReal, allowedRoots);
  if (!sScope.ok) return { synced: 0, skipped: 0, error: sScope.reason, files: [] };
  if (!tScope.ok) return { synced: 0, skipped: 0, error: tScope.reason, files: [] };

  let srcStat;
  try { srcStat = await fsp.stat(srcReal); } catch { return { synced: 0, skipped: 0, error: 'المصدر غير موجود', files: [] }; }
  if (!srcStat.isDirectory()) return { synced: 0, skipped: 0, error: 'المصدر ليس مجلداً', files: [] };

  await fsp.mkdir(tgtReal, { recursive: true });

  const walk = await walkFolder(srcReal, { maxFiles: HARD_MAX_FILES, allowedRoots });
  let synced = 0, skipped = 0;
  const files = [];

  for (const file of walk.files) {
    const rel = path.relative(srcReal, file).split(path.sep).join('/');
    const dest = path.join(tgtReal, rel);
    let srcSt;
    try { srcSt = await fsp.stat(file); } catch { continue; }
    let dstSt;
    try { dstSt = await fsp.stat(dest); } catch { dstSt = null; }

    const changed = !dstSt || dstSt.mtimeMs !== srcSt.mtimeMs || dstSt.size !== srcSt.size;
    if (!changed) { skipped++; files.push({ rel, status: 'unchanged' }); continue; }

    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(file, dest);
      synced++;
      files.push({ rel, status: 'synced', bytes: srcSt.size });
    } catch (e) {
      files.push({ rel, status: 'failed', error: errnoMessage(e) });
    }
  }

  return { synced, skipped, files, source: srcReal, target: tgtReal };
}

// ─────────────────────────── التصدير ───────────────────────────

module.exports = {
  findDuplicate,
  HANDLERS,
  IMPORTABLE_EXTENSIONS,
  isSupported,
  stripInjection,
  detectKind,
  extractMeta,
  importFile,
  importWeb,
  syncFiles,
  buildGitAuthEnv,
  // جماعي:
  importFolder,
  importGitRepo,
  validateGitUrl,
  walkFolder,
  isCandidateFile,
  WALK_SKIP_DIRS,
  DEFAULT_MAX_FILES,
  HARD_MAX_FILES,
};
