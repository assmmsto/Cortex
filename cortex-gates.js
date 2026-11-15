'use strict';
/**
 * Cortex — آلة المراحل الثمانية وبوابات منع الإطلاق (دستور §42، §43، §45)
 *
 * القرار هنا حتمي بالكود وحده: لا استدعاء نموذج ولا شبكة (§35).
 * ما يُقرأ من النموذج يُقدَّم عبر `probes` كدليل مُدخَل، ولا يُخترع هنا.
 *
 * القاعدتان الحاسمتان:
 *   1) لا تُفتح مرحلة قبل أن تُثبت التي قبلها (§42).
 *   2) لا إطلاق إن لم تجُز البوابات التسع كلها؛ و`rollback_proven` و`backup_restorable`
 *      يُفشل صراحةً إن لم يُقدَّم دليل تراجع — لا ادعاء نجاح (§38، §45).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { STAGES, RELEASE_GATES, tableExists, tableColumns } = require('./cortex-schema');
const i18n = require('./cortex-i18n');

// حالات المرحلة المقبولة — ما عدا ذلك يُقرأ «مقفلة»
const STAGE_STATUSES = Object.freeze(['locked', 'proven']);

// حالات مهام الوكيل المعتمدة (§36): queued/running/done/failed/blocked
const TASK_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed', 'blocked']);

// الحالة التي تعود إليها المهمة عند استعادتها — مسار requeue
const RECOVERABLE_STATUS = 'queued';

// أنماط أنواع سجل تدعم قراءة «هل نُفِّذ هذا الملف؟»
const EXEC_TYPES = Object.freeze(['exec', 'execute', 'shell_exec', 'run', 'command', 'exec_command']);

const STAGE_BY_KEY = new Map(STAGES.map((s) => [s.key, s]));
const GATE_KEYS = Object.freeze(RELEASE_GATES.map((g) => g.key));

// نص الرفض الصريح لبوابة التراجع — لا يُستبدل بادعاء نجاح
const NO_ROLLBACK_DETAIL = i18n.T('لم يُقدَّم دليل التراجع', 'No rollback evidence provided');

// ─────────────────────────── أدوات صغيرة ───────────────────────────

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return undefined; }
}

/** يوحّد الدليل إلى نص مخزَّن أو null — لا دليل فارغ */
function normalizeEvidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'object') {
    try {
      const t = JSON.stringify(value);
      return t && t !== '{}' && t !== '[]' ? t : null;
    } catch { return null; }
  }
  const t = String(value).trim();
  return t ? t : null;
}

function nowIso() {
  return new Date().toISOString();
}

// ═══════════════════════════ 1) آلة المراحل ═══════════════════════════

/**
 * حالة المراحل الثماني، وأي مرحلة يجوز فتحها تالياً.
 * لا تُعدّ مرحلة قابلةً للفتح إلا إذا كانت السابقة مُثبتة (§42).
 * @returns {{stages:Array, next:(string|null), proven:number, total:number, complete:boolean}}
 */
function evaluateStage(db, lang = i18n.lang()) {
  const rows = db.prepare(
    'SELECT stage, n, status, evidence, proven_at FROM stage_state ORDER BY n'
  ).all();
  const byKey = new Map(rows.map((r) => [r.stage, r]));

  const stages = [];
  let next = null;
  let predecessorProven = true; // المرحلة 1 لا سابقة لها

  for (const st of STAGES) {
    const row = byKey.get(st.key) || null;
    const status = row && STAGE_STATUSES.includes(row.status) ? row.status : 'locked';
    const proven = status === 'proven';
    const canOpen = !proven && predecessorProven;
    if (canOpen && next === null) next = st.key;

    stages.push({
      n: st.n,
      key: st.key,
      name: i18n.T(st.ar, st.en || st.ar),
      status,
      proven,
      evidence: row ? (row.evidence || null) : null,
      provenAt: row ? (row.proven_at || null) : null,
      canOpen,
    });

    predecessorProven = predecessorProven && proven;
  }

  const provenCount = stages.filter((s) => s.proven).length;
  return {
    stages,
    next,
    proven: provenCount,
    total: STAGES.length,
    complete: provenCount === STAGES.length,
  };
}

/**
 * يفتح مرحلة **فقط** إذا كانت السابقة مُثبتة، ودليلٌ صريح مُقدَّم.
 * يرفض خلاف ذلك برسالة واضحة (يرمي خطأً يحمل `code`).
 * يكتب status='proven' + evidence + proven_at.
 * @returns {{ok:true, stage:string, n:number, ar:string, status:'proven', evidence:string, provenAt:string}}
 */
