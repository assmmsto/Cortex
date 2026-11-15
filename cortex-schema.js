'use strict';

// ════════════════════════════════════════════════════════════════════
//  مخطط Cortex — يوافق الدستور الصارم
//  كل إضافة هنا تخدم مادة دستورية صريحة، ومكتوب عندها رقمها.
// ════════════════════════════════════════════════════════════════════

// الأنواع الثمانية — لكل نوع كيانه المستقل (م5)
const KINDS = Object.freeze([
  'note', 'project', 'document', 'file', 'repo', 'task', 'decision', 'knowledge',
]);

// الأنواع التي لها جدول كيان مخصّص — يقيسها اختبار المطابقة (م5)
const ENTITY_TABLES = Object.freeze({
  note: 'notes',
  project: 'project_entities',
  document: 'document_entities',
  file: 'file_entities',
  repo: 'repos',
  task: 'task_entities',
  decision: 'decision_entities',
  knowledge: 'knowledge_entities',
});

// تمييز مصدر المعرفة — لا يُخلط استنتاج بحقيقة (م6، م46/4)
const KNOWLEDGE_KINDS = Object.freeze(['imported', 'inferred', 'decided', 'hypothesis']);

// الأنواع التي يجوز استخدامها كدليل. inferred/hypothesis ممنوعة (م6)
const EVIDENCE_ALLOWED_KNOWLEDGE = Object.freeze(['imported', 'decided']);

// أنواع العلاقات التسعة المطلوبة نصاً في الدستور (م7)
const RELATION_KINDS = Object.freeze({
  depends_on: { ar: 'يعتمد على', en: 'depends_on', inverse: 'supports' },
  derives_from: { ar: 'يستمد من', en: 'derives_from', inverse: 'sources' },
  resulted_in: { ar: 'نتج عن', en: 'resulted_in', inverse: 'results_from' },
  responsible_for: { ar: 'مسؤول عن', en: 'responsible_for', inverse: 'owned_by' },
  belongs_to: { ar: 'تابع لـ', en: 'belongs_to', inverse: 'contains' },
  contradicts: { ar: 'متعارض مع', en: 'contradicts', inverse: 'contradicts' },
  risks: { ar: 'خطر على', en: 'risks', inverse: 'threatened_by' },
  tested_by: { ar: 'يُختبر بـ', en: 'tested_by', inverse: 'tests' },
  affected_by: { ar: 'يتأثر بـ', en: 'affected_by', inverse: 'affects' },
});

// الأنواع القديمة تبقى صالحة (توافق خلفي) لكن لا تُعدّ من التسعة
const LEGACY_RELATION_KINDS = Object.freeze(['contains', 'references', 'parent_project', 'wikilink']);

// حساسية البيانات — أصل من أصول اشتقاق الخطورة (م8)
const SENSITIVITY_LEVELS = Object.freeze(['public', 'internal', 'confidential', 'restricted']);

// مستويات الخطورة — تُشتق من أدلة لا من عدد الروابط (م8)
const SEVERITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// المراحل الثمانية وبواباتها (م42، م43، م45)
const STAGES = Object.freeze([
  { n: 1, key: 'knowledge_base', ar: 'قاعدة المعرفة', en: 'Knowledge base' },
  { n: 2, key: 'relations_map', ar: 'العلاقات والخريطة', en: 'Relations and map' },
  { n: 3, key: 'agent_chat', ar: 'الوكيل والمحادثة', en: 'Agent and chat' },
  { n: 4, key: 'model_gateway', ar: 'بوابة النماذج', en: 'Model gateway' },
  { n: 5, key: 'execution', ar: 'التنفيذ', en: 'Execution' },
  { n: 6, key: 'mcp', ar: 'MCP', en: 'MCP' },
  { n: 7, key: 'autonomy', ar: 'الاستقلال التشغيلي', en: 'Operational autonomy' },
  { n: 8, key: 'enterprise', ar: 'جاهزية الشركات', en: 'Enterprise readiness' },
]);

