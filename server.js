'use strict';
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { createCore } = require('./cortex-core');
const i18n = require('./cortex-i18n');
const { createAgent } = require('./cortex-agent');
const imp = require('./cortex-import');
const CortexExport = require('./cortex-export');
const extTools = require('./cortex-tools-external');
const { createProjectMemory } = require('./cortex-project-memory');
const gw = require('./cortex-model-gateway');
const { McpClient, createCallLogger, toToolPolicy } = require('./cortex-mcp-client');
const { MCP_TOOLS } = require('./cortex-mcp-tools');
const orc = require('./cortex-orchestrator');
const monitorMod = require('./cortex-monitor');
const { rateLimit } = require('./cortex-policy');

const PROJECT_ROOT = __dirname;
const WORK_ROOT = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : PROJECT_ROOT;

/* تنقية رسالة الخطأ قبل إرسالها: تُطمَس المسارات المطلقة (ومسار التطبيق نفسه)
   وتبقى الرسالة مفيدة ومترجمة. عطل مُقاس 2026-11-11: ردّ 400 كان يحمل
   `C:\Users\<اسم>\...\obsimem-web\data\...`. */
function sanitizeErrorText(message) {
  let s = String(message == null ? '' : message);
  for (const root of [WORK_ROOT, PROJECT_ROOT, core && core.dataDir, core && core.vaultDir]) {
    if (root) s = s.split(String(root)).join('<app>');
  }
  s = s.replace(/[A-Za-z]:\\[^\s"'`)]*/g, '<path>');
  s = s.replace(/(?<![\w<])\/(?:Users|home|var|tmp|mnt|opt)\/[^\s"'`)]*/g, '<path>');
  return s;
}
const PORT = Number(process.env.APP_PORT || 3737);
const HOST = process.env.APP_HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.APP_MAX_BODY_BYTES || 2 * 1024 * 1024);
const MODEL_TIMEOUT_MS = Number(process.env.APP_MODEL_TIMEOUT_MS || 180000);
const MODELS_TIMEOUT_MS = Number(process.env.APP_MODELS_TIMEOUT_MS || 30000);
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const core = createCore({ root: WORK_ROOT, projectRoot: PROJECT_ROOT });
// المهارات: وحدة ملفية تُقرأ من <WORK_ROOT>/skills — تُبنى البذور عند أول طلب
const { createSkills } = require('./cortex-skills');
const skills = createSkills({ dir: path.join(WORK_ROOT, 'skills') });
const agent = createAgent({ core, callModel, parseJsonLoose, cut, skills });
/* ── طبقة التشغيل أول-درجة (خطة الاستوديو W1): كل تشغيل له معرّف وسجل أحداث دائم
     وإلغاء حقيقي — نفس مخزن المنسّق (agent_events) فلا ازدواج ولا مصدران للحقيقة. */
const runsMod = require('./cortex-runs');
let RUNS = null;
function runsStore() { if (!RUNS) RUNS = runsMod.createRunStore(openLayerDb()); return RUNS; }
const VERSION = '5.0.0';

// ════════════════════════════════════════════════════════════════════════
// M32 (دستور): فصل الطبقات — الصفحة/العرض، التطبيق، البيانات.
//   1) طبقة العرض (presentation): public/ فقط — ملفات ثابتة وواجهة، لا منطق أعمال.
//   2) طبقة التطبيق (application): handleApi + مسارات /api/ — توجيه الطلبات، صلاحيات، تسجيل.
//
//   3) طبقة البيانات (data): cortex-core + cortex-store + cortex-schema — القراءة والكتابة على SQLite/vault.
//   لا طبقة تُستدعي طبقة أخرى مباشرةً خارج واجهاتها المُعلنة — core.store و core.saveNote إلخ هي واجهة البيانات الوحيدة.
// ════════════════════════════════════════════════════════════════════════
/* حُذف `LAYER_BOUNDARY` (2026-11-12): كائن توثيقي لا يقرأه أي كود — حدود الطبقات
   موصوفة في التعليق أعلاه وتُفرَض بالبنية (public/ لا تستورد core)، لا بثابت مُعلَّق.
   وأُصلح حرف كوري («선언ة») تسرّب إلى نص عربي. */

// جذور المسارات المسموحة لمسارات الخادم التي تنفّذ أدوات خارجية/استيراداً
const ALLOWED_ROOTS = extTools.buildAllowedRoots(WORK_ROOT);
// ذاكرة المشاريع (2026-10-28): احتضان المشروع بخرائط لا ملفات + قاطع السياق + مسير وكيل البناء
const projectMemory = createProjectMemory({ core, extTools, allowedRoots: ALLOWED_ROOTS, root: WORK_ROOT });
// نواة MCP الموحّدة (2026-10-30): نفس معالجات stdio تُخدم هنا على /mcp — منفذ الاتصال العام
const { createMcpCore } = require('./cortex-mcp-core');
const mcpCore = createMcpCore({ core, projectMemory });
const MCP_SERVERS_FILE = path.join(core.dataDir, 'mcp-servers.json');
// اتصال مشترك واحد لطبقات المخطط الموسّع.
// فتح اتصال جديد لكل طلب ثم إغلاقه كان يسبب تنافساً على قفل الملف،
// فيتجمّد الخادم كله أثناء أي تشغيل طويل للمنسّق (عطل مؤكد).
// اتصال واحد + WAL + busy_timeout = لا تعليق.
let LAYER_DB = null;
function openLayerDb() {
  if (!LAYER_DB) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(core.dataDir, 'cortex.db'));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 8000');
    db.exec('PRAGMA synchronous = NORMAL');
    require('./cortex-schema').migrate(db);
    LAYER_DB = db;
  }
  return LAYER_DB;
}

// ─────────────────────────────────────────────────────────────────────
// §12: تسجيل الاستهلاك فعلاً — لا ادعاء بلا سجل.
// كان الجدول موجوداً والدالة موجودة ولا يناديهما أحد ⇒ model_usage فارغ دائماً.
// ─────────────────────────────────────────────────────────────────────
let privacyMod = null;
try { privacyMod = require('./cortex-privacy'); } catch { privacyMod = null; }

function layerDb() {
  try { return openLayerDb(); } catch { return null; }
}

/* آخر نتيجة مسجَّلة لكل بوابة إطلاق — مصدر واحد يخدم /api/gates و/api/stages/prove.
   إصلاح 2026-11-12: كانت الحالة تُحسب في الواجهة من history فقط، وproveStage لا
   ينظر إليها إطلاقاً. الآن كلاهما يقرأ من هنا. */
function latestGateResults(db) {
  const out = {};
  if (!db) return out;
  try {
    const rows = db.prepare(
      `SELECT gate, passed, at, detail FROM release_gates r
        WHERE at = (SELECT MAX(at) FROM release_gates WHERE gate = r.gate)`
    ).all();
    for (const r of rows) out[r.gate] = r;
  } catch { /* لا جدول بعد — خريطة فارغة تعني «لم تُقيَّم» */ }
  return out;
}

// ─── §19: طيّ الاستيرادات المكررة عند الإقلاع (تدقيق 2026-10-20) ───
// البصمة كانت تُحفظ ولا تُستعلَم، فتراكمت عناصر مكررة بنفس البصمة (×9 مثلاً).
// الطيّ يقع مرة عند الإقلاع ثم يمنعه الفهرس الفريد بنيوياً — لا بالنية.
let DEDUPE_REPORT = { collapsed: 0, groups: 0, indexed: false, ran: false };
try {
  const _ldb = layerDb();
  const _sch = optMod('cortex-schema');
  if (_ldb && _sch && typeof _sch.dedupeDocuments === 'function') {
    DEDUPE_REPORT = { ...(_sch.dedupeDocuments(_ldb) || {}), ran: true };
    if (DEDUPE_REPORT.collapsed) console.log(`[§19] طُوي ${DEDUPE_REPORT.collapsed} استيراداً مكرراً عبر ${DEDUPE_REPORT.groups} بصمة`);
  }
} catch { /* لا طبقة/لا جدول — لا طيّ */ }

/** يكتب سطر تدقيق. فشل التدقيق لا يُسقط العملية لكنه لا يُبتلع صامتاً في الرد. */
function writeAudit(type, payload, extra = {}) {
  const db = layerDb();
  if (!db) return false;
  try {
    db.prepare('INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString(), type, extra.scope || null, extra.tool || null, extra.actor || 'system', JSON.stringify(payload ?? {}));
    return true;
  } catch { return false; }
}

/**
 * سعر المزود المعلَن صراحةً — منه فقط تُقدَّر التكلفة (م12). لا أسعار مفترضة.
 * المصدر: إعداد المزود المحفوظ (pricing.inPer1k/outPer1k) أو أسعار عامة في ai.pricing.
 */
function pricingFor(settings, provider) {
  const ai = (settings && settings.ai) || {};
  if (ai.pricing && typeof ai.pricing === 'object') return ai.pricing;
  const list = Array.isArray(settings && settings.providers) ? settings.providers : [];
  const hit = list.find(p => p && String(p.name || '') === String(provider || ''));
  return hit && hit.pricing && typeof hit.pricing === 'object' ? hit.pricing : null;
}

/**
 * اسم المزود النشط للتسجيل — لا المُشغِّل (عطل مُقاس 2026-11-05).
 * كل المزودين المتوافقين يُسجَّلون `openai-compatible` في model_usage وconnection_log،
 * فلا يُعرف من خدم النداء فعلاً (river أم tokenharbor) عند وجود أكثر من مزود محفوظ.
 * المطابقة بالعنوان لأن المُشغِّل مشترك والاسم هو ما يميّز.
 */
function activeProviderName(settings) {
  const ai = (settings && settings.ai) || {};
  const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
  const list = Array.isArray(settings && settings.providers) ? settings.providers : [];
  /* الاسم المصرَّح به عند التنشيط أولاً: عنوان واحد قد يخدمه أكثر من مدخل،
     و«أول تطابق» كان يجعل الشريط يسمّي مدخلاً غير المفعَّل. */
  const byName = ai.providerName ? list.find((p) => p && String(p.name || '') === String(ai.providerName)) : null;
  if (byName && norm(byName.baseUrl) === norm(ai.baseUrl)) return String(byName.name);
  const hit = list.find((p) => p && p.baseUrl && norm(p.baseUrl) === norm(ai.baseUrl));
  return hit && hit.name ? String(hit.name) : String(ai.provider || 'mock');
}

/**
 * دمج الإعدادات الواردة على **الحالي** لا على الافتراضي.
 *
 * عطل مُقاس (2026-11-09): core.saveSettings يدمج على defaultSettings()، فأي حقل
 * لا يرسله الطلب يعود إلى قيمته الافتراضية. حفظٌ جزئي واحد من شاشة الإعدادات
 * (ترسل ai.temperature وحدها) كان **يمحو** ai.provider/providerName/model/baseUrl
 * فيفقد النظام مزوّده النشط صامتاً — وهو ما حدث فعلاً في هذه الجلسة.
 * القاعدة: ما لم يُرسَل يبقى كما هو، وما أُرسل يُطبَّق (وبذلك يبقى «التصفير» ممكناً
 * بإرسال القيمة صراحةً). المصفوفات تُستبدل كاملة إن أُرسلت — كسلوك mergeDeep.
 */
function deepMergeSettings(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMergeSettings(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * §12 + §15/6: يسجّل كل نداء نموذج — مزوداً ونموذجاً ورموزاً وزمن — والتكلفة
 * **عند توفر أسعار معلَنة فقط** (بلا أسعار => null، لا تخمين — القاعدة نفسها في
 * gw.estimateCost). التسجيل يمرّ عبر gw.recordUsage الموحّدة (كان هنا INSERT
 * مكرراً، وخارج البوابة تبقى recordUsage بلا مستدعٍ إنتاجي — عطل «سلك غير موصول»).
 * سجل الاتصال (connection_log) مسؤولية callModel وحدها — كان يُكتب هنا أيضاً
 * فيتكرر الصف نفسه مرتين لكل نداء.
 */
function recordModelCall(provider, model, tokens, opts = {}) {
  const db = layerDb();
  const at = new Date().toISOString();
  const prompt = Number.isFinite(tokens?.prompt) ? tokens.prompt : null;
  const completion = Number.isFinite(tokens?.completion) ? tokens.completion : null;
  let knownCost = null;
  try { knownCost = gw.estimateCost(opts.pricing, prompt, completion); } catch { knownCost = null; }
  if (db) {
    try {
      gw.recordUsage(db, {
        provider, model,
        promptTokens: prompt, completionTokens: completion,
        cost: knownCost, source: knownCost === null ? 'unknown' : 'estimated',
        purpose: opts.purpose || 'chat', ok: opts.ok
      });
    } catch { /* لا نُسقط الرد بسبب فشل التسجيل */ }
  }
  return { at, provider, model, prompt, completion, knownCost };
}

/**
 * §21: العزل بلا تسجيل ناقص. كل حقن مُعزَل يُكتب صفاً مستقلاً بأصله وبصمته.
 */
function logIsolations({ source, fingerprint, noteId, stripped, at }) {
  const db = layerDb();
  const list = Array.isArray(stripped) ? stripped : [];
  if (!db || !list.length) return { logged: 0 };
  const now = at || new Date().toISOString();
  let n = 0;
  for (const s of list) {
    try {
      db.prepare('INSERT INTO import_isolations(at, source, fingerprint, note_id, pattern, match_text, index_at) VALUES (?,?,?,?,?,?,?)')
        .run(now, source || null, fingerprint || null, noteId || null,
          String(s.pattern || 'unknown'), String(s.match || '').slice(0, 400),
          Number.isFinite(s.index) ? s.index : null);
      n++;
    } catch { /* صف تالف لا يمنع تسجيل البقية */ }
  }
  if (n) writeAudit('import_isolation', { source, fingerprint, noteId, count: n }, { scope: 'import' });
  return { logged: n };
}

/**
 * §38 + §45/7: الرابط الوحيد لتصنيف الوحدات الجديدة.
 * التحميل متسامح: غياب وحدة لا يُسقط الخادم، لكنه لا يُعلن نجاحاً كاذباً.
 */
function optMod(name) {
  try { return require(`./${name}`); } catch { return null; }
}

/**
 * §24 + §38: يلتقط الحالة السابقة قبل أي كتابة.
 * بلا هذه الالتقاطات لا يوجد تراجع أصلاً — وهي بوابة منع إطلاق دستورية.
 */
function recordChange({ entity, entityId, op, before, after, actor, runId }) {
  const db = layerDb();
  const r = optMod('cortex-rollback');
  if (!db || !r || typeof r.snapshot !== 'function') return { ok: false, reason: i18n.T('وحدة التراجع غير متاحة', "Rollback module unavailable") };
  try {
    const out = r.snapshot(db, { entity, entityId, op, before, after, actor: actor || 'user', runId: runId || null });
    return out && out.ok ? out : { ok: false, reason: out?.error || i18n.T('فشل التقاط اللقطة', "Snapshot capture failed") };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/**
 * §37: المستورَد فحص قبل الدخول للمسار العادي. أي ملف يحمل محاولة توجيه أو
 * حمولة خطرة يُحجر ولا يُعالج كمعرفة عادية.
 */
function screenImport({ path: filePath, clean, stripped, fingerprint, noteId }) {
  const db = layerDb();
  const g = optMod('cortex-guard');
  if (!db || !g || typeof g.assess !== 'function') return { suspicious: false, quarantined: false, reason: i18n.T('وحدة الحجر غير متاحة', "Quarantine module unavailable") };
  let verdict;
  try { verdict = g.assess(String(clean || ''), { path: filePath }); }
  catch (e) { return { suspicious: false, quarantined: false, reason: e.message }; }
  const strippedCount = Array.isArray(stripped) ? stripped.length : 0;
  // أي حقن مُعزَل = محاولة موجّه صريحة ⇒ حجر حتى لو نُظّف النص.
  const suspicious = !!verdict.suspicious || strippedCount > 0;
  if (!suspicious) return { suspicious: false, quarantined: false, signals: verdict.signals || [] };
  const severity = strippedCount > 0 && verdict.maxSeverity !== 'critical' ? 'critical' : (verdict.maxSeverity || 'high');
  try {
    const q = g.quarantineFile(db, {
      path: filePath, severity,
      reason: strippedCount > 0 ? `محاولة توجيه الوكيل من محتوى مستورد (${strippedCount} مطابقة)` : i18n.T('محتوى مشبوه', "Suspicious content"),
      signals: verdict.signals || [],
    });
    if (noteId && typeof g.markNote === 'function') g.markNote(db, noteId, { quarantined: true });
    return { suspicious: true, quarantined: !!(q && q.ok), severity, signals: verdict.signals || [], strippedCount };
  } catch (e) { return { suspicious: true, quarantined: false, reason: e.message }; }
}

/* إعدادات خوادم MCP — أكبر خطر فقدان صامت في الملف (P0 تدقيق 2026-11-11):
   كان القارئ `catch { return { mcpServers: {} } }` بلا عزل، والكاتب `writeFile`
   غير ذرّي. أي قطع أثناء الكتابة يترك JSON مقطوعاً، فالقراءة التالية تُرجع كائناً
   فارغاً، ثم الكتابة التالية تكتبه فوق الملف ⇒ **ضياع كل خوادم MCP**، والتدقيق
   يسجّل `mcp_server_added` كأن شيئاً لم يحدث. الآن: عزل الملف التالف (لا محوه)،
   وكتابة ذرّية متسلسلة بنفس نمط settings/vector. */
const mcpServersWriteChain = { p: Promise.resolve() };
async function readMcpServers() {
  let raw;
  try { raw = await fsp.readFile(MCP_SERVERS_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { mcpServers: {} }; return { mcpServers: {} }; }
  try { return JSON.parse(raw); }
  catch {
    try { await fsp.rename(MCP_SERVERS_FILE, `${MCP_SERVERS_FILE}.corrupt-${Date.now()}`); } catch { /* مقفل */ }
    console.error('[Cortex] mcp-servers.json تالف — عُزل بدل محوه (data/mcp-servers.json.corrupt-*)');
    return { mcpServers: {} };
  }
}
async function writeMcpServers(cfg) {
  mcpServersWriteChain.p = mcpServersWriteChain.p.then(async () => {
    const tmp = MCP_SERVERS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    await fsp.rename(tmp, MCP_SERVERS_FILE);
  }).catch(() => {});
  await mcpServersWriteChain.p;
  return cfg;
}

// ═══════════════ الأصول: §19 «يُحفظ ما استُورد كاملاً» ═══════════════

const ASSETS_DIR = path.join(PROJECT_ROOT, 'data', 'assets');

// §19a: سقف حجم الأصل المفرد (بايت) — يمنع نمو assets بلا حد. الافتراضي 50MB،
// قابل للضبط بـ CORTEX_MAX_ASSET_BYTES. القيمة 0 = بلا سقف (تعطيل متعمد).
const MAX_ASSET_BYTES = (() => {
  const n = Number(process.env.CORTEX_MAX_ASSET_BYTES);
  return Number.isFinite(n) && n >= 0 ? n : 50 * 1024 * 1024;
})();

/**
 * ينسخ بايتات الملف الأصلي إلى data/assets/<fingerprint>.<ext> ويُثبت النسخ بقراءة الحجم.
 * §19: «يُحفظ ما استُورد كاملاً» — الادّعاء بلا نسخ فعلية كان مضلِّلاً (تدقيق 2026-10-20).
 * القاعدة: لا يُعاد true إلا بعد قراءة الملف المنسوخ والتأكد أن حجمه = حجم الأصل.
 * @returns {Promise<boolean>}
 */
async function persistOriginalAsset(out, ldb, docId) {
  try {
    if (!out || !out.path || !out.fingerprint) return false;
    // §19a: سقف الحجم قبل أي نسخ — الأصول الأكبر من السقف تُرفض ولا تُستهلك مساحة.
    let srcStat = null;
    try { srcStat = await fsp.stat(out.path); } catch { return false; }
    if (MAX_ASSET_BYTES > 0 && srcStat.size > MAX_ASSET_BYTES) {
      try {
        ldb.prepare('INSERT INTO audit_log (at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
          .run(new Date().toISOString(), 'asset_cap_rejected', null, null, 'import', JSON.stringify({ src: out.path, bytes: srcStat.size, cap: MAX_ASSET_BYTES }));
      } catch { /* لا سجل تدقيق */ }
      return false;
    }
    await fsp.mkdir(ASSETS_DIR, { recursive: true });
    const ext = path.extname(out.path) || '.bin';
    const dest = path.join(ASSETS_DIR, `${out.fingerprint}${ext}`);
    let exists = null;
    try { exists = await fsp.stat(dest); } catch { /* لم يُنسخ بعد */ }
    if (!exists) await fsp.copyFile(out.path, dest);
    const st = await fsp.stat(dest);
    // إثبات بالقراءة: الحجم مطابق، وإلا فالنسخ فاشل والمفتاح يبقى false
    if (!st || st.size !== srcStat.size) return false;
    if (ldb) {
      try {
        ldb.prepare('UPDATE document_entities SET asset_path = ? WHERE id = ?').run(dest, docId);
      } catch { /* العمود غير موجود بعد — يُرقَّع في المخطط */ }
    }
    // أثر مُعلن في سجل التدقيق: نسخ أصل = فعل يحتاج تتبّعاً (أعمدة audit_log الفعلية)
    try {
      ldb.prepare('INSERT INTO audit_log (at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
        .run(new Date().toISOString(), 'asset_saved', null, null, 'import', JSON.stringify({ src: out.path, dest, bytes: st.size }));
    } catch { /* لا سجل تدقيق */ }
    return true;
  } catch { return false; }
}

/**
 * §19: أرشفة مستند بإصدارات حقيقية — نفس المصدر ببصمة مختلفة = إصدار جديد.
 * العطل المُقاس 2026-10-24: كان INSERT OR REPLACE version=1 دائماً فإعادة
 * استيراد ملف معدّل تمحت التاريخ (كل document_versions version=1).
 */
function recordDocumentEntity(ldb, { noteId, source, kind, fingerprint, importedAt, analysis, language, pageCount, originalPath }) {
  try {
    const prev = ldb.prepare('SELECT version, fingerprint FROM document_entities WHERE id = ?').get(noteId);
    let version = 1;
    if (prev && prev.fingerprint && prev.fingerprint !== fingerprint) version = Number(prev.version || 1) + 1;
    else if (prev) version = Number(prev.version || 1);
    ldb.prepare(`INSERT OR REPLACE INTO document_entities
      (id, source, doc_type, version, fingerprint, imported_at, original_path, analysis, language, page_count)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(noteId, source, kind || 'document', version, fingerprint, importedAt, originalPath, analysis, language || null, pageCount ?? null);
    ldb.prepare(`INSERT OR REPLACE INTO document_versions
      (doc_id, version, fingerprint, source, imported_at, analysis, original_path)
      VALUES (?,?,?,?,?,?,?)`)
      .run(noteId, version, fingerprint, source, importedAt, analysis, originalPath);
    return version;
  } catch { return null; }
}

// ═══════════════ الاستيراد الجماعي والإكسپورت ═══════════════

/**
 * يكتب نتائج الدفعة إلى القاعدة بنفس مسار الاستيراد الفردي حرفياً:
 * saveNote (نوع document + source + knowledge_kind=imported) + document_entities
 * + document_versions + تسجيل العزل + فحص الحجر، ثم inferRelations مرة واحدة.
 */
async function persistBatchImport(out, { project, sourceKind, rootLabel, stableRoot }) {
  const importedAt = new Date().toISOString();
  const ldb = layerDb();
  let created = 0;
  let skipped = 0;
  let quarantined = 0;
  let isolations = 0;

  for (const pf of (out.perFile || [])) {
    if (pf.error) { skipped++; continue; }
    try {
      const title = pf.title || path.basename(pf.path);
    const absPath = pf.abs || pf.path;   // المسار الحقيقي لقراءة الملف ونسخ الأصل
    /* الهوية الثابتة: لمستودع مُستنسخ نستعمل رابط المستودع + المسار النسبي،
       لا مجلد الاستنساخ المؤقت — وإلا صارت كل إعادة استيراد نسخة جديدة. */
    const identity = stableRoot ? `${stableRoot}::${pf.path}` : absPath;
      // §19: هوية المستند من **مسار المصدر** لا العنوان — إعادة استيراد ملف معدّل
      // = إصدار جديد لنفس المستند، لا عنصراً ثانياً يمحو التاريخ (مُقاس 2026-10-24:
      // كان 'مستند-تجريبي' يصير 'مستند-تجريبي-mvlpy8em' وversion يعود 1).
      let existingDoc = null;
      try { existingDoc = ldb ? (ldb.prepare('SELECT id FROM document_entities WHERE original_path = ?').get(identity) || null) : null; } catch { /* لا قاعدة */ }
      // kind='document' (مخطط م5) + type='doc' (نوع الواجهة الموثوق، يؤهل isDocument)
      const note = await core.saveNote({
        id: existingDoc ? existingDoc.id : undefined,
        title, type: 'doc', documentType: 'imported', project, importance: 2,
        content: pf.clean || '',
        source: rootLabel ? `${sourceKind}:${rootLabel}::${pf.path}` : pf.path,
        kind: 'document', knowledge_kind: 'imported',
        fingerprint: pf.fingerprint,
      });
      // كتابة knowledge_kind فعلياً في frontmatter (saveNote يتجاهل المفاتيح غير المعروفة)
      // الأداء (عطل مُقاس 2026-10-24): كان هذا الموضع يستدعي core.invalidateCache()
      // ثم core.readNotes() **لكل ملف** — أي 120 ملفاً × ~700 ملاحظة = ~84 ألف قراءة
      // ملف، فاستيراد 120 ملفاً نصياً صغيراً أخذ 25–39 ثانية (والتكلفة تنمو مع المخزن).
      // الحاجة الحقيقية حقل واحد من الملف الذي كتبناه للتوّ: يُقرأ وحده، والكاش يُبطَل مرة بعد الدفعة.
      const notePath = path.join(core.vaultDir, `${note.id}.md`);
      let knowledgeKind = 'imported';
      if (fs.existsSync(notePath)) {
        const raw = await fsp.readFile(notePath, 'utf8');
        const m = raw.match(/^knowledge_kind:\s*(\S+)\s*$/m);
        if (m) {
          knowledgeKind = m[1];
        } else {
          const patched = raw.replace(/^---\n/, '---\nknowledge_kind: imported\n');
          await fsp.writeFile(notePath, patched, 'utf8');
        }
      }
      pf.noteId = note.id;
      pf.knowledgeKind = knowledgeKind;
      created++;
      if (ldb) {
        const analysis = JSON.stringify({
          meta: pf.meta || null, ext: pf.ext, kind: pf.kind, size: pf.size,
          batch: { sourceKind, root: rootLabel, relPath: pf.path },
          strippedCount: pf.strippedCount || 0,
        });
      try {
        pf.version = recordDocumentEntity(ldb, {
          noteId: note.id, source: identity, kind: pf.kind || 'document', fingerprint: pf.fingerprint,
          importedAt, analysis, originalPath: identity,
        });
        // §19: أصل الدفعة يُنسخ إلى assets أيضاً — كان للمفرد فقط (تدقيق 2026-10-24)
        pf.assetSaved = await persistOriginalAsset({ ...pf, path: absPath }, ldb, note.id);
      } catch { /* فشل الأرشفة لا يُسقط الدفعة — يُعلن في perFile */ }
      }
      // تسجيل الحقن المعزول (§21) — كل مطابقة صفاً مستقلاً
      if (pf.strippedCount > 0) {
        const iso = logIsolations({
          source: pf.path, fingerprint: pf.fingerprint, noteId: note.id,
          stripped: [{ match: '(batch summary)', pattern: 'injection_detected_in_batch_file', index: 0 }],
          at: importedAt,
        });
        isolations += iso.logged || 0;
      }
      // §37: فحص الحجر — المحتوى المنظّف قد يحمل حمولة يصطادها cortex-guard
      const screen = screenImport({
        path: pf.path, clean: pf.clean, fingerprint: pf.fingerprint,
        stripped: pf.strippedCount > 0 ? [{ match: 'batch-summarized' }] : [],
        noteId: note.id,
      });
      if (screen.quarantined) {
        quarantined++;
        pf.quarantined = true;
      }
      pf.suspicious = !!screen.suspicious;
    } catch (e) {
      pf.error = e.message;
      skipped++;
    }
  }

  // §7: اشتقاق العلاقات مرة واحدة بعد الدفعة كلها — لا نداء لكل ملف
  // (وإبطال كاش الملاحظات مرة واحدة هنا بدل مرة لكل ملف — كان O(n²))
  try { core.invalidateCache(); } catch { /* الكاش اختياري */ }
  let relationsAdded = 0;
  try {
    const rel = optMod('cortex-relations');
    if (rel?.inferRelations && ldb) {
      const r = rel.inferRelations(ldb, { notes: await core.readNotes() });
      relationsAdded = r.added ?? 0;
    }
  } catch { relationsAdded = 0; }

  notifyWatch('import_batch');
  return { created, skipped, quarantined, isolations, relationsAdded, perFile: out.perFile || [] };
}

/**
 * يجمع بيانات الإكسپورت من القاعدة الحقيقية: كل ملاحظات المشروع + محتواها الكامل
 * + علاقات note_links (origin/confidence) + أصل document_entities + حالة الحجر.
 */
async function buildProjectExportPayload({ project }) {
  const notes = (await core.readNotes()).filter((n) => (n.projectName || '') === project);
  const ldb = layerDb();
  const links = [];
  const docEntities = new Map();
  const quarantinedPaths = new Set();

  if (ldb) {
    try {
      const guard = optMod('cortex-guard');
      const qRows = guard
        ? guard.list(ldb, { onlyOpen: true })
        : ldb.prepare('SELECT path FROM quarantine WHERE cleared=0').all().map((r) => ({ path: r.path }));
      for (const q of (Array.isArray(qRows) ? qRows : [])) {
        if (q && q.path) quarantinedPaths.add(q.path);
      }
    } catch { /* لا حالة حجر متاحة — نُكمل بلا */ }
    try {
      const rows = ldb.prepare('SELECT id, source, doc_type, version, fingerprint, imported_at, original_path FROM document_entities').all();
      for (const r of rows) docEntities.set(r.id, r);
    } catch { /* لا كيانات مستندات */ }
  }

  try {
    const rel = optMod('cortex-relations');
    if (rel && ldb) {
      // origins/confidence الفعلية من note_links (مستمدة بواسطة inferRelations سابقاً)
      const rows = ldb.prepare('SELECT source, target, kind, origin, confidence, extracted_at FROM note_links').all();
      links.push(...rows);
    }
  } catch { /* بلا وحدة علاقات */ }

  // علاقات wikilink الأساسية من core (تشمل ما لم يمرّ بالاشتقاق بعد)
  for (const n of notes) {
    for (const l of new Set(n.links || [])) {
      const target = core.resolveLinkTarget ? core.resolveLinkTarget(l, notes) : l;
      const exists = links.some((x) => x.source === n.id && x.target === target && x.kind === 'wikilink');
      if (!exists) links.push({ source: n.id, target, kind: 'wikilink', origin: 'wikilink', confidence: 1 });
    }
  }

  const exported = notes.map((n) => ({
    id: n.id,
    title: n.title,
    content: n.content || '',
    body: n.body || '',
    fm: n.fm || {},
    kind: (n.classification && n.classification.primaryType) || 'note',
    knowledge_kind: n.fm?.knowledge_kind || null,
    source: n.fm?.source || null,
    sensitivity: n.fm?.sensitivity || 'internal',
    updatedAt: n.updatedAt,
    entities: n.entities || [],
    links: (n.links || []),
  }));

  return { project, notes: exported, links, docEntities, quarantinedPaths };
}

/** يحوّل حزمة الإكسپورت إلى ملف md أو zip فعلية تحت data/exports/. */
async function writeExportFile(exportData, { project, format }) {
  const dir = path.join(core.dataDir, 'exports');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `cortex-export-${slugProjectName(project)}-${stamp}`;

  // §19: أصول المشروع الأصلية تسافر داخل الـZIP — تصدير بلا أصول لا يعيد بناء المشروع
  let assets = [];
  try {
    const ldb = layerDb();
    const inProject = exportData.docEntities instanceof Map ? new Set(exportData.docEntities.keys()) : new Set();
    if (ldb && inProject.size) {
      const rows = ldb.prepare('SELECT id, asset_path FROM document_entities WHERE asset_path IS NOT NULL').all();
      for (const r of rows) {
        if (!inProject.has(r.id) || !r.asset_path) continue;
        try { assets.push({ docId: r.id, name: path.basename(r.asset_path), data: await fsp.readFile(r.asset_path) }); }
        catch { /* الأصل اختفى من القرص — يُعلن غيابه في manifest لا يُخترع */ }
      }
    }
  } catch { /* لا قاعدة — تصدير نصي فقط */ }

  const built = CortexExport.buildProjectExport({
    project,
    notes: exportData.notes.map((n) => ({
      id: n.id, title: n.title, body: n.body, content: n.content, fm: n.fm,
      classification: { primaryType: n.kind },
      updatedAt: n.updatedAt, entities: n.entities, links: n.links,
    })),
    links: exportData.links,
    docEntities: exportData.docEntities,
    quarantinedPaths: exportData.quarantinedPaths,
    assets,
  });

  if (format === 'md') {
    const file = path.join(dir, `${base}.md`);
    const data = Buffer.from(built.markdown, 'utf8');
    await fsp.writeFile(file, data);
    return { format: 'md', file, size: data.length, notes: built.manifest.items.length, manifest: built.manifest };
  }

  // zip: مخزّن بكاتب داخلي (crc32 داخلي، بلا أرشيف خارجي، بلا zlib هنا)
  const zipBuf = CortexExport.buildStoredZip(built.zipEntries);
  const file = path.join(dir, `${base}.zip`);
  await fsp.writeFile(file, zipBuf);
  return { format: 'zip', file, size: zipBuf.length, notes: built.manifest.items.length, manifest: built.manifest };
}

/** اسم مشروع آمن لأسماء ملفات التصدير (لا فصل مسارات ولا محارف تحكم). */
function slugProjectName(name) {
  const s = String(name || 'project')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'project';
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8'
};

const watchState = { version: 1, lastChanged: new Date().toISOString(), reason: 'startup', clients: new Set(), watcherStarted: false, timer: null };
function notifyWatch(reason = 'change') {
  watchState.version += 1;
  watchState.lastChanged = new Date().toISOString();
  watchState.reason = reason;
  core.invalidateCache();
  Promise.resolve(core.syncStore()).catch(() => {});
  // مراقب الملفات خطّه الحكيم: أي تعديل خارجي يعلم الفهرس — أما كتابتنا فنحن نعلِّمها بأنفسنا
  if (reason === 'external_vault_change' && !core.wasSelfWrite()) Promise.resolve(core.markVectorIndexDirty('external_vault_change')).catch(() => {});
  const payload = `data: ${JSON.stringify({ version: watchState.version, lastChanged: watchState.lastChanged, reason })}\n\n`;
  for (const res of watchState.clients) {
    try { res.write(payload); } catch {}
  }
}
function scheduleWatch(reason) {
  clearTimeout(watchState.timer);
  watchState.timer = setTimeout(() => notifyWatch(reason), 120);
}
function startVaultWatcher() {
  if (watchState.watcherStarted) return;
  watchState.watcherStarted = true;
  try { fs.watch(core.vaultDir, { persistent: false }, () => scheduleWatch('external_vault_change')); } catch {}
}

// كل نداء خارجي مقيّد بمهلة حتى لا يتعلّق الطلب إلى الأبد عند تعطّل المزوّد
async function timedFetch(url, options = {}, timeoutMs) {
  // حاكم عميق عند أصل الطلب نفسه: بروتوكول + مضيف عام + حلّ DNS يرفض الخاص/الحلقي (يمنع DNS rebinding) — ومنع التحويلات
  await core.guardOutboundUrl(url);
  // إنتاجية: 429 من المزود سقف/معدل عابر — المحاولات: فورًا → بعد 15ث → بعد 35ث ثم الاستسلام برسالة واضحة
  const backoff = [0, 15000, 35000];
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    if (backoff[attempt]) await new Promise(r => setTimeout(r, backoff[attempt]));
    let response;
    try {
      response = await fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`انتهت مهلة الاتصال بالمزوّد بعد ${Math.round(timeoutMs / 1000)} ثانية — تحقق من العنوان أو الشبكة`);
      throw new Error(`تعذّر الوصول إلى المزوّد (${url}): ${e.message}`);
    }
    if (response.status === 429 && attempt < backoff.length - 1) continue;
    return response;
  }
}
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [raw, fence && fence[1], (raw.match(/\{[\s\S]*\}/) || [])[0], (raw.match(/\[[\s\S]*\]/) || [])[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  // ما يلزم للجهزة غير المنظفة: آخر كائن JSON متوازن في النص (قرار الوكيل عادة يأتي في النهاية)
  for (let end = raw.lastIndexOf('}'); end !== -1; end = raw.lastIndexOf('}', end - 1)) {
    for (let start = raw.lastIndexOf('{', end); start !== -1; start = raw.lastIndexOf('{', start - 1)) {
      try { const r = JSON.parse(raw.slice(start, end + 1)); if (r && typeof r === 'object') return r; } catch {}
    }
  }
  return null;
}
function cut(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

async function safeJsonFetch(url, options = {}, timeoutMs = MODELS_TIMEOUT_MS) {
  const res = await timedFetch(url, options, timeoutMs);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json') && !ct.includes('text/json')) {
    const preview = (await res.text()).slice(0, 140);
    throw new Error(`الخادم أرجع HTML بدل JSON (${res.status})\n→ تأكد من Base URL.\nبداية الرد: ${preview}`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`خطأ ${res.status}: ${data.error?.message || data.message || JSON.stringify(data)}`);
  return data;
}
async function fetchModels(settings) {
  const provider = settings.ai?.provider || 'mock';
  if (provider === 'mock') return { models: ['cortex-mock'], tip: 'Mock mode' };
  if (provider === 'ollama') {
    const base = (settings.ai.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const data = await safeJsonFetch(`${base}/api/tags`);
    return { models: (data.models || []).map(m => m.name), tip: '' };
  }
  if (provider === 'openai-compatible') {
    const base = (settings.ai.openaiBaseUrl || settings.ai.baseUrl || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.ai.apiKey) headers.Authorization = `Bearer ${settings.ai.apiKey}`;
    let lastErr = null;
    for (const url of [`${base}/v1/models`, `${base}/api/v1/models`]) {
      try {
        const data = await safeJsonFetch(url, { headers });
        return { models: (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean), tip: '' };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error(i18n.T('تعذّر جلب النماذج', 'Could not fetch models'));
  }
  throw new Error(i18n.T(`مزود غير معروف: ${provider}`, `Unknown provider: ${provider}`));
}

function buildMockAgentAnswer({ mode = 'project', question = '', review = null, projectState = null, nextAction = null, resolved = null, contextNotes = [] }) {
  const E = i18n.lang() === 'en';
  const T = (ar, en) => (E ? en : ar);
  const lines = [];
  lines.push(`Mode: ${mode}`);
  if (question) lines.push(`${T('سؤالك', 'Your question')}: ${question}`);
  if (resolved?.resolved) lines.push(`${T('العنصر الأقرب', 'Closest item')}: ${resolved.resolved.title} (${resolved.resolved.type})`);
  if (contextNotes.length) lines.push(`${T('السياق', 'Context')}: ${contextNotes.map(n => n.title).join(E ? ', ' : '، ')}`);
  if (review) lines.push(`${T('نوع العنصر الحالي', 'Current item type')}: ${review.classification.primaryType}`);
  if (projectState) {
    lines.push(`${T('المشروع النشط', 'Active project')}: ${projectState.project}`);
    lines.push(`${T('درجة الصحة', 'Health score')}: ${projectState.healthScore}/100`);
    if (projectState.nextActions.length) lines.push(`${T('أفضل خطوة تالية', 'Best next step')}: ${projectState.nextActions[0].text}`);
  }
  if (nextAction?.text) lines.push(`${T('التوصية التنفيذية', 'Executive recommendation')}: ${nextAction.text}`);
  lines.push(T('هذه إجابة mock grounded على الذاكرة الحالية. فعّل نموذجًا حقيقيًا لردود أغنى.', 'This is a grounded mock answer over the current memory. Enable a real model for richer replies.'));
  return lines.join('\n\n');
}
/* قراءة بثّ OpenAI-compatible (SSE) وتمرير القطع للمستمع لحظة وصولها.
   يقلّص الزمن المُحسّ به من «زمن الرد كاملاً» إلى «أول رمز» — وهو الفرق بين
   14 ثانية صمت و14 ثانية نصّ يتدفق. تُرجع النص الكامل والرموز إن أعلنها المزود. */
async function readProviderStream(response, onDelta) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j = null;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) usage = j.usage;
      const delta = j.choices && j.choices[0] && (j.choices[0].delta || {});
      if (delta && typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        try { onDelta(delta.content); } catch { /* المستمع لا يُسقط النداء */ }
      }
    }
  }
  return { text, usage };
}

/* إزالة كتل التفكير من الرد (إصلاح 2026-11-13): بعض النماذج تُضمّن
   `<think>…</think>` داخل content نفسه (مقيس على MiniMax-M2.7 عبر مزود vLLM)،
   فيرى المستخدم تفكيره الخام. تُحذف الكتلة، وإن لم يبقَ نص نُعيد الأصل
   (لا نُفرغ الجواب أبداً). */
function stripThinkTags(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return raw;
  const cleaned = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^\s+/, '').trim();
  return cleaned || raw.trim();
}

/* ── «اسأل مكتبتك» (2026-11-15) ────────────────────────────────────────────
   البحث يعيد ملاحظات، والوكيل يصوغ. الناقص: جواب **بمقاطع** ومصادر مرقّمة،
   و«لا أعرف» صريحة. التقطيع هنا لا في النموذج: نختار من كل ملاحظة أقرب فقرة
   للسؤال، ونمرّرها مرقّمة، ونطلب الإحالة برقمها. */
function askTokens(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
}
function pickChunk(text, question) {
  const raw = String(text || '');
  /* الملاحظة القصيرة تُرسل كاملة (2026-11-15): اختيار «أقرب فقرة» كان يبتر
     دستوراً كاملاً إلى سطر واحد، فيقول النموذج «لا أعرف» وعنده الجواب. */
  if (raw.length <= 1600) return raw;
  const sections = raw.split(/\n(?=#{1,3}\s)/).map((x) => x.trim()).filter((x) => x.length > 30);
  if (!sections.length) return raw.slice(0, 1400);
  const qs = new Set(askTokens(question));
  const scored = sections.map((sec) => {
    const ts = askTokens(sec);
    let hit = 0;
    for (const t of ts) if (qs.has(t)) hit += 1;
    return { sec, score: hit / Math.sqrt(ts.length + 1) };
  }).sort((a, b) => b.score - a.score);
  let out = '';
  for (const item of scored) {
    if (out.length >= 1300) break;
    out += (out ? '\n\n' : '') + item.sec.slice(0, 1300 - out.length);
  }
  return out || raw.slice(0, 1300);
}

async function callModel(settings, messages, options = {}) {
  const provider = settings.ai?.provider || 'mock';
  const model = settings.ai?.model || '';
  const temperature = Number(settings.ai?.temperature ?? 0.2);
  // أسعار معلَنة للمزود (إن وُجدت) — أساس تقدير التكلفة بلا تخمين (م12)
  const pricing = pricingFor(settings, provider);
  // ═══ بوابة الخصوصية الفعلية (كانت موثّقة ومختبَرة ولا يستدعيها شيء — عطل مؤكد) ═══
  // القرار حتمي بكود: هل يجوز إرسال هذا الصنف لهذا المزود؟ سجل الاتصال إلزامي.
  const dataClass = options.dataClass || 'knowledge';
  /* ═══ بوابة الخصوصية — تُقيَّم دائماً، لا بشرط المزود ═══
     العطل المُثبت حياً 2026-10-20 (from privacy-enforced.test.mjs): كل هذه البوابة
     كانت داخل `if (provider !== 'mock')` — فمع المزود الافتراضي `mock` (وهو مزود
     الاختبار وديمو الإقلاع) تُتخطّى **كلها**: لا فحص أسرار في الحمولة، ولا سجل
     اتصالات. أي أن `learning: {key}` أو مفتاحاً حقيقياً في نص المستخدم يمرّ بلا
     اعتراض، وسجل الاتصالات يبقى فارغاً فتبدو «السياسة منفَّذة» وهي معطّلة.
     القاعدة الصحيحة: الأسرار لا تُغادر الجهاز إلى **أي** مزود — حتى mock — لأن
     خطأ الإعداد (تعيين مزود سحابي لاحقاً) لا يجوز أن يفتح ثغرة قديمة. البوابة
     تُقيَّم أولاً دائماً؛ وحدها «موافقة الإرسال السحابي» تبقى مشروطة بالمزود. */
  const providersEnabled = !!(settings.ai && settings.ai.provider && settings.ai.provider !== 'mock');
  const isLocalOrMock = provider === 'mock' || provider === 'local' || provider === 'llamacpp';

  // [1] كشف الأسرار في الحمولة — يُنفَّذ دائماً وقبل أي شيء (حتى mock).
  if (privacyMod && typeof privacyMod.scanForSecrets === 'function') {
    const payloadText = JSON.stringify(messages || []);
    const found = privacyMod.scanForSecrets(payloadText);
    if (Array.isArray(found) && found.length) {
      writeAudit('secret_in_outbound_payload', { provider, count: found.length }, { scope: 'privacy' });
      throw new Error(`مُنع الإرسال: الحمولة تحوي ${found.length} سراً محتملاً (مفتاح/رمز). أزل الأسرار من النص قبل الإرسال.`);
    }
  }

  // [2] قرار الصنف/المزود — يُقيَّم دائماً (الحكم الحتمي §35).
  if (privacyMod && typeof privacyMod.limitsFor === 'function') {
    let verdict;
    try { verdict = privacyMod.limitsFor(provider, dataClass, { providersEnabled }); } catch { verdict = { allowed: true }; }
    if (verdict && verdict.allowed === false) {
      writeAudit('external_send_blocked', { provider, dataClass, reason: verdict.note || 'محظور بالسياسة' }, { scope: 'privacy' });
      throw new Error(`محظور بالسياسة: لا يجوز إرسال «${dataClass}» إلى «${provider}» — ${verdict.note || ''}`);
    }
  }

  // [3] سجل الاتصالات — يُكتب بعد كل نداء نموذج فعلي، حتى للمزود المحلي/mock،
  //     لأن عقد §«محلي أولاً» يوجب **أثراً** لا نيّة (اختبار «سجل الاتصالات فارغ
  //     — السياسة غير منفّذة» كان يرصد هذه الثغرة بالضبط).
  if (privacyMod && typeof privacyMod.logConnection === 'function') {
    try {
      privacyMod.logConnection(layerDb(), {
        provider: activeProviderName(settings), purpose: options.mode || 'chat', dataClass,
        allowed: true, bytes: JSON.stringify(messages || []).length,
        note: `إرسال ${dataClass} عبر ${settings.ai?.baseUrl || provider}${isLocalOrMock ? ' (محلي)' : ''}`,
      });
    } catch { /* السجل لا يُسقط الرد */ }
  }
  const mode = options.mode || settings.agent?.defaultMode || 'project';
  const contextNotes = options.contextNotes || [];
  const resolved = options.resolved?.resolved ? `العنصر المرجعي: ${options.resolved.resolved.title} / ${options.resolved.resolved.type}` : 'لا يوجد عنصر مرجعي محسوم.';
  const projectStateBlock = options.projectState ? `حالة المشروع:\n${options.projectState.summary}` : 'لا توجد حالة مشروع.';
  const context = contextNotes.map(n => `### ${n.title}\n${(n.body || n.content).slice(0, 1600)}`).join('\n\n---\n\n');
  const sys = options.system || [
    'أنت Cortex، طبقة عقل وذاكرة تشغيلية.',
    'أجب فقط اعتمادًا على السياق والذاكرة الحالية عندما يكون ذلك ممكنًا.',
    'إذا كان المرجع غامضًا فاذكر أفضل تخمين واضح مع الإشارة إلى سبب الاختيار.',
    `الوضع: ${mode}`,
    resolved,
    projectStateBlock,
    context ? `سياق الذاكرة:\n${context}` : 'لا يوجد سياق إضافي.'
  ].join('\n\n');
  if (provider === 'mock') return { text: buildMockAgentAnswer({ mode, question: messages.at(-1)?.content || '', review: options.review, projectState: options.projectState, nextAction: options.nextAction, resolved: options.resolved, contextNotes }) };
  if (provider === 'ollama') {
    const base = core.validatePublicHttpUrl((settings.ai.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')).origin;
    const response = await timedFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: sys }, ...messages], options: { temperature } }) }, MODEL_TIMEOUT_MS);
    if (!response.ok) throw new Error(`خطأ Ollama ${response.status}: ${await response.text()}`);
    const data = await response.json();
    recordModelCall('ollama', model, { prompt: data.prompt_eval_count, completion: data.eval_count }, { purpose: mode, ok: true, base, pricing });
    return { text: data.message?.content || 'لا رد.' };
  }
  if (provider === 'openai-compatible') {
    // الأولوية للمسار النشط (baseUrl) — openaiBaseUrl مجرد احتياط.
    // عكس ذلك يجعل الطلب يذهب لمزود آخر بمفتاح لا يخصّه (401 مؤكد).
    const base = core.validatePublicHttpUrl((settings.ai.baseUrl || settings.ai.openaiBaseUrl || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '')).origin;
    const headers = { 'Content-Type': 'application/json' };
    if (settings.ai.apiKey) headers.Authorization = `Bearer ${settings.ai.apiKey}`;
    const wantStream = options.stream === true && typeof options.onDelta === 'function';
    const payloadBody = { model, temperature, max_tokens: 2500, messages: [{ role: 'system', content: sys }, ...messages], ...(wantStream ? { stream: true, stream_options: { include_usage: true } } : {}) };
    const response = await timedFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payloadBody) }, MODEL_TIMEOUT_MS);
    if (wantStream) {
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        recordModelCall(activeProviderName(settings), model, null, { purpose: mode, ok: false, base, pricing });
        throw new Error(`خطأ ${response.status}: ${raw.slice(0, 300)}`);
      }
      const { text, usage } = await readProviderStream(response, options.onDelta);
      recordModelCall(activeProviderName(settings), model, { prompt: usage?.prompt_tokens, completion: usage?.completion_tokens }, { purpose: mode, ok: true, base, pricing });
      return { text: stripThinkTags(text) || 'لا رد.' };
    }
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const preview = (await response.text()).slice(0, 200);
      throw new Error(`الخادم أرجع HTML بدل JSON.\nتأكد من الـ Base URL.\nبداية الرد: ${preview}`);
    }
    const data = await response.json();
    if (!response.ok) {
      recordModelCall(activeProviderName(settings), model, null, { purpose: mode, ok: false, base, pricing });
      throw new Error(`خطأ ${response.status}: ${data.error?.message || JSON.stringify(data)}`);
    }
    recordModelCall(activeProviderName(settings), model, { prompt: data.usage?.prompt_tokens, completion: data.usage?.completion_tokens }, { purpose: mode, ok: true, base, pricing });
    return { text: stripThinkTags(data.choices?.[0]?.message?.content) || 'لا رد.' };
  }
  throw new Error(`مزود غير معروف: ${provider}`);
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  /* الضغط للحمولات الكبيرة فقط (> 2KB): تحت هذا الحد يكسب gzip صفراً ويضيف CPU.
     Vary: Accept-Encoding يمنع أي كاش وسيط من خلط نسخة مضغوطة بأخرى ساذجة. */
  if (res._gzipOk && body.length > 2048 && !res.headersSent) {
    try {
      const gz = zlib.gzipSync(Buffer.from(body, 'utf8'));
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'Content-Length': gz.length,
      });
      return res.end(gz);
    } catch { /* فشل الضغط: نسقط إلى الجسم الساذج */ }
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
/**
 * §26 (i18n): رسائل الحرّاس في مسارات API تُرجَّم بلغة الطلب.
 * كان نصّ الرفض عربياً دائماً حتى مع lang=en — فيرى مستخدم الإنجليزية رسالة لا يفهمها.
 */
function apiMsg(src, ar, en) {
  return i18n.T(ar, en, src);
}
/** لغة هذا الطلب: ?lang= ثم جسم الطلب ثم إعدادات الخادم — تُحلّ مرة واحدة عند المدخل. */
async function requestLang(url, req) {
  // الأولوية: جسم الطلب ← ?lang= ← إعدادات الخادم (جسم الطلب أدق لأنه يخصّ العملية نفسها).
  const own = req && req._cortexPayload && (req._cortexPayload.lang || req._cortexPayload.language);
  if (own) return i18n.norm(own);
  const q = String(url.searchParams.get('lang') || '').toLowerCase();
  if (q === 'ar' || q === 'en') return q;
  try { return resolveAgentLang(await core.readSettings()); } catch { return 'ar'; }
}
/**
 * هل الطلب المُغيِّر (كتابة/تنفيذ) من أصل محلي موثوق؟
 * يُرفض الطلب إن حمل Origin/Referer لأصل خارجي — لا يُقبل «لا أصل» إلا للطلبات المحلية.
 * قاعدة الطلب البسيط (simple request) تتجاوز CORS، لذلك الفحص هنا ضروري ولا يكفيه applyCors.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
function isTrustedMutation(req, url) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  // مسار الصحة/الثابت لا يغيّر شيئاً
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp') return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const check = (value) => {
    if (!value) return null;
    try { return new URL(value).hostname; } catch { return '__invalid__'; }
  };
  const oh = check(origin);
  if (oh !== null) return LOCAL_HOSTNAMES.has(oh);
  const rh = check(referer);
  if (rh !== null) return LOCAL_HOSTNAMES.has(rh);
  // لا Origin ولا Referer: طلب برمجي محلي (curl/سكربت). نقبله فقط إن لم يكن الطلب من متصفح.
  const secFetch = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetch === 'cross-site') return false;
  if (secFetch === 'same-origin' || secFetch === 'same-site' || secFetch === 'none') return true;
  return true;
}

// CORS للأصول المحلية فقط: لا تُترك الواجهة البرمجية مفتوحة لأي صفحة خارجية
// ─────────────── §33/§34: بوابة هوية للكتابة ───────────────
//
// قبل هذا: أي عملية تصل إلى البورت 3737 كانت تنفّذ كتابة على القرص بلا جلسة
// (`POST /api/agent/execute` أثبت عملياً إنشاء ملف بـapplied:[{tool:fs_write}]).
// الحل: رمز جلسة محلي (capability token) يُولَّد عند الإقلاع، يُكتب بصلاحية
// 0600 في data/session.token، ويتسلّمه المتصفح من /api/session. كل مسار كتابة
// يشترطه عبر requireSession. القراءة تبقى حرة (عرض فقط لا يؤثر على القرص).
const crypto = require('crypto');
/* ملاحظة تصميم (2026-11-12): الرمز يبقى في `__dirname/data` لا في WORK_ROOT —
   قرار صريح بعد قياس: جعله تابعاً للجذر يكسر كل عميل محلي يقرأ الملف من مسار
   المشروع (اختبارات، CLI، غلاف Electron) دون أن يضيف حداً أمنياً حقيقياً:
   الحد هو ملكية الملف لنفس المستخدم، لا مساره. التغيير المُجرَّب أُلغِي. */
const SESSION_TOKEN_FILE = path.join(__dirname, 'data', 'session.token');
let SESSION_TOKEN = null;

function ensureSessionToken() {
  if (SESSION_TOKEN) return SESSION_TOKEN;
  // أعد استخدامه إن وُجد (حتى لا تنكسر الجلسات المفتوحة عند إعادة الإقلاع)
  try {
    const t = fs.readFileSync(SESSION_TOKEN_FILE, 'utf8').trim();
    if (t && t.length >= 32) { SESSION_TOKEN = t; return t; }
  } catch { /* غير موجود — نولّده */ }
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SESSION_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(SESSION_TOKEN_FILE, t, { mode: 0o600 });
    fs.chmodSync(SESSION_TOKEN_FILE, 0o600);
  } catch { /* القرص غير قابل للكتابة — الرمز يبقى في الذاكرة لهذه الجلسة */ }
  SESSION_TOKEN = t;
  return t;
}

/* ── رمز MCP (تدقيق 2026-11-11): `/mcp` كان يقبل الكتابة بلا أي هوية. الخيار
   «اقفل المنفذ» يكسر عملاء MCP الخارجيين وهم الغرض المعلن، و«اتركه مفتوحاً»
   يجعل أي عملية محلية تكتب في الذاكرة. الحل الثالث هو الصحيح: رمز **مخصّص لـMCP**
   (ملف 0600، منفصل عن رمز الجلسة فلا يمنح تحكّماً كاملاً) يُرسَل في ترويسة
   `Authorization: Bearer`، ويُعرض داخل الإعداد الذي تنسخه من نافذة MCP. */
const MCP_TOKEN_FILE = path.join(__dirname, 'data', 'mcp.token');
let MCP_TOKEN = null;
function ensureMcpToken() {
  if (MCP_TOKEN) return MCP_TOKEN;
  try {
    const t = fs.readFileSync(MCP_TOKEN_FILE, 'utf8').trim();
    if (t && t.length >= 32) { MCP_TOKEN = t; return t; }
  } catch { /* غير موجود — نولّده */ }
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(MCP_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(MCP_TOKEN_FILE, t, { mode: 0o600 });
    fs.chmodSync(MCP_TOKEN_FILE, 0o600);
  } catch { /* القرص غير قابل للكتابة — الرمز يبقى في الذاكرة */ }
  MCP_TOKEN = t;
  return t;
}
/** هل الطلب يحمل رمز MCP الصحيح؟ (Bearer، مقارنة ثابتة الزمن) */
function mcpTokenOk(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers['authorization'] || ''));
  if (!m) return false;
  return sameToken(m[1], ensureMcpToken());
}

