'use strict';
const i18n = require('./cortex-i18n');
/**
 * Cortex — طبقة الخصوصية (م12 + م15/6)
 *
 * هذه الوحدة **تقرّر وتُسجّل فقط** — لا تتصل بأي شبكة ولا ترسل أي بيانات.
 * كل قرار إرسال خارجي يمرّ من هنا، ويُترك أثر في connection_log و audit_log.
 *
 * محلي أولاً: لا صنف بيانات مفتوح للخارج بإعداد افتراضي. المستخدم هو من يفتح.
 * والأسرار ممنوعة إرسالاً مطلقاً — لا استثناء ولا إعداد يفتحها.
 *
 * دستور §38: لا اتصال خارجي بلا أثر مُثبَت.
 */

// ─────────────────────────────────────────────────────────────────
// 1) تصنيف البيانات القابلة للإرسال — المصدر الوحيد للحقيقة
// ─────────────────────────────────────────────────────────────────
const DATA_CLASSES = Object.freeze({
  knowledge: Object.freeze({
    label: 'نصوص المعرفة', enLabel: 'Knowledge text',
    description: 'متون ملاحظاتك ومحتوى مستنداتك ومقتطفاتها — أثقل صنف وأخطرها على الخصوصية.',
    enDescription: 'Your note bodies, document contents and excerpts — the heaviest and most privacy-sensitive class.'
  }),
  metadata: Object.freeze({
    label: 'عناوين وأنواع', enLabel: 'Titles and types',
    description: 'عناوين الملاحظات وأنواعها وبعض العدّادات — لا يكشف متن المعرفة.',
    enDescription: 'Note titles, their types and some counters — does not reveal knowledge bodies.'
  }),
  paths: Object.freeze({
    label: 'مسارات ملفات', enLabel: 'File paths',
    description: 'أسماء ومسارات ملفات على جهازك — تكشف بنية جهازك وأسماء مشاريعك.',
    enDescription: 'File names and paths on your device — reveals your device layout and project names.'
  }),
  secrets: Object.freeze({
    label: 'مفاتيح ورموز', enLabel: 'Keys and tokens',
    description: 'مفاتيح API ورموز الوصول وكلمات المرور — ممنوعة الإرسال مطلقاً.',
    enDescription: 'API keys, access tokens and passwords — sending them is forbidden absolutely.'
  }),
  commands: Object.freeze({
    label: 'أوامر تنفيذ', enLabel: 'Execution commands',
    description: 'أوامر shell أو سكربتات يُطلب تنفيذها — لا تُرسل إلى مزود سحابي.',
    enDescription: 'Shell commands or scripts requested for execution — never sent to a cloud provider.'
  }),
  images: Object.freeze({
    label: 'صور', enLabel: 'Images',
    description: 'الصور واللقطات ومحتوياتها — قد تحمل نصاً أو بيانات حساسة.',
    enDescription: 'Images, screenshots and their contents — may carry text or sensitive data.'
  })
});

// الأصناف التي لا تُفتح للخارج أبداً مهما كان الإعداد
const NEVER_EXTERNAL = Object.freeze(new Set(['secrets', 'commands']));

// المزودون المحليون: بياناتهم لا تغادر الجهاز أصلاً
const LOCAL_PROVIDERS = Object.freeze(new Set([
  'local', 'ollama', 'llamacpp', 'llama.cpp', 'lmstudio', 'lm-studio',
  'localhost', 'on-device', 'ondevice', 'offline', 'embedded', 'native',
  // العطل المُثبت حياً 2026-10-20: `mock` (المزود الافتراضي عند الإقلاع وفي
  // ديمو الاختبارات) لم يكن مصنَّفاً محلياً، فسقط إلى «cloud» ⇒ حُظر إرسال
  // «knowledge» افتراضياً ⇒ كل نداء نموذج في الإقلاع يُرد بـ«محظور بالسياسة»،
  // ولا سجل اتصالات يُكتب. `mock` لا يغادر الجهاز بطبيعته (بلا شبكة أصلاً)،
  // وكذلك `demo`؛ ومزود `file`/`echo` المحليان. تصنيفها محلية هو الصواب،
  // وبقاء حظر الأسرار مطلقاً لا يتأثر (الأسرار ممنوعة قبل فحص النوع).
  'mock', 'demo', 'file', 'echo', 'test'
]));