function proveStage(db, stageKey, options = {}) {
  const stage = STAGE_BY_KEY.get(stageKey);
  if (!stage) {
    const e = new Error(i18n.T(`مرحلة غير معروفة: «${stageKey}»`, `Unknown stage: "${stageKey}"`));
    e.code = 'UNKNOWN_STAGE';
    throw e;
  }

  const evidence = normalizeEvidence(options.evidence);
  if (!evidence) {
    const e = new Error(i18n.T(`لا إثبات بلا دليل: المرحلة «${stage.ar}» تحتاج دليلاً صريحاً`, `No proof without evidence: stage "${stage.en}" needs explicit evidence`));
    e.code = 'NO_EVIDENCE';
    throw e;
  }

  const row = db.prepare('SELECT status FROM stage_state WHERE stage = ?').get(stageKey);
  const status = row && STAGE_STATUSES.includes(row.status) ? row.status : 'locked';
  if (status === 'proven') {
    const e = new Error(i18n.T(`المرحلة «${stage.ar}» مُثبتة مسبقاً (${stageKey})`, `Stage "${stage.en}" is already proven (${stageKey})`));
    e.code = 'ALREADY_PROVEN';
    throw e;
  }

  if (stage.n > 1) {
    const prev = STAGES[stage.n - 2];
    const prevRow = db.prepare('SELECT status FROM stage_state WHERE stage = ?').get(prev.key);
    if (!prevRow || prevRow.status !== 'proven') {
      const e = new Error(
        i18n.T(`لا تُفتح المرحلة «${stage.ar}» قبل إثبات السابقة «${prev.ar}» (${prev.key}) — دستور §42`, `Stage "${stage.en}" cannot open before the previous one "${prev.en}" is proven (${prev.key}) — constitution §42`)
      );
      e.code = 'PREDECESSOR_NOT_PROVEN';
      throw e;
    }
  }

  const at = typeof options.now === 'string' && options.now ? options.now : nowIso();
  if (row) {
    db.prepare('UPDATE stage_state SET status = ?, evidence = ?, proven_at = ? WHERE stage = ?')
      .run('proven', evidence, at, stageKey);
  } else {
    db.prepare('INSERT INTO stage_state(stage, n, status, evidence, proven_at) VALUES (?,?,?,?,?)')
      .run(stageKey, stage.n, 'proven', evidence, at);
  }

  return {
    ok: true, stage: stage.key, n: stage.n, name: i18n.T(stage.ar, stage.en || stage.ar),
    status: 'proven', evidence, provenAt: at,
  };
}

// ═══════════════════════ 2) الفحوص الافتراضية للبوابات ═══════════════════════

/** هل نُفِّذ ملف محجور؟ يُستدل من سجل التدقيق ونداءات MCP */
function wasExecuted(db, path) {
  if (!path) return false;
  const like = `%${path}%`;
  if (tableExists(db, 'audit_log')) {
    const hit = safeGet(
      db,
      `SELECT 1 AS hit FROM audit_log
        WHERE lower(type) IN (${EXEC_TYPES.map(() => '?').join(',')})
          AND payload LIKE ? LIMIT 1`,
      [...EXEC_TYPES, like]
    );
    if (hit) return true;
  }
  if (tableExists(db, 'mcp_calls')) {
    const hit = safeGet(
      db,
      "SELECT 1 AS hit FROM mcp_calls WHERE lower(tool) LIKE '%exec%' AND args LIKE ? LIMIT 1",
      [like]
    );
    if (hit) return true;
  }
  return false;
}

// no_privilege_escape: لا ملف حرج غير ممسوح، ولا ملف محجور نُفِّذ
function checkNoPrivilegeEscape(db) {
  /* إصلاح 2026-11-12 (عدّ مضلِّل): كان الاستعلام يعدّ **الصفوف**، فـ6 ملفات
     مكرّرة في الاستيراد صارت «16 ملفاً حرجاً» — رقم يُخيف بلا أساس ويُخفي أن
     المشكلة 6 ملفات. وأي صف cleared=1 (حُسم بقرار مسجَّل) كان يظل يمنع الإطلاق.
     القاعدة الآن: مسارات متمايزة، وغير المحسومة فقط. */
  const unscannedCritical = safeAll(
    db,
    `SELECT DISTINCT path FROM quarantine
      WHERE (scanned IS NULL OR scanned = 0)
        AND severity = 'critical'
        AND (cleared IS NULL OR cleared = 0)`
  ).map((r) => r.path).filter(Boolean);

  const quarantinedPaths = safeAll(db, 'SELECT DISTINCT path FROM quarantine')
    .map((r) => r.path).filter(Boolean);
  const executed = quarantinedPaths.filter((p) => wasExecuted(db, p));

  const ok = unscannedCritical.length === 0 && executed.length === 0;
  const parts = [];
  if (unscannedCritical.length) parts.push(i18n.T(`${unscannedCritical.length} ملف حرج غير ممسوح في الحجر`, `${unscannedCritical.length} critical unscanned file(s) in quarantine`));
  if (executed.length) parts.push(i18n.T(`${executed.length} ملف محجور نُفِّذ`, `${executed.length} quarantined file(s) were executed`));
  return {
    passed: ok,
    detail: ok ? i18n.T('لا تجاوز: لا ملف حرج غير ممسوح ولا تنفيذ لملف محجور', 'No overreach: no unscanned critical file and no execution of a quarantined file') : i18n.T(`تجاوز صلاحيات: ${parts.join('، ')}`, `Privilege overreach: ${parts.join(', ')}`),
    evidence: JSON.stringify({ unscannedCritical, executed }),
  };
}

