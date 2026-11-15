/**
 * C1 — حارس البحث: مقطع فهرس يتيم لا يُسقط البحث.
 *
 * العطل المُثبت حياً (2026-11-15، 17:17:44 UTC): `cortex-core.js:1956`
 * `id: item.note.id` — مقطعٌ في `vector-index.json` لملاحظة **حُذفت** من الخزنة
 * (`trial-بوابة-الدفع`) يمرّ الفلاتر (lexical>0 وscore>=minScore) فيصل إلى
 * `notesMap.get(noteId) === undefined`، ثم يُنفَّذ `item.note.id` فيرمي
 * TypeError ⇒ **500** لكل استعلام يطابق ذلك العنوان (قيست: 8/8 استعلامات).
 *
 * القاعدة الصحيحة: مقطع بلا ملف = حقيقة قد تكون مؤقتة (حذف/إعادة بناء)،
 * فيُستبعد من النتائج ولا يُسقط البحث كله.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { createCore } = require(path.join(ROOT, 'cortex-core.js'));

const tmpRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-index-'));
  fs.mkdirSync(path.join(r, 'vault'), { recursive: true });
  return r;
};

test('C1 · مقطع لفهرس ملاحظة محذوفة لا يُسقط البحث (كان 500)', async () => {
  const root = tmpRoot();
  const core = createCore({ root, projectRoot: ROOT });
  await core.ensureBaseFiles();
  await core.saveNote({ id: 'trial-orphan', title: 'Trial — بوابة الدفع', type: 'note', content: 'trial payment gateway notes' });
  await core.saveNote({ id: 'trial-live', title: 'Trial live', type: 'note', content: 'trial second live note' });
  const built = await core.rebuildVectorIndex();
  assert.ok(built.index.entries.some(e => e.noteId === 'trial-orphan'), 'المقطع اليتيم دخل الفهرس');

  // حذف مباشر للملف: يُحاكي فهرساً أقدم من الخزنة (الحالة الحيّة بالضبط).
  fs.rmSync(path.join(root, 'vault', 'trial-orphan.md'), { force: true });
  assert.equal(fs.existsSync(path.join(root, 'vault', 'trial-orphan.md')), false);

  let out = null;
  let error = null;
  try { out = await core.searchWithEmbeddings('trial', { limit: 8 }); } catch (e) { error = e; }
  assert.equal(error, null, `البحث رمى: ${error && error.message}`);
  const ids = out.results.map(r => r.id);
  assert.ok(ids.includes('trial-live'), 'المقطع الحقيقي يُعاد');
  assert.ok(!ids.includes('trial-orphan'), 'المقطع اليتيم لا يُعرض كأنه ملاحظة');
});

test('C1 · مقطع يتيم لا يمنع باقي الاستعلامات من العمل', async () => {
  const root = tmpRoot();
  const core = createCore({ root, projectRoot: ROOT });
  await core.ensureBaseFiles();
  await core.saveNote({ id: 'alpha-note', title: 'Alpha rules', type: 'note', content: 'alpha checklist' });
  await core.rebuildVectorIndex();
  fs.writeFileSync(path.join(root, 'vault', 'beta-note.md'), '---\ntitle: Beta\n---\nbeta unpublished body\n', 'utf8');
  // نبني مرة أخرى ليدخل مستند beta ثم نحذفه ⇒ مقطع يتيم
  await core.saveNote({ id: 'beta-note', title: 'Beta', type: 'note', content: 'beta unpublished body' });
  await core.rebuildVectorIndex();
  fs.rmSync(path.join(root, 'vault', 'beta-note.md'), { force: true });

  const beta = await core.searchWithEmbeddings('beta', { limit: 5 }).catch(e => ({ threw: e.message }));
  assert.ok(!beta.threw, `استعلام beta رمى: ${beta.threw}`);
  const alpha = await core.searchWithEmbeddings('alpha', { limit: 5 });
  assert.equal(alpha.results[0]?.id, 'alpha-note', 'الاستعلام السليم ما زال يعمل');
});