/** مقارنة ثابتة الزمن (منع تسريب الرمز بحسّاسية الزمن) */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * هل الطلب يملك جلسة صالحة؟
 * الرمز يُقبل من ترويسة X-Cortex-Session أو من الرمز داخل الاستعلام (SSE/تنزيل)،
 * أو من كوكي cortex_session (يُضبط عند /api/session ليخدم واجهة الصفحة).
 */
function sessionOk(req) {
  const hdr = req.headers['x-cortex-session'];
  if (hdr && sameToken(hdr, ensureSessionToken())) return true;
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|; *)cortex_session=([^;]+)/);
  if (m && sameToken(decodeURIComponent(m[1]), ensureSessionToken())) return true;
  /* حُذف قبول `?session=<token>` (2026-11-12): كان تجاوزاً كاملاً لبوابة §34 —
     الرمز في العنوان يتسرّب إلى سجلات الخادم، وReferer، وتاريخ المتصفح، وأي
     وكيل وسيط، ويبقى صالحاً بعدها. الاختبار SEC-02 كان يُثبته كسلوك مقبول.
     البديلان الشرعيان فقط: ترويسة X-Cortex-Session أو كوكي HttpOnly. */
  return false;
}

/**
 * حارس الكتابة: يرفض الطلب بلا جلسة ما لم يكن من أصل محلي صريح.
 * القاعدة: لا كتابة على القرص بلا هوية (§34)، ولا استثناء «صامت» يفتح الباب
 * للشبكة المحلية. طلب بلا Origin وبرمز مفقود = 401 صريح.
 */
function requireSession(req, res) {
  if (sessionOk(req)) return true;
  applyCors(req, res);
  json(res, 401, {
    ok: false,
    error: i18n.T('جلسة غير موثّقة: الكتابة تتطلب رمز جلسة (افتح الواجهة على 127.0.0.1:3737)', "Unauthenticated session: writes require a session token (open the UI on 127.0.0.1:3737)"),
    code: 'no_session',
  });
  return false;
}

/* أصول الخادم نفسه فقط. كان CORS يعكس الأصل لأي منفذ localhost ⇒ أي صفحة على
   منفذ محلي آخر (خادم تطوير/تطبيق ثالث) تقرأ /api/session فتحصل على رمز الكتابة،
   ثم تقرأ أي ملف. القياس (2026-11-11): Origin: http://localhost:3000 كان يحصل على
   ACAO و200 مع الرمز. القاعدة: مطابقة الأصل الكامل (مخطط+مضيف+منفذ). */
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
]);
/* مضيفو الطلب المقبولون — يغلق إعادة ربط DNS: صفحة خارجية تجعل نطاقها يشير إلى
   127.0.0.1 فترسل Host: evil.example وتقرأ الخزنة. أي Host آخر يُرفض 421. */
const SELF_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  if (SELF_ORIGINS.has(String(origin).toLowerCase())) res.setHeader('Access-Control-Allow-Origin', origin);
}

/* ترويسات أمان للإطلاق المفتوح (2026-11-05): كانت غائبة تماماً.
   CSP تسمح بالملفات المحلية فقط (لا سكربت بعيد)، وتمنع التأطير وقراءة النوع
   الخاطئ — أي أن صفحة خارجية لا تستطيع تحميل الواجهة في إطار أو حقن سكربت بعيد. */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
}
function textR(res, code, data, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(data);
}
async function body(req) {
  // الحمولة تُقرأ مرة واحدة وتُخزَّن: حلّ اللغة عند المدخل يحتاج body.lang قبل المتناول.
  if (req._cortexPayload !== undefined) return req._cortexPayload;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error(i18n.T(`حجم الطلب يتجاوز الحد المسموح (${Math.round(MAX_BODY_BYTES / 1024)} كيلوبايت)`, `Request body exceeds the allowed limit (${Math.round(MAX_BODY_BYTES / 1024)} KB)`));
      err.statusCode = 413;
      throw err;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try {
    req._cortexPayload = JSON.parse(raw);
    return req._cortexPayload;
  } catch {
    const err = new Error(i18n.T('جسم الطلب ليس JSON صالحًا', 'Request body is not valid JSON'));
    err.statusCode = 400;
    throw err;
  }
}
function serializeSearchResults(result) {
  return {
    mode: result.mode,
    provider: result.provider,
    model: result.model,
    rerankStrategy: result.rerankStrategy,
    /* كان يُحسب في النواة ثم يُسقَط هنا ⇒ الواجهة لا تعرف أن الفهرس قديم
       (عطل مُقاس 2026-11-11 في التدقيق الوظيفي: indexStale=undefined). */
    indexStale: result.indexStale === true,
    indexStatus: result.indexStatus,
    results: (result.results || []).map(r => ({
      id: r.id,
      title: r.title,
      tags: r.tags,
      type: r.type,
      project: r.project,
      isDocument: r.isDocument,
      documentType: r.documentType,
      snippet: r.snippet,
      score: r.score,
      semantic: r.semantic,
      lexical: r.lexical,
      rerankScore: r.rerankScore,
      chunkCount: r.chunkCount
    }))
  };
}

/**
 * §34 — حارس الكتابة المركزي.
 * العطل المُثبت حيّاً 2026-10-20: كانت الحماية تُطبَّق باستدعاء `requireSession` يدوياً في
 * كل مسار، فسقطت ثلاثة مسارات كتابة فعلية من الحراسة (backup=200، agent/session/start=200،
 * DELETE /api/notes/:id=200 بلا رمز) — أي كتابة/حذف على القرص بهوية مجهولة.
 * القاعدة الآن: كل طلب **مُغيِّر** (غير GET/HEAD/OPTIONS) يُحجز هنا قبل أي معالجة،
 * باستثناء مسارات صغيرة مُعلنة صراحةً.
 */
/* §34 — الاستثناءات المُعلنة صراحةً (لا استثناء ضمني).
   مسارات القراءة وحدها حرة: الواجهة تحتاجها قبل امتلاك الرمز (الإقلاع).
   أي كتابة لا تظهر في هذه القائمة المُعلنة ⇒ تحتاج رمزاً.
   الاستثناء المُعلن الوحيد (2026-10-30): POST /mcp — منفذ الاتصال العام لعملاء MCP
   الخارجيين؛ هؤلاء وكلاء غير متصفحين لا يحملون رمز جلسة بطبيعتهم. والحدّ الأمني الذي
   تحميه §34 (كتابة من صفحة ويب غير موثوقة) مسدود على /mcp بنيوياً: (١) الخادم لا
   يستمع إلا على 127.0.0.1، (٢) isTrustedMutation يفحص أصل كل طلب كتابة على /mcp
   أيضاً، (٣) POST بجسم JSON يستلزم preflight من المتصفحات فلا تصله صفحة عشوائية.
   ولا يوسّع هذا الثقة القائمة: أي عملية محلية تستطيع أصلاً تشغيل خادم stdio والكتابة
   عبره — المنفذان سطحا ثقة واحد. */
/* عقد التصميم (2026-10-30، موثَّق أعلاه): /mcp يثق بالعمليات المحلية كسطح stdio
   نفسه، فكتابته بلا رمز جلسة مقصودة. تبقى بنداً في تقرير التدقيق (درجة P1) لأنها
   تُوسّع سطح الثقة لأي عملية على الجهاز — لكن إغلاقها يكسر عملاء MCP الخارجيين
   (Claude Code/Codex) وهم الغرض المعلن للخادم، فلا تُغيَّر بلا قرار صريح. */
const UNAUTHENTICATED_WRITE_ALLOW = new Set(['POST /mcp']);
/* حُذفت `READ_ONLY_ROUTES` (2026-11-12): كانت قائمة ميتة لا يقرأها أحد —
   الحاكم الفعلي هو `requiresSession` القائم على الطريقة + SIDE_EFFECT_READS.
   وكانت أيضاً مضلِّلة: تُدرج GET /api/session كقراءة حرّة، وقد صار محكوماً
   ببوابة المتصفح. قائمة تُوهم بالحماية أسوأ من غيابها. */
/* `isReadOnlyRoute` أُزيلت 2026-10-25 — كانت دالة ميتة: لا مستدعي لها،
   والحاكم الفعلي هو `requiresSession` أدناه. */
/* مسارات قراءة بأثر جانبي — تُعامل ككتابة (تقرير هجومي 2026-10-26 F5/F12):
   GET /api/export/project يكتب ملفاً على القرص؛ 20 طلباً بلا هوية أنتجت
   20 ملفاً. التصنيف بالطريقة وحدها لا يكفي، فالنيّة (أثر) هي المعيار.
   الواجهة لا تتأثر: الكوكي يُرسَل تلقائياً مع التنزيل من نفس الأصل. */
const SIDE_EFFECT_READS = new Set([
  'GET /api/export/project',
  /* ثغرة مؤكدة (2026-11-11): /api/file غير مصادَق أعاد **رمز الجلسة نفسه**
     (data/session.token) ومفتاح التشفير (data/.keystore) ⇒ تجاوز كامل لبوابة §34
     ثم فكّ enc:v1 من settings.json. القاعدة: قراءة ملفات ليست قراءة بريئة. */
  'GET /api/file',
  /* يعرض رمز MCP (كي يُنسخ الإعداد من الواجهة) ⇒ قراءة حسّاسة تحتاج جلسة. */
  'GET /api/mcp-info',
]);
/* ملاحظة تصميم (2026-11-11): `GET /api/notes/:id` يكتب `data/workspace-state.json`
   (تتبّع «آخر فتح») — أي قراءة بأثر كتابة. لم نُدرجه في القواعد أعلاه لأن قراءة
   الملاحظة عقد قراءة مفتوح في تطبيق محلي أحادي المستخدم، ولأن الواجهة تعتمد على
   التتبّع. الأثر المتبقّي: كتابة ملف حالة داخلية عند القراءة — لا تُغيّر بيانات
   المستخدم، والمسار محليّ. الإصلاح الجذري (فصل التتبّع في نداء صريح) مؤجَّل بقرار. */
function requiresSession(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (SIDE_EFFECT_READS.has(`${m} ${pathname}`)) return true;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  if (UNAUTHENTICATED_WRITE_ALLOW.has(`${m} ${pathname}`)) return false;
  return true; // كل ما ليس قراءةً يحتاج رمزاً — القاعدة لا الاستثناء
}

/* سقف التوازي (عطل مُقاس 2026-11-11): `Number(payload.maxParallel) || 3` كان يقبل
   64 (سقف MAX_TASKS وحده)، وكل مهمة نداء نموذج حتى 12 خطوة ⇒ طلب واحد يولّد مئات
   النداءات والمسودات. النطاق صريح ومعلن. */
function clampParallel(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.max(1, Math.min(Math.floor(n), 8));
}

/* صنف المسار المكلف — يُستخدم لميزان الرشقة فقط، لا للمصادقة ولا للتوجيه. */
function rateBucketFor(pathname) {
  const p = String(pathname || '');
  if (/^\/api\/import(?:\/|$)/.test(p)) return 'import';
  if (/^\/api\/export(?:\/|$)/.test(p)) return 'export';
  if (/^\/api\/(?:agent|orchestrate)(?:\/|$)/.test(p)) return 'agent';
  if (/^\/api\/ai(?:\/|$)/.test(p)) return 'ai';
  if (/^\/api\/models\/(?:probe|probe-provider|fetch-models|test)/.test(p)) return 'models';
  return null;
}


/* ── جسر الاستيراد للوكيل (2026-11-13) ─────────────────────────────────────
   كان منطق الاستيراد محبوساً داخل معالجات HTTP، فلم يملك الوكيل أداة استيراد:
   القسم بشري بالكامل. الحل هنا: الوكيل ينادي **نفس المسار العام** على
   ‏127.0.0.1 — لا نسخة ثانية من المنطق تنحرف عن الأصل، وتمرّ الحوكمة والجلسة
   والتدقيق كما تمرّ لأي مستخدم. */
async function callLocalApi(method, pathname, payload) {
  let token = '';
  try { token = String(await fsp.readFile(path.join(core.dataDir, 'session.token'), 'utf8')).trim(); } catch { /* بلا رمز: يُرفض */ }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Cortex-Session': token } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { ok: false, error: i18n.T('تعذّر الوصول إلى الخادم المحلي: ', 'Local server unreachable: ') + e.message } };
  }
}


/* ── فحص خادم MCP قبل حفظه (2026-11-13) ───────────────────────────────────
   كان «أضف خادماً» يكتب الإعداد فقط: بلا تشغيل ولا اكتشاف، فيُحفظ خادم ميت
   ويظهر «0 أداة» بلا سبب. الفحص: تشغيل + مصافحة + tools/list. */
/* محاولة فحص واحدة بإطار محدد: content-length (معيار MCP) أو ndjson. */
function probeMcpOnce({ command, args = [], framing, timeoutMs }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let child = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child) child.kill(); } catch { /* أُغلق */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, step: 'timeout', error: 'timeout' }), timeoutMs);
    try {
      child = spawn(command, args, { cwd: '.', shell: false, windowsHide: true, env: { ...process.env } });
    } catch (e) { return finish({ ok: false, step: 'connect', error: e.message }); }
    const write = (obj) => {
      const json = JSON.stringify(obj);
      try {
        if (framing === 'ndjson') child.stdin.write(json + '\n');
        else child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
      } catch { /* انقطع */ }
    };
    const onMessage = (msg) => {
      if (!msg) return;
      if (msg.id === 1) {
        write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (msg.id === 2) {
        const tools = (msg.result && Array.isArray(msg.result.tools)) ? msg.result.tools : [];
        if (!tools.length) return finish({ ok: false, step: 'tools', error: i18n.T('الخادم لم يعلن أي أداة (tools/list فارغ) — ليس خادم MCP صالحاً', 'The server announced no tools (empty tools/list) — not a valid MCP server') });
        finish({ ok: true, tools: tools.map(t => ({ name: t.name, description: String(t.description || '').slice(0, 200) })) });
      }
    };
    child.on('error', (e) => finish({ ok: false, step: 'connect', error: e.message }));
    child.on('exit', (code) => finish({ ok: false, step: 'connect', error: i18n.T(`انتهى الخادم قبل الرد (exit ${code})`, `The server exited before answering (exit ${code})`) }));
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (framing === 'ndjson') {
        let idx;
        while ((idx = buf.indexOf(0x0a)) >= 0) {
          const line = buf.slice(0, idx).toString('utf8').trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line)); } catch { /* سطر غير JSON */ }
        }
        return;
      }
      // content-length
      while (true) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const header = buf.slice(0, sep).toString('utf8');
        const m = /content-length:\s*(\d+)/i.exec(header);
        if (!m) { buf = buf.slice(sep + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < sep + 4 + len) return;
        const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
        buf = buf.slice(sep + 4 + len);
        try { onMessage(JSON.parse(body)); } catch { /* جسم غير JSON */ }
      }
    });
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cortex', version: '5' } } });
  });
}

/* فحص خادم MCP قبل حفظه (2026-11-13): كان «أضف خادماً» يكتب الإعداد فقط.
   يُجرَّب الإطار المعياري أولاً ثم NDJSON — خوادم كثيرة تنفّذ واحداً منهما فقط. */
async function probeMcpServer({ name, command, args = [], timeoutMs = 24000 }) {
  const per = Math.max(6000, Math.floor(timeoutMs / 2));
  let last = null;
  for (const framing of ['content-length', 'ndjson']) {
    const r = await probeMcpOnce({ command, args, framing, timeoutMs: per });
    if (r.ok) return r;
    if (r.step === 'tools') return r;   // اتصل لكن بلا أدوات — الإطار ليس المشكلة
    last = r;
  }
  return {
    ok: false, step: last && last.step === 'connect' ? 'connect' : 'timeout',
    error: (last && last.error && last.error !== 'timeout')
      ? last.error
      : i18n.T(`الخادم لم يستجب خلال ${Math.round(per / 1000)} ثانية بأي إطار (Content-Length أو NDJSON)`, `The server did not answer within ${Math.round(per / 1000)}s in either framing (Content-Length or NDJSON)`),
  };
}

/* أدوات MCP التي يراها الوكيل: المُتحقَّق منها فقط، وبلا نظير أصلي —
   وإلا انتفخ الموجّه بـ28 أداة مكرّرة (memory_search = search_notes). */
const MCP_SHADOWED = new Set([
  'memory_search', 'memory_semantic_search', 'memory_get_note', 'memory_related',
  'memory_recent', 'memory_tag_search', 'memory_stats', 'memory_dashboard',
  'memory_list_projects', 'memory_classify_note', 'memory_extract_structured',
  'memory_find_contradictions', 'memory_find_gaps', 'memory_project_state',
  'memory_rebuild_index', 'memory_retrieval_status', 'memory_upsert_note',
  'memory_delete_note', 'memory_resolve_reference', 'project_absorb',
  'project_trail', 'memory_slice', 'memory_record', 'agent_start_session',
  'agent_capture_message', 'agent_review_context', 'agent_next_best_action',
  'agent_update_living_note',
]);

async function mcpAgentTools() {
  const cfg = await readMcpServers().catch(() => null);
  const servers = (cfg && cfg.mcpServers) || {};
  const out = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || !spec.command || !spec.verifiedAt) continue;
    if (spec.exposeToAgent === false) continue;
    for (const t of (spec.tools || [])) {
      if (!t || !t.name || MCP_SHADOWED.has(t.name)) continue;
      out.push({ name: `mcp__${name}__${t.name}`, description: String(t.description || t.name).slice(0, 200), server: name, tool: t.name });
    }
  }
  return out.slice(0, 40);
}

/* تنفيذ أداة MCP من الوكيل — نفس مسار /api/mcp/call (حوكمة واحدة لا نسختان). */
async function callMcpToolForAgent({ server, tool, args, approved }) {
  return callLocalApi('POST', '/api/mcp/call', { server, tool, args: args || {}, approved: approved === true });
}

/* ── استنتاج العلاقات تلقائياً (2026-11-14) ────────────────────────────────
   كان زراً يدوياً لا يُضغط، فبقيت التغطية «0 من 9» أبداً، وكل استيراد جديد
   يبقى جزيرة. الآن مسار واحد يخدم الزر والاستيراد والإقلاع:
     • بعد كل استيراد  ⇒ مؤجّل 4 ثوانٍ (دفعة واحدة لا استنتاج لكل ملف)
     • عند الإقلاع     ⇒ فقط إن لم توجد علاقة مُصنَّفة بعد
   لا يُنفَّذ مرتين بالتوازي، ويُسجَّل في التدقيق. */
