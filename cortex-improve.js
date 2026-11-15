'use strict';
const i18n = require('./cortex-i18n');
/**
 * Cortex — المحسّن الذاتي (Self-Improver)
 *
 * دورة تحسين منضبطة: قياس ← ضعف ← اقتراح ← تجربة معزولة ← معايير قبول ← اعتماد أو تراجع.
 * كل شيء حتمي: القياس والمقارنة والحكم بكود، لا بنموذج (دستور §26، §23/11، §35).
 *
 * ═══ محرم دستوري مطلق ═══
 * هذه الوحدة لا تغيّر سياسات أمان ولا صلاحيات، ولا تعتمد على أي منها لتشتغل.
 * كل مقترح يمسّ سياسة أمان أو صلاحية يُرفض صراحةً بسبب «مساس بالأمان ممنوع».
 * الوحدة لا تكتب إلا في ثلاثة جداول: self_eval، improvement_trials، audit_log.
 * ولا تلمس cortex-policy ولا أي جدول كيانات — اعتماد المقترح إعلان نيّة مسجَّل،
 * وتنفيذه الفعلي يبقى خارج هذه الوحدة وبمراجعة بشرية.
 *
 * بلا اعتماد خارجي وبلا console.
 */

// ─────────────────────────────────────────────────────────────────
// أدوات صغيرة حتمية
// ─────────────────────────────────────────────────────────────────

const DEFAULT_SCOPE = 'system';
const MAX_LIMIT = 200;

function nowIso() {
  return new Date().toISOString();
}

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

function lastId(res) {
  const v = res && res.lastInsertRowid;
  return v == null ? null : Number(v);
}

function safeJson(text, fallback = null) {
  if (text == null) return fallback;
  if (typeof text === 'object') return text;
  try {
    const v = JSON.parse(String(text));
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** تقريب حتمي بمنازل ثابتة — لا عشريات عائمة في التخزين */
function round(n, digits = 4) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  return Math.round((x + (x >= 0 ? 1 : -1) * Number.EPSILON) * f) / f;
}

/** قراءة زمن نصّي بلا اعتماد على منطقة زمنية محلية */
function parseTime(text) {
  if (!text) return null;
  let s = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) s += 'Z';
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeScope(scope) {
  const s = scope == null ? DEFAULT_SCOPE : String(scope).trim();
  return s ? s.slice(0, 120) : DEFAULT_SCOPE;
}

// ─────────────────────────────────────────────────────────────────
// 1) حارس الأمان — البوابة التي لا يمرّ منها مقترح يمسّ السياسة
// ─────────────────────────────────────────────────────────────────

// الأنماط الممنوعة: أي مصادفة في target/title/acceptance تُبطل المقترح.
const SECURITY_PATTERNS = Object.freeze([
  { label: 'policy', re: /\bpolicies\b|\bpolicy\b/i },
  { label: 'صلاحيات', re: /صلاحي/ },
  { label: 'permission', re: /\bpermissions?\b/i },
  { label: 'scope', re: /\bscopes?\b/i },
  { label: 'security', re: /\bsecurity\b/i },
  { label: 'أمان', re: /أمان|حماية\s+النظام/ },
  { label: 'auth', re: /\bauth(?:entication|orization)?\b|\bcredentials?\b/i },
  { label: 'privilege', re: /\bprivileges?\b|\bacls?\b/i },
  { label: 'bypass', re: /\bbypass\b|\boverride\b|تجاوز\s+(?:ال)?(?:صلاح|سياس|حدود)/ },
  { label: 'secrets', re: /\bsecrets?\b|الأسرار/ },
  { label: 'grant/deny', re: /\bgrants?\b|\bdeny\b|\brevoke\b/i },
  { label: 'موافقة/تصريح', re: /\bapprovals?\b|تصريح/ },
]);

const GUARD_FIELDS = Object.freeze(['target', 'title', 'acceptance']);

/**
 * يرفض أي مقترح يمسّ الأمان أو الصلاحيات — قرار حتمي بلا استثناء.
 * @returns {{allowed:boolean, reason:string, field:(string|null), pattern:(string|null)}}
 */
function guard(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return { allowed: false, reason: 'مقترح غير صالح', field: null, pattern: null };
  }
  for (const field of GUARD_FIELDS) {
    const raw = proposal[field];
    if (raw == null) continue;
    const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    for (const { label, re } of SECURITY_PATTERNS) {
      if (re.test(text)) {
        return {
          allowed: false,
          reason: `مساس بالأمان ممنوع: الحقل «${field}» يلامس «${label}» — المحسّن لا يغيّر سياسة أمان ولا صلاحية`,
          field,
          pattern: label,
        };
      }
    }
  }
  return { allowed: true, reason: '', field: null, pattern: null };
}

// ─────────────────────────────────────────────────────────────────
// 2) المقاييس — حساب صرف من الجداول، لا تخمين
// ─────────────────────────────────────────────────────────────────

const TERMINAL = new Set(['done', 'failed', 'blocked']);
const EVIDENCE_TYPES = new Set(['tool_result', 'task_evidence']);

const THRESHOLDS = Object.freeze({
  noEvidencePct: 20,      // أكثر من 20% مهام مكتملة بلا أثر أداة = مؤشر سلبي
  successRate: 0.8,       // أقل من 80% نجاح = ضعف
  slowTaskMs: 60000,      // متوسط زمن مهمة يتجاوز دقيقة = ضعف
});