// no_double_execution: لا تكرار في idempotency_key (§36)
function checkNoDoubleExecution(db) {
  const dups = safeAll(
    db,
    `SELECT idempotency_key AS k, COUNT(*) AS n FROM agent_tasks
      WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''
      GROUP BY idempotency_key HAVING COUNT(*) > 1`
  );
  const ok = dups.length === 0;
  return {
    passed: ok,
    detail: ok ? i18n.T('لا تنفيذ مزدوج: مفاتيح idempotency فريدة', 'No double execution: idempotency keys are unique') : i18n.T(`تنفيذ مزدوج: ${dups.map((d) => d.k).join('، ')}`, `Double execution: ${dups.map((d) => d.k).join(', ')}`),
    evidence: JSON.stringify(dups.map((d) => ({ key: d.k, count: d.n }))),
  };
}

// valid_state_transitions: كل حالة في المجموعة المسموحة
function checkValidStateTransitions(db) {
  const statuses = safeAll(db, 'SELECT DISTINCT status FROM agent_tasks').map((r) => r.status);
  const bad = statuses.filter((s) => !TASK_STATUSES.includes(s));
  const ok = bad.length === 0;
  return {
    passed: ok,
    detail: ok ? i18n.T('انتقالات سليمة: كل حالات المهام مسموحة', 'Transitions valid: all task statuses are allowed') : i18n.T(`حالات غير معروفة: ${bad.join('، ')}`, `Unknown statuses: ${bad.join(', ')}`),
    evidence: JSON.stringify({ allowed: TASK_STATUSES, found: statuses }),
  };
}

// project_isolation: لا معرّف واحد يظهر في مشروعين مختلفين
function checkProjectIsolation(db) {
  if (!tableExists(db, 'notes')) {
    return { passed: true, detail: i18n.T('عزل المشاريع: لا جدول ملاحظات', 'Project isolation: no notes table'), evidence: null };
  }
  const cols = new Set(tableColumns(db, 'notes'));
  if (!cols.has('project')) {
    return { passed: true, detail: i18n.T('عزل المشاريع: لا حقل مشروع في الملاحظات', 'Project isolation: notes have no project field'), evidence: null };
  }
  // المعرّف المنطقي: بصمة المحتوى إن وُجدت، وإلا العنوان
  const idCols = ['fingerprint', 'title'].filter((c) => cols.has(c));
  const violations = [];
  for (const col of idCols) {
    const rows = safeAll(
      db,
      `SELECT ${col} AS ident, GROUP_CONCAT(DISTINCT project) AS projects, COUNT(DISTINCT project) AS n
         FROM notes
        WHERE project IS NOT NULL AND project <> ''
          AND ${col} IS NOT NULL AND ${col} <> ''
        GROUP BY ${col} HAVING COUNT(DISTINCT project) > 1`
    );
    for (const r of rows) violations.push({ by: col, identifier: r.ident, projects: r.projects, n: r.n });
  }
  const ok = violations.length === 0;
  return {
    passed: ok,
    detail: ok
      ? i18n.T('عزل سليم: لا معرّف يتجاوز مشروعه', 'Isolation intact: no id crosses its project')
      : i18n.T(`تسرب بيانات: ${violations.length} معرّفاً في أكثر من مشروع`, `Data leak: ${violations.length} id(s) in more than one project`),
    evidence: JSON.stringify(violations),
  };
}

// quarantine_intact: كل صف غير ممسوح معلوم السبب (§21، §37)
function checkQuarantineIntact(db) {
  const missingReason = safeAll(
    db,
    "SELECT path FROM quarantine WHERE (scanned IS NULL OR scanned = 0) AND (reason IS NULL OR TRIM(reason) = '')"
  ).map((r) => r.path).filter(Boolean);
  const total = safeGet(db, 'SELECT COUNT(*) AS n FROM quarantine');
  const count = total ? total.n : 0;
  const ok = missingReason.length === 0;
  return {
    passed: ok,
    detail: ok
      ? i18n.T(`حجر سليم: ${count} صفاً في الحجر بلا سبب مجهول`, `Quarantine intact: ${count} row(s) with no unknown reason`)
      : i18n.T(`حجر ناقص: ${missingReason.length} صفاً غير ممسوح بلا سبب معلوم`, `Incomplete quarantine: ${missingReason.length} unscanned row(s) with no known reason`),
    evidence: JSON.stringify({ missingReason, total: count }),
  };
}