let relInferTimer = null;
let relInferRunning = false;
function scheduleRelationsInfer(delayMs = 4000) {
  if (relInferTimer) clearTimeout(relInferTimer);
  relInferTimer = setTimeout(() => {
    relInferTimer = null;
    /* لا `.catch(() => {})` — ابتلاع الخطأ أخفى عطلاً حقيقياً («opt is not
       defined») فبدا الاستدراك كأنه لم يعمل. الفشل يُقال في الطرفية. */
    runRelationsInfer('import').catch((e) => console.error('relations infer failed:', e && e.message ? e.message : e));
  }, Math.max(500, Number(delayMs) || 4000));
  if (relInferTimer.unref) relInferTimer.unref();
}
async function runRelationsInfer(trigger = 'manual') {
  if (relInferRunning) return { skipped: 'running' };
  relInferRunning = true;
  try {
    /* optMod لا opt: الثانية اسم محلي داخل handleApi (سطر 3622)، واستعمالها
       هنا رمى «opt is not defined» فسقط استدراك الإقلاع صامتاً. */
    const rel = optMod('cortex-relations');
    const db = layerDb();
    if (!rel || !db) return { skipped: 'unavailable' };
    const notes = await core.readNotes();
    const out = rel.inferRelations(db, { notes });
    await core.appendAudit({ type: 'relations_inferred', trigger, added: out.added, byKind: out.byKind }).catch(() => {});
    return out;
  } finally {
    relInferRunning = false;
  }
}

async function doImportPath(args = {}) {
  const p = String(args.path || '').trim();
  if (!p) return { status: 400, body: { ok: false, error: i18n.T('المسار مطلوب', 'Path is required') } };
  return callLocalApi('POST', '/api/import', { path: p, project: String(args.project || '') });
}

/* مسار واحد للروابط — نفس قاعدة الواجهة (importRouteFor) حتى لا يختلف
   سلوك الوكيل عن سلوك المستخدم: git ⇒ استنساخ · https ⇒ صفحة · غير ذلك ⇒ مسار. */
async function doImportUrl(args = {}) {
  const url = String(args.url || '').trim();
  if (!url) return { status: 400, body: { ok: false, error: i18n.T('الرابط مطلوب', 'URL is required') } };
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
  if (['github.com', 'www.github.com', 'gitlab.com', 'bitbucket.org'].includes(host)) {
    return callLocalApi('POST', '/api/import/remote', { url, project: String(args.project || ''), depth: args.depth || 1 });
  }
  if (/^https?:\/\//i.test(url)) {
    return callLocalApi('POST', '/api/import/web', { url, project: String(args.project || '') });
  }
  return doImportPath({ path: url, project: args.project });
}

/* ما استُورد — كان 311 سجلاً في القاعدة بلا أي مسار لعرضها، ولا يعرف الوكيل
   أن مستندات مستوردة موجودة أصلاً. */