function readTasks(db) {
  if (!hasTable(db, 'agent_tasks')) return [];
  try {
    return db.prepare('SELECT id, run_id, role, status, attempts, created_at, started_at, finished_at FROM agent_tasks').all();
  } catch { return []; }
}

function readEvidenceTaskIds(db) {
  const set = new Set();
  if (!hasTable(db, 'agent_events')) return set;
  try {
    const rows = db.prepare('SELECT task_id, type FROM agent_events').all();
    for (const r of rows) {
      if (r.task_id == null) continue;
      if (EVIDENCE_TYPES.has(String(r.type))) set.add(String(r.task_id));
    }
  } catch { /* سجل غير مقروء = بلا أدلة، وهو مؤشر سلبي مشروع */ }
  return set;
}

function readMcp(db) {
  if (!hasTable(db, 'mcp_calls')) return [];
  try { return db.prepare('SELECT tool, needs_approval FROM mcp_calls').all(); } catch { return []; }
}

/**
 * القياس الحتمي. يعيد أرقاماً فقط — كل مشتقة من صفوف الجداول.
 */
function measure(db, scope = DEFAULT_SCOPE) {
  const tasks = readTasks(db);
  const evidence = readEvidenceTaskIds(db);
  const mcp = readMcp(db);

  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const pending = tasks.filter((t) => !TERMINAL.has(String(t.status))).length;

  let durSum = 0;
  let durCount = 0;
  for (const t of tasks) {
    const a = parseTime(t.started_at);
    const b = parseTime(t.finished_at);
    if (a == null || b == null) continue;
    const ms = b - a;
    if (ms >= 0) { durSum += ms; durCount++; }
  }

  const runs = new Set(tasks.map((t) => String(t.run_id == null ? '' : t.run_id)));

  // مهمة «بلا أثر أداة»: أعلنت الاكتمال ولم تترك أي أثر في agent_events (دستور §8، §35)
  const withoutEvidence = tasks.filter((t) => t.status === 'done' && !evidence.has(String(t.id))).length;

  const approvalTools = new Set(
    mcp.filter((c) => Number(c.needs_approval) === 1).map((c) => String(c.tool))
  );
  const approvalCalls = mcp.filter((c) => Number(c.needs_approval) === 1).length;

  const total = tasks.length;
  return {
    scope: normalizeScope(scope),
    tasks: total,
    runs: runs.size,
    done,
    failed,
    blocked,
    pending,
    successRate: total ? round(done / total, 4) : 0,
    successRatePct: total ? round((done / total) * 100, 2) : 0,
    avgDurationMs: durCount ? Math.round(durSum / durCount) : 0,
    totalDurationMs: durSum,
    timedTasks: durCount,
    tasksWithoutEvidence: withoutEvidence,
    noEvidenceRatio: total ? round(withoutEvidence / total, 4) : 0,
    noEvidencePct: total ? round((withoutEvidence / total) * 100, 2) : 0,
    retriedTasks: tasks.filter((t) => Number(t.attempts || 0) > 1).length,
    mcpCalls: mcp.length,
    mcpApprovalTools: approvalTools.size,
    mcpApprovalCalls: approvalCalls,
  };
}

// ─────────────────────────────────────────────────────────────────
// 3) قواعد الضعف والاقتراح — صريحة، مقروءة، بلا نموذج
// ─────────────────────────────────────────────────────────────────

// كل ضعف: شرط صريح + عتبة معلنة + مرجع القياس.
const WEAKNESS_RULES = Object.freeze([
  {
    code: 'evidence_gap',
    severity: 'high',
    metric: 'noEvidenceRatio',
    threshold: `> ${THRESHOLDS.noEvidencePct}%`,
    test: (m) => m.tasks > 0 && m.noEvidencePct > THRESHOLDS.noEvidencePct,
    label: 'مهام مكتملة بلا أثر أداة',
    labelEn: 'Completed tasks without a tool trace',
    message: (m) => `${m.tasksWithoutEvidence} من ${m.tasks} مهمة أعلنت الاكتمال بلا أي أثر أداة (${m.noEvidencePct}%) — الحد المسموح ${THRESHOLDS.noEvidencePct}%`,
    messageEn: (m) => `${m.tasksWithoutEvidence} of ${m.tasks} tasks declared completion without any tool trace (${m.noEvidencePct}%) — allowed limit ${THRESHOLDS.noEvidencePct}%`,
  },
  {
    code: 'low_success_rate',
    severity: 'high',
    metric: 'successRate',
    threshold: `< ${THRESHOLDS.successRate}`,
    test: (m) => m.tasks > 0 && m.successRate < THRESHOLDS.successRate,
    label: 'نسبة نجاح منخفضة',
    labelEn: 'Low success rate',
    message: (m) => `نسبة النجاح ${m.successRatePct}% (${m.done} ناجحة، ${m.failed} فاشلة) — الحد الأدنى ${THRESHOLDS.successRate * 100}%`,
    messageEn: (m) => `Success rate ${m.successRatePct}% (${m.done} passed, ${m.failed} failed) — minimum ${THRESHOLDS.successRate * 100}%`,
  },
  {
    code: 'excessive_retries',
    severity: 'medium',
    metric: 'retriedTasks',
    threshold: '> 0',
    test: (m) => m.retriedTasks > 0,
    label: 'إعادة محاولة متكررة',
    labelEn: 'Repeated retries',
    message: (m) => `${m.retriedTasks} مهمة أُعيدت أكثر من مرة — التكرار يشير إلى عطل متجذّر لا إلى عارض`,
    messageEn: (m) => `${m.retriedTasks} task(s) retried more than once — repetition points to a deep fault, not a fluke`,
  },
  {
    code: 'mcp_approval_friction',
    severity: 'low',
    metric: 'mcpApprovalTools',
    threshold: '> 0',
    test: (m) => m.mcpApprovalTools > 0,
    label: 'أدوات MCP تحتاج تدخّلاً',
    labelEn: 'MCP tools need attention',
    message: (m) => `${m.mcpApprovalTools} أداة MCP تحتاج موافقة يدوية (${m.mcpApprovalCalls} نداء) — التحسين هنا في المعاينة قبل التنفيذ، لا في الحدود`,
    messageEn: (m) => `${m.mcpApprovalTools} MCP tool(s) need manual approval (${m.mcpApprovalCalls} call(s)) — the improvement is in preview-before-execution, not in limits`,
  },
  {
    code: 'slow_tasks',
    severity: 'medium',
    metric: 'avgDurationMs',
    threshold: `> ${THRESHOLDS.slowTaskMs}ms`,
    test: (m) => m.avgDurationMs > THRESHOLDS.slowTaskMs,
    label: 'زمن مهمة مرتفع',
    labelEn: 'High task duration',
    message: (m) => `متوسط زمن المهمة ${m.avgDurationMs}ms — أعلى من ${THRESHOLDS.slowTaskMs}ms`,
    messageEn: (m) => `Average task time ${m.avgDurationMs}ms — above ${THRESHOLDS.slowTaskMs}ms`,
  },
  {
    code: 'no_data',
    severity: 'low',
    metric: 'tasks',
    threshold: '= 0',
    test: (m) => m.tasks === 0,
    label: 'لا بيانات',
    labelEn: 'No data',
    message: () => 'لا مهام مسجّلة — لا أساس للقياس، ولا اقتراح بلا دليل',
    messageEn: () => 'No tasks recorded — no basis for measurement, and no proposal without evidence',
  },
]);

