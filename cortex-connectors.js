'use strict';

// ════════════════════════════════════════════════════════════════════
//  cortex-connectors — التكاملات المستهدفة واكتشاف القدرات الفعلية
//  (دستور §30 التكاملات المستهدفة + §31 قواعد التكامل)
//
//  القاعدة الحاكمة (§31/1): «ممنوع الاعتماد على أسماء التطبيقات وحدها».
//  لذلك لا تُشتق قدرة واحدة من معرّف التطبيق أو نوعه أو ادعاء المزوّد:
//  القدرات تُشتق حصراً من الأدوات التي أعادها المسبار المحقون (`probe`)
//  عبر خريطة صريحة `TOOL_CAPABILITY` (tool → capability). إن لم يصل
//  المسبار أو لم يُعد أداة واحدة ⇒ `capabilities` فارغة مع سبب صريح.
//
//  §31/2: ليست كل عملية تُنفَّذ في كل تطبيق ⇒ `compatibility` تقارن
//         المكتشَف فعلاً بالمطلوب وتُرصد النواقص.
//  §31/3: اتصال MCP لا يعني وصولاً لكل ملفات النظام ⇒ `allowedScope`
//         يبدأ من المجموعة الآمنة (safe فقط) ويتوسّع بما ورد صراحةً،
//         وdangerous لا تُمنح إلا بـ explicit:true.
//  §31/6: سجل يوضح الأدوات المستدعاة والنتائج والملفات التي تغيّرت
//         والعمليات التي تحتاج موافقة (`mcp_calls` + `audit_log`).
//
//  حتمي بحت: لا شبكة، لا نموذج، لا عشوائية، لا console.log.
//  المسبار يُحقن من الخارج، فالموديول قابل للاختبار بلا أي اتصال حقيقي.
// ════════════════════════════════════════════════════════════════════

const MCP_TABLE = 'mcp_calls';
const AUDIT_TABLE = 'audit_log';

// أنواع سطور التدقيق التي يرفعها هذا الموديول (§31/6)
const AUDIT_TYPE_CONNECTOR_TESTED = 'connector_tested';
const AUDIT_TYPE_APPROVAL_REQUIRED = 'connector_approval_required';

const DEFAULT_CALL_LIMIT = 50;
const MAX_CALL_LIMIT = 500;

// درجات الحساسية الثلاث المعتمدة
const SENSITIVITIES = Object.freeze(['safe', 'guarded', 'dangerous']);

// ─────────────────────────────────────────────────────────────────────
//  1) التكاملات المستهدفة (§30)
//  السجل وصفي فقط: لا يُستدل منه على قدرات. الهدف الوحيد منه أن نعرف
//  كيف نتصل، لا ماذا نستطيع أن نفعل — الفرق هو جوهر §31/1.
// ─────────────────────────────────────────────────────────────────────
const TARGETS = Object.freeze([
  Object.freeze({ id: 'opencode', ar: 'OpenCode', en: 'OpenCode', kind: 'coding-agent', transport: 'stdio' }),
  Object.freeze({ id: 'claude-code', ar: 'Claude Code', en: 'Claude Code', kind: 'coding-agent', transport: 'stdio' }),
  Object.freeze({ id: 'generic-mcp', ar: 'خادم MCP عام', en: 'Generic MCP server', kind: 'mcp-server', transport: 'mcp' }),
  Object.freeze({ id: 'custom-connector', ar: 'موصل متخصص', en: 'Custom connector', kind: 'custom', transport: 'custom' }),
]);