// بوابات منع الإطلاق (م45) — كل بوابة تُقيَّم بكود حتمي لا بنموذج (م35)
const RELEASE_GATES = Object.freeze([
  { key: 'no_privilege_escape', ar: 'لا تجاوز صلاحيات' },
  { key: 'no_double_execution', ar: 'لا تنفيذ مزدوج' },
  { key: 'valid_state_transitions', ar: 'انتقالات حالة صحيحة' },
  { key: 'project_isolation', ar: 'عزل بيانات المشاريع' },
  { key: 'quarantine_intact', ar: 'عزل الملفات غير الموثوقة' },
  { key: 'tasks_recoverable', ar: 'استعادة المهام المعلقة' },
  { key: 'conflicts_have_path', ar: 'تعارض النتائج له مسار حل' },
  { key: 'rollback_proven', ar: 'اختبار التراجع المعتمد' },
  // م24: بوابات التراجع تُثبت عنصراً واحداً؛ هذه تُثبت أن **المنتج كله** قابل
  // للاستعادة — النسخة التي تُنقذ الملفات وتُفقد القاعدة (الصفوف) نسخة كاذبة.
  { key: 'backup_restorable', ar: 'قابلية استعادة النسخة' },
]);

/* البوابات التي يجب أن تكون خضراء قبل إثبات كل مرحلة (إصلاح 2026-11-12).
   السبب المقيس: كانت 7/8 مراحل «مُثبتة» بينما no_privilege_escape فاشلة —
   أي أن «مُثبت» لم تكن تعني شيئاً. المصدر الوحيد للحقيقة هو هذا الجدول،
   ويُفرَض في طبقة الخادم (server.js) لا في المكتبة، ليبقى الاختبار الوحدوي
   نقياً وليبقى الحاكم حيث تُتخذ القرارات. */
const STAGE_GATE_REQUIREMENTS = Object.freeze({
  knowledge_base: ['no_privilege_escape', 'quarantine_intact'],
  relations_map: ['valid_state_transitions', 'project_isolation'],
  agent_chat: ['no_privilege_escape', 'no_double_execution'],
  model_gateway: ['no_privilege_escape'],
  execution: ['no_double_execution', 'rollback_proven', 'tasks_recoverable'],
  mcp: ['no_privilege_escape', 'no_double_execution'],
  autonomy: ['tasks_recoverable', 'conflicts_have_path', 'rollback_proven'],
  enterprise: [
    'no_privilege_escape', 'no_double_execution', 'valid_state_transitions',
    'project_isolation', 'quarantine_intact', 'tasks_recoverable',
    'conflicts_have_path', 'rollback_proven', 'backup_restorable',
  ],
});

// خريطة التوافق الخلفي: نوع قديم -> kind جديد
const LEGACY_KIND_MAP = Object.freeze({
  project: 'project',
  doc: 'document',
  decision: 'decision',
  task: 'task',
  meeting: 'document',
  procedure: 'document',
});

// الجداول التي قد تحتاج أعمدة جديدة: table -> [[column, ddl]]
const COLUMN_PATCHES = Object.freeze({
  notes: [
    ['kind', "TEXT DEFAULT 'note'"],
    ['knowledge_kind', 'TEXT'],
    ['source', 'TEXT'],
    ['fingerprint', 'TEXT'],
    ['sensitivity', "TEXT DEFAULT 'internal'"],   // م8: أصل من أصول الخطورة
    ['criticality', 'INTEGER DEFAULT 0'],          // م8: اعتمادية حرجة
    ['promoted_from', 'TEXT'],                     // م46/4: أثر أي ترقية
  ],
  note_links: [
    ['origin', 'TEXT'],
    ['confidence', 'REAL DEFAULT 1.0'],
    ['extracted_at', 'TEXT'],
    ['evidence', 'TEXT'],                          // م7: الدليل الذي أُثبتت به العلاقة
  ],
  // جداول قد تكون أُنشئت سابقاً بصيغة أقدم — الترقية تحفظ البيانات (م12)
  model_usage: [
    ['purpose', 'TEXT'],
    ['ok', 'INTEGER'],
  ],
  agent_tasks: [
    ['idempotency_key', 'TEXT'],
    ['attempts', 'INTEGER DEFAULT 0'],
    ['error', 'TEXT'],
  ],
  // م19 «يُحفظ ما استُورد كاملاً» — أصل البايتات المنسوخة فعلياً؛ بدونه كان
  // assetsSaved ادّعاءً بلا عنصر على القرص (تدقيق 2026-10-20).
  document_entities: [
    ['asset_path', 'TEXT'],
  ],
});