/**
 * tasks_recoverable (§36): هل يمكن استعادة المهام العالقة **فعلاً**؟
 *
 * العطل الأصلي (مؤكد حياً): الفحص كان `TASK_STATUSES.includes('queued')` —
 * أي يتحقق أن ثابتاً في الكود يحوي ثابتاً آخر، وهو صحيح دائماً. النتيجة:
 * البوابة تعلن «استعادة سليمة» بينما 6 مهام running عالقة منذ يوم،
 * و`Orchestrator.resume` غير موصول (‏/api/agent/resume = 404).
 *
 * الفحص الصادق له ثلاثة أجزاء، وكلها تُقاس من الواقع لا من الكود:
 *   1) المهام العالقة لا تزيد على حدّ مسموح (وإلا فهي عالقة فعلاً).
 *   2) كل مهمة عالقة لها created_at (وإلا لا نعرف عمرها ولا نستطيع الحكم).
 *   3) **الاستعادة مُثبتة بالقراءة**: يُستدعى requeuePending فعلاً على تشغيل
 *      فيه مهام عالقة، ثم يُتحقق بالقراءة أن حالة صارت queued.
 */
function checkTasksRecoverable(db, opts = {}) {
  const running = safeAll(db, "SELECT id, run_id, status, created_at FROM agent_tasks WHERE status IN ('running','blocked')");
  const missingCreatedAt = running
    .filter((r) => !r.created_at || !String(r.created_at).trim())
    .map((r) => r.id);
  const maxStuck = Number.isFinite(Number(opts.maxStuck)) ? Number(opts.maxStuck) : 0;
  const tooManyStuck = running.length > maxStuck;

  // إثبات الاستعادة بالقراءة: نداء حقيقي على أول تشغيل عالق ثم تحقق
  let requeueProof = { available: false, requeued: 0, proved: false, runId: null, error: null };
  const store = opts.store;
  if (store && typeof store.requeuePending === 'function') {
    requeueProof.available = true;
    const runId = running[0] && running[0].run_id;
    if (runId) {
      try {
        const before = safeAll(db, "SELECT COUNT(*) AS n FROM agent_tasks WHERE run_id = ? AND status IN ('running','blocked')", [runId])[0]?.n || 0;
        const out = store.requeuePending(runId);
        const after = safeAll(db, "SELECT COUNT(*) AS n FROM agent_tasks WHERE run_id = ? AND status IN ('running','blocked')", [runId])[0]?.n || 0;
        requeueProof.runId = runId;
        requeueProof.requeued = out.requeued || 0;
        requeueProof.proved = before > 0 && after === 0; // الإثبات: صارت كلها queued
      } catch (e) { requeueProof.error = e.message; }
    } else {
      requeueProof.proved = true; // لا مهام عالقة ⇒ لا شيء يحتاج استعادة
    }
  }

  const ok = !tooManyStuck && missingCreatedAt.length === 0 && requeueProof.available && requeueProof.proved;
  let detail;
  if (!requeueProof.available) detail = i18n.T('لا مسار استعادة: store.requeuePending غير متاح', 'No recovery path: store.requeuePending unavailable');
  else if (missingCreatedAt.length) detail = i18n.T(`مهام بلا created_at (لا يُعرف عمرها): ${missingCreatedAt.join('، ')}`, `Tasks without created_at (age unknown): ${missingCreatedAt.join(', ')}`);
  else if (!requeueProof.proved) detail = i18n.T(`الاستعادة غير مُثبتة: ${requeueProof.error || requeueProof.requeued + ' مهمة أُعيدت بلا أثر مقروء'}`, `Recovery not proven: ${requeueProof.error || requeueProof.requeued + ' task(s) requeued with no readable trace'}`);
  else if (tooManyStuck) detail = i18n.T(`مهام عالقة: ${running.length} مهمة running/blocked (الحد المسموح ${maxStuck})`, `Stuck tasks: ${running.length} running/blocked (limit ${maxStuck})`);
  else detail = i18n.T(`استعادة مُثبتة بالقراءة: تحقّقت من ${requeueProof.requeued} مهمة في التشغيل ${requeueProof.runId || '—'}`, `Recovery proven by read-back: verified ${requeueProof.requeued} task(s) in run ${requeueProof.runId || '—'}`);
  return {
    passed: ok,
    detail,
    evidence: JSON.stringify({ running: running.map((r) => r.id), missingCreatedAt, maxStuck, requeueProof, requeue: RECOVERABLE_STATUS }),
  };
}