// ─────────────────────────────────────────────────────────────────────
//  2) القدرات المعيارية — تُكتشف فعلياً ولا تُفترض
//  `order` يضمن ترتيباً حتمياً في كل المخرجات (لا اعتماد على ترتيب الأدوات).
// ─────────────────────────────────────────────────────────────────────
const CAPABILITIES = Object.freeze({
  read_files: Object.freeze({
    ar: 'قراءة الملفات والمجلدات', en: 'Read files and folders', sensitivity: 'safe', order: 1,
  }),
  search: Object.freeze({
    ar: 'البحث في الملفات والمحتوى', en: 'Search files and content', sensitivity: 'safe', order: 2,
  }),
  provide_tools: Object.freeze({
    ar: 'تقديم أدوات للغير (تعريضها للاستدعاء)', en: 'Provide tools to others (expose for calling)', sensitivity: 'safe', order: 3,
  }),
  consume_tools: Object.freeze({
    ar: 'استدعاء أدوات الخارجية', en: 'Consume external tools', sensitivity: 'guarded', order: 4,
  }),
  run_tests: Object.freeze({
    ar: 'تشغيل الاختبارات', en: 'Run tests', sensitivity: 'guarded', order: 5,
  }),
  write_files: Object.freeze({
    ar: 'كتابة الملفات وتعديلها', en: 'Write and edit files', sensitivity: 'guarded', order: 6,
  }),
  exec_command: Object.freeze({
    ar: 'تنفيذ أوامر نظام', en: 'Execute system commands', sensitivity: 'dangerous', order: 7,
  }),
});

// ─────────────────────────────────────────────────────────────────────
//  الخريطة الصريحة الوحيدة: اسم أداة مُطبَّع → قدرة.
//  ما ليس هنا لا يُمنح قدرة؛ يُدرج في `unknownTools` ويُترك للمراجعة.
// ─────────────────────────────────────────────────────────────────────
const TOOL_CAPABILITY = Object.freeze({
  // قراءة الملفات والمجلدات
  read: 'read_files',
  read_file: 'read_files',
  read_files: 'read_files',
  read_text: 'read_files',
  readfile: 'read_files',
  read_many_files: 'read_files',
  view: 'read_files',
  view_file: 'read_files',
  open_file: 'read_files',
  cat: 'read_files',
  list_files: 'read_files',
  list_dir: 'read_files',
  list_directory: 'read_files',
  listdir: 'read_files',
  ls: 'read_files',
  tree: 'read_files',
  resources_list: 'read_files',
  resources_read: 'read_files',
  read_resource: 'read_files',
  fetch_resource: 'read_files',

  // بحث
  search: 'search',
  search_files: 'search',
  search_content: 'search',
  grep: 'search',
  ripgrep: 'search',
  rg: 'search',
  glob: 'search',
  glob_files: 'search',
  find: 'search',
  find_in_files: 'search',
  semantic_search: 'search',

  // تقديم أدوات (تعريض القدرات للغير)
  tools: 'provide_tools',
  tools_list: 'provide_tools',
  list_tools: 'provide_tools',
  get_tools: 'provide_tools',
  describe_tools: 'provide_tools',
  tools_describe: 'provide_tools',
  provide_tools: 'provide_tools',
  capabilities: 'provide_tools',

  // استدعاء أدوات الخارجية
  tools_call: 'consume_tools',
  call_tool: 'consume_tools',
  invoke_tool: 'consume_tools',
  run_tool: 'consume_tools',
  use_tool: 'consume_tools',
  consume_tools: 'consume_tools',
  mcp_call: 'consume_tools',

  // تشغيل الاختبارات
  test: 'run_tests',
  tests: 'run_tests',
  run_test: 'run_tests',
  run_tests: 'run_tests',
  test_runner: 'run_tests',
  pytest: 'run_tests',
  jest: 'run_tests',
  vitest: 'run_tests',
  npm_test: 'run_tests',

  // كتابة الملفات وتعديلها
  write: 'write_files',
  write_file: 'write_files',
  write_files: 'write_files',
  create_file: 'write_files',
  edit: 'write_files',
  edit_file: 'write_files',
  multi_edit: 'write_files',
  insert_edit: 'write_files',
  str_replace: 'write_files',
  str_replace_editor: 'write_files',
  apply_patch: 'write_files',
  patch: 'write_files',
  delete_file: 'write_files',
  move_file: 'write_files',
  rename_file: 'write_files',
  mkdir: 'write_files',

  // تنفيذ أوامر نظام
  exec: 'exec_command',
  exec_command: 'exec_command',
  run_command: 'exec_command',
  run: 'exec_command',
  shell: 'exec_command',
  bash: 'exec_command',
  sh: 'exec_command',
  cmd: 'exec_command',
  powershell: 'exec_command',
  terminal: 'exec_command',
  spawn: 'exec_command',
});