/**
 * م19: البصمة (fingerprint) كانت تُحسَب وتُحفظ ولا تُستعلَم — نفس الملف مرتين
 * كان يُنتج عنصرين (تدقيق 2026-10-20: بصمة واحدة ×9). تُطوى المكررات إلى أقدم صف
 * ثم يُفرض فهرس فريد، فلا يمكن تكرار الاستيراد بنيوياً لا بالنية.
 * @returns {{collapsed:number, groups:number, indexed:boolean}}
 */
function dedupeDocuments(db) {
  let collapsed = 0, groups = 0, indexed = false;
  try {
    const g = db.prepare(`SELECT fingerprint, COUNT(*) c FROM document_entities
      WHERE fingerprint IS NOT NULL AND fingerprint <> '' GROUP BY fingerprint HAVING c > 1`).all();
    groups = (g || []).length;
    for (const row of (g || [])) {
      const ids = db.prepare('SELECT id FROM document_entities WHERE fingerprint = ? ORDER BY imported_at ASC, rowid ASC').all(row.fingerprint);
      for (const r of (ids || []).slice(1)) {
        db.prepare('DELETE FROM document_entities WHERE id = ?').run(r.id);
        collapsed++;
      }
    }
  } catch { /* لا جدول بعد */ }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_entities_fingerprint ON document_entities(fingerprint) WHERE fingerprint IS NOT NULL');
    indexed = true;
  } catch { /* بصمات فارغة متعددة أو فهرس قائم */ }
  return { collapsed, groups, indexed };
}