// conflicts_have_path: كل تعارض له مسار حل مُسجَّل (§7)
/**
 * 「مسار حل」 يعني **قراراً يُذكر فيه أحد طرفي التعارض**، لا مجرد وجود حقل.
 * العيب المُصلَح: الشرط كان `String(conflict.evidence).trim()` — أي أن أي تعارض
 * يحمل `evidence='{}'` (وهو ما يكتبه كل ناقل تعارض تلقائي) يُعدّ «محلولاً»،
 * فتمرّ البوابة على تعارض حقيقي بلا قرار. النص الفارغ/`{}`/`[]` ليس دليلاً.
 * القرار الحقيقي: `decision_entities` يذكر معرّف أحد الطرفين.
 */
function isNonEmptyEvidence(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (s === '{}' || s === '[]' || s === 'null' || s === '""') return false;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (parsed == null) return false;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (typeof parsed === 'object') return Object.keys(parsed).length > 0;
      return Boolean(parsed);
    } catch { return true; }
  }
  return true;
}

function hasResolutionPath(conflict, resolutions) {
  const ids = [conflict.source, conflict.target].filter(Boolean).map(String);
  if (!ids.length) return false;
  const resolvedByDecision = resolutions.some((d) => {
    const hay = `${d.evidence || ''} ${d.rationale || ''}`;
    return ids.some((id) => id && hay.includes(id));
  });
  if (resolvedByDecision) return true;
  // دليل مكتوب على الرابط نفسه يُعدّ مساراً فقط إن كان نصاً حقيقياً غير مذكور أعلاه.
  return isNonEmptyEvidence(conflict.evidence);
}

function checkConflictsHavePath(db) {
  if (!tableExists(db, 'note_links')) {
    return { passed: true, detail: i18n.T('لا تعارضات: لا جدول روابط', 'No conflicts: no links table'), evidence: null };
  }
  const conflicts = safeAll(
    db,
    "SELECT source, target, kind, evidence FROM note_links WHERE kind = 'contradicts'"
  );
  if (!conflicts.length) {
    return { passed: true, detail: i18n.T('لا تعارضات مسجّلة', 'No conflicts recorded'), evidence: JSON.stringify({ conflicts: 0 }) };
  }
  const resolutions = tableExists(db, 'decision_entities')
    ? safeAll(db, 'SELECT evidence, rationale FROM decision_entities')
    : [];
  const unresolved = conflicts
    .filter((c) => !hasResolutionPath(c, resolutions))
    .map((c) => `${c.source}↔${c.target}`);
  const ok = unresolved.length === 0;
  return {
    passed: ok,
    detail: ok
      ? i18n.T(`تعارضات لها مسار حل: ${conflicts.length}`, `Conflicts with a resolution path: ${conflicts.length}`)
      : i18n.T(`تعارض بلا مسار حل: ${unresolved.join('، ')}`, `Conflict without a resolution path: ${unresolved.join(', ')}`),
    evidence: JSON.stringify({ conflicts: conflicts.length, unresolved }),
  };
}

/**
 * الفحوص الافتراضية المبنية على الجداول.
 * `rollback_proven` **غائبة عمداً**: لا فحص افتراضي يوهم بالنجاح (§38، §45).
 */

// ─────────────── backup_restorable (م24): قياس الواقع لا الافتراض ───────────────
//
// البوابة تقرأ أحدث نسخة على القرص وتتحقق أن **القاعدة داخل الـZIP** وتُفتح
// وتُقرأ صفوفها. النسخة التي تُنقذ الملفات وتُفقد القاعدة (الصفوف) نسخة كاذبة،
// ولذلك غياب القاعدة = فشل صريح لا «غير قابل للتقييم».
//
// لماذا هذه البوابة: `rollback_proven` تُثبت تراجع **عنصر واحد**؛ لا شيء كان
// يُثبت أن المنتج بمجمله (notes/agent_tasks/audit_log/…) قابل للاستعادة.
/* مجلد النسخ يُشتق من **مسار قاعدة البيانات الحيّة** لا من `__dirname`
   (إصلاح 2026-11-12): كان مثبَّتاً على مجلد المشروع، فأي نسخة تعمل على APP_ROOT
   آخر (اختبار/نسخة محمولة/تشغيل ثانٍ) تفحص نسخ مشروع مختلف — إما تفشل زوراً أو
   تنجح زوراً. PRAGMA database_list يعطينا مسار القاعدة الفعلي بلا معاملات جديدة. */
function latestBackupPath(liveDb) {
  let dir = path.join(__dirname, 'data', 'backups');
  try {
    const row = liveDb.prepare('PRAGMA database_list').all().find(r => r && r.file);
    if (row && row.file) dir = path.join(path.dirname(row.file), 'backups');
  } catch { /* بلا قاعدة: يبقى الافتراضي */ }
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort();
    if (!files.length) return null;
    return path.join(dir, files[files.length - 1]);
  } catch {
    return null;
  }
}

