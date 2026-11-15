'use strict';
const i18n = require('./cortex-i18n');

// ════════════════════════════════════════════════════════════════════
//  cortex-rollback — التراجع الحقيقي المُثبت (دستور §38 + بوابة §45)
//
//  القاعدة الدستورية الحاكمة هنا: القرار الأمني بكود لا بنموذج (§35).
//  لذلك هذا الملف حتمي بحت: لا نداء نموذج، لا شبكة، لا عشوائية.
//  كل دالة تفحص وجود الجدول أولاً وتُعيد خطأً مفهوماً بدل أن ترمي استثناءً،
//  لأن قاعدة قديمة (بلا هجرة) يجب ألّا تُسقط الوكيل.
//
//  المنطق الجوهري: لا «تراجع» بادعاء. اللقطة تُكتب قبل التغيير، والتراجع
//  يُنفّذ عبر دالة `apply` محقونة من الخارج، ثم يثبت `verifyRollback` أن
//  القيمة عادت فعلاً بالقراءة — لا برفع راية `reverted`.
// ════════════════════════════════════════════════════════════════════

const { isDeepStrictEqual } = require('node:util');

const SNAPSHOT_TABLE = 'change_snapshots';
const AUDIT_TABLE = 'audit_log';
const AUDIT_TYPE_REVERTED = 'change_reverted';
const GATE_KEY = 'rollback_proven';           // مفتاح بوابة الإطلاق (م45)
const PROBE_FIELD = '__cortex_rollback_probe__';

const ERR_NO_DB = 'قاعدة بيانات غير صالحة — الكائن لا يحوي prepare()';
const ERR_NO_TABLE = `جدول ${SNAPSHOT_TABLE} غير موجود — شغّل cortex-schema.migrate(db) أولاً`;
const ERR_NO_ID = i18n.T('معرّف اللقطة مطلوب', 'Snapshot id is required');
const ERR_NO_ENTITY = 'الحقلان entity و entityId مطلوبان';
const ERR_NO_APPLY = 'دالة apply مطلوبة لتنفيذ الاسترجاع الفعلي';
const ERR_NO_READ = i18n.T('دالتا apply و read مطلوبتان لإثبات التراجع', 'apply and read are both required to prove the rollback');

function nowIso() {
  return new Date().toISOString();
}

/** فحص وجود جدول — لا نلمس قاعدة لم تُهاجَر. */
function hasTable(db, name) {
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
    return !!row;
  } catch {
    return false;
  }
}

/** حارس موحّد: يُعيد { ok } أو { ok:false, error } بدل الاستثناء. */
function guard(db) {
  if (!db || typeof db.prepare !== 'function') return { ok: false, error: ERR_NO_DB };
  if (!hasTable(db, SNAPSHOT_TABLE)) return { ok: false, error: ERR_NO_TABLE };
  return { ok: true };
}

function toId(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** يقبل رقماً أو نصاً رقمياً أو bigint؛ يُعيد null إن كان فارغاً. */
function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function safeParse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return fallback; }
}

