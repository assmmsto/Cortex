'use strict';
const i18n = require('./cortex-i18n');

/**
 * cortex-guard.js — حجر الملفات المشبوهة وفحصها في بيئة محدودة الصلاحيات
 * دستور §37 (حجر بدل معالجة) + §21 (كل عزل مُسجَّل) + §38 (لا محو أثر تدقيقي)
 *
 * المبدأ الحاكم: المستورَد بيانات لا أوامر.
 *  1) `assess` يفحص المحتوى فحصاً حتمياً بحتاً — لا نموذج، لا شبكة، لا تنفيذ.
 *  2) `quarantineFile` يحجر الملف المشبوه بلا حذفه وبلا معالجته في المسار العادي.
 *  3) كل إشارة تُقيَّد في `import_isolations`، وكل حجر يُقيَّد في `audit_log`.
 *  4) `guardPath` يقطع الطريق على أي مسار يحاول لمس ملف محجور.
 *  5) `scan` يفحص الملف داخل بيئة محدودة بقراءة محقونة (`reader`) وحجم مقيّد،
 *     ولا ينفّذه ولا يستورده إطلاقاً.
 *
 * ملاحظات صارمة:
 *  - لا `console.log` في هذه المكتبة.
 *  - لا آثار جانبية على القرص من أي دالة هنا.
 *  - كل الدوال حتمية: نفس المدخل ⇒ نفس المخرج.
 */

// مستويات الخطورة من المخطط إن توفّر، وإلا نسخة مطابقة محلية (الوحدة تبقى قابلة للاستخدام منفردة).
let SEVERITY_LEVELS;
try {
  ({ SEVERITY_LEVELS } = require('./cortex-schema'));
} catch { /* تشغيل منفرد بلا مخطط: نستخدم النسخة المحلية */ }
if (!Array.isArray(SEVERITY_LEVELS) || SEVERITY_LEVELS.length === 0) {
  SEVERITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
}

const LEVEL_RANK = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
});

// أكواد الإشارات الخمسة الإلزامية (ثابتة ومرتبة).
const SIGNAL_CODES = Object.freeze([
  'instruction_injection',
  'script_payload',
  'path_traversal',
  'shell_danger',
  'binary_blob',
]);

// الحد الافتراضي لقراءة الملف المحجور داخل البيئة المحدودة (بايت).
const DEFAULT_MAX_BYTES = 65536;

// عتبات كشف الكتلة الثنائية.
const BINARY_MIN_BYTES = 24;   // أقل حجم يُحتمل أن يكون كتلة ثنائية
const BINARY_MIN_RATIO = 0.10; // نسبة الأحرف غير المقروءة الدنيا
const BINARY_HIGH_RATIO = 0.30; // عندها ترتفع الشدة إلى high

const UNREADABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g;

// ─────────────────────── أنماط الفحص الحتمية ───────────────────────

// أوامر موجّهة للوكيل/النموذج — عربية وإنجليزية (حقن التعليمات).
const INJECTION_PATTERNS = Object.freeze([
  { label: 'ignore-previous', re: /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directives?)/i },
  { label: 'disregard', re: /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+|prior\s+|above\s+)?(?:instructions?|rules?|prompts?|directives?)/i },
  { label: 'you-are-now', re: /you\s+are\s+now\b/i },
  { label: 'system-prompt', re: /system\s*prompt/i },
  { label: 'ignore-previous-ar', re: /تجاهل\s+(?:كل\s+|جميع\s+|جميع\s+)?(?:التعليمات|الأوامر|التوجيهات|القواعد|التوجيه)/i },
  { label: 'you-are-now-ar', re: /أنت\s+الآن(?![\u0600-\u06FF])/ },
  { label: 'act-as-ar', re: /تصرّ?ف\s+ك/ },
  { label: 'forget-rules-ar', re: /تناس[ىًَ]*\s*قواعدك/ },
]);