const SCHEMA_EXT = [
  "ALTER TABLE notes ADD COLUMN kind TEXT DEFAULT 'note'",
  'ALTER TABLE notes ADD COLUMN knowledge_kind TEXT',
  'ALTER TABLE notes ADD COLUMN source TEXT',
  'ALTER TABLE notes ADD COLUMN fingerprint TEXT',
  'ALTER TABLE notes ADD COLUMN sensitivity TEXT DEFAULT "internal"',
  'ALTER TABLE notes ADD COLUMN criticality INTEGER DEFAULT 0',
  'ALTER TABLE notes ADD COLUMN promoted_from TEXT',
  'ALTER TABLE note_links ADD COLUMN origin TEXT',
  'ALTER TABLE note_links ADD COLUMN confidence REAL DEFAULT 1.0',
  'ALTER TABLE note_links ADD COLUMN extracted_at TEXT',
  'ALTER TABLE note_links ADD COLUMN evidence TEXT',

  // ── م5: كيانات مستقلة لكل نوع. كل جدول يحمل حقوله الخاصة وعملياته ──
  `CREATE TABLE IF NOT EXISTS project_entities(
    id TEXT PRIMARY KEY, goal TEXT, state TEXT NOT NULL DEFAULT 'active',
    owner TEXT, progress INTEGER DEFAULT 0, created_at TEXT, closed_at TEXT,
    archived_at TEXT, priority TEXT DEFAULT 'normal')`,

  `CREATE TABLE IF NOT EXISTS document_entities(
    id TEXT PRIMARY KEY, source TEXT, doc_type TEXT, version INTEGER DEFAULT 1,
    fingerprint TEXT, imported_at TEXT, original_path TEXT,
    analysis TEXT, language TEXT, page_count INTEGER)`,

  `CREATE TABLE IF NOT EXISTS file_entities(
    id TEXT PRIMARY KEY, path TEXT NOT NULL, owner TEXT, mime TEXT,
    size INTEGER, hash TEXT, source TEXT, verified_at TEXT,
    integrity_ok INTEGER, last_seen TEXT)`,

  `CREATE TABLE IF NOT EXISTS task_entities(
    id TEXT PRIMARY KEY, plan TEXT, status TEXT NOT NULL DEFAULT 'open',
    result TEXT, depends_on TEXT, assignee TEXT, due TEXT,
    resumable INTEGER DEFAULT 1, attempts INTEGER DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS decision_entities(
    id TEXT PRIMARY KEY, rationale TEXT, evidence TEXT, alternatives TEXT,
    decided_by TEXT, decided_at TEXT, status TEXT DEFAULT 'active',
    superseded_by TEXT)`,

  `CREATE TABLE IF NOT EXISTS knowledge_entities(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, concept TEXT, statement TEXT,
    source TEXT, confidence REAL DEFAULT 0.0, verified_by TEXT,
    verified_at TEXT, evidence TEXT)`,
  // ─────────────────────────────────────────────────────────────────

  `CREATE TABLE IF NOT EXISTS document_versions(
    doc_id TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    source TEXT, imported_at TEXT NOT NULL, analysis TEXT, original_path TEXT,
    PRIMARY KEY(doc_id, version))`,

  `CREATE TABLE IF NOT EXISTS repos(
    id TEXT PRIMARY KEY, path TEXT NOT NULL, remote TEXT, branch TEXT,
    last_indexed TEXT, file_count INTEGER DEFAULT 0, meta TEXT)`,

  `CREATE TABLE IF NOT EXISTS repo_deps(
    repo_id TEXT NOT NULL, from_file TEXT NOT NULL, to_file TEXT NOT NULL,
    kind TEXT NOT NULL, confidence REAL DEFAULT 1.0, extracted_at TEXT,
    PRIMARY KEY(repo_id, from_file, to_file, kind))`,

  `CREATE TABLE IF NOT EXISTS project_lifecycle(
    project TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active',
    goals TEXT, created_at TEXT, closed_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS agent_tasks(
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL,
    goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    depends_on TEXT, result TEXT, error TEXT,
    idempotency_key TEXT UNIQUE, attempts INTEGER DEFAULT 0,
    created_at TEXT, started_at TEXT, finished_at TEXT)`,

  `CREATE TABLE IF NOT EXISTS agent_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT,
    type TEXT NOT NULL, payload TEXT, at TEXT NOT NULL)`,

  // م12 + م15/6: الاستهلاك وسجل الاتصالات الخارجية — لا ادعاء بلا سجل
  `CREATE TABLE IF NOT EXISTS model_usage(
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL,
    at TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
    cost REAL, source TEXT NOT NULL DEFAULT 'unknown', purpose TEXT, ok INTEGER)`,

  `CREATE TABLE IF NOT EXISTS connection_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT NOT NULL,
    purpose TEXT NOT NULL, data_kind TEXT, allowed INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER, privacy_note TEXT)`,

  `CREATE TABLE IF NOT EXISTS mcp_calls(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, server TEXT NOT NULL,
    tool TEXT NOT NULL, args TEXT, result TEXT, ok INTEGER, changed_files TEXT,
    needs_approval INTEGER DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL,
    scope TEXT, tool TEXT, actor TEXT, payload TEXT)`,

  // م38: لقطة قبل كل تغيير تُتيح تراجعاً حقيقياً مُثبتاً
  `CREATE TABLE IF NOT EXISTS change_snapshots(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL,
    entity_id TEXT NOT NULL, op TEXT NOT NULL, before_state TEXT,
    after_state TEXT, reverted INTEGER DEFAULT 0, reverted_at TEXT,
    actor TEXT, run_id TEXT)`,

  // م21: كل حقن مُعزَل يُسجَّل — العزل بلا تسجيل ناقص
  `CREATE TABLE IF NOT EXISTS import_isolations(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT,
    fingerprint TEXT, note_id TEXT, pattern TEXT, match_text TEXT, index_at INTEGER)`,

  // م37: حجر الملفات المشبوهة بدل معالجتها في المسار العادي
  `CREATE TABLE IF NOT EXISTS quarantine(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, path TEXT NOT NULL,
    reason TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'high',
    scanned INTEGER DEFAULT 0, scan_result TEXT, cleared INTEGER DEFAULT 0,
    cleared_by TEXT, cleared_at TEXT)`,

  // م26 + م23/11: تقييم الأداء ودورة التحسين المنضبط
  `CREATE TABLE IF NOT EXISTS self_eval(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, scope TEXT NOT NULL,
    metrics TEXT NOT NULL, weaknesses TEXT, proposals TEXT)`,

  `CREATE TABLE IF NOT EXISTS improvement_trials(
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
    proposal TEXT NOT NULL, target TEXT NOT NULL, acceptance TEXT NOT NULL,
    baseline TEXT, trial_result TEXT, verdict TEXT,
    decided_at TEXT, decided_by TEXT, applied INTEGER DEFAULT 0)`,

  // م42 + م43: آلة مراحل — لا انتقال بلا دليل مُثبت
  `CREATE TABLE IF NOT EXISTS stage_state(
    stage TEXT PRIMARY KEY, n INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'locked',
    evidence TEXT, proven_at TEXT, notes TEXT)`,

  // م45: نتيجة بوابات منع الإطلاق — تُقيَّم حتمياً وتُحفظ
  `CREATE TABLE IF NOT EXISTS release_gates(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, gate TEXT NOT NULL,
    passed INTEGER NOT NULL, detail TEXT, evidence TEXT)`,

  // م8: دليل الخطورة — يُشتق من خمسة أصول لا من عدد الروابط
  `CREATE TABLE IF NOT EXISTS severity_evidence(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL,
    entity_id TEXT NOT NULL, severity TEXT NOT NULL, tests_evidence TEXT,
    sensitivity TEXT, impact TEXT, critical_deps TEXT, score REAL)`,

].join(';\n');