function safeStringify(value) {
  if (value === undefined) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

function cloneState(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function clamp(n, fallback, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function mapRow(row) {
  return {
    id: toId(row.id),
    at: row.at,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    before: safeParse(row.before_state, null),
    after: safeParse(row.after_state, null),
    reverted: Number(row.reverted) === 1,
    revertedAt: row.reverted_at || null,
    actor: row.actor || null,
    runId: row.run_id || null,
  };
}

/**
 * §38: لقطة قبل كل تغيير. تُخزَّن before/after كـ JSON.
 * تُعيد { ok, id }.
 */
function snapshot(db, opts = {}) {
  const g = guard(db);
  if (!g.ok) return { ok: false, error: g.error };

  const entity = opts.entity == null ? '' : String(opts.entity).trim();
  const entityId = opts.entityId == null ? '' : String(opts.entityId).trim();
  if (!entity || !entityId) return { ok: false, error: ERR_NO_ENTITY };

  const op = opts.op == null || String(opts.op).trim() === '' ? 'update' : String(opts.op).trim();
  const at = nowIso();

  try {
    const info = db.prepare(
      `INSERT INTO ${SNAPSHOT_TABLE}(at, entity, entity_id, op, before_state, after_state, reverted, actor, run_id)
       VALUES (?,?,?,?,?,?,0,?,?)`
    ).run(
      at, entity, entityId, op,
      safeStringify(opts.before), safeStringify(opts.after),
      opts.actor == null ? null : String(opts.actor),
      opts.runId == null ? null : String(opts.runId)
    );
    return { ok: true, id: toId(info.lastInsertRowid), at };
  } catch (e) {
    return { ok: false, error: `تعذّر تسجيل اللقطة: ${e.message}` };
  }
}

/** التغييرات غير المُتراجَعة، الأحدث أولاً (بلا صفوف reverted=1). */
function listChanges(db, opts = {}) {
  const g = guard(db);
  if (!g.ok) return [];

  const where = ['reverted = 0'];
  const params = [];
  if (opts.entity != null && String(opts.entity).trim() !== '') {
    where.push('entity = ?');
    params.push(String(opts.entity).trim());
  }
  if (opts.entityId != null && String(opts.entityId).trim() !== '') {
    where.push('entity_id = ?');
    params.push(String(opts.entityId).trim());
  }
  const limit = clamp(opts.limit, 50, 1, 1000);

  try {
    const rows = db.prepare(
      `SELECT * FROM ${SNAPSHOT_TABLE} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`
    ).all(...params, limit);
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/** يكتب سطر تدقيق. تعذّر الكتابة لا يُسقط التراجع لكنه يظهر في النتيجة. */
function writeAudit(db, entry) {
  if (!hasTable(db, AUDIT_TABLE)) return false;
  try {
    db.prepare(
      `INSERT INTO ${AUDIT_TABLE}(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)`
    ).run(
      entry.at || nowIso(),
      AUDIT_TYPE_REVERTED,
      SNAPSHOT_TABLE,
      'rollback.revert',
      entry.actor == null ? 'system' : String(entry.actor),
      safeStringify({
        snapshotId: entry.snapshotId,
        entity: entry.entity,
        entityId: entry.entityId,
        op: entry.op,
        before: entry.before ?? null,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * §38: تراجع فعلي. يرفض اللقطة غير الموجودة أو المُتراجَعة سابقاً.
 * `apply` محقونة: تُستدعى بـ (beforeState) فتُعيد الحالة فعلاً.
 * الشرط الذرّي `reverted = 0` في UPDATE يمنع التراجع المزدوج حتى تحت تنافس.
 */
function revert(db, snapshotId, opts = {}) {
  const g = guard(db);
  if (!g.ok) return { ok: false, reverted: false, error: g.error };

  const id = normalizeId(snapshotId);
  if (id === null) return { ok: false, reverted: false, error: ERR_NO_ID };
  if (typeof opts.apply !== 'function') return { ok: false, reverted: false, error: ERR_NO_APPLY };

  let row;
  try {
    row = db.prepare(`SELECT * FROM ${SNAPSHOT_TABLE} WHERE id = ?`).get(id);
  } catch (e) {
    return { ok: false, reverted: false, error: e.message };
  }
  if (!row) return { ok: false, reverted: false, error: `لقطة غير موجودة: ${id}` };
  if (Number(row.reverted) === 1) {
    return { ok: false, reverted: false, alreadyReverted: true, error: `اللقطة ${id} مُتراجَعة سابقاً` };
  }

  const beforeState = safeParse(row.before_state, null);
  const at = nowIso();

  db.exec('BEGIN');
  try {
    opts.apply(beforeState);                    // التنفيذ الفعلي — خارج هذا الملف
    const info = db.prepare(
      `UPDATE ${SNAPSHOT_TABLE} SET reverted = 1, reverted_at = ? WHERE id = ? AND reverted = 0`
    ).run(at, id);
    if (Number(info.changes) !== 1) throw new Error('سُبق التراجع عن هذه اللقطة');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* مُنظَّف مسبقاً */ }
    return { ok: false, reverted: false, error: e.message };
  }

  const audited = writeAudit(db, {
    at,
    actor: opts.actor,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    snapshotId: toId(row.id),
    before: beforeState,
  });

  return {
    ok: true,
    reverted: true,
    id: toId(row.id),
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    before: beforeState,
    audited,
  };
}

/** حالة تُغيّر الشكل فعلاً كي لا يكون الإثبات مجانياً (تغيير بلا تغيير). */
function probeState(original) {
  if (Array.isArray(original)) return original.concat([{ [PROBE_FIELD]: true }]);
  if (original && typeof original === 'object') {
    return Object.assign({}, original, { [PROBE_FIELD]: true });
  }
  return original;
}

function step(name, ok, note = null) {
  return { step: name, ok: !!ok, note: note || null };
}

/**
 * بوابة §45 «rollback_proven»: إثبات التراجع بالكود لا بالادعاء.
 * يقرأ الحالة → يغيّرها عبر apply → يلتقط لقطة → يتراجع → يتحقق أن
 * القراءة عادت مطابقة للأصل (isDeepStrictEqual). يُعيد { proven, steps }.
 */
function verifyRollback(db, opts = {}) {
  const steps = [];

  const g = guard(db);
  if (!g.ok) {
    steps.push(step('guard', false, g.error));
    return { proven: false, steps, error: g.error };
  }
  if (typeof opts.apply !== 'function' || typeof opts.read !== 'function') {
    steps.push(step('guard', false, ERR_NO_READ));
    return { proven: false, steps, error: ERR_NO_READ };
  }

  const entity = opts.entity == null ? '' : String(opts.entity).trim();
  const entityId = opts.entityId == null ? '' : String(opts.entityId).trim();
  if (!entity || !entityId) {
    steps.push(step('guard', false, ERR_NO_ENTITY));
    return { proven: false, steps, error: ERR_NO_ENTITY };
  }

  // ١) الحالة الأصلية
  let before;
  try {
    before = opts.read();
  } catch (e) {
    steps.push(step('read_original', false, e.message));
    return { proven: false, steps, error: e.message };
  }
  if (before === undefined) {
    steps.push(step('read_original', false, 'read() لم تُعد قيمة'));
    return { proven: false, steps, error: 'read() لم تُعد قيمة' };
  }
  steps.push(step('read_original', true));

  // ٢) تغيير فعلي
  const probe = probeState(cloneState(before));
  let afterApply;
  try {
    opts.apply(probe);
    afterApply = opts.read();
  } catch (e) {
    steps.push(step('state_changed', false, e.message));
    return { proven: false, steps, error: e.message };
  }
  const changed = !isDeepStrictEqual(afterApply, before);
  if (!changed) {
    steps.push(step('state_changed', false, 'القيمة لم تتغيّر — لا إثبات بلا تغيير فعلي'));
    return { proven: false, steps, error: 'القيمة لم تتغيّر' };
  }
  steps.push(step('state_changed', true));

  // ٣) لقطة قبل التراجع
  const snap = snapshot(db, {
    entity,
    entityId,
    op: opts.op || 'verify',
    before: cloneState(before),
    after: cloneState(afterApply),
    actor: opts.actor || 'rollback-verify',
    runId: opts.runId || null,
  });
  if (!snap.ok) {
    steps.push(step('snapshot', false, snap.error));
    return { proven: false, steps, error: snap.error };
  }
  steps.push(step('snapshot', true, `لقطة رقم ${snap.id}`));

  // ٤) التراجع الفعلي
  const rev = revert(db, snap.id, { actor: opts.actor || 'rollback-verify', apply: opts.apply });
  if (!rev.ok) {
    steps.push(step('revert', false, rev.error));
    return { proven: false, steps, error: rev.error, snapshotId: snap.id };
  }
  steps.push(step('revert', true));

  // ٥) الإثبات بالقراءة لا بالراية
  let restored;
  try {
    restored = opts.read();
  } catch (e) {
    steps.push(step('verify_restored', false, e.message));
    return { proven: false, steps, error: e.message, snapshotId: snap.id };
  }
  const proven = isDeepStrictEqual(restored, before);
  steps.push(step('verify_restored', proven, proven ? null : 'القيمة لم تعد مطابقة للأصل'));

  return { proven, steps, snapshotId: snap.id, before, after: afterApply, restored, gate: GATE_KEY };
}

/** فحص حتمي: هل يمكن التراجع عن هذه اللقطة الآن؟ */
function canRollback(db, snapshotId) {
  const g = guard(db);
  if (!g.ok) return { ok: false, canRollback: false, error: g.error };

  const raw = snapshotId !== null && typeof snapshotId === 'object' ? snapshotId.id : snapshotId;
  const id = normalizeId(raw);
  if (id === null) return { ok: false, canRollback: false, error: ERR_NO_ID };

  let row;
  try {
    row = db.prepare(`SELECT id, reverted FROM ${SNAPSHOT_TABLE} WHERE id = ?`).get(id);
  } catch (e) {
    return { ok: false, canRollback: false, error: e.message };
  }
  if (!row) return { ok: true, canRollback: false, reason: `لقطة غير موجودة: ${id}` };
  if (Number(row.reverted) === 1) return { ok: true, canRollback: false, reason: 'اللقطة مُتراجَعة سابقاً' };
  return { ok: true, canRollback: true, reason: null };
}

/** إحصاء اللقطات: total/reverted/pending. */
function stats(db) {
  const g = guard(db);
  if (!g.ok) return { total: 0, reverted: 0, pending: 0, ok: false, error: g.error };
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN reverted = 1 THEN 1 ELSE 0 END), 0) AS reverted
         FROM ${SNAPSHOT_TABLE}`
    ).get();
    const total = Number(row.total) || 0;
    const reverted = Number(row.reverted) || 0;
    return { total, reverted, pending: total - reverted, ok: true };
  } catch (e) {
    return { total: 0, reverted: 0, pending: 0, ok: false, error: e.message };
  }
}

module.exports = {
  snapshot,
  listChanges,
  revert,
  verifyRollback,
  canRollback,
  stats,
  // ثوابت مساعدة
  SNAPSHOT_TABLE,
  AUDIT_TABLE,
  AUDIT_TYPE_REVERTED,
  GATE_KEY,
  hasTable,
};