/**
 * نوع المزود: محلي أم سحابي. أي مزود غير معروف = سحابي (الافتراض الآمن).
 */
function providerKind(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return 'unknown';
  if (LOCAL_PROVIDERS.has(p)) return 'local';
  if (p.startsWith('local') || p.includes('localhost') || p.includes('127.0.0.1') || p.endsWith(':local')) return 'local';
  return 'cloud';
}

function isLocalProvider(provider) {
  return providerKind(provider) === 'local';
}

// ─────────────────────────────────────────────────────────────────
// 2) السياسة الافتراضية — محلي أولاً
// ─────────────────────────────────────────────────────────────────
/**
 * كل الأصناف مرفوعة الحظر افتراضياً. لا يُفتح إلا (metadata) — وفقط
 * إن كان المستخدم قد فعّل مزوداً خارجياً صراحةً.
 * secrets و commands مرفوعة دائماً ولا يستطيع أي إعداد فتحها.
 *
 * @param {{providersEnabled?:boolean, providerEnabled?:boolean, providers?:Array}} [opts]
 * @returns {{[key:string]:{allowed:boolean, note:string}}}
 */
function defaultPolicy(opts = {}) {
  const providersEnabled = opts.providersEnabled === true
    || opts.providerEnabled === true
    || (Array.isArray(opts.providers) && opts.providers.length > 0);

  const policy = {};
  for (const key of Object.keys(DATA_CLASSES)) {
    if (NEVER_EXTERNAL.has(key)) {
      policy[key] = {
        allowed: false,
        note: key === 'secrets'
          ? i18n.T('إرسال الأسرار ممنوع — لا استثناء ولا إعداد يفتحه', 'Sending secrets is forbidden — no exception, no setting opens it')
          : i18n.T('أوامر التنفيذ لا تُرسل خارج الجهاز', 'Execution commands are never sent off this machine')
      };
      continue;
    }
    if (key === 'metadata' && providersEnabled) {
      policy[key] = {
        allowed: true,
        note: i18n.T('مسموح: العنوان والنوع فقط — دون متن المعرفة', 'Allowed: title and type only — never the knowledge body')
      };
      continue;
    }
    policy[key] = {
      allowed: false,
      note: i18n.T('مرفوع افتراضياً — محلي أولاً، والفتح قرار صريح للمستخدم', 'Raised by default — local first; opening it is an explicit user decision')
    };
  }
  return policy;
}

// ─────────────────────────────────────────────────────────────────
// 3) قرار الإرسال — هل يجوز إرسال هذا الصنف إلى هذا المزود؟
// ─────────────────────────────────────────────────────────────────
/**
 * الوحدة **لا ترسل شيئاً**؛ تقرّر فقط هل يجوز الإرسال.
 *
 * @param {string} provider
 * @param {string} dataClass
 * @param {{providersEnabled?:boolean, providerEnabled?:boolean, providers?:Array}} [opts]
 * @returns {{allowed:boolean, note:string, class?:string, provider?:string, kind?:string}}
 */
/**
 * قرار الخصوصية لاتصال واحد.
 *
 * ⚠️ إصلاح جوهري: السياسة السابقة كانت تحظر «knowledge» على أي مزود سحابي **دائماً**،
 * فتُعطّل المحادثة والوكيل كلياً عند فرضها. «محلي أولاً» تعني: الافتراض محلي،
 * وأن إرسال بيانات المعرفة لمزود سحابي **قرار صريح يملكه المستخدم** عند اختياره ذلك المزود.
 * ما يبقى محظوراً دائماً ولا يُفتح بأي إعداد: الأسرار (secrets) وأوامر التنفيذ (commands).
 */