// حمولات نصية قابلة للتنفيذ — نكتشفها ولا ننفّذها أبداً.
const SCRIPT_PATTERNS = Object.freeze([
  { label: '<script>', re: /<script\b/i },
  { label: 'javascript:', re: /javascript\s*:/i },
  { label: 'eval(', re: /\beval\s*\(/i },
  { label: 'child_process', re: /child_process/ },
  { label: "require('child_process')", re: /require\s*\(\s*['"]child_process['"]\s*\)/ },
  { label: 'base64 -d', re: /base64\s+(?:-d|--decode)/i },
]);

// اجتياز المسار: `../` متكرر أو مسار مطلق خارجي.
const TRAVERSAL_PATTERNS = Object.freeze([
  { label: '../', re: /(?:\.\.[\\/]){2,}/ },
  { label: 'absolute-outside', re: /(?:^|[\s"'`(=,\[;])(?:\/(?:etc|usr|bin|root|var|home)\/|[a-z]:[\\/](?:windows|users|programdata|system32)[\\/]|\\\\[a-z0-9._-]+\\[a-z0-9._$-]+)/i },
]);

// أوامر صدفة خطرة.
const SHELL_PATTERNS = Object.freeze([
  { label: 'rm -rf', re: /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\b/i },
  { label: 'curl | sh', re: /\b(?:curl|wget|fetch)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/i },
  { label: 'powershell -enc', re: /\bpowershell(?:\.exe)?\b[^\n]*?\s-(?:enc|encodedcommand|e)\b/i },
  { label: 'backticks', re: /`[^`\n]*\b(?:rm|curl|wget|cat|sh|bash|powershell|nc|python|node)\b[^`\n]*`/i },
]);

// مسار مطلق خارجي يُستعمل عند تمرير `path` إلى `assess`.
// العطل المُثبت 2026-10-20: النسخة السابقة كانت `[a-z]:[\\/](?:windows|users|…)`
// — أي تشترط فاصلاً **قبل** اسم المنطقة، فلم تُطابق `C:\\Windows\\…` (فاصلاً واحداً
// فقط بعد النقطتين) ولا `C:\\Users\\…`. النتيجة: `assess(nص, {path})` تُعيد
// suspicious=false لمسار نظام حساس (ثغرة كشف) **و** للاختبار الذي يفحص ذلك.
// النمط الصحيح: `[a-z]:[\\/]?(?:windows|users|…)` مع فاصل لاحق، وأيضاً مسارات
// يونكس المطلقة في مناطق النظام. لا يطابق عنواناً عادياً لملف داخل مساحة العمل.
/* مسار الاستيراد: إنذار مبكر **محافظ**.
   التاريخ (2026-10-20): الفحص الأول كان نمطاً لا يطابق `C:\\Windows\\…` أصلاً
   (ثغرة كشف صامتة)؛ ثم صار نمطاً أوسع فحجر مسارات مشروعة (مجلدات مؤقتة تحت
   …\AppData\Local\Temp\، ومشاريع تحت …\Users\…) — وهو نفس العطل القديم
   (59 ملفاً بريئاً) بصورة أخرى. القاعدة المستقرة: نُشير **فقط** إلى مناطق
   نظام حرجة لا يسكنها عمل المستخدم، وأي شيء آخر يبقى على `guardPath` عند
   التنفيذ (الحكم الحقيقي هناك بالجذور المسموحة لا بالنص). */
const ABSOLUTE_OUTSIDE = /^(?:[a-z]:[\\/])?(?:windows|programdata|system32)(?:[\\/]|$)/i;
function isOutsideAllowedRoots(filePath) {
  const abs = String(filePath || '');
  const rel = abs.replace(/^[a-z]:[\\/]/i, '');
  if (ABSOLUTE_OUTSIDE.test(rel)) return true;             // C:\Windows\... أو \Windows\...
  if (/^\/(?:etc|usr|bin|sbin|root|var|boot|sys|proc)(?:\/|$)/i.test(abs)) return true; // مسار نظام يونكس
  return false;
}

// ─────────────────────── مساعدات حتمية ───────────────────────

/** بصمة FNV-1a (32 بت) — حتمية، بلا تشفير وبلا اعتماد خارجي. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSeverity(sev) {
  if (typeof sev !== 'string') return null;
  const v = sev.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, v) ? v : null;
}

function rankOf(sev) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, sev) ? LEVEL_RANK[sev] : -1;
}

/** تشغيل عملية داخل معاملة واحدة — لا نصف حجر مُسجَّل. */
function withTx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* لا شيء */ }
    throw err;
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function describe(matches) {
  const uniq = dedupe(matches.map((m) => String(m).trim()).filter(Boolean));
  return uniq.slice(0, 4).map((s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s)).join(' | ');
}

/** يجمع كل مطابقات قائمة أنماط — لا يتوقف عند الأولى. */
function collect(patterns, text) {
  const out = [];
  for (const p of patterns) {
    const re = p.re.global ? p.re : new RegExp(p.re.source, `${p.re.flags}g`);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = String(m[0]).trim();
      if (hit) out.push(hit);
      if (m[0] === '') re.lastIndex++;
      if (out.length >= 40) return out;
    }
  }
  return out;
}

function unreadableRatio(text) {
  if (!text.length) return 0;
  const found = text.match(UNREADABLE);
  return found ? found.length / text.length : 0;
}

function asBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content == null) return Buffer.alloc(0);
  return Buffer.from(String(content), 'utf8');
}

// ─────────────────────── 1) الفحص الحتمي ───────────────────────

/**
 * فحص حتمي للمحتوى — يجمع كل الإشارات لا الأولى فقط.
 * @param {string|Buffer} content المحتوى الخام (لا يُنفَّذ ولا يُستورَد).
 * @param {{path?:string}} [options]
 * @returns {{suspicious:boolean, signals:Array<{code:string,severity:string,detail:string}>, maxSeverity:string|null}}
 */
function assess(content, options = {}) {
  const opts = options || {};
  const filePath = typeof opts.path === 'string' ? opts.path : null;

  const buf = asBuffer(content);
  const text = buf.toString('utf8');

  const signals = [];

  // 1) حقن التعليمات (عربي/إنجليزي)
  const injections = collect(INJECTION_PATTERNS, text);
  if (injections.length) {
    signals.push({ code: 'instruction_injection', severity: 'critical', detail: describe(injections) });
  }

  // 2) حمولات نصية قابلة للتنفيذ
  const scripts = collect(SCRIPT_PATTERNS, text);
  if (scripts.length) {
    signals.push({ code: 'script_payload', severity: 'critical', detail: describe(scripts) });
  }

  // 3) اجتياز المسار ومسار مطلق خارجي — **في المحتوى فقط**.
  //
  // العطل الأصلي (مؤكد على 59 صفاً حجراً): كان `ABSOLUTE_OUTSIDE.test(filePath)`
  // يُفحص فيسجل `path_traversal` لأي ملف مشروع يقع تحت `Users\…` — أي كل ملف.
  // والنتيجة: ملفات تقنية بريئة (ARCHITECTURE.md, ROADMAP.md, OPERATIONS.md)
  // حُجرت كـ«محتوى مشبوه» مع severity=critical، فسقطت بوابة §42 عن حق كاذب.
  //
  // المسار مُدخل نظام لا محتوى مُستورد (§21): المسار يخضع لـ`guardPath` عند
  // التنفيذ (هناك يُقرَّر السماح)، وأما هذا الفحص فهو لحمولة الملف. ولا نُبلّغ
  // عن مسار خارجي إلا إذا كان الملف نفسه **خارج** ما يُسمح باستيراده، وهو ما
  // يتولاه `guardPath` لا `assess`.
  const traversals = collect(TRAVERSAL_PATTERNS, text);
  if (traversals.length) {
    signals.push({ code: 'path_traversal', severity: 'high', detail: describe(traversals) });
  }

  // 3ب) مسار الاستيراد نفسه: مُدخل نظام لا محتوى — يُقبل التقرير عنه **دون تحليل
  //     محتوى الملف**. العطل المُثبت 2026-10-20: ABSOLUTE_OUTSIDE كان معرَّفاً ثم
  //     أُهمل، فصار `assess('نص نظيف', { path: 'C:\\Windows\\System32\\evil.dll' })`
  //     يُعيد suspicious=false — أي أن مساراً خارجياً خطيراً يمرّ بلا إشارة،
  //     والاختبار كان صحيحاً والكود ناقصاً. النمط يقيّد نفسه إلى مناطق النظام
  //     الحساسة (windows/users/programdata/system32 و /etc /usr /bin /root /var /home)
  //     فلا يُطلق على مساحة عمل المستخدم — لذا لا يتكرر العطل القديم (حجر 59 ملفاً
  //     بريئاً كان سببه فحص كل مسار تحت Users).
  const pathOutside = filePath
    ? isOutsideAllowedRoots(filePath, options.allowedRoots || options.roots)
    : false;
  if (pathOutside && !traversals.length) {
    signals.push({ code: 'path_traversal', severity: 'high', detail: `مسار استيراد خارج المناطق المسموحة: ${filePath}` });
  }

  // 4) أوامر صدفة خطرة
  const shells = collect(SHELL_PATTERNS, text);
  if (shells.length) {
    signals.push({ code: 'shell_danger', severity: 'critical', detail: describe(shells) });
  }

  // 5) كتلة ثنائية: نسبة أحرف غير مقروءة عالية
  const ratio = unreadableRatio(text);
  if (buf.length >= BINARY_MIN_BYTES && ratio >= BINARY_MIN_RATIO) {
    const severity = ratio >= BINARY_HIGH_RATIO ? 'high' : 'medium';
    const pct = (ratio * 100).toFixed(1);
    signals.push({
      code: 'binary_blob',
      severity,
      detail: `نسبة أحرف غير مقروءة ${pct}% من ${buf.length} بايت`,
    });
  }

  const suspicious = signals.length > 0;
  let maxSeverity = null;
  if (suspicious) {
    maxSeverity = 'low';
    for (const s of signals) {
      if (rankOf(s.severity) > rankOf(maxSeverity)) maxSeverity = s.severity;
    }
  }

  return { suspicious, signals, maxSeverity };
}

// ─────────────────────── 2) الحجر ───────────────────────

/**
 * يحجر ملفاً مشبوهاً: يسجّل الصف في `quarantine`، ويقيّد كل إشارة في
 * `import_isolations`، ويكتب حجراً في `audit_log`. لا يحذف الملف ولا يلمسه.
 * @returns {{ok:true, id:number, blocked:true}}
 */
function quarantineFile(db, options = {}) {
  const opts = options || {};

  const filePath = opts.path;
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('مسار الملف إلزامي للحجر');
  }

  const reason = opts.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('سبب الحجر إلزامي — لا حجر بلا سبب موثّق');
  }

  const severity = normalizeSeverity(opts.severity) || 'high';
  const signals = Array.isArray(opts.signals) ? opts.signals.filter((s) => s && typeof s === 'object') : [];
  const actor = opts.by == null || opts.by === '' ? 'system' : String(opts.by);
  const at = nowIso();

  const codes = signals.map((s) => String(s.code || s.pattern || 'unknown'));

  const id = withTx(db, () => {
    const info = db
      .prepare('INSERT INTO quarantine(at, path, reason, severity) VALUES (?,?,?,?)')
      .run(at, filePath, reason, severity);
    const rowId = Number(info.lastInsertRowid);

    // صف لكل إشارة — العزل بلا تسجيل ناقص (م21)
    const insIso = db.prepare(
      'INSERT INTO import_isolations(at, source, fingerprint, note_id, pattern, match_text, index_at) VALUES (?,?,?,?,?,?,?)'
    );
    signals.forEach((s, i) => {
      const code = String(s.code || s.pattern || 'unknown');
      const detail = String(s.detail == null ? '' : s.detail).slice(0, 400);
      insIso.run(at, filePath, fnv1a(`${filePath}|${code}`), null, code, detail, i);
    });

    // أثر تدقيقي للحجر (م38)
    db.prepare('INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
      .run(at, 'file_quarantined', filePath, 'cortex-guard', actor,
        JSON.stringify({ id: rowId, path: filePath, reason, severity, signals: codes }));

    return rowId;
  });

  return { ok: true, id, blocked: true };
}

// ─────────────────────── 3) الاستعلام الحتمي ───────────────────────

/** هل المسار محجور حالياً (حجر قائم غير مرفوع)؟ */
function isQuarantined(db, path) {
  const row = db
    .prepare('SELECT 1 FROM quarantine WHERE path=? AND cleared=0 LIMIT 1')
    .get(String(path));
  return !!row;
}

// ─────────────────────── 4) حارس المسار ───────────────────────

/**
 * يرفض تعامل النظام مع ملف محجور.
 * @returns {{allowed:false, reason:string, severity:string, quarantineId:number, path:string}|{allowed:true}}
 */
function guardPath(db, path) {
  const p = String(path);
  const row = db
    .prepare('SELECT id, reason, severity FROM quarantine WHERE path=? AND cleared=0 ORDER BY id DESC LIMIT 1')
    .get(p);
  if (!row) return { allowed: true };
  return {
    allowed: false,
    reason: row.reason,
    severity: row.severity,
    quarantineId: Number(row.id),
    path: p,
  };
}

// ─────────────────────── 5) الفحص في بيئة محدودة ───────────────────────

/**
 * يفحص الملف المحجور داخل بيئة محدودة: يقرأ عبر `reader` المحقون فقط،
 * ويحدّ الحجم بـ `maxBytes`، ويخزّن الملخص في `scan_result` مع `scanned=1`.
 * **لا ينفّذ الملف ولا يستورده ولا يلمس القرص بنفسه.**
 * @param {object} db
 * @param {number} id معرّف صف الحجر
 * @param {{reader:Function, maxBytes?:number}} options
 */
/**
 * ملاحظة عقد: هذه دالة async — كل نداء يجب أن يُنتظر (`await`)، وإلا ضاع الأثر
 * بصمت. مسار الاستخدام الفعلي في `/api/gates/check` يُنتظر صراحةً.
 */
async function scan(db, id, options = {}) {
  const opts = options || {};

  const reader = opts.reader;
  if (typeof reader !== 'function') {
    throw new Error('reader مطلوب — الفحص يجري بقراءة محقونة داخل بيئة محدودة، بلا تنفيذ');
  }

  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? Math.floor(opts.maxBytes)
    : DEFAULT_MAX_BYTES;

  const row = db.prepare('SELECT id, path, cleared FROM quarantine WHERE id=?').get(id);
  if (!row) throw new Error(`لا صف حجر بالمعرّف ${id}`);

  // القراءة الوحيدة المسموحة: عبر القارئ المحقون. لا fs، لا require، لا eval.
  //
  // العطل الأصلي (مؤكد حياً): ملف مفقود كان يرمي ENOENT فيُرفض الوعد بلا معالجة
  // (فحصٌ بلا await)، فيبقى `scanned=0` إلى الأبد. والمسح **إجابة** لا استثناء:
  // ملف غير موجود ⇒ يُسجَّل «missing» صريحاً، ويُعرف أنه لا محتوى له ليُخطر.
  let raw;
  try {
    raw = await reader(row.path, { maxBytes });
  } catch (err) {
    const code = err && err.code ? err.code : null;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    const summary = {
      id: Number(row.id),
      path: row.path,
      bytes: 0,
      truncated: false,
      missing,
      error: missing ? 'الملف غير موجود' : `تعذّر الفحص: ${err && err.message ? err.message : err}`,
      suspicious: false,
      maxSeverity: null,
      signals: [],
      scannedAt: nowIso(),
    };
    db.prepare('UPDATE quarantine SET scanned=1, scan_result=? WHERE id=?')
      .run(JSON.stringify(summary), Number(row.id));
    return { ok: true, id: Number(row.id), scanned: true, missing, summary };
  }
  const buf = asBuffer(raw);
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;

  const verdict = assess(slice, { path: row.path });
  const summary = {
    id: Number(row.id),
    path: row.path,
    maxBytes,
    bytes: slice.length,
    truncated,
    // العطل الأصلي: مسار النجاح لم يكن يُسجّل `missing` مطلقاً ⇒ كل ملف **موجود**
    // يحمل `missing: undefined`، وأي قارئ (بوابة، واجهة، تدقيق) يقرؤه كلمةً مبهمة.
    // الحقل الآن صريح في الفرعين، لا في فرع الخطأ وحده.
    missing: false,
    fingerprint: fnv1a(slice.toString('utf8')),
    suspicious: verdict.suspicious,
    maxSeverity: verdict.maxSeverity,
    signals: verdict.signals.map((s) => ({ code: s.code, severity: s.severity })),
    scannedAt: nowIso(),
  };

  db.prepare('UPDATE quarantine SET scanned=1, scan_result=? WHERE id=?')
    .run(JSON.stringify(summary), Number(row.id));

  return { ok: true, id: Number(row.id), scanned: true, summary };
}

// ─────────────────────── 6) رفع الحجر ───────────────────────

/**
 * يرفع الحجر برفع العلم (لا بحذف الصف): cleared=1 مع cleared_by/cleared_at
 * وسبب إلزامي، ويكتب أثره في `audit_log`. بلا سبب ⇒ رفض.
 */
function clear(db, id, options = {}) {
  const opts = options || {};

  const reason = opts.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error(i18n.T('سبب رفع الحجر إلزامي — لا رفع بلا سبب موثّق', 'A reason is required to lift quarantine — no lift without a recorded reason'));
  }

  const by = opts.by == null || opts.by === '' ? 'system' : String(opts.by);

  const row = db.prepare('SELECT id, path FROM quarantine WHERE id=?').get(id);
  if (!row) throw new Error(`لا صف حجر بالمعرّف ${id}`);

  const at = nowIso();
  const rowId = Number(row.id);

  withTx(db, () => {
    db.prepare('UPDATE quarantine SET cleared=1, cleared_by=?, cleared_at=? WHERE id=?')
      .run(by, at, rowId);
    db.prepare('INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
      .run(at, 'quarantine_cleared', row.path, 'cortex-guard', by,
        JSON.stringify({ id: rowId, path: row.path, reason }));
  });

  return { ok: true, id: rowId, cleared: true };
}

// ─────────────────────── 7) العرض والإحصاء ───────────────────────

function rowToObject(row) {
  return {
    id: Number(row.id),
    at: row.at,
    path: row.path,
    reason: row.reason,
    severity: row.severity,
    scanned: row.scanned === 1 || row.scanned === true || Number(row.scanned) === 1,
    scanResult: safeParse(row.scan_result),
    cleared: Number(row.cleared) === 1,
    clearedBy: row.cleared_by ?? null,
    clearedAt: row.cleared_at ?? null,
  };
}

function safeParse(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** قائمة صفوف الحجر — الافتراضي القائم فقط (cleared=0). */
function list(db, options = {}) {
  const opts = options || {};
  const onlyOpen = opts.onlyOpen !== false;
  const sql = onlyOpen
    ? 'SELECT * FROM quarantine WHERE cleared=0 ORDER BY id'
    : 'SELECT * FROM quarantine ORDER BY id';
  return db.prepare(sql).all().map(rowToObject);
}

/** إحصاء حتمي لحالة الحجر والعزل. */
function stats(db) {
  const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n);
  const total = count('SELECT COUNT(*) AS n FROM quarantine');
  const open = count('SELECT COUNT(*) AS n FROM quarantine WHERE cleared=0');
  const scanned = count('SELECT COUNT(*) AS n FROM quarantine WHERE scanned=1');
  const isolations = count('SELECT COUNT(*) AS n FROM import_isolations');
  const auditRows = count('SELECT COUNT(*) AS n FROM audit_log WHERE type IN (?,?)',
    'file_quarantined', 'quarantine_cleared');

  const bySeverity = {};
  for (const s of SEVERITY_LEVELS) bySeverity[s] = 0;
  for (const r of db.prepare('SELECT severity, COUNT(*) AS n FROM quarantine WHERE cleared=0 GROUP BY severity').all()) {
    const key = Object.prototype.hasOwnProperty.call(bySeverity, r.severity) ? r.severity : 'unknown';
    if (key === 'unknown') bySeverity.unknown = (bySeverity.unknown || 0) + Number(r.n);
    else bySeverity[key] = Number(r.n);
  }

  return {
    total,
    open,
    cleared: total - open,
    scanned,
    unscanned: total - scanned,
    isolations,
    auditRows,
    bySeverity,
  };
}

module.exports = {
  assess,
  quarantineFile,
  isQuarantined,
  guardPath,
  scan,
  clear,
  list,
  stats,
  SIGNAL_CODES,
  DEFAULT_MAX_BYTES,
  SEVERITY_LEVELS,
};