const ERR_BAD_DB = 'قاعدة بيانات غير صالحة — الكائن لا يحوي prepare()';
const ERR_BAD_PROBE = 'مسبار غير صالح: يجب حقن دالة probe(target)';
const ERR_NO_TOOLS = 'لم يُعد المسبار أي أداة — لا قدرات مشتقة من اسم التطبيق (§31/1)';
const ERR_NOT_REACHED = 'لم يصل المسبار إلى التكامل — لا قدرات مشتقة من اسم التطبيق (§31/1)';
// الترجمة الإنجليزية لأسباب الرفض — تُختار بلغة الطلب داخل discover
const ERR_EN = {
  [ERR_BAD_PROBE]: 'Invalid probe: a function probe(target) must be injected',
  [ERR_NO_TOOLS]: 'Probe returned no tool — no capabilities inferred from the app name (§31/1)',
  [ERR_NOT_REACHED]: 'Probe did not reach the integration — no capabilities inferred from the app name (§31/1)',
};

function nowIso() {
  return new Date().toISOString();
}

function isDb(db) {
  return !!db && typeof db.prepare === 'function';
}

/** فحص وجود جدول — لا نلمس قاعدة لم تُهاجَر. */
function hasTable(db, name) {
  if (!isDb(db)) return false;
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
    return !!row;
  } catch {
    return false;
  }
}

function toId(v) {
  return v === undefined || v === null ? null : Number(v);
}

/** تسلسل آمن: لا يُسقط العملية على قيمة غريبة، ولا يخترع قيمة. */
function json(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

/** فكّ تسلسل بلا رمي: قيمة غير صالحة تُعاد كما هي بدل كسر القراءة. */
function parse(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sensitivityOf(capability) {
  const entry = CAPABILITIES[capability];
  return entry ? entry.sensitivity : 'unknown';
}

function capabilityOf(toolName) {
  const key = normalizeToolName(toolName);
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, key) ? TOOL_CAPABILITY[key] : null;
}

/**
 * تطبيع اسم الأداة إلى مفتاح واحد حتمي:
 *  «mcp__filesystem__read_file» ← «read_file»،  «Tools/List» ← «tools_list».
 * التطبيع ضروري لأن المسبار قد يُعيد الاسم بأي شكل، والاعتماد على التفاصيل
 * الشكلية يجعل الاكتشاف هشاً لا خاطئاً.
 */
function normalizeToolName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (!s) return '';
  if (s.includes('__')) {
    const parts = s.split('__').filter(Boolean);
    if (parts.length) s = parts[parts.length - 1];
  }
  return s.replace(/[\s\-./:]+/g, '_').replace(/^_+|_+$/g, '');
}

/** ترتيب حتمي للقدرات بحسب `order` المعرّف في الكتالوج. */
function orderCapabilities(ids) {
  return [...new Set(ids)]
    .filter((id) => Object.prototype.hasOwnProperty.call(CAPABILITIES, id))
    .sort((a, b) => CAPABILITIES[a].order - CAPABILITIES[b].order);
}

/** تفصيل كل قدرة: عربي + حساسية — يُرفق في التقارير ليكون الفحص قابلاً للمراجعة. */
function detail(ids, lang) {
  const L = String(lang || '').toLowerCase();
  return orderCapabilities(ids).map((id) => ({
    id,
    ar: CAPABILITIES[id].ar,
    en: CAPABILITIES[id].en,
    label: L.startsWith('en') ? (CAPABILITIES[id].en || CAPABILITIES[id].ar) : CAPABILITIES[id].ar,
    sensitivity: CAPABILITIES[id].sensitivity,
  }));
}

function targetById(id) {
  return TARGETS.find((t) => t.id === id) || null;
}

/**
 * حلّ الهدف: معرّف معروف ⇒ وصفه، معرّف مجهول ⇒ هيكل «غير معروف».
 * ملاحظة دستورية: الهدف المجهول يُفحَص بالمسبار كما هو — لأن الحكم
 * على القدرات يأتي من الأداة لا من السجل (§31/1).
 */