// كل اقتراح مصدره ضعف واحد: معايير القبول مقروءة كبيانات لا كلام.
const PROPOSAL_CATALOG = Object.freeze({
  'improv-evidence': {
    id: 'improv-evidence',
    title: 'إلزام أداة لكل مهمة',
    titleEn: 'Require a tool trace per task',
    target: 'agent:role-brief',
    acceptance: 'كل مهمة مكتملة تحمل أثر أداة واحداً على الأقل',
    acceptanceEn: 'Every completed task carries at least one tool trace',
    metric: 'noEvidenceRatio',
    direction: 'down',
    minDelta: null,
    minRelative: 0.5,
    impact: 90,
    fromWeakness: 'evidence_gap',
    reason: (m) => `${m.noEvidencePct}% من المهام مكتملة بلا أثر أداة — تعليمات الدور لا تُلزم باستخدام أداة`,
    reasonEn: (m) => `${m.noEvidencePct}% of tasks completed without a tool trace — the role brief does not require using a tool`,
  },
  'improv-success': {
    id: 'improv-success',
    title: 'معالجة أسباب فشل المهام قبل إعادة المحاولة',
    titleEn: 'Address task failure causes before retrying',
    target: 'agent:orchestrator',
    acceptance: 'نسبة النجاح ترتفع 10 نقاط مئوية على الأقل',
    acceptanceEn: 'Success rate rises by at least 10 percentage points',
    metric: 'successRate',
    direction: 'up',
    minDelta: 0.1,
    minRelative: null,
    impact: 80,
    fromWeakness: 'low_success_rate',
    reason: (m) => `نسبة النجاح ${m.successRatePct}% — ${m.failed} مهمة فاشلة بلا مسار تصحيح معلن`,
    reasonEn: (m) => `Success rate ${m.successRatePct}% — ${m.failed} failed task(s) with no declared fix path`,
  },
  'improv-retries': {
    id: 'improv-retries',
    title: 'ميزانية محاولات صريحة لكل مهمة',
    titleEn: 'Explicit attempt budget per task',
    target: 'agent:attempt-budget',
    acceptance: 'لا مهمة تتجاوز محاولتين، وكل تكرار يحمل سبباً مسجّلاً',
    acceptanceEn: 'No task exceeds two attempts, and every retry carries a recorded reason',
    metric: 'retriedTasks',
    direction: 'down',
    minDelta: 1,
    minRelative: null,
    impact: 60,
    fromWeakness: 'excessive_retries',
    reason: (m) => `${m.retriedTasks} مهمة أُعيدت أكثر من مرة — إعادة المحاولة بلا ميزانية تخفي العطل`,
    reasonEn: (m) => `${m.retriedTasks} task(s) retried more than once — retrying without a budget hides the defect`,
  },
  'improv-parallel': {
    id: 'improv-parallel',
    title: 'رفع التوازي للمهام المستقلّة',
    titleEn: 'Raise parallelism for independent tasks',
    target: 'agent:parallelism',
    acceptance: 'متوسط زمن المهمة ينخفض 20% على الأقل',
    acceptanceEn: 'Average task time drops by at least 20%',
    metric: 'avgDurationMs',
    direction: 'down',
    minDelta: null,
    minRelative: 0.2,
    impact: 50,
    fromWeakness: 'slow_tasks',
    reason: (m) => `متوسط زمن المهمة ${m.avgDurationMs}ms (${m.timedTasks} مهمة موقوتة) — التشغيل يبدو تسلسلياً`,
    reasonEn: (m) => `Average task time ${m.avgDurationMs}ms (${m.timedTasks} timed task(s)) — execution looks sequential`,
  },
  'improv-mcp-preview': {
    id: 'improv-mcp-preview',
    title: 'عرض أثر التغيير قبل تنفيذ أدوات MCP',
    titleEn: 'Show effect preview before executing MCP tools',
    target: 'mcp:dry-run',
    acceptance: 'كل أداة MCP خارجية تُعيد ملخّص أثر قبل التنفيذ',
    acceptanceEn: 'Every external MCP tool returns an effect summary before execution',
    metric: 'mcpApprovalTools',
    direction: 'down',
    minDelta: 1,
    minRelative: null,
    impact: 40,
    fromWeakness: 'mcp_approval_friction',
    reason: (m) => `${m.mcpApprovalTools} أداة MCP تحتاج تدخّلاً — المعاينة تقلّل التدخّل بلا مساس بأي حدّ`,
    reasonEn: (m) => `${m.mcpApprovalTools} MCP tool(s) need attention — preview reduces intervention without touching any limit`,
  },
});

