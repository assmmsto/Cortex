// tests/skills.test.mjs — مهارات الوكيل ببروتوكول ثلاثي الطبقات (cortex-skills.js)
//
// العزل إلزامي (درس 2026-10-24): كل اختبار يبني جذره في mkdtemp — لا لمس لأي
// مجلد مهارات في المشروع الحقيقي.
//
// الادعاءات المقيسة هنا (سلوك لا نص):
//   • ensureDefaults يبذر 4 مهارات مرة واحدة، و list تحمل ميتاداتا فقط بلا أجسام.
//   • get يكشف الجسم والمراجع، و renderIndex يحترم maxChars، و renderSkill يقصّ maxBody.
//   • مهارة بجسم > 6000 تُرفض وتُدرج في issues ولا تكسر list/list — الوحدة لا تسقط.
//   • readReference يرفض ../evil.md و a/b.md (اختبار أمني: لا قراءة خارج references/).
//   • تعديل القرص (وصف/جسم/مرجع/إضافة/حذف) يُلتقط بـ reload بلا إعادة إنشاء الوحدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = path.resolve(import.meta.dirname, '..');
const { createSkills } = require(path.join(root, 'cortex-skills.js'));

const SEED_NAMES = ['import-source', 'project-analysis', 'run-tests', 'write-report'];
const API_KEYS = ['ensureDefaults', 'get', 'list', 'readReference', 'reload', 'renderIndex', 'renderSkill'];

function makeSkills() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  return {
    tmp,
    dir: path.join(tmp, 'skills'),
    skills: createSkills({ dir: path.join(tmp, 'skills') }),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }),
  };
}