function limitsFor(provider, dataClass, opts = {}) {
  if (!Object.prototype.hasOwnProperty.call(DATA_CLASSES, dataClass)) {
    return { allowed: false, note: `صنف بيانات غير معروف: ${dataClass}`, class: dataClass, provider, kind: providerKind(provider) };
  }

  const kind = providerKind(provider);

  // الأسرار: ممنوعة دائماً، حتّى إلى مزود محلي — لا تُرسل أصلاً حتى للتقنيع.
  if (dataClass === 'secrets') {
    return { allowed: false, note: 'إرسال الأسرار ممنوع مطلقاً', class: dataClass, provider, kind };
  }

  // المزود المحلي: لا تغادر البيانات الجهاز.
  if (kind === 'local') {
    return { allowed: true, note: `المزود «${provider}» محلي — البيانات لا تغادر الجهاز`, class: dataClass, provider, kind };
  }

  // السحابي: نتبع السياسة (محلي أولاً) + منع الأصناف الخطرة.
  if (NEVER_EXTERNAL.has(dataClass)) {
    return { allowed: false, note: `${DATA_CLASSES[dataClass].label} لا تُرسل إلى مزود سحابي`, class: dataClass, provider, kind };
  }

  // المزود السحابي: الأصناف غير الخطرة تُفتح بقرار المستخدم الصريح (اختيار مزود سحابي = موافقة)
  const userOptedIn = opts.providersEnabled === true || opts.providerEnabled === true;
  if (userOptedIn && !NEVER_EXTERNAL.has(dataClass)) {
    return {
      allowed: true,
      note: `مسموح بقرارك الصريح: «${DATA_CLASSES[dataClass] ? DATA_CLASSES[dataClass].label : dataClass}» تُرسل إلى «${provider}» السحابي — أنت اخترت هذا المزود`,
      class: dataClass, provider, kind, explicit: true,
    };
  }
  const policy = defaultPolicy(opts);
  const entry = policy[dataClass];
  return { allowed: entry.allowed, note: entry.note, class: dataClass, provider, kind };
}

// ─────────────────────────────────────────────────────────────────
// 4) سجل الاتصالات الخارجية — لا اتصال بلا أثر (دستور §38)
// ─────────────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

/**
 * يكتب صفاً في connection_log + أثراً في audit_log نوعه external_connection.
 * يرفض تسجيل أي إرسال فعلي (allowed=true) لصنف secrets.
 *
 * @returns {{ok:boolean, id:(number|null), warning?:string}}
 */
function logConnection(db, { provider, purpose, dataClass, allowed = false, bytes = null, note = null } = {}) {
  if (dataClass === 'secrets' && allowed === true) {
    return { ok: false, id: null, warning: 'إرسال الأسرار ممنوع' };
  }

  const at = nowIso();
  const providerName = String(provider || 'unknown');
  const purposeText = String(purpose || 'unspecified');
  let privacyNote = note ? String(note) : null;

  // تحذير مفهوم إن كان الإرسال سحابياً لصنف غير metadata
  let warning;
  if (allowed === true && !isLocalProvider(providerName) && dataClass !== 'metadata' && dataClass !== 'secrets') {
    warning = `إرسال «${DATA_CLASSES[dataClass] ? DATA_CLASSES[dataClass].label : dataClass}» إلى مزود سحابي «${providerName}» — راجع حدود الخصوصية.`;
    if (!privacyNote) privacyNote = warning;
  } else if (!privacyNote) {
    privacyNote = allowed
      ? (isLocalProvider(providerName) ? 'إرسال محلي — لا تغادر البيانات الجهاز' : 'إرسال مسموح بالسياسة')
      : 'مرفوع بالسياسة — لم يُرسل شيء';
  }

  let id = null;
  db.prepare(
    'INSERT INTO connection_log(at, provider, purpose, data_kind, allowed, bytes, privacy_note) VALUES (?,?,?,?,?,?,?)'
  ).run(at, providerName, purposeText, dataClass ?? null, allowed ? 1 : 0, bytes ?? null, privacyNote);
  id = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare(
    'INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)'
  ).run(
    at,
    'external_connection',
    'external',
    purposeText,
    'privacy',
    JSON.stringify({ provider: providerName, purpose: purposeText, dataClass: dataClass ?? null, allowed: allowed === true, bytes: bytes ?? null })
  );

  const out = { ok: true, id };
  if (warning) out.warning = warning;
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 5) سجل الاتصالات — الأحدث أولاً
// ─────────────────────────────────────────────────────────────────
function connectionHistory(db, { limit = 50, provider = null } = {}) {
  const lim = Number.isInteger(limit) && limit > 0 ? limit : 50;
  let rows;
  if (provider) {
    rows = db.prepare(
      'SELECT id, at, provider, purpose, data_kind AS dataKind, allowed, bytes, privacy_note AS privacyNote FROM connection_log WHERE provider = ? ORDER BY id DESC LIMIT ?'
    ).all(String(provider), lim);
  } else {
    rows = db.prepare(
      'SELECT id, at, provider, purpose, data_kind AS dataKind, allowed, bytes, privacy_note AS privacyNote FROM connection_log ORDER BY id DESC LIMIT ?'
    ).all(lim);
  }
  return rows.map((r) => ({ ...r, allowed: r.allowed === 1 }));
}

