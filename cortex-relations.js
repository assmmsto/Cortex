'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// cortex-relations — العلاقات والخطورة (م7 + م8)
//
// حتمي بالكامل: لا نموذج، لا شبكة، لا عشوائية. كل قيمة إما مشتقّة حسابياً أو
// مأخوذة من صف قاعدة بيانات. لا console.log هنا: مكتبة صامتة تُعيد قيماً.
//
// مبدأان دستوريان محفوران في الكود:
//   • العلاقة لا تُخزَّن بلا مصدر ووقت وثقة — المصدر إلزامي (م7).
//   • الخطورة تُشتق من أدلة أربعة، ولا تُشتق من عدد الروابط إطلاقاً (م8).
//     عدد الروابط المدخل يُتجاهل تماماً ولو مُرّر — هذا مثبت في الاختبارات.
// ─────────────────────────────────────────────────────────────────────────────

const schema = require('./cortex-schema');

const {
  RELATION_KINDS,
  LEGACY_RELATION_KINDS,
  SENSITIVITY_LEVELS,
  SEVERITY_LEVELS,
  isValidRelationKind,
  tableColumns,
  tableExists,
} = schema;

const RELATION_KIND_NAMES = Object.freeze(Object.keys(RELATION_KINDS));

// مفاتيح عدد الروابط — تُتجاهل كلياً في اشتقاق الخطورة (م8).
// وجودها في المدخل لا يغيّر الناتج بمقدار ذرة.
const LINK_COUNT_KEYS = Object.freeze([
  'links', 'linkCount', 'links_count', 'relations', 'relationsCount',
  'relations_count', 'edges', 'edgeCount', 'degree', 'connectionCount',
]);

// أوزان الأصول الأربعة — ثوابت، لا تُشتق من شيء.
const SEVERITY_WEIGHTS = Object.freeze({
  tests: 0.25,
  sensitivity: 0.40,
  impact: 0.25,
  criticalDeps: 0.10,
});