// الفهارس: نتخطى الفهارس المرتبطة بأعمدة لا وجود لها في قاعدة قديمة
const INDEX_PATCHES = Object.freeze([
  ['idx_notes_kind', 'notes', 'notes(kind)'],
  ['idx_tasks_status', 'tasks', 'tasks(status)'],
  ['idx_events_run', 'agent_events', 'agent_events(run_id)'],
  ['idx_agent_tasks_run', 'agent_tasks', 'agent_tasks(run_id, status)'],
  ['idx_docs_versions', 'document_versions', 'document_versions(doc_id, version DESC)'],
  ['idx_snapshots_entity', 'change_snapshots', 'change_snapshots(entity, entity_id, id DESC)'],
  ['idx_connections_at', 'connection_log', 'connection_log(at DESC)'],
  ['idx_usage_at', 'model_usage', 'model_usage(at DESC)'],
  ['idx_quarantine_path', 'quarantine', 'quarantine(path, cleared)'],
  ['idx_isolations_note', 'import_isolations', 'import_isolations(note_id)'],
]);

const CREATE_TABLES = Object.freeze([
  'document_versions', 'repos', 'repo_deps', 'project_lifecycle',
  'agent_tasks', 'agent_events', 'model_usage', 'mcp_calls', 'audit_log',
  'project_entities', 'document_entities', 'file_entities', 'task_entities',
  'decision_entities', 'knowledge_entities',
  'change_snapshots', 'import_isolations', 'quarantine',
  'self_eval', 'improvement_trials', 'stage_state', 'release_gates',
  'connection_log', 'severity_evidence',
]);

function tableExists(db, name) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return !!row;
}

