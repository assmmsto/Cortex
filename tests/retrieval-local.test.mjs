/**
 * المزود المحلي الحقيقي (n-gram TF-IDF) — عقد الوحدة:
 *  1) الفهرس يخزّن إحصاءات idf وإعلان النوع الصادق (ngram-tfidf) لا «mock».
 *  2) التطبيع العربي يوحّد الهمزات/التشكيل، فاستعلام بلا همزة يطابق نصاً بهمزة.
 *  3) الحالة تُعلن المزود الحقيقي والعدد الفعلي لمفردات idf.
 *  4) إعادة البناء لنفس المحتوى بلا تغيير لا تعيد الحساب (rebuilt=false).
 * كل ذلك على جذر مؤقت معزول — لا لمس للبيانات الحية، والمخزن يُغلق قبل الحذف
 * (عطل ويندوز مُقاس: cortex.db يبقى محتجزاً فيفشل حذف المجلد بـEPERM).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCore } = require('../cortex-core.js');
const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function makeRoot() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cortex-local-embed-'));
  mkdirSync(path.join(tmp, 'data'), { recursive: true });
  mkdirSync(path.join(tmp, 'vault'), { recursive: true });
  writeFileSync(path.join(tmp, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', baseUrl: '', openaiBaseUrl: '', apiKey: '', temperature: 0.2 },
    memory: { retrieval: { provider: 'local-ngram', model: 'ngram-tfidf-v2', dimensions: 256, chunkSize: 900, chunkOverlap: 120, topK: 8, candidateMultiplier: 6, rerankStrategy: 'mmr', minScore: 0.02, minSemantic: 0.02, batchSize: 16 } },
    agent: {}
  }, null, 2));
  return tmp;
}

test('local-ngram: فهرس حقيقي بإحصاءات idf + تطبيع عربي + حالة صادقة', async t => {
  const tmp = makeRoot();
  const core = createCore({ root: tmp, projectRoot: projectDir });
  t.after(() => {
    try { core.store && core.store.close && core.store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });

  await core.saveNote({ id: 'note-retrieval', title: 'الاسترجاع الدلالي في المحرك', type: 'note', content: '# الاسترجاع\n\nإعادة بناء الفهرس وتقييم الجودة عبر إحصاءات التكرار.' });
  await core.saveNote({ id: 'note-perf', title: 'قياس الأداء', type: 'note', content: '# الأداء\n\nزمن الاستعلام ومقاييس الذاكرة.' });
  await core.saveNote({ id: 'note-roadmap', title: 'خارطة الطريق', type: 'note', content: '# الخطة\n\nمراحل البناء الثمانية.' });

  const { index, rebuilt } = await core.rebuildVectorIndex({ force: true });
  assert.equal(rebuilt, true);
  assert.equal(index.provider, 'local-ngram');
  assert.equal(index.model, 'ngram-tfidf-v2');
  assert.equal(index.embedding.kind, 'ngram-tfidf', 'نوع التضمين يُعلن نفسه صادقاً');
  assert.ok(index.embedding.stats && index.embedding.stats.df.length > 20, 'إحصاءات idf مخزّنة في الفهرس');
  assert.equal(index.entries.length >= 3, true);

  // التطبيع: «إسترجاع» بهمزة تحت = «استرجاع» بألف — يطابق نفس الوثيقة
  const q1 = await core.searchWithEmbeddings('استرجاع', { limit: 3 });
  assert.equal(q1.results[0]?.id, 'note-retrieval', 'استعلام بلا همزة يجد الوثيقة');
  const q2 = await core.searchWithEmbeddings('إسترجاع', { limit: 3 });
  assert.equal(q2.results[0]?.id, 'note-retrieval', 'همزة تحت الألف تُطبَّع لنفس النتيجة');

  const status = await core.getRetrievalStatus();
  assert.equal(status.provider, 'local-ngram');
  assert.equal(status.embeddingKind, 'ngram-tfidf');
  assert.ok(Number.isInteger(status.idfTerms) && status.idfTerms > 20, 'الحالة تعرض عدد مفردات idf');
  assert.equal(status.dirty, false);

  // فهرس مطابق لنفس المحتوى لا يعاد بناؤه
  const again = await core.rebuildVectorIndex({});
  assert.equal(again.rebuilt, false, 'لا بناء بلا تغيير');
});