/** قارئ إدخال ZIP مركزي — بلا مكتبات (نفس مبدأ buildZip معكوساً) */
function unzipEntry(buf, want) {
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const ds = i + 30 + nlen + elen;
    const data = buf.slice(ds, ds + csize);
    if (name === want) return method === 0 ? data : zlib.inflateRawSync(data);
    i = ds + csize;  }
  return null;
}

/** أسماء إدخالات ZIP — لازمة للتحقق من أن الخزنة (مصدر الحقيقة) داخل النسخة. */
function listZipEntries(buf) {
  const names = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    names.push(buf.slice(i + 30, i + 30 + nlen).toString('utf8'));
    i += 30 + nlen + elen + csize;
  }
  return names;
}

/* المعامل اسمه liveDb لا db: داخل هذه الدالة `const db = new DatabaseSync(tmp)`
   لقاعدة النسخة المستخرجة، وكان **يحجب** المعامل في كل الكتلة (عطل مُقاس
   2026-11-12: liveVault ظهر 0 دائماً لأن القاعدة الداخلية أُغلقت قبل القراءة،
   فمرّت بوابة على نسخة تغطي 23% من المعرفة). */
function checkBackupRestorable(liveDb) {
  const p = latestBackupPath(liveDb);
  if (!p) {
    return { passed: false, detail: i18n.T('لا نسخة احتياطية واحدة على القرص — الاستعادة غير مُثبتة', 'No backup on disk — restore is not proven'), evidence: null };
  }
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    return { passed: false, detail: i18n.T(`تعذّر قراءة النسخة: ${err && err.message}`, `Could not read the backup: ${err && err.message}`), evidence: null };
  }
  let dbBuf = null;
  try {
    dbBuf = unzipEntry(buf, 'data/cortex.db');
  } catch (err) {
    return { passed: false, detail: i18n.T(`النسخة تالفة (تعذّر فك ZIP): ${err && err.message}`, `Backup is corrupt (unzip failed): ${err && err.message}`), evidence: null };
  }
  if (!dbBuf || !dbBuf.length) {
    return {
      passed: false,
      detail: i18n.T('النسخة تحوي ملفات فقط و0 صف من القاعدة — المعرفة والمهام والتدقيق غير محفوظة (§24)', 'The backup holds files only and 0 DB rows — knowledge, tasks and audit are not saved (§24)'),
      evidence: null,
    };
  }
  // إثبات الاسترجاع الفعلي: نفتح القاعدة ونقرأ المعرفة
  const tmp = path.join(os.tmpdir(), `cortex-gate-restore-${process.pid}-${Date.now()}.sqlite`);
  try {
    fs.writeFileSync(tmp, dbBuf);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmp);
    let notes = 0;
    let tasks = 0;
    try {
      notes = db.prepare('SELECT COUNT(*) c FROM notes').get().c;
      tasks = db.prepare('SELECT COUNT(*) c FROM agent_tasks').get().c;
    } finally {
      db.close();
    }
    if (!notes && !tasks) {
      return { passed: false, detail: i18n.T('القاعدة داخل النسخة فارغة — الاستعادة لا تُعيد شيئاً', 'The DB inside the backup is empty — restore brings back nothing'), evidence: null };
    }
    /* عطل مُقاس 2026-11-11: البوابة كانت تفحص القاعدة وحدها، والنسخة التي تُسقط
       **الخزنة** (مصدر الحقيقة: ملفات Markdown) كانت تنجح — أي «نسخة قابلة للاستعادة»
       تعيد فهرساً بلا معرفة. الآن تُعدّ ملفات vault/*.md داخل الـZIP ويُشترط وجودها. */
    let vaultFiles = 0;
    let assetFiles = 0;
    try {
      for (const n of listZipEntries(buf)) {
        if (n.startsWith('vault/') && n.endsWith('.md')) vaultFiles += 1;
        else if (n.startsWith('data/assets/')) assetFiles += 1;
      }
    } catch { /* قراءة الأسماء فشلت: تُعالَج كصفر أدناه */ }
    if (!vaultFiles) {
      return {
        passed: false,
        detail: i18n.T('النسخة لا تحوي أي ملف خزنة (vault/*.md) — القاعدة وحدها لا تُعيد المعرفة', 'The backup holds no vault file (vault/*.md) — the DB alone does not restore knowledge'),
        evidence: JSON.stringify({ backup: path.basename(p), notes, tasks, vaultFiles }),
      };
    }
    /* إصلاح 2026-11-12 (بوابة تنجح على نسخة ميتة): كانت البوابة تفحص *وجود* نسخة
       صالحة، لا حداثتها ولا اكتمالها. القياس: نجحت على نسخة 2026-10-29 فيها 85
       ملاحظة بينما القاعدة تحوي 362 — أي أنها كانت تُصادق على استعادة 23% من
       المعرفة. الآن شرطان إضافيان: العمر ≤ 14 يوماً، والتغطية ≥ 90% من الخزنة
       الحيّة. النسخة القديمة تفشل صراحةً بدل أن تُطمئن كذباً. */
    const MAX_AGE_DAYS = 14;
    const MIN_COVERAGE = 0.9;
    let backupAgeDays = null;
    try { backupAgeDays = (Date.now() - fs.statSync(p).mtimeMs) / 86400000; } catch { backupAgeDays = null; }
    let liveVault = 0;
    /* عدد الملاحظات الحيّة من **الخزنة على القرص** (مصدر الحقيقة)، ومسارها مشتق
       من مسار قاعدة البيانات الحيّة. كان يقرأ `__dirname/vault` (مشروع آخر) ثم
       صار يقرأ جدول `notes` — وهو مرآة مؤجَّلة (debounce 800ms) فتتأخر عن الحقيقة
       أثناء الكتابة السريعة. الخزنة لا تتأخر.
       قاعدة في الذاكرة (`:memory:`) بلا مسار ⇒ لا خزنة على القرص ⇒ نقرأ الجدول،
       وإن كان فارغاً تُتخطّى التغطية (لا شيء يُقاس) — لا نُسقط بوابة على قاعدة نظيفة. */
    let haveDiskVault = false;
    try {
      const row = liveDb.prepare('PRAGMA database_list').all().find(r => r && r.file);
      if (row && row.file) {
        const vaultDir = path.join(path.dirname(row.file), '..', 'vault');
        liveVault = fs.readdirSync(vaultDir).filter(f => f.endsWith('.md')).length;
        haveDiskVault = true;
      }
    } catch { haveDiskVault = false; }
    if (!haveDiskVault) {
      try { liveVault = Number(liveDb.prepare('SELECT COUNT(*) c FROM notes').get().c) || 0; } catch { liveVault = 0; }
    }
    const needed = Math.floor(liveVault * MIN_COVERAGE);
    if (backupAgeDays !== null && backupAgeDays > MAX_AGE_DAYS) {
      return {
        passed: false,
        detail: i18n.T(`النسخة عمرها ${Math.round(backupAgeDays)} يوماً (الحد ${MAX_AGE_DAYS}) — نسخة قديمة لا تُثبت استعادة الحالة الراهنة`, `The backup is ${Math.round(backupAgeDays)} days old (limit ${MAX_AGE_DAYS}) — a stale backup does not prove restoring the current state`),
        evidence: JSON.stringify({ backup: path.basename(p), backupAgeDays: Math.round(backupAgeDays), maxAgeDays: MAX_AGE_DAYS }),
      };
    }
    if (liveVault && vaultFiles < needed) {
      return {
        passed: false,
        detail: i18n.T(`النسخة تحوي ${vaultFiles} ملف خزنة من ${liveVault} حيّاً (الحد الأدنى ${needed}) — تغطية ناقصة`, `The backup holds ${vaultFiles} vault files out of ${liveVault} live ones (minimum ${needed}) — incomplete coverage`),
        evidence: JSON.stringify({ backup: path.basename(p), vaultFiles, liveVault, needed }),
      };
    }
    return {
      passed: true,
      detail: i18n.T(`نسخة قابلة للاستعادة: ${path.basename(p)} تحوي القاعدة (${notes} ملاحظة، ${tasks} مهمة) و${vaultFiles} ملف خزنة${assetFiles ? ` و${assetFiles} أصلاً` : ''}${backupAgeDays !== null ? ` — عمرها ${Math.round(backupAgeDays)} يوم` : ''}`, `Restorable backup: ${path.basename(p)} contains the DB (${notes} notes, ${tasks} tasks) and ${vaultFiles} vault files${assetFiles ? ` plus ${assetFiles} assets` : ''}${backupAgeDays !== null ? ` — ${Math.round(backupAgeDays)} days old` : ''}`),
      evidence: JSON.stringify({ backup: path.basename(p), notes, tasks, vaultFiles, assetFiles, bytes: dbBuf.length, backupAgeDays: backupAgeDays === null ? null : Math.round(backupAgeDays), liveVault }),
    };
  } catch (err) {
    return { passed: false, detail: i18n.T(`القاعدة داخل النسخة غير قابلة للفتح: ${err && err.message}`, `The DB inside the backup cannot be opened: ${err && err.message}`), evidence: null };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* تنظيف غير حرج */ }
  }
}