function tableColumns(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

// الأعمدة التي يُمنع محوها — حماية سجل التدقيق (م38: ممنوع محو أثر تدقيقي)
const PROTECTED_TABLES = Object.freeze(['audit_log', 'change_snapshots', 'agent_events', 'import_isolations']);

/**
 * يثبّت حرّاس المنع على مستوى قاعدة البيانات نفسها.
 * الحماية هنا لا تعتمد على أي مسار برمجي في التطبيق: حتى لو نسي مسارٌ ما،
 * تُرفض الكتابة الماحية من المحرّك (م38 + م46/6).
 * ملاحظة: الحذف المسموح يمر عبر رفع العلم (reverted/cleared) لا بحذف الصف.
 */
function installAuditGuards(db) {
  const rules = [
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'سجل التدقيق محمي — الحذف ممنوع (دستور §38)'); END`,
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'سجل التدقيق محمي — التعديل ممنوع (دستور §38)'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_events_no_delete BEFORE DELETE ON agent_events
       BEGIN SELECT RAISE(ABORT, 'سجل الأحداث محمي — الحذف ممنوع (دستور §36)'); END`,
    `CREATE TRIGGER IF NOT EXISTS change_snapshots_no_delete BEFORE DELETE ON change_snapshots
       BEGIN SELECT RAISE(ABORT, 'سجل التراجع محمي — الحذف ممنوع (دستور §38)'); END`,
    `CREATE TRIGGER IF NOT EXISTS import_isolations_no_delete BEFORE DELETE ON import_isolations
       BEGIN SELECT RAISE(ABORT, 'سجل العزل محمي — الحذف ممنوع (دستور §21)'); END`,
  ];
  const ok = [];
  for (const sql of rules) {
    try { db.exec(sql); ok.push(sql.match(/IF NOT EXISTS (\w+)/)[1]); }
    catch { /* قاعدة قديمة/نسخة سابقة: نتخطى بلا كسر الهجرة */ }
  }
  return ok;
}

/**
 * يعبّئ كيانات الأنواع الثمانية من `notes` الموجودة — هجرة لا تُفقد شيئاً (م5 + م19).
 * يعمل مرة واحدة فقط: إن كان الجدول ممتلئاً لا يعيد النسخ.
 */
function backfillEntities(db) {
  if (!tableExists(db, 'notes') || !tableExists(db, 'project_entities')) {
    return { ok: false, reason: 'tables-missing', filled: {} };
  }
  const filled = {};
  const COLS = {
    project: ['id', 'goal', 'state', 'owner', 'progress', 'created_at'],
    document: ['id', 'source', 'doc_type', 'imported_at', 'original_path'],
    file: ['id', 'path', 'source', 'hash', 'verified_at'],
    task: ['id', 'status', 'assignee', 'due'],
    decision: ['id', 'rationale', 'decided_at'],
    knowledge: ['id', 'kind', 'source', 'confidence', 'verified_at'],
  };
  const src = db.prepare('SELECT * FROM notes').all();
  const insert = {
    project: db.prepare("INSERT OR IGNORE INTO project_entities(id, goal, state, owner, progress, created_at) VALUES (?,?,?,?,?,?)"),
    document: db.prepare("INSERT OR IGNORE INTO document_entities(id, source, doc_type, imported_at, original_path) VALUES (?,?,?,?,?)"),
    file: db.prepare("INSERT OR IGNORE INTO file_entities(id, path, source, hash, verified_at) VALUES (?,?,?,?,?)"),
    task: db.prepare("INSERT OR IGNORE INTO task_entities(id, status, assignee, due) VALUES (?,?,?,?)"),
    decision: db.prepare("INSERT OR IGNORE INTO decision_entities(id, rationale, decided_at) VALUES (?,?,?)"),
    knowledge: db.prepare("INSERT OR IGNORE INTO knowledge_entities(id, kind, source, confidence, verified_at) VALUES (?,?,?,?,?)"),
  };
  db.exec('BEGIN');
  try {
    for (const n of src) {
      const kind = kindOf(n);
      if (!insert[kind]) continue;
      try {
        if (kind === 'project') insert.project.run(n.id, n.project || null, 'active', null, 0, n.created_at || null);
        else if (kind === 'document') insert.document.run(n.id, n.source || null, n.doc_type || null, n.created_at || null, n.source || null);
        else if (kind === 'file') insert.file.run(n.id, n.source || n.id, n.source || null, n.fingerprint || null, n.updated_at || null);
        else if (kind === 'task') insert.task.run(n.id, n.status || 'open', null, null);
        else if (kind === 'decision') insert.decision.run(n.id, null, n.created_at || null);
        else if (kind === 'knowledge') {
          const kk = KNOWLEDGE_KINDS.includes(n.knowledge_kind) ? n.knowledge_kind : 'inferred';
          insert.knowledge.run(n.id, kk, n.source || null, isVerifiedKnowledge(kk) ? 1.0 : 0.0, isVerifiedKnowledge(kk) ? (n.updated_at || null) : null);
        }
        filled[kind] = (filled[kind] || 0) + 1;
      } catch { /* صف واحد تالف لا يوقف الهجرة */ }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* مُنظَّف */ }
    return { ok: false, reason: 'transaction-failed', error: e.message, filled };
  }
  return { ok: true, filled };
}

