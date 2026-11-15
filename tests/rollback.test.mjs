import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../cortex-schema');
const rb = require('../cortex-rollback');

// قاعدة مُهاجَرة كاملة (change_snapshots + audit_log + محفّزات الحماية)
function makeDb() {
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  return db;
}

// قاعدة قديمة بلا هجرة: لا change_snapshots ولا audit_log
function makeRawDb() {
  return new DatabaseSync(':memory:');
}

// كيان حقيقي بحالة JSON: القيمة تُقرأ وتُكتب فعلاً كي يكون التراجع مُثبتاً
// بالقيمة لا بالراية. نستخدم document_entities.analysis (TEXT).
function makeEntity(db, id, state) {
  db.prepare('INSERT INTO document_entities(id, analysis) VALUES (?, ?)').run(id, JSON.stringify(state));
  return {
    read: () => JSON.parse(db.prepare('SELECT analysis FROM document_entities WHERE id = ?').get(id).analysis),
    apply: (s) => {
      db.prepare('UPDATE document_entities SET analysis = ? WHERE id = ?').run(JSON.stringify(s), id);
    },
  };
}

// ─────────── ١. لقطة وتعداد ───────────

test('لقطة وتعداد: snapshot يكتب صفاً و listChanges يعرض الأحدث أولاً', () => {
  const db = makeDb();
  const a = rb.snapshot(db, { entity: 'note', entityId: 'n1', op: 'update', before: { t: 'أ' }, after: { t: 'ب' }, actor: 'tester' });
  assert.equal(a.ok, true);
  assert.equal(typeof a.id, 'number');

  const b = rb.snapshot(db, { entity: 'note', entityId: 'n1', op: 'update', before: { t: 'ب' }, after: { t: 'ج' } });
  const c = rb.snapshot(db, { entity: 'note', entityId: 'n2', op: 'create', before: null, after: { t: 'د' } });
  assert.ok(b.id > a.id);
  assert.ok(c.id > b.id);

  const list = rb.listChanges(db, { entity: 'note', entityId: 'n1' });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id, 'الأحدث يجب أن يكون أولاً');
  assert.deepEqual(list[0].after, { t: 'ج' });
  assert.deepEqual(list[1].before, { t: 'أ' });
  assert.equal(list[0].reverted, false);

  assert.equal(rb.listChanges(db, {}).length, 3);
  assert.equal(rb.listChanges(db, { entity: 'note', entityId: 'n1', limit: 1 }).length, 1);
  assert.equal(rb.listChanges(db, { entity: 'other' }).length, 0);

  const st = rb.stats(db);
  assert.deepEqual({ total: st.total, reverted: st.reverted, pending: st.pending }, { total: 3, reverted: 0, pending: 3 });
});

// ─────────── ٢. تراجع ناجح يُعيد الحالة فعلاً ───────────