/** الضعف ← المقترح: ربط صريح بالمعرّف، بلا استنتاج ضمني */
const WEAKNESS_TO_PROPOSAL = Object.freeze({
  evidence_gap: 'improv-evidence',
  low_success_rate: 'improv-success',
  excessive_retries: 'improv-retries',
  slow_tasks: 'improv-parallel',
  mcp_approval_friction: 'improv-mcp-preview',
});

function proposalFrom(catalogId, metrics, weakness, lang = 'ar') {
  const c = PROPOSAL_CATALOG[catalogId];
  if (!c) return null;
  /* القالب يولّد بلغة القارئ (نمط `E ? en : ar` المستعمل في cortex-core).
     سبب الإصلاح المقيس 2026-10-20: كانت عناوين المقترحات ومعايير القبول
     وأسبابها عربية دائماً، فتظهر داخل واجهة إنجليزية في «شاشة الحُكم» ويسقط
     تدقيق اللغة. اختيار اللغة يقع هنا (مصدر النص) لا في الواجهة، لأن ترجمة
     قوالب طويلة متغيّرة في الواجهة هشّة ولا تصمد. */
  const E = String(lang).toLowerCase().startsWith('en');
  const p = {
    id: c.id,
    title: E ? (c.titleEn || c.title) : c.title,
    target: c.target,
    acceptance: E ? (c.acceptanceEn || c.acceptance) : c.acceptance,
    reason: E ? (c.reasonEn ? c.reasonEn(metrics) : c.reason(metrics)) : c.reason(metrics),
    metric: c.metric,
    impact: c.impact,
    criteria: { metric: c.metric, direction: c.direction, minDelta: c.minDelta, minRelative: c.minRelative },
    weakness: { code: weakness.code, severity: weakness.severity, message: weakness.message },
  };
  const g = guard(p);
  p.allowed = g.allowed;
  p.rejectReason = g.allowed ? '' : g.reason;
  return p;
}

/** يقيس الضعف ويكشف المقترحات المشتقة — كل اقتراح مُدقَّق بحارس الأمان */
function derive(metrics, lang = 'ar') {
  const E = String(lang).toLowerCase().startsWith('en');
  const weaknesses = [];
  const proposals = [];
  for (const rule of WEAKNESS_RULES) {
    if (!rule.test(metrics)) continue;
    const weakness = {
      code: rule.code,
      severity: rule.severity,
      label: E ? (rule.labelEn || rule.label) : rule.label,
      message: E && rule.messageEn ? rule.messageEn(metrics) : rule.message(metrics),
      metric: rule.metric,
      value: metrics[rule.metric],
      threshold: rule.threshold,
    };
    weaknesses.push(weakness);
    const catalogId = WEAKNESS_TO_PROPOSAL[rule.code];
    if (!catalogId) continue; // ضعف بلا اقتراح (مثل «لا بيانات») — لا نقترح بلا أساس
    const p = proposalFrom(catalogId, metrics, weakness, lang);
    if (p) proposals.push(p);
  }
  proposals.sort((a, b) => (b.impact - a.impact) || String(a.id).localeCompare(String(b.id)));
  return { weaknesses, proposals };
}

// ─────────────────────────────────────────────────────────────────
// 4) التقييم الذاتي — يُحفظ في self_eval دائماً
// ─────────────────────────────────────────────────────────────────

function evaluate(db, { scope = DEFAULT_SCOPE, lang = 'ar' } = {}) {
  const sc = normalizeScope(scope);
  const metrics = measure(db, sc);
  const { weaknesses, proposals } = derive(metrics, lang);
  const at = nowIso();

  let id = null;
  try {
    const res = db.prepare(
      'INSERT INTO self_eval(at, scope, metrics, weaknesses, proposals) VALUES (?,?,?,?,?)'
    ).run(at, sc, JSON.stringify(metrics), JSON.stringify(weaknesses), JSON.stringify(proposals));
    id = lastId(res);
  } catch {
    // إن غاب الجدول لا نسقط التقييم: القياس نفسه قيمته قائمة.
    id = null;
  }

  // لا تغيير بلا أثر: كل تقييم يُسجَّل في سجل التدقيق المحمي (دستور §38)
  audit(db, {
    type: 'improvement_eval',
    scope: sc,
    tool: 'self_eval',
    actor: 'improve',
    payload: {
      evalId: id,
      tasks: metrics.tasks,
      successRatePct: metrics.successRatePct,
      noEvidencePct: metrics.noEvidencePct,
      retriedTasks: metrics.retriedTasks,
      mcpApprovalTools: metrics.mcpApprovalTools,
      weaknesses: weaknesses.map((w) => w.code),
      proposals: proposals.map((p) => p.id),
    },
  });

  return { ok: true, id, at, scope: sc, metrics, weaknesses, proposals };
}