const DEFAULT_CHECKS = Object.freeze({
  no_privilege_escape: checkNoPrivilegeEscape,
  no_double_execution: checkNoDoubleExecution,
  valid_state_transitions: checkValidStateTransitions,
  project_isolation: checkProjectIsolation,
  quarantine_intact: checkQuarantineIntact,
  tasks_recoverable: checkTasksRecoverable,
  conflicts_have_path: checkConflictsHavePath,
  backup_restorable: checkBackupRestorable,
});

// ═══════════════════════ 3) تقييم البوابات ═══════════════════════

/** يقيّم بوابة واحدة: إحقان ← فحص افتراضي ← رفض صريح */
/**
 * ملاحظة عقد: المسبار قد يكون async (مسح حجر يقرأ ملفات). النتيجة تُنتظر هنا،
 * و`checkGates` صارت async أيضاً — وإلا عاد الوعد نفسه وكان `out.passed`
 * غير معرّف فتفشل البوابة، أو أسوأ: يُقرأ وعد كنجاح.
 */
async function evaluateGate(db, key, injected) {
  const probe = injected[key];
  if (typeof probe === 'function') {
    let out;
    try {
      out = await probe(db);
    } catch (err) {
      return { passed: false, detail: i18n.T(`فحص البوابة «${key}» انهار: ${err && err.message ? err.message : err}`, `Gate check "${key}" crashed: ${err && err.message ? err.message : err}`), evidence: null };
    }
    if (!out || typeof out !== 'object') {
      return { passed: false, detail: i18n.T(`فحص البوابة «${key}» لم يُعِد نتيجة صالحة`, `Gate check "${key}" returned no valid result`), evidence: null };
    }
    const pass = out.passed === true;
    return {
      passed: pass,
      detail: typeof out.detail === 'string' && out.detail ? out.detail : (pass ? i18n.T('نجح', 'pass') : i18n.T('فشل', 'fail')),
      evidence: normalizeEvidence(out.evidence),
    };
  }

  const def = DEFAULT_CHECKS[key];
  if (typeof def === 'function') return await def(db);

  // لا مسار افتراضي — لا يُدَّعى نجاح (§45)
  if (key === 'rollback_proven') {
    return { passed: false, detail: NO_ROLLBACK_DETAIL, evidence: null };
  }
  return { passed: false, detail: i18n.T(`لا فحص افتراضي للبوابة «${key}»`, `No default check for gate "${key}"`), evidence: null };
}