function migrate(db) {
  const addedColumns = [];
  const createdTables = [];

  const before = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  for (const stmt of SCHEMA_EXT.split(';\n')) {
    const sql = stmt.trim();
    if (!sql || sql.startsWith('ALTER TABLE')) continue;
    db.exec(sql);
  }
  for (const name of CREATE_TABLES) {
    if (!before.has(name) && tableExists(db, name)) createdTables.push(name);
  }

  // تصحيحات الأعمدة تأتي بعد إنشاء الجداول: جدول يُنشأ في هذه الدورة يجب أن يحصل
  // على أعمدته في نفس الدورة، وإلا تعذّر القياس (عطل: asset_path يُضاف في كل إقلاع).
  for (const [table, patches] of Object.entries(COLUMN_PATCHES)) {
    if (!tableExists(db, table)) continue;
    const existing = new Set(tableColumns(db, table));
    for (const [column, ddl] of patches) {
      if (existing.has(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      addedColumns.push(`${table}.${column}`);
    }
  }

  for (const [indexName, table, cols] of INDEX_PATCHES) {
    if (!tableExists(db, table)) continue;
    const existing = new Set(tableColumns(db, table));
    const needed = cols.replace(/^[^(]+\(|\)$/g, '').split(',').map((c) => c.trim().replace(/\s+.*$/, ''));
    if (!needed.every((c) => existing.has(c))) continue;
    db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${cols}`);
  }

  const guards = installAuditGuards(db);
  const backfill = backfillEntities(db);

  // المراحل الثمانية تُزرع مقفلة — لا مرحلة مفتوحة بلا دليل (م42، م43)
  try {
    const have = new Set(db.prepare('SELECT stage FROM stage_state').all().map((r) => r.stage));
    for (const s of STAGES) {
      if (!have.has(s.key)) {
        db.prepare('INSERT INTO stage_state(stage, n, status) VALUES (?,?,?)').run(s.key, s.n, 'locked');
      }
    }
  } catch { /* الجدول أُنشئ للتوّ */ }

  return { ok: true, addedColumns, createdTables, guards, backfill };
}

// نوع العنصر: من الحقل الحديث أو مستنتجاً من type القديم.
// تحذير حاسم: إضافة عمود `kind` بقيمة افتراضية 'note' تجعله موجوداً في كل صف،
// فلو أخذناه دائماً لضاع نوع كل عنصر وتحوّل النظام كله إلى «ملاحظات» (عطل مؤكد
// رُصد على قاعدة حقيقية: 29 عنصراً كلها note وفيها 5 مشاريع وقرار). لذلك:
// الافتراضي 'note' لا يتمسّك إن كان `type` القديم يحدّد نوعاً أخصّ.
function kindOf(note) {
  if (!note || typeof note !== 'object') return 'note';
  const kind = note.kind;
  const legacy = note.type && Object.prototype.hasOwnProperty.call(LEGACY_KIND_MAP, note.type)
    ? LEGACY_KIND_MAP[note.type]
    : null;
  if (kind && KINDS.includes(kind)) {
    if (kind === 'note' && legacy && legacy !== 'note') return legacy;
    return kind;
  }
  return legacy || (KINDS.includes(kind) ? kind : 'note');
}

// معارف موثوقة فقط: imported/decided حقيقة، inferred/hypothesis ليست كذلك (م6)
function isVerifiedKnowledge(k) {
  return EVIDENCE_ALLOWED_KNOWLEDGE.includes(k);
}

/* ملاحظة تنظيف 2026-10-29: أُزيلت mayBeEvidence — كانت معرَّفة ومصدَّرة بلا أي مستدعٍ
   في الكود كله (كود ميت). الحراسة الفعلية لم6 قائمة في isVerifiedKnowledge المستدعاة
   عند إدخال كيانات المعرفة (knowledge_entities بثقة/دليل حسب نوع المعرفة). */

/** تحقق أن نوع العلاقة من التسعة المعتمدة أو من القديمة المتوافقة (م7) */
function isValidRelationKind(kind) {
  return Object.prototype.hasOwnProperty.call(RELATION_KINDS, kind) || LEGACY_RELATION_KINDS.includes(kind);
}

// M5 (دستور): CRUD للأصناف السبعة المستقلة على جداولها المخصصة في SQLite.
// لا تمسّ ملاحظات الـ .md — جداول مستقلة لكل صنف: project, document, file, task, decision, knowledge.
function entityCRUD(db) {
  const TABLES = {
    project: 'project_entities',
    document: 'document_entities',
    file: 'file_entities',
    task: 'task_entities',
    decision: 'decision_entities',
    knowledge: 'knowledge_entities',
  };
  function resolveTable(kind) {
    const t = TABLES[kind];
    if (!t) throw new Error(`نوع كيان غير معروف: ${kind}`);
    return t;
  }
  function save(kind, id, fields) {
    const table = resolveTable(kind);
    const cols = Object.keys(fields);
    if (!cols.length) throw new Error('لا حقول للحفظ');
    const placeholders = cols.map(() => '?').join(',');
    const sets = cols.map((c) => `${c} = ?`).join(',');
    try {
      db.prepare(`INSERT INTO ${table}(id, ${cols.join(',')}) VALUES (?,${placeholders})`).run(id, ...cols.map((c) => fields[c]));
    } catch {
      db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
    }
    return { id, kind, table };
  }
  function get(kind, id) {
    const table = resolveTable(kind);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return row || null;
  }
  function list(kind, whereSql = '', params = []) {
    const table = resolveTable(kind);
    const sql = whereSql ? `SELECT * FROM ${table} WHERE ${whereSql}` : `SELECT * FROM ${table}`;
    return db.prepare(sql).all(...params);
  }
  function remove(kind, id) {
    const table = resolveTable(kind);
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return { deleted: Number(info.changes) === 1 };
  }
  return { save, get, list, remove };
}

module.exports = {
  dedupeDocuments,
  SCHEMA_EXT,
  migrate,
  KINDS,
  ENTITY_TABLES,
  KNOWLEDGE_KINDS,
  EVIDENCE_ALLOWED_KNOWLEDGE,
  RELATION_KINDS,
  LEGACY_RELATION_KINDS,
  SENSITIVITY_LEVELS,
  SEVERITY_LEVELS,
  STAGES,
  RELEASE_GATES,
  STAGE_GATE_REQUIREMENTS,
  PROTECTED_TABLES,
  kindOf,
  isVerifiedKnowledge,
  isValidRelationKind,
  installAuditGuards,
  backfillEntities,
  tableExists,
  tableColumns,
  entityCRUD,
};