/** مهارة تحكم على القرص مباشرة — لاختبار الفساد والالتقاط بعد reload. */
function writeSkill(dir, name, { description = 'وصف صالح للاختبار', body = 'جسم المهارة', tags = 'a, b' } = {}) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\ntags: [${tags}]\n---\n\n${body}\n`, 'utf8');
  return d;
}

test('ensureDefaults يبذر 4 مهارات (مربع مرات) · list ميتاداتا فقط بلا أجسام', () => {
  const { dir, skills, cleanup } = makeSkills();
  try {
    // الواجهة بالضبط كما اشترط التصميم — أي مفتاح زائد يكسر هذا الادعاء
    assert.deepEqual(Object.keys(skills).sort(), [...API_KEYS].sort());

    assert.deepEqual(skills.ensureDefaults(), { created: 4 });
    assert.deepEqual(skills.ensureDefaults(), { created: 0 }, 'إعادة البذر لا تُكرّر ولا تكتب فوق موجود');

    const rel = skills.reload();
    assert.equal(rel.count, 4);
    assert.deepEqual(rel.issues, [], 'لا مشاكل في البذر السليم');

    const list = skills.list();
    assert.deepEqual(list.map((s) => s.name), SEED_NAMES, 'مرتبة بالاسم');
    for (const s of list) {
      assert.deepEqual(Object.keys(s).sort(), ['bodyChars', 'description', 'name', 'referenceCount', 'tags', 'updatedAt'].sort());
      assert.ok(!('body' in s), 'الطبقة 2 لا تدخل فهرس الميتاداتا أبداً');
      assert.ok(s.description.length > 0 && s.description.length <= 300, `وصف ${s.name} داخل السقف`);
      assert.ok(s.description.includes('Use when') || s.description.includes('استخدم عند'), 'الوصف بصيغة الاستدعاء');
      assert.ok(s.bodyChars > 0 && s.bodyChars <= 6000, `جسم ${s.name} داخل سقف 6000`);
      assert.ok(Array.isArray(s.tags) && s.tags.length > 0);
      assert.ok(!Number.isNaN(Date.parse(s.updatedAt)), 'updatedAt طابع زمني صالح');
    }

    // الطبقة 3 مكتوبة على القرص ومعدودة في الميتاداتا
    assert.equal(list.find((s) => s.name === 'project-analysis').referenceCount, 1);
    assert.ok(fs.existsSync(path.join(dir, 'project-analysis', 'references', 'tools.md')));
    for (const s of list.filter((x) => x.name !== 'project-analysis')) {
      assert.equal(s.referenceCount, 0, `${s.name} بلا مراجع كما وُعد`);
    }
  } finally { cleanup(); }
});

test('get يكشف الجسم والمراجع · renderIndex يحترم maxChars · renderSkill يقصّ maxBody', () => {
  const { dir, skills, cleanup } = makeSkills();
  try {
    skills.ensureDefaults();
    const g = skills.get('project-analysis');
    assert.equal(g.name, 'project-analysis');
    assert.ok(g.body.includes('repo_index'), 'الجسم يحمل تعليمات الأدوات');
    assert.deepEqual(g.references, ['tools.md']);
    assert.equal(g.dir, path.join(dir, 'project-analysis'));
    assert.equal(skills.get('غير-موجودة'), null);

    // الطبقة 1: فهرس شامل (سقف واسع) بلا أي جسم
    const all = skills.renderIndex('ar', { maxChars: 5000 });
    assert.ok(all.length <= 5000);
    assert.ok(all.split('\n')[0].startsWith('import-source — '), 'الفهرس مرتب بالاسم');
    for (const s of skills.list()) assert.ok(all.includes(`${s.name} — `), `${s.name} في الفهرس`);
    assert.ok(!all.includes(g.body), 'الفهرس لا يحقن الأجسام');

    // السقف: القصّ مُعلن بـ«… والمزيد» ولا يتجاوز maxChars بحرف واحد
    const cutIdx = skills.renderIndex('ar', { maxChars: 120 });
    assert.ok(cutIdx.length <= 120, `طول الفهرس ${cutIdx.length} يجب ألا يتجاوز 120`);
    assert.ok(cutIdx.includes('والمزيد'), 'القصّ يشير إلى المزيد');
    assert.ok(skills.renderIndex('en', { maxChars: 120 }).includes('and more'), 'الصيغة الإنجليزية للمؤشر');

    // الطبقة 2: حقن كامل ثم مقصوص
    const full = skills.renderSkill('project-analysis', 'ar', { maxBody: 100000 });
    assert.ok(full.includes(g.body), 'الحقن الكامل يحمل الجسم كاملاً');
    assert.ok(full.includes('tools.md'), 'أسماء المراجع تُدرج في نهاية الحقن');
    const clipped = skills.renderSkill('project-analysis', 'ar', { maxBody: 50 });
    assert.ok(clipped.includes(g.body.slice(0, 50)), 'المقصوص يحمل بداية الجسم');
    assert.ok(!clipped.includes(g.body.slice(0, 200)), 'المقصوص لا يحمل ما بعد السقف');
    assert.ok(clipped.includes('قُصّ'), 'القصّ مُعلن لا صامت');
    assert.equal(skills.renderSkill('غير-موجودة'), null);
  } finally { cleanup(); }
});

test('مهارة فاسدة (جسم > 6000 · وصف مفقود · اسم غير صالح) تُتخطى وتُدرج ولا تكسر list', () => {
  const { dir, skills, cleanup } = makeSkills();
  try {
    skills.ensureDefaults();

    const big = path.join(dir, 'too-big');
    fs.mkdirSync(big, { recursive: true });
    fs.writeFileSync(path.join(big, 'SKILL.md'), `---\nname: too-big\ndescription: مهارة بجسم ضخم\n---\n\n${'x'.repeat(6001)}\n`, 'utf8');

    const noDesc = path.join(dir, 'no-desc');
    fs.mkdirSync(noDesc, { recursive: true });
    fs.writeFileSync(path.join(noDesc, 'SKILL.md'), '---\nname: no-desc\ntags: [a]\n---\n\nجسم\n', 'utf8');

    writeSkill(dir, 'Bad Name!', { description: 'اسم غير صالح' });

    const r = skills.reload();
    assert.equal(r.count, 4, 'السليم فقط يُفهرس');
    assert.equal(skills.list().length, 4, 'الفهرس لم ينكسر');
    assert.equal(skills.get('too-big'), null);

    const reasons = new Map(r.issues.map((i) => [i.name, i.reason]));
    assert.match(reasons.get('too-big') || '', /6000/, 'سبب الرفض يذكر السقف المقاس');
    assert.match(reasons.get('no-desc') || '', /description/, 'الوصف المفقود يُدرج بسببه');
    assert.ok(reasons.get('Bad Name!'), 'الاسم غير الصالح يُدرج باسمه');
    for (const issue of r.issues) {
      assert.equal(typeof issue.name, 'string');
      assert.equal(typeof issue.reason, 'string');
    }
  } finally { cleanup(); }
});

test('readReference: حماية اجتياز المسار — ../evil.md و a/b.md و a\\b.md ترمي بخطأ', () => {
  const { dir, skills, cleanup } = makeSkills();
  try {
    skills.ensureDefaults();

    // ملفات خبيثة خارج references/ — وجودها يثبت أن الرفض بالفحص لا بالغياب
    fs.writeFileSync(path.join(dir, 'evil-root.md'), 'SECRET-ROOT', 'utf8');
    fs.writeFileSync(path.join(dir, 'project-analysis', 'evil.md'), 'SECRET-OUTSIDE-REFS', 'utf8');

    for (const evil of ['../evil.md', '..\\evil.md', 'a/b.md', 'a\\b.md', 'nested/../../evil.md']) {
      assert.throws(() => skills.readReference('project-analysis', evil), /غير صالح/, `«${evil}» يجب أن يُرفض`);
    }
    // رفض ما ليس .md حتى داخل المجلد، ورفض الغائب بمصدر صريح
    assert.throws(() => skills.readReference('project-analysis', 'evil.md'), /غير موجود/);
    assert.throws(() => skills.readReference('project-analysis', 'no-such.md'), /غير موجود/);
    assert.throws(() => skills.readReference('غير-موجودة', 'tools.md'), /غير موجودة/);

    // المسار المشروع يعمل، والسقف 20000 حرف صارم
    const ok = skills.readReference('project-analysis', 'tools.md');
    assert.ok(ok.includes('repo_index'));
    fs.writeFileSync(path.join(dir, 'project-analysis', 'references', 'long.md'), 'z'.repeat(25000), 'utf8');
    skills.reload();
    assert.equal(skills.readReference('project-analysis', 'long.md').length, 20000);

    // لا تسريب للمحتوى الخبيث بأي صيغة عادت
    assert.ok(!ok.includes('SECRET'));
  } finally { cleanup(); }
});

test('reload يلتقط تعديل القرص: جسم/مرجع/إضافة/حذف بلا إعادة إنشاء الوحدة', () => {
  const { dir, skills, cleanup } = makeSkills();
  try {
    skills.ensureDefaults();
    const before = skills.get('run-tests');

    // تعديل الجسم على القرص مباشرة — reload يقرأ الملف كاملاً (لا يعتمد على mtime وحده)
    const f = path.join(dir, 'run-tests', 'SKILL.md');
    const metaOf = (n) => skills.list().find((s) => s.name === n);
    const beforeMeta = metaOf('run-tests');
    const raw = fs.readFileSync(f, 'utf8').replace('# تشغيل الاختبارات والتحقق', '# تشغيل الاختبارات والتحقق — نسخة محدثة');
    fs.writeFileSync(f, raw, 'utf8');
    skills.reload();
    const after = skills.get('run-tests');
    assert.notEqual(after.body, before.body);
    assert.ok(after.body.includes('نسخة محدثة'), 'الجسم الجديد مقروء');
    assert.ok(Date.parse(metaOf('run-tests').updatedAt) >= Date.parse(beforeMeta.updatedAt), 'mtime لا يتقهقر');

    // مهارة تُضاف على القرص تظهر بعد reload
    writeSkill(dir, 'fresh-skill', { description: 'مهارة مضافة على القرص', body: 'اتبع القياس دائماً.' });
    assert.equal(skills.reload().count, 5);
    assert.ok(skills.list().some((s) => s.name === 'fresh-skill'));

    // مرجع (طبقة 3) يُضاف فيظهر في العدّ والقراءة بعد reload
    const refDir = path.join(dir, 'write-report', 'references');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'extra.md'), '# مرجع إضافي\nنص المرجع.', 'utf8');
    skills.reload();
    assert.ok(skills.get('write-report').references.includes('extra.md'));
    assert.equal(skills.list().find((s) => s.name === 'write-report').referenceCount, 1);
    assert.ok(skills.readReference('write-report', 'extra.md').includes('مرجع إضافي'));

    // حذف من القرص يُزال من الفهرس بعد reload
    fs.rmSync(path.join(dir, 'fresh-skill'), { recursive: true, force: true });
    assert.equal(skills.reload().count, 4);
    assert.equal(skills.get('fresh-skill'), null);
  } finally { cleanup(); }
});
