import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rel = require('../cortex-relations.js');
const schema = require('../cortex-schema.js');

// قاعدة اختبار مطابقة لِما تفترضه cortex-schema.migrate: الجداول الأساسية
// تُنشأ أولاً ثم يُطلق الترحيل ليضيف الأعمدة (origin/confidence/extracted_at/evidence).
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT)');
  db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
  db.exec('CREATE TABLE tasks(id TEXT)');
  schema.migrate(db);
  return db;
}

test('كل نوع من الأنواع التسعة يُقبل ويُخزَّن بمصدره ووقته وثقته', () => {
  const db = makeDb();
  for (const kind of Object.keys(schema.RELATION_KINDS)) {
    const res = rel.addRelation(db, {
      source: `s:${kind}`,
      target: `t:${kind}`,
      kind,
      origin: 'test-harness',
      confidence: 0.8,
    });
    assert.equal(res.ok, true, `kind ${kind} should be accepted`);
    assert.equal(res.legacy, false, `kind ${kind} is constitutional, not legacy`);
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM note_links').get().c;
  assert.equal(total, 9, `تسعة أنواع دستورية تُخزَّن: ${total}`);
  db.close();
});

test('نوع باطل يُرفض برسالة واضحة', () => {
  const db = makeDb();
  assert.throws(
    () => rel.addRelation(db, { source: 'a', target: 'b', kind: 'loves', origin: 'x' }),
    (err) => err instanceof Error && err.message.includes('loves') && err.message.includes('غير صالح')
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM note_links').get().c, 0);
  db.close();
});

test('النوع القديم يُقبل ويُوسَم legacy=true', () => {
  const db = makeDb();
  const res = rel.addRelation(db, {
    source: 'a', target: 'b', kind: 'references', origin: 'legacy-migrator', confidence: 0.5,
  });
  assert.equal(res.ok, true);
  assert.equal(res.legacy, true, 'references نوع قديم ⇒ legacy');
  assert.ok(schema.LEGACY_RELATION_KINDS.includes('references'));
  assert.ok(!Object.prototype.hasOwnProperty.call(schema.RELATION_KINDS, 'references'));
  db.close();
});

test('origin فارغ يُرفض: المصدر إلزامي (م7)', () => {
  const db = makeDb();
  assert.throws(
    () => rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on', origin: '' }),
    (err) => err instanceof Error && err.message.includes('origin')
  );
  assert.throws(
    () => rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on', origin: '   ' }),
    /origin/
  );
  assert.throws(
    () => rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on' }),
    /origin/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM note_links').get().c, 0);
  db.close();
});

test('provenanceOf تُعيد المصدر والوقت والثقة', () => {
  const db = makeDb();
  const at = '2026-10-19T10:00:00.000Z';
  rel.addRelation(db, {
    source: 'svc', target: 'db', kind: 'depends_on',
    origin: 'repo_deps', confidence: 0.75, evidence: 'import:sqlite', extractedAt: at,
  });
  const p = rel.provenanceOf(db, 'svc', 'db', 'depends_on');
  assert.deepEqual(p, { origin: 'repo_deps', extractedAt: at, confidence: 0.75, evidence: 'import:sqlite' });
  assert.equal(rel.provenanceOf(db, 'nope', 'x', 'depends_on'), null);
  db.close();
});

test('relationsOf تفصل الصادر عن الوارد وتحمل حقول المصدر', () => {
  const db = makeDb();
  rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on', origin: 'repo_deps', confidence: 1.0 });
  rel.addRelation(db, { source: 'c', target: 'a', kind: 'references', origin: 'title-mention', confidence: 0.6 });
  const r = rel.relationsOf(db, 'a');
  assert.equal(r.outgoing.length, 1);
  assert.equal(r.incoming.length, 1);
  assert.equal(r.outgoing[0].origin, 'repo_deps');
  assert.equal(r.incoming[0].origin, 'title-mention');
  // فلترة بالثقة
  const filtered = rel.relationsOf(db, 'a', { minConfidence: 0.9 });
  assert.equal(filtered.outgoing.length, 1);
  assert.equal(filtered.incoming.length, 0);
  db.close();
});

test('inferRelations: depends_on من repoDeps، belongs_to من التصنيف، مع origin', () => {
  const db = makeDb();
  const notes = [
    { id: 'doc1', title: 'Atlas PRD', kind: 'document', project: 'Atlas', content: 'يشرح نظام Atlas PRD' },
    { id: 'note2', title: 'ملاحظة حرة', kind: 'note', project: null, content: 'تعتمد على Atlas PRD في التصميم' },
  ];
  const repoDeps = [
    { from_file: 'server.js', to_file: 'db.js', kind: 'import' },
    { from_file: 'db.js', to_file: 'sqlite', kind: 'import' },
  ];

  const res = rel.inferRelations(db, { notes, repoDeps });
  assert.ok(res.added >= 3, `expected >=3 relations, got ${res.added}`);
  assert.equal(res.byKind.depends_on, 2, 'استيرادان ⇒ depends_on اثنان');
  assert.equal(res.byKind.belongs_to, 1, 'مستند داخل مشروع ⇒ belongs_to واحد');
  assert.ok(res.skipped >= 0);

  // depends_on مصدره repo_deps بثقة 1.0
  const dep = rel.provenanceOf(db, 'server.js', 'db.js', 'depends_on');
  assert.equal(dep.origin, 'repo_deps');
  assert.equal(dep.confidence, 1.0);

  // belongs_to مصدره classification بثقة 0.9
  const bel = rel.provenanceOf(db, 'doc1', 'Atlas', 'belongs_to');
  assert.equal(bel.origin, 'classification');
  assert.equal(bel.confidence, 0.9);

  // ذكر حرفي لعنوان مستند آخر داخل المحتوى ⇒ references بثقة 0.6
  const ref = rel.provenanceOf(db, 'note2', 'doc1', 'references');
  assert.equal(ref.origin, 'title-mention');
  assert.equal(ref.confidence, 0.6);

  // تشغيل ثانٍ: كل المكرّر يُتخطّى، لا إضافة جديدة
  const res2 = rel.inferRelations(db, { notes, repoDeps });
  assert.equal(res2.added, 0, 'لا تكرار عند إعادة الاشتقاق');
  assert.ok(res2.skipped >= 3);
  db.close();
});

test('حاسم: الخطورة لا تُشتق من عدد الروابط — 10 و 1000 رابط ⇒ نتيجة متطابقة', () => {
  const db = makeDb();
  const baseInputs = {
    tests: { passed: 8, failed: 2, total: 10 },
    sensitivity: 'confidential',
    impact: 'high',
    criticalDeps: ['auth', 'billing'],
  };

  // مدخلان متطابقان تماماً في الأصول الأربعة، ويختلفان فقط في عدد الروابط.
  const tenLinks = rel.deriveSeverity(db, 'entity-X', { ...baseInputs, links: 10, linkCount: 10 });
  const thousandLinks = rel.deriveSeverity(db, 'entity-X', { ...baseInputs, links: 1000, linkCount: 1000 });

  assert.equal(tenLinks.score, thousandLinks.score, 'الدرجة يجب أن تكون متطابقة رغم فرق عدد الروابط');
  assert.equal(tenLinks.severity, thousandLinks.severity, 'المستوى يجب أن يكون متطابقاً');
  assert.deepEqual(tenLinks.evidence.contributions, thousandLinks.evidence.contributions);
  // عدد الروابط مُتجاهَل ومُوثَّق أنه مُتجاهَل
  assert.deepEqual(thousandLinks.evidence.ignoredLinkKeys.sort(), ['linkCount', 'links']);

  console.log(
    `إثبات استقلال الخطورة عن عدد الروابط: score(10 links)=${tenLinks.score} & ${tenLinks.severity} ` +
    `=== score(1000 links)=${thousandLinks.score} & ${thousandLinks.severity} ` +
    `⇒ delta=${thousandLinks.score - tenLinks.score}`
  );

  db.close();
});

test('deriveSeverity: حساسية restricted أعلى مستوى من public', () => {
  const db = makeDb();
  const common = { tests: { passed: 9, failed: 1, total: 10 }, impact: 'medium', criticalDeps: [] };
  const pub = rel.deriveSeverity(db, 'pub', { ...common, sensitivity: 'public' });
  const res = rel.deriveSeverity(db, 'res', { ...common, sensitivity: 'restricted' });

  const order = schema.SEVERITY_LEVELS;
  assert.ok(res.score > pub.score, `restricted(${res.score}) يجب أن يتجاوز public(${pub.score})`);
  assert.ok(
    order.indexOf(res.severity) > order.indexOf(pub.severity),
    `مستوى restricted (${res.severity}) أعلى من public (${pub.severity})`
  );
  db.close();
});

test('كل أصل مُستخدَم مُثبت في severity_evidence، وغير المُستخدَم لا يُثبت', () => {
  const db = makeDb();
  rel.deriveSeverity(db, 'e1', {
    tests: { passed: 1, failed: 1, total: 2 },
    sensitivity: 'confidential',
    impact: 'critical',
    criticalDeps: ['a'],
  });
  const row = db.prepare('SELECT * FROM severity_evidence WHERE entity_id = ? ORDER BY id DESC').get('e1');
  assert.ok(row, 'صف دليل مكتوب');
  assert.ok(row.tests_evidence, 'أصل الاختبارات مُثبت');
  assert.equal(row.sensitivity, 'confidential', 'أصل الحساسية مُثبت');
  assert.ok(row.impact, 'أصل الأثر مُثبت');
  assert.ok(row.critical_deps, 'أصل الاعتمادية الحرجة مُثبت');
  assert.equal(typeof row.score, 'number');

  // مدخل بأصلين فقط: الأصلان الغائبان يبقيان NULL (لا يُثبت ما لم يُستخدم)
  rel.deriveSeverity(db, 'e2', { sensitivity: 'internal', impact: 'low' });
  const row2 = db.prepare('SELECT * FROM severity_evidence WHERE entity_id = ? ORDER BY id DESC').get('e2');
  assert.equal(row2.tests_evidence, null, 'أصل غير مُستخدَم ⇒ NULL');
  assert.equal(row2.critical_deps, null, 'أصل غير مُستخدَم ⇒ NULL');
  assert.ok(row2.sensitivity, 'الأصلان المُستخدَمان مُثبتان');
  db.close();
});

test('coverage تكشف الأنواع الغائبة', () => {
  const db = makeDb();
  const empty = rel.coverage(db);
  assert.equal(empty.total, 9);
  assert.equal(empty.kindsPresent.length, 0);
  assert.equal(empty.kindsMissing.length, 9, 'كل التسعة غائبة على قاعدة فارغة');

  rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on', origin: 'repo_deps' });
  rel.addRelation(db, { source: 'b', target: 'c', kind: 'risks', origin: 'analysis' });

  const c = rel.coverage(db);
  assert.deepEqual(c.kindsPresent.sort(), ['depends_on', 'risks']);
  assert.equal(c.kindsMissing.length, 7, 'سبعة أنواع غائبة');
  assert.ok(c.kindsMissing.includes('tested_by'));
  db.close();
});

// ─── إصلاح 2026-11-14: القاعدة كانت ميتة بسبب أسماء حقول لا وجود لها ───────────
test('belongs_to يعمل على شكل الخزنة الحقيقي (documentType/projectName)', () => {
  const db = makeDb();
  // كيان مشروع فعلي — الهدف لا يكون معلّقاً (الجدول يُنشئه cortex-schema)
  db.prepare("INSERT INTO project_entities(id, state, created_at) VALUES ('atlas','active','2026-11-14')").run();
  const notes = [
    // شكل core.readNotes: documentType + projectName، ولا kind ولا project
    { id: 'doc-a', title: 'متطلب المنتج', documentType: 'imported', projectName: 'atlas', body: 'نص' },
    { id: 'doc-b', title: 'خطة الإطلاق', documentType: 'plan', projectName: 'atlas', body: 'نص' },
    // مشروع غير موجود في الكيانات ⇒ لا هدف معلّق
    { id: 'doc-c', title: 'مستند يتيم', documentType: 'imported', projectName: 'ghost-proj', body: 'نص' },
  ];
  const res = rel.inferRelations(db, { notes });
  assert.equal(res.byKind.belongs_to, 2, `belongs_to للاثنين الموجودين فقط: ${res.byKind.belongs_to}`);
  assert.equal(rel.provenanceOf(db, 'doc-a', 'atlas', 'belongs_to').origin, 'classification');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM note_links WHERE target='ghost-proj'").get().c, 0, 'لا هدف معلّق');
  db.close();
});

test('coverage تقول متى استُنبطت آخر مرة وكم صفاً مُصنَّفاً', () => {
  const db = makeDb();
  rel.addRelation(db, { source: 'a', target: 'b', kind: 'depends_on', origin: 'repo_deps', confidence: 1 });
  const c = rel.coverage(db);
  assert.equal(c.typedRows, 1, 'صف مُصنَّف واحد');
  assert.ok(c.lastInferredAt, 'وقت الاستنتاج مُبلَّغ');
  assert.equal(c.severityRows, 0, 'لا تقديرات بعد');
  assert.ok(c.kindsPresent.includes('depends_on'));
  db.close();
});