/**
 * يقيّم البوابات التسع حتمياً ويحفظ كل نتيجة في `release_gates`.
 * @param {object} [probes] إحقان فحوص خارجية: { [gateKey]: () => ({passed, detail, evidence}) }
 * @returns {{canRelease:boolean, gates:Array<{key:string, pass:boolean, detail:string}>}}
 */
async function checkGates(db, probes = {}) {
  const injected = probes && typeof probes === 'object' ? probes : {};
  const at = nowIso();
  const insert = db.prepare(
    'INSERT INTO release_gates(at, gate, passed, detail, evidence) VALUES (?, ?, ?, ?, ?)'
  );

  const gates = [];
  let canRelease = true;
  for (const g of RELEASE_GATES) {
    const res = await evaluateGate(db, g.key, injected);
    const pass = res.passed === true;
    if (!pass) canRelease = false;
    insert.run(at, g.key, pass ? 1 : 0, res.detail || null, res.evidence || null);
    gates.push({ key: g.key, pass, detail: res.detail || null });
  }
  return { canRelease, gates };
}

/**
 * قرار الإطلاق: هل يجوز، وما البوابات الحاجبة.
 * تقييم محض بلا كتابة في `release_gates` (checkGates هو من يحفظ).
 * @returns {{release:boolean, blocking:string[]}}
 */
async function canRelease(db, probes = {}) {
  const injected = probes && typeof probes === 'object' ? probes : {};
  const blocking = [];
  for (const g of RELEASE_GATES) {
    const res = await evaluateGate(db, g.key, injected);
    if (res.passed !== true) blocking.push(g.key);
  }
  return { release: blocking.length === 0, blocking };
}

/**
 * آخر نتائج البوابات — الأحدث أولاً.
 * @param {number} [limit=50]
 * @returns {Array<{id:number, at:string, gate:string, passed:boolean, detail:string, evidence:string}>}
 */
function history(db, limit = 50) {
  let n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) n = 50;
  n = Math.min(Math.floor(n), 1000);
  const rows = safeAll(
    db,
    'SELECT id, at, gate, passed, detail, evidence FROM release_gates ORDER BY id DESC LIMIT ?',
    [n]
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    gate: r.gate,
    passed: !!r.passed,
    detail: r.detail,
    evidence: r.evidence,
  }));
}

module.exports = {
  evaluateStage,
  proveStage,
  checkGates,
  canRelease,
  history,
  STAGE_STATUSES,
  TASK_STATUSES,
  RECOVERABLE_STATUS,
  GATE_KEYS,
  DEFAULT_CHECKS,
};