// ─────────────────────────────────────────────────────────────────
// 5) الخطة — المقترحات مرتّبة بالأثر ومخزَّنة كتجارب «proposed»
// ─────────────────────────────────────────────────────────────────

function audit(db, { type, scope, tool = null, actor = null, payload = null } = {}) {
  try {
    db.prepare('INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
      .run(nowIso(), String(type), scope == null ? null : String(scope), tool == null ? null : String(tool),
           actor == null ? null : String(actor), payload == null ? null : JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** يفصل حقل «موافقة» عن مقترح وارد قبل التخزين — لا نحفظ لغة أمنية في أثر تجربة */
function storeProposalShape(proposal) {
  return {
    id: proposal.id,
    title: proposal.title,
    target: proposal.target,
    acceptance: proposal.acceptance,
    reason: proposal.reason,
    metric: proposal.metric,
    impact: proposal.impact == null ? null : Number(proposal.impact),
    weakness: proposal.weakness || null,
  };
}

function readTrial(db, id) {
  let r = null;
  try {
    r = db.prepare('SELECT * FROM improvement_trials WHERE id = ?').get(Number(id));
  } catch { return null; }
  if (!r) return null;
  const acc = safeJson(r.acceptance, {});
  return {
    id: r.id,
    at: r.created_at,
    proposal: safeJson(r.proposal, {}),
    target: r.target,
    acceptance: acc && typeof acc === 'object' ? acc : { text: String(r.acceptance || '') },
    acceptanceText: (acc && acc.text) || String(r.acceptance || ''),
    criteria: acc && typeof acc === 'object'
      ? { metric: acc.metric || null, direction: acc.direction || 'down', minDelta: acc.minDelta ?? null, minRelative: acc.minRelative ?? null }
      : { metric: null, direction: 'down', minDelta: null, minRelative: null },
    baseline: safeJson(r.baseline, null),
    trialResult: safeJson(r.trial_result, null),
    verdict: r.verdict == null ? null : String(r.verdict),
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    applied: Number(r.applied || 0) === 1,
  };
}

/**
 * يحوّل مقترحاً إلى تجربة في القاعدة: «proposed» إن مرّ من الحارس، و«rejected» إن مسّ الأمان.
 * @returns {{allowed:boolean, reason:string, trialId:(number|null), trial:(object|null)}}
 */
function admitProposal(db, proposal, scope = DEFAULT_SCOPE) {
  const sc = normalizeScope(scope);
  const g = guard(proposal);
  const at = nowIso();
  const acceptance = JSON.stringify({
    text: proposal && proposal.acceptance ? String(proposal.acceptance) : '',
    metric: (proposal && proposal.metric) || null,
    direction: (proposal && proposal.criteria && proposal.criteria.direction) || 'down',
    minDelta: (proposal && proposal.criteria && proposal.criteria.minDelta != null) ? Number(proposal.criteria.minDelta) : null,
    minRelative: (proposal && proposal.criteria && proposal.criteria.minRelative != null) ? Number(proposal.criteria.minRelative) : null,
  });

  // الأساس يُلتقط عند التخطيط: قيمة المقياس وقت الاقتراح، لا تقدير لاحق
  const baseVal = proposal && proposal.baselineValue != null && Number.isFinite(Number(proposal.baselineValue))
    ? Number(proposal.baselineValue)
    : null;
  const baseline = baseVal == null
    ? null
    : JSON.stringify({ metric: (proposal && proposal.metric) || null, value: baseVal, at });

  /* منع التكرار (عطل مقيس 2026-11-13: نداء plan مرتين ضاعف التجارب 2→4):
     المقترح المعلَّق **أو المقيس المنتظر قراراً** لا يُقترح مرة أخرى — وإلا
     امتلأ الجدول بنسخ متطابقة تنتظر نفس القرار. بعد الحسم (accepted/reverted)
     يُسمح بإعادة الطرح. */
  const dupTarget = String((proposal && proposal.target) || '');
  const dupId = proposal && proposal.id ? String(proposal.id) : '';
  if (dupTarget && dupId) {
    const open = db.prepare(
      "SELECT id, verdict FROM improvement_trials WHERE verdict IN ('proposed','trialed') AND target = ? AND proposal LIKE ? ORDER BY id LIMIT 1"
    ).get(dupTarget, `%"id":"${dupId}"%`);
    if (open) {
      return {
        allowed: false,
        reason: i18n.T(`مقترح معلّق بالفعل (تجربة #${open.id}) — لا تكرار`, `Proposal already pending (trial #${open.id}) — no duplicate`),
        trialId: open.id,
        trial: null,
      };
    }
  }

  let trialId = null;
  try {
    const res = db.prepare(
      'INSERT INTO improvement_trials(created_at, proposal, target, acceptance, baseline, trial_result, verdict, applied) VALUES (?,?,?,?,?,?,?,0)'
    ).run(
      at,
      JSON.stringify(storeProposalShape(proposal || {})),
      String((proposal && proposal.target) || ''),
      acceptance,
      baseline,
      g.allowed ? null : JSON.stringify({ rejected: true, reason: g.reason, field: g.field, at }),
      g.allowed ? 'proposed' : 'rejected'
    );
    trialId = lastId(res);
  } catch {
    trialId = null;
  }

  audit(db, {
    type: g.allowed ? 'improvement_proposed' : 'improvement_rejected',
    scope: sc,
    tool: proposal && proposal.target ? proposal.target : null,
    actor: 'improve',
    payload: { proposalId: proposal && proposal.id ? proposal.id : null, trialId, allowed: g.allowed, reason: g.reason },
  });

  return { allowed: g.allowed, reason: g.reason, trialId, trial: trialId == null ? null : readTrial(db, trialId) };
}

function plan(db, { scope = DEFAULT_SCOPE } = {}) {
  const sc = normalizeScope(scope);
  const evaluation = evaluate(db, { scope: sc });
  const ordered = [...evaluation.proposals].sort((a, b) => (b.impact - a.impact) || String(a.id).localeCompare(String(b.id)));

  const proposals = [];
  const trials = [];
  const rejected = [];
  for (const p of ordered) {
    const admitted = admitProposal(db, { ...p, baselineValue: evaluation.metrics[p.metric] }, sc);
    const entry = { ...p, trialId: admitted.trialId, allowed: admitted.allowed, rejectReason: admitted.allowed ? '' : admitted.reason };
    if (admitted.allowed) { proposals.push(entry); trials.push(admitted.trial); }
    else rejected.push(entry);
  }

  return {
    ok: true,
    scope: sc,
    at: evaluation.at,
    evalId: evaluation.id,
    metrics: evaluation.metrics,
    weaknesses: evaluation.weaknesses,
    proposals: proposals.concat(rejected), // مرتبة بالأثر: المقبولة أولاً
    trials,
    rejected,
  };
}

// ─────────────────────────────────────────────────────────────────
// 6) التجربة المعزولة — measure تُحقن، والحكم بمعيار القبول
// ─────────────────────────────────────────────────────────────────

// بصمة حالة: تُقاس قبل التجربة وبعدها. تغيّرها = التجربة لوّثت القاعدة ⇒ ترفض.
const STATE_PROBES = Object.freeze([
  ['agent_tasks', 'SELECT status AS k, COUNT(*) AS n, COALESCE(SUM(COALESCE(attempts,0)),0) AS a FROM agent_tasks GROUP BY status'],
  ['agent_events', 'SELECT type AS k, COUNT(*) AS n, 0 AS a FROM agent_events GROUP BY type'],
  ['mcp_calls', 'SELECT (tool || \':\' || COALESCE(ok,-1)) AS k, COUNT(*) AS n, 0 AS a FROM mcp_calls GROUP BY tool, ok'],
  ['model_usage', 'SELECT (provider || \':\' || model) AS k, COUNT(*) AS n, 0 AS a FROM model_usage GROUP BY provider, model'],
  ['self_eval', 'SELECT scope AS k, COUNT(*) AS n, COALESCE(MAX(id),0) AS a FROM self_eval GROUP BY scope'],
  ['improvement_trials', 'SELECT (COALESCE(verdict,\'-\') || \':\' || COALESCE(applied,0)) AS k, COUNT(*) AS n, 0 AS a FROM improvement_trials GROUP BY verdict, applied'],
]);

function stateFingerprint(db) {
  const parts = [];
  for (const [table, sql] of STATE_PROBES) {
    if (!hasTable(db, table)) { parts.push(`${table}:-`); continue; }
    let rows = [];
    try { rows = db.prepare(sql).all(); } catch { rows = []; }
    const norm = rows.map((r) => [String(r.k == null ? '' : r.k), Number(r.n) || 0, Number(r.a) || 0]);
    parts.push(`${table}:${JSON.stringify(norm)}`);
  }
  return parts.join('|');
}

/** يحكم على القياس مقابل الأساس وفق معايير القبول المُشتقة من الاقتراح */
function judge(criteria, value, baseline) {
  const direction = criteria && criteria.direction === 'up' ? 'up' : 'down';
  const abs = round(value - baseline, 6);
  const rel = baseline !== 0 ? round((value - baseline) / Math.abs(baseline), 6) : null;
  const gain = direction === 'up' ? abs : -abs;
  const relGain = rel == null ? null : (direction === 'up' ? rel : -rel);
  const minDelta = criteria && criteria.minDelta != null && Number.isFinite(Number(criteria.minDelta)) ? Number(criteria.minDelta) : null;
  const minRelative = criteria && criteria.minRelative != null && Number.isFinite(Number(criteria.minRelative)) ? Number(criteria.minRelative) : null;

  let passed;
  if (minDelta == null && minRelative == null) passed = gain > 0;
  else {
    const byDelta = minDelta != null && gain >= minDelta;
    const byRelative = minRelative != null && relGain != null && relGain >= minRelative;
    passed = byDelta || byRelative;
  }

  return {
    passed: !!passed,
    better: gain > 0,
    delta: { absolute: abs, relative: rel, gain: round(gain, 6), direction },
  };
}

/**
 * يشغّل التجربة في بيئة معزولة: measure() تُحقن ولا تصل إلى قاعدة البيانات،
 * وبصمة الحالة تُقارَن قبل/بعد فلا يمرّ قياس لوّث الواقع.
 * @returns {Promise<{ok:boolean, trialId:(number|null), verdict:(string|null), trialResult:(object|null), delta:(object|null), error?:string}>}
 */
async function runTrial(db, trialId, { baselineValue = null, measure: measureFn = null } = {}) {
  const row = readTrial(db, trialId);
  if (!row) return { ok: false, trialId: null, verdict: null, trialResult: null, delta: null, error: i18n.T('التجربة غير موجودة', 'Trial not found') };
  if (row.verdict !== 'proposed') {
    return {
      ok: false, trialId: row.id, verdict: row.verdict, trialResult: row.trialResult, delta: null,
      error: row.verdict === 'rejected'
        ? 'المقترح مرفوض (مساس بالأمان) — لا تجربة عليه'
        : `التجربة محسومة بحالة «${row.verdict}» — لا تُعاد`,
    };
  }
  if (typeof measureFn !== 'function') {
    return { ok: false, trialId: row.id, verdict: row.verdict, trialResult: null, delta: null, error: 'measure دالة محقونة مطلوبة' };
  }

  const stored = row.baseline && row.baseline.value != null ? Number(row.baseline.value) : null;
  const before = baselineValue != null && Number.isFinite(Number(baselineValue))
    ? Number(baselineValue)
    : (stored != null && Number.isFinite(stored) ? stored : null);
  if (before == null) {
    return { ok: false, trialId: row.id, verdict: row.verdict, trialResult: null, delta: null, error: 'لا أساس للمقارنة — baselineValue مطلوب' };
  }

  const criteria = Object.freeze({
    metric: row.criteria.metric,
    direction: row.criteria.direction,
    minDelta: row.criteria.minDelta,
    minRelative: row.criteria.minRelative,
  });
  const ctx = Object.freeze({
    trialId: row.id,
    proposal: Object.freeze({ ...(row.proposal || {}) }),
    metric: criteria.metric,
    baseline: before,
    criteria,
  });

  const beforeState = stateFingerprint(db);
  let value = null;
  let thrown = null;
  try {
    const raw = await measureFn(ctx);
    value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  } catch (e) {
    thrown = e && e.message ? e.message : String(e);
  }
  const afterState = stateFingerprint(db);
  const executedAt = nowIso();

  let trialResult;
  if (thrown) {
    trialResult = { ok: false, executedAt, metric: criteria.metric, baseline: before, value: null, error: thrown, isolation: beforeState === afterState ? 'ok' : 'violated' };
    db.prepare('UPDATE improvement_trials SET baseline=?, trial_result=? WHERE id=?')
      .run(JSON.stringify({ metric: criteria.metric, value: before, at: executedAt }), JSON.stringify(trialResult), row.id);
    return { ok: false, trialId: row.id, verdict: 'proposed', trialResult, delta: null, error: `فشل القياس: ${thrown}` };
  }
  if (beforeState !== afterState) {
    trialResult = { ok: false, executedAt, metric: criteria.metric, baseline: before, value, isolation: 'violated', error: 'انتهاك العزل: التجربة غيّرت حالة القاعدة' };
    db.prepare('UPDATE improvement_trials SET baseline=?, trial_result=? WHERE id=?')
      .run(JSON.stringify({ metric: criteria.metric, value: before, at: executedAt }), JSON.stringify(trialResult), row.id);
    return { ok: false, trialId: row.id, verdict: 'proposed', trialResult, delta: null, error: 'انتهاك العزل: التجربة غيّرت حالة القاعدة — ترفض' };
  }

  const num = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(num)) {
    trialResult = { ok: false, executedAt, metric: criteria.metric, baseline: before, value: null, isolation: 'ok', error: 'قياس غير رقمي' };
    db.prepare('UPDATE improvement_trials SET baseline=?, trial_result=? WHERE id=?')
      .run(JSON.stringify({ metric: criteria.metric, value: before, at: executedAt }), JSON.stringify(trialResult), row.id);
    return { ok: false, trialId: row.id, verdict: 'proposed', trialResult, delta: null, error: 'قياس غير رقمي — لا حكم بلا رقم' };
  }

  const verdict = judge(criteria, num, before);
  trialResult = {
    ok: true,
    executedAt,
    metric: criteria.metric,
    direction: criteria.direction,
    baseline: before,
    value: num,
    passed: verdict.passed,
    better: verdict.better,
    delta: verdict.delta,
    criteria: { minDelta: criteria.minDelta, minRelative: criteria.minRelative },
    isolation: 'ok',
  };

  const res = db.prepare(
    "UPDATE improvement_trials SET baseline=?, trial_result=?, verdict='trialed' WHERE id=? AND verdict='proposed'"
  ).run(JSON.stringify({ metric: criteria.metric, value: before, at: executedAt }), JSON.stringify(trialResult), row.id);
  if (!res || Number(res.changes) !== 1) {
    return { ok: false, trialId: row.id, verdict: row.verdict, trialResult, delta: verdict.delta, error: 'التجربة تغيّرت أثناء القياس — أُلغيت الكتابة' };
  }

  audit(db, {
    type: 'improvement_trial', scope: DEFAULT_SCOPE, tool: row.target, actor: 'improve',
    payload: { trialId: row.id, metric: criteria.metric, baseline: before, value: num, passed: verdict.passed },
  });

  return { ok: true, trialId: row.id, verdict: 'trialed', trialResult, delta: verdict.delta };
}

// ─────────────────────────────────────────────────────────────────
// 7) الاعتماد أو التراجع — بشرط تجربة مُنجزة وتفوّق مُثبَت
// ─────────────────────────────────────────────────────────────────

function decide(db, trialId, { accept = false, by = null } = {}) {
  const row = readTrial(db, trialId);
  if (!row) return { ok: false, verdict: null, error: i18n.T('التجربة غير موجودة', 'Trial not found') };

  if (row.verdict !== 'trialed') {
    const why = row.verdict === 'proposed'
      ? 'لا اعتماد قبل التجربة — شغّل runTrial أولاً'
      : row.verdict === 'rejected'
        ? 'المقترح مرفوض (مساس بالأمان ممنوع) — لا اعتماد'
        : `التجربة محسومة مسبقاً بحالة «${row.verdict}»`;
    return { ok: false, verdict: row.verdict, error: why };
  }

  const at = nowIso();
  const who = by == null ? 'unspecified' : String(by).slice(0, 120);
  const tr = row.trialResult && typeof row.trialResult === 'object' ? row.trialResult : {};

  if (accept === true) {
    if (tr.passed !== true) {
      audit(db, {
        type: 'improvement_decision', scope: DEFAULT_SCOPE, tool: row.target, actor: who,
        payload: { trialId: row.id, accept: true, ok: false, error: 'التجربة ليست أفضل من الأساس' },
      });
      return {
        ok: false, verdict: 'trialed', delta: tr.delta || null,
        error: 'التجربة ليست أفضل من الأساس — الاعتماد مرفوض',
      };
    }
    const res = db.prepare(
      "UPDATE improvement_trials SET verdict='accepted', decided_at=?, decided_by=? WHERE id=? AND verdict='trialed'"
    ).run(at, who, row.id);
    if (!res || Number(res.changes) !== 1) return { ok: false, verdict: row.verdict, error: 'تعذّر الاعتماد — الحالة تغيّرت' };
    audit(db, {
      type: 'improvement_decision', scope: DEFAULT_SCOPE, tool: row.target, actor: who,
      payload: { trialId: row.id, accept: true, ok: true, verdict: 'accepted', delta: tr.delta || null },
    });
    return { ok: true, verdict: 'accepted', decidedAt: at, decidedBy: who, delta: tr.delta || null, trial: readTrial(db, row.id) };
  }

  const res = db.prepare(
    "UPDATE improvement_trials SET verdict='reverted', decided_at=?, decided_by=? WHERE id=? AND verdict='trialed'"
  ).run(at, who, row.id);
  if (!res || Number(res.changes) !== 1) return { ok: false, verdict: row.verdict, error: 'تعذّر التراجع — الحالة تغيّرت' };
  audit(db, {
    type: 'improvement_decision', scope: DEFAULT_SCOPE, tool: row.target, actor: who,
    payload: { trialId: row.id, accept: false, ok: true, verdict: 'reverted' },
  });
  return { ok: true, verdict: 'reverted', decidedAt: at, decidedBy: who, trial: readTrial(db, row.id) };
}

/** التطبيق إعلان نيّة مسجَّل — لا يُسمح قبل الاعتماد، والوحدة لا تعدّل شيئاً غيره */
function markApplied(db, trialId) {
  const row = readTrial(db, trialId);
  if (!row) return { ok: false, applied: false, error: i18n.T('التجربة غير موجودة', 'Trial not found') };
  if (row.verdict !== 'accepted') {
    return { ok: false, applied: row.applied, verdict: row.verdict, error: 'لا تطبيق قبل الاعتماد — اخترع مقترحاً معتمداً أولاً' };
  }
  if (row.applied) return { ok: true, applied: true, already: true, verdict: 'accepted' };

  const res = db.prepare("UPDATE improvement_trials SET applied=1 WHERE id=? AND verdict='accepted' AND applied=0").run(row.id);
  if (!res || Number(res.changes) !== 1) return { ok: false, applied: false, verdict: row.verdict, error: 'تعذّر التطبيق' };
  audit(db, {
    type: 'improvement_applied', scope: DEFAULT_SCOPE, tool: row.target, actor: row.decidedBy || 'unspecified',
    payload: { trialId: row.id, verdict: 'accepted' },
  });
  return { ok: true, applied: true, verdict: 'accepted', trial: readTrial(db, row.id) };
}

// ─────────────────────────────────────────────────────────────────
// 8) التاريخ — آخر المقترحات وحالاتها
// ─────────────────────────────────────────────────────────────────

function history(db, limit = 50) {
  if (!hasTable(db, 'improvement_trials')) return [];
  const lim = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), MAX_LIMIT) : 50;
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM improvement_trials ORDER BY id DESC LIMIT ?').all(lim);
  } catch { return []; }
  return rows.map((r) => {
    const t = readTrial(db, r.id);
    return {
      id: t.id,
      at: t.at,
      proposal: t.proposal,
      title: (t.proposal && t.proposal.title) || null,
      target: t.target,
      acceptance: t.acceptanceText,
      baseline: t.baseline,
      trialResult: t.trialResult,
      verdict: t.verdict,
      decidedAt: t.decidedAt,
      decidedBy: t.decidedBy,
      applied: t.applied,
    };
  });
}

module.exports = {
  // الواجهة المطلوبة
  evaluate,
  plan,
  runTrial,
  decide,
  markApplied,
  guard,
  history,
  // أجزاء مفيدة للاختبار والواجهة — كلها حتمية
  measure,
  derive,
  judge,
  admitProposal,
  stateFingerprint,
  readTrial,
  audit,
  // ثوابت معلنة
  DEFAULT_SCOPE,
  THRESHOLDS,
  WEAKNESS_RULES,
  PROPOSAL_CATALOG,
  WEAKNESS_TO_PROPOSAL,
  SECURITY_PATTERNS,
  TERMINAL,
};