// ─────────────────────────────────────────────────────────────────
// 6) ملخّص الاستهلاك — لا تخمين للتكلفة
// ─────────────────────────────────────────────────────────────────
/**
 * التكلفة المجهولة **لا تُخمَّن**: تُعدّ فقط في unknownCostCalls.
 * knownCost = مجموع الصفوف التي تحمل cost فعلاً.
 */
function usageSummary(db, { since = null } = {}) {
  const sinceIso = since instanceof Date ? since.toISOString() : (since ? String(since) : null);
  const base = `SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
      COALESCE(SUM(completion_tokens), 0) AS completionTokens,
      COALESCE(SUM(cost), 0) AS knownCost,
      SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknownCostCalls
    FROM model_usage`;
  const row = sinceIso
    ? db.prepare(`${base} WHERE at >= ?`).get(sinceIso)
    : db.prepare(base).get();

  return {
    calls: Number(row.calls) || 0,
    promptTokens: Number(row.promptTokens) || 0,
    completionTokens: Number(row.completionTokens) || 0,
    knownCost: Number(row.knownCost) || 0,
    unknownCostCalls: Number(row.unknownCostCalls) || 0
  };
}

// ─────────────────────────────────────────────────────────────────
// 7) إشعار الخصوصية — حدّ كل اتصال قبل استخدامه
// ─────────────────────────────────────────────────────────────────
/**
 * نص عربي مفاهيمي يعرض: ما سيُرسل، إلى أين، وما لن يُرسل.
 * ممنوع أن يوحي بأن البيانات بقيت محلية إن كان الاتصال سحابياً.
 */