function resolveTarget(target) {
  if (target && typeof target === 'object') {
    const id = typeof target.id === 'string' && target.id ? target.id : 'unknown';
    const known = targetById(id);
    return {
      id,
      ar: target.ar || (known ? known.ar : 'تكامل غير معروف'),
      en: target.en || (known ? known.en : 'Unknown integration'),
      kind: target.kind || (known ? known.kind : 'unknown'),
      transport: target.transport || (known ? known.transport : 'unknown'),
    };
  }
  const known = typeof target === 'string' ? targetById(target) : null;
  if (known) return { ...known };
  return {
    id: typeof target === 'string' && target ? target : 'unknown',
    ar: 'تكامل غير معروف',
    en: 'Unknown integration',
    kind: 'unknown',
    transport: 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────
//  3) discover — قدرات فعلية لا أسماء (§31/1، §31/2)
//  المسبار يُحقن: `probe(target) → { reached, tools[], resources[], error? }`
// ─────────────────────────────────────────────────────────────────────
function discover(probe, target, lang) {
  const descriptor = resolveTarget(target);
  const EN = String(lang || '').toLowerCase().startsWith('en');
  const say = (m) => (EN && ERR_EN[m] ? ERR_EN[m] : m);
  const report = {
    target: descriptor.id,
    ar: descriptor.ar,
    en: descriptor.en,
    label: EN ? (descriptor.en || descriptor.ar) : descriptor.ar,
    kind: descriptor.kind,
    transport: descriptor.transport,
    reached: false,
    capabilities: [],
    capabilityDetails: [],
    evidence: {},
    unknownTools: [],
    resources: [],
    discoveredAt: nowIso(),
    reason: null,
  };

  if (typeof probe !== 'function') {
    return { ...report, reason: say(ERR_BAD_PROBE) };
  }

  let res;
  try {
    res = probe(descriptor);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ...report, reason: EN ? `Probe failed: ${msg}` : `فشل المسبار: ${msg}` };
  }

  if (!res || typeof res !== 'object') {
    return { ...report, reason: EN ? 'Probe returned no valid result' : 'المسبار لم يُعد نتيجة صالحة' };
  }

  if (res.reached !== true) {
    return {
      ...report,
      reason: res.error ? `${say(ERR_NOT_REACHED)} (${res.error})` : say(ERR_NOT_REACHED),
    };
  }

  const tools = asArray(res.tools);
  const found = new Set();
  const evidence = {};
  const unknown = [];

  for (const raw of tools) {
    const name = normalizeToolName(raw);
    if (!name) continue;
    const cap = capabilityOf(name);
    if (!cap) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    found.add(cap);
    if (!evidence[cap]) evidence[cap] = [];
    // الدليل يحفظ كل اسم أداة كما ورد (بالمفتاح المطبَّع)، والتكرار يُمنع بالنص نفسه
    const label = typeof raw === 'string' ? raw.trim() : name;
    if (!evidence[cap].includes(label)) evidence[cap].push(label);
  }

  const capabilities = orderCapabilities([...found]);

  return {
    ...report,
    reached: true,
    capabilities,
    capabilityDetails: detail(capabilities, lang),
    evidence,
    // unknownTools مرتّبة نصياً: النتيجة نفسها لا تتغير بترتيب الأدوات الواردة
    unknownTools: unknown.sort(),
    resources: asArray(res.resources).map(String),
    reason: capabilities.length ? null : say(ERR_NO_TOOLS),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  4) compatibility — مقارنة المكتشَف بالمطلوب (§31/2)
//  `required` عنصر نصي أو كائن { id, approved }.
//  قدرة مطلوبة dangerous بلا موافقة ⇒ غير متوافق.
// ─────────────────────────────────────────────────────────────────────
function normalizeRequirements(required, approvals) {
  return asArray(required)
    .map((item) => {
      if (typeof item === 'string') return { id: item, approved: approvals.has(item) };
      if (item && typeof item === 'object') {
        const id = typeof item.id === 'string' ? item.id : (typeof item.capability === 'string' ? item.capability : null);
        if (!id) return null;
        const approved = item.approved === true || item.explicit === true || approvals.has(id);
        return { id, approved };
      }
      return null;
    })
    .filter(Boolean);
}

function compatibility(report, required) {
  const reached = !!(report && report.reached === true);
  const discovered = orderCapabilities(asArray(report && report.capabilities));
  const caps = new Set(discovered);
  const approvals = new Set(
    asArray(report && (report.approved || report.approvals)).map(String)
  );
  const wanted = normalizeRequirements(required, approvals);

  const missing = [];
  const needsApproval = [];
  for (const req of wanted) {
    if (!caps.has(req.id)) {
      if (!missing.includes(req.id)) missing.push(req.id);
      continue;
    }
    if (sensitivityOf(req.id) === 'dangerous' && req.approved !== true) {
      if (!needsApproval.includes(req.id)) needsApproval.push(req.id);
    }
  }

  const requestedIds = new Set(wanted.map((w) => w.id));
  const extra = discovered.filter((c) => !requestedIds.has(c));

  let verdict;
  if (!reached) {
    verdict = 'غير متوافق: التكامل لم يُصل إليه — لا حكم على قدرات لم تُكتشف';
  } else if (missing.length) {
    verdict = `غير متوافق: قدرات مطلوبة غير مكتشفة (${missing.join(', ')})`;
  } else if (needsApproval.length) {
    verdict = `متوافق شرطياً: قدرات حساسة تحتاج موافقة صريحة (${needsApproval.join(', ')})`;
  } else if (!wanted.length) {
    verdict = 'غير متوافق: لم تُطلب أي قدرة — لا توافق بلا مطلب';
  } else {
    verdict = 'متوافق: كل القدرات المطلوبة مكتشفة فعلياً';
  }

  return {
    compatible: reached && wanted.length > 0 && missing.length === 0 && needsApproval.length === 0,
    missing,
    extra,
    verdict,
    needsApproval,
    required: wanted.map((w) => w.id),
    discovered,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  5) allowedScope — لا وصول كامل (§31/3)
//  نبدأ من safe فقط، ونتوسّع بما ورد صراحةً في granted.
//  dangerous لا تُمنح إلا إن وردت صراحةً ومع explicit: true.
// ─────────────────────────────────────────────────────────────────────
function normalizeGrants(granted) {
  return asArray(granted)
    .map((item) => {
      if (typeof item === 'string') return { id: item, explicit: false };
      if (item && typeof item === 'object') {
        const id = typeof item.id === 'string' ? item.id : (typeof item.capability === 'string' ? item.capability : null);
        if (!id) return null;
        return { id, explicit: item.explicit === true };
      }
      return null;
    })
    .filter(Boolean);
}

function allowedScope(report, options = {}) {
  const discovered = orderCapabilities(asArray(report && report.capabilities));
  const granted = normalizeGrants(options.granted);

  const allowed = new Set(discovered.filter((c) => sensitivityOf(c) === 'safe'));
  const expanded = [];
  const blockedDangerous = [];
  const ungrantable = [];

  for (const grant of granted) {
    if (!discovered.includes(grant.id)) {
      if (!ungrantable.includes(grant.id)) ungrantable.push(grant.id);
      continue;
    }
    const sens = sensitivityOf(grant.id);
    if (sens === 'dangerous' && grant.explicit !== true) {
      if (!blockedDangerous.includes(grant.id)) blockedDangerous.push(grant.id);
      continue;
    }
    if (!allowed.has(grant.id)) {
      allowed.add(grant.id);
      expanded.push(grant.id);
    }
  }

  const allowedIds = orderCapabilities([...allowed]);
  const denied = discovered.filter((c) => !allowed.has(c));

  const parts = ['النطاق يبدأ آمناً: القدرات safe فقط تُمنح تلقائياً'];
  if (expanded.length) parts.push(`توسيع صريح: ${expanded.join(', ')}`);
  if (denied.length) parts.push(`ممنوع بلا منح صريح: ${denied.join(', ')}`);
  if (blockedDangerous.length) parts.push(`قدرات حساسة أُوقفت لغياب explicit: ${blockedDangerous.join(', ')}`);
  if (ungrantable.length) parts.push(`منح مستبعد لغياب القدرة المكتشفة: ${ungrantable.join(', ')}`);
  parts.push('لا وصول شامل: اتصال MCP لا يعني صلاحية كل ملفات النظام (§31/3)');

  return {
    allowed: allowedIds,
    denied,
    note: parts.join(' — '),
    expanded,
    blockedDangerous,
    ungrantable,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  سطر تدقيق — الحذف/التعديل مرفوضان بمحفّزات قاعدة البيانات (§38)
// ─────────────────────────────────────────────────────────────────────
function writeAudit(db, type, payload, extra = {}) {
  if (!hasTable(db, AUDIT_TABLE)) return { ok: false, id: null };
  try {
    const info = db
      .prepare(`INSERT INTO ${AUDIT_TABLE}(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)`)
      .run(
        extra.at || nowIso(),
        type,
        extra.scope === undefined ? null : extra.scope,
        extra.tool === undefined ? null : extra.tool,
        extra.actor || 'system',
        json(payload === undefined ? {} : payload)
      );
    return { ok: true, id: toId(info && info.lastInsertRowid) };
  } catch {
    return { ok: false, id: null };
  }
}

// ─────────────────────────────────────────────────────────────────────
//  6) testIntegration — الفحص موحّداً ثم يُسجَّل (§31/6)
// ─────────────────────────────────────────────────────────────────────
function testIntegration(db, target, options = {}) {
  const { probe, required, granted, lang } = options;
  const report = discover(probe, target, lang);
  const compat = compatibility(report, required);
  const scope = allowedScope(report, { granted });

  const audit = writeAudit(
    db,
    AUDIT_TYPE_CONNECTOR_TESTED,
    {
      targetId: report.target,
      reached: report.reached,
      compatible: compat.compatible,
      allowed: scope.allowed,
    },
    { scope: report.target, tool: 'testIntegration', actor: options.actor || 'system' }
  );

  return {
    target: report.target,
    ar: report.ar,
    en: report.en,
    label: report.label,
    kind: report.kind,
    transport: report.transport,
    reached: report.reached,
    discoveredAt: report.discoveredAt,
    reason: report.reason,
    capabilities: report.capabilities,
    capabilityDetails: report.capabilityDetails,
    evidence: report.evidence,
    unknownTools: report.unknownTools,
    resources: report.resources,
    compatible: compat.compatible,
    missing: compat.missing,
    extra: compat.extra,
    verdict: compat.verdict,
    needsApproval: compat.needsApproval,
    allowed: scope.allowed,
    denied: scope.denied,
    blockedDangerous: scope.blockedDangerous,
    note: scope.note,
    audited: audit.ok,
    auditId: audit.id,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  7) logCall — سجل الأدوات والنتائج والملفات المتغيرة والموافقات (§31/6)
// ─────────────────────────────────────────────────────────────────────
function logCall(db, call = {}) {
  if (!hasTable(db, MCP_TABLE)) {
    return { ok: false, reason: `جدول ${MCP_TABLE} غير موجود — شغّل cortex-schema.migrate(db) أولاً` };
  }
  const server = typeof call.server === 'string' ? call.server.trim() : '';
  const tool = typeof call.tool === 'string' ? call.tool.trim() : '';
  if (!server || !tool) {
    return { ok: false, reason: 'الحقلان server و tool مطلوبان لتسجيل نداء' };
  }

  const at = call.at || nowIso();
  const changedFiles = asArray(call.changedFiles).map(String);
  const needsApproval = call.needsApproval === true;
  const ok = call.ok === true;

  let id = null;
  try {
    const info = db
      .prepare(
        `INSERT INTO ${MCP_TABLE}(at, server, tool, args, result, ok, changed_files, needs_approval)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        at,
        server,
        tool,
        json(call.args === undefined ? null : call.args),
        json(call.result === undefined ? null : call.result),
        ok ? 1 : 0,
        json(changedFiles),
        needsApproval ? 1 : 0
      );
    id = toId(info && info.lastInsertRowid);
  } catch (e) {
    return { ok: false, reason: `فشل تسجيل النداء: ${e && e.message ? e.message : String(e)}` };
  }

  // العملية التي تحتاج موافقة لا تُترك في سجل الأدوات فقط: تُرفع لسجل التدقيق.
  let auditId = null;
  if (needsApproval) {
    const audit = writeAudit(
      db,
      AUDIT_TYPE_APPROVAL_REQUIRED,
      { server, tool, changedFiles, args: call.args === undefined ? null : call.args },
      { scope: server, tool, actor: call.actor || 'system', at }
    );
    auditId = audit.ok ? audit.id : null;
  }

  return { ok: true, id, at, changedFiles, needsApproval, callOk: ok, audited: auditId !== null, auditId };
}

/** سجل النداءات: الأدوات + النتائج + الملفات المتغيرة + ما يحتاج موافقة. */
function callLog(db, options = {}) {
  if (!hasTable(db, MCP_TABLE)) {
    return { count: 0, entries: [], pendingApproval: [], total: 0, reason: `جدول ${MCP_TABLE} غير موجود` };
  }
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_CALL_LIMIT)
    : DEFAULT_CALL_LIMIT;
  const server = typeof options.server === 'string' && options.server ? options.server : null;

  let rows = [];
  try {
    rows = server
      ? db.prepare(`SELECT * FROM ${MCP_TABLE} WHERE server = ? ORDER BY id DESC LIMIT ?`).all(server, limit)
      : db.prepare(`SELECT * FROM ${MCP_TABLE} ORDER BY id DESC LIMIT ?`).all(limit);
  } catch {
    rows = [];
  }

  const entries = rows.map((row) => ({
    id: toId(row.id),
    at: row.at,
    server: row.server,
    tool: row.tool,
    args: parse(row.args),
    result: parse(row.result),
    ok: row.ok === null || row.ok === undefined ? null : !!row.ok,
    changedFiles: asArray(parse(row.changed_files)).map(String),
    needsApproval: !!row.needs_approval,
  }));

  const totalRow = (() => {
    try {
      return server
        ? db.prepare(`SELECT COUNT(*) AS n FROM ${MCP_TABLE} WHERE server = ?`).get(server)
        : db.prepare(`SELECT COUNT(*) AS n FROM ${MCP_TABLE}`).get();
    } catch {
      return null;
    }
  })();

  return {
    count: entries.length,
    total: totalRow ? Number(totalRow.n) : entries.length,
    entries,
    pendingApproval: entries.filter((e) => e.needsApproval),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  9) summary — ملخص التكاملات المختبرة والموافقات المعلّقة
// ─────────────────────────────────────────────────────────────────────
function summary(db, options = {}) {
  const reports = asArray(options.reports).filter((r) => r && typeof r === 'object');
  const testedTargets = [...new Set(reports.map((r) => r.target).filter(Boolean))];
  const compatible = reports.filter((r) => r.compatible === true).length;
  const reached = reports.filter((r) => r.reached === true).length;

  let callsLogged = 0;
  const operationsNeedingApproval = [];
  if (hasTable(db, MCP_TABLE)) {
    try {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${MCP_TABLE}`).get();
      callsLogged = n ? Number(n.n) : 0;
    } catch {
      callsLogged = 0;
    }
    try {
      const rows = db
        .prepare(`SELECT id, at, server, tool, changed_files FROM ${MCP_TABLE} WHERE needs_approval = 1 ORDER BY id DESC LIMIT ?`)
        .all(MAX_CALL_LIMIT);
      for (const row of rows) {
        operationsNeedingApproval.push({
          id: toId(row.id),
          at: row.at,
          server: row.server,
          tool: row.tool,
          changedFiles: asArray(parse(row.changed_files)).map(String),
        });
      }
    } catch {
      /* قاعدة قديمة: لا نكسر الملخص */
    }
  }

  return {
    tested: reports.length,
    compatible,
    incompatible: reports.length - compatible,
    reached,
    unreached: reports.length - reached,
    testedTargets,
    callsLogged,
    needsApproval: operationsNeedingApproval.length,
    operationsNeedingApproval,
  };
}

module.exports = {
  TARGETS,
  CAPABILITIES,
  TOOL_CAPABILITY,
  SENSITIVITIES,
  AUDIT_TYPE_CONNECTOR_TESTED,
  AUDIT_TYPE_APPROVAL_REQUIRED,
  MCP_TABLE,
  AUDIT_TABLE,
  discover,
  compatibility,
  allowedScope,
  testIntegration,
  logCall,
  callLog,
  summary,
  // مساعدات مكشوفة للاختبار والاستخدام الخارجي
  normalizeToolName,
  capabilityOf,
  sensitivityOf,
  orderCapabilities,
  resolveTarget,
  writeAudit,
  hasTable,
};