// أثر نصّي → قيمة [0..1] حتمية. مجهول = 0 (لا دليل، لا تخمين).
const IMPACT_SCALE = Object.freeze({
  none: 0.0, negligible: 0.1, trivial: 0.1,
  low: 0.25, minor: 0.25,
  medium: 0.5, moderate: 0.5, normal: 0.5, medium_high: 0.6,
  high: 0.75, major: 0.75,
  severe: 0.9,
  critical: 1.0, critical_high: 1.0, catastrophic: 1.0,
});

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isNonEmptyString(x) {
  return typeof x === 'string' && x.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function columnsOf(db, table) {
  try { return new Set(tableColumns(db, table)); } catch { return new Set(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// سياسة النوع (م7): التسعة معتمدة، الأربعة القديمة مقبولة وموسومة legacy،
// وما عدا ذلك يُرفض برسالة واضحة تحمل النوع المرفوض.
// ─────────────────────────────────────────────────────────────────────────────
function classifyKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, reason: 'kind-missing', message: 'نوع العلاقة إلزامي: مرّر kind نصياً.' };
  }
  if (Object.prototype.hasOwnProperty.call(RELATION_KINDS, kind)) {
    return { ok: true, kind, legacy: false, kindType: 'constitutional' };
  }
  if (LEGACY_RELATION_KINDS.includes(kind)) {
    return { ok: true, kind, legacy: true, kindType: 'legacy' };
  }
  return {
    ok: false,
    reason: 'invalid-kind',
    message:
      `نوع علاقة غير صالح: "${kind}". الأنواع التسعة المعتمدة: ` +
      `${RELATION_KIND_NAMES.join(', ')}. والقديمة المقبولة (legacy): ` +
      `${LEGACY_RELATION_KINDS.join(', ')}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// addRelation (م7): يخزّن العلاقة بالمصدر والوقت والثقة إلزامياً.
// ─────────────────────────────────────────────────────────────────────────────
function addRelation(db, input) {
  const rel = input && typeof input === 'object' ? input : {};
  const { source, target, kind, origin, confidence, evidence, extractedAt } = rel;

  if (!isNonEmptyString(source)) {
    throw new Error('addRelation: source إلزامي (نص غير فارغ).');
  }
  if (!isNonEmptyString(target)) {
    throw new Error('addRelation: target إلزامي (نص غير فارغ).');
  }
  if (source === target) {
    throw new Error('addRelation: لا تُقبل علاقة من العنصر إلى نفسه.');
  }

  const cls = classifyKind(kind);
  if (!cls.ok) throw new Error(`addRelation: ${cls.message}`);

  // المصدر إلزامي: لا تُخزَّن علاقة مجهولة المصدر (م7). الحقول مفصولة لأن
  // الثقة والوقت بلا مصدر لا يعنيان شيئاً.
  if (!isNonEmptyString(origin)) {
    throw new Error(
      'addRelation: origin إلزامي — كل علاقة تُخزَّن بمصدرها ووقتها وثقتها (م7). ' +
        'rejected: origin-empty'
    );
  }

  let conf = 1.0;
  if (confidence !== undefined && confidence !== null) {
    const n = Number(confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new Error(`addRelation: confidence يجب أن تكون رقماً بين 0 و 1 (وصلت: ${confidence}).`);
    }
    conf = n;
  }

  const at = isNonEmptyString(extractedAt) ? extractedAt : nowIso();
  const ev = evidence === undefined || evidence === null
    ? null
    : (typeof evidence === 'string' ? evidence : JSON.stringify(evidence));

  db.prepare(
    `INSERT OR REPLACE INTO note_links(source, target, kind, origin, confidence, extracted_at, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(source, target, kind, origin, conf, at, ev);

  return {
    ok: true,
    source,
    target,
    kind,
    origin,
    confidence: conf,
    extractedAt: at,
    evidence: ev,
    legacy: cls.legacy,
    kindType: cls.kindType,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// relationsOf (م7): صادر/وارد مع كل حقول المصدر.
// ─────────────────────────────────────────────────────────────────────────────
function relationsOf(db, id, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
  const minConfidence = Number.isFinite(Number(opts.minConfidence)) ? Number(opts.minConfidence) : null;

  const SELECT = 'SELECT source, target, kind, origin, confidence, extracted_at, evidence FROM note_links';
  const shape = (r) => ({
    source: r.source,
    target: r.target,
    kind: r.kind,
    origin: r.origin,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    extractedAt: r.extracted_at,
    evidence: r.evidence === undefined ? null : r.evidence,
  });

  let outgoing = db.prepare(`${SELECT} WHERE source = ? ORDER BY kind, target`).all(id).map(shape);
  let incoming = db.prepare(`${SELECT} WHERE target = ? ORDER BY kind, source`).all(id).map(shape);

  const keep = (r) => (kinds ? kinds.has(r.kind) : true) && (minConfidence === null ? true : (r.confidence ?? 0) >= minConfidence);
  outgoing = outgoing.filter(keep);
  incoming = incoming.filter(keep);

  return { outgoing, incoming, total: outgoing.length + incoming.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// provenanceOf (م7): من أين جاءت العلاقة ومتى وبأي ثقة.
// ─────────────────────────────────────────────────────────────────────────────
function provenanceOf(db, source, target, kind) {
  const row = db.prepare(
    `SELECT origin, extracted_at, confidence, evidence FROM note_links
     WHERE source = ? AND target = ? AND kind = ?`
  ).get(source, target, kind);
  if (!row) return null;
  return {
    origin: row.origin,
    extractedAt: row.extracted_at,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    evidence: row.evidence === undefined ? null : row.evidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// inferRelations (م7): اشتقاق علاقات فعلية بلا تخمين.
//   • كل استيراد في repoDeps        ⇒ depends_on  (1.0, origin='repo_deps')
//   • ذكر حرفي لعنوان عنصر آخر      ⇒ references  (0.6, origin='title-mention')
//   • مستند داخل مشروع              ⇒ belongs_to  (0.9, origin='classification')
// ─────────────────────────────────────────────────────────────────────────────
function readNotes(db, provided) {
  if (Array.isArray(provided)) return provided;
  if (!tableExists(db, 'notes')) return [];
  const cols = columnsOf(db, 'notes');
  const pick = ['id', 'title', 'kind', 'knowledge_kind', 'project', 'type', 'doc_type'];
  const has = pick.filter((c) => cols.has(c));
  if (!has.includes('id')) return [];
  const contentCol = cols.has('content') ? 'content' : null;
  const sel = has.concat(contentCol ? [contentCol] : []).join(', ');
  return db.prepare(`SELECT ${sel} FROM notes`).all();
}

function readRepoDeps(db, provided) {
  if (Array.isArray(provided)) return provided;
  if (!tableExists(db, 'repo_deps')) return [];
  return db.prepare('SELECT from_file, to_file, kind FROM repo_deps').all();
}

function inferRelations(db, input) {
  const opts = input && typeof input === 'object' ? input : {};
  const notes = readNotes(db, opts.notes);
  const repoDeps = readRepoDeps(db, opts.repoDeps);

  const byKind = { depends_on: 0, references: 0, belongs_to: 0 };
  let added = 0;
  let skipped = 0;
  const skippedReasons = [];

  const existsProbe = db.prepare('SELECT 1 FROM note_links WHERE source = ? AND target = ? AND kind = ? LIMIT 1');
  const alreadyThere = (s, t, k) => !!existsProbe.get(s, t, k);

  // محاولة إضافة بأمان: لا كسر على علاقة قائمة، ويُعدُّ المكرّر "متخطّى".
  const push = (source, target, kind, origin, confidence, evidence) => {
    if (!isNonEmptyString(source) || !isNonEmptyString(target) || source === target) {
      skipped += 1;
      skippedReasons.push({ source, target, kind, reason: 'invalid-endpoints' });
      return;
    }
    if (alreadyThere(source, target, kind)) {
      skipped += 1;
      skippedReasons.push({ source, target, kind, reason: 'already-exists' });
      return;
    }
    addRelation(db, { source, target, kind, origin, confidence, evidence });
    byKind[kind] += 1;
    added += 1;
  };

  // (1) الاعتماديات من الاستيراد — حقيقة قائمة في repo_deps، ثقة كاملة.
  for (const dep of repoDeps) {
    const from = dep && (dep.from_file !== undefined ? dep.from_file : dep.from);
    const to = dep && (dep.to_file !== undefined ? dep.to_file : dep.to);
    const kind = (dep && dep.kind) || 'import';
    push(from, to, 'depends_on', 'repo_deps', 1.0, `repo_deps:${kind}`);
  }

  // (2) المستند داخل مشروع ⇒ belongs_to المشروع — تصنيف صريح، ثقة 0.9.
  /* إصلاح 2026-11-14 — القاعدة كانت ميتة مرتين:
       • تقرأ note.kind / note.project بينما الخزنة تُعطي documentType/projectName.
       • تشترط النوع 'document' بينما الأنواع الفعلية imported/spec/prd/plan…
     القياس قبل الإصلاح: 0 belongs_to من 368 ملاحظة. والهدف الآن كيان مشروع
     موجود فعلاً في project_entities — لا اسم معلّق لا يشير إلى شيء. */
  const DOC_KINDS = new Set(['document', 'doc', 'imported', 'spec', 'prd', 'plan', 'runbook', 'design', 'adr']);
  const kindOf = (n) => String(
    n.kind || n.doc_type || n.documentType
    || (n.classification && n.classification.primaryType) || ''
  ).toLowerCase();
  const projectOf = (n) => String(n.project || n.projectName || '').trim();
  let knownProjects = null;
  try {
    knownProjects = new Set(db.prepare('SELECT id FROM project_entities').all().map((r) => String(r.id)));
  } catch { knownProjects = null; }
  for (const note of notes) {
    if (!note || !isNonEmptyString(note.id)) continue;
    const kind = kindOf(note);
    const project = projectOf(note);
    if (!DOC_KINDS.has(kind) || !isNonEmptyString(project)) continue;
    if (knownProjects && knownProjects.size && !knownProjects.has(project)) continue;
    push(note.id, project, 'belongs_to', 'classification', 0.9, `note.kind=${kind};project=${project}`);
  }

  // (3) ذكر حرفي لعنوان عنصر آخر ⇒ references — دليل نصّي، ثقة أدنى 0.6.
  const targets = notes.filter((n) => n && isNonEmptyString(n.id) && isNonEmptyString(n.title));
  for (const note of notes) {
    if (!note || !isNonEmptyString(note.id)) continue;
    const haystack = `${note.title || ''}\n${note.content || ''}`;
    if (!haystack.trim()) continue;
    for (const other of targets) {
      if (other.id === note.id) continue;
      const needle = String(other.title).trim();
      if (needle.length < 3) continue; // عناوين قصيرة جداً تُحدث ضجيجاً كاذباً
      if (needle === String(note.title || '').trim()) continue; // لا ذاتية
      if (haystack.includes(needle)) {
        push(note.id, other.id, 'references', 'title-mention', 0.6, `title-mention:"${needle}"`);
      }
    }
  }

  return { added, skipped, byKind, skippedReasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveSeverity (م8): الخطورة من أدلة أربعة، لا من عدد الروابط.
//   الأصل 1: نتائج الاختبارات   (tests)
//   الأصل 2: حساسية البيانات    (sensitivity)
//   الأصل 3: الأثر المحتمل       (impact)
//   الأصل 4: الاعتمادية الحرجة   (criticalDeps)
// كل أصل مُستخدَم يُثبت في severity_evidence. عدد الروابط يُتجاهل تماماً.
// ─────────────────────────────────────────────────────────────────────────────
function sensitivityScore(value) {
  if (value === undefined || value === null || value === '') return null;
  const idx = SENSITIVITY_LEVELS.indexOf(String(value).toLowerCase());
  if (idx < 0) return null;
  return idx / (SENSITIVITY_LEVELS.length - 1); // 0 .. 1
}

function testsScore(tests) {
  if (tests === undefined || tests === null) return null;
  let failed;
  let total;
  if (typeof tests === 'number') {
    // رقم سالب = عدد اختبارات فاشلة، بلا مقام ⇒ أثر مباشر محصور.
    failed = Math.max(0, tests);
    total = null;
  } else if (typeof tests === 'object') {
    failed = Number(tests.failed !== undefined ? tests.failed : (tests.failures !== undefined ? tests.failures : tests.failing))
      || 0;
    const passed = Number(tests.passed !== undefined ? tests.passed : (tests.pass !== undefined ? tests.pass : tests.passing)) || 0;
    total = Number(tests.total) || (passed + failed);
  } else {
    return null;
  }
  let ratio;
  if (total && total > 0) ratio = failed / total;
  else ratio = failed > 0 ? 1 : 0; // بلا مقام: أي فشل = فشل كامل
  return clamp01(ratio);
}

function impactScore(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return clamp01(value > 1 ? value / 100 : value);
  const key = String(value).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(IMPACT_SCALE, key)) return IMPACT_SCALE[key];
  // أرقام مكتوبة نصاً تُقرأ كأرقام
  const n = Number(key);
  if (Number.isFinite(n)) return clamp01(n > 1 ? n / 100 : n);
  return null;
}

function criticalDepsScore(value) {
  if (value === undefined || value === null) return null;
  let count;
  if (Array.isArray(value)) count = value.length;
  else if (typeof value === 'number') count = Math.max(0, value);
  else if (typeof value === 'object') count = Object.keys(value).length;
  else if (typeof value === 'string') count = value.trim() ? value.split(',').filter((s) => s.trim()).length : 0;
  else return null;
  if (count <= 0) return 0;
  return clamp01(count / 3); // ثلاث اعتماديات حرجة أو أكثر = التشبّع
}

function levelFor(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

function deriveSeverity(db, entityId, input) {
  const opts = input && typeof input === 'object' ? input : {};
  if (!isNonEmptyString(entityId)) {
    throw new Error('deriveSeverity: entityId إلزامي (نص غير فارغ).');
  }
  if (opts.countLinks === true || opts.useLinkCount === true) {
    // م8: ممنوع قانونياً الاشتقاق من عدد الروابط — طلبُ ذلك خطأ صريح لا صمت.
    throw new Error('deriveSeverity: الاشتقاق من عدد الروابط ممنوع (م8).');
  }

  const tScore = testsScore(opts.tests);
  const sScore = sensitivityScore(opts.sensitivity);
  const iScore = impactScore(opts.impact);
  const cScore = criticalDepsScore(opts.criticalDeps);

  // الأصول المستخدمة فعلاً (لها دليل). غير المستخدمة لا تدخل الحساب ولا الإثبات.
  const used = {
    tests: tScore !== null,
    sensitivity: sScore !== null,
    impact: iScore !== null,
    criticalDeps: cScore !== null,
  };

  const contributions = { tests: 0, sensitivity: 0, impact: 0, criticalDeps: 0 };
  if (used.tests) contributions.tests = SEVERITY_WEIGHTS.tests * tScore;
  if (used.sensitivity) contributions.sensitivity = SEVERITY_WEIGHTS.sensitivity * sScore;
  if (used.impact) contributions.impact = SEVERITY_WEIGHTS.impact * iScore;
  if (used.criticalDeps) contributions.criticalDeps = SEVERITY_WEIGHTS.criticalDeps * cScore;

  const raw = contributions.tests + contributions.sensitivity + contributions.impact + contributions.criticalDeps;
  const score = Math.round(clamp01(raw) * 100);
  const severity = levelFor(score);

  // لو مُرّر عدد روابط، يُذكر أنه مُتجاهَل — ولا يمسّ الدرجة.
  const ignoredLinkKeys = LINK_COUNT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(opts, k));

  const evidence = {
    entity: isNonEmptyString(opts.entity) ? opts.entity : 'note',
    entityId,
    at: isNonEmptyString(opts.at) ? opts.at : nowIso(),
    severity,
    score,
    used,
    contributions,
    testsEvidence: used.tests ? JSON.stringify({ input: opts.tests, ratio: tScore }) : null,
    sensitivity: used.sensitivity ? String(opts.sensitivity).toLowerCase() : null,
    impact: used.impact ? JSON.stringify({ input: opts.impact, value: iScore }) : null,
    criticalDeps: used.criticalDeps
      ? JSON.stringify({ count: Array.isArray(opts.criticalDeps) ? opts.criticalDeps.length : opts.criticalDeps, value: cScore })
      : null,
    ignoredLinkKeys,
  };

  db.prepare(
    `INSERT INTO severity_evidence(at, entity, entity_id, severity, tests_evidence, sensitivity, impact, critical_deps, score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    evidence.at,
    evidence.entity,
    evidence.entityId,
    evidence.severity,
    evidence.testsEvidence,
    evidence.sensitivity,
    evidence.impact,
    evidence.criticalDeps,
    evidence.score
  );

  return { severity, score, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// coverage (م7): تغطية الأنواع التسعة في قاعدة العلاقات.
// ─────────────────────────────────────────────────────────────────────────────
function coverage(db) {
  const rows = db.prepare('SELECT DISTINCT kind FROM note_links').all();
  const seen = new Set(rows.map((r) => r.kind));
  const kindsPresent = RELATION_KIND_NAMES.filter((k) => seen.has(k));
  const kindsMissing = RELATION_KIND_NAMES.filter((k) => !seen.has(k));
  const legacyPresent = LEGACY_RELATION_KINDS.filter((k) => seen.has(k));
  /* «متى استُنبطت آخر مرة» و«كم صفاً مُصنَّفاً» (2026-11-14): بدونهما كانت
     الشاشة تقول «0 من 9» بلا أن تفرّق بين «لم يُشغَّل قط» و«شُغِّل ولم يجد».
     وعدد تقديرات الخطورة يُقاس من جدوله لا من الواجهة. */
  let lastInferredAt = null;
  let typedRows = 0;
  try {
    const r = db.prepare(
      "SELECT COUNT(*) c, MAX(extracted_at) m FROM note_links WHERE origin IS NOT NULL AND origin NOT IN ('wikilink:auto','decision_project')"
    ).get();
    typedRows = Number(r && r.c) || 0;
    lastInferredAt = (r && r.m) || null;
  } catch { /* جدول بلا أعمدة قديمة */ }
  let severityRows = 0;
  try { severityRows = db.prepare('SELECT COUNT(*) c FROM severity_evidence').get().c; } catch { severityRows = 0; }
  return {
    kindsPresent,
    kindsMissing,
    total: RELATION_KIND_NAMES.length,
    present: kindsPresent.length,
    legacyPresent,
    typedRows,
    lastInferredAt,
    severityRows,
  };
}

module.exports = {
  addRelation,
  relationsOf,
  provenanceOf,
  inferRelations,
  deriveSeverity,
  coverage,
  // ثوابت مساعدة للاختبار وللتكامل
  RELATION_KIND_NAMES,
  SEVERITY_WEIGHTS,
};