async function doImportList({ project = '', limit = 50 } = {}) {
  const projectParam = String(project || '').trim();
  const ldb = layerDb();
  if (!ldb) return { status: 503, body: { ok: false, error: i18n.T('طبقة SQLite غير متاحة', 'SQLite layer unavailable') } };
  const lim = Math.max(1, Math.min(Number(limit) || 50, 500));
  try {
    /* الحقيقة هي الملف لا الإسقاط: جدول notes يُبنى من الملفات بتأخير (debounce)،
       فاستيراد تم للتوّ لا يظهر فيه بعد — وكان يُحسب «يتيماً» خطأً. الفحص على
       وجود ملف الملاحظة نفسه. */
    const rows = ldb.prepare(`SELECT d.id, d.source, d.doc_type, d.imported_at, d.original_path, n.title, n.project
                              FROM document_entities d LEFT JOIN notes n ON n.id = d.id
                              ORDER BY d.imported_at DESC`).all();
    const documents = [];
    let orphaned = 0;
    for (const r of rows) {
      const noteFile = path.join(core.vaultDir, `${r.id}.md`);
      if (!fs.existsSync(noteFile)) { orphaned += 1; continue; }
      let title = r.title || '';
      let project = r.project || '';
      if (!title || project == null) {
        try {
          const head = String(await fsp.readFile(noteFile, 'utf8')).slice(0, 800);
          const tm = head.match(/^title:\s*(.+)$/m);
          const pm = head.match(/^project:\s*(.+)$/m);
          if (!title && tm) title = tm[1].trim().replace(/^["']|["']$/g, '');
          if (!project && pm) project = pm[1].trim().replace(/^["']|["']$/g, '');
        } catch { /* يبقى المعرّف */ }
      }
      if (projectParam && String(project) !== projectParam) continue;
      documents.push({
        id: r.id,
        title: title || r.id,
        kind: r.doc_type || null,
        project: project || '',
        source: r.source || r.original_path || null,
        importedAt: r.imported_at || null,
        sourceExists: Boolean(r.source && fs.existsSync(r.source)),
      });
      if (documents.length >= lim) break;
    }
    const missing = documents.filter(d => d.source && !d.sourceExists).length;
    return { status: 200, body: { ok: true, count: documents.length, missingSources: missing, orphaned, documents } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  // ── §34: البوابة المركزية — لا مسار كتابة يمرّ بلا هوية، ولو نُسي الحارس المحلي ──
  if (requiresSession(req.method, url.pathname) && !sessionOk(req)) {
    applyCors(req, res);
    return json(res, 401, {
      ok: false,
      error: i18n.T('جلسة غير موثّقة: الكتابة تتطلب رمز جلسة (افتح الواجهة على 127.0.0.1:3737)', "Unauthenticated session: writes require a session token (open the UI on 127.0.0.1:3737)"),
      code: 'no_session',
      method: req.method,
      path: url.pathname,
    });
  }
  // ── حدّ الرشقة (2026-10-26): المسارات المكلفة ──
  /* عطل مُقاس 2026-11-11: الشرط كان `method === 'POST'` وحده، فمرّت قراءات مكلفة
     بلا سقف: GET /api/export/project (يكتب ملفاً لكل نداء) وGET /api/search
     (يستدعي نموذجاً). الميزان يتبع صنف المسار، والقراءات ذات الأثر تُعامل
     ككتابة — كما في المصادقة تماماً. */
  {
    const bucket = rateBucketFor(url.pathname);
    const m0 = String(req.method || '').toUpperCase();
    const isWrite = m0 !== 'GET' && m0 !== 'HEAD';
    /* القراءات ذات الأثر (SIDE_EFFECT_READS) تُحاسَب أيضاً: GET /api/export/project
       يكتب ملفاً لكل نداء وكان بلا سقف لأن الشرط كان «POST فقط» (عطل مُقاس 2026-11-11). */
    if (bucket && (isWrite || SIDE_EFFECT_READS.has(`${m0} ${url.pathname}`))) {
      const gate = rateLimit(bucket, (req.socket && req.socket.remoteAddress) || '-');
      if (!gate.ok) {
        applyCors(req, res);
        res.setHeader('Retry-After', String(gate.retryAfter));
        return json(res, 429, {
          ok: false,
          error: i18n.T(
            `طلبات كثيرة على «${bucket}» خلال وقت قصير — أعد المحاولة بعد ${gate.retryAfter} ثانية`,
            `Too many ${bucket} requests in a short window — retry after ${gate.retryAfter}s`),
          code: 'rate_limited',
          bucket,
          retryAfter: gate.retryAfter,
          limit: gate.limit,
          windowMs: gate.windowMs,
        });
      }
    }
  }
  /* تسليم رمز الجلسة — إصلاح 2026-11-12 (ثغرة حرجة موثّقة في AUDIT-2026-11-11):
     كان `let ok = !origin` يعتبر **غياب** الترويسة موافقة، فأي عملية محلية تحصل على
     رمز الكتابة بطلب واحد. القاعدة الآن: لا يُسلَّم الرمز إلا لمن يثبت أنه **متصفح
     على هذا الأصل بالضبط** — ثلاث بوابات، كلها لازمة:
       1) Host يطابق ما يستمع عليه الخادم فعلًا (يغلق DNS rebinding).
       2) Origin غائب أو يطابق الأصل الكامل (لا يعكس أي localhost آخر).
       3) Sec-Fetch-Site = same-origin|none — ترويسة يفرضها المتصفح ولا يرسلها curl.
     من لا يملك الترويسات (سكربت/عملية أخرى) يُوجَّه إلى ملف الرمز على القرص:
     الوصول إلى الملف هو الحد الأمني الحقيقي، لا ترويسة HTTP. */
  if (req.method === 'GET' && url.pathname === '/api/session') {
    const hostHdr = String(req.headers.host || '').toLowerCase();
    if (hostHdr && !SELF_HOSTS.has(hostHdr)) {
      return json(res, 403, { ok: false, code: 'bad_host', error: i18n.T('مضيف غير مطابق — الجلسة تُسلَّم من 127.0.0.1 فقط', 'Host mismatch — the session token is issued from 127.0.0.1 only') });
    }
    const origin = String(req.headers.origin || '').toLowerCase();
    if (origin && !SELF_ORIGINS.has(origin)) {
      return json(res, 403, { ok: false, code: 'bad_origin', error: i18n.T('أصل غير محلي — الجلسة تُسلَّم من الجهاز نفسه فقط', 'Non-local origin — the session token is issued to the local machine only') });
    }
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    const browserProven = sfs === 'same-origin' || sfs === 'none';
    if (!browserProven) {
      return json(res, 403, {
        ok: false, code: 'not_a_browser',
        error: i18n.T('الرمز لا يُسلَّم لعملية غير متصفح. اقرأه من data/session.token وأرسله في X-Cortex-Session.',
          'The token is not handed to non-browser callers. Read it from data/session.token and send it in X-Cortex-Session.'),
        tokenFile: 'data/session.token',
      });
    }
    const t = ensureSessionToken();
    res.setHeader('Set-Cookie', `cortex_session=${t}; Path=/; HttpOnly; SameSite=Strict`);
    return json(res, 200, { ok: true, token: t, hint: i18n.T('أرسله في الترويسة X-Cortex-Session لكل كتابة', "Send it in the X-Cortex-Session header on every write") });
  }
  /* نبضة حياة رخيصة للحارس (عطل مُقاس 2026-11-05). كان الحارس يفحص /api/status
     وهو يشغّل reviewWorkspace + قراءة كل الملاحظات + حالة الاسترجاع ≈ 3–4 ثوانٍ
     على قاعدة حقيقية؛ وأثناء أي حمل يتجاوز مهلة 5 ثوانٍ فيُعلن «تعلّقاً» ويقتل
     الخادم في منتصف تشغيل وكيل (watchdog.log: hang_detected_killing). */
  if (req.method === 'GET' && url.pathname === '/api/ping') {
    return json(res, 200, { ok: true, app: 'Cortex', version: VERSION, uptime: Math.round(process.uptime()) });
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const settings = await core.readSettings();
    const notes = await core.readNotes();
    const workspaceReview = await core.reviewWorkspace();
    const retrieval = await core.getRetrievalStatus();
    const state = await core.readWorkspaceState();
    /* قدرات النموذج النشط كما أُثبتت بالفحص — لا بالاسم (م12). الواجهة تحتاجها
       لتقول «هذا النموذج بلا رؤية» قبل أن يفشل المستخدم (عطل UX 2026-11-05). */
    const activeInfo = (() => {
      const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
      const list = Array.isArray(settings.providers) ? settings.providers : [];
      const hit = list.find((p) => p && p.baseUrl && norm(p.baseUrl) === norm(settings.ai.baseUrl));
      const info = (hit && Array.isArray(hit.modelsInfo)) ? hit.modelsInfo.find((m) => m && m.id === settings.ai.model) : null;
      return (info && info.capabilities) || null;
    })();
    return json(res, 200, { ok: true, app: 'Cortex', version: VERSION, port: PORT, provider: settings.ai.provider, providerName: activeProviderName(settings), model: settings.ai.model || i18n.T('(لا يوجد)', '(none)'), capabilities: activeInfo, noteCount: notes.length, watchVersion: watchState.version, healthScore: workspaceReview.healthScore, activeProject: state.activeProject || '', retrieval: { provider: retrieval.provider, model: retrieval.model, entryCount: retrieval.entryCount, builtAt: retrieval.builtAt, dirty: retrieval.dirty, embeddingKind: retrieval.embeddingKind || null, idfTerms: retrieval.idfTerms ?? null }, daemon: daemonState() });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, await core.getDashboardData());
  if (req.method === 'GET' && url.pathname === '/api/brain/map') {
    const notes = await core.readNotes();
    return json(res, 200, core.buildBrainModel(notes));
  }
  if (req.method === 'POST' && url.pathname === '/api/resolve') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    return json(res, 200, await core.resolveReference(payload.query || '', payload));
  }
  if (req.method === 'POST' && url.pathname === '/api/context/track') {
      if (!requireSession(req, res)) return;
    return json(res, 200, await core.recordActivity(await body(req)));
  }
  if (req.method === 'GET' && url.pathname === '/api/watch-state') return json(res, 200, { version: watchState.version, lastChanged: watchState.lastChanged, reason: watchState.reason });
  if (req.method === 'GET' && url.pathname === '/api/watch') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ version: watchState.version, lastChanged: watchState.lastChanged, reason: watchState.reason })}\n\n`);
    watchState.clients.add(res);
    req.on('close', () => watchState.clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/notes') {
    const notes = await core.readNotes();
    return json(res, 200, { notes: notes.map(({ content, body, structured, entities, fingerprint, ...rest }) => rest) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/notes/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const note = (await core.readNotes()).find(n => n.id === id);
    if (!note) return json(res, 404, { error: i18n.T('ملاحظة غير موجودة', "Note not found") });
    await core.recordActivity({ noteId: note.id, project: note.projectName || '' });
    return json(res, 200, { note });
  }
  if (req.method === 'POST' && url.pathname === '/api/notes') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    // §24 + §38: نلتقط الحالة السابقة قبل الكتابة، وإلا لا يوجد تراجع ممكن أصلاً.
    let beforeNote = null;
    if (payload.id) {
      try { beforeNote = (await core.readNotes()).find(n => n.id === payload.id) || null; } catch { beforeNote = null; }
    }
    const note = await core.saveNote(payload);
    const snap = recordChange({
      entity: 'note', entityId: note.id, op: beforeNote ? 'update' : 'create',
      before: beforeNote, after: note, actor: payload.actor || 'user',
    });
    notifyWatch('save_note');
    return json(res, 200, { note, rollbackReady: !!snap.ok, snapshotId: snap.id ?? null });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/notes/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    // §24: نحفظ المحتوى قبل الحذف ليكون الحذف قابلاً للتراجع (بلا هذا لا استعادة).
    let beforeNote = null;
    try { beforeNote = (await core.readNotes()).find(n => n.id === id) || null; } catch { beforeNote = null; }
    const ok = await core.deleteNote(id);
    /* عقد موحّد (2026-11-11): الحذف لمعلومة غير موجودة كان 200 {ok:false} بينما
       GET لنفس الحالة 404 — الطريقة نفسها تتصرّف نفس التصرّف. */
    if (!ok) return json(res, 404, { ok: false, error: i18n.T('المعلومة غير موجودة', 'Not found'), code: 'not_found' });
    /* تنظيف سجلات المستند (2026-11-14): حذف ملاحظة كان يترك صفّها في
       document_entities/versions إلى الأبد — 13 «مستنداً» شبحياً في خزنة حقيقية
       تظهر في قائمة الاستيراد بلا وجود. الحذف يشمل أثر المستند كاملاً. */
    try {
      const ldb0 = layerDb();
      if (ldb0) {
        ldb0.prepare('DELETE FROM document_entities WHERE id = ?').run(id);
        ldb0.prepare('DELETE FROM document_versions WHERE doc_id = ?').run(id);
        ldb0.prepare('DELETE FROM note_links WHERE source = ? OR target = ?').run(id, id);
      }
    } catch { /* تنظيف تحسيني — لا يُسقط الحذف */ }
    recordChange({ entity: 'note', entityId: id, op: 'delete', before: beforeNote, after: null, actor: 'user' });
    notifyWatch('delete_note');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/note-history/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = decodeURIComponent(parts[2] || '');
    const file = parts[3] ? decodeURIComponent(parts[3]) : '';
    if (!file) return json(res, 200, { entries: await core.listHistory(id) });
    const content = await core.readHistoryEntry(id, file);
    return content === null ? json(res, 404, { error: i18n.T('اللقطة غير موجودة', "Snapshot not found") }) : json(res, 200, { id, file, content });
  }
  if (req.method === 'GET' && url.pathname === '/api/retrieval/status') return json(res, 200, await core.getRetrievalStatus());
  if (req.method === 'POST' && url.pathname === '/api/retrieval/rebuild') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await core.rebuildVectorIndex({ force: !!payload.force });
    return json(res, 200, { rebuilt: out.rebuilt, index: { builtAt: out.index.builtAt, entryCount: out.index.entryCount, noteCount: out.index.noteCount, provider: out.index.provider, model: out.index.model, rerankStrategy: out.index.rerankStrategy, dirty: out.index.dirty } });
  }
  if (req.method === 'GET' && (url.pathname === '/api/search' || url.pathname === '/api/semantic-search' || url.pathname === '/api/retrieval/search')) {
    const q = String(url.searchParams.get('q') || '').trim();
    const project = String(url.searchParams.get('project') || '').trim();
    const activeNoteId = String(url.searchParams.get('activeNoteId') || '').trim();
    const settings = await core.readSettings();
    const cfg = core.getRetrievalConfig(settings);
    const limit = Number(url.searchParams.get('limit')) || cfg.topK || 8;
    return json(res, 200, serializeSearchResults(await core.searchWithEmbeddings(q, { limit, project, activeNoteId })));
  }
  /* اسأل مكتبتك: بحث ← تقطيع ← جواب بمصادر مرقّمة (2026-11-15) */
  if (req.method === 'POST' && url.pathname === '/api/ask') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const question = String(payload.question || '').trim();
    if (question.length < 2) return json(res, 400, { error: i18n.T('اكتب سؤالاً أطول', 'Write a longer question') });
    const t0 = Date.now();
    const settings = await core.readSettings();
    let hits = [];
    try {
      const found = await core.searchWithEmbeddings(question, { limit: Number(payload.limit) || 6 });
      hits = (found && (found.results || found)) || [];
    } catch { hits = []; }
    const notes = await core.readNotes();
    const byId = new Map(notes.map((n) => [n.id, n]));
    const chunks = [];
    for (const h of hits.slice(0, 6)) {
      const n = byId.get(h && h.id);
      if (!n) continue;
      const text = pickChunk(n.body || n.content || '', question);
      if (text) chunks.push({ id: n.id, title: n.title || n.id, text });
    }
    const ms = () => Date.now() - t0;
    if (!chunks.length) {
      return json(res, 200, {
        ok: true,
        answer: i18n.T('لا أعرف — لا شيء في خزنتك يغطي هذا السؤال.', 'I don\'t know — nothing in your vault covers this.'),
        citations: [], noEvidence: true, ms: ms(),
      });
    }
    const context = chunks.map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`).join('\n\n');
    const system = [
      'أنت تجيب من خزنة المستخدم فقط — لا من معرفتك العامة.',
      'كل جملة factual تحمل رقم مصدرها بين قوسين مربعين مثل [1].',
      'إن لم تكفِ المقاطع للإجابة، ابدأ بـ«لا أعرف» واذكر ما ينقص. لا تخمّن.',
      'أجب بلغة السؤال، بإيجاز، بلا مقدمات.',
    ].join('\n');
    let answer = '';
    let error = null;
    try {
      const out = await callModel(settings, [{ role: 'user', content: `السؤال: ${question}\n\nالمقاطع:\n${context}` }], { system, mode: 'ask', dataClass: 'knowledge' });
      answer = String(out && out.text || '').trim();
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    const citations = chunks.map((c, i) => ({ n: i + 1, id: c.id, title: c.title }));
    const noEvidence = !answer || /^لا أعرف|^i don'?t know/i.test(answer) || !/\[\d+\]/.test(answer);
    await core.appendAudit({ type: 'ask_answered', question: question.slice(0, 120), chunks: chunks.length, noEvidence, error: error ? String(error).slice(0, 120) : null }).catch(() => {});
    return json(res, 200, { ok: !error, answer: answer || i18n.T('لا أعرف — تعذّر توليد جواب.', 'I don\'t know — could not generate an answer.'), citations, noEvidence, error, ms: ms() });
  }

  if (req.method === 'GET' && url.pathname === '/api/graph') return json(res, 200, await (async () => {
    const notes = await core.readNotes();
    const model = core.buildBrainModel(notes);
    const byId = new Map(model.notes.map(n => [n.id, n]));
    const nodes = notes.map(n => { const m = byId.get(n.id) || {}; return { id: n.id, label: n.title, degree: 0, tags: m.tags || [], importance: m.importance || 0, type: m.type || n.classification.primaryType, project: m.project || n.projectName || '', owner: ((n.structured?.tasks || []).map(t => t.owner).filter(Boolean)[0]) || null, shape: m.shape, color: m.color }; });
    const edges = [];
    /* عطل أداء مُقاس 2026-11-11: `notes.find` لكل حافة (52,168 × 361 ≈ 9.4M مقارنة
       نصية) و`edges.filter` لكل عقدة، مع أن `byId` مبنية أعلاه — الردّ 438ms
       ليُبقي 306 حافة فقط. مجموعة معرّفات + عدّاد درجات = خطّي. */
    const noteIds = new Set(notes.map(n => n.id));
    const degree = new Map();
    for (const edge of model.edges) {
      if (!noteIds.has(edge.target)) continue;
      edges.push({ source: edge.source, target: edge.target, type: edge.type, relation: !!edge.relation });
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
    for (const node of nodes) node.degree = degree.get(node.id) || 0;
    return { nodes, edges, version: watchState.version };
  })());
  /* خريطة «من يعتمد على من» — نظام FileMap المنقول حرفياً (مركز + عمودان + شريط أرقام).
     نفس شكل filegraph.json المرجعي: عقد بفئة ومشروع وعدد أسطر، حواف، إحصاءات
     (عناصر/مشاريع/دورات/يتيمة/ارتباطات + المحور الأكثر ارتباطاً + مجموعات الدورات الصغيرة). */
  /* ── الخزنة: المسار والإحصاء (2026-11-15) ────────────────────────────────
     كانت الخزنة ثابتة في <root>/vault. الآن يمكن فتح خزنة Obsidian قائمة:
     CORTEX_VAULT_DIR أو data/vault.json. التغيير يحتاج إعادة تشغيل لأن المسار
     يُقرأ عند إنشاء النواة — والواجهة تقول ذلك صراحةً بدل أن تتظاهر فوريّته. */
  if (url.pathname === '/api/vault') {
    if (req.method === 'GET') {
      const notes = await core.readNotes();
      const folders = new Set();
      let attachments = 0;
      let nested = 0;
      for (const n of notes) {
        const rel = String(n.relPath || '');
        if (rel.includes('/')) { nested += 1; folders.add(rel.slice(0, rel.lastIndexOf('/'))); }
        attachments += Array.isArray(n.attachments) ? n.attachments.length : 0;
      }
      const cfgFile = path.join(core.dataDir, 'vault.json');
      return json(res, 200, {
        ok: true,
        dir: core.vaultDir,
        exists: fs.existsSync(core.vaultDir),
        notes: notes.length,
        folders: folders.size,
        nested,
        attachments,
        source: process.env.CORTEX_VAULT_DIR ? 'env' : (fs.existsSync(cfgFile) ? 'config' : 'default'),
        restartRequired: false,
      });
    }
    if (req.method === 'POST') {
      if (!requireSession(req, res)) return;
      const payload = await body(req);
      const cfgFile = path.join(core.dataDir, 'vault.json');
      if (payload.reset === true) {
        try { fs.unlinkSync(cfgFile); } catch { /* لا ملف */ }
        await core.appendAudit({ type: 'vault_path_reset' }).catch(() => {});
        return json(res, 200, { ok: true, reset: true, restartRequired: true, dir: path.join(core.root, 'vault') });
      }
      const dir = String(payload.dir || '').trim();
      if (!dir) return json(res, 400, { error: i18n.T('المسار مطلوب', 'Path is required') });
      const abs = path.resolve(dir);
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; }
      if (!isDir) return json(res, 400, { error: i18n.T('المسار ليس مجلداً موجوداً', 'Path is not an existing folder'), dir: abs });
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, JSON.stringify({ dir: abs }, null, 2), 'utf8');
      await core.appendAudit({ type: 'vault_path_set', dir: abs }).catch(() => {});
      return json(res, 200, { ok: true, dir: abs, restartRequired: true });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/filemap') return json(res, 200, await (async () => {
    const notes = await core.readNotes();
    const model = core.buildBrainModel(notes);
    const kindOf = (n) => {
      const t = n.classification.primaryType;
      return (t === 'doc' || t === 'document') ? 'doc' : (['project', 'decision', 'task'].includes(t) ? t : 'note');
    };
    /* «المجلد» = من أين جاء العنصر فعلاً (قرار 2026-10-24):
       1) source بنمط folder/git:…::relPath ⇒ مجلد فرعي حقيقي من مسار الاستيراد
       2) source مسار مطلق (استيراد مفرد) ⇒ آخر مقطعين من مجلد الأصل
       3) وإلا المشروع — فالطيّ بالعمودين يجمع ما جمعه الاستيراد معاً. */
    const folderOf = (n) => {
      const src = String(n.fm?.source || '');
      let raw = '';
      const marker = src.indexOf('::');
      if (marker !== -1) {
        const rel = src.slice(marker + 2);
        const parts = rel.split(/[\\/]/).filter(Boolean);
        parts.pop();
        raw = parts.join('/');
      } else {
        const mAbs = src.match(/^[a-zA-Z]:[\\/](.+)$/);
        if (mAbs) {
          const parts = mAbs[1].split(/[\\/]/).filter(Boolean);
          parts.pop();
          raw = parts.slice(-2).join('/');
        }
      }
      if (!raw) return n.projectName || '';
      // توحيد المصادر النسبية والمطلقة لنفس المسار (relPath وabs يشتركان في الذيل)
      return raw.replace(/\\/g, '/').replace(/\/+$/, '');
    };
    const nodes = notes.map(n => {
      const f = folderOf(n);
      return {
        id: n.id, name: n.title,
        ext: kindOf(n),
        kind: kindOf(n),
        /* '' للعناصر بلا مجلد/مشروع — التسمية «(بلا مشروع)» مسؤولية الواجهة
           المترجمة (عطل مُقاس: كان النص العربي يُرسل من الخادم فيبقى في وضع EN). */
        folder: f || '',
        loc: String(n.body || '').split('\n').length,
      };
    });
    const ids = new Set(nodes.map(n => n.id));
    const edges = [];
    const seen = new Set();
    for (const edge of model.edges) {
      const from = edge.source, to = edge.target;
      if (!ids.has(from) || !ids.has(to) || from === to) continue;
      const key = from + '→' + to;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
    // الإحصاءات بالكود الحتمي — لا تخمين (م35): درجات، يتيمة، محور، دورات صغيرة
    const outMap = new Map(nodes.map(n => [n.id, []]));
    const inMap = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) { outMap.get(e.from).push(e.to); inMap.get(e.to).push(e.from); }
    const orphans = nodes.filter(n => !(outMap.get(n.id).length) && !(inMap.get(n.id).length)).length;
    let hub = null; let hubDeg = -1;
    for (const n of nodes) {
      const d = outMap.get(n.id).length + inMap.get(n.id).length;
      if (d > hubDeg) { hubDeg = d; hub = n.id; }
    }
    // دورات صغيرة (≤6 عقد) بالكشف عبر DFS — تُسمّى في حاشية الخريطة فقط
    const cycleGroups = [];
    const seenCycles = new Set();
    const state = new Map(); // 1 في الرصة، 2 منتهٍ
    const stack = [];
    (function dfs(u) {
      state.set(u, 1); stack.push(u);
      for (const v of (outMap.get(u) || [])) {
        if (!state.get(v)) dfs(v);
        else if (state.get(v) === 1) {
          const i = stack.indexOf(v);
          if (i !== -1 && stack.length - i <= 6) {
            const cyc = stack.slice(i);
            const key = [...cyc].sort().join('|');
            if (!seenCycles.has(key)) { seenCycles.add(key); cycleGroups.push(cyc); }
          }
        }
      }
      stack.pop(); state.set(u, 2);
    })(nodes.length ? nodes[0].id : '');
    for (const n of nodes) if (!state.get(n.id)) (function dfs2(u) {
      state.set(u, 1); stack.push(u);
      for (const v of (outMap.get(u) || [])) {
        if (!state.get(v)) dfs2(v);
        else if (state.get(v) === 1) {
          const i = stack.indexOf(v);
          if (i !== -1 && stack.length - i <= 6) {
            const cyc = stack.slice(i);
            const key = [...cyc].sort().join('|');
            if (!seenCycles.has(key)) { seenCycles.add(key); cycleGroups.push(cyc); }
          }
        }
      }
      stack.pop(); state.set(u, 2);
    })(n.id);
    const folders = new Set(nodes.map(n => n.folder));
    return {
      nodes, edges,
      stats: {
        files: nodes.length, folders: folders.size, cycles: cycleGroups.length,
        orphans, edges: edges.length, hub, cycleGroups: cycleGroups.slice(0, 4),
      },
      generatedAt: new Date().toISOString(),
      root: 'cortex-vault',
    };
  })());
  if (req.method === 'GET' && url.pathname === '/api/links') return json(res, 200, { links: await core.readRelations() });  if (req.method === 'POST' && url.pathname === '/api/links') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    try { return json(res, 200, await core.addRelation(String(payload.source || ''), String(payload.target || ''), String(payload.type || 'references'))); }
    catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (req.method === 'DELETE' && url.pathname === '/api/links') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    try { return json(res, 200, await core.removeRelation(String(payload.source || ''), String(payload.target || ''), String(payload.type || 'references'))); }
    catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/backlinks/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const notes = await core.readNotes();
    return json(res, 200, { backlinks: notes.filter(n => n.links.some(l => core.resolveLinkTarget(l, notes) === id)).map(n => ({ id: n.id, title: n.title })) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/review/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const review = await core.buildReview(id);
    return review ? json(res, 200, review) : json(res, 404, { error: i18n.T('ملاحظة غير موجودة', "Note not found") });
  }
  if (req.method === 'GET' && url.pathname === '/api/workspace-review') return json(res, 200, await core.reviewWorkspace());
  if (req.method === 'GET' && url.pathname === '/api/project-state') {
    const project = String(url.searchParams.get('project') || '').trim();
    if (project) await core.recordActivity({ project });
    return json(res, 200, await core.synthesizeProjectState(project, i18n.lang()));
  }
  if (req.method === 'POST' && url.pathname === '/api/project-state/living-note') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const result = await core.updateLivingNote(payload.project || 'workspace');
    notifyWatch('living_note_updated');
    return json(res, 200, result);
  }
  /* قائمة النسخ واستعادتها (2026-11-15): كانت النسخة تُنشأ ولا تُرى ولا تُستعاد
     من الواجهة — أي «نسخة بلا استعادة» = طمأنينة بلا قدرة. */
  if (req.method === 'GET' && url.pathname === '/api/backups') {
    const items = await core.listBackups();
    return json(res, 200, { ok: true, count: items.length, items, dir: core.backupsDir });
  }
  if (req.method === 'POST' && url.pathname === '/api/backups/restore') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await core.restoreBackup(String(payload.name || ''));
    return json(res, out.ok ? 200 : 400, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/backup') return json(res, 200, await core.createBackup());
  if (req.method === 'GET' && url.pathname === '/api/settings') {
      // §15: القراءة لا تكتب على القرص — لا تشترط رمز جلسة (§34 يخص الكتابة فقط).
      // المفتاح مقنّع دائماً هنا (mask)، فالقراءة الحرة لا تكشف سراً.
    // §15: لا يُعاد أي مفتاح كامل عبر الـAPI — يُقنّع دائماً (ثغرة مؤكدة: كان يُرجع sk_... كاملاً)
    const settings = await core.readSettings();
    const safe = JSON.parse(JSON.stringify(settings || {}));
    const mask = (v) => {
      const s = String(v || '');
      if (!s) return '';
      if (s.length <= 8) return '***';
      return s.slice(0, 6) + '…' + s.slice(-4);
    };
    if (safe.ai && safe.ai.apiKey) {
      safe.ai.apiKeyMasked = mask(safe.ai.apiKey);
      safe.ai.hasApiKey = true;
      delete safe.ai.apiKey;
    }
    if (Array.isArray(safe.providers)) {
      safe.providers = safe.providers.map((p) => {
        const c = { ...p };
        if (c.apiKey) { c.apiKeyMasked = mask(c.apiKey); c.hasApiKey = true; delete c.apiKey; }
        return c;
      });
    }
    return json(res, 200, safe);
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (!requireSession(req, res)) return;
    const incoming = await body(req);
    const current = await core.readSettings();
    // ═══ حماية المفاتيح: واجهة ترسل إعدادات مقنّعة/بلا مفتاح لا يجوز أن تمحو المفتاح الحقيقي ═══
    if (incoming && incoming.ai && current && current.ai) {
      const sent = incoming.ai.apiKey;
      const looksMasked = typeof sent === 'string' && (sent === '' || sent.includes('…') || sent.length <= 8);
      if (looksMasked || sent === undefined) {
        delete incoming.ai.apiKey;
        incoming.ai.apiKey = current.ai.apiKey;
      }
      delete incoming.ai.apiKeyMasked;
      delete incoming.ai.hasApiKey;
    }
    if (incoming && incoming.providers === undefined && Array.isArray(current.providers)) {
      /* فقدان بيانات مُقاس 2026-11-05: POST /api/settings بحمولة جزئية (شاشة
         الإعدادات ترسل ai/memory/agent فقط) كان يُسقط مصفوفة المزودين كلها،
         لأن الدمج مع الافتراضي يستبدل المصفوفات. الحفظ الجزئي لا يملك المزودين
         فلا يجوز أن يمحوهم. */
      incoming.providers = current.providers;
    }
    /* نفس الحماية للغة الواجهة: حفظ جزئي من شاشة الإعدادات (لا يرسل ui) كان
       يُعيدها إلى الافتراضي فيمحو اختيار المستخدم — فيرجع الخادم يكتب المحتوى
       بلغة أخرى (عطل مُقاس 2026-11-09). */
    if (incoming && incoming.ui === undefined && current && current.ui) {
      incoming.ui = current.ui;
    }
    if (incoming && Array.isArray(incoming.providers) && Array.isArray(current.providers)) {
      incoming.providers = incoming.providers.map((p) => {
        const prev = current.providers.find((x) => x && p && x.name === p.name);
        const sent = p && p.apiKey;
        const looksMasked = typeof sent === 'string' && (sent === '' || sent.includes('…') || sent.length <= 8);
        const next = { ...p };
        if ((looksMasked || sent === undefined) && prev && prev.apiKey) next.apiKey = prev.apiKey;
        delete next.apiKeyMasked;
        delete next.hasApiKey;
        return next;
      });
    }
    /* الدمج على الحالي (لا على الافتراضي): حفظ جزئي لا يمحو ما لم يُرسَل.
       بدونه كان POST يحمل ai.temperature فقط يمحو المزوّد والنموذج والعنوان. */
    const saved = await core.saveSettings(deepMergeSettings(current, incoming));
    armScheduler();
    /* تدفئة الكاش: قراءة الخزنة مرة في الخلفية حتى لا يدفع أول طلب ثمن تحليل كل الملفات */
    setImmediate(() => { core.readNotes().catch(() => {}); });
    // لا نُعيد المفاتيح أبداً — حتى في رد الحفظ
    const safeSaved = JSON.parse(JSON.stringify(saved || {}));
    const mask = (v) => { const s = String(v || ''); return s ? (s.length <= 8 ? '***' : s.slice(0, 6) + '…' + s.slice(-4)) : ''; };
    if (safeSaved.ai && safeSaved.ai.apiKey) { safeSaved.ai.apiKeyMasked = mask(safeSaved.ai.apiKey); safeSaved.ai.hasApiKey = true; delete safeSaved.ai.apiKey; }
    if (Array.isArray(safeSaved.providers)) safeSaved.providers = safeSaved.providers.map((pp) => {
      const c = { ...pp };
      if (c.apiKey) { c.apiKeyMasked = mask(c.apiKey); c.hasApiKey = true; delete c.apiKey; }
      return c;
    });
    return json(res, 200, safeSaved);
  }
  if (req.method === 'GET' && url.pathname === '/api/ai/models') {
    try { return json(res, 200, await fetchModels(await core.readSettings())); }
    catch (err) { return json(res, 200, { models: [], error: err.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/session/start') return json(res, 200, { session: await core.createSession(await body(req)) });
  if (req.method === 'GET' && url.pathname === '/api/agent/sessions') return json(res, 200, { sessions: await core.listSessions(25) });
  if (req.method === 'GET' && url.pathname.startsWith('/api/agent/session/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const session = await core.readSession(id);
    return session ? json(res, 200, { session }) : json(res, 404, { error: i18n.T('الجلسة غير موجودة', "Session not found") });
  }
  if (req.method === 'POST' && url.pathname.match(/^\/api\/agent\/session\/[^/]+\/message$/)) {
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    return json(res, 200, { session: await core.appendSessionMessage(id, await body(req)) });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/next-action') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const settings0 = await core.readSettings();
    return json(res, 200, await core.nextBestAction({ ...payload, lang: payload.lang || i18n.lang() }));
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/review-context') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const packet = await core.buildContextPacket(payload.query || '', { project: payload.project || '', activeNoteId: payload.noteId || '' });
    return json(res, 200, { resolved: packet.resolved, context: packet.search.results.map(r => ({ id: r.id, title: r.title, type: r.type, score: r.score, project: r.project })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const settings = await core.readSettings();
    const query = payload.messages?.at(-1)?.content || '';
    const packet = await core.buildContextPacket(query, { project: payload.project || '', activeNoteId: payload.noteId || '' });
    const contextNotes = packet.contextNotes;
    const project = payload.project || packet.resolved.resolved?.project || '';
    const lang = payload.lang || i18n.lang();
    /* البنود الثلاثة مستقلة بعد بناء السياق — تنفيذها تتابعياً كان يضيف ثانية كاملة
       إلى كل سؤال بلا سبب. (قياس 2026-11-05: ~1s من أصل ~4s). */
    const [review, projectState, nextAction] = await Promise.all([
      payload.noteId ? core.buildReview(payload.noteId).catch(() => null) : Promise.resolve(null),
      core.synthesizeProjectState(project, lang).catch(() => null),
      core.nextBestAction({ project, noteId: payload.noteId, question: query, lang }).catch(() => null),
    ]);
    core.recordActivity({ noteId: payload.noteId || packet.resolved.resolved?.id || '', project }).catch(() => {});

    // بثّ تدريجي اختياري: ?stream أو {stream:true} — يُظهر النص لحظة توليده
    const stream = payload.stream === true || url.searchParams.get('stream') === '1';
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* العميل أغلق */ } };
      send({ type: 'start', resolved: packet.resolved });
      try {
        const answer = await callModel(settings, payload.messages || [], { mode: payload.mode, review, projectState, nextAction, resolved: packet.resolved, contextNotes, stream: true, onDelta: (d) => send({ type: 'delta', d }) });
        if (payload.sessionId) {
          await core.appendSessionMessage(payload.sessionId, { role: 'user', content: query }).catch(() => {});
          await core.appendSessionMessage(payload.sessionId, { role: 'assistant', content: answer.text }).catch(() => {});
        }
        send({ type: 'done', answer: answer.text, nextAction, review, projectState, retrieval: packet.search.indexStatus });
      } catch (err) {
        send({ type: 'error', error: String(err.message || err) });
      }
      try { res.end(); } catch { /* انتهى */ }
      return;
    }
    try {
      const answer = await callModel(settings, payload.messages || [], { mode: payload.mode, review, projectState, nextAction, resolved: packet.resolved, contextNotes });
      if (payload.sessionId) {
        await core.appendSessionMessage(payload.sessionId, { role: 'user', content: query });
        await core.appendSessionMessage(payload.sessionId, { role: 'assistant', content: answer.text });
      }
      return json(res, 200, {
        answer: answer.text,
        resolved: packet.resolved,
        context: contextNotes.map(n => ({ id: n.id, title: n.title, type: n.classification.primaryType, project: n.projectName || '' })),
        nextAction,
        review,
        projectState,
        retrieval: packet.search.indexStatus
      });
    } catch (err) {
      return json(res, 200, { answer: `⚠️ خطأ: ${err.message}`, resolved: packet.resolved, context: [], nextAction, review, projectState, retrieval: packet.search.indexStatus });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/suggest-links') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const notes = await core.readNotes();
    return json(res, 200, { suggestions: core.relatedNotes(notes, payload.noteId, 8) });
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/extract-actions') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    return json(res, 200, { actions: core.extractStructuredInfo(payload.content || '').tasks.map(t => t.text) });
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const project = String(url.searchParams.get('project') || '').trim();
    const status = String(url.searchParams.get('status') || '').trim();
    const owner = String(url.searchParams.get('owner') || '').trim();
    return json(res, 200, { tasks: core.listTasks({ project, status, owner }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/health/history') {
    const project = String(url.searchParams.get('project') || '').trim();
    const limit = Number(url.searchParams.get('limit')) || 100;
    return json(res, 200, { history: core.healthHistory({ project, limit }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/summarize') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const notes = await core.readNotes();
    const note = notes.find(n => n.id === core.slugify(String(payload.noteId || '')));
    if (!note) return json(res, 404, { error: i18n.T('الملاحظة غير موجودة', "Note not found") });
    const settings = await core.readSettings();
    const packet = await core.buildContextPacket(note.title, { activeNoteId: note.id, project: note.projectName || '' });
    const sources = [{ id: note.id, title: note.title, updatedAt: note.updatedAt }, ...packet.contextNotes.filter(n => n.id !== note.id).slice(0, 4).map(n => ({ id: n.id, title: n.title, updatedAt: n.updatedAt }))];
    const system = [
      'أنت Cortex، محرر معرفة تنفيذي داخل نظام معرفة هندسي محلي.',
      'المطلوب: تلخيص المستند ثم تقييم اكتماله بصرامة كمراجع هندسي: ما الأقسام والحالات المتوقعة في هذا النوع من المستندات وغير المذكورة فيه.',
      'الملخص يعتمد على النص فقط. النواقص توقعات معلَّلة بحسب النوع لا وقائع.',
      'اكتب بالعربية وأعد JSON فقط بالشكل: {"summary":"...","missing":["..."],"risks":["..."],"next":"..."} دون أي نص خارج JSON.'
    ].join('\n');
    const user = [
      `المستند: ${note.title} — النوع: ${note.documentType || note.classification.primaryType} — المشروع: ${note.projectName || 'بدون'}`,
      `--- محتوى المستند ---\n${note.body.slice(0, 6000)}`,
      packet.contextNotes.length ? `--- سياق من المشروع (للفهم لا للتلخيص) ---\n${packet.contextNotes.map(n => `## ${n.title}\n${n.body.slice(0, 1000)}`).join('\n----\n')}` : '--- لا سياق إضافي ---'
    ].join('\n\n');
    try {
      const answer = await callModel(settings, [{ role: 'user', content: user }], { system, mode: 'builder' });
      const parsed = parseJsonLoose(answer.text) || {};
      const gaps = core.findGaps(notes, note.projectName || '').map(g => g.message);
      return json(res, 200, {
        summary: parsed.summary || cut(note.body, 500),
        missing: Array.isArray(parsed.missing) && parsed.missing.length ? parsed.missing.map(String) : gaps,
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : note.structured.risks.map(r => r.text),
        next: typeof parsed.next === 'string' ? parsed.next : null,
        provider: settings.ai.provider,
        sources
      });
    } catch (e) {
      return json(res, 200, { error: e.message, provider: settings.ai.provider, sources });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/meeting-actions') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const notes = await core.readNotes();
    const note = notes.find(n => n.id === core.slugify(String(payload.noteId || '')));
    if (!note) return json(res, 404, { error: i18n.T('الملاحظة غير موجودة', "Note not found") });
    const settings = await core.readSettings();
    const sources = [{ id: note.id, title: note.title, updatedAt: note.updatedAt }];
    const system = [
      'أنت Cortex، محوّل ملاحظات الاجتماعات إلى عناصر تنفيذية.',
      'استخرج كل مهمة أو التزامًا يحتاج متابعة، وحدد صاحبه إن ذُكر، وموعدًا إن ذُكر (بصيغة YYYY-MM-DD إن أمكن).',
      'لا تخترع أصحابًا أو مواعيد غير مذكورة؛ اتركها null. اكتب بالعربية.',
      'أعد JSON فقط: {"actions":[{"text":"...","owner":null,"due":null}]}'
    ].join('\n');
    const user = `--- ملاحظات الاجتماع: ${note.title} ---\n${note.body.slice(0, 6000)}`;
    try {
      const answer = await callModel(settings, [{ role: 'user', content: user }], { system, mode: 'builder' });
      const parsed = parseJsonLoose(answer.text) || {};
      const actions = Array.isArray(parsed.actions) && parsed.actions.length
        ? parsed.actions.map(a => ({ text: String(a.text || '').slice(0, 300), owner: a.owner || null, due: a.due || null }))
        : note.structured.tasks.map(t => ({ text: t.text, owner: t.owner || null, due: t.due || null }));
      return json(res, 200, { actions, meeting: { id: note.id, title: note.title, type: note.classification.primaryType }, provider: settings.ai.provider, sources });
    } catch (e) {
      return json(res, 200, { error: e.message, actions: [], provider: settings.ai.provider, sources });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/apply-actions') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const notes = await core.readNotes();
    const note = notes.find(n => n.id === core.slugify(String(payload.noteId || '')));
    if (!note) return json(res, 404, { error: i18n.T('الملاحظة غير موجودة', "Note not found") });
    const actions = Array.isArray(payload.actions) ? payload.actions.filter(a => a && String(a.text || '').trim()).slice(0, 30) : [];
    if (!actions.length) return json(res, 400, { error: i18n.T('لا توجد عناصر صالحة للتطبيق', "No valid items to apply") });
    // منع التكرار: ما استُخرج سابقًا وحوِّل لا يُضاف مرة أخرى
    const existing = new Set((note.structured?.tasks || []).map(t => String(t.text).trim().toLowerCase()).filter(Boolean));
    const fresh = actions.filter(a => !existing.has(String(a.text).trim().toLowerCase()));
    if (!fresh.length) return json(res, 200, { added: 0, message: i18n.T('العناصر موجودة في المستند بالفعل', "The items already exist in the document"), note: { id: note.id, title: note.title } });
    const lines = fresh.map(a => {
      const owner = a.owner ? ` @${String(a.owner).replace(/\s+/g, '-')}` : '';
      const due = a.due ? ` (due: ${String(a.due).slice(0, 32)})` : '';
      return `- [ ] ${String(a.text).trim()}${owner}${due}`;
    });
    const content = `${note.body.replace(/\s+$/, '')}\n\n## عناصر تنفيذية\n${lines.join('\n')}\n`;
    const saved = await core.saveNote({ id: note.id, title: note.title, content, project: note.projectName || '', type: note.classification.primaryType });
    return json(res, 200, { note: { id: saved.id, title: saved.title }, added: fresh.length });
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/contradictions') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const notes = await core.readNotes();
    const note = notes.find(n => n.id === core.slugify(String(payload.noteId || '')));
    if (!note) return json(res, 404, { error: i18n.T('الملاحظة غير موجودة', "Note not found") });
    const settings = await core.readSettings();
    const related = core.relatedNotes(notes, note.id, 6).map(r => notes.find(n => n.id === r.id)).filter(Boolean);
    const sources = [{ id: note.id, title: note.title, updatedAt: note.updatedAt }, ...related.map(n => ({ id: n.id, title: n.title, updatedAt: n.updatedAt }))];
    const heuristic = core.detectContradictions(note, notes).map(c => ({ topic: 'تعارض لفظي', a: c.evidence[0], b: c.evidence[1], sources: [note.title, c.againstTitle], severity: 'medium' }));
    if (!related.length) return json(res, 200, { contradictions: heuristic, fallback: true, provider: settings.ai.provider, sources });
    const system = [
      'أنت مدقق تناقضات هندسي داخل Cortex.',
      'قارن المستند الأساسي بالمستندات ذات الصلة، واكشف فقط التعارضات ذات الأثر الهندسي: قرار يلغي قرارًا، حد أو رقم يختلف، نطاق متنافر، مصطلح مُعرَّف بشكلين مختلفين.',
      'لا تذكر اختلافات صياغة بلا أثر. اكتب بالعربية.',
      'أعد JSON فقط: {"contradictions":[{"topic":"","a":"","b":"","sources":["عنوان ملف"],"severity":"high|medium|low"}]}'
    ].join('\n');
    const user = [
      `المستند الأساسي: ${note.title}\n${note.body.slice(0, 4000)}`,
      '--- المستندات ذات الصلة ---',
      related.map(n => `## ${n.title} (${n.updatedAt.slice(0, 10)})\n${n.body.slice(0, 1500)}`).join('\n----\n')
    ].join('\n\n');
    try {
      const answer = await callModel(settings, [{ role: 'user', content: user }], { system, mode: 'critic' });
      const parsed = parseJsonLoose(answer.text);
      const contradictions = parsed && Array.isArray(parsed.contradictions) && parsed.contradictions.length
        ? parsed.contradictions.slice(0, 10)
        : heuristic;
      return json(res, 200, { contradictions, fallback: !(parsed && Array.isArray(parsed.contradictions) && parsed.contradictions.length), provider: settings.ai.provider, sources });
    } catch (e) {
      return json(res, 200, { error: e.message, contradictions: heuristic, fallback: true, provider: settings.ai.provider, sources });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/proactive') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await agent.proactive({ project: String(payload.project || '').trim(), noteId: String(payload.noteId || '').trim(), lang: i18n.lang() });
    return json(res, 200, out);
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/run') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const goal = String(payload.goal || '').trim();
    if (!goal) return json(res, 400, { error: apiMsg(payload, 'أعط الوكيل هدفًا', 'Give the agent a goal') });
    const lang = payload.lang === 'en' ? 'en' : 'ar';
    const project = String(payload.project || '').trim();
    const noteId = String(payload.noteId || '').trim();
    /* W1 ص-6: ربط تلقائي بخيط جلسة — لا تشغيل بلا جلسة (تُنشأ عند الغياب) */
    let sid = String(payload.sessionId || '').trim();
    if (!sid) {
      try { const s = await core.createSession({ goal: goal.slice(0, 120), mode: 'project', project, source: 'chat' }); sid = s.id; } catch { /* التشغيل يكمل بلا جلسة */ }
    }
    /* W1: التشغيل كائن أوّل-درجة — معرّف دائم + سجل أحداث + إلغاء تعاوني حقيقي */
    const rs = runsStore();
    const runId = rs.begin({ goal, project, noteId, sessionId: sid, trigger: 'chat', lang });
    const hooks = {
      onEvent: (ev) => { try { rs.event(runId, ev && ev.type, (ev && ev.payload) || null); } catch { /* السجل لا يُسقط التشغيل */ } },
      shouldCancel: () => rs.isCancelled(runId)
    };
    const emit = step => { try { res.write(`data: ${JSON.stringify({ type: 'agent_step', step })}\n\n`); } catch {} };
    try {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'run_started', runId, sessionId: sid })}\n\n`);
      // §33: الوضع من إعداد النظام لا من الحمولة (payload.autonomy مُهمَل عمداً)
      const out = await agent.run(
        { goal, project, noteId, lang, language: payload.language, autonomy: String((await core.readSettings())?.agent?.autonomy || 'supervised') },
        emit,
        { hooks, sysTools: sysToolsFor(runId), mcpTools: await mcpAgentTools() }
      );
      // المسودات المعلقة تُحفظ للاعتماد من الواجهة — قبل إعلان الانتهاء حتى لا يقرأها العميل مبكرًا
      if (out.pending?.length) await fsp.writeFile(path.join(core.dataDir, 'agent-pending.json'), JSON.stringify({ at: new Date().toISOString(), mutations: out.pending }, null, 2), 'utf8').catch(() => {});
      const answerText = String(out.answer || '');
      /* W3: المخرَج أوّل-درجة — الجواب الطويل يصير تقريراً في المعرفة، والشات يعرض بطاقة */
      let artifact = null;
      if (!out.error && !out.cancelled && answerText.length > 600 && goal) {
        try {
          /* إصلاح 2026-11-12 (تكرار مقيس): كان المعرّف report-<runId> فريداً لكل
             تشغيل، فهدف واحد يُنتج نسخة لكل تشغيل — قياس حيّ: 3 نسخ لنفس العنوان.
             القاعدة الآن: عنوان واحد + مشروع واحد ⇒ تقرير واحد يُحدَّث (واللقطات
             السابقة محفوظة في data/history). لا تكرار في المعرفة. */
          const reportTitle = (lang === 'en' ? 'Report: ' : 'تقرير: ') + String(goal).slice(0, 60);
          const existing = (await core.readNotes()).find(n =>
            n.title === reportTitle && String(n.projectName || '') === String(project || '')
          );
          const nid = existing ? existing.id : ('report-' + runId.replace(/^run-/, ''));
          await core.saveNote({
            id: nid,
            title: reportTitle,
            type: 'note', project, importance: 2, content: answerText
          });
          artifact = { noteId: nid, chars: answerText.length, updated: Boolean(existing) };
        } catch { /* المخرَج تحسيني — الجواب يبقى في الشات */ }
      }
      /* عطل مُقاس 2026-10-24: `/api/agent/run` كان **يتجاهل sessionId تماماً** —
         فالجلسات الـ25 كلها صفر رسائل رغم أن الواجهة تنشئها. الآن: الهدف والجواب
         يُسجَّلان في الجلسة المرسلة (نفس عقد /api/ai/chat)، والفشل لا يُسقط التشغيل. */
      if (sid) {
        try {
          if (!out.error) {
            await core.appendSessionMessage(sid, { role: 'user', content: goal });
            await core.appendSessionMessage(sid, { role: 'assistant', content: answerText.slice(0, 4000) });
          }
        } catch { /* الجلسة لا تُسقط التشغيل */ }
      }
      // الختام الدائم: نجاح/إلغاء/فشل — لا تشغيل بلا نهاية موثقة
      if (out.error) rs.finish(runId, 'run_failed', { error: String(out.error).slice(0, 400) });
      else if (out.cancelled) rs.finish(runId, 'run_cancelled', { reason: 'user_request' });
      else rs.finish(runId, 'run_finished', { ok: true, verified: out.verified ?? null, stepsUsed: out.stepsUsed || 0, answer: answerText.slice(0, 4000), artifact });
      // مسير المشروع: خطوة النموذج تُسجَّل تلقائياً إن كان للتشغيل مشروع (الهدف الثاني)
      if (project) {
        try {
          projectMemory.appendTrail({
            project, source: 'cortex-agent',
            entries: [{
              kind: 'run', status: out.error ? 'failed' : out.cancelled ? 'cancelled' : (out.verified ? 'verified' : 'done'),
              text: `${goal}${answerText ? ` — ${answerText.slice(0, 240)}` : ''}`, files: []
            }]
          });
        } catch { /* المسير تحسيني — لا يُسقط التشغيل */ }
      }
      res.write(`data: ${JSON.stringify({ type: 'agent_done', result: { ...out, runId, sessionId: sid, artifact } })}\n\n`);
      res.end();
    } catch (e) {
      try { rs.finish(runId, 'run_failed', { error: String(e && e.message || e).slice(0, 400) }); } catch { /* سباق إغلاق */ }
      try { res.write(`data: ${JSON.stringify({ type: 'agent_done', result: { error: e.message, mutations: [], sources: [], runId, sessionId: sid } })}\n\n`); res.end(); } catch {}
    }
    return;
  }
  // §36: استئناف تشغيل عالق — يُعيد مهامه المعلّقة إلى المسار
  if (req.method === 'POST' && url.pathname === '/api/agent/resume') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const runId = String(payload.runId || payload.run_id || '').trim();
    const odb = openLayerDb();
    const ostore = orc.createStore(odb);
    if (!ostore || typeof ostore.requeuePending !== 'function') {
      return json(res, 503, { error: apiMsg(payload, 'لا مسار استعادة متاح (requeuePending مفقود)', 'No resume path available (requeuePending missing)') });
    }
    /* §24 (عطل مُقاس 2026-10-24): المسار القديم كان يقلب الحالة فقط — المهام تعود
       queued ولا تُنفَّذ أبداً (32 مهمة عالقة 6 أيام شاهدة). الآن:
       - runId محدد ⇒ استئناف **تنفيذي** فعلي عبر Orchestrator.resume
         (إعادة طابور + جدولة + تنفيذ + تحقق النتائج).
       - بلا runId ⇒ استعادة حالة شاملة فقط (إعادة طابور كل العالق) — التنفيذ
         قرار صريح لكل تشغيل، لا تفجير جماعي من نداء واحد. */
    if (runId) {
      try {
        const resumeAgent = async (taskGoal, subCtx) => agent.run(
          { goal: taskGoal,
            // §33: الوضع من إعداد النظام لا من الحمولة
            autonomy: String((await core.readSettings())?.agent?.autonomy || 'supervised') },
          (subCtx && typeof subCtx.emit === 'function') ? subCtx.emit : null,
          subCtx || {}
        );
        const orchestrator = new orc.Orchestrator({ store: ostore, runAgent: resumeAgent, maxParallel: clampParallel(payload.maxParallel) });
        const out = await orchestrator.resume(runId);
        await core.appendAudit({ type: 'agent_resume_executed', runId, tasks: out.summary?.total ?? null, done: out.summary?.done ?? null, verified: !!out.verified }).catch(() => {});
        return json(res, 200, { ok: true, runId: out.runId, tasks: out.tasks, verified: !!out.verified, summary: out.summary });
      } catch (e) {
        return json(res, 500, { ok: false, runId, error: e.message });
      }
    }
    const stuck = ostore.pendingRuns();
    const results = [];
    for (const r of stuck) {
      try { results.push({ runId: r.run_id, ...ostore.requeuePending(r.run_id) }); }
      catch (e) { results.push({ runId: r.run_id, error: e.message }); }
    }
    await core.appendAudit({ type: 'agent_resume_all', runs: results.length }).catch(() => {});
    return json(res, 200, { ok: true, resumed: results, count: results.length });
  }

  // اعتماد مسودات الوكيل — تنفيذ موسوم تحت نفس الحاكم (إيقاف/ميزانية/نطاق)
  if (req.method === 'POST' && url.pathname === '/api/agent/execute') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    if (core.agentPaused()) return json(res, 423, { error: apiMsg(payload, 'الوكيل موقوف', 'The agent is paused') });
    const settingsX = await core.readSettings();
    /* §33: الوضع والنطاقات من *إعداد النظام* — لا من حمولة الطلب.
       العطل المُثبت حياً 2026-10-20: `payload.autonomy` و`payload.allowedScopes`
       كانا يمرّان مباشرةً، فرفع مهاجمٌ نفسه إلى «مستقل» ومنح نفسه sandbox.
       الآن تُتجاهل الحمولة في هذين الحقلين تماماً (وcortex-agent يُبلّغ عن المحاولة). */
    const out = await agent.execute(payload.mutations || [], {
      project: String(payload.project || '').trim(),
      // §33: النطاقات قائمة معلنة صلبة — لا تُقرأ من الحمولة ولا تُوسّع.
      // 'sandbox' مشمولة: أدوات الاختبار (run_tests) نطاقها sandbox وتصبح مسودة
      // دائمة (alwaysDraft) — وبلا النطاق هنا كان اعتمادها يُرفض «scope not granted»
      // فيتعذر مسار الاعتماد كله على الاختبارات (عطل مُقاس 2026-10-27).
      allowedScopes: ['vault', 'filesystem', 'repo', 'sandbox', 'mcp'],
      /* §33+§35: `meta.autonomy` كان يُحمّل بوضع *النظام*، فيقارن cortex-agent
         «الطلب» بـ«الطلب» ولا يرى محاولة التصعيد إطلاقاً (وإن كان لا ينفّذها).
         العقد الصحيح: نحمل هنا **ما طلبه المُستدعي** ليُكشف الرفض ويُدقّق،
         والوضع الفعلي يقرأه الوكيل من إعداد النظام بنفسه. */
      requestedAutonomy: payload.autonomy === undefined ? undefined : String(payload.autonomy),
      // W4: أدوات الإدارة الذاتية (جدولة/إلغاء/ميزانية) في التنفيذ المعتمد —
      // «سياسة alwaysDraft» وصولها هنا هو بوابة الاعتماد البشرية نفسها
      sysTools: sysToolsFor('approve'),
      lang: String(payload.lang || resolveAgentLang(settingsX, payload.lang)),
      // §24: تنفيذ معتمد بلا لقطة = كتابة لا تُتراجعَ — كان هذا العطل: agent.execute
      // يكتب الملاحظات عبر core.saveNote بلا تسجيل تغيير، فتبقى «التغييرات» صفراً.
      recordChange,
    });
    /* عطل مُقاس 2026-11-15: كان السطر التالي يحذف الملف **كاملاً**، فاعتماد مسودة
       واحدة يمحو كل المسودات غير المعتمدة (قياس: مسودتان ⇒ اعتماد الأولى ⇒ المتبقي 0).
       القاعدة الآن: يُزال **المعتمد بالهوية فقط** (أداة + وسائط مطابقة)؛ وما لم
       يُعتمد يبقى في الطابور. الاعتماد نفسه idempotent: إعادة اعتماد مسودة أُزيلت
       لا تُحذف شيئاً ولا تفشل. */
    await dropApprovedFromPending(payload.mutations || []);
    return json(res, 200, out);
  }
/* إزالة المسودات المعتمدة بالهوية (أداة + وسائط) من الطابور المعلّق.
   الملف يحمل **ما لم يُبتّ فيه**، فإزالة غير المعتمد خرق مباشر لعقد الاعتماد
   (كان يحذف الملف كاملاً — عطل مقيس 2026-11-15: اعتماد واحد أطاح بالباقي).
   التسلسل: نقرأ ثم نكتب ذرّياً (tmp+rename) داخل سلسلة كتابة واحدة؛ وإعادة
   اعتماد مسودة أُزيلت لا تحذف شيئاً ولا تفشل (idempotent). */
function pendingSignature(m) {
  const args = (m && m.args) || {};
  return `${String((m && m.tool) || '')}|${JSON.stringify(args, Object.keys(args).sort())}`;
}
async function dropApprovedFromPending(approved) {
  const ids = new Set((approved || []).map(pendingSignature));
  if (!ids.size) return { removed: 0, left: 0 };
  const file = path.join(core.dataDir, 'agent-pending.json');
  const run = async () => {
    let previous = null;
    try { previous = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return { removed: 0, left: 0 }; }
    const all = Array.isArray(previous && previous.mutations) ? previous.mutations : [];
    const left = all.filter((m) => !ids.has(pendingSignature(m)));
    const removed = all.length - left.length;
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ at: new Date().toISOString(), mutations: left }, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    if (removed) await core.appendAudit({ type: 'agent_pending_approved', removed, left: left.length }).catch(() => {});
    return { removed, left: left.length };
  };
  const chain = (dropApprovedFromPending._chain || Promise.resolve()).catch(() => {}).then(run);
  dropApprovedFromPending._chain = chain.then(() => undefined, () => undefined);
  return chain;
}

  if (req.method === 'GET' && url.pathname === '/api/agent/pending') {
    try { const j = JSON.parse(await fsp.readFile(path.join(core.dataDir, 'agent-pending.json'), 'utf8')); return json(res, 200, j); } catch { return json(res, 200, { mutations: [] }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/pending/reject') {
      if (!requireSession(req, res)) return;
    try { await fsp.rm(path.join(core.dataDir, 'agent-pending.json'), { force: true }); } catch {}
    await core.appendAudit({ type: 'agent_reject' }).catch(() => {});
    return json(res, 200, { ok: true });
  }
  // تنبيهات المجدول المخزنة (تعمل ولو غاب المستخدم)
  if (req.method === 'GET' && url.pathname === '/api/agent/findings') {
    try { const j = JSON.parse(await fsp.readFile(path.join(core.dataDir, 'agent-findings.json'), 'utf8')); return json(res, 200, j); } catch { return json(res, 200, { at: null, findings: [] }); }
  }
  // سجل النبضات (آخر 20) — دليل التشغيل الذاتي المقروء (bookmark/ledger/سجل تشغيل)
  if (req.method === 'GET' && url.pathname === '/api/agent/ticks') {
    try {
      const raw = await fsp.readFile(path.join(core.dataDir, 'scheduler-log.jsonl'), 'utf8');
      const items = raw.split('\n').filter(Boolean).slice(-20).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      return json(res, 200, { items });
    } catch { return json(res, 200, { items: [] }); }
  }
  // المهام المجدولة: عرض وإدارة (إضافة/حذف/تعطيل/تشغيل الآن) + ساعات النبض
  if (req.method === 'GET' && url.pathname === '/api/agent/schedule') {
    const settings = await core.readSettings();
    const tasks = Array.isArray(settings.agent?.scheduled_tasks) ? settings.agent.scheduled_tasks : [];
    const raw = settings.agent?.schedule_hours;
    const now = Date.now();
    return json(res, 200, {
      hours: raw != null ? Number(raw) : null,
      effectiveHours: raw === 0 || raw === '0' ? 0 : (Number(raw) > 0 ? Number(raw) : 6),
      tasks: tasks.map(t => ({ ...t, due: scheduledTaskDue(t, now) }))
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/schedule') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const action = String(payload.action || '').toLowerCase();
    const settings = await core.readSettings();
    settings.agent = settings.agent || {};
    if (payload.schedule_hours !== undefined) {
      const h = Number(payload.schedule_hours);
      if (!Number.isFinite(h) || h < 0 || h > 720) return json(res, 400, { error: apiMsg(payload, 'ساعات الفحص خارج النطاق (0..720 — و0 تعطّل النبض)', 'Sweep hours out of range (0..720 — 0 disables the pulse)') });
      settings.agent.schedule_hours = h;
    }
    if (action === 'add') {
      const out = await scheduleAddTask(settings, { goal: payload.goal, every_hours: payload.every_hours });
      return json(res, out.error ? (out.status || 400) : 200, out);
    }
    if (action === 'remove' || action === 'toggle') {
      const out = action === 'remove'
        ? await scheduleRemoveTask(settings, String(payload.id || ''))
        : await scheduleToggleTask(settings, String(payload.id || ''), payload.enabled);
      return json(res, out.error ? (out.status || 400) : 200, out);
    }
    if (action === 'run-now') {
      const id = String(payload.id || '');
      const tasks = [...scheduleTasksOf(settings)];
      const task = tasks.find(t => t.id === id);
      if (!task) return json(res, 404, { error: apiMsg(payload, 'مهمة غير موجودة', 'Task not found') });
      const runOut = await runScheduledTask(task, settings);
      task.last_run_at = new Date().toISOString();
      settings.agent.scheduled_tasks = tasks;
      await core.saveSettings(settings).catch(() => {});
      return json(res, 200, { ok: runOut.ok, run: runOut });
    }
    // بلا action: حفظ ساعات النبض وإعادة تسليح المؤقت فوراً
    await core.saveSettings(settings);
    armScheduler();
    await core.appendAudit({ type: 'agent_schedule_updated', hours: settings.agent.schedule_hours ?? null }).catch(() => {});
    return json(res, 200, { ok: true, hours: settings.agent.schedule_hours ?? null });
  }
  /* ═══ W1: التشغيل أوّل-درجة — قائمة/حالة/بث قابل لإعادة الاشتراك/إلغاء حقيقي ═══ */
  if (req.method === 'GET' && url.pathname === '/api/agent/runs') {
    return json(res, 200, { runs: runsStore().recent(Number(url.searchParams.get('limit')) || 12) });
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/runs/active') {
    return json(res, 200, { active: runsStore().active() });
  }
  /* بث التشغيل: يُعيد من السجل ثم يلحق الحيّ — فالعميل الذي أُغلق متصفحه
     يستأنف العرض كاملاً (?since=<آخر حدث>) بدل أن يبدأ من الصفر أو يفقد شيئاً. */
  if (req.method === 'GET' && url.pathname === '/api/agent/runs/stream') {
    const runId = String(url.searchParams.get('runId') || '').trim();
    if (!runId) return json(res, 400, { error: i18n.T('runId مطلوب', 'runId is required') });
    const rs = runsStore();
    if (!rs.summarize(runId)) return json(res, 404, { error: i18n.T('تشغيل غير موجود', 'Run not found') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    let since = Number(url.searchParams.get('since') || 0) || 0;
    let closed = false;
    req.on('close', () => { closed = true; });
    const t0 = Date.now();
    let lastPing = Date.now();
    try {
      while (!closed && Date.now() - t0 < 600000) {
        const list = rs.events(runId, { since });
        for (const e of list) {
          since = e.id;
          res.write(`data: ${JSON.stringify({ type: 'run_event', event: { id: e.id, runId, type: e.type, payload: e.payload, at: e.at } })}\n\n`);
        }
        const sum = rs.summarize(runId);
        if (sum && !sum.active) {
          res.write(`data: ${JSON.stringify({ type: 'run_end', summary: sum })}\n\n`);
          break;
        }
        if (Date.now() - lastPing > 15000) { lastPing = Date.now(); try { res.write(': ping\n\n'); } catch { break; } }
        await new Promise(r => setTimeout(r, 400));
      }
    } catch { /* العميل أغلق — ينتهي البث بهدوء */ }
    try { res.end(); } catch { /* مُغلق */ }
    return;
  }
  {
    const m = url.pathname.match(/^\/api\/agent\/runs\/([A-Za-z0-9._-]+)$/);
    if (req.method === 'GET' && m) {
      const runId = decodeURIComponent(m[1]);
      const rs = runsStore();
      const summary = rs.summarize(runId);
      if (!summary) return json(res, 404, { error: i18n.T('تشغيل غير موجود', 'Run not found') });
      const since = Number(url.searchParams.get('since') || 0) || 0;
      return json(res, 200, { summary, events: rs.events(runId, { since }), since });
    }
  }
  // إلغاء حقيقي: راية يفحصها الوكيل قبل الخطوة التالية — والحدث يُدوَّن فوراً
  if (req.method === 'POST' && url.pathname === '/api/agent/cancel') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const runId = String(payload.runId || '').trim();
    if (!runId) return json(res, 400, { error: apiMsg(payload, 'runId مطلوب', 'runId is required') });
    const rs = runsStore();
    const sum = rs.summarize(runId);
    if (!sum) return json(res, 404, { error: apiMsg(payload, 'تشغيل غير موجود بهذا المعرّف', 'No run with that id') });
    if (!sum.active) return json(res, 200, { ok: true, already: sum.terminal, runId });
    rs.requestCancel(runId);
    await core.appendAudit({ type: 'run_cancel_requested', runId, by: 'user' }).catch(() => {});
    return json(res, 200, { ok: true, runId, note: apiMsg(payload, 'سيتوقف قبل الخطوة التالية', 'It will stop before the next step') });
  }
  /* ═══ W5: عقد الصلاحيات والأدوار — عرضاً وتعديلاً بتأكيد صريح + تدقيق ═══ */
  if (req.method === 'GET' && url.pathname === '/api/agent/contract') {
    const policyMod = require('./cortex-policy');
    const settings = await core.readSettings();
    return json(res, 200, {
      autonomy: String(settings.agent?.autonomy || 'supervised'),
      modes: policyMod.AUTONOMY_MODES || ['supervised', 'assisted', 'autonomous'],
      roles: orc.ROLES || null,
      tools: policyMod.TOOL_POLICY || null,
      limits: effectiveCaps(settings),
      limitsBase: policyMod.DAILY_LIMITS || null,
      scheduleHours: settings.agent?.schedule_hours ?? null
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/contract-update') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    // البوابة البشرية نفسها: لا تغيير عقدٍ بلا تأكيد صريح في الحمولة (W5)
    if (payload.confirm !== true) {
      return json(res, 400, { error: apiMsg(payload, 'تغيير العقد يتطلب تأكيداً صريحاً (confirm: true)', 'Contract change requires explicit confirmation (confirm: true)') });
    }
    const policyMod = require('./cortex-policy');
    const settings = await core.readSettings();
    settings.agent = settings.agent || {};
    const changes = {};
    if (payload.autonomy !== undefined) {
      const a = String(payload.autonomy);
      const modes = policyMod.AUTONOMY_MODES || [];
      if (!modes.includes(a)) return json(res, 400, { error: apiMsg(payload, 'وضع استقلالية غير معروف', 'Unknown autonomy mode') });
      changes.autonomy = { from: settings.agent.autonomy || 'supervised', to: a };
      settings.agent.autonomy = a;
    }
    if (payload.limits !== undefined && payload.limits !== null) {
      const limits = { ...(settings.agent.limits || {}) };
      const base = policyMod.DAILY_LIMITS || {};
      for (const k of Object.keys(base)) {
        if (payload.limits[k] === undefined) continue;
        const v = Number(payload.limits[k]);
        if (!Number.isFinite(v) || v < 0 || v > 100000) return json(res, 400, { error: apiMsg(payload, `سقف ${k} خارج النطاق (0..100000 — و0 بلا سقف)`, `Cap for ${k} out of range (0..100000 — 0 = unlimited)`) });
        limits[k] = v;
      }
      changes.limits = limits;
      settings.agent.limits = limits;
    }
    if (!Object.keys(changes).length) return json(res, 400, { error: apiMsg(payload, 'لا تغيير مطلوب', 'No change requested') });
    await core.saveSettings(settings);
    await core.appendAudit({ type: 'agent_contract_updated', changes }).catch(() => {});
    return json(res, 200, { ok: true, changes });
  }
  // المهارات: فهرس الميتاداتا (الطبقة 1 من ثلاث) — الأجسام تُحمَّل بأداة use_skill عند الحاجة
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    try {
      skills.ensureDefaults();
      const r = skills.reload();
      return json(res, 200, { dir: path.join(WORK_ROOT, 'skills'), count: r.count, issues: r.issues || [], skills: skills.list() });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  /* تحقق من مهارة (2026-11-13): إضافة مهارة = مجلد فيه SKILL.md. بلا تحقق
     يبقى المستخدم يخمّن لماذا لا تظهر. هذا المسار يفحصها كما يفحصها المحمّل
     ثم يُعيد عيّنة من الجسم — إثبات أنها تُقرأ لا مجرد وجود ملف. */
  /* إنشاء مهارة من الواجهة (2026-11-14): كانت الإضافة تتطلب وضع مجلد يدوياً
     على القرص. الآن: اسم + وصف + جسم ⇒ يُكتب SKILL.md ويُتحقَّق فوراً بنفس
     المحمّل الذي يقرأه الوكيل — لا صيغة ثانية تنحرف عن الأصل. */
  if (req.method === 'POST' && url.pathname === '/api/skills/create') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const rawName = String(payload.name || '').trim();
    const description = String(payload.description || '').trim();
    const bodyText = String(payload.body || '').trim();
    /* slug آمن: لا مسارات ولا نقاط — نفس نمط المحمّل. الاسم غير الصالح يُرفض
       برسالته بدل أن يصبح مجلداً غريباً على القرص. */
    const slug = rawName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u0600-\u06FF-]/g, '').slice(0, 64);
    if (slug.length < 2) return json(res, 400, { ok: false, error: i18n.T('اسم المهارة غير صالح — حروف/أرقام/شرطة (٢–٦٤)', 'Invalid skill name — letters/digits/dash (2–64)') });
    if (!description) return json(res, 400, { ok: false, error: i18n.T('الوصف مطلوب — هو ما يراه الوكيل في الفهرس', 'Description is required — it is what the agent sees in the index') });
    if (description.length > 300) return json(res, 400, { ok: false, error: i18n.T(`الوصف ${description.length} حرفاً — السقف 300`, `Description is ${description.length} chars — cap is 300`) });
    if (!bodyText) return json(res, 400, { ok: false, error: i18n.T('جسم المهارة مطلوب', 'Skill body is required') });
    if (bodyText.length > 6000) return json(res, 400, { ok: false, error: i18n.T(`الجسم ${bodyText.length} حرفاً — السقف 6000`, `Body is ${bodyText.length} chars — cap is 6000`) });
    const dir = path.join(WORK_ROOT, 'skills', slug);
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file) && payload.overwrite !== true) {
      return json(res, 409, { ok: false, error: i18n.T('مهارة بنفس الاسم موجودة — أرسل overwrite:true للتحديث', 'A skill with this name exists — send overwrite:true to update'), name: slug });
    }
    try {
      await fsp.mkdir(dir, { recursive: true });
      const doc = `---\nname: ${slug}\ndescription: ${description}\n---\n\n${bodyText}\n`;
      await fsp.writeFile(file, doc, 'utf8');
      const r = skills.reload();
      const one = skills.get(slug);
      if (!one) {
        const issue = (r.issues || []).find(x => String(x.name || '') === slug);
        return json(res, 400, { ok: false, error: i18n.T('كُتب الملف لكنه لم يُقرأ كمهارة', 'The file was written but did not parse as a skill'), issue: issue || null, name: slug });
      }
      await core.appendAudit({ type: 'skill_created', name: slug, chars: String(one.body || '').length }).catch(() => {});
      return json(res, 200, { ok: true, name: slug, chars: String(one.body || '').length, preview: String(one.body || '').slice(0, 200), count: r.count });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/validate') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const name = String(payload.name || '').trim();
    try {
      const r = skills.reload();
      const issues = (r.issues || []).filter(x => !name || String(x.name || '') === name);
      if (!name) return json(res, 200, { ok: true, count: r.count, issues, skills: skills.list() });
      const one = skills.get(name);
      if (!one) {
        return json(res, 404, {
          ok: false, error: i18n.T(`المهارة غير موجودة أو فاسدة: ${name}`, `Skill missing or corrupt: ${name}`),
          issues,
          expected: i18n.T('ضع المجلد skills/' + name + '/SKILL.md', 'Place the folder skills/' + name + '/SKILL.md'),
        });
      }
      return json(res, 200, {
        ok: true, name, description: one.description || '',
        chars: String(one.body || '').length,
        preview: String(one.body || '').slice(0, 200),
        references: Array.isArray(one.references) ? one.references.length : 0,
        issues,
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/reload') {
      if (!requireSession(req, res)) return;
    const r = skills.reload();
    await core.appendAudit({ type: 'skills_reloaded', count: r.count }).catch(() => {});
    return json(res, 200, r);
  }
  // ── الطبقات الجديدة: الاستيراد · المستودعات · النماذج · MCP · المنسّق ──
  if (req.method === 'GET' && url.pathname === '/api/import/supported') {
    return json(res, 200, { extensions: imp.IMPORTABLE_EXTENSIONS });
  }
  // معاينة استيراد مجلد — تصنيف بلا كتابة، الواجهة تعرض ما سيُستورد قبل التأكيد
  if (req.method === 'POST' && url.pathname === '/api/import/preview') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const wantPath = String(payload.path || '');
    /* معاينة صادقة (إصلاح 2026-11-13): كانت تُمرّر أي مسار إلى importFolder،
       فمسار ملف يُرفض بـ«المسار ليس مجلداً» — أي أن «معاينة التصنيف» لا تعاين
       ملفاً أبداً. الآن: ملف ⇒ تصنيفه الفعلي بلا كتابة (importFile قراءة محضة)،
       مجلد ⇒ المعاينة الحالية. */
    let isFile = false;
    try { isFile = (await fsp.stat(wantPath)).isFile(); } catch { /* غير موجود: يتولى الرفض */ }
    if (isFile) {
      const one = await imp.importFile({ path: wantPath, allowedRoots: ALLOWED_ROOTS });
      if (one.error) return json(res, 400, { ok: false, error: one.error, path: wantPath });
      return json(res, 200, {
        ok: true, file: true, path: one.path, ext: one.ext, kind: one.kind,
        size: one.size, chars: String(one.clean || '').length,
        title: one.meta?.title || null, language: one.meta?.language || null,
        strippedCount: one.strippedCount || 0, unsupported: !!one.unsupported,
        preview: String(one.clean || '').slice(0, 400),
      });
    }
    const out = await imp.importFolder({ path: wantPath, allowedRoots: ALLOWED_ROOTS, maxFiles: Number(payload.maxFiles) || 200 });
    if (out.rejected) return json(res, 400, { error: out.reason, path: out.path || null, rejected: true });
    const byKind = {};
    for (const f of (out.perFile || [])) byKind[f.kind || 'file'] = (byKind[f.kind || 'file'] || 0) + 1;
    return json(res, 200, {
      ok: true, root: out.root, total: out.total, byKind,
      sample: (out.perFile || []).slice(0, 30).map(f => ({ path: f.path, kind: f.kind, ext: f.ext, size: f.size, error: f.error || null }))
    });
  }
  // §21: استيراد مجلد كامل — كل ملف يمر بمسار الاستيراد الفردي نفسه
  // (بصمة + stripInjection + فحص الحجر) ولا حقن يدخل بلا عزل وتسجيل.
  if (req.method === 'POST' && url.pathname === '/api/import/folder') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await imp.importFolder({
      path: String(payload.path || ''),
      allowedRoots: ALLOWED_ROOTS,
      maxFiles: Number(payload.maxFiles) || undefined,
    });
    if (out.rejected) return json(res, 400, { error: out.reason, path: out.path || null, rejected: true });
    const created = await persistBatchImport(out, { project: String(payload.project || ''), sourceKind: 'folder', rootLabel: out.root });
    return json(res, 200, {
      ok: true, root: out.root, scanned: out.total, created: created.created,
      skipped: created.skipped, quarantined: created.quarantined,
      isolationsLogged: created.isolations, relationsAdded: created.relationsAdded,
      perFile: created.perFile,
    });
  }
  // §21 + §23: استيراد مستودع git — clone محلي بمسار قرص أو بعيد https (#يمنع أي شيء آخر)
  if (req.method === 'POST' && url.pathname === '/api/import/remote') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const src = String(payload.url || '').trim();
    const looksLikeLocalPath = /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/');
    let out;
    let clonedInto = null;
    if (looksLikeLocalPath) {
      // clone محلي: مسار قرص حقيقي صحيح إلى مجلد قابل للقراءة (بلا شبكة وبلا https gate)
      const tmpDir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'cortex-git-clone-'));
      try {
        const result = require('child_process').spawnSync('git', ['clone', src, tmpDir], {
          encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (result.error || result.status !== 0) {
          const stderr = String(result.stderr || '').trim().split('\n').slice(-3).join(' | ');
          await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
          return json(res, 400, { error: i18n.T('فشل git clone المحلي: ', "Local git clone failed: ") + (result.error ? result.error.message : stderr || `exit ${result.status}`), rejected: true });
        }
        clonedInto = tmpDir;
        out = await imp.importFolder({ path: tmpDir, allowedRoots: [tmpDir], maxFiles: Number(payload.maxFiles) || undefined });
        if (out.rejected) {
          await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
          return json(res, 400, { error: out.reason || i18n.T('رفض استيراد المجلد المستنسخ', "Refused to import the cloned folder"), rejected: true });
        }
        // إعادة كتابة المسارات النسبية للمستودع في perFile
        for (const pf of (out.perFile || [])) {
          if (pf.path && path.isAbsolute(pf.path)) {
            pf.path = path.relative(tmpDir, pf.path).split(path.sep).join('/');
          }
        }
      } catch (e) {
        await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
        return json(res, 400, { error: e.message, rejected: true });
      }
    } else {
      // بعيد: بوابة validateGitUrl + DNS حاكم + clone إلى مؤقت + تنظيف نهائي
      out = await imp.importGitRepo({
        url: src,
        depth: Number(payload.depth) || 1,
        maxFiles: Number(payload.maxFiles) || undefined,
      });
      clonedInto = out.clonedInto || null;
      if (out.rejected) {
        return json(res, 400, { error: out.reason, url: src, rejected: true, clonedInto: clonedInto || null });
      }
    }
    const created = await persistBatchImport(out, { project: String(payload.project || ''), sourceKind: looksLikeLocalPath ? 'git-local' : 'git-remote', stableRoot: (looksLikeLocalPath ? 'git-local:' : 'git-remote:') + src, rootLabel: clonedInto || src });
    // تنظيف مجلد الاستنساخ المحلي بعد الاستيراد (commit القوس المؤقت يزول دائماً)
    if (clonedInto && looksLikeLocalPath) {
      await fsp.rm(clonedInto, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
    return json(res, 200, {
      ok: true, clonedInto: clonedInto || src, scanned: out.total, created: created.created,
      skipped: created.skipped, quarantined: created.quarantined,
      isolationsLogged: created.isolations, relationsAdded: created.relationsAdded,
      perFile: created.perFile,
    });
  }
  // §19: إكسپورت مشروع — md بملف واحد + manifest، أو zip مخزّن بكاتب داخلي بلا أرشيف خارجي
  if (req.method === 'GET' && url.pathname === '/api/export/project') {
    const project = String(url.searchParams.get('project') || '').trim();
    const format = String(url.searchParams.get('format') || 'md').toLowerCase();
    if (!project) return json(res, 400, { error: i18n.T('المشروع مطلوب: ?project=', "Project is required: ?project=") });
    if (!['md', 'zip'].includes(format)) return json(res, 400, { error: i18n.T('format غير مدعوم: md | zip فقط', "Unsupported format: md | zip only") });
    try {
      const out = await buildProjectExportPayload({ project });
      if (!out.notes.length) return json(res, 404, { error: `لا عناصر لمشروع ${project}` });
      const result = await writeExportFile(out, { project, format });
      return json(res, 200, result);
    } catch (e) {
      return json(res, 500, { error: i18n.T('فشل الإكسپورت: ', "Export failed: ") + e.message });
    }
  }
  /* ما استُورد — مرآة الوكيل والبشر معاً (2026-11-13) */
  if (req.method === 'GET' && url.pathname === '/api/imports') {
    const r = await doImportList({
      project: String(url.searchParams.get('project') || ''),
      limit: url.searchParams.get('limit'),
    });
    return json(res, r.status, r.body);
  }
  if (req.method === 'POST' && url.pathname === '/api/import') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const project = String(payload.project || '').trim();
    const wantPath = String(payload.path || '');
    // مسار مجلد كان يُرفض بـ«المسار ليس ملفاً» — والواجهة ترسل مساراً نصياً واحداً بلا تمييز نوع.
    // القاعدة: مجلد ⇒ استيراد حزمة ملفات (نفس مسار /api/import/folder)، ملف ⇒ الاستيراد المفرد.
    let isDir = false;
    try { isDir = (await fsp.stat(wantPath)).isDirectory(); } catch { /* غير موجود ⇒ يتولّى importFile الرفض برسالته */ }
    if (isDir) {
      const fout = await imp.importFolder({ path: wantPath, allowedRoots: ALLOWED_ROOTS, maxFiles: Number(payload.maxFiles) || undefined });
      if (fout.rejected) return json(res, 400, { error: fout.reason, path: fout.path || null, rejected: true });
      const fcreated = await persistBatchImport(fout, { project, sourceKind: 'folder', rootLabel: fout.root });
      return json(res, 200, {
        ok: true, folder: true, root: fout.root, scanned: fout.total,
        created: fcreated.created, skipped: fcreated.skipped, quarantined: fcreated.quarantined,
        isolationsLogged: fcreated.isolations, relationsAdded: fcreated.relationsAdded,
        perFile: fcreated.perFile,
      });
    }
    const out = await imp.importFile({ path: wantPath, allowedRoots: ALLOWED_ROOTS });
    if (out.error) return json(res, 400, out);
    /* §19 — كشف التكرار يجري **قبل** أي كتابة (إصلاح 2026-11-06).
       العطل المُقاس: كان الكشف بعد core.saveNote، فيُنشأ الملف ثم يأتي الرد
       «استيراد مُعاد — لم تُنشأ نسخة ثانية». الحصيلة على خزنة حقيقية: 15 نسخة
       متطابقة (نفس البصمة) لملف واحد — نسخة جديدة لكل استيراد. */
    const importedAt = new Date().toISOString();
    const ldb = layerDb();
    let duplicateOf = null;
    // كشف تكرار الاستيراد: البصمة تُستعلَم قبل أي إضافة (§19 + منع التكرار الأعمى)
    try {
      const impMod = optMod('cortex-import');
      const dup = impMod && typeof impMod.findDuplicate === 'function' ? impMod.findDuplicate(ldb, out.fingerprint) : { duplicate: false };
      if (dup && dup.duplicate) {
        /* صف بلا ملف = بقايا جلسات قديمة (قياس 2026-11-06: 30 صفاً يشير إلى
           ملاحظة محذوفة). كان يمنع الاستيراد صامتاً ويقول «لم تُنشأ نسخة ثانية»
           بينما لا وجود لأي نسخة. الصف البائد يُنظَّف ويُسجَّل، ويُكمل الاستيراد. */
        const existingFile = dup.existingId ? path.join(core.vaultDir, dup.existingId + '.md') : null;
        if (existingFile && fs.existsSync(existingFile)) {
          duplicateOf = dup;
        } else if (ldb && dup.existingId) {
          try {
            ldb.prepare('DELETE FROM document_entities WHERE id = ?').run(dup.existingId);
            writeAudit('stale_duplicate_row_cleared', { fingerprint: out.fingerprint, path: out.path, staleId: dup.existingId },
              { scope: 'import', actor: 'import' });
          } catch { /* تعذّر التنظيف: يُكمل كاستيراد جديد بلا صمت */ }
        }
      }
    } catch { /* بلا وحدة استيراد — لا كشف تكرار */ }
    // §19: التكرار لا يُنتج نسخة ثانية — البصمة موجودة ⇒ هذا استيراد مُعاد.
    // كان duplicateOf يُحسَب ثم يُهمَل تماماً (كـspecPolicy سابقاً) فيمرّ التكرار.
    if (duplicateOf && ldb) {
      try {
        writeAudit('duplicate_rejected', { fingerprint: out.fingerprint, path: out.path, existingId: duplicateOf.existingId ?? null },
          { scope: 'import', actor: 'import' });
      } catch { /* لا سجل */ }
      return json(res, 200, {
        ok: true, deduplicated: true, path: out.path, ext: out.ext, kind: out.kind,
        fingerprint: out.fingerprint, size: out.size, importedAt,
        existingId: duplicateOf.existingId ?? null, existingTitle: duplicateOf.existingTitle ?? null,
        existingImportedAt: duplicateOf.existingImportedAt ?? null,
        assetsSaved: false, note: i18n.T('استيراد مُعاد — لم تُنشأ نسخة ثانية (§19)', "Duplicate import — no second copy created (§19)")
      });
    }

    const title = out.meta?.title || path.basename(out.path || 'imported');
    /* لا كتابة قبل التأكد أنه ليس تكراراً */
    const note = await core.saveNote({
      title, type: 'document', project, importance: 2, content: out.clean || '',
      source: out.path, kind: 'document', knowledge_kind: 'imported', fingerprint: out.fingerprint
    });
    let assetsSaved = false;
    let assetCopyPath = null;
    if (ldb) {
      const analysis = JSON.stringify({
        meta: out.meta || null, ext: out.ext, kind: out.kind, size: out.size,
        archive: out.archive || null, unsupported: !!out.unsupported,
        strippedCount: out.strippedCount || 0,
      });
      try {
        const version = recordDocumentEntity(ldb, {
          noteId: note.id, source: out.path, kind: out.kind || 'document', fingerprint: out.fingerprint,
          importedAt, analysis, language: out.meta?.language || null,
          pageCount: Number.isFinite(out.meta?.pageCount) ? out.meta.pageCount : null,
          originalPath: out.path,
        });
        out.version = version;
        // §19: نسخ البايتات الأصلية فعلياً — assetsSaved صادق فقط بأثر مُثبت على القرص
        assetsSaved = await persistOriginalAsset(out, ldb, note.id);
        if (assetsSaved) assetCopyPath = path.join(ASSETS_DIR, `${out.fingerprint}${path.extname(out.path) || '.bin'}`);
      } catch { /* فشل أرشفة الأصل لا يُسقط الاستيراد لكنه يُبلَّغ في الرد */ }
    }
    // §21: كل حقن مُعزَل يُسجَّل تدقيقياً لا صامتاً.
    const iso = logIsolations({ source: out.path, fingerprint: out.fingerprint, noteId: note.id, stripped: out.stripped, at: importedAt });
    // §37: فحص قبل المعالجة — الملف المشبوه أو الحامل لمحاولة توجيه يُحجر،
    // ولا يجوز أن يمرّ إلى قاعدة المعرفة كمعرفة عادية.
    const screen = screenImport({ path: out.path, clean: out.clean, stripped: out.stripped, fingerprint: out.fingerprint, noteId: note.id });
    // §7: نشتق علاقات حقيقية من الوارد بدل ترك الخريطة بلا روابط.
    let rels = { added: 0 };
    try {
      const rel = optMod('cortex-relations');
      if (rel?.inferRelations && ldb) rels = rel.inferRelations(ldb, { notes: await core.readNotes() });
    } catch { rels = { added: 0 }; }
    // §24 + §38: الاستيراد تغيير — يُلتقط ليكون قابلاً للتراجع.
    const snap = recordChange({ entity: 'note', entityId: note.id, op: 'import', before: null, after: { id: note.id, source: out.path }, actor: 'import' });
    notifyWatch('import_file');
    return json(res, 200, {
      ok: true, path: out.path, ext: out.ext, kind: out.kind, fingerprint: out.fingerprint,
      size: out.size, meta: out.meta, strippedCount: out.strippedCount,
      importedAt, originalPath: out.path, assetsSaved, isolationsLogged: iso.logged,
      quarantined: !!screen.quarantined, suspicion: screen.suspicious ? { severity: screen.severity || null, signals: screen.signals || [] } : null,
      relationsAdded: rels.added ?? 0, rollbackReady: !!snap.ok,
      deduplicated: false, assetPath: assetCopyPath,
      note: { id: note.id, title: note.title, project: note.projectName || '' }
    });
  }
  // M20 (دستور): استيراد من ويب — https فقط، مضيف عام، لا إعادة توجيه، لا تنفيذ، لا كتابة على القرص.
  if (req.method === 'POST' && url.pathname === '/api/import/web') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await imp.importWeb({ url: String(payload.url || ''), allowedRoots: ALLOWED_ROOTS });
    if (!out.ok) return json(res, 400, { ok: false, error: out.error, path: out.path, unsupported: out.unsupported });
    /* §19 (عطل مُقاس 2026-10-24): استيراد الويب كان يعيد تحليلاً ولا يخزّن شيئاً —
       لا ملاحظة، لا document_entities، لا أصل، لا تاريخ. الآن يُخزَّن كاملاً
       بنفس مسار الاستيراد الفردي: ملاحظة + أصل + أرشفة بإصدار. */
    const importedAt = new Date().toISOString();
    const ldb = layerDb();

    /* §19 — كشف التكرار **قبل** أي كتابة (كان غائباً كلياً عن مسار الويب).
       العطل المُقاس: مسار الملفات كان يُنشئ نسخة جديدة لكل استيراد (15 نسخة
       متطابقة) حتى أُصلح؛ ومسار الويب لم يكن يكشف التكرار أصلاً. */
    let duplicateOf = null;
    try {
      const impMod = optMod('cortex-import');
      const dup = impMod && typeof impMod.findDuplicate === 'function' ? impMod.findDuplicate(ldb, out.fingerprint) : { duplicate: false };
      if (dup && dup.duplicate) {
        const existingFile = dup.existingId ? path.join(core.vaultDir, dup.existingId + '.md') : null;
        if (existingFile && fs.existsSync(existingFile)) duplicateOf = dup;
        else if (ldb && dup.existingId) {
          try {
            ldb.prepare('DELETE FROM document_entities WHERE id = ?').run(dup.existingId);
            writeAudit('stale_duplicate_row_cleared', { fingerprint: out.fingerprint, path: out.path, staleId: dup.existingId },
              { scope: 'import', actor: 'import' });
          } catch { /* تعذّر التنظيف: يُكمل كاستيراد جديد بلا صمت */ }
        }
      }
    } catch { /* بلا وحدة استيراد — لا كشف تكرار */ }
    if (duplicateOf && ldb) {
      try {
        writeAudit('duplicate_rejected', { fingerprint: out.fingerprint, path: out.path, existingId: duplicateOf.existingId ?? null },
          { scope: 'import', actor: 'import' });
      } catch { /* لا سجل */ }
      return json(res, 200, {
        ok: true, deduplicated: true, path: out.path, ext: out.ext, kind: out.kind,
        fingerprint: out.fingerprint, size: out.size, importedAt,
        existingId: duplicateOf.existingId ?? null, existingTitle: duplicateOf.existingTitle ?? null,
        existingImportedAt: duplicateOf.existingImportedAt ?? null, assetsSaved: false,
        note: i18n.T('استيراد مُعاد — لم تُنشأ نسخة ثانية (§19)', 'Duplicate import — no second copy created (§19)'),
      });
    }

    const note = await core.saveNote({
      title: String(out.meta?.title || out.fingerprint.slice(0, 12)),
      type: 'doc', documentType: 'imported',
      project: String(payload.project || ''), importance: 2,
      content: out.clean || '', source: String(out.meta?.source || payload.url || ''),
      kind: 'document', knowledge_kind: 'imported', fingerprint: out.fingerprint,
    });
    const version = recordDocumentEntity(ldb, {
      noteId: note.id, source: String(out.meta?.source || payload.url || ''), kind: 'web',
      fingerprint: out.fingerprint, importedAt,
      analysis: JSON.stringify({ meta: out.meta || null, kind: out.kind, size: out.size, strippedCount: out.strippedCount }),
      originalPath: out.path || null,
    });
    const assetSaved = await persistOriginalAsset(out, ldb, note.id);
    /* §21: كل حقن مُعزَل من صفحة ويب يُسجَّل تدقيقياً لا صامتاً (كان غائباً هنا). */
    const iso = logIsolations({ source: out.path, fingerprint: out.fingerprint, noteId: note.id, stripped: out.stripped, at: importedAt });
    /* §37: الحجر يجري على مسار الويب أيضاً. كان غائباً، وهو المسار الوحيد الذي
       يبتلع محتوى كتبه غريب عن الخزنة ⇒ أخطر موضع لغياب البوابة. */
    const screen = screenImport({ path: out.path, clean: out.clean, stripped: out.stripped, fingerprint: out.fingerprint, noteId: note.id });
    /* §24 + §38: الاستيراد تغيير — يُلتقط ليكون قابلاً للتراجع (كان غائباً هنا). */
    const snap = recordChange({ entity: 'note', entityId: note.id, op: 'import', before: null, after: { id: note.id, source: out.path }, actor: 'import' });
    notifyWatch('import_web');
    return json(res, 200, { ok: true, id: note.id, title: note.title, version, assetSaved,
      path: out.path, ext: out.ext, kind: out.kind, fingerprint: out.fingerprint,
      size: out.size, meta: out.meta, strippedCount: out.strippedCount, source: out.meta?.source,
      isolationsLogged: iso.logged, deduplicated: false,
      quarantined: !!screen.quarantined,
      suspicion: screen.suspicious ? { severity: screen.severity || null, signals: screen.signals || [] } : null,
      rollbackReady: !!snap.ok });
  }

  // M21 (دستور): مزامنة ملفات — مجلد مصدر → مجلد هدف، فقط الجديد/المعدل يُنقل، لا تنفيذ.
  if (req.method === 'POST' && url.pathname === '/api/import/sync') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await imp.syncFiles({ source: String(payload.source || ''), target: String(payload.target || ''), allowedRoots: ALLOWED_ROOTS });
    if (!!out.error) return json(res, 400, { ok: false, error: out.error, files: out.files });
    return json(res, 200, { ok: true, synced: out.synced, skipped: out.skipped, files: out.files, source: out.source, target: out.target });
  }
  /* عقد الأخطاء (إصلاح 2026-11-12): كانت تُرجع 200 مع {error:"empty path"}
     فيقرأها الوكيل نجاحًا. القاعدة الآن: خطأ ⇒ 4xx دائمًا، لا 200 بحقل خطأ. */
  const repoReply = (out) => {
    if (out && out.error) {
      const bad = /empty path|required|غير مسموح|not allowed|outside/i.test(String(out.error));
      return json(res, bad ? 400 : 500, { ok: false, error: String(out.error) });
    }
    return json(res, 200, Object.assign({ ok: true }, out));
  };
  if (req.method === 'GET' && url.pathname === '/api/repo/index') {
    return repoReply(await extTools.TOOL_IMPLS.repo_index({ path: String(url.searchParams.get('path') || '') }, { allowedRoots: ALLOWED_ROOTS }));
  }
  if (req.method === 'GET' && url.pathname === '/api/repo/deps') {
    /* ?repo=<id> يقرأ الحواف المخزَّنة في SQLite (من الاحتضان) بدل إعادة المسح.
       هذا ما يجعل repo_deps جدولاً حياً لا أرشيفاً: استعلام فوري، وربط ممكن
       بالقرارات واشتقاق الخطورة. المسح الحيّ يبقى عند غياب المعرّف. */
    const repoId = String(url.searchParams.get('repo') || '').trim();
    if (repoId) {
      const db = layerDb();
      if (!db) return json(res, 503, { ok: false, error: i18n.T('طبقة SQLite غير متاحة', 'SQLite layer unavailable') });
      try {
        const rows = db.prepare('SELECT from_file, to_file, kind, confidence, extracted_at FROM repo_deps WHERE repo_id = ? LIMIT 5000').all(repoId);
        const repo = db.prepare('SELECT id, path, last_indexed, file_count FROM repos WHERE id = ?').get(repoId) || null;
        if (!repo) return json(res, 404, { ok: false, error: i18n.T('مستودع غير محتضَن: احتضنه أولاً', 'Repo not absorbed: absorb it first') });
        return json(res, 200, { ok: true, repo, count: rows.length, edges: rows });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }
    return repoReply(await extTools.TOOL_IMPLS.repo_deps({ path: String(url.searchParams.get('path') || '') }, { allowedRoots: ALLOWED_ROOTS }));
  }
  /* إصلاح 2026-11-13 (قسم «المستودعات» كان أداة بشرية بحتة): الواجهة كانت
     تستعيد من localStorage فقط، ولا مسار يعرض ما يعرفه **الوكيل**. النتيجة:
     مستودعان مفهورسان و350 حافة في القاعدة، والقسم يبدو فارغاً.
     هذا المسار يجعل القسم مرآةً لذاكرة الوكيل لا نموذج إدخال. */
  if (req.method === 'GET' && url.pathname === '/api/repos') {
    const db = layerDb();
    if (!db) return json(res, 200, { ok: true, repos: [] });
    try {
      const repos = db.prepare('SELECT id, path, file_count, last_indexed FROM repos ORDER BY last_indexed DESC').all();
      const depCount = db.prepare('SELECT COUNT(*) c FROM repo_deps WHERE repo_id = ?');
      return json(res, 200, {
        ok: true,
        repos: repos.map(r => ({
          id: r.id,
          path: r.path,
          files: Number(r.file_count) || 0,
          lastIndexed: r.last_indexed,
          edges: (() => { try { return Number(depCount.get(r.id).c) || 0; } catch { return 0; } })(),
        })),
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/repo/impact') {
    /* ?repo=<id>&file=<path> يحسب الأثر من الحواف المخزَّنة (استعلام عكسي فوري)
       بدل إعادة مسح 455 ملفاً. هذا ما يجعل الأداة قابلة للاستدعاء من الوكيل
       داخل جولة واحدة بدل أن تكلّف ثوانٍ في كل سؤال. */
    const impactRepo = String(url.searchParams.get('repo') || '').trim();
    const impactFile = String(url.searchParams.get('file') || '').trim();
    if (impactRepo && impactFile) {
      const db = layerDb();
      if (!db) return json(res, 503, { ok: false, error: i18n.T('طبقة SQLite غير متاحة', 'SQLite layer unavailable') });
      try {
        const repo = db.prepare('SELECT id, path, file_count, last_indexed FROM repos WHERE id = ?').get(impactRepo);
        if (!repo) return json(res, 404, { ok: false, error: i18n.T('مستودع غير محتضَن', 'Repo not absorbed') });
        // الملف قد يُذكر بمساره الكامل أو نسبي — نطابق الذيول
        const needle = impactFile.replace(/\\/g, '/');
        const direct = db.prepare("SELECT DISTINCT from_file, kind FROM repo_deps WHERE repo_id = ? AND replace(to_file,'\\','/') LIKE ?").all(impactRepo, `%${needle}%`);
        const reverse = db.prepare("SELECT DISTINCT to_file, kind FROM repo_deps WHERE repo_id = ? AND replace(from_file,'\\','/') LIKE ?").all(impactRepo, `%${needle}%`);
        return json(res, 200, {
          ok: true, repo: repo.id, file: impactFile, source: 'sqlite',
          affected: direct.map(r => r.from_file),
          dependsOn: reverse.map(r => r.to_file),
          count: direct.length,
        });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }
    return repoReply(await extTools.TOOL_IMPLS.repo_impact({ path: String(url.searchParams.get('path') || ''), file: String(url.searchParams.get('file') || '') }, { allowedRoots: ALLOWED_ROOTS }));
  }
  /* ── ذاكرة المشاريع لوكلاء البناء (2026-10-28) ──────────────────────────
     الهدف الثاني: احتضان المشروع (خرائط مرجعية+اعتمادية+سياق، لا نسخ ملفات)
     الهدف الأول: قاطع السياق — الجزء اللازم + المسار + تلخيص دقيق */
  /* عارض الملفات (م27، 2026-10-29): قراءة نصية مقيدة بنفس حماية الأدوات الخارجية
     (الجذور المسموحة تُفرض في resolveSafePath — لا مسار خارجها)؛ للنقرة من «المصادر». */
  if (req.method === 'GET' && url.pathname === '/api/file') {
    /* حماية إضافية **حتى مع جلسة صالحة**: عارض الملفات لا يقرأ منطقة البيانات —
       رمز الجلسة ومفتاح التشفير والقاعدة والنسخ ليست «مصادر» تُعرض. (الثغرة كانت:
       قراءة data/session.token ثم data/.keystore ثم فكّ enc:v1 من settings.json.) */
    const dataRoot = path.resolve(core.dataDir);
    let asked = '';
    try { asked = path.resolve(String(url.searchParams.get('path') || '')); } catch { asked = ''; }
    if (asked && (asked === dataRoot || asked.startsWith(dataRoot + path.sep))) {
      return json(res, 403, { ok: false, error: i18n.T('مسار محمي — لا يُقرأ عبر عارض الملفات', 'Protected path — not readable through the file viewer'), code: 'PROTECTED_PATH' });
    }
    const out = await extTools.TOOL_IMPLS.fs_read({ path: String(url.searchParams.get('path') || '') }, { allowedRoots: ALLOWED_ROOTS });
    if (out.error) return json(res, 400, { ok: false, error: out.error });
    return json(res, 200, { ok: true, path: out.path, size: out.size, truncated: out.truncated, lines: out.lines, content: out.content });
  }
  if (req.method === 'POST' && url.pathname === '/api/project/absorb') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = await projectMemory.absorbProject({ path: String(payload.path || ''), project: String(payload.project || ''), refresh: payload.refresh !== false });
    return json(res, out.error ? 400 : 200, out);
  }
  if (req.method === 'GET' && url.pathname === '/api/project/map') {
    const id = projectMemory.slug(String(url.searchParams.get('project') || ''));
    const map = projectMemory.readMap(id);
    return json(res, map ? 200 : 404, map || { error: 'لا خريطة لهذا المشروع — احتضنه أولاً', id });
  }
  if (req.method === 'GET' && url.pathname === '/api/projects/maps') {
    return json(res, 200, { maps: projectMemory.listProjectMaps() });
  }
  if (req.method === 'POST' && url.pathname === '/api/memory/slice') {
    const payload = await body(req);
    const out = await projectMemory.buildMemorySlice(payload || {});
    return json(res, out.error ? 400 : 200, out);
  }
  if (req.method === 'POST' && url.pathname === '/api/memory/record') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const out = projectMemory.appendTrail({ project: String(payload.project || ''), source: String(payload.source || 'api'), entries: payload.entries });
    return json(res, out.error ? 400 : 200, out);
  }
  if (req.method === 'GET' && url.pathname === '/api/project/trail') {
    return json(res, 200, projectMemory.readTrail({ project: String(url.searchParams.get('project') || ''), limit: Number(url.searchParams.get('limit') || 30) }));
  }
  // قائمة المزودين بمفاتيح مموّهة — لا يُعاد أي مفتاح كامل (§15)
  if (req.method === 'GET' && url.pathname === '/api/models/providers') {
    const settings = await core.readSettings();
    return json(res, 200, { providers: gw.listProviders(settings) });
  }
  // فحص فوري لمزود محفوظ بالاسم — يوثق النتيجة في الإعدادات (شارة حية بالواجهة)
  if (req.method === 'POST' && url.pathname === '/api/models/probe-provider') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const settings = await core.readSettings();
    const name = String(payload.name || '');
    const targets = Array.isArray(settings.providers) ? settings.providers : [];
    const hit = targets.find(p => String(p.name || '') === name);
    if (!hit) return json(res, 404, { error: i18n.T(`لا يوجد مزود محفوظ بهذا الاسم: ${name}`, `No saved provider with this name: ${name}`) });
    const at = new Date().toISOString();
    try {
      const conn = await gw.probeConnection(hit.baseUrl, hit.apiKey, { timeoutMs: 6000 });
      const disc = conn.ok ? await gw.discoverModels(hit.baseUrl, hit.apiKey).catch(() => ({ ok: false, models: [] })) : { ok: false, models: [] };
      const modelsCount = Array.isArray(disc.models) ? disc.models.length : 0;
      hit.lastProbe = { at, ok: !!conn.ok, modelsCount, error: conn.ok ? null : String(conn.error || i18n.T('فشل الاتصال', "Connection failed")) };
      await core.saveSettings(settings);
      return json(res, 200, { name, ok: !!conn.ok, at, modelsCount, error: hit.lastProbe.error });
    } catch (e) {
      hit.lastProbe = { at, ok: false, modelsCount: 0, error: String(e.message || e) };
      await core.saveSettings(settings);
      return json(res, 200, { name, ok: false, at, modelsCount: 0, error: hit.lastProbe.error });
    }
  }
  /* تفعيل مزود محفوظ من الخادم نفسه — لا رحلة مفتاح إلى المتصفح (§15).
     العطل الذي أُصلح: زر «استخدم» في الواجهة كان يعيد إرسال مفتاح القائمة،
     وهو **مقنَّع** دائماً (`thk_...qg`)، فتمرّره حماية /api/settings إلى
     المفتاح النشط السابق — فيُحفظ عنوان مزود جديد بمفتاح مزود آخر (401). */
  if (req.method === 'POST' && url.pathname === '/api/models/use-provider') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const name = String(payload.name || '');
    const settings = await core.readSettings();
    const saved = Array.isArray(settings.providers) ? settings.providers : [];
    const hit = saved.find((p) => p && String(p.name || '') === name);
    if (!hit) return json(res, 404, { error: i18n.T(`لا يوجد مزود محفوظ بهذا الاسم: ${name}`, `No saved provider with this name: ${name}`) });
    const info = Array.isArray(hit.modelsInfo) ? hit.modelsInfo : [];
    const proven = info.find((m) => m && m.canGenerate === true);
    const model = String(payload.model || '').trim() || (proven && proven.id) || (Array.isArray(hit.models) ? hit.models[0] : '');
    if (!model) {
      return json(res, 400, { ok: false, error: i18n.T('المزود بلا نموذج مُثبت — أعد فحصه أو أدخل معرّف النموذج', 'Provider has no proven model — re-probe it or supply a model id') });
    }
    /* القناع يُحسب قبل الحفظ: saveSettings يشفّر في مكانه فيحوّل hit.apiKey
       إلى نص مشفّر، فيظهر القناع «enc:...» لو حُسب بعده. */
    const maskedKey = gw.maskKey(hit.apiKey || '');
    /* المُشغِّل لا الاسم: callModel يوزّع على mock/ollama/openai-compatible فقط،
       وكل مزود محفوظ هنا فُحص عبر /chat/completions أي أنه متوافق مع OpenAI. */
    await core.saveSettings({
      ...settings,
      ai: { ...(settings.ai || {}), provider: 'openai-compatible', providerName: hit.name, baseUrl: hit.baseUrl, apiKey: hit.apiKey || '', model },
    });
    return json(res, 200, { ok: true, name, baseUrl: hit.baseUrl, model, maskedKey });
  }
if (req.method === 'POST' && url.pathname === '/api/models/remove-provider') {
    if (!requireSession(req, res)) return;
    const payload = await body(req);
    const name = String(payload.name || '').trim();
    if (!name) return json(res, 400, { ok: false, error: i18n.T('اسم المزود مطلوب', 'Provider name required') });
    const settings = await core.readSettings();
    const list = Array.isArray(settings.providers) ? settings.providers : [];
    const hit = list.find((p) => p && String(p.name || '') === name);
    if (!hit) return json(res, 404, { ok: false, error: i18n.T(`لا يوجد مزود بهذا الاسم: ${name}`, `No provider named: ${name}`) });
    /* المزود النشط لا يُحذف: يُترك المستخدم ينتقل لغيره أولاً حتى لا يبقى النظام
       بمفتاح محذوف و«مزود» لا وجود له (فشل غامض عند أول نداء). */
    const activeName = activeProviderName(settings);
    if (activeName === name) {
      return json(res, 400, { ok: false, error: i18n.T('هذا المزود هو النشط — انتقل إلى مزود آخر ثم احذفه', 'This is the active provider — switch to another before removing it') });
    }
    const next = list.filter((p) => p && String(p.name || '') !== name);
    await core.saveSettings({ ...settings, providers: next });
    await core.appendAudit({ type: 'provider_removed', name }).catch(() => {});
    return json(res, 200, { ok: true, removed: name, remaining: next.length });
  }
  /* فحص مزود **قبل** حفظه (إصلاح 2026-11-13): التدفق المطلوب هو
     «أدخل البيانات → اختبر → اختر نموذجاً → احفظ». بلا هذا المسار كان
     الاختبار والحفظ في زر واحد، فيُحفظ المزود ويُختار له نموذج تلقائياً
     قبل أن يرى المستخدم الخيارات أصلاً. هذا المسار لا يكتب شيئاً. */
  if (req.method === 'POST' && url.pathname === '/api/models/test-provider') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const tName = String(payload.name || '').trim();
    const tUrl = String(payload.baseUrl || '').trim();
    if (!tName || !tUrl) return json(res, 400, { ok: false, error: i18n.T('الاسم والعنوان مطلوبان', 'Name and Base URL are required') });
    // مفتاح فارغ = تعديل مزود قائم: يُقرأ المحفوظ ولا يُعاد أبداً
    let tKey = String(payload.apiKey || '').trim();
    if (!tKey) {
      const cur = await core.readSettings();
      const hit = (Array.isArray(cur.providers) ? cur.providers : []).find(p => p && p.name === tName);
      if (hit && hit.apiKey) tKey = hit.apiKey;
    }
    if (!tKey) return json(res, 400, { ok: false, error: i18n.T('مفتاح API مطلوب', 'API key is required') });
    const manual = Array.isArray(payload.models) ? payload.models : [];
    try {
      const result = await gw.addProvider(
        { name: tName, baseUrl: tUrl, apiKey: tKey, models: manual },
        { timeoutMs: Number(payload.timeoutMs) || 30000, probeCapabilities: payload.probeCapabilities === true }
      );
      return json(res, result.ok ? 200 : 400, {
        ok: !!result.ok,
        step: result.step || null,
        error: result.error || null,
        models: (result.models || []).map(m => ({
          id: m.id,
          canGenerate: m.canGenerate === true,
          error: m.canGenerate === true ? null : String(m.error || '').slice(0, 160) || null,
        })),
      });
    } catch (e) {
      return json(res, 400, { ok: false, step: 'test-provider', error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/models/add-provider') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    try {
      // معرّفات نماذج يدوية: مزود قد يقفل نقطة الاكتشاف ويخدم التوليد (tokenharbor.ai)
      const manualModels = Array.isArray(payload.models)
        ? payload.models
        : (String(payload.model || '').trim() ? [payload.model] : []);
      /* تعديل مزود قائم بلا إعادة كتابة المفتاح (إصلاح 2026-11-13): نموذج
         «حفظ/تعديل» يتطلب ألا يُجبر المستخدم على لصق المفتاح من جديد — وهو
         لا يستطيع قراءته بعد الحفظ (يُعرض مقنّعاً). المفتاح الفارغ = أبقِه. */
      let effectiveKey = String(payload.apiKey || '').trim();
      if (!effectiveKey) {
        const current = await core.readSettings();
        const existing = (Array.isArray(current.providers) ? current.providers : [])
          .find(p => p && p.name === payload.name);
        if (existing && existing.apiKey) effectiveKey = existing.apiKey;
      }
      const result = await gw.addProvider(
        { name: payload.name, baseUrl: payload.baseUrl, apiKey: effectiveKey, models: manualModels },
        { timeoutMs: Number(payload.timeoutMs) || 12000, probeCapabilities: payload.probeCapabilities !== false }
      );
      if (!result.ok) return json(res, 400, result);
      /* مزود سليم فعلياً: يُحفظ في الإعدادات بمفتاحه (لا يُعاد أبداً في الرد).
         م12/م10-7 (عطل «سلك غير موصول» مُصلَح 2026-10-29): كان يُحفظ map(m => m.id)
         فيُسقَط ما فُحص للتو (canGenerate/capabilities). الآن تُحفظ modelsInfo مع
         القدرات، و**يُوصَل pickModel**: إن لم يكن للنظام نموذج محدد بعد، يُختار
         النموذج الافتراضي من القدرات المُثبتة فحصاً — لا من الاسم. */
      const settings = await core.readSettings();
      const providers = Array.isArray(settings.providers) ? settings.providers.slice() : [];
      /* إصلاح 2026-11-13: كان `error` يُسقَط عند الحفظ، فيظهر النموذج «غير قابل
         للاستخدام» بلا سبب. مقيس على مزود حقيقي: GLM-5.3 يرد 429
         model_concurrency (طاقة ممتلئة) لا عطلاً — والمستخدم لا يرى الفرق.
         نحفظ سبباً قصيراً ليُعرض، ويُعاد الفحص لاحقاً. */
      const modelsInfo = (result.models || []).map(m => ({
        id: m.id,
        canGenerate: m.canGenerate === true,
        capabilities: m.capabilities || null,
        probeError: m.canGenerate === true ? null : String(m.error || '').slice(0, 160) || null,
      }));
      // أسعار معلَنة اختيارية (لكل 1000 رمز) — أساس تقدير التكلفة؛ بلا إعلان لا تقدير
      const rawPricing = payload.pricing && typeof payload.pricing === 'object' ? payload.pricing : null;
      const cleanPricing = (() => {
        if (!rawPricing) return null;
        const out = {};
        for (const k of ['inPer1k', 'outPer1k']) {
          const v = Number(rawPricing[k]);
          if (rawPricing[k] !== undefined && rawPricing[k] !== '' && Number.isFinite(v) && v >= 0) out[k] = v;
        }
        return Object.keys(out).length ? out : null;
      })();
      const entry = { name: payload.name, baseUrl: payload.baseUrl, apiKey: effectiveKey, enabled: true, models: modelsInfo.map(m => m.id), modelsInfo };
      if (cleanPricing) entry.pricing = cleanPricing;
      const idx = providers.findIndex(p => p && p.name === payload.name);
      if (idx >= 0) providers[idx] = entry; else providers.push(entry);
      /* التفعيل (إصلاح 2026-11-13): كان النموذج يُختار آلياً متى كان ai.model
         فارغاً — أي أن أول مزود يُضاف يُفعّل نموذجاً **قبل أن يرى المستخدم
         الخيارات**. الآن: النموذج الذي اختاره المستخدم صراحةً هو الذي يُفعّل؛
         والاختيار الآلي يبقى احتياطاً فقط حين لا يختار شيئاً. */
      let autoModel = null;
      const ai = settings.ai || {};
      const wantedModel = String(payload.model || '').trim();
      const wantedOk = wantedModel && modelsInfo.some(m => m.id === wantedModel && m.canGenerate === true);
      let activate = null;
      if (wantedOk) {
        activate = wantedModel;
      } else if (!String(ai.model || '').trim() && modelsInfo.length) {
        // pickModel تحتاج كائنات القدرات (id/canGenerate/capabilities) لا الأسماء النصية
        const pick = gw.pickModel([{ name: payload.name, models: modelsInfo }], 'plan');
        if (pick && pick.model) activate = pick.model;
      }
      if (activate) {
        autoModel = activate;
        /* المزود النشط يُسجَّل بالمُشغِّل الذي يفهمه callModel، لا باسم المزود:
           التوزيع هناك محصور في mock/ollama/openai-compatible، فاسم مثل
           «tokenharbor» كان يجعل كل نداء حي يفشل بـ«مزود غير معروف».
           ويُلزم معه العنوان والمفتاح، وإلا ذهب النداء إلى api.openai.com.
           (عطل ثانٍ أُصلح: كان يستعمل payload.apiKey الفارغ فيمسح المفتاح
           المحفوظ عند التعديل — الآن effectiveKey.) */
        settings.ai = {
          ...ai,
          model: activate,
          provider: 'openai-compatible',
          baseUrl: payload.baseUrl,
          apiKey: effectiveKey,
        };
      }
      await core.saveSettings({ ...settings, providers });
      return json(res, 200, { ...result, maskedKey: gw.maskKey(effectiveKey), autoModel, activated: Boolean(wantedOk) });
    } catch (e) {
      return json(res, 400, { ok: false, step: 'add-provider', error: e.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp/servers') {
    const cfg = await readMcpServers();
    /* حالة الربط لكل خادم (2026-10-30): كان السرد بلا حالة — «وصل أم لا؟» بلا جواب
       في الواجهة. المصدر سجل التدقيق نفسه (connector_discovered) — لا عدّاد موازٍ. */
    const lastTest = {};
    try {
      const db0 = layerDb();
      const rows = db0.prepare("SELECT at, payload FROM audit_log WHERE type='connector_discovered' ORDER BY id DESC LIMIT 80").all();
      for (const r of rows) {
        let p = null; try { p = JSON.parse(r.payload || '{}'); } catch {}
        const id = p && p.targetId;
        if (id && !lastTest[id]) lastTest[id] = { at: r.at, reached: !!p.reached };
      }
    } catch { /* بلا سجل ⇒ لا حالة — لا اختلاق */ }
    const servers = Object.entries(cfg.mcpServers || {}).map(([name, spec]) => ({
      name, command: spec.command || '', args: spec.args || [], allowedTools: spec.allowedTools || [],
      /* ما اكتُشف فعلاً عند الإضافة (2026-11-13): كانت البطاقة تعرض 0 دائماً
         لأن الحقل لم يكن يُحفظ أصلاً. */
      tools: Array.isArray(spec.tools) ? spec.tools : [],
      toolsCount: Array.isArray(spec.tools) ? spec.tools.length : 0,
      verifiedAt: spec.verifiedAt || null,
      exposeToAgent: spec.exposeToAgent !== false,
      lastTest: lastTest[name] || null,
    }));
    return json(res, 200, { servers, count: servers.length });
  }
  /* §29 الاتجاه الثاني (قرار 2026-10-24): إضافة خادم MCP خارجي من الواجهة —
     Cortex يستدعي أدواته، وكل أداة خارجية مسودة دائمة تحتاج اعتماداً (§31). */
  /* إصلاح 2026-11-13: كان «أضف خادماً» يكتب الإعداد فقط — بلا تشغيل ولا اكتشاف.
     فيُحفظ خادم ميت ويظهر «0 أداة» بلا سبب. الآن: فحص قبل الحفظ (نمط المزوّدين):
     تشغيل + مصافحة + tools/list، والفشل يردّ برسالته ولا يكتب شيئاً. */
  if (req.method === 'POST' && url.pathname === '/api/mcp/servers') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const name = String(payload.name || '').trim();
    const command = String(payload.command || '').trim();
    const args = Array.isArray(payload.args) ? payload.args.map((x) => String(x)) : [];
    if (!/^[A-Za-z\u0600-\u06FF][\w.\u0600-\u06FF-]{0,63}$/.test(name)) {
      return json(res, 400, { error: i18n.T('اسم الخادم غير صالح — حروف/أرقام/نقطة/شرطة بلا مسافات', 'Invalid server name — letters/digits/dot/dash only') });
    }
    if (!command) return json(res, 400, { error: i18n.T('command مطلوب', 'command is required') });
    const probe = await probeMcpServer({ name, command, args });
    if (!probe.ok) return json(res, 400, { ok: false, step: probe.step || 'probe', error: probe.error, tools: [] });
    const cfg = await readMcpServers();
    cfg.mcpServers = cfg.mcpServers || {};
    const existed = !!cfg.mcpServers[name];
    cfg.mcpServers[name] = {
      command, args, cwd: '.', timeoutMs: 30000,
      allowedTools: [], tools: probe.tools, verifiedAt: new Date().toISOString(),
    };
    await writeMcpServers(cfg);
    await core.appendAudit({ type: 'mcp_server_added', name, command, args: args.join(' '), updated: existed, tools: probe.tools.length }).catch(() => {});
    return json(res, 200, { ok: true, name, updated: existed, tools: probe.tools });
  }
  /* إلغاء ربط خادم خارجي (2026-10-30): كان الإنشاء بلا حذف — لا مخرج من إدخال خاطئ،
     وطلب المستخدم صراحةً: «ربما أريد إلغاء اتصاله — لا يوجد أي أدوات لذلك». */
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/mcp/servers/')) {
      if (!requireSession(req, res)) return;
    let name = '';
    try { name = decodeURIComponent(url.pathname.slice('/api/mcp/servers/'.length)).trim(); } catch { name = ''; }
    if (!name) return json(res, 400, { error: i18n.T('اسم الخادم مطلوب', 'Server name is required') });
    if (name === 'cortex-memory') return json(res, 403, { error: i18n.T('خادم كورتكس المدمج لا يُحذف — هو أداة «اختبر الاتصال الآن»', 'The built-in Cortex server cannot be removed — it powers “Test the connection now”') });
    const cfgU = await readMcpServers();
    cfgU.mcpServers = cfgU.mcpServers || {};
    if (!cfgU.mcpServers[name]) return json(res, 404, { error: i18n.T(`الخادم غير مسجَّل: ${name}`, `Server is not registered: ${name}`) });
    delete cfgU.mcpServers[name];
    await writeMcpServers(cfgU);
    await core.appendAudit({ type: 'mcp_server_removed', name }).catch(() => {});
    return json(res, 200, { ok: true, name, removed: true });
  }
  /* مفتاح الاتصال العام (2026-10-30): إيقاف/تشغيل استقبال /mcp — «فك الاتصال العام» وإعادته. */
  if (url.pathname === '/api/mcp/incoming') {
    const s1 = await core.readSettings().catch(() => null);
    if (req.method === 'GET') {
      return json(res, 200, { enabled: !(s1 && s1.mcp && s1.mcp.incomingEnabled === false) });
    }
    if (req.method === 'POST') {
      if (!requireSession(req, res)) return;
      const payload = await body(req);
      const enabled = payload.enabled === true;
      await core.saveSettings({ ...(s1 || {}), mcp: { ...((s1 && s1.mcp) || {}), incomingEnabled: enabled } });
      await core.appendAudit({ type: 'mcp_incoming_toggled', enabled }).catch(() => {});
      return json(res, 200, { ok: true, enabled });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/call') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const serverName = String(payload.server || '').trim();
    const toolName = String(payload.tool || '').trim();
    if (!serverName || !toolName) return json(res, 400, { error: i18n.T('server و tool مطلوبان', "server and tool are required") });
    const cfg = await readMcpServers();
    const spec = (cfg.mcpServers || {})[serverName];
    if (!spec || !spec.command) return json(res, 404, { error: i18n.T(`خادم MCP غير مهيّأ: ${serverName}`, `MCP server is not configured: ${serverName}`) });
    // بوابة الصلاحيات: الأداة تُعرَّف بـ mcp__<server>__<tool> بمستوى read دائماً (§31)
    const policyKey = `mcp__${serverName}__${toolName}`;
    const policyMap = toToolPolicy([{ name: serverName, tools: (spec.allowedTools || []).map(n => ({ name: n })) }]);
    const specPolicy = policyMap[policyKey];
    /* §31 + §35: بوابة MCP حقيقية — العطل الأصلي أن `specPolicy` كان يُحسب ثم **يُهمَل**،
       فتمرّ أدوات MCP بلا حكم (نُفِّذ حذف فعلي بلا اعتماد).
       القاعدة: كل أداة MCP مسودة تحتاج اعتماداً صريحاً؛ وحدود الخادم تُفرض. */
    const approvedCall = payload.approved === true;
    /* سياسة MCP تأتي من toToolPolicy نفسها (مستوى read، نطاق mcp، alwaysDraft) —
       فنحكم بـ«هل الأداة معروفة ومصرّح بها؟» ثم نفرض alwaysDraft: كل أداة MCP
       مسودة تحتاج اعتماداً صريحاً (§31). لا نداء بلا حكم ولا بلا أثر في السجل. */
    const allowed = Array.isArray(spec.allowedTools) ? spec.allowedTools : [];
    if (allowed.length && !allowed.includes(toolName)) {
      const dbD = openLayerDb();
      try { createCallLogger(dbD)({ server: serverName, tool: toolName, args: payload.args || {}, ok: false, error: 'not allowed for this server' }, { pending: false }); } catch {}
      return json(res, 403, { error: i18n.T('الأداة غير مصرّح بها لهذا الخادم', "This tool is not allowed for this server"), tool: toolName });
    }
    if (!approvedCall) {
      const pendingFile0 = path.join(core.dataDir, 'mcp-pending.json');
      let pend0 = [];
      try { pend0 = JSON.parse(await fsp.readFile(pendingFile0, 'utf8')); } catch {}
      if (!Array.isArray(pend0)) pend0 = [];
      pend0.push({ at: new Date().toISOString(), server: serverName, tool: toolName, args: payload.args || {}, policy: policyKey });
      await fsp.writeFile(pendingFile0, JSON.stringify(pend0.slice(-50), null, 2), 'utf8').catch(() => {});
      const dbP0 = openLayerDb();
      try { createCallLogger(dbP0)({ server: serverName, tool: toolName, args: payload.args || {}, ok: false, needsApproval: true, level: 'read' }); } catch {}
      return json(res, 202, {
        ok: false, needsApproval: true, tool: toolName, server: serverName, policy: policyKey,
        message: i18n.T('أداة MCP مسجّلة كمسودة — أعد الإرسال بـ approved:true للتنفيذ', "MCP tool registered as draft — resend with approved:true to execute"),
      });
    }
    // أدوات MCP كافة تسجّل مسودة وتنتظر اعتماداً صريحاً (§31)
    // (كُتلة ثانية مطابقة أُزيلت 2026-10-25: كانت **كوداً ميتاً** — الكتلة أعلاه تُرجع دائماً.)
    const client = new McpClient({
      name: serverName, command: spec.command, args: spec.args || [], env: spec.env || {},
      cwd: spec.cwd || PROJECT_ROOT, timeoutMs: Number(spec.timeoutMs) || 8000,
      allowedTools: spec.allowedTools || []
    });
    let out;
    try {
      client.start();
      const init = await client.initialize();
      if (init && init.error) throw new Error(init.error);
      out = await client.callTool(toolName, payload.args || {});
    } catch (e) {
      out = { ok: false, error: e.message };
    } finally {
      // كل start له stop مضمون — لا عملية فرعية معلّقة
      try { await client.stop({ graceMs: 1500 }); } catch {}
    }
    // إغلاق صريح للأنبوب على ويندوز: نضمن عدم بقاء مقبض مفتوح
    try { if (client.child && client.child.killed === false) client.child.kill(); } catch {}
    const ok = !!(out && out.ok);
    // كل نداء يُسجَّل في mcp_calls — نجاحاً وفشلاً؛ لا نداء بلا أثر في السجل (§30)
    const db = openLayerDb();
    try {
      createCallLogger(db)({
        policy: specPolicy ? specPolicy.level + ':' + specPolicy.scope : 'unknown',
        approved: approvedCall,
        server: serverName, tool: toolName, args: payload.args || {}, ok,
        result: ok ? { clean: out.clean } : { clean: (out && out.error) || i18n.T('فشل استدعاء الأداة', "Tool call failed") },
        changedFiles: (out && out.changedFiles) || [], needsApproval: !!(out && out.needsApproval)
      });
    } finally { /* اتصال مشترك: لا يُغلق */ }
    if (!ok) {
      return json(res, 502, { ok: false, server: serverName, tool: toolName, policyKey, error: (out && out.error) || i18n.T('فشل استدعاء الأداة', "Tool call failed"), clean: out && out.clean });
    }
    return json(res, 200, { ok: true, server: serverName, tool: toolName, policyKey, level: specPolicy?.level || 'read', clean: out.clean, stripped: out.stripped, changedFiles: out.changedFiles || [], needsApproval: !!out.needsApproval });
  }
  /* ── الاتصال العام (2026-10-30): MCP عبر HTTP على عنوان واحد ──
     أي نظام يدعم MCP عن بُعد يتصل بـ POST http://127.0.0.1:<port>/mcp — بلا مسارات
     ملفات ولا صيغ خاصة بكل عميل. محلي فقط (الخادم لا يستمع إلا على 127.0.0.1)،
     والنمط JSON بلا جلسات (stateless) وبلا بث SSE من الخادم.
     ملاحظة أمنية بنيوية: POST بـ Content-Type: application/json يستلزم preflight
     من المتصفحات ⇒ صفحة ويب عشوائية لا تستطيع استدعاءه (حماية CSRF بلا رمز إضافي). */
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') {
      return json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: i18n.T('يُقبل POST فقط على /mcp', 'Only POST is accepted on /mcp') } });
    }
    /* مفتاح الاستقبال (2026-10-30): متى أُوقف من النافذة يُرفض الوافدون فوراً —
       هذا هو «فك الاتصال العام» الحقيقي: لا نصّاً بلا أداة. */
    let _st = null; try { _st = await core.readSettings(); } catch { /* بلا إعدادات ⇒ مفتوح */ }
    if (_st && _st.mcp && _st.mcp.incomingEnabled === false) {
      return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: i18n.T('استقبال MCP متوقف — شغّله من نافذة MCP في كورتكس', 'MCP incoming is stopped — enable it from the Cortex MCP panel') } });
    }
    /* هوية الوافد (تدقيق 2026-11-11): إمّا جلسة الواجهة (كوكي/ترويسة) أو رمز MCP
       المخصّص في `Authorization: Bearer`. الرمز يُعرض داخل الإعداد المنسوخ، فيبقى
       ربط الوكلاء الخارجيين بنقرة — ويتوقف أن تكتب أي عملية محلية بلا هوية. */
    if (!sessionOk(req) && !mcpTokenOk(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="cortex-mcp"');
      return json(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: i18n.T('ترويسة مفقودة: أرسل Authorization: Bearer <رمز MCP> — انسخ الإعداد من نافذة MCP', 'Missing credentials: send Authorization: Bearer <MCP token> — copy the config from the MCP panel') } });
    }
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: i18n.T('جسم الطلب ليس JSON صالحًا', 'Request body is not valid JSON') } }); }
    try {
      const messages = Array.isArray(payload) ? payload : [payload];
      const out = [];
      /* الوضع الافتراضي قراءة فقط (2026-11-15): أي وكيل خارجي يقرأ ولا يكتب
         حتى يُفعَّل خلاف ذلك من إعدادات MCP. */
      const readOnly = !(_st && _st.mcp && _st.mcp.readOnly === false);
      for (const m of messages) { const r0 = await mcpCore.handle(m, { readOnly }); if (r0) out.push(r0); }
      // أثر الاتصال الوارد: سطر واحد لكل طلب — يُغذّي «آخر اتصال وارد» في النافذة (2026-10-30)
      if (messages.length) writeAudit('mcp_http_call', { method: (messages[0] && messages[0].method) || null });
      if (!out.length) { res.writeHead(202); return res.end(); }
      return json(res, 200, Array.isArray(payload) ? out : out[0]);
    } catch (e) {
      return json(res, 200, { jsonrpc: '2.0', id: (payload && payload.id) || null, error: { code: -32603, message: e.message } });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/tasks') {
    const runId = String(url.searchParams.get('runId') || '').trim();
    if (!runId) return json(res, 400, { error: i18n.T('runId مطلوب', "runId is required") });
    const db = openLayerDb();
    try {
      const store = orc.createStore(db);
      return json(res, 200, { runId, tasks: store.listTasks(runId), events: store.events(runId) });
    } finally { /* اتصال مشترك: لا يُغلق */ }
  }
  // ── قائمة تشغيلات المنسّق ──
  if (req.method === 'GET' && url.pathname === '/api/agent/runs') {
    const db = openLayerDb();
    try {
      const rows = db.prepare(`
        SELECT run_id AS runId,
               COUNT(*) AS tasks,
               SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
               SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
               MIN(created_at) AS startedAt,
               MAX(COALESCE(finished_at, started_at, created_at)) AS endedAt
        FROM agent_tasks GROUP BY run_id ORDER BY MIN(rowid) DESC LIMIT 50
      `).all();
      return json(res, 200, { runs: rows });
    } catch (e) {
      return json(res, 200, { runs: [], note: e.message });
    }
  }

  // ── تقرير المراقب الصارم لتشغيل ──
  if (req.method === 'GET' && url.pathname === '/api/agent/monitor') {
    const runId = String(url.searchParams.get('runId') || '').trim();
    const db = openLayerDb();
    try {
      const store = orc.createStore(db);
      const tasks = runId ? store.listTasks(runId) : [];
      const events = runId ? store.events(runId) : [];
      if (!runId) {
        // بلا runId: نلخّص آخر تشغيل تلقائياً — فلا تبقى اللوحة فارغة
        const last = db.prepare('SELECT run_id FROM agent_tasks ORDER BY rowid DESC LIMIT 1').get();
        if (!last) {
          return json(res, 200, { verdict: 'empty', steps: 0, done: 0, failed: 0, blocked: 0, successRate: 0, avgDurationMs: 0, peakConcurrency: 0, objections: [], tasks: [], reasons: {} });
        }
        const t2 = store.listTasks(last.run_id);
        const e2 = store.events(last.run_id);
        return json(res, 200, { runId: last.run_id, ...monitorMod.report({ events: e2, tasks: t2 }) });
      }
      return json(res, 200, { runId, ...monitorMod.report({ events, tasks }) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/orchestrate') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const goal = String(payload.goal || '').trim();
    if (!goal) return json(res, 400, { error: i18n.T('أعطِ المنسّق هدفاً', "Give the orchestrator a goal") });
    const db = openLayerDb();
    const stream = payload.stream === true;
    try {
      const store = orc.createStore(db);
      // subCtx يحمل الدور والصلاحيات، و subCtx.emit هو قناة الأثر التي زرعها المنسّق.
      // تمرير null مكان emit كان يُهدر كل أثر الأدوات فيبدو التشغيل «بلا أدلة» (عطل مؤكد).
      const runAgent = async (taskGoal, subCtx) => agent.run(
        { goal: taskGoal, project: String(payload.project || '').trim(),
          // §33: الوضع من الإعدادات لا من الحمولة
          autonomy: String((await core.readSettings())?.agent?.autonomy || 'supervised') },
        (subCtx && typeof subCtx.emit === 'function') ? subCtx.emit : null,
        subCtx || {}
      );

      if (stream) {
        // بثّ حيّ: كل حدث من المنسّق يُرسل فوراً — يرى المستخدم كل دور يعمل لحظياً
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* العميل أغلق */ } };
        const orchestrator = new orc.Orchestrator({
          store, runAgent,
          maxParallel: clampParallel(payload.maxParallel),
          onEvent: (ev) => send({ type: 'orc_event', event: ev })
        });
        try {
          const out = await orchestrator.run(goal);
          send({ type: 'orc_done', runId: out.runId, tasks: out.tasks, verified: out.verified, summary: out.summary });
        } catch (e) {
          send({ type: 'orc_error', error: e.message });
        }
        res.end();
        return;
      }

      const orchestrator = new orc.Orchestrator({ store, runAgent, maxParallel: clampParallel(payload.maxParallel) });
      const out = await orchestrator.run(goal);
      return json(res, 200, { runId: out.runId, tasks: out.tasks, verified: out.verified, summary: out.summary });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  /* إعداد الربط الجاهز للنسخ (2026-11-15): كان المستخدم يخمّن العنوان والرمز.
     الآن: سطر واحد لأي عميل، ووضع قراءة فقط افتراضي. */
  if (req.method === 'GET' && url.pathname === '/api/mcp/config') {
      if (!requireSession(req, res)) return;
    const st = await core.readSettings();
    const readOnly = !(st && st.mcp && st.mcp.readOnly === false);
    const token = ensureMcpToken();
    const host = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    const urlMcp = `http://${host}:${PORT}/mcp`;
    const auth = `Bearer ${token}`;
    return json(res, 200, {
      ok: true,
      url: urlMcp,
      token,
      readOnly,
      claude: `claude mcp add --transport http cortex ${urlMcp} --header "Authorization: ${auth}"`,
      json: { mcpServers: { cortex: { type: 'http', url: urlMcp, headers: { Authorization: auth } } } },
      note: i18n.T('قراءة فقط افتراضياً — فعّل الكتابة من المفتاح أدناه.', 'Read-only by default — enable writes with the switch below.'),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/settings') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const readOnly = payload.readOnly !== false;
    const st = await core.readSettings();
    st.mcp = { ...(st.mcp || {}), readOnly };
    await core.saveSettings(st);
    await core.appendAudit({ type: 'mcp_readonly_changed', readOnly }).catch(() => {});
    return json(res, 200, { ok: true, readOnly });
  }

  if (req.method === 'GET' && url.pathname === '/api/mcp-info') {
    const s0 = await core.readSettings().catch(() => null);
    const httpIncomingOn = !(s0 && s0.mcp && s0.mcp.incomingEnabled === false);
    return json(res, 200, {
      server: 'cortex-memory',
      command: 'node',
      args: ['mcp-memory-server.js', '--root', WORK_ROOT],
      tools: MCP_TOOLS.map(t => t.name),
      /* وضع الوصول الفعلي (2026-11-15): القائمة الكاملة أعلاه مصدر الحقيقة،
         وهذا الحقل يقول ما يُقدَّم فعلاً لوافد الآن. */
      readOnly: !(s0 && s0.mcp && s0.mcp.readOnly === false),
      vaultDir: core.vaultDir,
      retrieval: await core.getRetrievalStatus(),
      /* اتصال HTTP الموثّق (تدقيق 2026-11-11): الرمز يُعرض هنا ليكون الربط بنقرة.
         هذه النقطة محمية بالجلسة (SIDE_EFFECT_READS) كي لا يقرأ الرمزَ أصلٌ آخر. */
      http: {
        url: `http://127.0.0.1:${PORT}/mcp`,
        headers: { Authorization: `Bearer ${ensureMcpToken()}` },
      },
      /* آخر اتصال وارد عبر /mcp (2026-10-30): «مرتبط أم لا؟» مرئي من الواجهة —
         من سطر التدقيق نفسه، بلا عدّاد مواز. */
      mcpHttp: {
        lastAt: (() => {
          try {
            const r0 = layerDb().prepare("SELECT at FROM audit_log WHERE type='mcp_http_call' ORDER BY id DESC LIMIT 1").get();
            return r0 ? r0.at : null;
          } catch { return null; }
        })(),
        /* مفتاح الاستقبال (2026-10-30): «إيقاف/تشغيل» من النافذة — حالة مرئية حقيقية */
        enabled: httpIncomingOn,
      },
    });
  }
  // ═══════════════════════════════════════════════════════════════════
  //  نقاط الحُكم والامتثال — كل مادة دستورية لها سطح ظاهر هنا.
  //  الوحدات تُحمَّل بتسامح: غياب وحدة لا يُسقط الخادم ولا يُوهم بنجاح.
  // ═══════════════════════════════════════════════════════════════════
  const opt = optMod;
  const entityIsNote = (e) => e === 'note' || e === undefined || e === null;

  // §38: التراجع الفعلي عن تغيير
  if (req.method === 'POST' && url.pathname === '/api/rollback/revert') {
      if (!requireSession(req, res)) return;
    const r = opt('cortex-rollback'); const db = layerDb();
    if (!r || !db) return json(res, 503, { error: i18n.T('وحدة التراجع غير متاحة', "Rollback module unavailable") });
    const payload = await body(req);
    // دالة التطبيق الحقيقية: تُعيد العنصر إلى حالته السابقة في المخزن.
    const apply = async (beforeState) => {
      if (!beforeState) return { applied: false, reason: i18n.T('لا حالة سابقة (عملية إنشاء)', "No prior state (create operation)") };
      if (entityIsNote(payload.entity)) {
        await core.saveNote({ ...beforeState, id: beforeState.id });
        return { applied: true };
      }
      return { applied: false, reason: `كيان غير مدعوم: ${payload.entity}` };
    };
    const out = r.revert(db, Number(payload.id), { actor: payload.actor || 'user', apply });
    notifyWatch('rollback');
    return json(res, out.ok ? 200 : 400, { ...out, entity: payload.entity || 'note' });
  }

  // §38: إثبات التراجع عملياً (بوابة إلزامية لمنع الإطلاق)
  if (req.method === 'POST' && url.pathname === '/api/rollback/verify') {
      if (!requireSession(req, res)) return;
    const r = opt('cortex-rollback'); const db = layerDb();
    if (!r || !db) return json(res, 503, { error: i18n.T('وحدة التراجع غير متاحة', "Rollback module unavailable") });
    const out = r.verifyRollback(db, {});
    return json(res, 200, out);
  }

  // §7: اشتقاق العلاقات من الواقع (استيرادات + تصنيف + إشارات نصية)
  if (req.method === 'POST' && url.pathname === '/api/relations/infer') {
      if (!requireSession(req, res)) return;
    const rel = opt('cortex-relations'); const db = layerDb();
    if (!rel || !db) return json(res, 503, { error: i18n.T('وحدة العلاقات غير متاحة', "Relations module unavailable") });
    const out = await runRelationsInfer('manual');
    return json(res, 200, { ...out, coverage: rel.coverage(db) });
  }

  // §12 + §15/6: الاستهلاك وسجل الاتصالات
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const p = privacyMod; const db = layerDb();
    if (!p || !db || !p.usageSummary) {
      return json(res, 503, { error: i18n.T('وحدة الخصوصية غير متاحة', "Privacy module unavailable"), note: i18n.T('لا يوجد تسجيل استهلاك', "No usage records") });
    }
    return json(res, 200, p.usageSummary(db, { since: url.searchParams.get('since') || undefined }));
  }
  if (req.method === 'GET' && url.pathname === '/api/connections') {
    const p = privacyMod; const db = layerDb();
    if (!p || !db || !p.connectionHistory) return json(res, 503, { error: i18n.T('وحدة الخصوصية غير متاحة', "Privacy module unavailable") });
    return json(res, 200, { items: p.connectionHistory(db, { limit: Number(url.searchParams.get('limit')) || 50 }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/privacy/notice') {
    const p = privacyMod;
    if (!p || !p.privacyNotice) return json(res, 503, { error: i18n.T('وحدة الخصوصية غير متاحة', "Privacy module unavailable") });
    const settings = await core.readSettings();
    return json(res, 200, {
      provider: settings.ai?.provider || 'mock',
      baseUrl: settings.ai?.baseUrl || settings.ai?.openaiBaseUrl || '',
      // §«القالب يولّد بلغة الطلب»: يُمرَّر lang صراحةً (نفس نمط resolveAgentLang)
      notice: p.privacyNotice(settings.ai?.provider || 'mock', url.searchParams.get('dataClass') || 'knowledge', resolveAgentLang(settings, url.searchParams.get('lang'))),
      policy: p.defaultPolicy ? p.defaultPolicy() : null,
    });
  }

  // §42 + §43: آلة المراحل
  if (req.method === 'GET' && url.pathname === '/api/stages') {
    const g = opt('cortex-gates'); const db = layerDb();
    if (!g || !db) return json(res, 503, { error: i18n.T('وحدة البوابات غير متاحة', "Gates module unavailable") });
    return json(res, 200, g.evaluateStage(db, i18n.lang()));
  }
  if (req.method === 'POST' && url.pathname === '/api/stages/prove') {
      if (!requireSession(req, res)) return;
    const g = opt('cortex-gates'); const db = layerDb();
    if (!g || !db) return json(res, 503, { error: i18n.T('وحدة البوابات غير متاحة', "Gates module unavailable") });
    const payload = await body(req);
    /* إصلاح 2026-11-12: كان الإثبات يقبل أي دليل نصّي ويُعلن «proven» بلا فحص
       البوابات المرتبطة بالمرحلة. القياس: 7/8 مراحل proven وno_privilege_escape
       فاشلة. الآن: لا إثبات وبوابة حمراء أو غائبة أو أقدم من 30 يوماً. */
    const stageKey = String(payload.stage || '');
    const required = (require('./cortex-schema').STAGE_GATE_REQUIREMENTS || {})[stageKey] || [];
    if (required.length) {
      const latest = latestGateResults(db);
      const STALE_MS = 30 * 24 * 60 * 60 * 1000;
      const blocked = required.map(key => {
        const r = latest[key];
        if (!r) return { key, state: 'missing', detail: i18n.T('لم تُقيَّم قط', 'never evaluated') };
        const age = Date.now() - Date.parse(r.at || 0);
        if (!Number.isFinite(age) || age > STALE_MS) return { key, state: 'stale', detail: r.at || '' };
        if (Number(r.passed) !== 1) return { key, state: 'failed', detail: r.detail || '' };
        return null;
      }).filter(Boolean);
      if (blocked.length) {
        return json(res, 400, {
          ok: false, code: 'GATES_NOT_GREEN', stage: stageKey,
          error: i18n.T(
            `لا إثبات للمرحلة «${stageKey}» قبل أن تجُز بواباتها: ${blocked.map(b => `${b.key}(${b.state})`).join('، ')} — دستور §45`,
            `Stage "${stageKey}" cannot be proven before its gates pass: ${blocked.map(b => `${b.key}(${b.state})`).join(', ')} — constitution §45`),
          blocked,
        });
      }
    }
    const out = g.proveStage(db, stageKey, { evidence: payload.evidence || {} });
    return json(res, out.ok ? 200 : 400, out);
  }

/* مسبار التراجع الفعلي (م45/7): يكتب على صفّ حقيقي ثم يتراجع ويتحقق بالقراءة.
   كان معرَّفاً داخل `/api/gates/check` وحده، فالتقييم التلقائي يرى «لم يُقدَّم
   دليل التراجع» أبداً (عطل مقيس 2026-11-15). الآن مصدر واحد يخدم الزر والتلقائي. */
function rollbackProbe(db, rollbackMod) {
  return () => {
    try {
      const probeId = `__rollback_probe_${Date.now()}`;
      db.prepare("INSERT OR IGNORE INTO agent_tasks(id, run_id, role, goal, status) VALUES (?,?,?,?,?)")
        .run(probeId, '__probe', 'verifier', 'إثبات التراجع الحتمي', 'queued');
      const read = () => ({ __original: db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(probeId)?.status });
      const apply = (state) => {
        if (state && state.__cortex_rollback_probe__ === true) {
          db.prepare('UPDATE agent_tasks SET status = ? WHERE id = ?').run('running', probeId);
          return { applied: true };
        }
        if (state && state.__original !== undefined) {
          db.prepare('UPDATE agent_tasks SET status = ? WHERE id = ?').run(state.__original, probeId);
          return { applied: true };
        }
        return { applied: false, reason: i18n.T('حالة غير مفهومة', 'Unrecognized state') };
      };
      const proof = rollbackMod.verifyRollback(db, { entity: 'agent_task', entityId: probeId, read, apply });
      try { db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(probeId); } catch { /* لا يُفشل الإثبات */ }
      return {
        passed: !!proof.proven,
        detail: proof.proven ? i18n.T('أُثبت التراجع عملياً على عنصر حقيقي', 'Rollback proven on a real item') : `تعذّر إثبات التراجع: ${proof.error || i18n.T('غير معروف', 'unknown')}`,
        evidence: { steps: proof.steps?.length || 0, error: proof.error || null },
      };
    } catch (e) { return { passed: false, detail: `فشل إثبات التراجع: ${e.message}`, evidence: {} }; }
  };
}
/* مسبار الاستعادة (§36): يُعيد المهام العالقة فعلاً ثم يتحقق بالقراءة. */
function recoveryProbe(db, store) {
  return () => {
    try {
      const rows = db.prepare("SELECT id, run_id, status FROM agent_tasks WHERE status IN ('running','blocked')").all();
      if (!rows.length) return { passed: true, detail: i18n.T('لا مهام عالقة — لا شيء يحتاج استعادة', 'No stuck tasks — nothing to recover'), evidence: { stuck: 0 } };
      if (!store || typeof store.requeuePending !== 'function') {
        return { passed: false, detail: i18n.T('لا مسار استعادة: requeuePending غير متاح', 'No recovery path: requeuePending unavailable'), evidence: { stuck: rows.length } };
      }
      const runId = rows[0].run_id;
      const before = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE run_id = ? AND status IN ('running','blocked')").get(runId).n;
      const out2 = store.requeuePending(runId);
      const after = db.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE run_id = ? AND status IN ('running','blocked')").get(runId).n;
      const proven = before > 0 && after === 0;
      return {
        passed: proven,
        detail: proven
          ? (i18n.lang() === 'en'
            ? `Recovery proven by read-back: ${out2.requeued} task(s) requeued in run ${runId}`
            : `استعادة مُثبتة بالقراءة: ${out2.requeued} مهمة صارت queued في التشغيل ${runId}`)
          : `الاستعادة غير مُثبتة: قبل=${before} بعد=${after}`,
        evidence: { runId, before, after, requeued: out2.requeued },
      };
    } catch (e) { return { passed: false, detail: `فشل إثبات الاستعادة: ${e.message}`, evidence: {} }; }
  };
}

/* نضارة بوابات الإطلاق: تقييم أقدم من ساعة لا يُعرض كأنه «الآن».
   السبب المقيس (2026-11-15): آخر تقييم كان قبل يومين، و`releaseAllowed:true`
   يُعرض صفر إعادة قياس. القيمة قابلة للضبط بـCORTEX_GATES_MAX_AGE_MS. */
const GATES_MAX_AGE_MS = (() => {
  const raw = Number(process.env.CORTEX_GATES_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();
/* يُعيد تقييم البوابات إن كان أحدث تقييم أقدم من الحد. مُسبِّر (single-flight)
   كي لا تتزاحم عدة طلبات على السلسلة نفسها. لا يُقيَّم في وضع الاختبار المحايد
   إلا عند الطلب (لا مؤقّتات خلفية تُبطئ الاختبارات). */
let gatesRefreshInFlight = null;
async function refreshGatesIfStale(g, db) {
  const latest = latestGateResults(db);
  const ages = Object.values(latest).map(r => Date.parse(r.at || 0)).filter(Number.isFinite);
  const newest = ages.length ? Math.max(...ages) : 0;
  const isStale = !newest || (Date.now() - newest) > GATES_MAX_AGE_MS;
  if (!isStale) return { refreshed: false };
  if (gatesRefreshInFlight) return gatesRefreshInFlight;
  gatesRefreshInFlight = (async () => {
    try {
      /* عطل مقيس 2026-11-15: كان يُنادى `checkGates(db)` بلا store ولا مسبار تراجع،
         فتفشل بوابتان دائماً: tasks_recoverable («requeuePending غير متاح») و
         rollback_proven («لم يُقدَّم دليل التراجع»). القاعدة: التقييم التلقائي
         يقيس ما يقيسه الزر اليدوي — نفس المسبارَين، مصدر واحد. */
      const rb = optMod('cortex-rollback');
      const probes = { tasks_recoverable: recoveryProbe(db, core.store || null) };
      if (rb && typeof rb.verifyRollback === 'function') probes.rollback_proven = rollbackProbe(db, rb);
      await g.checkGates(db, probes);
      await core.appendAudit({ type: 'gates_refreshed', reason: 'stale', maxAgeMs: GATES_MAX_AGE_MS, probes: Object.keys(probes) }).catch(() => {});
      return { refreshed: true };
    } catch (e) {
      console.error('[Cortex] تعذّر تجديد البوابات:', e && e.message);
      return { refreshed: false, error: String(e && e.message) };
    } finally {
      gatesRefreshInFlight = null;
    }
  })();
  return gatesRefreshInFlight;
}

  // §45: بوابات منع الإطلاق
  if (req.method === 'GET' && url.pathname === '/api/gates') {
    const g = opt('cortex-gates'); const db = layerDb();
    if (!g || !db) return json(res, 503, { error: i18n.T('وحدة البوابات غير متاحة', "Gates module unavailable") });
    /* نضارة البوابات (عطل مقيس 2026-11-15): كان العرض يقرأ **آخر تقييم مسجَّل**
       بلا حدّ عمر، ولا أحد يعيد التقييم تلقائياً ⇒ `releaseAllowed:true` من لقطة
       عمرها يومان، وبوابة `backup_restorable` تصف نسخة عمرها 3 أيام بينما الخزنة
       تغيّرت. القاعدة الآن: العرض يعيد التقييم إن تجاوز عمره GATES_MAX_AGE_MS،
       ويُعلن لكل بوابة عمرها ودرجة نضارتها — فلا يُقرأ «أخضر» على أنه «الآن». */
    await refreshGatesIfStale(g, db);
    /* إصلاح 2026-11-12: كان يُرجع **كتالوج التعريفات فقط** بلا حالة، فتُظهر
       الواجهة «لم يُفحص» أبداً ولو كانت البوابة فاشلة في القاعدة. الآن كل بوابة
       تحمل حالتها من آخر تقييم مسجَّل. */
    const latest = latestGateResults(db);
    const defs = g.RELEASE_GATES || require('./cortex-schema').RELEASE_GATES || [];
    const now = Date.now();
    const gates = defs.map(d => {
      const r = latest[d.key];
      const at = r && r.at ? r.at : null;
      const ageMs = at ? now - Date.parse(at) : null;
      const fresh = ageMs !== null && Number.isFinite(ageMs) && ageMs <= GATES_MAX_AGE_MS;
      return Object.assign({}, d, r
        ? { passed: Number(r.passed) === 1, status: Number(r.passed) === 1 ? 'pass' : 'fail', at, detail: r.detail || null, checked: true, ageMs, fresh }
        : { passed: null, status: 'unchecked', at: null, detail: null, checked: false, ageMs, fresh: false });
    });
    const red = gates.filter(x => x.passed === false).length;
    const unchecked = gates.filter(x => x.passed === null).length;
    const stale = gates.filter(x => x.checked && !x.fresh).length;
    return json(res, 200, {
      gates, history: g.history(db, 20),
      summary: {
        total: gates.length, green: gates.filter(x => x.passed === true).length, red, unchecked,
        stale, fresh: gates.filter(x => x.fresh).length, maxAgeMs: GATES_MAX_AGE_MS,
        /* لا يُسمح بالإطلاق على تقييم قديم: النضارة جزء من الحكم لا زينة. */
        releaseAllowed: red === 0 && unchecked === 0 && stale === 0,
      },
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/gates/check') {
      if (!requireSession(req, res)) return;
    const g = opt('cortex-gates'); const r = opt('cortex-rollback'); const db = layerDb();
    if (!g || !db) return json(res, 503, { error: i18n.T('وحدة البوابات غير متاحة', "Gates module unavailable") });
    /* المسبارين صارا مصدراً واحداً (server.js: rollbackProbe/recoveryProbe) —
       نفس ما يستخدمه التقييم التلقائي، فلا بوابتان بمسارين. */
    const store = core.store || null;
    const probes = { tasks_recoverable: recoveryProbe(db, store) };
    if (r && typeof r.verifyRollback === 'function') probes.rollback_proven = rollbackProbe(db, r);
    /* §42/§21: بوابة «لا تجاوز صلاحيات» كانت تفشل بلا إثبات: 59 صفاً حجراً
       لم يُمسح أيٌّ منها (scanned=0) لأن وحدة الحجر تُنشئ الحجر ولا تُشغّل
       الفحص. هنا نُشغّل `guard.scan` فعلياً بقارئ حقيقي مقرون بـ`guardPath`
       (لا fs مباشر، لا eval)، ثم نُعيد قياس الصفوف غير الممسوحة بالقراءة. */
    probes.no_privilege_escape = async () => {
      const gd = optMod('cortex-guard');
      if (!gd || typeof gd.scan !== 'function') {
        return { passed: false, detail: i18n.T('وحدة الحجر غير متاحة — لا يمكن إثبات المسح', "Quarantine module unavailable — cannot prove clearing"), evidence: {} };
      }
      const rootDir = core.root;
      const rootNorm = String(rootDir).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const reader = async (p) => {
        const abs = path.resolve(String(p));
        // قارئ محدود: قراءة داخل جذر المشروع فقط، وبلا تنفيذ
        const absNorm = abs.replace(/\\/g, '/').toLowerCase();
        if (!absNorm.startsWith(rootNorm + '/')) throw new Error('مسار خارج جذر المشروع');
        return fsp.readFile(abs);
      };
      const pending = db.prepare(
        "SELECT id FROM quarantine WHERE (scanned IS NULL OR scanned=0) AND (cleared IS NULL OR cleared=0) LIMIT 60"
      ).all().map((r) => r.id);
      const errors = [];
      let scanned = 0;
      for (const id of pending) {
        try {
          // scan دالة async: بلا await ينتهي المسبار والكتابة لم تُنجز بعد
          await gd.scan(db, id, { reader });
          scanned += 1;
        } catch (e) { errors.push({ id, error: e.message }); }
      }
      const after = db.prepare(
        "SELECT COUNT(*) AS n FROM quarantine WHERE (scanned IS NULL OR scanned=0) AND (cleared IS NULL OR cleared=0)"
      ).get().n;
      const critAfter = db.prepare(
        "SELECT COUNT(*) AS n FROM quarantine WHERE (scanned IS NULL OR scanned=0) AND (cleared IS NULL OR cleared=0) AND severity='critical'"
      ).get().n;
      const passed = critAfter === 0;
      return {
        passed,
        detail: passed
          ? i18n.T(`لا تجاوز: مُسح ${scanned}/${pending.length} صفاً، لا ملف حرج غير ممسوح (باقٍ ${after} إجمالاً)`, `No overreach: scanned ${scanned}/${pending.length} row(s); no critical unscanned file (${after} remaining overall)`)
          : i18n.T(`تجاوز صلاحيات: ${critAfter} ملف حرج غير ممسوح${errors.length ? `، ${errors.length} خطأ قراءة` : ''}`, `Privilege overreach: ${critAfter} critical unscanned file(s)${errors.length ? `, ${errors.length} read error(s)` : ''}`),
        evidence: { pending: pending.length, scanned, remaining: after, criticalRemaining: critAfter, errors: errors.slice(0, 5) },
      };
    };
    const out = await g.checkGates(db, probes);
    return json(res, 200, out);
  }

  // §37 + §21: الحجر والفحص المحدود
  if (req.method === 'GET' && url.pathname === '/api/quarantine') {
    const q = opt('cortex-guard'); const db = layerDb();
    if (!q || !db) return json(res, 503, { error: i18n.T('وحدة الحجر غير متاحة', "Quarantine module unavailable") });
    return json(res, 200, { items: q.list(db, { onlyOpen: url.searchParams.get('all') !== '1' }), stats: q.stats(db) });
  }
  if (req.method === 'POST' && url.pathname === '/api/quarantine/assess') {
      if (!requireSession(req, res)) return;
    const q = opt('cortex-guard');
    if (!q || !q.assess) return json(res, 503, { error: i18n.T('وحدة الحجر غير متاحة', "Quarantine module unavailable") });
    const payload = await body(req);
    return json(res, 200, q.assess(String(payload.content || ''), { path: String(payload.path || '') }));
  }
  if (req.method === 'POST' && url.pathname === '/api/quarantine/clear') {
      if (!requireSession(req, res)) return;
    const q = opt('cortex-guard'); const db = layerDb();
    if (!q || !db) return json(res, 503, { error: i18n.T('وحدة الحجر غير متاحة', "Quarantine module unavailable") });
    const payload = await body(req);
    // الوحدة ترمي عند سبب فارغ؛ نقطة الوصل تُحوّل الرمي إلى رد واضح لا إلى 500.
    try {
      const out = q.clear(db, Number(payload.id), { by: payload.by || 'user', reason: String(payload.reason || '') });
      return json(res, out && out.ok ? 200 : 400, out || { ok: false, error: i18n.T('لم يُرفع الحجر', "Quarantine was not lifted") });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // §26 + §23/11: التقييم الذاتي ودورة التحسين
  if (req.method === 'GET' && url.pathname === '/api/improve') {
    const im = opt('cortex-improve'); const db = layerDb();
    if (!im || !db) return json(res, 503, { error: i18n.T('وحدة التحسين غير متاحة', "Improvement module unavailable") });
    // lang يُمرَّر: عناوين المقترحات ومعايير القبول تُولَّد بلغة القارئ من المصدر
    return json(res, 200, { evaluation: im.evaluate(db, { scope: url.searchParams.get('scope') || 'system', lang: resolveAgentLang(await core.readSettings(), url.searchParams.get('lang')) }), history: im.history(db, 20) });
  }
  if (req.method === 'POST' && url.pathname === '/api/improve/decide') {
      if (!requireSession(req, res)) return;
    const im = opt('cortex-improve'); const db = layerDb();
    if (!im || !db) return json(res, 503, { error: i18n.T('وحدة التحسين غير متاحة', "Improvement module unavailable") });
    const payload = await body(req);
    const out = im.decide(db, Number(payload.id), { accept: !!payload.accept, by: payload.by || 'user' });
    return json(res, out.ok ? 200 : 400, out);
  }
  /* إصلاح 2026-11-13 (حلقة ميتة مقيسة: improvement_trials = 0 صف بينما الوحدة
     كاملة: evaluate + plan + runTrial + decide + markApplied). السبب: **لا مسار
     HTTP يُنشئ تجربة** — الوحدة تصدّر plan/runTrial ولا يستدعيهما أحد، فبقيت
     الحلقة نصف مبنية: تقرأ وتقرّر على تجارب لا وجود لها.
     الآن: plan يُنشئ مقترحات بتجارب مسجّلة، وtrial يقيسها بقراءة محضة. */
  if (req.method === 'POST' && url.pathname === '/api/improve/plan') {
      if (!requireSession(req, res)) return;
    const im = opt('cortex-improve'); const db = layerDb();
    if (!im || !db) return json(res, 503, { error: i18n.T('وحدة التحسين غير متاحة', "Improvement module unavailable") });
    const payload = await body(req);
    try {
      const out = im.plan(db, { scope: payload.scope || 'system' });
      return json(res, 200, out);
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/improve/trial') {
      if (!requireSession(req, res)) return;
    const im = opt('cortex-improve'); const db = layerDb();
    if (!im || !db) return json(res, 503, { error: i18n.T('وحدة التحسين غير متاحة', "Improvement module unavailable") });
    const payload = await body(req);
    const id = Number(payload.id);
    if (!Number.isFinite(id)) return json(res, 400, { ok: false, error: i18n.T('id التجربة مطلوب', 'Trial id is required') });
    /* القياس دالة **قراءة محضة** (im.measure): runTrial يفحص العزل بمقارنة بصمة
       الحالة قبل/بعد، فأي كتابة داخل القياس تُرفض كانتهاك عزل. هذا ما يمنع
       «تجربة» تُحسّن رقمها بتغيير القاعدة نفسها. */
    const scope = String(payload.scope || 'system');
    try {
      const out = await im.runTrial(db, id, {
        measure: (ctx) => {
          const m = im.measure(db, scope);
          const metric = ctx && ctx.metric;
          return metric && m && Object.prototype.hasOwnProperty.call(m, metric) ? Number(m[metric]) : null;
        },
      });
      return json(res, out.ok ? 200 : 400, out);
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // §7 + §8 + §40: العلاقات والمصدر والخطورة
  if (req.method === 'GET' && url.pathname === '/api/relations/coverage') {
    const rel = opt('cortex-relations'); const db = layerDb();
    if (!rel || !db) return json(res, 503, { error: i18n.T('وحدة العلاقات غير متاحة', "Relations module unavailable") });
    return json(res, 200, { ...rel.coverage(db), kinds: rel.RELATION_KINDS || null });
  }
  /* إصلاح 2026-11-13 (جدول ميت مقيس: severity_evidence = 0 صف): `deriveSeverity`
     مُصدَّرة ومكتوبة ومُختبَرة — ولا يستدعيها أحد. فالخطورة لا تُشتق أبداً،
     والواجهة تعرض «غير معروف» دائماً. الآن لها مسار: عنصر واحد أو دفعة.
     الأدلة المستخدمة تُثبت في الصف نفسه (used/contributions)، وما لا دليل له
     لا يدخل الحساب — لا تخمين. */
  if (req.method === 'POST' && url.pathname === '/api/relations/severity') {
      if (!requireSession(req, res)) return;
    const rel = opt('cortex-relations'); const db = layerDb();
    if (!rel || !db) return json(res, 503, { error: i18n.T('وحدة العلاقات غير متاحة', 'Relations module unavailable') });
    if (typeof rel.deriveSeverity !== 'function') return json(res, 503, { error: i18n.T('deriveSeverity غير متاحة', 'deriveSeverity unavailable') });
    const payload = await body(req);
    const notes = await core.readNotes();
    const one = String(payload.noteId || '').trim();
    const targets = one ? notes.filter(n => n.id === one) : notes;
    if (one && !targets.length) return json(res, 404, { error: i18n.T('العنصر غير موجود', 'Note not found') });
    const derived = [];
    const invalid = [];
    let skipped = 0;
    /* مفردات الحساسية الأربع فقط (2026-11-14): قيمة مثل «high» كانت تُمرَّر
       ثم تُتجاهل في الحساب بصمت — فيبدو الاشتقاق ناجحاً والدرجة بلا هذا الأصل.
       الآن: قيمة غير معروفة تُعلَن بالاسم وبالمسموح، ولا تُحسب كأنها دليل. */
    const SENS_OK = new Set(['public', 'internal', 'confidential', 'restricted']);
    for (const n of targets) {
      const sens = n.fm?.sensitivity || payload.sensitivity || null;
      const crit = Number(n.fm?.criticality ?? payload.impact);
      const input = { entity: 'note', entityId: n.id };
      if (sens) {
        const sv = String(sens).toLowerCase().trim();
        if (SENS_OK.has(sv)) input.sensitivity = sv;
        else invalid.push({ noteId: n.id, field: 'sensitivity', value: String(sens), allowed: [...SENS_OK] });
      }
      // criticality > 0 يعني أثراً معلناً؛ الصفر يعني «لم يُقدَّر» لا «لا أثر»
      if (Number.isFinite(crit) && crit > 0) input.impact = crit;
      /* لا دليل ⇒ لا صف. (مقيس 2026-11-13: تشغيل الدفعة على 373 ملاحظة بلا
         sensitivity/criticality مُعلنة أنتج 373 صفاً بدرجة 0 — ضجيج يشبه
         التغطية. الصدق: نعدّها «لم تُقدَّر» ولا نكتب.) */
      if (!input.sensitivity && input.impact === undefined) { skipped += 1; continue; }
      try {
        const out = rel.deriveSeverity(db, n.id, input);
        derived.push({ noteId: n.id, severity: out?.severity ?? out?.level ?? null, score: out?.score ?? null });
      } catch (e) { derived.push({ noteId: n.id, error: e.message }); }
    }
    const levels = {};
    for (const d of derived) if (d.severity) levels[d.severity] = (levels[d.severity] || 0) + 1;
    return json(res, 200, { ok: true, count: derived.length, skipped, invalid: invalid.slice(0, 20), invalidCount: invalid.length, levels, sample: derived.slice(0, 5) });
  }

  /* ربط ذكي — فلسفة الوكيل: الربط مهمة الوكيل لا نموذج بثلاث قوائم.
     المقترحات مشتقة من التشابه الفعلي (relatedNotes: وسوم/روابط/تقاطع مصطلحات)،
     بلا أي كتابة — والاعتماد البشري يبقى بوابة التسجيل (§7 provenance). */
  if (req.method === 'GET' && url.pathname === '/api/links/suggest') {
    const noteId = String(url.searchParams.get('noteId') || '').trim();
    if (!noteId) return json(res, 400, { error: i18n.T('حدد noteId', 'Pass noteId') });
    const notes = await core.readNotes();
    const source = notes.find(n => n.id === noteId);
    if (!source) return json(res, 404, { error: i18n.T('العنصر غير موجود', 'Note not found') });
    let existing = [];
    try { const rel = opt('cortex-relations'); const db = layerDb(); if (rel && db) existing = rel.relationsOf(db, source.id, {}); } catch { existing = []; }
    // relationsOf يعيد {outgoing,incoming} — والاتجاهان يعنيان «مرتبط» في العرض
    const rows = Array.isArray(existing) ? existing : [...(existing.outgoing || []), ...(existing.incoming || [])];
    const linked = new Set(rows.map(r => `${r.target}`).concat(rows.map(r => `${r.source}`)));
    const suggestions = core.relatedNotes(notes, source.id, 12)
      .filter(r => !linked.has(r.id))
      .map(r => ({
        target: r.id, title: r.title, score: r.score,
        confidence: Math.max(0.12, Math.min(0.95, Number((r.score / 20).toFixed(2)))),
        kind: 'references',
        reason: i18n.T(`تشابه فعلي مع «${source.title}» (${r.score} نقطة إشارة: وسوم/روابط/تقاطع مصطلحات)`,
                      `Real similarity with "${source.title}" (${r.score} signal points: tags/links/term overlap)`)
      }));
    return json(res, 200, { noteId: source.id, title: source.title, count: suggestions.length, suggestions });
  }
  // اعتماد اقتراح ربط: يُسجَّل في note_links بأصل وثقة وزمن — لا ربط بلا مصدر (§7)
  if (req.method === 'POST' && url.pathname === '/api/links/approve') {
      if (!requireSession(req, res)) return;
    const payload = await body(req);
    const rel = opt('cortex-relations'); const db = layerDb();
    if (!rel || !db) return json(res, 503, { error: apiMsg(payload, 'وحدة العلاقات غير متاحة', 'Relations module unavailable') });
    const source = String(payload.source || '').trim();
    const target = String(payload.target || '').trim();
    const kind = String(payload.kind || 'references').trim();
    const confidence = Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0.5;
    const notes = await core.readNotes();
    if (!notes.some(n => n.id === source) || !notes.some(n => n.id === target)) {
      return json(res, 404, { error: apiMsg(payload, 'أحد العنصرين غير موجود', 'One of the items is missing') });
    }
    try {
      const out = rel.addRelation(db, {
        source, target, kind,
        origin: String(payload.origin || 'agent-suggest-approved').slice(0, 40),
        confidence: Math.max(0, Math.min(1, confidence)),
        evidence: JSON.stringify({ reason: String(payload.reason || '').slice(0, 300), approvedBy: 'user', approvedAt: new Date().toISOString() }),
        extractedAt: new Date().toISOString()
      });
      await core.appendAudit({ type: 'relation_approved', source, target, kind, added: !!out?.ok }).catch(() => {});
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  // §40: درجة الثقة والمصدر يُعرضان مع العنصر — لا يُكتفى بحفظهما
  if (req.method === 'GET' && url.pathname === '/api/confidence') {
    const rel = opt('cortex-relations'); const db = layerDb();
    if (!rel || !db) return json(res, 503, { error: i18n.T('وحدة العلاقات غير متاحة', "Relations module unavailable") });
    const id = String(url.searchParams.get('id') || '');
    if (!id) return json(res, 400, { error: i18n.T('المعرّف مطلوب', "id is required") });
    const out = rel.relationsOf(db, id, {});
    return json(res, 200, {
      id,
      outgoing: Array.isArray(out) ? out : (out.outgoing || out.relations || []),
      incoming: out.incoming || [],
    });
  }

  // §38: التراجع عن التغيير
  if (req.method === 'GET' && url.pathname === '/api/rollback/changes') {
    const r = opt('cortex-rollback'); const db = layerDb();
    if (!r || !db) return json(res, 503, { error: i18n.T('وحدة التراجع غير متاحة', "Rollback module unavailable") });
    const items = r.listChanges(db, { limit: Number(url.searchParams.get('limit')) || 50 });
    /* الواجهة تعرض الحالة لا المحتوى (2026-11-14): كانت 50 صفاً تحمل 618KB من
       before/after الكاملة ولا يقرأ منها الواجهة حرفاً — 110KB مضغوطة على كل
       فتح للحُكم. الافتراضي الآن ملخّص بأحجام؛ المحتوى الكامل بـ?full=1 فقط
       (والتراجع نفسه يقرأ الصف من القاعدة لا من المتصفح). */
    const full = String(url.searchParams.get('full') || '') === '1';
    const slim = full ? items : items.map((x) => ({
      id: x.id, at: x.at, entity: x.entity, entityId: x.entityId, op: x.op,
      reverted: x.reverted, revertedAt: x.revertedAt, actor: x.actor, runId: x.runId,
      beforeChars: x.before == null ? 0 : String(x.before).length,
      afterChars: x.after == null ? 0 : String(x.after).length,
    }));
    return json(res, 200, { items: slim, full, stats: r.stats(db) });
  }

  // §38: التحقق من سلامة سجل التدقيق (كشف أي محو)
  if (req.method === 'GET' && url.pathname === '/api/audit/verify') {
    const out = typeof core.verifyAuditChain === 'function'
      ? await core.verifyAuditChain()
      : { ok: false, reason: i18n.T('دالة التحقق غير متاحة', "Verification function unavailable") };
    const db = layerDb();
    let dbRows = 0;
    if (db) { try { dbRows = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c; } catch { dbRows = 0; } }
    return json(res, 200, { ...out, dbRows });
  }

  // §30 + §31: سطح التكاملات — قدرات فعلية مشتقة لا أسماء تطبيقات
  if (req.method === 'GET' && url.pathname === '/api/connectors') {
    const c = opt('cortex-connectors'); const db = layerDb();
    if (!c) return json(res, 503, { error: i18n.T('وحدة التكاملات غير متاحة', "Connectors module unavailable") });
    let calls = [], tested = [];
    if (db) {
      try { calls = c.callLog ? c.callLog(db, { limit: 20 }) : []; } catch { calls = []; }
      try {
        tested = db.prepare("SELECT at, payload FROM audit_log WHERE type IN ('connector_tested','connector_discovered') ORDER BY id DESC LIMIT 20").all()
          .map((r) => { try { return { at: r.at, ...JSON.parse(r.payload) }; } catch { return { at: r.at }; } });
      } catch { tested = []; }
    }
    const L = i18n.lang();
    const lab = (x) => ({ ...x, label: L === 'en' ? (x.en || x.ar) : x.ar });
    const targets = (c.TARGETS || []).map(lab);
    const caps = {};
    for (const [id, v] of Object.entries(c.CAPABILITIES || {})) caps[id] = lab(v);
    return json(res, 200, { targets, capabilities: caps, calls, tested });
  }
  // §31/2: اكتشاف قدرات خادم MCP مرتبط فعلاً (من mcp-servers.json) — بلا شبكة خارجية:
  // المسبار يشغّل الأداة المدمجة tools/list على الخادم المحلي إن وُجد أمر، وإلا يفشل بوضوح.
  if (req.method === 'POST' && url.pathname === '/api/connectors/discover') {
      if (!requireSession(req, res)) return;
    const c = opt('cortex-connectors'); const db = layerDb();
    if (!c || !db) return json(res, 503, { error: i18n.T('وحدة التكاملات غير متاحة', "Connectors module unavailable") });
    const payload = await body(req);
    const targetId = String(payload.target || 'generic-mcp');
    // مسبار حقيقي: لو المستخدم وفر tools يدوياً (من خطوة ربط سابقة) نستخدمها؛
    // وإلا نبني المسبار من أكتشاف MCP المحلي الموجود أصلاً في /api/mcp-info.
    let probeResult;
    if (Array.isArray(payload.tools)) {
      probeResult = { reached: payload.reached !== false, tools: payload.tools };
    } else {
      try {
        const info = await new Promise((resolve) => {
          const rq = { method: 'GET', pathname: '/api/mcp-info' };
          // نداء داخلي آمن: نعيد استخدام منطق mcp-info عبر توليد الرد نفسه
          resolve(null);
        });
        // خوادم MCP المحلية تُكتشف عبر McpClient الحالي:
        const servers = await readMcpServers();
        const list = Object.entries(servers.mcpServers || {});
        // اختيار خادم بعينه إن حُدّد (واجهة «أضف واختبر» تختبر الخادم الجديد لا الأول)
        const want = String(payload.server || '').trim();
        const picked = want ? list.filter(([n]) => n === want) : list;
        if (!list.length || !picked.length) {
          probeResult = { reached: false, error: i18n.T('لا خوادم MCP مربوطة — أضف خادماً أولاً في mcp-servers.json', "No MCP servers linked — add one in mcp-servers.json first") };
        } else {
          const [sname, scfg] = picked[0];
          const { McpClient } = require('./cortex-mcp-client');
          /* عطلان مُقاسان 2026-10-24 في هذا المسار:
             (1) المهلة كانت 4000ms وخادم MCP حقيقي يحتاج ~13-16ث لإقلاع بارد.
             (2) العميل كان يُنشأ ثم يُنادى tools/list **بلا start/initialize** —
                 فيرجع خطأ فورياً «لا أدوات» رغم أن الخادم سليم (أثبتته الوحدة مباشرة: 28 أداة).
             والآن يُشغَّل ويُهيَّأ ويُغلق نظيفاً بعد الاكتشاف. */
          const client = new McpClient({ name: sname, ...scfg, timeoutMs: 20000 });
          let probe;
          try {
            await client.start();
            const init = await client.initialize();
            if (init && init.error) throw new Error(String(init.error));
            const tools = await client.listTools();
            probe = Array.isArray(tools)
              ? { reached: true, tools: tools.map(t => (typeof t === 'string' ? t : t.name)) }
              : { reached: false, error: `فشل استدعاء tools/list على «${sname}»: ${(tools && tools.error) || i18n.T('لا أدوات', "No tools")}` };
          } catch (e) {
            probe = { reached: false, error: `فشل استدعاء tools/list على «${sname}»: ${e.message}` };
          } finally {
            try { await client.stop(); } catch { /* الإغلاق لا يُسقط الاكتشاف */ }
          }
          probeResult = probe;
        }
      } catch (e) { probeResult = { reached: false, error: String(e.message || e) }; }
    }
    const probe = () => probeResult;
    const report = c.discover(probe, { id: targetId }, i18n.lang());
    /* الأدوات الخام المكتشفة فعلاً تُعاد أيضاً — `capabilities` تصنيف من قاموس
       connectors لا عدد أدوات؛ إظهار الرقمين يمنع التباس «0 قدرة = خادم فارغ». */
    report.toolsFound = (probeResult && Array.isArray(probeResult.tools)) ? probeResult.tools : [];
    // تسجيل النتيجة تدقيقياً (§31/6) — الفحص بلا أثر لا يجوز
    writeAudit('connector_discovered', { targetId, reached: !!report.reached, capabilities: report.capabilities }, { scope: 'connectors' });
    return json(res, 200, report);
  }
  // §31/5: فحص توافق/صلاحيات تكامل بمسبار محقون (لا شبكة من الخادم).
  // ملاحظة عقد الوحدة: المسبار متزامن — المسبار اللاإحائي كان يجعل الاكتشاف
  // يفشل دائماً بـ«لم يصل» (عطل مؤكد رُصد وأُصلح).
  if (req.method === 'POST' && url.pathname === '/api/connectors/test') {
      if (!requireSession(req, res)) return;
    const c = opt('cortex-connectors'); const db = layerDb();
    if (!c || !db) return json(res, 503, { error: i18n.T('وحدة التكاملات غير متاحة', "Connectors module unavailable") });
    const payload = await body(req);
    const probe = () => ({ reached: !!payload.reached, tools: Array.isArray(payload.tools) ? payload.tools : [], resources: [] });
    const out = c.testIntegration(db, String(payload.target || 'generic-mcp'), {
      probe, required: Array.isArray(payload.required) ? payload.required : [], granted: payload.granted || {},
      lang: i18n.lang(),
    });
    return json(res, 200, out);
  }

  // ملخص حُكم واحد للوحة
  if (req.method === 'GET' && url.pathname === '/api/governance') {
    const db = layerDb();
    const g = opt('cortex-gates'); const im = opt('cortex-improve');
    const rel = opt('cortex-relations'); const q = opt('cortex-guard'); const r = opt('cortex-rollback');
    const out = { ok: true, stages: null, gates: null, usage: null, quarantine: null, improvement: null, relations: null, rollback: null, modules: {} };
    out.modules = {
      gates: !!g, improve: !!im, relations: !!rel, guard: !!q, rollback: !!r, privacy: !!privacyMod,
    };
    const glang = i18n.lang();
    if (db && g) { try { out.stages = g.evaluateStage(db, glang); } catch (e) { out.stages = { error: e.message }; } }
    if (db && q) { try { out.quarantine = q.stats(db); } catch (e) { out.quarantine = { error: e.message }; } }
    if (db && rel) { try { out.relations = rel.coverage(db); } catch (e) { out.relations = { error: e.message }; } }
    if (db && r) { try { out.rollback = r.stats(db); } catch (e) { out.rollback = { error: e.message }; } }
    if (db && im) { try { out.improvement = im.evaluate(db, { scope: 'system', lang: glang }); } catch (e) { out.improvement = { error: e.message }; } }
    if (db && privacyMod?.usageSummary) { try { out.usage = privacyMod.usageSummary(db, { lang: glang }); } catch (e) { out.usage = { error: e.message }; } }
    return json(res, 200, out);
  }
  return false;
}

async function serveStatic(req, res, url) {
  // favicon مدمج — لا 404 في كنسول المتصفح أبداً
  if (url.pathname === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2937"/><text x="16" y="23" font-size="17" text-anchor="middle">🧠</text></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(svg);
  }
  /* مسار ينتهي بـ/ يخدم index.html داخله — فتصفح مجلدات الواجهة يعمل
     (/next/ للواجهة الجديدة بينما / تبقى الكلاسيكية الافتراضية). */
  const rel = url.pathname === '/' ? '/index.html'
    : (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return textR(res, 403, 'Forbidden');
  try {
    const ext = path.extname(filePath);
    const content = await fsp.readFile(filePath);
    // لا تخزين مؤقت: أي تغيير في الواجهة يظهر فورًا في المتصفح
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // وصول الزائر إلى / يمسح قديم هذا الأصل مرة واحدة (كسر كاش نسخ ما قبل الإصلاح)
    if (url.pathname === '/') headers['Clear-Site-Data'] = '"cache"';
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    textR(res, 404, 'Not found');
  }
}

// ---- النبض الزمني للوكيل: فحص دوري + موجز صباحي يومي — يعمل دون سؤال المستخدم ----
let schedTimer = null;
let schedInFlight = false;
/* حالة المجدول المنشورة (2026-11-06): كان النبض يعمل كل 6 ساعات بلا سطح يقول
   متى التالي أو ما نتيجة آخر فحص — فيبدو النظام ساكناً أو متصرفاً من نفسه. */
const schedState = { hours: null, nextAt: null, nextInMs: null, lastTickAt: null, lastReason: null, lastOk: null, lastError: null, ticks: 0 };
/**
 * لغة ردّ الوكيل: طلب العميل أولاً، ثم إعداد الخادم، ثم العربية.
 * العطل الأصلي: كانت تقرأ الإعداد فقط — فطلب الواجهة `lang:'en'` كان يُهمَل
 * ويُعاد نص عربي في وضع الواجهة الإنجليزية (بقايا 120 نصاً في المراقبة).
 */
function resolveAgentLang(settings, requested) {
  const ask = String(requested || '').toLowerCase();
  if (ask === 'ar' || ask === 'en') return ask;
  const pref = String(settings?.agent?.language || 'auto');
  if (pref === 'ar' || pref === 'en') return pref;
  /* لغة الواجهة المحفوظة تسبق 'ar' الافتراضية: كانت الواجهة تحفظ لغتها في
     localStorage وحده، فالخادم لا يعرفها ويكتب **محتوى يُخزَّن** بالعربية
     (عناوين مهام وملاحظات الوكيل) حتى في الواجهة الإنجليزية — عطل مُقاس
     2026-11-09: عشرات النصوص العربية داخل «المعرفة» و«الخريطة» في en. */
  const uiLang = String(settings?.ui?.lang || '').toLowerCase();
  if (uiLang === 'ar' || uiLang === 'en') return uiLang;
  return 'ar';
}
/* ── جدولة المهام + سقوف العقد + أدوات النظام: منطق واحد يستخدمه
   المسار المباشر (الواجهة) وأدوات الوكيل الذاتية (W4) وإدارة السقوف (W5). ── */
function scheduleTasksOf(settings) { return Array.isArray(settings?.agent?.scheduled_tasks) ? settings.agent.scheduled_tasks : []; }
function effectiveCaps(settings) {
  const base = require('./cortex-policy').DAILY_LIMITS || {};
  const over = (settings && settings.agent && settings.agent.limits) || {};
  const out = { ...base };
  for (const k of Object.keys(base)) if (Number.isFinite(Number(over[k])) || over[k] === 0) out[k] = Number(over[k]);
  return out;
}
async function scheduleAddTask(settings, { goal, every_hours } = {}) {
  const g = String(goal || '').trim();
  const every = Number(every_hours);
  if (!g || g.length > 500) return { error: i18n.T('هدف المهمة مطلوب (حتى 500 حرف)', 'Task goal required (up to 500 chars)'), status: 400 };
  if (!Number.isFinite(every) || every < 0.25 || every > 720) return { error: i18n.T('تكرار المهمة خارج النطاق (0.25..720 ساعة)', 'Task interval out of range (0.25..720h)'), status: 400 };
  const tasks = [...scheduleTasksOf(settings)];
  if (tasks.length >= 10) return { error: i18n.T('سقف المهام المجدولة 10 — احذف مهمة أولاً', 'Scheduled-task cap is 10 — remove one first'), status: 400 };
  const task = { id: 'task-' + Date.now().toString(36), goal: g, every_hours: every, enabled: true, last_run_at: null, created_at: new Date().toISOString() };
  tasks.push(task);
  settings.agent = { ...(settings.agent || {}), scheduled_tasks: tasks };
  await core.saveSettings(settings);
  await core.appendAudit({ type: 'agent_schedule_added', taskId: task.id, every }).catch(() => {});
  return { ok: true, task };
}
async function scheduleToggleTask(settings, id, enabled) {
  const tasks = [...scheduleTasksOf(settings)];
  const idx = tasks.findIndex(t => t.id === String(id));
  if (idx === -1) return { error: i18n.T('مهمة غير موجودة', 'Task not found'), status: 404 };
  tasks[idx] = { ...tasks[idx], enabled: enabled !== undefined ? !!enabled : !tasks[idx].enabled };
  settings.agent = { ...(settings.agent || {}), scheduled_tasks: tasks };
  await core.saveSettings(settings);
  armScheduler();
  await core.appendAudit({ type: 'agent_schedule_toggled', taskId: String(id), enabled: tasks[idx].enabled }).catch(() => {});
  return { ok: true, task: tasks[idx], tasks };
}
async function scheduleRemoveTask(settings, id) {
  const before = scheduleTasksOf(settings);
  const tasks = before.filter(t => t.id !== String(id));
  if (tasks.length === before.length) return { error: i18n.T('مهمة غير موجودة', 'Task not found'), status: 404 };
  settings.agent = { ...(settings.agent || {}), scheduled_tasks: tasks };
  await core.saveSettings(settings);
  armScheduler();
  await core.appendAudit({ type: 'agent_schedule_removed', taskId: String(id) }).catch(() => {});
  return { ok: true, tasks };
}
/* أدوات النظام التي يراها الوكيل في سياقه (W4): القراءات فورية، والتغييرات
   تصل هنا فقط عبر مسار الاعتماد (alwaysDraft في السياسة) — فيقترح الوكيل
   وينفّذ المستخدم. */
function sysToolsFor(runId) {
  return {
    runsList: () => ({ active: runsStore().active(), recent: runsStore().recent(8) }),
    budgetReport: async () => {
      const settings = await core.readSettings();
      const caps = effectiveCaps(settings);
      const used = typeof agent.dailyUsageByKey === 'function' ? await agent.dailyUsageByKey() : {};
      return { caps, used, note: i18n.T('عدّاد agent_action منذ بداية اليوم', 'agent_action counter since the start of today') };
    },
    scheduleList: async () => {
      const settings = await core.readSettings();
      const raw = settings.agent?.schedule_hours;
      const now = Date.now();
      return {
        hours: raw != null ? Number(raw) : null,
        effectiveHours: raw === 0 || raw === '0' ? 0 : (Number(raw) > 0 ? Number(raw) : 6),
        tasks: scheduleTasksOf(settings).map(t => ({ id: t.id, goal: t.goal, every_hours: t.every_hours, enabled: t.enabled !== false, last_run_at: t.last_run_at || null, due: scheduledTaskDue(t, now) }))
      };
    },
    scheduleAdd: async (args) => scheduleAddTask(await core.readSettings(), args || {}),
    scheduleToggle: async (args) => scheduleToggleTask(await core.readSettings(), String((args || {}).id || ''), (args || {}).enabled),
    scheduleRemove: async (args) => scheduleRemoveTask(await core.readSettings(), String((args || {}).id || '')),
    cancelRun: async (rid) => {
      const id = String(rid || '').trim();
      if (!id) return { error: i18n.T('runId مطلوب', 'runId is required') };
      const sum = runsStore().summarize(id);
      if (!sum) return { error: i18n.T('تشغيل غير موجود بهذا المعرّف', 'No run with that id') };
      if (!sum.active) return { ok: true, already: sum.terminal, runId: id };
      runsStore().requestCancel(id);
      await core.appendAudit({ type: 'run_cancel_requested', runId: id, by: 'agent' }).catch(() => {});
      return { ok: true, runId: id, note: i18n.T('سيتوقف قبل الخطوة التالية', 'It will stop before the next step') };
    },
    /* ذاكرة المشاريع لوكلاء البناء — الهدفان (2026-10-28) */
    projectAbsorb: async (args) => projectMemory.absorbProject(args || {}),
    memorySlice: async (args) => projectMemory.buildMemorySlice(args || {}),
    projectTrail: async (args) => projectMemory.readTrail(args || {}),
    trailAppend: async (args) => projectMemory.appendTrail(args || {}),
    /* الاستيراد (2026-11-13): كان القسم بشرياً بالكامل — لا أداة للوكيل */
    importPath: async (args) => doImportPath(args || {}),
    importUrl: async (args) => doImportUrl(args || {}),
    importList: async (args) => doImportList(args || {}),
    /* أدوات MCP (2026-11-13): الوكيل كان أعمى عنها تماماً */
    mcpCall: async ({ server, tool, args, approved }) => callMcpToolForAgent({ server, tool, args, approved })
  };
}
async function schedulerTick(reason = 'interval') {
  if (schedInFlight) return;
  schedInFlight = true;
  const t0 = Date.now();
  const dry = process.env.CORTEX_SCHED_DRY === '1';
  const entry = { at: new Date().toISOString(), reason, dryRun: dry, ok: false, findings: 0, briefCreated: false, memoryRefreshed: false, scheduled: [], error: null };
  schedState.lastTickAt = entry.at;
  schedState.lastReason = reason;
  try {
    const settings = await core.readSettings();
    const lang = resolveAgentLang(settings);
    // إعادة محاولة واحدة للفشل العابر (مهلة شبكة للمزود) — النبضة لا تفشل من وميض
    let out = null; let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { out = await agent.proactive({ project: '', lang }); lastErr = null; break; }
      catch (e) { lastErr = e; if (attempt === 1) await new Promise(r => setTimeout(r, 3000)); }
    }
    if (lastErr) throw lastErr;
    entry.findings = (out.findings || []).length;
    await fsp.writeFile(path.join(core.dataDir, 'agent-findings.json'), JSON.stringify({ at: new Date().toISOString(), findings: out.findings || [] }, null, 2), 'utf8').catch(() => {});
    await core.appendAudit({ type: 'scheduler_tick', reason, findings: entry.findings, dryRun: dry });
    if (!dry) {
      const todayId = 'morning-brief-' + new Date().toISOString().slice(0, 10);
      const hadBrief = (await core.readNotes()).some(n => n.id === todayId);
      await ensureMorningBrief(settings, out.findings || [], lang);
      entry.briefCreated = !hadBrief;
      await refreshAgentMemory(settings, out.findings || [], lang);
      entry.memoryRefreshed = true;
      // المهام المجدولة المستحقة — سقف اثنتين في النبضة الواحدة (لا تفجير طابور)
      const tasks = Array.isArray(settings.agent?.scheduled_tasks) ? settings.agent.scheduled_tasks : [];
      let ran = 0;
      for (const task of tasks) {
        if (ran >= 2) break;
        if (!scheduledTaskDue(task)) continue;
        if (core.agentPaused()) break;
        ran++;
        const res = await runScheduledTask(task, settings);
        task.last_run_at = new Date().toISOString();
        entry.scheduled.push({ id: task.id, ok: res.ok, answer: String(res.answer || '').slice(0, 80) });
      }
      if (ran) await core.saveSettings(settings).catch(() => {});
    }
    entry.ok = true;
  } catch (e) {
    entry.error = String(e.message).slice(0, 200);
    await core.appendAudit({ type: 'scheduler_error', error: entry.error }).catch(() => {});
  } finally {
    entry.ms = Date.now() - t0;
    // سجل النبض append-only (عقد daily-brief: bookmark + ledger + سجل تشغيل) — يحتفظ بآخر 200 سطر
    try {
      await fsp.appendFile(path.join(core.dataDir, 'scheduler-log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
      const raw = await fsp.readFile(path.join(core.dataDir, 'scheduler-log.jsonl'), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 200) await fsp.writeFile(path.join(core.dataDir, 'scheduler-log.jsonl'), lines.slice(-200).join('\n') + '\n', 'utf8');
    } catch { /* السجل لا يُسقط النبضة */ }
    schedState.lastOk = entry.ok;
    schedState.lastError = entry.error || null;
    schedState.ticks += 1;
    schedInFlight = false;
  }
}
/* وقت آخر نبضة من السجل الدائم — لئلا يُعاد التحليل الكامل في كل إقلاع. */
async function lastSchedulerTickAt() {
  try {
    const logRaw = await fsp.readFile(path.join(core.dataDir, 'scheduler-log.jsonl'), 'utf8');
    const logLines = logRaw.split('\n').filter(Boolean);
    const last = JSON.parse(logLines[logLines.length - 1]);
    return last && last.at ? Date.parse(last.at) : 0;
  } catch { return 0; }
}

/* استحقاق مهمة مجدولة: بلا last_run_at ⇒ مستحقة فوراً (أول تشغيل) */
function scheduledTaskDue(task, now = Date.now()) {
  if (!task || task.enabled === false) return false;
  const every = Number(task.every_hours);
  if (!Number.isFinite(every) || every <= 0) return false;
  const last = task.last_run_at ? Date.parse(task.last_run_at) : 0;
  return !last || (now - last) >= every * 3600e3;
}
/* تنفيذ مهمة مجدولة عبر المسار الوكيلي الكامل: جلسة + تشغيل + رسائل + مسودات
   معلّقة تُدمج في ملف الاعتماد + تدقيق. الوضع من إعداد النظام (supervised
   افتراضاً) — فالمهام المجدولة تكتب مسودات، والاعتماد يبقى بشرياً (§33). */
async function runScheduledTask(task, settings) {
  const t0 = Date.now();
  let session = null;
  try { session = await core.createSession({ goal: String(task.goal).slice(0, 200), mode: 'project', source: 'scheduler' }); } catch { /* الجلسة لا تُسقط المهمة */ }
  /* عطل مُقاس (تحقق مستقل C، 2026-10-27): فشل المزود كان **يرمي** من agent.run
     فيتخطى كل ما بعده — لا حدث تدقيق scheduled_task_run ولا استجابة منظّمة،
     فالواجهة ترى 500 والدفتر يبدو كأن المهمة لم تُحاول. العقد: كل محاولة
     تُخلّف أثراً — نجحت أو فشلت. */
  let out = null; let runError = null;
  /* W1: التشغيل المجدول أيضاً كائن أوّل-درجة — معرّف وسجل أحداث وإلغاء */
  const rs = runsStore();
  const runId = rs.begin({ goal: String(task.goal), sessionId: session?.id || '', trigger: 'schedule', lang: 'ar' });
  const hooks = {
    onEvent: (ev) => { try { rs.event(runId, ev && ev.type, (ev && ev.payload) || null); } catch { /* تحسيني */ } },
    shouldCancel: () => rs.isCancelled(runId)
  };
  try { out = await agent.run({ goal: String(task.goal), autonomy: String(settings.agent?.autonomy || 'supervised') }, null, { hooks, sysTools: sysToolsFor(runId) }); }
  catch (e) { runError = e; }
  if (out?.pending?.length) {
    try {
      const pf = path.join(core.dataDir, 'agent-pending.json');
      let prev = { mutations: [] };
      try { prev = JSON.parse(await fsp.readFile(pf, 'utf8')); } catch { /* لا ملف بعد */ }
      const merged = { at: new Date().toISOString(), mutations: [...(prev.mutations || []), ...out.pending] };
      await fsp.writeFile(pf, JSON.stringify(merged, null, 2), 'utf8');
    } catch { /* دمج المسودات تحسيني */ }
  }
  if (session?.id && out && !out.error) {
    try {
      await core.appendSessionMessage(session.id, { role: 'user', content: String(task.goal) });
      await core.appendSessionMessage(session.id, { role: 'assistant', content: String(out.answer || '').slice(0, 4000) });
    } catch { /* الجلسة لا تُسقط المهمة */ }
  }
  // الختام الدائم للمهمة المجدولة — لا تشغيل بلا نهاية موثقة
  /* صدق الحالة (عطل مُثبت 2026-11-15): كان أي تشغيل بلا error يُعلَن ok:true ولو
     كان **كل** ما فعله مسودات معلّقة (تشغيلات حيّة: run-1794600072969 و
     run-1794692777125 تحمل ok:true ونتيجتها «queued: مسودة بانتظار موافقتك»).
     القاعدة: النجاح يحتاج عقدةً حقيقية — pending=0 أو كانت هناك mutations؛
     وما دام كل الأثر مسودات: awaiting_approval لا ok. */
  const pendingCount = Array.isArray(out?.pending) ? out.pending.length : 0;
  const mutationsCount = Array.isArray(out?.mutations) ? out.mutations.length : 0;
  const awaitingApproval = !runError && !out?.error && !out?.cancelled && pendingCount > 0 && mutationsCount === 0;
  try {
    if (runError) rs.finish(runId, 'run_failed', { error: String(runError.message || runError).slice(0, 300) });
    else if (out?.error) rs.finish(runId, 'run_failed', { error: String(out.error).slice(0, 300) });
    else if (out?.cancelled) rs.finish(runId, 'run_cancelled', { reason: 'user_request' });
    else if (awaitingApproval) rs.finish(runId, 'run_finished', { ok: false, awaitingApproval: true, pending: pendingCount, stepsUsed: out?.stepsUsed || 0, answer: String(out?.answer || '').slice(0, 1500) });
    else rs.finish(runId, 'run_finished', { ok: true, verified: out?.verified ?? null, stepsUsed: out?.stepsUsed || 0, answer: String(out?.answer || '').slice(0, 1500) });
  } catch { /* سباق إغلاق */ }
  const entry = {
    ok: !runError && !out?.error && !awaitingApproval,
    outcome: runError || out?.error ? 'failed' : out?.cancelled ? 'cancelled' : awaitingApproval ? 'awaiting_approval' : 'completed',
    awaitingApproval,
    ms: Date.now() - t0, runId, sessionId: session?.id || null,
    pending: pendingCount, mutations: mutationsCount,
    answer: String(out?.answer || '').slice(0, 300),
    error: runError ? String(runError.message || runError).slice(0, 200) : (out?.error || null)
  };
  await core.appendAudit({ type: 'scheduled_task_run', taskId: task.id, ...entry }).catch(() => {});
  return entry;
}
/* ذاكرة الوكيل الطويلة (نمط LongTermMEMORY): ملاحظة حيّة واحدة تُحدَّث كل نبضة
   وتُحقن مختصرة في مطالبة كل تشغيل — فالوكيل يستأنف من حالة مشروعه لا من الصفر. */
async function refreshAgentMemory(settings, findings, lang) {
  const en = lang === 'en';
  const review = await core.reviewWorkspace();
  const openTasks = core.listTasks({ status: 'open' }).slice(0, 6);
  const notes = await core.readNotes();
  const decisions = notes.filter(n => n.classification.primaryType === 'decision').slice(-5);
  const recent = notes.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 6);
  const openTaskLabels = openTasks.map(t => String(t.title || t.goal || '').trim()).filter(Boolean);
  const lines = [
    en ? `# Agent Memory — ${new Date().toISOString().slice(0, 10)}` : `# ذاكرة الوكيل — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `- ${en ? 'Knowledge items' : 'عناصر المعرفة'}: ${review.noteCount} · ${en ? 'projects' : 'مشاريع'}: ${review.projectCount} · ${en ? 'health' : 'الصحة'}: ${review.healthScore}%`,
    `- ${en ? 'Open tasks' : 'مهام مفتوحة'}: ${openTasks.length}${openTaskLabels.length ? ' — ' + openTaskLabels.join(' · ') : ''}`,
    decisions.length ? `- ${en ? 'Recent decisions' : 'آخر قرارات'}: ${decisions.map(d => d.title).join(' · ')}` : null,
    recent.length ? `- ${en ? 'Recently touched' : 'آخر ما مُسّ'}: ${recent.map(n => n.title).join(' · ')}` : null,
    findings.length ? `- ${en ? 'Findings' : 'مستجدات'}: ${findings.slice(0, 4).map(f => `[${f.severity}] ${String(f.text).slice(0, 80)}`).join(' | ')}` : null,
    ''
  ].filter(Boolean);
  const title = en ? 'Agent Memory — living topic' : 'ذاكرة الوكيل — موضوع حي';
  const content = lines.join('\n').slice(0, 1800);
  // لا كتابة بلا تغيير: إعادة الكتابة المتطابقة كل نبضة كانت تُوسم الفهرس متسخاً
  // (وتولّد لقطة) بلا أي فائدة — العقد: الذاكرة تُحدَّث عندما يتغير فيها شيء فعلاً.
  try {
    const all = await core.readNotes();
    const prev = all.find(n => n.id === 'agent-memory');
    // المحتوى يحمل عنوانه H1 بنفسه — saveNote لا يضيف ترويسة ثانية حينها؛
    // المقارنة على المحتوى مباشرة (وبنسخة الترويسة كاحتياط لو غاب H1 يوماً)
    if (prev) {
      const bodyNow = String(prev.body || '').trim();
      if (bodyNow === content.trim() || bodyNow === `# ${title}\n\n${content}`.trim()) return;
    }
  } catch { /* المقارنة تحسينية — الفشل يعني كتابة عادية */ }
  await core.saveNote({
    id: 'agent-memory',
    title,
    type: 'note', importance: 3,
    content
  });
  await core.appendAudit({ type: 'agent_memory_refreshed' }).catch(() => {});
}
async function ensureMorningBrief(settings, findings, lang) {
  const today = new Date().toISOString().slice(0, 10);
  const id = 'morning-brief-' + today;
  const notes = await core.readNotes();
  if (notes.some(n => n.id === id)) return;
  const review = await core.reviewWorkspace();
  const openTasks = core.listTasks({ status: 'open' });
  const en = lang === 'en';
  const head = en
    ? `# Morning Brief — ${today}\n\nAutomatic daily pulse from the Cortex agent (generated without being asked).\n`
    : `# موجز الصباح — ${today}\n\nنبض يومي تلقائي من وكيل Cortex (أُنشئ دون طلب منك).\n`;
  const body = [
    head,
    `- ${en ? 'Knowledge items' : 'عناصر المعرفة'}: ${review.noteCount} · ${en ? 'projects' : 'مشاريع'}: ${review.projectCount} · ${en ? 'health' : 'الصحة'}: ${review.healthScore}%`,
    `- ${en ? 'Open tasks' : 'مهام مفتوحة'}: ${openTasks.length}`,
    findings.length ? `\n${en ? '## Attention points' : '## نقاط تستدعي انتباهك'}\n${(findings.slice(0, 5)).map(f => `- [${f.severity}] ${f.text}`).join('\n')}\n` : '',
    `\n${en ? 'Scheduled sweeps are configured in Settings → Agent (0 disables the pulse).' : 'الفحص الدوري يضبط من الإعدادات ← الوكيل (0 يعطل النبض).'}`,
    ''
  ].join('\n');
  await core.saveNote({ id, title: en ? `Morning Brief — ${today}` : `موجز الصباح — ${today}`, type: 'note', project: '', importance: 2, content: body });
  await core.appendAudit({ type: 'morning_brief_created', note: id });
}
/* حالة الحارس (عملية منفصلة تعيد التشغيل عند التجمّد):pid محفوظ في data/watchdog.pid
   والفحص عند الطلب بـ signal 0 — لا نثق بملف قديم. */
function watchdogState() {
  try {
    const pid = Number(require('fs').readFileSync(path.join(core.dataDir, 'watchdog.pid'), 'utf8').trim());
    if (!pid) return { managed: false, pid: null, alive: false };
    try { process.kill(pid, 0); return { managed: true, pid, alive: true }; }
    catch { return { managed: true, pid, alive: false }; }
  } catch { return { managed: false, pid: null, alive: false }; }
}
function daemonState() {
  return {
    uptimeSec: Math.round(process.uptime()),
    scheduler: {
      hours: schedState.hours,
      enabled: schedState.nextAt !== null || schedInFlight,
      nextAt: schedState.nextAt,
      nextInSec: schedState.nextAt ? Math.max(0, Math.round((Date.parse(schedState.nextAt) - Date.now()) / 1000)) : null,
      inFlight: schedInFlight,
      lastTickAt: schedState.lastTickAt,
      lastReason: schedState.lastReason,
      lastOk: schedState.lastOk,
      lastError: schedState.lastError,
      ticks: schedState.ticks
    },
    watchdog: watchdogState()
  };
}
function armScheduler() {
  clearTimeout(schedTimer);
  schedTimer = null;
  (async () => {
    const settings = await core.readSettings();
    const envMin = Number(process.env.CORTEX_SCHED_MINUTES);
    /* العطل الذي أغلق مبادرة الوكيل (حكم 2026-10-25: «لا عمل بلا ضغطة إنسان»):
       غياب الإعداد يعني 0 فيسكت النبض إلى الأبد. العقد الآن: 0 صريحة = تعطيل
       مقصود، وغياب الإعداد = الافتراضي 6 ساعات — الوكيل يعمل ما لم يُوقَف. */
    const raw = settings.agent?.schedule_hours;
    const defaultHours = 6;
    const hours = raw === 0 || raw === '0' ? 0 : (Number(raw) > 0 ? Number(raw) : defaultHours);
    const minutes = envMin > 0 ? envMin : hours * 60;
    schedState.hours = hours;
    if (!minutes) { schedState.nextAt = null; schedState.nextInMs = null; return; }
    const ms = Math.min(minutes * 60000, 2147483000);
    schedState.nextAt = new Date(Date.now() + ms).toISOString();
    schedState.nextInMs = ms;
    schedTimer = setTimeout(async () => { await schedulerTick('interval'); armScheduler(); }, ms);
  })().catch(() => {});
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    applySecurityHeaders(res);
    /* ضغط الاستجابات (إصلاح 2026-11-12): القياس الحيّ أعطى /api/brain/map = 7.4MB،
       /api/project-state = 1.4MB، /api/rollback/changes = 634KB — على كل فتح.
       gzip المدمج في Node (بلا اعتمادية) يقلّص JSON بنحو 90%، ويُترك للمتصفح
       الذي يعلن قبوله فقط. لا يتغيّر أي عقد: نفس الجسم، أقل بايتات. */
    res._gzipOk = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    /* فحص Host يغلق إعادة ربط DNS: صفحة خارجية تجعل نطاقها يشير إلى 127.0.0.1
       فترسل Host: attacker.tld وتقرأ الخزنة كاملة. أي مضيف غير مضيف هذا الخادم ⇒ 421.
       لا يُطبَّق إلا على الربط المحلي (مع CORTEX_ALLOW_REMOTE يقصد المستخدم الانفتاح). */
    const hostHdr = String(req.headers.host || '').toLowerCase();
    if (hostHdr && String(HOST) === '127.0.0.1' && !SELF_HOSTS.has(hostHdr)) {
      return json(res, 421, { error: i18n.T('مضيف الطلب لا يطابق مضيف الخادم', 'Request host does not match the server host'), code: 'BAD_HOST' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    // ═══ حماية CSRF (ثغرة مؤكدة: أي موقع كان يستطيع الكتابة في معرفتك) ═══
    // القاعدة: الطلبات المُغيِّرة (غير GET/HEAD/OPTIONS) لا تُقبل إلا من أصل محلي.
    // تُفحص Origin ثم Referer ثم غيابهما (طلبات وكلاء/curl بلا Origin — تُقبل محلياً فقط).
    if (!isTrustedMutation(req, url)) {
      return json(res, 403, {
        error: i18n.T('طلب مُغيِّر من أصل غير موثوق — مرفوض (حماية CSRF). افتح الواجهة من localhost.', "Mutating request from an untrusted origin — rejected (CSRF protection). Open the UI from localhost."),
        code: 'UNTRUSTED_ORIGIN',
      });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        try { await body(req); } catch (err) { return json(res, err.statusCode || 400, { error: err.message }); }
      }
      const lang = await requestLang(url, req);
      const handled = await i18n.runWithLang(lang, () => handleApi(req, res, url));
      if (handled !== false) return;
      /* عقد مُقاس 2026-11-11: أي /api/* غير معروف كان يسقط إلى serveStatic فيُعاد
         404 نصّي («Not found») لا JSON ⇒ res.json() في العميل يرمي خطأ تحليل بدل
         خطأ مفهوم. فضاء /api كله JSON. */
      return json(res, 404, { ok: false, error: i18n.T('مسار API غير معروف', 'Unknown API endpoint'), code: 'unknown_endpoint' });
    }
    await serveStatic(req, res, url);
  } catch (error) {
  /* سجل الأثر الدائم: 500 صامت كانت تترك المستخدم بلا سبب — كل خطأ غير متوقع يظهر الآن */
  console.error('[Cortex] ' + String(error && error.stack || error));
  try { fsp.appendFile(path.join(core.dataDir, 'server-errors.log'), new Date().toISOString() + ' ' + String(error && error.stack || error) + '\n', 'utf8').catch(() => {}); } catch (e) { }
  /* لا تسريب مسارات داخلية في الردّ (عطل مُقاس 2026-11-11): error.message كان
     يبثّ مساراً مطلقاً مثل `C:\Users\...\obsimem-web`. الحلّ **تنقية** لا استبدال:
     الرسالة تبقى مفيدة ومترجمة (المعالج يولّدها بلغة الطلب أصلاً، وبعض الأخطاء
     المقصودة مثل «Session not found» يعتمد عليها العميل والاختبارات)، ويُطمَس
     المسار وحده. التفصيل الكامل يبقى في data/server-errors.log. */
  const status = error.statusCode || 500;
  json(res, status, { error: sanitizeErrorText(error && error.message) });
  }
});

core.ensureBaseFiles().then(() => {
  Promise.resolve(core.syncStore(true)).catch(() => {});
  /* بناء الفهرس عند الإقلاع **معطّل افتراضياً** — بقرار مقاس (2026-11-11):
     البناء الكامل يكلّف 48–141 ثانية على خزنة 361 ملاحظة، ويحجب الحلقة الواحدة
     فتتجمد كل الطلبات (ومنها نبضة الحارس) طوال المدة. الخادم الآن يخدم من الفهرس
     القائم ويُعلن indexStale، والبناء يجري خارج العملية:
       node tools/rebuild-index.cjs
     أو بزر «إعادة بناء الفهرس» في الإعدادات (طلب صريح يتحمّل الانتظار).
     CORTEX_BOOT_REBUILD=1 يعيد السلوك القديم. */
  if (String(process.env.CORTEX_BOOT_REBUILD || '') === '1') {
    setTimeout(() => {
      const t0 = Date.now();
      Promise.resolve(core.rebuildVectorIndex())
        .then((r) => { if (r && r.rebuilt === false) return; console.log(`↻ فهرس الاسترجاع جُهّز في ${Date.now() - t0}ms`); })
        .catch((e) => console.error('تعذّر بناء فهرس الاسترجاع:', e.message));
    }, 5000);
  }
  // مصالحة التشغيلات المتروكة: قتل انقطاعٍ لا يترك حدثاً ختامياً — والإقلاع نفسه
  // دليل قاطع أنه لا منفّذ حيّ لأي تشغيل «نشط» في السجل (العملية الواحدة هي المنفّذ)،
  // فتُغلق كلها فوراً بلا انتظار عتبة — وإلا ظهر شريط الحالة «يعمل الآن» كذباً.
  try {
    const n = runsStore().reconcileAbandoned(0);
    if (n) console.log(`↻ مصالحة: أُغلقت ${n} تشغيلات متروكة من انقطاع العملية`);
  } catch (e) { console.error('تعذّرت مصالحة التشغيلات:', e.message); }

  // ── تنظيف التشغيلات المهجورة عند الإقلاع (عطل مُثبت 2026-10-20) ──
  // تشغيل الفريق توقّف عند 220ث فبقيت مهام `running`/`queued` معلّقة للأبد:
  // لا شيء كان يعيدها. النتيجة المقيسة: شاشة المراقبة تُظهر 0 مهام و0 توازٍ
  // وحكماً فارغاً — لأن المهام عالقة لا منتهية. القاعدة: إقلاع الخادم = لحظة
  // الاستئناف الطبيعية؛ كل غير منتهٍ يُعاد إلى `queued` ليُستأنف بدل أن يُفسد
  // كل تشغيل تالٍ. (requeuePending سابقاً كانت تعالج `running` فقط وتُهمل `queued`.)
  try {
    const odb = openLayerDb();
    const ostore = orc.createStore(odb);
    const stale = ostore.pendingRuns();
    let recovered = 0;
    for (const r of stale) recovered += ostore.requeuePending(r.runId).length;
    if (recovered) console.log(`↻ استئناف: أُعيدت ${recovered} مهمة معلّقة من ${stale.length} تشغيل إلى الطابور`);
  } catch (e) { console.error('تعذّر تنظيف التشغيلات المعلّقة:', e.message); }

  /* §24 (عطل مُقاس 2026-10-24): إعادة الطابور وحدها لا تُكمل عملاً — الاستئناف
     التنفيذي عند الإقلاع يكمل ما انقطع: كل تشغيل عالق يُستأنف عبر Orchestrator.resume
     (تنفيذ فعلي + تحقق). محدود بـCORTEX_AUTO_RESUME_CAP (الافتراضي 3، 0 يعطّل)،
     وبعد فتح المنفذ حتى لا يؤخر جاهزية الخادم، وكل استئناف يُدقَّق. */
  try {
    const capRaw = process.env.CORTEX_AUTO_RESUME_CAP;
    const cap = capRaw === undefined ? 3 : Number(capRaw);
    if (Number.isFinite(cap) && cap > 0) {
      setTimeout(async () => {
        try {
          const odb2 = openLayerDb();
          const ostore2 = orc.createStore(odb2);
          const resumeAgent = async (taskGoal, subCtx) => agent.run(
            { goal: taskGoal, autonomy: String((await core.readSettings())?.agent?.autonomy || 'supervised') },
            (subCtx && typeof subCtx.emit === 'function') ? subCtx.emit : null,
            subCtx || {}
          );
          const runs = (ostore2.pendingRuns() || []).slice(0, cap);
          for (const r of runs) {
            try {
              const orch = new orc.Orchestrator({ store: ostore2, runAgent: resumeAgent, maxParallel: 2 });
              const out = await orch.resume(r.runId);
              console.log(`↻ استئناف تنفيذي: ${r.runId} — ${out && out.summary ? (out.summary.done + '/' + out.summary.total + ' منجزة') : 'تم'}`);
            } catch (e) { console.error(`تعذّر استئناف ${r.runId}:`, e.message); }
          }
        } catch (e) { console.error('تعذّر الاستئناف التنفيذي:', e.message); }
      }, 2500);
    }
  } catch (e) { console.error('تعذّر جدولة الاستئناف:', e.message); }

  startVaultWatcher();
  /* حارس البقاء الخارجي (عطل تجمّد مُقاس مرتين تحت الحِمل): عملية مستقلة تفحص
     /api/status كل 10ث وتعيد تشغيل المتجمد — الحلقة العالقة لا تشفي نفسها.
     عطل مُقاس 2026-10-28: كان يُطلق قبل listen وفي كل بيئة — فخادم فشل ربطه
     (أو خادم اختبار قُتل عمداً) خلّف حراساً يعيدون تشغيل فشل/قتل بلا نهاية
     (أشباح على منافذ ثابتة أفسدت اختبارات retrieval/import-deep). العقد الآن:
     لا حارس قبل استماع ناجح، ولا حارس في وضع الاختبار (القتل المتعمد فيها جزء
     من العقد — يبقى الحارس يخدم جمود المنتج فقط). */
  const bootWatchdog = () => {
    /* NODE_TEST_CONTEXT (يثبته مشغّل node:test في نسل الاختبارات — مُثبت عملياً
       أن الأبناء يرثونه عبر {...process.env}) يمنع الحارس في كل اختبار أياً كانت
       طريقة تشغيله؛ وCORTEX_NO_WATCHDOG صريحة لمن يشغّل الاختبارات بمشغّل آخر. */
    if (process.env.CORTEX_NO_WATCHDOG === '1' || process.env.CORTEX_TEST_MODE === '1' || process.env.NODE_TEST_CONTEXT) return;
    try {
      const wdPidFile = path.join(core.dataDir, 'watchdog.pid');
      let alive = false;
      try {
        const old = Number(require('fs').readFileSync(wdPidFile, 'utf8').trim());
        if (old) { process.kill(old, 0); alive = true; }
      } catch { alive = false; }
      if (!alive) {
        const wd = require('node:child_process').spawn(process.execPath, [path.join(PROJECT_ROOT, 'tools', 'watchdog.cjs'), '--pid', String(process.pid), '--port', String(PORT)], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
        wd.unref();
        try { require('fs').writeFileSync(wdPidFile, String(wd.pid), 'utf8'); } catch { /* تحسيني */ }
        console.log(`🛡 حارس البقاء يعمل (pid ${wd.pid}) — إعادة تشغيل ذاتية عند أي تجمّد`);
      }
    } catch (e) { console.error('تعذّر إقلاع حارس البقاء:', e.message); }
  };
  /* حارس الإطلاق المفتوح (2026-11-05): النظام محلي-أولاً — بلا HTTPS ولا مستخدمين
     متعددين ولا مصادقة مركزية. الربط على واجهة شبكة بلا عكسٍ آمن (reverse proxy)
     يعرّض الذاكرة والملفات لكل من يصل المنفذ. الرفض افتراضي، والتجاوز صريح. */
  const isLocalBind = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(HOST));
  if (!isLocalBind && process.env.CORTEX_ALLOW_REMOTE !== '1') {
    console.error(`\n[Cortex] رُفض الربط على ${HOST} — هذه نسخة محلية (127.0.0.1) بلا HTTPS ولا تعدد مستخدمين.`);
    console.error('[Cortex] للنشر الآمن: ضع عكسياً بـ HTTPS (Caddy/nginx) على 127.0.0.1 وأبقِ APP_HOST محلياً.');
    console.error('[Cortex] إن كنت تعرف ما تفعل: CORTEX_ALLOW_REMOTE=1 APP_HOST=0.0.0.0\n');
    process.exit(1);
  }
  if (require.main === module) server.listen(PORT, HOST, () => {
    /* إصلاح 2026-11-12: الرمز كان يُنشأ عند أول طلب فقط، فأي أداة محلية (اختبار،
       CLI، Electron) تقرأ data/session.token عند الإقلاع لا تجده — وتلجأ إلى
       /api/session الذي صار لا يخدم غير المتصفح. الإنشاء الآن عند الإقلاع:
       الحد الأمني هو الملف، ووجوده المسبق يجعل السلوك حتمياً. */
    try { ensureSessionToken(); } catch { /* القرص غير قابل للكتابة — يبقى في الذاكرة */ }
    console.log(`Cortex v5 على http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} — APP_ROOT=${WORK_ROOT}`); bootWatchdog();
    /* استدراك الإقلاع (2026-11-14): خزنة عاشت على علاقات مُمحاة تحتاج استنتاجاً
       واحداً بعد الإقلاع — بلا زر، وبلا انتظار إنسان. يُنفَّذ فقط إن لم توجد
       علاقة مُصنَّفة، فلا يتكرر على كل تشغيل. */
    setTimeout(() => {
      try {
        const db = layerDb();
        const typed = db ? db.prepare("SELECT COUNT(*) c FROM note_links WHERE origin IS NOT NULL AND origin NOT IN ('wikilink:auto','decision_project')").get().c : 0;
        if (!typed) scheduleRelationsInfer(3000);
      } catch { /* جدول غائب: أول تشغيل */ }
    }, 6000).unref?.();
  });
  server.on('error', err => {
    /* عطل مقيس 2026-11-15: كان `process.exit(0)` هنا — أي أن تعارض المنفذ
       (نسخة ثانية تعمل، أو منفذ محجوز) يُبلَّغ للمشغّل كـ«نجاح»، فلا يعيد
       supervisor.bat المحاولة ولا تعرف أي أداة أن الخادم لم يُقلع.
       الآن رمز الفشل صريح: EADDRINUSE = 2 (قابل لإعادة المحاولة، ومختلف عن 1
       الذي قد يُلتبس بالقتل على ويندوز). الإنهاء المتعمد يبقى رمز 0. */
    console.error('server error:', err.message);
    const code = err && err.code === 'EADDRINUSE' ? 2 : 1;
    process.exit(code);
  });
  // توليد وجدولة النبض — ومرة أولى عند الإقلاع مباشرة
  armScheduler();
  /* كانت النبضة تعمل بعد 1.5ث في كل إقلاع: تحليل كامل + موجز جديد (مُقاس: 21 موجزاً،
     14 ثانية CPU قبل إصلاح كاش الجُمل). العقد الآن: احترام الدورة المُعدّة،
     وschedule_hours = 0 تعطيل صريح. */
  /* النبضة الأولى بعد الإقلاع: عقد قائم (اختبار النبضة يفرضه) — الوكيل يعمل دون سؤال.
     الكلفة صارت ~0.6ث بعد كاش جُمل القرار، فلا حاجة لتأجيلها أو تعطيلها. */
  setTimeout(() => { schedulerTick('startup'); }, 1500);
});

module.exports = { server, core, fetchModels, callModel };