function privacyNotice(provider, dataClass, lang = 'ar') {
  const providerName = String(provider || 'unknown');
  const kind = providerKind(providerName);
  const cls = DATA_CLASSES[dataClass];
  const E = String(lang).toLowerCase().startsWith('en');
  const what = cls
    ? (E ? `${cls.enLabel || cls.label} (${cls.enDescription || cls.description})` : `${cls.label} (${cls.description})`)
    : (E ? `Unknown class: ${dataClass}` : `صنف غير معروف: ${dataClass}`);

  if (kind === 'local') {
    return E ? [
      `Privacy boundaries — provider “${providerName}” (local).`,
      `What is sent: ${what}.`,
      `Where to: it stays on your device — the provider is local, nothing leaves to the network.`,
      `What is not sent: nothing leaves the device, and no external connection is logged for this request.`
    ].join(' ') : [
      `حدود الخصوصية — المزود «${providerName}» (محلي).`,
      `ما سيُرسل: ${what}.`,
      `إلى أين: يبقى داخل جهازك — المزود محلي، ولا يخرج شيء إلى الشبكة.`,
      `ما لن يُرسل: لا شيء يغادر الجهاز، ولا يُسجَّل اتصال خارجي لهذا الطلب.`
    ].join(' ');
  }

  // سحابي — لا ادّعاء بالبقاء محلياً
  const blocked = dataClass === 'secrets' || dataClass === 'commands'
    ? (E ? 'Sending this class is forbidden, and it will not be sent.'
         : 'إرسال هذا الصنف ممنوع، ولن يُرسل.')
    : (E ? 'Other data classes (knowledge text, paths, commands, secrets, images) are sent only with your explicit consent.'
         : 'باقي أصناف البيانات (نصوص المعرفة، المسارات، الأوامر، الأسرار، الصور) لن تُرسل إلا بموافقتك الصريحة.');

  /* قالب الإشعار يولّد بلغة الطلب — نمط `E ? en : ar` نفسه المستعمل في cortex-core.
     سبب الإصلاح (2026-10-20): كانت تُرجع نصاً عربياً دائماً، فتظهر «Privacy
     boundaries — المزود…» في واجهة إنجليزية، وبقي تدقيق اللغة (06-i18n-audit)
     يفشل بـ«6 متبقٍ». الترجمة في الواجهة ممّكنة لكنها هشّة (قوالب طويلة متغيّرة)؛
     الأصل أن يُصاغ النصّ بلغة القارئ من مصدره. */
  return E ? [
    `Privacy boundaries — provider “${providerName}” (cloud).`,
    `What is sent: ${what}.`,
    `Where to: sent to cloud provider “${providerName}” over the network — this data leaves your device.`,
    `What is not sent: ${blocked}`,
    `Every external connection is recorded in the connection log with its outcome.`
  ].join(' ') : [
    `حدود الخصوصية — المزود «${providerName}» (سحابي).`,
    `ما سيُرسل: ${what}.`,
    `إلى أين: يُرسل إلى مزود سحابي «${providerName}» عبر الشبكة — هذه البيانات تغادر جهازك.`,
    `ما لن يُرسل: ${blocked}`,
    `يُسجَّل كل اتصال خارجي في سجل الاتصالات مع نتيجته.`
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────
// 8) تقنيع الأسرار — إلزامي قبل أي عرض
// ─────────────────────────────────────────────────────────────────
/**
 * أول 6 أحرف و4 أخيرة فقط مع فاصل. أي قيمة أقصر من 12 حرفاً تُقنّع كلياً.
 */
function maskSecret(value) {
  const s = String(value ?? '');
  if (s.length < 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────
// 9) فحص نص بحثاً عن مفاتيح/رموز — بلا إظهار القيمة كاملة
// ─────────────────────────────────────────────────────────────────
const SECRET_PATTERNS = Object.freeze([
  /* عطل مُقاس 2026-10-27 (كشفه اختبار الإدارة الذاتية): النمط بلا حدّ كلمة كان
     يلتقط «ta**sk-mvqz…**» — أي كل معرّف مهمة مجدولة `task-<ts36>` يبدو مفتاحاً
     فيُمنع إرسال أي محادثة تظهر فيها مهمة الوكيل. القاعدة الصحيحة: `sk-` تبدأ
     مفتاحاً فقط إذا لم تسبقها محرف لاتيني/رقم/شرطة سفلية (حدّ يسار صريح). */
  { name: 'openai_sk', re: /(?:^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]{8,})/g, group: 1 },
  { name: 'bearer', re: /Bearer\s+([A-Za-z0-9._~+/=-]{8,})/g, group: 1 },
  { name: 'aws_akia', re: /AKIA[0-9A-Z]{16}/g, group: 0 },
  { name: 'github', re: /gh[pous]_[A-Za-z0-9]{16,}/g, group: 0 },
  { name: 'slack', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { name: 'prefixed_key', re: /\b(?:rv_|sk_)[A-Za-z0-9]{16,}\b/g, group: 0 }
]);

/**
 * يعيد مواقع المفاتيح المكتشفة مع قيمتها مُقنّعة — لا القيمة كاملة.
 * @returns {{type:string, index:number, masked:string}[]}
 */
function scanForSecrets(text) {
  const s = String(text ?? '');
  const found = [];
  for (const { name, re, group } of SECRET_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(s)) !== null) {
      const value = m[group] || m[0];
      const offset = m[0].indexOf(value);
      found.push({
        type: name,
        index: m.index + (offset > 0 ? offset : 0),
        masked: maskSecret(value)
      });
      if (m.index === rx.lastIndex) rx.lastIndex++; // حماية من تطابق صفري
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

module.exports = {
  DATA_CLASSES,
  NEVER_EXTERNAL,
  LOCAL_PROVIDERS,
  providerKind,
  isLocalProvider,
  defaultPolicy,
  limitsFor,
  logConnection,
  connectionHistory,
  usageSummary,
  privacyNotice,
  maskSecret,
  scanForSecrets
};