test('تراجع ناجح يُعيد القيمة فعلاً (تحقّق بالقيمة لا بالراية)', () => {
  const db = makeDb();
  const ent = makeEntity(db, 'd1', { title: 'الأصل', version: 1 });
  const original = ent.read();

  const snap = rb.snapshot(db, { entity: 'document', entityId: 'd1', op: 'update', before: original, after: { title: 'مُعدَّل', version: 2 }, actor: 'tester' });

  // نغيّر الحالة فعلاً
  ent.apply({ title: 'مُعدَّل', version: 2 });
  assert.deepEqual(ent.read(), { title: 'مُعدَّل', version: 2 });

  // اللقطة معلّقة قبل التراجع
  const beforeRv = rb.stats(db);
  assert.equal(beforeRv.pending, 1);
  assert.equal(rb.canRollback(db, snap.id).canRollback, true);

  const rev = rb.revert(db, snap.id, { actor: 'tester', apply: ent.apply });
  assert.equal(rev.ok, true);
  assert.equal(rev.reverted, true);
  assert.equal(rev.audited, true);

  // الإثبات الجوهري: القيمة عادت — لا مجرد راية
  assert.deepEqual(ent.read(), original, 'الحالة لم تعد إلى القيمة الأصلية');

  const row = db.prepare('SELECT reverted, reverted_at FROM change_snapshots WHERE id = ?').get(snap.id);
  assert.equal(Number(row.reverted), 1);
  assert.ok(row.reverted_at, 'reverted_at يجب أن يُختم');

  // سجل التدقيق يحمل نوع التراجع
  const audit = db.prepare("SELECT type, tool, actor, payload FROM audit_log WHERE type = 'change_reverted' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit, 'سطر التدقيق مفقود');
  assert.equal(audit.tool, 'rollback.revert');
  assert.equal(audit.actor, 'tester');
  assert.equal(JSON.parse(audit.payload).snapshotId, snap.id);

  const after = rb.stats(db);
  assert.deepEqual({ total: after.total, reverted: after.reverted, pending: after.pending }, { total: 1, reverted: 1, pending: 0 });
  assert.equal(rb.listChanges(db, { entity: 'document', entityId: 'd1' }).length, 0, 'المُتراجَع يخرج من القائمة');
});

// ─────────── ٣. رفض التراجع مرتين ───────────

test('رفض التراجع مرتين عن اللقطة نفسها', () => {
  const db = makeDb();
  const ent = makeEntity(db, 'd2', { v: 1 });
  const snap = rb.snapshot(db, { entity: 'document', entityId: 'd2', op: 'update', before: ent.read(), after: { v: 2 } });
  ent.apply({ v: 2 });

  const first = rb.revert(db, snap.id, { apply: ent.apply });
  assert.equal(first.ok, true);
  assert.equal(first.reverted, true);

  const second = rb.revert(db, snap.id, { apply: ent.apply });
  assert.equal(second.ok, false);
  assert.equal(second.reverted, false);
  assert.match(String(second.error), /مُتراجَعة/);

  // ولا يُنفَّذ apply مرة ثانية (لا أثر مزدوج)
  assert.equal(ent.read().v, 1);
  assert.equal(rb.canRollback(db, snap.id).canRollback, false);
  assert.equal(rb.stats(db).reverted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE type = 'change_reverted'").get().n, 1);
});

// ─────────── ٤. رفض معرّف غير موجود ───────────

test('رفض التراجع بمعرّف غير موجود', () => {
  const db = makeDb();
  const r = rb.revert(db, 9999, { apply: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reverted, false);
  assert.match(String(r.error), /غير موجود/);

  const cb = rb.canRollback(db, 9999);
  assert.equal(cb.ok, true);
  assert.equal(cb.canRollback, false);
  assert.match(String(cb.reason), /غير موجود/);

  // معرّف فارغ يُرفض كذلك بلا استثناء
  assert.equal(rb.revert(db, null, { apply: () => {} }).ok, false);
  assert.equal(rb.canRollback(db, '').ok, false);
});

// ─────────── ٥. verifyRollback يُثبت ───────────

test('verifyRollback يُعيد proven=true ويثبت أن القيمة عادت', () => {
  const db = makeDb();
  const ent = makeEntity(db, 'd3', { title: 'حالة أولى', n: 1 });
  const original = ent.read();

  const res = rb.verifyRollback(db, { entity: 'document', entityId: 'd3', read: ent.read, apply: ent.apply, actor: 'gate' });
  assert.equal(res.proven, true, 'الإثبات لم ينجح: ' + JSON.stringify(res.steps));
  assert.equal(res.gate, 'rollback_proven');
  assert.ok(Array.isArray(res.steps));
  assert.ok(res.steps.length >= 5, 'خطوات الإثبات ناقصة');
  assert.ok(res.steps.every((s) => s.ok === true), 'خطوة فاشلة: ' + JSON.stringify(res.steps));

  // الإثبات بالقراءة: القيمة عادت مطابقة
  assert.deepEqual(ent.read(), original);
  assert.deepEqual(res.restored, original);

  // اللقطة المسجَّلة مُتراجَعة، ولا تغيير معلّق
  const row = db.prepare('SELECT reverted FROM change_snapshots WHERE id = ?').get(res.snapshotId);
  assert.equal(Number(row.reverted), 1);
  const st = rb.stats(db);
  assert.deepEqual({ total: st.total, reverted: st.reverted, pending: st.pending }, { total: 1, reverted: 1, pending: 0 });
});

// ─────────── ٦. حماية سجل التدقيق قائمة ───────────

test('حماية سجل التدقيق قائمة — DELETE على audit_log يُرفض', () => {
  const db = makeDb();
  db.prepare('INSERT INTO audit_log(at, type, scope, tool, actor, payload) VALUES (?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'seed', null, null, 'tester', '{}');

  assert.throws(() => db.exec('DELETE FROM audit_log'), /محمي/);
  assert.throws(() => db.exec('DELETE FROM audit_log WHERE 1=1'), /محمي/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1, 'الصف مُحي رغم المحفّز');

  // سجل التراجع محمي هو الآخر من الحذف
  const snap = rb.snapshot(db, { entity: 'note', entityId: 'n1', before: {}, after: {} });
  assert.throws(() => db.exec('DELETE FROM change_snapshots'), /محمي/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM change_snapshots WHERE id = ?').get(snap.id).n, 1);
});

// ─────────── ٧. قاعدة ناقصة بلا استثناء ───────────

test('قاعدة قديمة بلا الجداول: خطأ مفهوم لا استثناء', () => {
  const db = makeRawDb(); // بلا migrate: لا change_snapshots

  assert.doesNotThrow(() => rb.snapshot(db, { entity: 'note', entityId: 'n1', before: {}, after: {} }));
  const s = rb.snapshot(db, { entity: 'note', entityId: 'n1', before: {}, after: {} });
  assert.equal(s.ok, false);
  assert.match(String(s.error), /change_snapshots/);

  assert.deepEqual(rb.listChanges(db, {}), []);

  const r = rb.revert(db, 1, { apply: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reverted, false);
  assert.match(String(r.error), /change_snapshots/);

  const cb = rb.canRollback(db, 1);
  assert.equal(cb.ok, false);
  assert.equal(cb.canRollback, false);

  const st = rb.stats(db);
  assert.deepEqual({ total: st.total, reverted: st.reverted, pending: st.pending }, { total: 0, reverted: 0, pending: 0 });

  assert.doesNotThrow(() => rb.verifyRollback(db, { entity: 'x', entityId: 'y', read: () => ({}), apply: () => {} }));
  const vr = rb.verifyRollback(db, { entity: 'x', entityId: 'y', read: () => ({}), apply: () => {} });
  assert.equal(vr.proven, false);
  assert.ok(Array.isArray(vr.steps));
  assert.match(String(vr.error), /change_snapshots/);

  db.close();
});
