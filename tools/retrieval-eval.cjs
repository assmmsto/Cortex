'use strict';
/**
 * مقياس استرجاع قابل للتكرار — يقارن مزودي التضمين على نفس الخزنة ونفس الأسئلة.
 *
 * القاعدة: نسخة معزولة كاملة من الخزنة في مجلد مؤقت (لا لمس للبيانات الحية)،
 * ثم إعادة بناء الفهرس بالمزود المطلوب وقياس hit@1/hit@3 والزمن لكل سؤال.
 * الاستخدام: node tools/retrieval-eval.cjs --provider local-ngram [--provider mock]
 *            (يتكرر --provider لعدة مزودين في تشغيل واحد)
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createCore } = require(path.join(__dirname, '..', 'cortex-core.js'));

const ROOT = path.join(__dirname, '..');
const LIVE = process.env.CORTEX_ROOT || ROOT;

// أسئلة مرجعية بأهداف حقيقية من الخزنة — الهدف دالة (عنوان يطابق) لا معرّف جامد
const QUERIES = [
  { q: 'خارطة الحالة الفعلية', expect: t => t.includes('خارطة الحالة') },
  { q: 'الواجهة الكربونية', expect: t => t.includes('خارطة الحالة') },
  { q: 'الحالة الفعلية v5', expect: t => t.includes('خارطة الحالة') },
  { q: 'موجز الصباح', expect: t => t.includes('موجز الصباح') },
  { q: 'ملخص يومي تلقائي', expect: t => t.includes('موجز الصباح') || t.includes('خارطة') },
  { q: 'الوكيل المحلي', expect: t => t.includes('خارطة الحالة') },
  { q: 'الصباح', expect: t => t.includes('موجز الصباح') },
  // فجوة معلنة: استعلام إنجليزي على خزنة عربية — لا يتوقع المزود المعجمي إصابته
  { q: 'morning brief', expect: t => t.includes('موجز الصباح'), knownGap: true }
];

function setupIsolated(provider) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eval-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.cpSync(path.join(LIVE, 'vault'), path.join(tmp, 'vault'), { recursive: true });
  const settings = JSON.parse(fs.readFileSync(path.join(LIVE, 'data', 'settings.json'), 'utf8'));
  const model = provider === 'mock' ? 'cortex-embed-mock' : provider === 'local-ngram' ? 'ngram-tfidf-v2' : settings.memory?.retrieval?.model || '';
  settings.memory = settings.memory || {};
  settings.memory.retrieval = { ...(settings.memory.retrieval || {}), provider, model };
  fs.writeFileSync(path.join(tmp, 'data', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return tmp;
}

async function runProvider(provider) {
  const tmp = setupIsolated(provider);
  const core = createCore({ root: tmp, projectRoot: LIVE });
  const t0 = Date.now();
  const { index } = await core.rebuildVectorIndex({ force: true });
  const buildMs = Date.now() - t0;
  const rows = [];
  let hit1 = 0, hit3 = 0, graded = 0, totalMs = 0;
  for (const item of QUERIES) {
    const t = Date.now();
    const res = await core.searchWithEmbeddings(item.q, { limit: 5 });
    const ms = Date.now() - t;
    totalMs += ms;
    const titles = (res.results || []).map(r => String(r.title || ''));
    const h1 = titles.length > 0 && item.expect(titles[0]);
    const h3 = titles.slice(0, 3).some(item.expect);
    if (!item.knownGap) { graded++; if (h1) hit1++; if (h3) hit3++; }
    rows.push({ q: item.q, top1: titles[0] || null, top3: titles.slice(0, 3), hit1: h1, hit3: h3, gap: !!item.knownGap, ms });
  }
  // إغلاق مقبض SQLite قبل حذف المجلد المؤقت — بدونه يبقى cortex.db محتجزاً على ويندوز (EPERM مُقاس)
  try { if (core.store && typeof core.store.close === 'function') core.store.close(); } catch { /* طوبولوجيا بلا مخزن مفتوح */ }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  return {
    provider, model: index.model, entryCount: index.entryCount, noteCount: index.noteCount,
    idfTerms: Array.isArray(index.embedding?.stats?.df) ? index.embedding.stats.df.length : null,
    buildMs, graded, hit1, hit3, hit1Pct: Math.round(100 * hit1 / graded), hit3Pct: Math.round(100 * hit3 / graded),
    avgMs: Math.round(totalMs / QUERIES.length), rows
  };
}

(async () => {
  const providers = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--provider' && process.argv[i + 1]) providers.push(process.argv[++i]);
  if (!providers.length) providers.push('local-ngram');
  const out = [];
  for (const p of providers) {
    console.log(`\n⏳ قياس المزود: ${p} …`);
    const r = await runProvider(p);
    out.push(r);
    console.log(`  hit@1 = ${r.hit1Pct}% · hit@3 = ${r.hit3Pct}% (${r.graded} سؤال) · بناء ${r.buildMs}ms · استعلام ${r.avgMs}ms · مفردات idf=${r.idfTerms ?? '—'}`);
    for (const row of r.rows) console.log(`   ${row.hit1 ? '✓' : row.gap ? '◌' : '✗'} "${row.q}" → ${row.top1 || 'لا نتيجة'}`);
  }
  const dir = path.join(ROOT, 'data', 'eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `retrieval-eval-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results: out }, null, 2), 'utf8');
  console.log(`\n📄 حُفظت النتائج: ${file}`);
})().catch(e => { console.error('فشل القياس:', e.message); process.exit(1); });
