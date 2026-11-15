'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const i18n = require('./cortex-i18n');
const dns = require('dns').promises;

// كلمات تُفتتح بها الجمل الإنجليزية ولا تحمل دلالة كيان، تُستبعد من استخراج الكيانات
// عبارات قوالب الملاحظات الحية — ليست كيانات دلالية
const PHRASE_STOPWORDS = new Set(['recent documents', 'recent notes', 'next actions', 'open questions', 'living note', 'knowledge items', 'most important', 'no explicit']);
const ENTITY_STOPWORDS = new Set(['see', 'use', 'run', 'runs', 'suggest', 'extract', 'related', 'goals', 'goal', 'risks', 'risk', 'summary', 'usage', 'example', 'note', 'notes', 'new', 'open', 'add', 'also', 'the', 'this', 'that', 'these', 'those', 'and', 'but', 'for', 'with', 'from', 'into', 'onto', 'than', 'then', 'there', 'here', 'when', 'where', 'what', 'which', 'while', 'how', 'why', 'who', 'it', 'its', 'in', 'on', 'at', 'by', 'to', 'of', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'yes', 'all', 'any', 'some', 'more', 'most', 'other', 'such', 'only', 'just', 'very', 'too', 'so', 'if', 'or', 'no', 'project', 'documents', 'document', 'decisions', 'recent', 'next', 'actions', 'questions', 'knowledge', 'items', 'guardrails', 'flywheel']);

function createCore(config = {}) {
  const root = path.resolve(config.root || process.cwd());
  const projectRoot = path.resolve(config.projectRoot || root);
  const dataDir = path.join(root, 'data');
  /* مسار الخزنة (2026-11-15): يمكن أن تكون خزنة Obsidian قائمة كما هي — بلا نسخ
     ولا إعادة تسمية. الأولوية: CORTEX_VAULT_DIR ← data/vault.json ← root/vault */
  const vaultDir = (() => {
    const fromEnv = String(process.env.CORTEX_VAULT_DIR || '').trim();
    if (fromEnv) return path.resolve(fromEnv);
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8'));
      const d = String((cfg && cfg.dir) || '').trim();
      if (d) return path.resolve(d);
    } catch { /* لا إعداد: الافتراضي */ }
    return path.join(root, 'vault');
  })();
  const settingsFile = path.join(dataDir, 'settings.json');
  const historyDir = path.join(dataDir, 'history');
  const sessionsDir = path.join(dataDir, 'sessions');
  const backupsDir = path.join(dataDir, 'backups');
  const auditFile = path.join(dataDir, 'audit.log');
  const pausedFile = path.join(dataDir, 'agent.paused');
const WRITE_TOOLS = new Set(['create_note', 'append_tasks', 'append_section', 'link_note', 'living_note', 'extract_meeting_actions']);
/* علاقات بين العناصر (م7).
   العطل الأصلي: مجموعة محلية من 4 أنواع قديمة فقط — فكانت أنواع الدستور التسعة
   (depends_on, contradicts, risks, …) تُرفض بـ 400 رغم تعريفها في cortex-schema.
   الحل الجذري: المجموعة تُشتق من المخطط (مصدر حقيقة واحد) + الأنواع القديمة للتوافق. */
let RELATION_TYPES = new Set(['contains', 'references', 'parent_project', 'wikilink']);
try {
  const _schema = require('./cortex-schema');
  const _kinds = Object.keys(_schema.RELATION_KINDS || {});
  const _legacy = _schema.LEGACY_RELATION_KINDS || [];
  if (_kinds.length) RELATION_TYPES = new Set([..._kinds, ..._legacy]);
} catch (e) {
  // بلا المخطط: نُبقي الأنواع القديمة (لا نُعلن نجاحاً كاذباً — وتُسجَّل الحالة)
  try { console.warn('[cortex-core] تعذّر تحميل أنواع العلاقات من المخطط:', e.message); } catch {}
}

const relationsFile = path.join(dataDir, 'relations.json');
const vectorIndexFile = path.join(dataDir, 'vector-index.json');
/* سقف التحليل الاستكشافي (عطل مُقاس بالبروفايل 2026-10-29): استيراد ملف 50MB
   جعل saveNote يحجب حلقة الحدث 10.7s — 40% منها استخراج جمل/كلمات من نص كامل
   50MB (sentenceSplit + regex على كل الجمل ×5 دوال) وextractEntities (نمط الكلمات
   الكبيرة يلتقط نصوصاً ضخمة) وregexes التصنيف. هذه تحليلات استكشافية لا تحتاج
   النص كاملاً: أول 200 ألف حرف يكفي للتصنيف/النوع/الاستدلالات. النصوص العادية
   (أقل من السقف — كل الاستخدام الطبيعي) لا تتأثر إطلاقاً. */
const MAX_ANALYZE_CHARS = 200000;
  const vectorDirtyFile = path.join(dataDir, 'vector-index.dirty.json');
  const workspaceStateFile = path.join(dataDir, 'workspace-state.json');

const cache = { notesKey: '', notes: null, index: null, state: null, relations: null };
let selfWriteAt = 0;

  // Layer 2 — فهرس SQLite منظم (مرآة قابلة لإعادة البناء من vault؛ vault يظل مصدر الحقيقة)
  let store = null;
  try {
    const { createStore } = require('./cortex-store');
    store = createStore({ root });
    if (store && store.dbFile) {
      const { DatabaseSync } = require('node:sqlite');
      const migrationDb = new DatabaseSync(store.dbFile);
      try { require('./cortex-schema').migrate(migrationDb); } finally { migrationDb.close(); }
    }
  } catch (e) {
    /* P1 تدقيق 2026-11-11: كان الابتلاع صامتاً (`catch { store = null; }`) — أي فشل
       ترحيل يُطفئ طبقة SQLite كلها (audit_log، change_snapshots، MCP في القاعدة)
       بلا سطر واحد يشرحه، فتبدو الأعطال لاحقاً «غامضة». لا نُصلح ذرّية الترحيل هنا
       (جسمه يفتح معاملة بنفسه فلا يصحّ لفه)، لكن الفشل صار مرئياً: سجل + ملف الأخطاء
       الدائم، والحالة تُعلن لاحقاً عبر layerDb() = null. */
    store = null;
    try {
      const line = '[Cortex] فشل تهيئة طبقة SQLite — الترحيل لم يكتمل: ' + String((e && e.message) || e);
      console.error(line);
      require('fs').promises.appendFile(path.join(dataDir, 'server-errors.log'), new Date().toISOString() + ' ' + String((e && e.stack) || e) + '\n', 'utf8').catch(() => {});
    } catch { /* السجل نفسه غير متاح */ }
  }

  function nowIso() { return new Date().toISOString(); }
  function sha1(text) { return crypto.createHash('sha1').update(String(text)).digest('hex'); }
  function slugify(input) {
    return String(input || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || `note-${Date.now()}`;
  }
  function unique(arr) { return [...new Set((arr || []).filter(Boolean))]; }
  function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(t => t.length > 1);
  }
  function sentenceSplit(text) {
    return String(text || '').split(/(?<=[\.\!\?\n])\s+/).map(s => s.trim()).filter(Boolean);
  }
  function normalizeVector(vec) {
    const arr = Array.from(vec || []).map(Number);
    let norm = 0;
    for (const x of arr) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return arr.map(x => x / norm);
  }
  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
    return s;
  }
  function deterministicEmbedding(text, dims = 256) {
    const vec = new Float32Array(dims);
    const tokens = tokenize(text);
    const grams = [];
    for (const token of tokens) {
      grams.push(token);
      if (token.length > 4) for (let i = 0; i < token.length - 2; i++) grams.push(token.slice(i, i + 3));
    }
    for (const gram of grams) {
      let h = 2166136261;
      for (let i = 0; i < gram.length; i++) {
        h ^= gram.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[Math.abs(h) % dims] += 1;
    }
    return normalizeVector(Array.from(vec));
  }
  /* ── التمثيل الدلالي المحلي الحقيقي (n-gram TF-IDF) ──────────────────────
     الخلفية: المزود الافتراضي كان تجزئة n-gram بلا ترجيح (يُسمّى mock)، فلا
     تعرف الكلمة النادرة من الشائعة ولا توحّد صيغ العربية. النموذج الجديد:
     تطبيع عربي (تشكيل/تطويل/همزات/ى/ة) → uni+3gram → وزن (1+ln tf)·idf
     بتجزئة موقّعة بعنوانين — أي أن كل بُعد يحمل إشارة التصادم أيضاً (تقليل
     تحيّز التصادم). الـidf يُحسب مرة عند البناء ويُخزَّن في الفهرس نفسه،
     فاستعلام اليوم يستخدم نفس إحصاءات بناء الوثائق بلا أي نداء خارجي.
     إشارة صادقة: هذا استرجاع معجمي حقيقي (IR) وليس تضميناً عصبياً — يظهر
     بالاسم الحقيقي في الحالة ولا يُقدَّم كثقة أعلى من قدره. */
  function normalizeArabicForEmbedding(text) {
    return String(text || '')
      .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // تشكيل + تطويل
      .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // أإآٱ → ا
      .replace(/\u0649/g, '\u064A') // ى → ي
      .replace(/\u0629/g, '\u0647') // ة → ه (توحيد للإحصاء)
      .replace(/[\u0624]/g, '\u0648') // ؤ → و
      .replace(/[\u0626]/g, '\u064A') // ئ → ي
      .toLowerCase();
  }
  function embeddingGrams(text) {
    const tokens = normalizeArabicForEmbedding(text).split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);
    const grams = [];
    for (const token of tokens) {
      grams.push(token);
      if (token.length > 4) for (let i = 0; i < token.length - 2; i++) grams.push(token.slice(i, i + 3));
    }
    return grams;
  }
  function gramHashFNV(gram) {
    let h = 2166136261;
    for (let i = 0; i < gram.length; i++) { h ^= gram.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // إحصاءات idf تُبنى مرة واحدة عند إعادة بناء الفهرس وتُخزَّن معطياته (أزواج [gram, df])
  function buildEmbeddingStats(texts) {
    const df = new Map();
    for (const text of texts) {
      const seen = new Set(embeddingGrams(text));
      for (const g of seen) df.set(g, (df.get(g) || 0) + 1);
    }
    const pairs = [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120000);
    return { N: Math.max(1, texts.length), df: pairs };
  }
  /* كاش تهيئة إحصاءات idf — عطل أداء مُقاس 2026-11-11 (الأكبر في النظام):
     كانت الدالة تبني `new Map(stats.df)` عند **كل** نداء، وdf يصل إلى 120,000 زوج.
     بناء الفهرس يضمّن 822 مقطعاً ⇒ 98.6 مليون إدخال Map = 29.7 ثانية من أصل 40.
     الكاش WeakMap على كائن الإحصاءات نفسه: لا طفرة على الكائن (كي لا يتسرّب
     `_dfMap` إلى JSON الفهرس)، ويُبنى مرة واحدة لكل نسخة إحصاءات. */
  const embeddingStatsCache = new WeakMap();
  function hydrateEmbeddingStats(stats) {
    if (!stats || !Array.isArray(stats.df)) return null;
    const hit = embeddingStatsCache.get(stats);
    if (hit) return hit;
    const hydrated = { N: Number(stats.N) || 1, df: stats.df, _dfMap: new Map(stats.df) };
    embeddingStatsCache.set(stats, hydrated);
    return hydrated;
  }
  function makeLocalEmbedding(text, dims = 256, stats = null) {
    const hStats = hydrateEmbeddingStats(stats);
    const tf = new Map();
    for (const g of embeddingGrams(text)) tf.set(g, (tf.get(g) || 0) + 1);
    const N = hStats ? hStats.N : 1;
    const vec = new Float32Array(dims);
    for (const [g, f] of tf) {
      let idf = 1;
      if (hStats) {
        const df = hStats._dfMap.get(g) || 0;
        idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      }
      const w = (1 + Math.log(f)) * idf;
      if (!Number.isFinite(w) || w === 0) continue;
      const h = gramHashFNV(g);
      const idx = h % dims;
      const sign = ((h >>> 16) & 1) === 0 ? 1 : -1;
      vec[idx] += sign * w;
    }
    return normalizeVector(Array.from(vec));
  }
  function safeRegexToken(token) { return String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function snippet(text, query, maxLen = 220) {
    const token = tokenize(query)[0] || '';
    const lower = String(text || '').toLowerCase();
    const idx = token ? lower.indexOf(token) : 0;
    const start = Math.max(0, idx - 60);
    const out = String(text || '').slice(start, start + maxLen).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + out + (lower.length > start + maxLen ? '…' : '');
  }
  function parseFrontmatter(content) {
    const fm = {};
    const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) return { fm, body: String(content || '') };
    for (const line of match[1].split('\n')) {
      const [k, ...v] = line.split(':');
      if (!k) continue;
      const key = k.trim();
      const val = v.join(':').trim();
      if (val.startsWith('[')) {
        try { fm[key] = JSON.parse(val); } catch { fm[key] = val; }
      } else if (val === 'true') fm[key] = true;
      else if (val === 'false') fm[key] = false;
      else if (!Number.isNaN(Number(val)) && val !== '') fm[key] = Number(val);
      else fm[key] = val;
    }
    return { fm, body: content.slice(match[0].length) };
  }
  function buildFrontmatter(fm) {
    const lines = Object.entries(fm || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => Array.isArray(v) ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`);
    return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
  }
  function extractTitle(content, fallback = 'Untitled') {
    return (String(content || '').match(/^#\s+(.+)$/m)?.[1] || fallback).trim();
  }
  function extractWikiLinks(content) {
    return [...String(content || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
  }
  /* مرفقات Obsidian: ![[x.png]] و ![](x.png) — تُستخرج للإحصاء والعرض فقط */
  function extractAttachments(content) {
    const out = new Set();
    for (const m of String(content || '').matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]/g)) out.add(m[1].trim());
    for (const m of String(content || '').matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) out.add(m[1].trim());
    return [...out];
  }
  function extractProjectHint(text) {
    // فاصل إلزامي + منع تجاوز نهاية السطر (\s كان يقفز السطر فيلتقط كلمات الترويسة التالية مثل tags)
    const m = String(text || '').match(/(?:project|مشروع)[ \t]*[:\-][ \t]*([\p{L}\p{N} _-]{2,60})/iu);
    return m ? m[1].trim() : null;
  }
  function stripWikiLinks(text) {
    return String(text || '')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/`[^`]*`/g, ' ');
  }
  function getDocumentType(text = '', title = '') {
    const hay = `${title} ${text}`.toLowerCase();
    if (/prd|product requirements|متطلبات المنتج/i.test(hay)) return 'prd';
    if (/\brfc\b|request for comment/i.test(hay)) return 'rfc';
    if (/\badr\b|architecture decision record|سجل القرار/i.test(hay)) return 'adr';
    if (/spec|مواصفة|وثيقة/i.test(hay)) return 'spec';
    if (/design|architecture|معمار|تصميم/i.test(hay)) return 'design';
    if (/decision|قرار/i.test(hay)) return 'decision';
    if (/meeting|اجتماع|attendees|transcript/i.test(hay)) return 'meeting';
    if (/runbook|procedure|playbook|إجراء|خطوات/i.test(hay)) return 'runbook';
    if (/plan|roadmap|خارطة|خطة/i.test(hay)) return 'plan';
    return 'note';
  }
  function normalizeType(value = '') {
    const v = String(value || '').toLowerCase();
    if (['note','decision','task','project','risk','meeting','question','procedure','doc','reference','state','living_note'].includes(v)) return v;
    return 'note';
  }
  function isDocumentType(type) {
    return ['doc', 'reference', 'procedure', 'decision', 'meeting', 'living_note', 'project'].includes(type);
  }
  function classifyText(content = '') {
    const text = String(content || '').slice(0, MAX_ANALYZE_CHARS);
    const title = extractTitle(text, 'Untitled');
    const bodyText = stripWikiLinks(text);
    const haystack = `${stripWikiLinks(title)} ${bodyText}`;
    const tags = [];
    let primaryType = 'note';
    let confidence = 0.55;
    if (/^#\s+.*decision/mi.test(text) || /قرار|decision/i.test(title)) { primaryType = 'decision'; confidence = 0.9; tags.push('decision'); }
    else if (/\- \[ \]|\btodo\b|\btask\b|المهام|مهام/i.test(text)) { primaryType = 'task'; confidence = 0.82; tags.push('task'); }
    else if (/\brisk\b|risk|مخاطر|خطر|blocker/i.test(text)) { primaryType = 'risk'; confidence = 0.83; tags.push('risk'); }
    else if (/\bmeeting\b|اجتماع|attendees|transcript/i.test(text)) { primaryType = 'meeting'; confidence = 0.84; tags.push('meeting'); }
    else if (/procedure|runbook|playbook|خطوات|إجراء/i.test(haystack)) { primaryType = 'procedure'; confidence = 0.74; tags.push('procedure'); }
    else if (/spec|design|architecture|doc|document|وثيقة|مستند|تصميم|معمار/i.test(haystack)) { primaryType = 'doc'; confidence = 0.76; tags.push('doc'); }
    else if (/roadmap|project|strategy|خارطة طريق|مشروع/i.test(haystack)) { primaryType = 'project'; confidence = 0.78; tags.push('project'); }
    const importance = Math.min(5, Math.max(1, (text.includes('##') ? 1 : 0) + ((text.match(/\[\[/g) || []).length > 2 ? 1 : 0) + (/decision|قرار|risk|مخاطر/i.test(text) ? 2 : 0) + (/project|roadmap|strategy|مشروع|spec|وثيقة|design|architecture/i.test(title) ? 1 : 0)));
    const project = extractProjectHint(bodyText);
    return { primaryType, confidence, tags: unique(tags), suggestedImportance: importance, project, documentType: getDocumentType(bodyText, title) };
  }
  function extractEntities(text = '') {
    const source = String(text || '').slice(0, MAX_ANALYZE_CHARS);
    const entities = [];
    const add = (name, type = 'entity', sourceType = 'text') => {
      const clean = String(name || '').trim().replace(/\s+/g, ' ');
      if (!clean || clean.length < 2) return;
      if (/^\d+$/.test(clean)) return;
      if (!clean.includes(' ') && ENTITY_STOPWORDS.has(clean.toLowerCase())) return;
      if (PHRASE_STOPWORDS.has(clean.toLowerCase())) return;
      entities.push({ id: slugify(clean), name: clean, type, sourceType });
    };
    for (const m of source.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add(m[1], 'reference', 'wikilink');
    for (const m of source.matchAll(/(?:component|service|module|feature|project|خدمة|مكوّن|ميزة|وحدة)\s*[:\-]\s*([^\n]+)/gi)) add(m[1], 'named', 'label');
    for (const m of source.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}(?:[ \t]+[A-Z][A-Za-z0-9_-]{2,})*/g)) add(m[0], 'named', 'caps');
    return unique(entities.map(x => JSON.stringify(x))).map(x => JSON.parse(x));
  }
  function classifyNote(note) {
    const derived = classifyText(note.content);
    const fmType = normalizeType(note.fm?.type || derived.primaryType);
    return {
      primaryType: fmType,
      confidence: note.fm?.type ? 0.95 : derived.confidence,
      suggestedTags: unique([...(note.fm?.tags || []), ...derived.tags]),
      project: note.fm?.project || derived.project || (fmType === 'project' ? note.title : null),
      documentType: note.fm?.documentType || derived.documentType,
      isDocument: isDocumentType(fmType) || derived.documentType !== 'note'
    };
  }
  // بيانات وصفية للمهام: @owner و due:YYYY-MM-DD (ويُقبل موعد)
  function parseTaskMeta(text) {
    let owner = null;
    let due = null;
    const atMatch = String(text).match(/@([\p{L}\p{N}_.-]{2,32})/u);
    if (atMatch) owner = atMatch[1];
    const ownerLabel = String(text).match(/(?:المسؤول|owner)\s*[:\-]\s*([^\n@]+)/i);
    if (!owner && ownerLabel) owner = ownerLabel[1].trim().slice(0, 40) || null;
    const dueMatch = String(text).match(/(?:\bdue\b|موعد)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}(?:[T ][\d:.Z-]+)?|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)/i);
    if (dueMatch) due = dueMatch[1];
    const clean = String(text)
      .replace(/\s*@[\p{L}\p{N}_.-]{2,32}/gu, '')
      .replace(/\s*[(（]?\s*(?:\bdue\b|موعد)\s*[:\-]?\s*[^\s()（）]+[)）]?/giu, '')
      .replace(/[()（）]+\s*$/, '')
      .replace(/[(（]\s*[)）]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { owner, due, clean: clean || String(text).trim() };
  }
  function extractTasks(content) {
    const lines = String(content || '').split('\n');
    const tasks = [];
    for (const line of lines) {
      const a = line.match(/^- \[ \] (.+)$/);
      if (a) { const meta = parseTaskMeta(a[1]); tasks.push({ text: meta.clean, status: 'open', owner: meta.owner, due: meta.due }); }
      const b = line.match(/^- \[x\] (.+)$/i);
      if (b) { const meta = parseTaskMeta(b[1]); tasks.push({ text: meta.clean, status: 'done', owner: meta.owner, due: meta.due }); }
      const c = line.match(/^(?:task|todo|مهمة)\s*[:\-]\s*(.+)$/i);
      if (c) { const meta = parseTaskMeta(c[1]); tasks.push({ text: meta.clean, status: 'open', owner: meta.owner, due: meta.due }); }
    }
    return unique(tasks.map(x => JSON.stringify(x))).map(x => JSON.parse(x));
  }
  function extractBulletSection(content, keywords, type) {
    const out = [];
    for (const s of sentenceSplit(content)) if (keywords.some(k => s.toLowerCase().includes(k))) out.push({ type, text: s.trim() });
    return out;
  }
  function extractStructuredInfo(content) {
    const text = String(content || '').slice(0, MAX_ANALYZE_CHARS);
    return {
      decisions: extractBulletSection(text, ['decision','قرر','سنعتمد','adopt','choose','اخترنا'], 'decision'),
      risks: extractBulletSection(text, ['risk','مخاطر','خطر','blocker','blocking'], 'risk'),
      questions: extractBulletSection(text, ['?','question','سؤال','unknown','open question'], 'question'),
      assumptions: extractBulletSection(text, ['assume','افتراض','نفترض'], 'assumption'),
      tasks: extractTasks(text)
    };
  }
  function overlapScore(a, b) {
    const aa = new Set(tokenize(a).filter(x => x.length > 2));
    const bb = new Set(tokenize(b).filter(x => x.length > 2));
    let s = 0;
    for (const t of aa) if (bb.has(t)) s += 1;
    return s;
  }
  function polarityScore(text) {
    const t = String(text || '').toLowerCase();
    let score = 0;
    const positive = ['use','adopt','enable','allow','preferred','recommend','سنعتمد','اعتمد','نستخدم','مفضل'];
    const negative = ['avoid','ban','disable','do not','dont','deprecated','replace','لن نستخدم','لا نستخدم','تجنب','ممنوع'];
    for (const w of positive) if (t.includes(w)) score += 1;
    for (const w of negative) if (t.includes(w)) score -= 1;
    return score;
  }
  function lexicalScoreForText(text, title, tags, query) {
    /* التطبيع العربي يُطبَّق هنا أيضاً (عطل مُقاس 2026-10-27، كشفه اختبار الهمزة):
       كان التوجيه الدلالي يطبّع «إسترجاع»→«استرجاع» بينما المكافأة المعجمية تقارن
       الخام — فكلمة واحدة بكتابتين تعطي ترتيبين مختلفين. الآن الجهة نفسها موحّدة. */
    const tokens = tokenize(normalizeArabicForEmbedding(query));
    const hay = normalizeArabicForEmbedding(`${title} ${text}`);
    const nTitle = normalizeArabicForEmbedding(title);
    const nTags = (tags || []).map(t => normalizeArabicForEmbedding(t));
    let lexical = 0;
    for (const t of tokens) {
      const rx = new RegExp(safeRegexToken(t), 'g');
      lexical += (hay.match(rx) || []).length;
      if (nTitle.includes(t)) lexical += 6;
      if (nTags.some(tag => tag.includes(t))) lexical += 4;
    }
    return lexical;
  }
  // حاكم الروابط الصادرة: http/https فقط، ويُمنع المضيف المحلي والحلقي والخاص والمحجوز (سياسة أمان تعمل قبل أي طلب)
  function validatePublicHttpUrl(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl || '')); } catch { throw new Error('رابط صادر غير صالح'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`نظام رابط غير مسموح للطلبات الصادرة: ${u.protocol}`);
    const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const privateMsg = `policy_blocked_host: طلب للرابط رُفض — مضيف محلي/خاص/محجوز غير مسموح (${host})`;
    if (!host) throw new Error(privateMsg);
    const isPrivate = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' || host === '::1' || host === '[::1]' ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && (() => { const p = host.split('.').map(Number); return p[0] === 127 || p[0] === 10 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); })() ||
      (host.includes(':') && (/^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)));
    // باب مختبيري صريح: يُفعَّل يدويًا في قيود الاختبار فقط (ex. خادم تمثيلات وهمي) — يظل مغلقًا في التشغيل الحقيقي
    if (isPrivate && process.env.CORTEX_ALLOW_LOCAL_URL !== '1') throw new Error(privateMsg);
    return u;
  }
  // فحص عنوان IP مطلق (بعد حل الاسم) — يتضمن IPv6 ومطاوته المركبة ::ffff:
  function isBlockedIp(ip) {
    let s = String(ip || '').toLowerCase();
    if (s.startsWith('::ffff:')) s = s.slice(7); // IPv4-mapped IPv6
    if (s === '::' || s === '::1' || s === '0.0.0.0') return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
      const p = s.split('.').map(Number);
      return p[0] === 127 || p[0] === 10 || p[0] === 0 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
    }
    if (s.includes(':')) {
      if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^[0-9a-f]{0,3}::1$/.test(s)) return true;
      if (/^::ffff:/.test(s)) return isBlockedIp(s.slice(7));
      return false;
    }
    return false;
  }
  /* إعادة محاولة DNS (إصلاح 2026-11-13): فشل حلّ اسم عابر (EAI_AGAIN/ESERVFAIL)
     كان يُسقط مهمة وكيل كاملة برسالة policy_dns_fail — قياس حيّ: مهمتان من ستة
     ماتتا لهذا السبب وحده. ثلاث محاولات بتباعد قصير. لا يُرخي هذا الحاكم شيئاً:
     كل محاولة تُحلّ وتُفحص عناوينها، والقرار الأمني لم يتغيّر. */
  const DNS_RETRY_DELAYS_MS = [0, 150, 400];
  async function lookupWithRetry(hostname) {
    let lastErr = null;
    for (const delay of DNS_RETRY_DELAYS_MS) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
        if (addrs && addrs.length) return addrs;
        lastErr = new Error('no addresses');
      } catch (e) {
        lastErr = e;
        const code = e && e.code;
        if (code && !['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ENOTFOUND', 'ECONNRESET'].includes(code)) break;
      }
    }
    throw lastErr || new Error('lookup failed');
  }
  // الحاكم العميق: صلاحية الرابط + حلُّ DNS ثم رفض أي عائلة عناوين خاصة/حلقية — يمنع DNS rebinding والتحويل للداخل
  async function guardOutboundUrl(rawUrl) {
    const u = validatePublicHttpUrl(rawUrl);
    if (process.env.CORTEX_ALLOW_LOCAL_URL === '1') return u; // باب الاختبار فقط
    let addrs = [];
    try { addrs = await lookupWithRetry(u.hostname); } catch { throw new Error(`policy_dns_fail: تعذر حل اسم المضيف (${u.hostname})`); }
    if (!addrs.length) throw new Error('policy_dns_fail: لا عناوين للمضيف');
    for (const a of addrs) {
      if (isBlockedIp(a.address)) throw new Error(`policy_blocked_host: حلُّ الاسم أدى إلى عنوان محجوب (${a.address})`);
    }
    return u;
  }
  async function safeJsonFetch(url, options = {}, timeoutMs = 60000) {
    await guardOutboundUrl(url);
    let res = null;
    // إنتاجية: 429 سقف معدل عابر من المزود — إعادة محاولة واحدة بعد 12 ثانية
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status === 429 && attempt === 0) { await new Promise(r => setTimeout(r, 12000)); continue; }
      break;
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json') && !ct.includes('text/json')) {
      const preview = (await res.text()).slice(0, 180);
      throw new Error(`Expected JSON from ${url} but got ${ct || 'unknown'}: ${preview}`);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error?.message || data.message || JSON.stringify(data)}`);
    return data;
  }
  // كل نداء خارجي مقيّد بمهلة حتى لا يتعلّق الطلب إلى الأبد عند تعطّل المزوّد
  async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    try {
      // redirect: 'error' — المزود لا يحوّل عادةً؛ التحويل مسار التفافي محتمل نحو عناوين داخلية فنمنعه من المصدر
      return await fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`انتهت مهلة الاتصال بالمزوّد بعد ${Math.round(timeoutMs / 1000)} ثانية — تحقق من العنوان أو الشبكة`);
      throw new Error(`تعذّر الوصول إلى المزوّد (${url}): ${e.message}`);
    }
  }
  function defaultSettings() {
    return {
      ai: { provider: 'mock', model: '', baseUrl: 'http://localhost:11434', openaiBaseUrl: 'https://api.openai.com', apiKey: '', temperature: 0.2 },
      memory: {
        retrieval: {
          provider: 'local-ngram',
          model: 'ngram-tfidf-v2',
          baseUrl: 'https://api.openai.com',
          ollamaBaseUrl: 'http://localhost:11434',
          apiKey: '',
          // 512 بُعداً بدل 256: ضجيج التصادم في تجزئة الميزات كان يرفع وثائق غير
          // ذات صلة لاستعلامات قصيرة (عطل مُقاس 2026-10-27: عنوان غير متصل 0.56
          // مقابل الوثيقة الصحيحة 0.51 على استعلام كلمة واحدة)
          dimensions: 512,
          chunkSize: 900,
          chunkOverlap: 120,
          topK: 8,
          candidateMultiplier: 6,
          rerankStrategy: 'mmr',
          minScore: 0.08,
          minSemantic: 0.12,
          batchSize: 16
        }
      },
      agent: { defaultMode: 'project' }
    };
  }
  function defaultWorkspaceState() {
    return {
      version: 1,
      updatedAt: nowIso(),
      activeNoteId: '',
      activeProject: '',
      recentNoteIds: [],
      recentDocumentIds: [],
      recentProjectNames: [],
      lastResolved: null
    };
  }
  function mergeDeep(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(override || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = mergeDeep(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  function getRetrievalConfig(settings) {
    return mergeDeep(defaultSettings().memory.retrieval, settings?.memory?.retrieval || {});
  }
  async function ensureBaseFiles() {
    /* تحصين 2026-11-12 (عطل مقيس: EPERM على data/workspace-state.json كان يُسقط
       خادم MCP كاملاً بـ exit=1 عند أي جذر غير قابل للكتابة — قرص للقراءة فقط،
       صلاحية مفقودة، أو جذر مؤقت محمي). الإقلاع يجب أن ينجح **قراءةً** ولو فشلت
       الكتابة، لا أن يموت. كل كتابة هنا تحسينية: غيابها يعني «لا ملفات أولية»،
       لا «لا خادم». */
    const soft = async (fn, label) => {
      try { await fn(); } catch (err) {
        try { process.stderr.write(`[cortex] تهيئة غير قابلة للكتابة (${label}): ${err && err.code ? err.code : err.message}\n`); } catch { /* stderr مغلق */ }
      }
    };
    await soft(() => fsp.mkdir(vaultDir, { recursive: true }), 'vault');
    await soft(() => fsp.mkdir(dataDir, { recursive: true }), 'data');
    await soft(() => fsp.mkdir(historyDir, { recursive: true }), 'history');
    await soft(() => fsp.mkdir(sessionsDir, { recursive: true }), 'sessions');
    await soft(() => fsp.mkdir(backupsDir, { recursive: true }), 'backups');
    if (!fs.existsSync(settingsFile)) await soft(() => fsp.writeFile(settingsFile, JSON.stringify(defaultSettings(), null, 2), 'utf8'), 'settings');
    if (!fs.existsSync(workspaceStateFile)) await soft(() => fsp.writeFile(workspaceStateFile, JSON.stringify(defaultWorkspaceState(), null, 2), 'utf8'), 'workspace-state');
    let vaultEmpty = false;
    await soft(async () => { vaultEmpty = !(await fsp.readdir(vaultDir)).length; }, 'readdir');
    if (vaultEmpty) {
      const stamp = nowIso();
      await soft(() => fsp.writeFile(path.join(vaultDir, 'welcome.md'), `---\ntags: ["intro","cortex"]\nimportance: 2\ntype: state\ncreated: "${stamp}"\nupdated: "${stamp}"\n---\n# Welcome\n\nCortex is ready.\n\nSee [[ai-roadmap]] and [[mcp-memory]].\n`, 'utf8'), 'welcome');
      await soft(() => fsp.writeFile(path.join(vaultDir, 'ai-roadmap.md'), `---\ntags: ["ai","plan"]\nimportance: 3\ntype: project\nproject: AI Roadmap\ncreated: "${stamp}"\nupdated: "${stamp}"\n---\n# AI Roadmap\n\n## Goals\n- [ ] Local and cloud models\n- [ ] Semantic memory\n- [ ] Agent workflows\n\n## Risks\n- Model drift\n- Missing long-term memory structure\n`, 'utf8'), 'roadmap');
      await soft(() => fsp.writeFile(path.join(vaultDir, 'mcp-memory.md'), `---\ntags: ["mcp","memory"]\nimportance: 4\ntype: procedure\ncreated: "${stamp}"\nupdated: "${stamp}"\n---\n# MCP Memory\n\nCortex exposes memory tools over MCP for external runtimes.\n`, 'utf8'), 'mcp-memory');
    }
  }
  // §38: «ممنوع محو سجل التدقيق — يُحفظ محميًا». حماية الملف بسلسلة تجزئة:
  // كل سطر يحمل تجزئة السطر السابق، فأي محو أو تعديل أو إعادة ترتيب يصبح مكشوفاً
  // عبر verifyAuditChain. السطور القديمة (قبل التفعيل) تُعدّ بادئة غير موقّعة لا كسراً.
  let auditChainCache;
  let auditChainCacheAt = -1; // حجم الملف عند اشتقاق الترويسة المخزنة — كتّاب آخرون (عملية MCP) يلحقون نفس الملف
  function auditCanonical(obj) {
    // نستثني prev وhash من التوحيد: عند الكتابة لا وجود لـ prev، فعلى التحقق
    // أن يحسب على نفس المجموعة وإلا ظهر إنذار كاذب (عطل مؤكد رُصد وأُصلح).
    // و`hmac` يُستثنى أيضاً: يُحسب **بعد** التجزئة ويُضاف للإطار، فإدخاله في
    // التوحيد كان سيجعل تحقق كل سطر جديد يفشل (سبق أن أوشكنا على هذا العطل).
    const keys = Object.keys(obj).filter((k) => k !== 'hash' && k !== 'prev' && k !== 'hmac').sort();
    return JSON.stringify(keys.map((k) => [k, obj[k]]));
  }
  /* مفتاح توقيع سلسلة التدقيق (تدقيق 2026-11-11): sha1 بلا مفتاح قابل لإعادة
     الحساب، فمن يكتب على القرص يزوّر سجلاً متّسقاً. HMAC-SHA256 بمفتاح **خارج
     ملف السجل** يغلق ذلك: بلا المفتاح لا يمكن إنتاج سطر يُقبل. يُطبَّق على الأسطر
     الجديدة فقط؛ القديمة تُتحقَّق بالسلسلة وحدها (حقبة موثّقة في التقرير). */
  let auditKeyCache = null;
  function ensureAuditKey() {
    if (auditKeyCache) return auditKeyCache;
    try {
      const k = fs.readFileSync(auditKeyFile, 'utf8').trim();
      if (k && k.length >= 64) { auditKeyCache = Buffer.from(k, 'hex'); return auditKeyCache; }
    } catch { /* غير موجود — نولّده */ }
    const k = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(auditKeyFile), { recursive: true });
      fs.writeFileSync(auditKeyFile, k.toString('hex'), { mode: 0o600 });
      try { fs.chmodSync(auditKeyFile, 0o600); } catch { /* ويندوز */ }
    } catch { /* القرص غير قابل للكتابة — يبقى في الذاكرة لهذه العملية */ }
    auditKeyCache = k;
    return k;
  }
  function auditHmac(prev, canonical, hash) {
    return crypto.createHmac('sha256', ensureAuditKey()).update(`${prev}|${canonical}|${hash}`).digest('hex');
  }
  /** مقارنة توقيعين ثابتة الزمن. */
  function sameHex(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) return false;
    try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
  }
  async function auditHead() {
    let size = -1;
    try { size = (await fsp.stat(auditFile)).size; } catch { return ''; }
    // الاعتماد على الترويسة المخزنة صحيح فقط إن لم يلحق أي كاتب آخر بعد اشتقاقها —
    // وإلا يُشتق prev من آخر سطر موقّع فعلي في الملف (كان هذا العطل يفرّع السلسلة).
    if (auditChainCache !== undefined && auditChainCacheAt === size) return auditChainCache;
    try {
      const raw = await fsp.readFile(auditFile, 'utf8');
      const ls = raw.split('\n');
      auditChainCache = '';
      for (let i = ls.length - 1; i >= 0; i--) {
        if (!ls[i].trim()) continue;
        try { const h = JSON.parse(ls[i]).hash; if (h) { auditChainCache = String(h); break; } } catch { continue; }
      }
    } catch { auditChainCache = ''; }
    auditChainCacheAt = size;
    return auditChainCache;
  }
  let auditWriteTail = Promise.resolve();
  /* قفل بين-العمليات (درس السجل الحي: 133 تفرّعًا من كتّاب متوازنين — الخادم
     وعملية MCP يلحقان نفس الملف): التوقيع يحتاج (اقرأ الترويسة ← اكتب) ذرّيًا عبر
     العمليات. open 'wx' ذرّي على كل الأنظمة؛ قفل يتيم (مالك مات) يُستلم بعد 5 ثوانٍ. */
  const auditLockFile = path.join(dataDir, 'audit.lock');
  /* مفتاح HMAC لسلسلة التدقيق — خارج ملف السجل عمداً (انظر ensureAuditKey). */
  const auditKeyFile = path.join(dataDir, 'audit.key');
  /* مرجع طرف السلسلة (يكشف حذف الذيل) — انظر appendAudit/verifyAuditChain. */
  const auditAnchorFile = path.join(dataDir, 'audit.head.json');
  async function acquireAuditLock() {
    for (let i = 0; i < 50; i++) {
      try {
        // الأداء (عطل مُقاس 2026-10-24): كان open+write+close = ٣ عمليات fs لكل إلحاق
        // وكل عملية ~26ms على ويندوز ⇒ appendAudit = 105ms. وجود الملف هو القفل نفسه؛
        // الكتابة داخله زينة تشخيصية لا يحتاجها الاستلام اليتيم (يعتمد mtime).
        const fd = await fsp.open(auditLockFile, 'wx');
        await fd.close();
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') return false;
        try {
          const st = await fsp.stat(auditLockFile);
          if (Date.now() - st.mtimeMs > 5000) { await fsp.unlink(auditLockFile).catch(() => {}); continue; }
        } catch { continue; }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return false;
  }
  async function releaseAuditLock() { await fsp.unlink(auditLockFile).catch(() => {}); }
  async function appendAuditUnserialized(event) {
    const locked = await acquireAuditLock();
    try {
      // داخل القفل: لا كاتب آخر يستطيع الإلحاق، فالكاش المبعوم بالحجم صحيح
      const prev = await auditHead();
      const entry = { time: nowIso(), ...event };
      const canonical = auditCanonical(entry);
      const hash = sha1(`${prev}|${canonical}`);
      /* توقيع HMAC يُضاف لكل سطر جديد — بلا المفتاح لا يمكن إنتاج سطر يُقبل. */
      const hmac = auditHmac(prev, canonical, hash);
      const payloadLine = JSON.stringify({ ...entry, prev, hash, hmac }) + '\n';
      await fsp.appendFile(auditFile, payloadLine, 'utf8');
      auditChainCache = hash;
      auditChainCacheAt += Buffer.byteLength(payloadLine, 'utf8');
      /* مرساة الطرف (P0 تدقيق 2026-11-11): السلسلة بلا مفتاح، فمن يستطيع الكتابة
         يستطيع إعادة تجزئة الذيل — لكن **حذف الذيل** كان يمرّ `ok:true` بلا أثر.
         نكتب آخر (hash, عدد الأسطر) في ملف مرجعي صغير ذرّياً؛ عند التحقق يُقارَن
         فيُكشف الحذف/التقصير. الحد المعلن: من يعدّل الملف **والمرساة** معاً يبقى
         غير مكشوف — وهذا يحتاج مفتاحاً خارج الملف (لم يُنفَّذ، وموثَّق في SECURITY). */
      try {
        /* المرساة: آخر تجزئة + حجم الملف بعد الإلحاق (الحجم متتبَّع أصلاً في الكاش
           أعلاه، فلا قياس إضافي). عند التحقق: ملف أقصر من المرساة = حذف ذيل. */
        const anchor = JSON.stringify({ head: hash, bytes: auditChainCacheAt, at: nowIso() });
        await fsp.writeFile(auditAnchorFile + '.tmp', anchor, 'utf8');
        await fsp.rename(auditAnchorFile + '.tmp', auditAnchorFile);
      } catch { /* المرساة تحسينية — لا تُسقط الإلحاق */ }
    } finally {
      if (locked) await releaseAuditLock();
    }
  }
  function appendAudit(event) {
    // تسلسل داخل العملية (سباق نفس-Tick كان يكتب سطرين بنفس prev — السطر 922 شاهده)
    // + القفل بين-العمليات أعلاه: الطرفان معاً يغلقان مسارَي التفرّع.
    const run = auditWriteTail.then(() => appendAuditUnserialized(event));
    auditWriteTail = run.then(() => undefined, () => undefined);
    return run;
  }
  /** يكشف أي محو أو تعديل أو تفرّع في سجل التدقيق. البادئة غير الموقّعة (قبل تفعيل
   *  السلسلة) تُبلَّغ عدّادًا preHashLines لا كسرًا — لا تحمل تجزئة يُتحقق منها.
   *  الانقطاع داخل الحقبة الموقّعة يُبلَّغ بدقة (تفرّعات، إلحاق مزدوج، أسطر تالفة)
   *  دون أي تلفيق استمرارية: التاريخ لا يُعاد كتابته ليَمُرّ الفحص. */
  async function verifyAuditChain() {
    let raw = '';
    try { raw = await fsp.readFile(auditFile, 'utf8'); }
    catch { return { ok: true, lines: 0, unhashed: 0, preHashLines: 0, hashedFrom: null, head: '', brokenAt: null, forks: [], duplicates: [], corrupt: [], sealedAt: null, historicalIncidents: null, note: 'لا يوجد سجل بعد' }; }
    const lines = raw.split('\n').filter((l) => l.trim());
    let prev = ''; let preHashLines = 0; let hashedFrom = null;
    let sealLine = null; let sealIncidents = null;
    let hmacFrom = null; let hmacRows = 0;
    const forks = []; const corrupt = []; const duplicates = [];
    for (let i = 0; i < lines.length; i++) {
      let e;
      try { e = JSON.parse(lines[i]); }
      catch { if (hashedFrom === null) { preHashLines++; continue; } corrupt.push(i + 1); continue; }
      if (!e || typeof e !== 'object' || !e.hash) {
        if (hashedFrom === null) { preHashLines++; continue; }
        corrupt.push(i + 1); continue; // سطر بلا توقيع بعد بدء السلسلة = إقحام
      }
      if (hashedFrom === null) hashedFrom = i + 1;
      if (i > 0 && lines[i] === lines[i - 1]) { duplicates.push(i + 1); continue; } // إلحاق مزدوج حرفي لنفس الحدث
      if (e.prev !== prev) { forks.push({ line: i + 1, type: String(e.type || ''), prev: String(e.prev || '') }); prev = String(e.prev || ''); }
      const canonical = auditCanonical(e);
      if (sha1(`${prev}|${canonical}`) !== e.hash) {
        // تلاعب بالمحتى فشل قاطع — لا ختم يعفيه
        return { ok: false, lines: lines.length, unhashed: preHashLines, preHashLines, hashedFrom, head: prev, brokenAt: i + 1, reason: 'تعديل في محتوى السطر', forks, duplicates, corrupt, sealedAt: sealLine };
      }
      /* التوقيع: يُتحقَّق حيث وُجد، ويُشترط بعد أول سطر موقّع (إزالته من سطر لاحق
         = محاولة تجريد الختم ⇒ تعديل). الأسطر قبل `hmacFrom` حقبة قديمة بلا مفتاح،
         تُحميها السلسلة + المرساة، ويُعلَن ذلك في التقرير. */
      if (typeof e.hmac === 'string' && e.hmac) {
        if (hmacFrom === null) hmacFrom = i + 1;
        hmacRows += 1;
        if (!sameHex(auditHmac(prev, canonical, e.hash), e.hmac)) {
          return { ok: false, lines: lines.length, unhashed: preHashLines, preHashLines, hashedFrom, head: prev, brokenAt: i + 1, reason: 'توقيع HMAC لا يطابق — السطر ليس من كاتب يملك المفتاح', forks, duplicates, corrupt, sealedAt: sealLine, hmacFrom, hmacRows };
        }
      } else if (hmacFrom !== null) {
        return { ok: false, lines: lines.length, unhashed: preHashLines, preHashLines, hashedFrom, head: prev, brokenAt: i + 1, reason: 'سطر بعد بدء التوقيع بلا HMAC — جُرِّد الختم', forks, duplicates, corrupt, sealedAt: sealLine, hmacFrom, hmacRows };
      }
      if (e.type === 'audit_chain_sealed') {
        /* ختم حقبة: سطر موقّع يعلن نهاية فترة مضطربة موثقة بأحداثها داخل الختم نفسه.
           الاستمرارية الصارمة تُطالب بعد الختم فقط — وما قبله تاريخ لا يُعاد كتابته (م38). */
        sealLine = i + 1;
        sealIncidents = {
          forksTotal: Number(e.incidents && e.incidents.forksTotal) || 0,
          duplicates: Array.isArray(e.incidents && e.incidents.duplicates) ? e.incidents.duplicates : [],
          corrupt: Array.isArray(e.incidents && e.incidents.corrupt) ? e.incidents.corrupt : [],
        };
      }
      prev = e.hash;
    }
    const first = (a) => (a.length ? a[0] : Infinity);
    // الحكم على ما بعد الختم فقط — ما قبله محفوظ حرفياً في سجل الختم
    const afterSeal = (arr) => (sealLine === null ? arr : arr.filter((x) => (typeof x === 'object' && x !== null ? x.line : x) > sealLine));
    const forksEff = afterSeal(forks), corruptEff = afterSeal(corrupt), duplicatesEff = afterSeal(duplicates);
    const brokenAt = Math.min(forksEff.length ? forksEff[0].line : Infinity, first(corruptEff), first(duplicatesEff));
    const brokenAtOut = Number.isFinite(brokenAt) ? brokenAt : null;
    const notes = [];
    if (duplicatesEff.length) notes.push(`إلحاق مزدوج (حرفي) في السطر ${duplicatesEff[0]}`);
    if (forksEff.length) notes.push(`تفرّع السلسلة في ${forksEff.length} موضعًا بعد الختم (أولها السطر ${forksEff[0].line})`);
    if (corruptEff.length) notes.push(`سطر تالف: ${corruptEff.join('،')}`);
    /* المرساة الطرفية: تكشف **حذف الذيل** (كان يمرّ ok:true) وتبديل الرأس.
       الحد المعلن: من يعدّل السجل والمرساة معاً يبقى غير مكشوف ⇒ يلزم مفتاح
       خارج الملف (HMAC) لإغلاق ذلك، وهو موثَّق كحد في SECURITY.md. */
    let anchor = null;
    try { anchor = JSON.parse(await fsp.readFile(auditAnchorFile, 'utf8')); } catch { anchor = null; }
    if (anchor) {
      const bytes = Buffer.byteLength(raw, 'utf8');
      if (Number(anchor.bytes) > bytes) notes.push(`السجل أقصر من آخر إلحاق مرصود (${bytes} < ${anchor.bytes} بايت) — حُذف ذيل`);
      if (anchor.head && prev && String(anchor.head) !== String(prev)) notes.push('رأس السلسلة لا يطابق المرساة — السجل ليس الذي كُتب');
    }
    return {
      ok: !forksEff.length && !corruptEff.length && !duplicatesEff.length && !notes.some((n) => /حُذف ذيل|لا يطابق المرساة/.test(n)),
      lines: lines.length, unhashed: preHashLines, preHashLines, hashedFrom,
      sealedAt: sealLine, historicalIncidents: sealIncidents,
      head: prev, brokenAt: brokenAtOut, anchored: Boolean(anchor),
      /* حالة التوقيع: من أي سطر بدأ، وكم سطراً موقّعاً، وكيف تُحمى الحقبة القديمة. */
      hmacFrom, hmacRows,
      hmacProtected: hmacFrom !== null,
      reason: notes.length ? notes.join('؛ ') : null,
      forks: forksEff.slice(0, 50), forksTotal: forksEff.length, duplicates: duplicatesEff, corrupt: corruptEff,
    };
  }
  // --- دوال العلاقات ---
  async function readRelations() {
    await ensureBaseFiles();
    if (!fs.existsSync(relationsFile)) return [];
    try { return JSON.parse(await fsp.readFile(relationsFile, 'utf8')); } catch { return []; }
  }
  async function writeRelations(rels) {
    await ensureBaseFiles();
    await fsp.writeFile(relationsFile, JSON.stringify(rels, null, 2), 'utf8');
    return rels;
  }
  // هل يؤدي إضافة relation من source إلى target إلى دورة (يعود target إلى source)؟
  async function wouldCreateCycle(rels, source, target) {
    // استعرض كل العلاقات المنبثقة من target بعمق، إذا وصلنا إلى source ⇒ دورة
    const visited = new Set();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === source) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const r of rels) {
        if (r.source === cur) stack.push(r.target);
      }
    }
    return false;
  }
  async function addRelation(source, target, type) {
    if (!source || !target || !RELATION_TYPES.has(type)) throw new Error('علاقة غير صالحة');
    if (source === target) throw new Error('لا يمكن الربط بين العنصر ونفسه');
    const rels = await readRelations();
    if (rels.some(r => r.source === source && r.target === target && r.type === type)) return { added: false, message: 'العلاقة موجودة بالفعل' };
    // contains و parent_project: ومنع أن يكون присоединение 역يًا (الابن لا يحتضن الأب)
    if ((type === 'contains' || type === 'parent_project') && await wouldCreateCycle(rels, source, target)) {
      throw new Error('منع دورة احتضان: هذا سيجعل العنصر ancestral لنفسه');
    }
    rels.push({ source, target, type, createdAt: nowIso() });
    await writeRelations(rels);
    cache.relations = rels;
    await appendAudit({ type: 'relation_added', source, target, relationType: type });
    return { added: true, source, target, type };
  }
  async function removeRelation(source, target, type) {
    const rels = await readRelations();
    const filtered = rels.filter(r => !(r.source === source && r.target === target && r.type === type));
    if (filtered.length === rels.length) return { removed: false };
    await writeRelations(filtered);
    cache.relations = filtered;
    await appendAudit({ type: 'relation_removed', source, target, relationType: type });
    return { removed: true };
  }
  async function getRelationsForNote(noteId) {
    const rels = await readRelations();
    return rels.filter(r => r.source === noteId || r.target === noteId);
  }
  // حاكم الوكيل: إيقاف فوري + ميزانية كتابة يومية — يفحص قبل كل أداة
  function agentPaused() { return fs.existsSync(pausedFile); }
  async function agentWritesToday() {
    try {
      const txt = await fsp.readFile(auditFile, 'utf8');
      const today = nowIso().slice(0, 10);
      let n = 0;
      for (const l of txt.split('\n')) {
        if (!l.trim()) continue;
        try { const d = JSON.parse(l); if (d.type === 'agent_action' && WRITE_TOOLS.has(d.tool) && String(d.time || '').startsWith(today)) n++; } catch {}
      }
      return n;
    } catch { return 0; }
  }
  /* ── م15/4: المفاتيح محمية على القرص ──
     AES-256-GCM بمفتاح محلي (data/.keystore، صلاحية 0600). الحد المعروف صراحةً:
     من يملك القرص كاملاً يملك المفتاح أيضاً — التشفير هنا يغلق مسار التسريب
     المُقاس (نسخ احتياطية/مزامنة/نقل ملف الإعدادات/بحث نصي)، لا هجوم حاسوب كامل.
     الصيغة: enc:v1:<iv>:<tag>:<cipher> — القيم الأخرى تُمرَّر كما هي. */
  const ENC_PREFIX = 'enc:v1:';
  const keystoreFile = path.join(dataDir, '.keystore');
  function keystoreKey() {
    try {
      const hex = fs.readFileSync(keystoreFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    } catch { /* يُنشأ أدناه */ }
    const key = require('crypto').randomBytes(32);
    fs.writeFileSync(keystoreFile, key.toString('hex') + '\n', { mode: 0o600 });
    try { fs.chmodSync(keystoreFile, 0o600); } catch { /* ويندوز: وضع الملف يكفي */ }
    return key;
  }
  function encryptSecret(plain) {
    const c = require('crypto');
    const iv = c.randomBytes(12);
    const cipher = c.createCipheriv('aes-256-gcm', keystoreKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `${ENC_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
  }
  function decryptSecret(v) {
    try {
      const [, , ivB64, tagB64, dataB64] = String(v).split(':');
      const d = require('crypto').createDecipheriv('aes-256-gcm', keystoreKey(), Buffer.from(ivB64, 'base64'));
      d.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
    } catch { return ''; } // قيمة مشفرة بمفتاح آخر ⇒ فارغة لا قيمة مختلقة
  }
  /* حقول الأسرار: مساران ثابتان + مصفوفة providers[].apiKey */
  function walkSecrets(obj, fn) {
    if (!obj || typeof obj !== 'object') return obj;
    if (typeof obj.ai?.apiKey === 'string') obj.ai.apiKey = fn(obj.ai.apiKey);
    if (typeof obj.memory?.retrieval?.apiKey === 'string') obj.memory.retrieval.apiKey = fn(obj.memory.retrieval.apiKey);
    if (Array.isArray(obj.providers)) for (const p of obj.providers) {
      if (p && typeof p === 'object' && typeof p.apiKey === 'string') p.apiKey = fn(p.apiKey);
    }
    return obj;
  }
  async function readSettings() {
    /* لا كاش هنا — بقرار مقاس: الاختبارات والأدوات تكتب settings.json مباشرةً،
       وتغيير بنفس الحجم داخل نفس الميلي‑ثانية (ar↔en) كان يفوته كاش
       mtime+size ⇒ لغة قديمة تُخدَم بصمت. صحّة الإعدادات تسبق توفير ~4ms. */
    let raw;
    try { raw = await fsp.readFile(settingsFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return defaultSettings(); throw e; }
    let loaded;
    try { loaded = JSON.parse(raw); }
    catch {
      /* عطل مُقاس (2026-11-11): قارئ متزامن مع كتابة غير ذرّية رأى JSON مقطوعاً
         ⇒ JSON.parse رمى ⇒ 500 متقطّع في /api/retrieval/status وغيره. محاولة
         ثانية قصيرة، ثم **عزل** الملف التالف والرجوع للافتراضي: طلب واحد لا يجوز
         أن يُسقط النظام، والملف يُحفظ للاستعادة لا يُمحى. */
      await new Promise((r) => setTimeout(r, 40));
      try { loaded = JSON.parse(await fsp.readFile(settingsFile, 'utf8')); }
      catch {
        try { await fsp.rename(settingsFile, `${settingsFile}.corrupt-${Date.now()}`); } catch { /* مقفل */ }
        return defaultSettings();
      }
    }
    walkSecrets(loaded, (v) => (typeof v === 'string' && v.startsWith(ENC_PREFIX) ? decryptSecret(v) : v));
    return mergeDeep(defaultSettings(), loaded);
  }
  async function saveSettings(settings) {
    const merged = mergeDeep(defaultSettings(), settings || {});
    // قبل الكتابة: كل سر نصي صريح يُشفَّر — القيم المشفرة مسبقاً والمقنَّعة تُتجاوز
    walkSecrets(merged, (v) => (typeof v === 'string' && v && !v.startsWith(ENC_PREFIX) && !/…/.test(v) ? encryptSecret(v) : v));
    /* كتابة **ذرّية ومتسلسلة** (النمط المُثبت في writeWorkspaceState): writeFile
       يفرّغ الملف أولاً، فكان قارئ متزامن يرى JSON مقطوعاً فيرمي 500، وكان انقطاع
       أثناء الكتابة يُتلف الإعدادات بمفاتيحها. tmp ثم rename ذرّي + سلسلة تمنع
       تداخل كتابتين. */
    settingsWriteChain = settingsWriteChain.then(async () => {
      const tmp = settingsFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
      await fsp.rename(tmp, settingsFile);
    }).catch(() => {});
    await settingsWriteChain;
    await appendAudit({ type: 'settings_updated' });
    cache.index = null;
    return merged;
  }
  // أسباب الإسناد تُخزَّن كرموز ثابتة وتُترجَم لحظة العرض — وإلا تسرّبت لغة
  // النداء الأول إلى كل النداءات التالية (عربية في en والعكس).
  const REASONS = Object.freeze({
    open_now: ['هو العنصر المفتوح الآن', 'It is the currently open item'],
    active_project: ['ينتمي للمشروع النشط', 'It belongs to the active project'],
    recent_doc: ['من أحدث المستندات', 'It is one of the most recent documents'],
    is_document: ['هو مستند', 'It is a document'],
    is_project: ['هو مشروع', 'It is a project'],
    is_task: ['هي مهمة', 'It is a task'],
    exact_title: ['مطابقة مباشرة', 'Direct title match'],
    project_name: ['مطابقة اسم مشروع', 'Project name match'],
    lexical: ['تطابق نصي', 'Lexical match'],
    entity: ['يحتوي الكيان المذكور', 'It contains the mentioned entity'],
    generic_doc: ['طلب عام على مستند', 'Generic request for a document'],
    generic_project: ['طلب عام على مشروع', 'Generic request for a project'],
  });
  const reasonText = (code) => {
    const r = REASONS[code];
    return r ? i18n.T(r[0], r[1]) : code;
  };
  function localizeResolved(res) {
    if (!res || !Array.isArray(res.reasonCodes)) return res;
    return { ...res, reasons: res.reasonCodes.map(reasonText) };
  }

  async function readWorkspaceState() {
    await ensureBaseFiles();
    if (cache.state) return cache.state;
    let loaded = defaultWorkspaceState();
    if (fs.existsSync(workspaceStateFile)) {
      try {
        loaded = JSON.parse(await fsp.readFile(workspaceStateFile, 'utf8'));
      } catch (e) {
        // ملف تالف (كتابة متزامنة قديمة): استخرج أول كائن JSON صالح منه بدل 500 كامل
        try {
          const raw = await fsp.readFile(workspaceStateFile, 'utf8');
          loaded = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
        } catch (e2) { loaded = defaultWorkspaceState(); }
      }
    }
    cache.state = mergeDeep(defaultWorkspaceState(), loaded);
    if (cache.state.lastResolved) cache.state.lastResolved = localizeResolved(cache.state.lastResolved);
    return cache.state;
  }
  let workspaceWriteChain = Promise.resolve();
  /* سلسلة كتابة مستقلة للإعدادات (انظر saveSettings): نفس عطل الملف المزدوج. */
  let settingsWriteChain = Promise.resolve();
  /* وثالثة لفهرس المتجهات (ملف كبير): القطع كان يُفسده. */
  let vectorWriteChain = Promise.resolve();
  /* سلسلة كتابة **لكل معرّف ملاحظة**: حفظان متزامنان لنفس id كانا يتداخلان
     (writeFile يُفرّغ الملف ثم يكتب، فالكاتب الثاني يقرأ نصف الأول). */
  const noteWriteChains = new Map();
  async function writeWorkspaceState(state) {
    const next = mergeDeep(defaultWorkspaceState(), state || {});
    next.updatedAt = nowIso();
    // كتابة ذرية متسلسلة: تزامن مسارين كان ينتج ملف JSON مزدوجاً (}{" ) ⇒ dashboard 500
    workspaceWriteChain = workspaceWriteChain.then(async () => {
      const tmp = workspaceStateFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await fsp.rename(tmp, workspaceStateFile);
    }).catch(() => {});
    await workspaceWriteChain;
    cache.state = next;
    return next;
  }
  async function recordActivity({ noteId = '', project = '', resolved = null, note: noteArg = null } = {}) {
    const state = await readWorkspaceState();
    // الأداء (عطل مُقاس 2026-10-24): كان يقرأ المخزن كله ليصفّي ملاحظة واحدة —
    // وsaveNote يناديه بعد كل حفظ ⇒ مسح 700+ ملف لكل حفظ. من يملك كائن الملاحظة
    // يمرّره (noteArg) فلا مسح، ومن لا يملكه يبقى مساره كما هو.
    let note = noteArg;
    if (!note && noteId) note = (await readNotes()).find(n => n.id === slugify(noteId)) || null;
    const next = { ...state };
    if (note) {
      next.activeNoteId = note.id;
      next.recentNoteIds = unique([note.id, ...(next.recentNoteIds || [])]).slice(0, 25);
      if (note.classification.isDocument) next.recentDocumentIds = unique([note.id, ...(next.recentDocumentIds || [])]).slice(0, 25);
      if (note.classification.project) next.activeProject = note.classification.project;
    }
    if (project) {
      next.activeProject = project;
      next.recentProjectNames = unique([project, ...(next.recentProjectNames || [])]).slice(0, 15);
    }
    if (resolved) {
      const { reasons, ...rest } = resolved; // النص المترجم لا يُخزَّن
      next.lastResolved = { ...rest, time: nowIso() };
    }
    return writeWorkspaceState(next);
  }
  async function computeNotesKey(files) {
    const stats = await Promise.all(files.map(async f => {
      const st = await fsp.stat(path.join(vaultDir, f));
      return `${f}:${st.mtimeMs}`;
    }));
    return stats.sort().join('|');
  }
  function noteFingerprint(note) {
    return sha1(JSON.stringify({ id: note.id, updatedAt: note.updatedAt, content: note.content }));
  }
  function resolveProjectName(note, derived) {
    return note.fm?.project || derived.project || (derived.primaryType === 'project' ? note.title : '');
  }
  /* بناء كائن الملاحظة من ملفها وحده (بلا قراءة المخزن كله).
     الأداء (عطل مُقاس 2026-10-24): saveNote كان يستدعي readNotes() بعد كل كتابة،
     وreadNotes يفحص كل ملفات المخزن (700+ stat) ⇒ 90ms لكل حفظ، والتكلفة تنمو
     مع حجم المخزن (استيراد 120 ملفاً: 25–50 ثانية، تربيعي). الحفظ يحتاج ملاحظته هو. */
  async function noteFromFile(file, { rawOverride = null, statOverride = null } = {}) {
    const full = path.join(vaultDir, file);
    const stat = statOverride || await fsp.stat(full);
    const raw = rawOverride !== null ? rawOverride : await fsp.readFile(full, 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    const note = {
      id: path.basename(file, '.md'),
      /* المسار داخل الخزنة (2026-11-15): يلزم لتمييز ملاحظتين بنفس الاسم في
         مجلدين، ولعرض «أين تسكن هذه الملاحظة» في الواجهة. */
      relPath: String(file).replace(/\\/g, '/'),
      title: extractTitle(body, path.basename(file, '.md')),
      content: raw,
      body,
      fm,
      updatedAt: stat.mtime.toISOString(),
      createdAt: fm.created || stat.birthtime.toISOString(),
      links: extractWikiLinks(raw),
      /* مرفقات Obsidian: ![[صورة.png]] أو ![](مسار) — تُذكر ولا تُفهرَس
         (لا OCR ولا استخراج نص منها بعد). */
      attachments: extractAttachments(raw)
    };
    const derived = classifyText(note.content);
    note.classification = classifyNote(note);
    note.documentType = note.classification.documentType;
    note.isDocument = note.classification.isDocument;
    note.projectName = resolveProjectName(note, derived);
    note.structured = extractStructuredInfo(note.body);
    note.entities = extractEntities(`${note.title}\n${note.body}`);
    note.fingerprint = noteFingerprint(note);
    note.__stamp = stat.mtimeMs + ':' + stat.size;
    return note;
  }
  /* قراءتان متوازيتان (تدفئة الكاش + أول طلب) كانتا تُحلّلان كل الملفات مرتين. */
  let notesInflight = null;
  /* مجلدات لا تُقرأ كمعرفة: مخفيّات Obsidian وأثر الحذف وnode_modules.
     القاعدة: أي مجلد يبدأ بنقطة يُتخطّى (‎.obsidian/‎. trashes/‎. git). */
  const VAULT_SKIP = new Set(['node_modules', 'trash', 'backups']);
  async function listVaultFiles() {
    const out = [];
    const walk = async (rel, depth) => {
      if (depth > 8) return;
      let entries = [];
      try { entries = await fsp.readdir(path.join(vaultDir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e || !e.name || e.name.startsWith('.')) continue;
        if (VAULT_SKIP.has(e.name)) continue;
        const next = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(next, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(next);
      }
    };
    await walk('', 0);
    return out.sort();
  }

  async function readNotes() {
    if (notesInflight) return notesInflight;
    notesInflight = (async () => {
    await ensureBaseFiles();
    /* عودي (2026-11-15): كانت تقرأ الجذر فقط — فخزنة Obsidian بمجلداتها
       تبدو فارغة إلا من ملفات المستوى الأول. */
    const files = await listVaultFiles();
    const key = await computeNotesKey(files);
    if (cache.notes && cache.notesKey === key) return cache.notes;
    /* كاش قرص: إعادة التشغيل كانت تُعيد تحليل كل الملفات (~8-13ث لأول طلب).
       المفتاح نفسه (اسم: mtimeMs) يحمي الملف: أي تعديل يغيّر المفتاح فيُعاد البناء. */
    const diskCacheFile = path.join(dataDir, 'notes-cache.json');
    if (!Array.isArray(cache.notes) || !cache.notes.length) {
      try {
        const disk = JSON.parse(await fsp.readFile(diskCacheFile, 'utf8'));
        if (disk && disk.v === 1 && disk.key === key && Array.isArray(disk.notes) && disk.notes.length) {
          cache.notes = disk.notes;
          cache.notesKey = key;
          cache.relations = await readRelations();
          return cache.notes;
        }
      } catch { /* لا كاش أو تالف: نبني من الملفات */ }
    }
    /* الأداء (مؤكد حياً): كل كتابة كانت تُفرّغ الكاش فيُعاد بناء القاعدة كاملة —
       عند 552 عنصراً صار POST /api/notes = 11.0ث و/status = 1.1ث (تربيعي).
       الإصلاح: كاش **ملف-بملف** بمفتاح (mtimeMs:size) — يُعاد تحليل الملفات
       المتغيّرة وحدها، والباقي يُعاد استخدامه كما هو. النتيجة واحدة بالضبط. */
    const prevByFile = new Map();
    if (Array.isArray(cache.notes)) for (const n of cache.notes) prevByFile.set(n.id + '.md', n);
  const notes = new Array(files.length);
  /* التحليل كان تسلسلياً: 356 ملفاً × ~50ms = 18.8 ثانية على إقلاع بارد.
     عمال متوازون بسقف 8 يحفظون النتيجة نفسها بترتيب الملفات. */
  let parsedCount = 0;
  let nextFile = 0;
  /* ملفات تُتخطّى لخطأ قراءة/تحليل — تُبلَّغ في حالة الاسترجاع بدل الابتلاع. */
  const skippedNotes = [];
  const parseOne = async (i) => {
    const file = files[i];
    const full = path.join(vaultDir, file);
    let stat;
    try { stat = await fsp.stat(full); } catch { return; }   // ملف اختفى بين القراءة والإحصاء
    const stamp = stat.mtimeMs + ':' + stat.size;
    const cached = prevByFile.get(file);
    if (cached && cached.__stamp === stamp) { notes[i] = cached; return; }
    /* يُحصى **المُحلَّل** لا المفحوص: كان العدّ قبل فحص الكاش، فشرط «20 مُحلَّلاً»
       صحيح دائماً في خزنة كبيرة ⇒ كتابة 32.7MB (notes-cache) عند كل حفظ.
       (عطل أداء مُقاس 2026-11-11: JSON.stringify للكاش = 210ms داخل كل حفظ.) */
    parsedCount += 1;
    /* عزل خطأ لكل ملف (عطل مُقاس 2026-11-11): stat كانت محمية وحدها، فـEBUSY/EPERM
       (مضاد فيروسات/OneDrive) أو ENOENT بين stat والقراءة كان يُسقط readNotes
       كاملاً ⇒ 500 في كل مسار يقرأ الخزنة (notes/dashboard/brain/search).
       القاعدة: ملف واحد تالف يُتخطّى ويُحصى، ولا يُسقط الطلب. */
    let parsed;
    try {
      parsed = await noteFromFile(file, { statOverride: stat });
    } catch (e) {
      skippedNotes.push({ file, error: String((e && e.message) || e) });
      return;
    }
    /* نوع المعرفة (المادة 6): يُحسب مرة واحدة ويُحمَل مع العنصر حتى تُظهره الواجهة
       — كان محفوظاً في SQLite فقط، فبدا المستنتج كأنه معتمد. */
    parsed.knowledgeKind = knowledgeKindOf(parsed);
    notes[i] = parsed;
  };
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    for (;;) {
      const i = nextFile++;
      if (i >= files.length) return;
      await parseOne(i);
    }
  });
  await Promise.all(workers);
  const keep = notes.filter(Boolean);
  /* تصادم المعرّفات (2026-11-15): خزنة بمجلدات قد تحمل a/x.md و b/x.md —
     كلتاهما id=x فتُطمس إحداهما في الفهرس. الثانية تُسمّى مجلد-الاسم. */
  {
    const seen = new Map();
    for (const n of keep) {
      if (!seen.has(n.id)) { seen.set(n.id, 1); continue; }
      const rel = String(n.relPath || '').replace(/\.md$/i, '');
      const parts = rel.split('/').filter(Boolean);
      const folder = parts.length > 1 ? parts[parts.length - 2] : 'dup';
      let candidate = `${folder}-${n.id}`.replace(/[\s/\\]+/g, '-');
      let i = 2;
      while (seen.has(candidate)) candidate = `${folder}-${n.id}-${i++}`;
      seen.set(candidate, 1);
      n.id = candidate;
    }
  }
  notes.length = 0; notes.push(...keep);
  cache.skippedNotes = skippedNotes;
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    cache.notesKey = key;
    cache.notes = notes;
    /* حفظ كاش القرص بعد بناء كبير (≥20 ملفاً محلَّلاً) — لا بعد كل تعديل صغير. */
    if (parsedCount >= 20) {
      (async () => {
        try {
          const payload = JSON.stringify({ v: 1, key, notes });
          if (payload.length < 40 * 1024 * 1024) await fsp.writeFile(diskCacheFile, payload, 'utf8');
        } catch { /* فشل الكتابة لا يُسقط القراءة */ }
      })();
    }
    cache.relations = await readRelations();
    return notes;
    })().finally(() => { notesInflight = null; });
    return notesInflight;
  }
  function invalidateCache() {
    /* لا نُسقط cache.notes هنا (كان العطل: كل كتابة تُفرّغ كل شيء ⇒ إعادة بناء كاملة).
       نُبطل المفتاح فقط، فيُعاد بناء الملاحظات من كاش الملفات الجزئي — الملفات
       غير المتغيّرة تُعاد استخدامها فوراً. */
    cache.notesKey = '';
    cache.index = null;
    cache.state = null;
    cache.relations = null;
    decisionSentenceCache.clear();
    reviewCache.key = '';
  }
  async function snapshotExisting(filePath, noteId) {
    if (!fs.existsSync(filePath)) return;
    const dir = path.join(historyDir, noteId);
    await fsp.mkdir(dir, { recursive: true });
    const current = await fsp.readFile(filePath, 'utf8');
    const existing = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort().reverse();
    if (existing.length) {
      const last = await fsp.readFile(path.join(dir, existing[0]), 'utf8').catch(() => null);
      if (last === current) return; // لا تغيير فعلي ⇒ لا نكرّر اللقطة
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(filePath, path.join(dir, `${stamp}.md`));
  }
  function mergeFrontmatter(existingFm = {}, next = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(next || {})) {
      if (v === undefined || v === null || v === '') continue;
      clean[k] = v;
    }
    const tags = unique([...(existingFm.tags || []), ...(clean.tags || [])]);
    const merged = {
      ...existingFm,
      ...clean,
      tags,
      type: normalizeType(clean.type || existingFm.type || 'note'),
      created: existingFm.created || clean.created || nowIso(),
      updated: nowIso()
    };
    if (!merged.documentType) delete merged.documentType;
    return merged;
  }
  // نعلّم الفهرس «متسخًا» بملف صغير بدل إعادة كتابة الفهرس كاملًا (تضمينات ونصوص) عند كل حفظ
  async function markVectorIndexDirty(reason = 'write') {
    try {
      // الأداء (عطل مُقاس 2026-10-24): كتابة ملف العلامة لكل حفظ = ~26ms على ويندوز
      // (كل عملية fs هنا ~26ms). العلامة منطقية لا يومية: إن كانت مرفوعة فعلاً لا شيء يتغيّر
      // بإعادة كتابتها. نكتب مرة واحدة حتى يُنظَّف الملف، ونحدّث السبب في الذاكرة فقط.
      if (cache.vectorDirty) {
        if (cache.index) cache.index = { ...cache.index, dirty: true, dirtyReason: reason };
        return;
      }
      const marker = { dirty: true, dirtyReason: reason, dirtyAt: nowIso() };
      await fsp.writeFile(vectorDirtyFile, JSON.stringify(marker, null, 2), 'utf8');
      cache.vectorDirty = true;
      if (cache.index) cache.index = { ...cache.index, ...marker };
    } catch {}
  }
  async function readVectorDirtyMarker() {
    if (!fs.existsSync(vectorDirtyFile)) { cache.vectorDirty = false; return null; }
    try {
      const m = JSON.parse(await fsp.readFile(vectorDirtyFile, 'utf8'));
      cache.vectorDirty = !!m?.dirty;
      return m;
    } catch { cache.vectorDirty = false; return null; }
  }
  async function clearVectorDirtyMarker() {
    cache.vectorDirty = false;
    if (fs.existsSync(vectorDirtyFile)) await fsp.unlink(vectorDirtyFile).catch(() => {});
  }
  async function saveNote(payload = {}) {
    const rawContent = String(payload.content || '').trim();
    const title = String(payload.title || extractTitle(rawContent, 'Untitled')).trim() || 'Untitled';
    let id = payload.id ? slugify(payload.id) : slugify(title);
    if (!payload.id && fs.existsSync(path.join(vaultDir, `${id}.md`))) id = `${id}-${Date.now().toString(36)}`;
    /* مكان الحفظ (2026-11-15): ملاحظة تعيش في مجلد داخل خزنة Obsidian يجب أن
       تعود إلى مجلدها — وإلا نُسخت إلى الجذر عند أول تعديل. */
    const existingNote = Array.isArray(cache.notes) ? cache.notes.find((n) => n && n.id === id) : null;
    const filePath = (existingNote && existingNote.relPath)
      ? path.join(vaultDir, existingNote.relPath)
      : path.join(vaultDir, `${id}.md`);
    let existingFm = {};
    if (fs.existsSync(filePath)) existingFm = parseFrontmatter(await fsp.readFile(filePath, 'utf8')).fm;
    await snapshotExisting(filePath, id);
    const parsed = rawContent.startsWith('---') ? parseFrontmatter(rawContent) : { fm: {}, body: rawContent };
    const baseFm = { ...existingFm, ...parsed.fm };
    const bodyText = parsed.body;
    const derived = classifyText(bodyText);
    const inferredProject = payload.project || baseFm.project || derived.project || ((payload.type || baseFm.type || derived.primaryType) === 'project' ? title : '');
    const documentType = payload.documentType || (derived.documentType !== 'note' ? derived.documentType : baseFm.documentType);
    const mergedFm = mergeFrontmatter(baseFm, {
      tags: payload.tags,
      type: payload.type || (derived.primaryType !== 'note' ? derived.primaryType : baseFm.type),
      documentType,
      importance: payload.importance !== undefined ? Number(payload.importance) : (baseFm.importance ?? derived.suggestedImportance ?? 1),
      source: payload.source,
      url: payload.url,
      project: inferredProject,
      status: payload.status,
      owner: payload.owner
    });
    const body = bodyText.trim();
    const headed = body.startsWith('# ') ? body : `# ${title}\n\n${body}`;
    /* كتابة ذرّية متسلسلة لكل معرّف (عطل مُقاس 2026-11-11): writeFile يُفرّغ
       الملف قبل الكتابة، فحفظان متزامنان لنفس الملاحظة يتداخلان (الكاتب الثاني
       يقرأ/يكتب نصف الأول) وانقطاع العملية يترك ملاحظة مقطوعة — ومصدر الحقيقة
       هو الملف. نفس نمط settingsWriteChain المُثبت. */
    const tmpNote = filePath + '.tmp';
    const prev = noteWriteChains.get(id) || Promise.resolve();
    const chain = prev.catch(() => { /* فشل سابق لا يكسر السلسلة */ }).then(async () => {
      await fsp.writeFile(tmpNote, `${buildFrontmatter(mergedFm)}${headed}\n`, 'utf8');
      await fsp.rename(tmpNote, filePath);
    });
    noteWriteChains.set(id, chain);
    try {
      await chain;
    } finally {
      if (noteWriteChains.get(id) === chain) noteWriteChains.delete(id);
    }
    selfWriteAt = Date.now();
    invalidateCache();
    await markVectorIndexDirty('note_saved');
    // الأداء: الملاحظة تُبنى من ملفها المكتوب للتوّ (ملف واحد) لا من المخزن كله —
    // readNotes كانت تفحص 700+ ملفاً لكل حفظ (تربيعي مع حجم المخزن).
    let saved = null;
    /* المسار الفعلي لا `id.md` (2026-11-15): ملاحظة داخل مجلد كانت تُقرأ من
       مسار غير موجود بعد الحفظ ⇒ saved=null ⇒ نشاط وتقرير بلا كائن. */
    try {
      const relSaved = path.relative(vaultDir, filePath).split(path.sep).join('/');
      saved = await noteFromFile(relSaved);
    } catch { /* ملف غير متاح: نكمل بلا كائن ملاحظة */ }
    await recordActivity({ noteId: id, project: saved?.projectName || inferredProject || '', note: saved });
    await appendAudit({ type: 'note_saved', noteId: id, noteTitle: title, noteType: mergedFm.type });
    return saved;
  }
  async function deleteNote(id) {
    const noteId = slugify(id);
    /* الملاحظة قد تكون داخل مجلد (2026-11-15): الحذف يجدها بمسارها لا بالجذر. */
    const known = Array.isArray(cache.notes) ? cache.notes.find((n) => n && n.id === noteId) : null;
    const file = (known && known.relPath)
      ? path.join(vaultDir, known.relPath)
      : path.join(vaultDir, `${noteId}.md`);
    if (!fs.existsSync(file)) return false;
    await snapshotExisting(file, noteId);
    await fsp.unlink(file);
    selfWriteAt = Date.now();
    invalidateCache();
    await markVectorIndexDirty('note_deleted');
    await appendAudit({ type: 'note_deleted', noteId });
    return true;
  }
  async function listHistory(id) {
    const dir = path.join(historyDir, slugify(id));
    if (!fs.existsSync(dir)) return [];
    return (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort().reverse();
  }
  async function readHistoryEntry(id, fileName) {
    const safe = path.basename(String(fileName || ''));
    if (!/\.md$/i.test(safe)) return null;
    const dir = path.join(historyDir, slugify(id));
    const p = path.join(dir, safe);
    if (!p.startsWith(dir + path.sep)) return null;
    return fs.existsSync(p) ? fsp.readFile(p, 'utf8') : null;
  }
  function resolveLinkTarget(target, notes) {
    const slug = slugify(target);
    return notes.find(n => n.id === slug)?.id || notes.find(n => n.title.toLowerCase() === target.toLowerCase())?.id || slug;
  }
  /* مفتاح هوية المشروع. `slugify` وحدها لا تكفي: تُعيد `note-<ts>` للفراغ، فيصير
     مشروعان بلا اسم «متطابقين». الفراغ هنا يعني «بلا مشروع» صراحةً. */
  function projectKey(value) {
    const raw = String(value || '').trim();
    return raw ? slugify(raw) : '';
  }
  /* عطل مُقاس (P0، تدقيق 2026-11-11): الفلتر لم يكن حاجزاً. كان `notesForProject`
     يسقط إلى `n.body/n.title.includes(q)` — ففلتر m41 يعيد ملاحظات m41-demo لأن
     نصّها يذكر m41 — وكان الفلتر في البحث يقبل `projectBoost>0` (تطابق **جزئي**
     على entry.project) دليلاً كافياً. الآن مسارَان منفصلان: هوية دقيقة
     (`projectKey`) للمطابقة، ثم «ذات صلة» (مشروع فرعي/أب بالاسم) للعرض فقط،
     وبلا أي سقوط إلى body/title. */
  function notesForProject(notes, project) {
    const key = projectKey(project);
    if (!key) return notes;
    const exact = notes.filter(n => projectKey(n.projectName) === key
      || (n.fm?.tags || []).some(t => projectKey(t) === key));
    if (exact.length) return exact;
    // ذات صلة: علاقة تسمية صريحة (m41 ↔ m41-demo) لا بحث نصي حر.
    return notes.filter(n => {
      const k = projectKey(n.projectName);
      return Boolean(k) && (k.startsWith(`${key}-`) || key.startsWith(`${k}-`));
    });
  }
  // مرجع سريع للروابط: بالمعرّف ثم بعنوان الملاحظة (نفس منطق resolveLinkTarget بلا بحث متكرر)
  function makeLinkResolver(notes) {
    const ids = new Set(notes.map(n => n.id));
    const titles = new Map(notes.map(n => [n.title.toLowerCase(), n.id]));
    return link => {
      const slug = slugify(link);
      if (ids.has(slug)) return slug;
      return titles.get(String(link || '').toLowerCase()) || slug;
    };
  }
  function buildBrainModel(notes) {
    const projects = new Map();
    const entities = new Map();
    const edges = [];
    const resolveLink = makeLinkResolver(notes);
    for (const note of notes) {
      const projectName = note.projectName || '';
      if (projectName) {
        const pid = slugify(projectName);
        const project = projects.get(pid) || { id: pid, name: projectName, noteIds: [], documentIds: [], taskIds: [], decisionIds: [], riskIds: [], meetingIds: [], updatedAt: note.updatedAt, importance: 0 };
        project.noteIds.push(note.id);
        if (note.isDocument) project.documentIds.push(note.id);
        if (note.classification.primaryType === 'task') project.taskIds.push(note.id);
        if (note.classification.primaryType === 'decision') project.decisionIds.push(note.id);
        if (note.classification.primaryType === 'risk') project.riskIds.push(note.id);
        if (note.classification.primaryType === 'meeting') project.meetingIds.push(note.id);
        if (note.classification.primaryType === 'project' && !project.rootNoteId) project.rootNoteId = note.id;
        project.updatedAt = project.updatedAt > note.updatedAt ? project.updatedAt : note.updatedAt;
        project.importance = Math.max(project.importance, Number(note.fm?.importance) || 0);
        projects.set(pid, project);
        edges.push({ source: note.id, target: pid, type: 'belongs_to_project' });
      }
      for (const link of note.links) edges.push({ source: note.id, target: resolveLink(link), type: 'wikilink' });
      for (const entity of note.entities) {
        const current = entities.get(entity.id) || { id: entity.id, name: entity.name, type: entity.type, noteIds: [], projects: [] };
        current.noteIds.push(note.id);
        if (projectName) current.projects.push(projectName);
        entities.set(entity.id, current);
        edges.push({ source: note.id, target: entity.id, type: 'mentions_entity' });
      }
    }
    const projectList = [...projects.values()].map(p => ({
      ...p,
      noteIds: unique(p.noteIds),
      documentIds: unique(p.documentIds),
      taskIds: unique(p.taskIds),
      decisionIds: unique(p.decisionIds),
      riskIds: unique(p.riskIds),
      meetingIds: unique(p.meetingIds),
      noteCount: unique(p.noteIds).length,
      documentCount: unique(p.documentIds).length,
      taskCount: unique(p.taskIds).length,
      decisionCount: unique(p.decisionIds).length,
      riskCount: unique(p.riskIds).length
    })).sort((a, b) => b.noteCount - a.noteCount || b.updatedAt.localeCompare(a.updatedAt));
    // إضافة علاقات العلاقات (contains / references / parent_project) إلى حواف الخارطة
    const relationships = cache.relations || [];
    for (const r of relationships) {
      edges.push({ source: r.source, target: r.target, type: r.type, relation: true });
    }
    const light = n => {
      const type = n.classification.primaryType;
      // شكل ولون ثابت حسب النوع في كل مكان (الخارطة، المكتبة، القوائم، لوحة المشروع)
      const shape = type === 'project' ? 'circle' : type === 'doc' || type === 'procedure' || type === 'decision' || type === 'meeting' ? 'rect' : type === 'task' ? 'diamond' : 'octagon';
      const color = type === 'project' ? '#e8b34b' : type === 'doc' ? '#4cc2b0' : type === 'decision' ? '#e06c75' : type === 'meeting' ? '#c678dd' : type === 'task' ? '#61afef' : type === 'procedure' ? '#98c379' : '#66707c';
      return { id: n.id, title: n.title, type, project: n.projectName || '', isDocument: n.isDocument, documentType: n.documentType, importance: Number(n.fm?.importance) || 0, tags: n.fm?.tags || [], links: n.links, updatedAt: n.updatedAt, shape, color };
    };
    return {
      notes: notes.map(light),
      documents: notes.filter(n => n.isDocument).map(light),
      projects: projectList,
      entities: [...entities.values()].map(e => ({ ...e, noteIds: unique(e.noteIds), projects: unique(e.projects) })).sort((a, b) => b.noteIds.length - a.noteIds.length),
      edges
    };
  }
  /* جُمل القرار لكل ملاحظة تُحسب مرة واحدة.
     العطل المُقاس 2026-11-07: reviewWorkspace يقارن 40 × 356 = 14,240 زوجاً،
     وكان sentenceSplit + regex يُعادان في كل زوج على نص يبلغ 58KB ⇒ 16.7 ثانية
     من CPU تحجب /api/status عند كل نبضة إقلاع. النتيجة الآن مطابقة تماماً. */
  const DECISION_RE = /decision|قرر|نستخدم|لا نستخدم|adopt|avoid|replace/i;
  const decisionSentenceCache = new Map();
  function decisionSentences(n) {
    const stamp = String(n.updatedAt || '') + ':' + String((n.body || '').length);
    const hit = decisionSentenceCache.get(n.id);
    if (hit && hit.stamp === stamp) return hit.sentences;
    const sentences = sentenceSplit(n.body).filter(s => DECISION_RE.test(s));
    decisionSentenceCache.set(n.id, { stamp, sentences });
    return sentences;
  }
  function detectContradictions(note, notes) {
    const subjects = decisionSentences(note);
    const contradictions = [];
    for (const other of notes) {
      if (other.id === note.id) continue;
      const others = decisionSentences(other);
      for (const a of subjects) for (const b of others) {
        const overlap = overlapScore(a, b);
        if (overlap >= 3 && polarityScore(a) * polarityScore(b) < 0) contradictions.push({ againstId: other.id, againstTitle: other.title, evidence: [a, b], overlap });
      }
    }
    return contradictions.slice(0, 8);
  }
  function chunkNote(note, cfg) {
    const text = `${note.title}\n\n${note.body}`.trim();
    const paragraphs = text.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    const pushChunk = () => {
      if (!current.trim()) return;
      chunks.push(current.trim());
      current = '';
    };
    for (const para of paragraphs) {
      if (!current.length) current = para;
      else if ((current + '\n\n' + para).length <= cfg.chunkSize) current += `\n\n${para}`;
      else { pushChunk(); current = para; }
    }
    pushChunk();
    if (!chunks.length && text) chunks.push(text.slice(0, cfg.chunkSize));
    if (cfg.chunkOverlap > 0 && chunks.length > 1) {
      return chunks.map((chunk, idx) => idx === 0 ? chunk : `${chunks[idx - 1].slice(-cfg.chunkOverlap)}\n${chunk}`);
    }
    return chunks;
  }
  async function embedTexts(texts, settings, stats = null) {
    const cfg = getRetrievalConfig(settings);
    const provider = cfg.provider || 'mock';
    if (!texts.length) return [];
    if (provider === 'mock') return texts.map(t => deterministicEmbedding(t, cfg.dimensions || 256));
    // المزود المحلي الحقيقي: n-gram TF-IDF مموضع بإشارة — بلا أي نداء شبكة
    if (provider === 'local-ngram') return texts.map(t => makeLocalEmbedding(t, cfg.dimensions || 256, stats));
    if (provider === 'openai-compatible') {
      const base = (cfg.baseUrl || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const data = await safeJsonFetch(`${base}/v1/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: cfg.model, input: texts }) });
      return (data.data || []).sort((a, b) => a.index - b.index).map(item => normalizeVector(item.embedding || []));
    }
    if (provider === 'ollama') {
      const base = (cfg.ollamaBaseUrl || cfg.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      try {
        const data = await safeJsonFetch(`${base}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.model, input: texts }) });
        const embeddings = data.embeddings || data.data || [];
        return embeddings.map(item => normalizeVector(Array.isArray(item) ? item : item.embedding || []));
      } catch {
        const out = [];
        for (const text of texts) {
          const data = await safeJsonFetch(`${base}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: cfg.model, prompt: text }) });
          out.push(normalizeVector(data.embedding || []));
        }
        return out;
      }
    }
    throw new Error(`Unsupported retrieval provider: ${provider}`);
  }
  function retrievalSignature(settings) {
    const cfg = getRetrievalConfig(settings);
    return sha1(JSON.stringify({ provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, ollamaBaseUrl: cfg.ollamaBaseUrl, dimensions: cfg.dimensions, chunkSize: cfg.chunkSize, chunkOverlap: cfg.chunkOverlap, rerankStrategy: cfg.rerankStrategy }));
  }
  async function readVectorIndex() {
    /* كاش مع تحقق بصمة الملف (عطل مُقاس 2026-11-11): الخادم كان يخزّن الفهرس في
       الذاكرة ولا يرى إعادة بناء خارجية أبداً — فتصبح أداة \`tools/rebuild-index.cjs\`
       **عديمة الأثر** ما دام الخادم يعمل، ويبقى البحث على فهرس قديم بلا إشارة.
       stat واحدة (~٠٫١ms) تكفي لكشف تغيّر mtime/size. */
    let stamp = null;
    try { const st = await fsp.stat(vectorIndexFile); stamp = `${st.mtimeMs}:${st.size}`; } catch { stamp = null; }
    if (stamp === null) return null;
    if (cache.index && cache.indexStamp === stamp) return { ...cache.index, _loadedFromCache: true };
    try {
      const idx = JSON.parse(await fsp.readFile(vectorIndexFile, 'utf8'));
      cache.index = idx;
      cache.indexStamp = stamp;
      return idx;
    } catch {
      /* عطل مُقاس (2026-11-11): فهرس المتجهات (12.5MB) كُتب بلا ذرّية فانقطع،
         ثم رمى JSON.parse داخل getRetrievalStatus ⇒ 500 متكرر وبطء شديد لكل طلب.
         الفهرس **مشتق** لا مصدر حقيقة (يمكن إعادة بنائه من الخزنة)، فالصواب عزله
         ووسمه متسخاً ليبني نفسه، لا إسقاط الطلبات. */
      try { await fsp.rename(vectorIndexFile, `${vectorIndexFile}.corrupt-${Date.now()}`); } catch { /* مقفل */ }
      cache.index = null;
      await markVectorIndexDirty('vector_index_corrupt').catch(() => {});
      return null;
    }
  }
  async function writeVectorIndex(index) {
    /* كتابة ذرّية متسلسلة: الملف كبير (12.5MB) والقطع كان يُفسده (عطل مُقاس). */
    vectorWriteChain = vectorWriteChain.then(async () => {
      const tmp = vectorIndexFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
      await fsp.rename(tmp, vectorIndexFile);
    }).catch(() => {});
    await vectorWriteChain;
    cache.index = index;
    return index;
  }
  function notesFingerprint(notes) { return sha1(notes.map(n => `${n.id}:${n.fingerprint}`).join('|')); }
  async function getRetrievalStatus() {
    const settings = await readSettings();
    const cfg = getRetrievalConfig(settings);
    const current = await readVectorIndex();
    const marker = await readVectorDirtyMarker();
    const base = current || { version: 1, engine: 'hybrid-memory', provider: cfg.provider, model: cfg.model, entryCount: 0, noteCount: 0, builtAt: null, signature: retrievalSignature(settings), dirty: true };
    const { _loadedFromCache, entries, embedding, ...status } = base;
    return {
      ...status,
      embeddingKind: embedding?.kind || null,
      idfTerms: Array.isArray(embedding?.stats?.df) ? embedding.stats.df.length : null,
      dirty: Boolean(marker) || Boolean(status.dirty),
      dirtyReason: marker?.dirtyReason ?? status.dirtyReason ?? null,
      dirtyAt: marker?.dirtyAt ?? status.dirtyAt ?? null,
      /* ملفات خزنة تُتخطّى لخطأ قراءة — تُعلن بدل الابتلاع (عزل لكل ملف). */
      skippedNotes: Array.isArray(cache.skippedNotes) ? cache.skippedNotes.length : 0
    };
  }
  async function rebuildVectorIndex({ force = false } = {}) {
    /* توقيت المراحل دائم (لا خلف راية): بناء الفهرس عملية نادرة ومكلفة، وقياس
       أين يُنفَق الزمن هو ما يمنع التخمين. (عطل مُقاس: 48–141 ثانية لـ820 مقطعاً،
       ولا أحد يعرف أي مرحلة تستهلكها.) */
    const tProf = { start: Date.now() };
    const settings = await readSettings();
    const cfg = getRetrievalConfig(settings);
    const notes = await readNotes();
    tProf.afterNotes = Date.now();
    const signature = retrievalSignature(settings);
    const fingerprint = notesFingerprint(notes);
    const existing = await readVectorIndex();
    const marker = await readVectorDirtyMarker();
    const existingDirty = Boolean(existing && (existing.dirty || marker));
    if (!force && existing && !existingDirty && existing.signature === signature && existing.notesFingerprint === fingerprint) return { index: existing, rebuilt: false };

    const chunkRows = [];
    /* قفل صيانة: البناء يحجب الحلقة الواحدة عشرات الثواني، فيقرأه الحارس «جموداً»
       ويقتل الخادم (206 قتلة مُقاسة). القفل يُبلّغ الحارس أن الخادم حيّ ويَنتج،
       فيتخطّى القتل حتى انتهاء البناء. يُزال في finally دائماً. */
    const maintenanceFile = path.join(dataDir, '.maintenance');
    try { await fsp.writeFile(maintenanceFile, JSON.stringify({ at: nowIso(), reason: 'vector_rebuild', pid: process.pid }), 'utf8'); } catch { /* تحسيني */ }
    try {
    for (const note of notes) {
      const chunks = chunkNote(note, cfg);
      chunks.forEach((text, chunkIndex) => {
        chunkRows.push({
          id: `${note.id}::${chunkIndex}`,
          noteId: note.id,
          title: note.title,
          type: note.classification.primaryType,
          isDocument: note.isDocument,
          documentType: note.documentType,
          text,
          chunkIndex,
          textHash: sha1(text),
          importance: Number(note.fm?.importance) || 0,
          project: note.projectName || '',
          tags: note.fm?.tags || [],
          updatedAt: note.updatedAt,
          linkCount: note.links.length
        });
      });
    }
    tProf.afterChunk = Date.now();
    const embeddings = [];
    // إحصاءات idf تُبنى من نفس نصوص الفهرسة قبل التضمين — التطابق بين بناء
    // الوثائق والاستعلام مضمون بمشاركة نفس الأزواج المخزّنة في الفهرس
    const useLocal = cfg.provider === 'local-ngram';
    const embeddingStats = useLocal ? buildEmbeddingStats(chunkRows.map(r => r.text)) : null;
    tProf.afterStats = Date.now();
    for (let i = 0; i < chunkRows.length; i += cfg.batchSize) {
      const batch = chunkRows.slice(i, i + cfg.batchSize);
      const vecs = await embedTexts(batch.map(x => x.text), settings, embeddingStats);
      if (vecs.length !== batch.length) throw new Error(`Embedding count mismatch: expected ${batch.length}, got ${vecs.length}`);
      embeddings.push(...vecs);
    }
    tProf.afterEmbed = Date.now();
    const entries = chunkRows.map((row, idx) => ({ ...row, embedding: embeddings[idx] }));
    const index = {
      version: 4,
      engine: 'hybrid-memory',
      builtAt: nowIso(),
      provider: cfg.provider,
      model: cfg.model,
      signature,
      notesFingerprint: fingerprint,
      noteCount: notes.length,
      entryCount: entries.length,
      dirty: false,
      rerankStrategy: cfg.rerankStrategy,
      embedding: {
        kind: useLocal ? 'ngram-tfidf' : String(cfg.provider || ''),
        dims: Number(cfg.dimensions) || 256,
        stats: embeddingStats
      },
      entries
    };
    await writeVectorIndex(index);
    await clearVectorDirtyMarker();
    await appendAudit({ type: 'vector_index_rebuilt', entryCount: entries.length, provider: cfg.provider, model: cfg.model });
    const ms = (a, b) => b - a;
    console.log(
      `↻ فهرس الاسترجاع: ملاحظات=${notes.length} مقاطع=${entries.length} · ` +
      `قراءة=${ms(tProf.start, tProf.afterNotes)}ms تقطيع=${ms(tProf.afterNotes, tProf.afterChunk)}ms ` +
      `إحصاء=${ms(tProf.afterChunk, tProf.afterStats)}ms تضمين=${ms(tProf.afterStats, tProf.afterEmbed)}ms ` +
      `كتابة=${ms(tProf.afterEmbed, Date.now())}ms إجمالي=${ms(tProf.start, Date.now())}ms`
    );
    return { index, rebuilt: true };
    } finally {
      /* يُزال القفل دائماً — قفل عالق يجعل الحارس أعمى للأبد. */
      try { await fsp.unlink(maintenanceFile); } catch { /* ذهب */ }
    }
  }
  function recencyBoost(updatedAt) {
    const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 86400000);
    return Math.max(0, 1 - ageDays / 30) * 0.25;
  }
  function noteSimilarityFromEntries(a, b) {
    if (!a || !b) return 0;
    return cosine(a.embedding || [], b.embedding || []);
  }
  function mmrRerank(candidates, limit = 8) {
    const selected = [];
    const pool = [...candidates];
    const lambda = 0.72;
    while (pool.length && selected.length < limit) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        const redundancy = selected.length ? Math.max(...selected.map(s => noteSimilarityFromEntries(cand.bestEntry, s.bestEntry))) : 0;
        const score = lambda * cand.baseScore - (1 - lambda) * redundancy;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      selected.push({ ...pool[bestIdx], rerankScore: bestScore });
      pool.splice(bestIdx, 1);
    }
    return selected;
  }
  /* بناء الفهرس في الخلفية — لا داخل الطلب.
     عطل مُقاس (2026-11-11): كل حفظ وسم الفهرس متسخاً، والبحث التالي كان يستدعي
     rebuildVectorIndex() **داخل الطلب** ⇒ 33.04s لأول بحث بعد أي حفظ (و56,434ms
     مسجّلاً)، فتحجب الحلقة الواحدة ويراها الحارس «جموداً» فيقتل الخادم (206 قتلة
     في data/watchdog.log). القاعدة الآن: البحث يخدم فوراً من الفهرس القائم مع وسم
     stale، والبناء يجري مرة واحدة في الخلفية (debounce + single-flight). */
  let rebuildTimer = null;
  let rebuildRunning = false;
  let lastRebuildAt = 0;
  /* كبح: بناء واحد كل 15 دقيقة كحدّ أقصى. السبب المقاس (2026-11-11): كل حفظ يوسم
     الفهرس متسخاً، والبناء الكامل يكلّف 48–56 ثانية على خزنة 361 ملاحظة، فيحجب
     الحلقة الواحدة. البناء الفوري عند كل حفظ = خادم غير قابل للاستخدام. الفهرس
     يبقى صالحاً (قديم قليلاً) والبحث يخدم منه، والبناء يتقارب خلال ربع ساعة. */
  const REBUILD_MIN_INTERVAL_MS = 15 * 60 * 1000;
  /* إصلاح 2026-11-12 (تجربة مقيسة، أُلغيت): جرّبتُ تشغيل البناء كعملية فرعية تلقائياً
     عند الاتساخ لإغلاق الحلقة. القياس في مجموعة الاختبارات: كل خادم تجريبي يُطلق
     عملية بناء (48–141 ثانية لكل واحدة) فتتزاحم الأقفال وتتجمّد المجموعة (13 دقيقة
     بلا نتيجة مقابل 4:15 قبلها). الاستنتاج: الإطلاق التلقائي من داخل الخادم غير آمن
     على هذه القاعدة، والقرار الأصلي (بناء خارجي) صحيح. الحلّ الصحيح: مهمة مجدولة
     على مستوى النظام تستدعي tools/rebuild-index.cjs — لا كود في مسار الطلب. */
  function scheduleBackgroundRebuild(delayMs = 2000) {
    if (String(process.env.CORTEX_AUTO_REBUILD || '') !== '1') return;
    /* معطّل افتراضياً — بقرار مقاس. البناء الكامل يكلّف 48–141 ثانية على 361
       ملاحظة، والبناء داخل عملية الخادم (ولو «في الخلفية») يحجب الحلقة الواحدة
       فتتجمد كل الطلبات وتقتل الحارس. البديل: البحث يخدم من الفهرس القائم ويُعلن
       stale، والبناء يجري عبر أداة مستقلة (tools/rebuild-index.cjs) أو زر
       «إعادة بناء الفهرس» في الإعدادات — بلا تجميد الخادم.
       CORTEX_AUTO_REBUILD=1 يعيد السلوك القديم لمن يريد. */
    if (String(process.env.CORTEX_AUTO_REBUILD || '') !== '1') return;
    if (rebuildRunning) return;
    if (lastRebuildAt && Date.now() - lastRebuildAt < REBUILD_MIN_INTERVAL_MS) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      rebuildTimer = null;
      if (rebuildRunning) return;
      rebuildRunning = true;
      lastRebuildAt = Date.now();
      const t0 = Date.now();
      try {
        const out = await rebuildVectorIndex({ force: true });
        if (out && out.rebuilt === false) return;
        console.log(`↻ فهرس الاسترجاع (خلفية) في ${Date.now() - t0}ms`);
      } catch (e) {
        console.error('تعذّر بناء فهرس الاسترجاع (خلفية):', e.message);
      } finally { rebuildRunning = false; }
    }, delayMs);
    if (rebuildTimer && typeof rebuildTimer.unref === 'function') rebuildTimer.unref();
  }
  function isIndexStale(index) {
    if (!index) return true;
    if (index.dirty === true) return true;
    return false;
  }
  async function searchWithEmbeddings(query, { limit = null, project = '', activeNoteId = '' } = {}) {
    const q = String(query || '').trim();
    if (!q) return { mode: 'hybrid-memory', results: [], indexStatus: await getRetrievalStatus() };
    const settings = await readSettings();
    const cfg = getRetrievalConfig(settings);
    const effLimit = Math.max(1, Math.min(Number(limit) || Number(cfg.topK) || 8, 50));
    const minSemantic = Number(cfg.minSemantic ?? 0.12);
    const state = await readWorkspaceState();
    /* الفهرس: خَدَم من القائم فوراً، وابنِ في الخلفية إن كان متسخاً. البناء
       المتزامن يبقى فقط عند غياب فهرس صالح (أول تشغيل أو تلف عُوزل) — وإلا فكل
       بحث بعد حفظ يحجب الحلقة ثوانٍ/دقائق ويُستدعى قتل الحارس. */
    let index = await readVectorIndex();
    let indexStale = false;
    if (!index) {
      const r = await rebuildVectorIndex();
      index = r.index;
    } else {
      const marker = await readVectorDirtyMarker().catch(() => null);
      indexStale = Boolean(marker) || isIndexStale(index);
      if (indexStale) scheduleBackgroundRebuild();
    }
    const notes = await readNotes();
    const notesMap = new Map(notes.map(n => [n.id, n]));
    const model = buildBrainModel(notes);
    // استعلام المزود المحلي يستخدم نفس إحصاءات idf المخزّنة في الفهرس —
    // استعلام بلا الإحصاءات يعني متجهات غير متوافقة مع الوثائق (عطل صامت محتمل)
    let queryVec;
    if (cfg.provider === 'local-ngram') {
      queryVec = makeLocalEmbedding(q, index.embedding?.dims || cfg.dimensions || 256, index.embedding?.stats);
    } else {
      queryVec = (await embedTexts([q], settings))[0];
    }
    const candidateLimit = Math.max(effLimit * (cfg.candidateMultiplier || 6), effLimit);
    /* عطلان متقابلان هنا — والقاعدة الفاصلة بينهما:
       - المشروع **المطلوب صراحةً** (وسيط project) = فلتر صلب كما كان.
       - المشروع **النشط** في مساحة العمل = تعزيز لا حجب.
       السبب المقاس (تحقق مستقل C، 2026-10-27): مع activeProject=M41 صار بحث
       «خارطة الحالة الفعلية» يعيد **صفراً** لأن ملاحظات الخزنة بلا مشروع —
       فلتر النشط كان يحجب كل ما لا ينتمي إليه. */
    const explicitFilter = String(project || '').trim();
    /* الهوية تُقارَن بمفتاح دقيق لا بـ includes: m41 لم يعد يطابق m41-demo. */
    const explicitProjectKey = projectKey(explicitFilter);
    const scopeProjectKey = explicitProjectKey || projectKey(state.activeProject);
    const activeId = slugify(activeNoteId || state.activeNoteId || '');
    const scoredEntries = index.entries.map(entry => {
      const note = notesMap.get(entry.noteId);
      const lexical = lexicalScoreForText(entry.text, entry.title, entry.tags, q);
      const semantic = cosine(queryVec, entry.embedding || []);
      const importanceBoost = entry.importance * 0.03;
      const graphBoost = Math.min(0.15, entry.linkCount * 0.02);
      const recentBoost = recencyBoost(entry.updatedAt);
      const projectBoost = scopeProjectKey && projectKey(entry.project) === scopeProjectKey ? 0.24 : 0;
      const activeBoost = entry.noteId === activeId ? 0.28 : 0;
      const documentBoost = entry.isDocument && /مستند|وثيقة|doc|document|spec|file/i.test(q) ? 0.2 : 0;
      const entityBoost = note?.entities?.some(e => q.toLowerCase().includes(e.name.toLowerCase())) ? 0.12 : 0;
      const score = semantic * 0.68 + Math.min(lexical / 20, 0.38) + importanceBoost + graphBoost + recentBoost + projectBoost + activeBoost + documentBoost + entityBoost;
      return { entry, note, score, semantic, lexical, projectBoost };
    }).filter(x => {
      /* المشروع المطلوب صراحةً حاجز صلب: هوية دقيقة على حافة الفهرس أو الملاحظة.
         (كان: `projectBoost > 0 || notesForProject(...)` — أي تطابق جزئي أو ذكر
         الاسم في النص يمرّ، وهو العطل P0). */
      if (explicitProjectKey) {
        const onEntry = projectKey(x.entry.project) === explicitProjectKey;
        const onNote = Boolean(x.note) && projectKey(x.note.projectName) === explicitProjectKey;
        if (!onEntry && !onNote) return false;
      }
      // النشط (غير الصريح) يعزّز فقط — لا يحجب شيئاً
      // بلا دليل: لا تشابه دلالي أدنى ولا تطابق معجمي ⇒ لا يُعرض كنتيجة واثقة
      return x.lexical > 0 || x.semantic >= minSemantic;
    }).sort((a, b) => b.score - a.score).slice(0, candidateLimit);

    /* ── دلتا البحث (إصلاح 2026-11-12) ─────────────────────────────────────
       عطل مقيس في التجربة الحقيقية: ملاحظة تُنشأ للتوّ **لا تُوجد في البحث**
       حتى إعادة بناء يدوية (25 ثانية، وأبداً إن لم تُبنَ). الفهرس صورة لحظة
       builtAt، فكل ما كُتب بعده غائب. الحل بلا كتابة ولا بناء: الملاحظات الأحدث
       من الفهرس تُقيَّم في الذاكرة بنفس المعادلة (معجمياً) وتُدمج في المرشّحين.
       لا يغيّر ترتيب القديم إلا إذا تطابق فعلاً، ولا يكتب شيئاً على القرص. */
    try {
      const builtAtMs = Date.parse(index.builtAt || 0);
      const indexedIds = new Set(index.entries.map(e => e.noteId));
      /* حَدّان إلزاميان (عطل مقيس 2026-11-13: الخادم تجمّد تماماً — الحلقة الواحدة
         محجوبة — لأن الدلتا كانت تُقطّع **كل** ملاحظة متغيّرة بكامل جسمها، وفي
         الخزنة ملاحظة بحجم عشرات الميغابايت من استيراد اختباري. التقطيع المتزامن
         لنص بهذا الحجم يوقف كل الطلبات. الحد: 4000 حرف لكل ملاحظة (كفاية للاسترجاع)
         و64 ملاحظة كحد أقصى. الدلتا تحسين استرجاع لا محرك فهرسة كامل. */
      const DELTA_MAX_NOTES = 64;
      const DELTA_MAX_CHARS = 4000;
      let deltaCount = 0;
      for (const n of notes) {
        if (deltaCount >= DELTA_MAX_NOTES) break;
        if (indexedIds.has(n.id)) continue;
        const fresh = Number.isFinite(builtAtMs) ? Date.parse(n.updatedAt || 0) > builtAtMs : true;
        if (!fresh) continue;
        if (explicitProjectKey) {
          const onNote = projectKey(n.projectName) === explicitProjectKey;
          if (!onNote) continue;
        }
        const text = `${n.title}\n${String(n.body || '').slice(0, DELTA_MAX_CHARS)}`;
        const lexical = lexicalScoreForText(text, n.title, n.fm?.tags || [], q);
        if (!lexical) continue;
        deltaCount += 1;
        const projectBoost = scopeProjectKey && projectKey(n.projectName) === scopeProjectKey ? 0.24 : 0;
        const score = Math.min(lexical / 20, 0.38)
          + (Number(n.fm?.importance) || 0) * 0.03
          + recencyBoost(n.updatedAt)
          + projectBoost
          + (n.id === activeId ? 0.28 : 0);
        scoredEntries.push({
          entry: {
            noteId: n.id, title: n.title, text, tags: n.fm?.tags || [],
            importance: Number(n.fm?.importance) || 0, project: n.projectName,
            updatedAt: n.updatedAt, isDocument: n.isDocument,
            linkCount: (n.links || []).length, delta: true,
          },
          note: n, score, semantic: 0, lexical, projectBoost,
        });
      }
      scoredEntries.sort((a, b) => b.score - a.score);
      if (scoredEntries.length > candidateLimit) scoredEntries.length = candidateLimit;
    } catch { /* الدلتا تحسينية: غيابها يعيد السلوك القديم لا يُسقط البحث */ }

    const byNote = new Map();
    for (const row of scoredEntries) {
      if (row.score < cfg.minScore) continue;
      /* مقطع بلا ملف = الفهرس أقدم من الخزنة (ملاحظة حُذفت ولم يُعَد بناؤه بعد).
         عطل مُقاس حياً 2026-11-15: ملاحظة `trial-بوابة-الدفع` كانت مقطعاً في
         الفهرس وبلا ملف ⇒ `item.note.id` أدناه رمى TypeError فسقط **كل** بحث
         يطابق عنوانها بـ500 (8 استعلامات من 8). المقطع اليتيم يُستبعد، لا يُسقط البحث. */
      if (!row.note) continue;
      const existing = byNote.get(row.entry.noteId) || {
        note: row.note,
        bestEntry: row.entry,
        bestScore: row.score,
        semantic: row.semantic,
        lexical: row.lexical,
        projectBoost: row.projectBoost,
        chunkCount: 0,
        scoreSum: 0,
        snippets: []
      };
      existing.chunkCount += 1;
      existing.scoreSum += row.score;
      existing.snippets.push(snippet(row.entry.text, q, 180));
      if (row.score > existing.bestScore) {
        existing.bestScore = row.score;
        existing.bestEntry = row.entry;
        existing.semantic = row.semantic;
        existing.lexical = row.lexical;
        existing.projectBoost = row.projectBoost;
      }
      byNote.set(row.entry.noteId, existing);
    }
    const aggregated = [...byNote.values()].map(item => ({ ...item, avgScore: item.scoreSum / item.chunkCount, baseScore: item.bestScore + Math.min(0.18, (item.chunkCount - 1) * 0.04) }));
    const reranked = (cfg.rerankStrategy || 'mmr') === 'mmr' ? mmrRerank(aggregated, effLimit) : aggregated.sort((a, b) => b.baseScore - a.baseScore).slice(0, effLimit);
    const results = reranked.slice(0, effLimit).map(item => ({
      id: item.note.id,
      title: item.note.title,
      tags: item.note.fm?.tags || [],
      type: item.note.classification.primaryType,
      project: item.note.projectName || '',
      isDocument: item.note.isDocument,
      documentType: item.note.documentType,
      snippet: item.snippets[0] || snippet(item.note.body, q),
      score: Number(item.baseScore.toFixed(4)),
      semantic: Number(item.semantic.toFixed(4)),
      lexical: item.lexical,
      rerankScore: Number((item.rerankScore ?? item.baseScore).toFixed(4)),
      chunkCount: item.chunkCount
    }));
    /* إصلاح 2026-11-12 (تناقض مقيس): كانت الاستجابة تُرجع indexStale=true و
       indexStatus.dirty=false في الجسم نفسه، لأن الأول يشمل علامة الاتساخ على
       القرص والثاني يقرأ الحقل داخل الفهرس المحمَّل. الآن مصدر واحد: dirty تتبع
       indexStale حرفياً، فلا يمكن أن يتناقضا. */
    return { mode: 'hybrid-memory', provider: cfg.provider, model: cfg.model, rerankStrategy: cfg.rerankStrategy, results, projects: model.projects.slice(0, 10), indexStale, indexStatus: { builtAt: index.builtAt, noteCount: index.noteCount, entryCount: index.entryCount, dirty: Boolean(indexStale) } };
  }
  function hybridSearchSyncFallback(notes, query, limit = 8) {
    const qv = deterministicEmbedding(query, 256);
    return notes.map(note => {
      const lexical = lexicalScoreForText(note.body, note.title, note.fm?.tags || [], query) + (Number(note.fm?.importance) || 0) * 2;
      const semantic = cosine(qv, deterministicEmbedding(`${note.title}\n${note.body}\n${(note.fm?.tags || []).join(' ')}`, 256));
      const graphBoost = Math.min(3, note.links.length * 0.3);
      const score = lexical + semantic * 8 + graphBoost;
      return { note, score, lexical, semantic, graphBoost };
    }).filter(r => r.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function relatedNotes(notes, noteId, limit = 6) {
    const source = notes.find(n => n.id === slugify(noteId));
    if (!source) return [];
    const resolveLink = makeLinkResolver(notes);
    const sourceTags = source.fm?.tags || [];
    const sourceLinks = (source.links || []).map(resolveLink);
    const sourceTokens = new Set(tokenize(source.body));
    return notes.filter(n => n.id !== source.id).map(n => {
      const sharedTags = (n.fm?.tags || []).filter(t => sourceTags.includes(t)).length;
      const sharedLinks = (n.links || []).map(resolveLink).filter(id => sourceLinks.includes(id)).length;
      const tokenOverlap = tokenize(n.body).filter(t => t.length > 3 && sourceTokens.has(t)).length;
      const backlink = (n.links || []).some(l => resolveLink(l) === source.id) ? 5 : 0;
      const score = sharedTags * 4 + sharedLinks * 3 + Math.min(tokenOverlap, 20) + backlink;
      return { note: n, score };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => ({ id: r.note.id, title: r.note.title, score: r.score }));
  }
  function findGaps(notes, project = '', lang = 'ar') {
    const E = lang === 'en';
    const scoped = project ? notesForProject(notes, project) : notes;
    const gaps = [];
    const typed = scoped.reduce((acc, n) => { acc[n.classification.primaryType] = (acc[n.classification.primaryType] || 0) + 1; return acc; }, {});
    if ((typed.project || 0) > 0 && !(typed.decision > 0)) gaps.push({ type: 'missing_decision', severity: 'high', message: E ? 'A project exists without documented decisions.' : 'يوجد مشروع دون قرارات موثقة.' });
    if ((typed.project || 0) > 0 && !(typed.risk > 0)) gaps.push({ type: 'missing_risk', severity: 'medium', message: E ? 'There are no explicit risk notes for the project.' : 'لا توجد ملاحظات مخاطر واضحة للمشروع.' });
    if (scoped.some(n => (n.structured?.tasks || []).some(t => t.status === 'open')) && !(typed.procedure > 0)) gaps.push({ type: 'missing_procedure', severity: 'medium', message: E ? 'There are open tasks without clear procedures or a runbook.' : 'هناك مهام مفتوحة دون إجراءات أو runbook واضح.' });
    const isolated = scoped.filter(n => (Number(n.fm?.importance) || 0) >= 4 && n.links.length === 0);
    for (const note of isolated.slice(0, 4)) gaps.push({ type: 'isolated_high_importance', severity: 'medium', noteId: note.id, message: E ? `The important note ${note.title} is not linked to the rest of the knowledge.` : `الملاحظة المهمة ${note.title} غير مرتبطة بباقي المعرفة.` });
    return gaps;
  }
  function healthScore(notes, project = '') {
    const scoped = project ? notesForProject(notes, project) : notes;
    if (!scoped.length) return 0;
    const linked = scoped.filter(n => n.links.length > 0).length / scoped.length;
    const typed = scoped.filter(n => n.classification.primaryType !== 'note').length / scoped.length;
    const importantLinked = scoped.filter(n => (Number(n.fm?.importance) || 0) >= 3 && n.links.length > 0).length / Math.max(1, scoped.filter(n => (Number(n.fm?.importance) || 0) >= 3).length);
    const gapsPenalty = findGaps(scoped).length * 6;
    return Math.max(0, Math.min(100, Math.round((linked * 35) + (typed * 25) + (importantLinked * 40) - gapsPenalty)));
  }
  function buildNextActions({ projectQuery, openTasks, decisions, risks, questions, gaps, recentDocuments, lang = 'ar' }) {
    const E = lang === 'en';
    const actions = [];
    if (!decisions.length) actions.push({ type: 'document_decision', priority: 'high', text: (E ? `Record the project's first key decision ${projectQuery || ''}` : `وثّق أول قرار رئيسي للمشروع ${projectQuery || ''}`).trim() });
    /* §6/§8 — الاقتراح لا يقتبس نص اقتراح سابق.
       العطل المُثبت حيّاً 2026-10-20: زر «الخطوة التالية» يُرسل نص الاقتراح كهدف، فتُنشأ
       مهمة نصّها «نفّذ أو قسم المهمة: …». ثم يقرأ الاقتراح التالي تلك المهمة كمهمة مفتوحة
       فيقتبسها داخل نصّه، وتتضخّم النصوص: «نفّذ أو قسم المهمة: نفّذ أو قسم المهمة: …»
       (وُجدت فعلاً في قاعدة البيانات 3 مستويات). الإصلاح: نُجرِّد النص من أغلفة الاقتراح
       المتكرّرة قبل الاقتباس، ونمنع الاقتباس إن كان النص كله غلافاً بلا مضمون. */
    const stripActionWrapper = (raw) => {
      const wrappers = [
        /^نفّذ أو قسم المهمة:\s*/i, /^أجب عن السؤال المفتوح:\s*/i,
        /^وثّق أول قرار رئيسي للمشروع\s*/i, /^أنشئ ملاحظة مخاطر أساسية للمشروع\.?\s*/i,
        /^Execute or split the task:\s*/i, /^Answer the open question:\s*/i,
        /^Record the project's first key decision\s*/i, /^Create a baseline risk note for the project\.?\s*/i,
      ];
      let t = String(raw || '').trim();
      let changed = true;
      while (changed) {
        changed = false;
        for (const re of wrappers) {
          const next = t.replace(re, '').trim();
          if (next !== t) { t = next; changed = true; }
        }
      }
      return t;
    };
    const firstOpenText = openTasks.length ? stripActionWrapper(openTasks[0].text) : '';
    if (firstOpenText) actions.push({ type: 'execute_task', priority: 'high', text: (E ? `Execute or split the task: ${firstOpenText}` : `نفّذ أو قسم المهمة: ${firstOpenText}`) });
    if (!risks.length) actions.push({ type: 'identify_risks', priority: 'medium', text: E ? 'Create a baseline risk note for the project.' : 'أنشئ ملاحظة مخاطر أساسية للمشروع.' });
    if (questions.length) actions.push({ type: 'resolve_question', priority: 'medium', text: (E ? `Answer the open question: ${questions[0].text}` : `أجب عن السؤال المفتوح: ${questions[0].text}`) });
    if (gaps.length) actions.push({ type: 'close_gap', priority: gaps[0].severity === 'high' ? 'high' : 'medium', text: gaps[0].message });
    if (recentDocuments.length) actions.push({ type: 'review_recent_doc', priority: 'low', text: (E ? `Review the latest document: ${recentDocuments[0].title}` : `راجع آخر مستند: ${recentDocuments[0].title}`) });
    return actions.slice(0, 6);
  }
  async function synthesizeProjectState(projectQuery, lang = 'ar') {
    const E = lang === 'en';
    const notes = await readNotes();
    const scoped = notesForProject(notes, projectQuery);
    const decisions = scoped.flatMap(n => (n.structured?.decisions || []).map(x => ({ ...x, noteId: n.id, noteTitle: n.title })));
    const risks = scoped.flatMap(n => (n.structured?.risks || []).map(x => ({ ...x, noteId: n.id, noteTitle: n.title })));
    const questions = scoped.flatMap(n => (n.structured?.questions || []).map(x => ({ ...x, noteId: n.id, noteTitle: n.title })));
    const tasks = scoped.flatMap(n => (n.structured?.tasks || []).map(x => ({ ...x, noteId: n.id, noteTitle: n.title })));
    const openTasks = tasks.filter(t => t.status === 'open');
    const important = [...scoped].sort((a, b) => (Number(b.fm?.importance) || 0) - (Number(a.fm?.importance) || 0)).slice(0, 5);
    const recent = [...scoped].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
    const recentDocuments = recent.filter(n => n.isDocument);
    const gaps = findGaps(notes, projectQuery, lang);
    const EN = String(lang || '').toLowerCase().startsWith('en');
    const summaryLines = EN
      ? [`Project: ${projectQuery || 'workspace'}`, `Knowledge items: ${scoped.length}`, `Documents: ${recentDocuments.length}`, `Open tasks: ${openTasks.length}`, `Decisions: ${decisions.length}`, `Risks: ${risks.length}`, `Open questions: ${questions.length}`]
      : [`المشروع: ${projectQuery || 'كل المساحة'}`, `عناصر المعرفة: ${scoped.length}`, `الوثائق: ${recentDocuments.length}`, `المهام المفتوحة: ${openTasks.length}`, `القرارات: ${decisions.length}`, `المخاطر: ${risks.length}`, `الأسئلة المفتوحة: ${questions.length}`];
    if (important.length) summaryLines.push(EN ? `Most important: ${important.map(n => n.title).join(', ')}` : `الأهم: ${important.map(n => n.title).join('، ')}`);
    const nextActions = buildNextActions({ projectQuery, openTasks, decisions, risks, questions, gaps, recentDocuments, lang });
    return { project: projectQuery || 'workspace', noteCount: scoped.length, healthScore: healthScore(notes, projectQuery), summary: summaryLines.join('\n'), important: important.map(n => ({ id: n.id, title: n.title, importance: Number(n.fm?.importance) || 0, type: n.classification.primaryType })), recent: recent.map(n => ({ id: n.id, title: n.title, updatedAt: n.updatedAt, type: n.classification.primaryType, isDocument: n.isDocument })), recentDocuments: recentDocuments.map(n => ({ id: n.id, title: n.title, documentType: n.documentType })), openTasks, decisions, risks, questions, gaps, nextActions };
  }
  /* عطل مقيس 2026-11-12 (انهيار خادم كامل): `E` استُعمل في هذا التابع بلا تعريف
     — بقية التوابع تُعرّفه من `lang`. فكان **كل** نداء لـ/api/review/:id يقتل
     العملية بـReferenceError. أُعيد التعريف من لغة الطلب. */
  async function buildReview(noteId, lang = i18n.lang()) {
    const E = lang === 'en';
    const notes = await readNotes();
    const note = notes.find(n => n.id === slugify(noteId));
    if (!note) return null;
    const contradictions = detectContradictions(note, notes);
    const related = relatedNotes(notes, note.id, 8);
    const gaps = [];
    if (!note.links.length && (Number(note.fm?.importance) || 0) >= 3) gaps.push(E ? 'Important note with no links.' : 'الملاحظة مهمة لكن بلا روابط.');
    if (!(note.structured?.decisions || []).length && /decide|قرار|سنعتمد|adopt/i.test(note.body)) gaps.push(E ? 'It looks like it has an unorganized decision — needs a clear Decision block.' : 'يبدو أن بها قرارًا غير منظم في صياغة Decision واضحة.');
    if (!(note.structured?.tasks || []).length && /todo|مهمة|next step|الخطوة التالية/i.test(note.body)) gaps.push(E ? 'Some tasks may not be extracted into a structured format.' : 'يحتمل وجود مهام غير مستخرجة بصيغة منظمة.');
    return { note: { id: note.id, title: note.title }, classification: note.classification, structured: note.structured, contradictions, related, gaps, suggestedActions: [note.classification.primaryType === 'note' ? E ? 'Turn the note into a clearer type if it is a decision, risk, or document.' : 'حوّل الملاحظة إلى نوع أوضح إذا كانت قرارًا أو خطرًا أو مستندًا.' : null, contradictions.length ? E ? 'Review contradictions and record the final decision in one note.' : 'راجع التناقضات وأثبت القرار النهائي في ملاحظة واحدة.' : null, !note.links.length ? E ? 'Add [[wiki links]] to related notes.' : 'أضف روابط [[wiki links]] للملاحظات المرتبطة.' : null].filter(Boolean) };
  }
  async function createSession({ goal = '', mode = 'project', project = '', source = 'ui' } = {}) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const session = { id, goal, mode, project, source, createdAt: nowIso(), updatedAt: nowIso(), messages: [] };
    await fsp.writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2), 'utf8');
    await appendAudit({ type: 'session_started', sessionId: id, mode, project, goal });
    if (project) await recordActivity({ project });
    return session;
  }
  async function readSession(id) {
    const file = path.join(sessionsDir, `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, 'utf8')) : null;
  }
  async function appendSessionMessage(id, message) {
    const session = await readSession(id);
    if (!session) throw new Error(i18n.T('الجلسة غير موجودة', 'Session not found'));
    session.messages.push({ time: nowIso(), ...message });
    session.updatedAt = nowIso();
    await fsp.writeFile(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2), 'utf8');
    return session;
  }
  async function listSessions(limit = 20) {
    const files = (await fsp.readdir(sessionsDir)).filter(f => f.endsWith('.json'));
    const rows = [];
    for (const f of files) {
      const s = JSON.parse(await fsp.readFile(path.join(sessionsDir, f), 'utf8'));
      // معاينة آخر رسالة وعداد — ليست كل الجلسات أسطراً ميتة بلا سياق (قرار دورة الأدوار)
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      const last = msgs[msgs.length - 1] || null;
      rows.push({
        ...s,
        messageCount: msgs.length,
        lastPreview: last ? String(last.content || last.text || '').slice(0, 120) : '',
        lastRole: last ? (last.role || 'user') : null,
      });
    }
    return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
  }
  function detectReferenceIntent(query) {
    const q = String(query || '').toLowerCase();
    if (/مستند|وثيقة|document|doc|file|spec|design/.test(q)) return 'document';
    if (/مشروع|project/.test(q)) return 'project';
    if (/مهمة|task|todo/.test(q)) return 'task';
    return 'note';
  }
  async function resolveReference(query, opts = {}) {
    const notes = await readNotes();
    const state = await readWorkspaceState();
    const q = String(query || '').trim();
    const activeNoteId = slugify(opts.activeNoteId || state.activeNoteId || '');
    const activeProject = String(opts.activeProject || state.activeProject || '').trim();
    const preferType = opts.preferType || detectReferenceIntent(q);
    const genericDocument = !q || /^(هذا|هذه|ذلك|المستند|الوثيقة|الملف|last doc|latest doc|آخر مستند|آخر وثيقة|doc)$/i.test(q.toLowerCase());
    const genericProject = /^(المشروع|project|مشروعنا|current project)$/i.test(q.toLowerCase());
    const recentDocSet = new Map((state.recentDocumentIds || []).map((id, idx) => [id, Math.max(0, 10 - idx)]));
    const recentNoteSet = new Map((state.recentNoteIds || []).map((id, idx) => [id, Math.max(0, 8 - idx)]));
    const tokens = tokenize(q);

    const candidates = notes.map(note => {
      let score = 0;
      const reasons = [];
      const reasonCodes = [];
      const why = (code) => { const r = REASONS[code]; if (r) { reasons.push(i18n.T(r[0], r[1])); reasonCodes.push(code); } };
      if (note.id === activeNoteId) { score += 8; why('open_now'); }
      if (activeProject && note.projectName && slugify(note.projectName) === slugify(activeProject)) { score += 9; why('active_project'); }
      if (recentDocSet.has(note.id)) { score += recentDocSet.get(note.id); why('recent_doc'); }
      if (recentNoteSet.has(note.id)) score += recentNoteSet.get(note.id);
      if (preferType === 'document' && note.isDocument) { score += 7; why('is_document'); }
      if (preferType === 'project' && note.classification.primaryType === 'project') { score += 7; why('is_project'); }
      if (preferType === 'task' && note.classification.primaryType === 'task') { score += 7; why('is_task'); }
      if (q) {
        if (note.title.toLowerCase() === q.toLowerCase() || note.id === slugify(q)) { score += 20; why('exact_title'); }
        if (note.projectName && note.projectName.toLowerCase() === q.toLowerCase()) { score += 18; why('project_name'); }
        const lexical = lexicalScoreForText(note.body, note.title, note.fm?.tags || [], q);
        if (lexical) { score += Math.min(lexical, 14); why('lexical'); }
        if (note.entities.some(e => tokens.some(t => e.name.toLowerCase().includes(t)))) { score += 6; why('entity'); }
      }
      if (genericDocument && note.isDocument) { score += 10; why('generic_doc'); }
      if (genericProject && note.classification.primaryType === 'project') { score += 10; why('generic_project'); }
      if (/آخر|latest|recent/.test(q.toLowerCase())) score += recencyBoost(note.updatedAt) * 20;
      return { note, score, reasons: unique(reasons), reasonCodes: unique(reasonCodes) };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt));

    const best = candidates[0] || null;
    const response = {
      query: q,
      preferType,
      activeProject,
      activeNoteId,
      resolved: best ? {
        id: best.note.id,
        title: best.note.title,
        type: best.note.classification.primaryType,
        project: best.note.projectName || '',
        isDocument: best.note.isDocument,
        documentType: best.note.documentType,
        score: best.score,
        reasons: best.reasons,
        reasonCodes: best.reasonCodes
      } : null,
      alternatives: candidates.slice(1, 5).map(c => ({ id: c.note.id, title: c.note.title, type: c.note.classification.primaryType, project: c.note.projectName || '', score: c.score }))
    };
    await recordActivity({ resolved: response.resolved });
    return response;
  }
  async function buildContextPacket(query, opts = {}) {
    const resolved = await resolveReference(query, opts);
    const project = opts.project || resolved.resolved?.project || (await readWorkspaceState()).activeProject || '';
    const search = await searchWithEmbeddings(query || resolved.resolved?.title || project, { limit: 6, project, activeNoteId: opts.activeNoteId });
    const notes = await readNotes();
    const contextNotes = search.results.map(r => notes.find(n => n.id === r.id)).filter(Boolean);
    return { resolved, search, contextNotes };
  }
  async function nextBestAction({ project = '', noteId = '', question = '', lang = 'ar' } = {}) {
    const E = lang === 'en';
    const notes = await readNotes();
    const note = noteId ? notes.find(n => n.id === slugify(noteId)) : null;
    const state = await synthesizeProjectState(project || note?.projectName || '', lang);
    const base = state.nextActions[0] || { text: E ? 'Write a state note or record the next decision.' : 'أنشئ ملاحظة حالة أو وثّق القرار التالي.', priority: 'medium', type: 'create_state' };
    const reason = [];
    if (state.gaps.length) reason.push(state.gaps[0].message);
    if (state.openTasks.length) reason.push(E ? `There are ${state.openTasks.length} open task(s).` : `هناك ${state.openTasks.length} مهمة مفتوحة.`);
    if (note && !note.links.length) reason.push(E ? 'The current item is not linked enough.' : 'العنصر الحالي غير مربوط بما يكفي.');
    if (question) reason.push(E ? `User question: ${question}` : `سؤال المستخدم: ${question}`);
    return { ...base, reason: reason.join(' '), project: state.project, healthScore: state.healthScore };
  }
  async function updateLivingNote(project) {
    const state = await synthesizeProjectState(project);
    const id = slugify(`living-note-${state.project}`);
    const md = [
      `# Living Note — ${state.project}`,
      '',
      '## Summary', state.summary, '',
      '## Recent Documents', ...(state.recentDocuments.length ? state.recentDocuments.map(d => `- ${d.title} (${d.documentType})`) : ['- لا يوجد']), '',
      '## Next Actions', ...state.nextActions.map(a => `- [ ] ${a.text}`), '',
      '## Risks', ...(state.risks.length ? state.risks.map(r => `- ${r.text}`) : ['- No explicit risks documented.']), '',
      '## Decisions', ...(state.decisions.length ? state.decisions.map(d => `- ${d.text}`) : ['- No explicit decisions documented.']), '',
      '## Open Questions', ...(state.questions.length ? state.questions.map(q => `- ${q.text}`) : ['- No open questions documented.'])
    ].join('\n');
    const note = await saveNote({ id, title: `Living Note — ${state.project}`, content: md, type: 'living_note', documentType: 'plan', tags: ['living-note', slugify(state.project)], project: state.project, importance: 5, source: 'cortex-agent' });
    return { livingNoteId: note.id, livingNoteTitle: note.title, state };
  }
  /* مراجعة المخزن تُحسب مرة لكل مفتاح ملاحظات — لا في كل طلب حالة (كانت 16.7ث). */
  let reviewCache = { key: '', value: null };
  async function reviewWorkspace() {
    const notes = await readNotes();
    if (reviewCache.key && reviewCache.key === cache.notesKey && reviewCache.value) return reviewCache.value;
    const contradictions = [];
    const reviewSlice = notes.slice(0, 40);
    for (let ri = 0; ri < reviewSlice.length; ri++) {
      const note = reviewSlice[ri];
      /* كل 8 ملاحظات نُسلّم دورة الحدث: نبضة طويلة لا تُجوّع الواجهة */
      if (ri && ri % 8 === 0) await new Promise((r) => setImmediate(r));
      const found = detectContradictions(note, notes);
      if (found.length) contradictions.push({ noteId: note.id, noteTitle: note.title, count: found.length, items: found.slice(0, 2) });
    }
    const model = buildBrainModel(notes);
    const __review = { noteCount: notes.length, documentCount: model.documents.length, projectCount: model.projects.length, healthScore: healthScore(notes), gaps: findGaps(notes, '', i18n.lang()), contradictions: contradictions.slice(0, 8), topImportantIsolated: notes.filter(n => (Number(n.fm?.importance) || 0) >= 4 && n.links.length === 0).slice(0, 6).map(n => ({ id: n.id, title: n.title })), typedCounts: notes.reduce((acc, n) => { acc[n.classification.primaryType] = (acc[n.classification.primaryType] || 0) + 1; return acc; }, {}) };
    reviewCache = { key: cache.notesKey, value: __review };
    return __review;
  }
  async function getDashboardData() {
    const notes = await readNotes();
    const state = await readWorkspaceState();
    const retrieval = await getRetrievalStatus();
    const model = buildBrainModel(notes);
    const activeNote = state.activeNoteId ? notes.find(n => n.id === state.activeNoteId) : null;
    const activeProjectName = state.activeProject || activeNote?.projectName || '';
    const activeProject = activeProjectName ? await synthesizeProjectState(activeProjectName) : null;
    const recentNotes = (state.recentNoteIds || []).map(id => notes.find(n => n.id === id)).filter(Boolean).slice(0, 6).map(n => ({ id: n.id, title: n.title, type: n.classification.primaryType, project: n.projectName || '', updatedAt: n.updatedAt }));
    const recentDocuments = (state.recentDocumentIds || []).map(id => notes.find(n => n.id === id)).filter(Boolean).slice(0, 6).map(n => ({ id: n.id, title: n.title, documentType: n.documentType, project: n.projectName || '', updatedAt: n.updatedAt }));
    return {
      workspace: {
        noteCount: notes.length,
        documentCount: model.documents.length,
        projectCount: model.projects.length,
        entityCount: model.entities.length,
        healthScore: healthScore(notes)
      },
      active: {
        note: activeNote ? { id: activeNote.id, title: activeNote.title, type: activeNote.classification.primaryType, project: activeNote.projectName || '', documentType: activeNote.documentType } : null,
        project: activeProject,
        state
      },
      retrieval: { provider: retrieval.provider, model: retrieval.model, entryCount: retrieval.entryCount, dirty: retrieval.dirty, builtAt: retrieval.builtAt },
      projects: model.projects.slice(0, 20),
      recentNotes,
      recentDocuments,
      topEntities: model.entities.slice(0, 12)
    };
  }
  // مزامنة مرآة SQLite من vault، ولقطات صحة لكل مشروع (يتغير المحتوى فقط)
  let storeSyncTimer = null;
  async function syncStore(immediate = false) {
    if (!store) return { ok: false, reason: 'sqlite unavailable' };
    const run = async () => {
      const notes = await readNotes();
      const resolveLink = makeLinkResolver(notes);
      const rows = { notes: [], tasks: [], links: [] };
      for (const n of notes) {
        rows.notes.push({ id: n.id, title: n.title, type: n.classification.primaryType, docType: n.documentType, project: n.projectName || '', importance: Number(n.fm?.importance) || 0, linksCount: n.links.length, createdAt: n.createdAt, updatedAt: n.updatedAt, fingerprint: n.fingerprint || null });
        (n.structured?.tasks || []).forEach((t, i) => rows.tasks.push({ id: `${n.id}#${i}`, noteId: n.id, project: n.projectName || '', text: t.text, status: t.status || 'open', owner: t.owner || null, due: t.due || null, updatedAt: n.updatedAt }));
        for (const l of n.links) rows.links.push({ source: n.id, target: resolveLink(l), kind: 'wikilink' });
      }
      const result = store.sync(rows);
      for (const p of unique(notes.map(n => n.projectName).filter(Boolean))) {
        store.recordHealth(p, healthScore(notes, p), notesForProject(notes, p).length, nowIso());
      }
      await syncEntitiesFromNotes(notes, resolveLink);
      return result;
    };
    if (immediate) return run();
    clearTimeout(storeSyncTimer);
    storeSyncTimer = setTimeout(() => { run().catch(() => {}); }, 800);
    return { ok: true, scheduled: true };
  }

  /* ── م5: مرآة الكيانات — كل نوع في جدوله من الواقع لا من الادعاء ──
     تُشتق من نموذج الملاحظات نفسه عند كل مزامنة: مشاريع/مهام/قرارات/معرفة/ملفات
     أصلية + أعمدة kind وknowledge_kind + علاقات بمصدر ووقت وثقة (م7).
     الجداول المشتقة تُعاد بناؤها (task_entities) — تاريخها الحقيقي في مكانها
     (document_versions/agent_events)، والجداول التراكمية upsert فقط. */
  function entityKindOf(n) {
    const t = n.classification.primaryType;
    if (t === 'doc' || t === 'document') return 'document';
    if (t === 'project' || t === 'decision' || t === 'task') return t;
    return 'note';
  }
  function knowledgeKindOf(n) {
    const fm = n.fm || {};
    const declared = String(fm.knowledge_kind || '');
    if (['imported', 'decided', 'inferred', 'hypothesis'].includes(declared)) return declared;
    if (fm.source || fm.url) return 'imported';
    if (n.classification.primaryType === 'decision') return 'decided';
    return null;
  }
  async function syncEntitiesFromNotes(notes, resolveLink) {
    const { DatabaseSync } = require('node:sqlite');
    let db = null;
    try {
      db = new DatabaseSync(store.dbFile);
      db.exec('PRAGMA busy_timeout=6000');
      const now = nowIso();
      // 1) المشاريع — كيان لكل مشروع فعلي في الخزنة
      for (const p of unique(notes.map(n => n.projectName).filter(Boolean))) {
        db.prepare("INSERT INTO project_entities(id, state, created_at) VALUES (?, 'active', ?) ON CONFLICT(id) DO NOTHING")
          .run(slugify(p), now);
      }
      // 2) أعمدة النوع على الملاحظات نفسها
      const upNote = db.prepare('UPDATE notes SET kind=?, knowledge_kind=? WHERE id=?');
      for (const n of notes) upNote.run(entityKindOf(n), knowledgeKindOf(n), n.id);
      // 3) المهام — مرآة مشتقة تُعاد كاملة
      db.exec('DELETE FROM task_entities');
      const insTask = db.prepare("INSERT OR REPLACE INTO task_entities(id, plan, status, assignee, due, resumable) VALUES (?,?,?,?,?,1)");
      let taskCount = 0;
      for (const n of notes) (n.structured?.tasks || []).forEach((t, i) => {
        insTask.run(`${n.id}#${i}`, t.text, (t.status === 'done' || t.status === 'x') ? 'done' : 'open', t.owner || null, t.due || null);
        taskCount++;
      });
      // 4) القرارات — ملاحظات نوع decision
      const insDecision = db.prepare("INSERT INTO decision_entities(id, rationale, decided_at, status) VALUES (?,?,?,'active') ON CONFLICT(id) DO UPDATE SET rationale=excluded.rationale");
      let decisionCount = 0;
      for (const n of notes.filter(x => x.classification.primaryType === 'decision')) {
        insDecision.run(n.id, n.body.slice(0, 400), n.createdAt);
        decisionCount++;
      }
      // 5) المعرفة الموثقة النوع — لا ترقية استنتاج إلى دليل (م6)
      const insKnow = db.prepare("INSERT INTO knowledge_entities(id, kind, concept, statement, source, confidence) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, statement=excluded.statement, source=excluded.source");
      const CONFIDENCE = { imported: 0.8, decided: 1.0, inferred: 0.5, hypothesis: 0.0 };
      let knowCount = 0;
      for (const n of notes) {
        const kk = knowledgeKindOf(n);
        if (!kk) continue;
        insKnow.run(n.id, kk, n.title, n.body.slice(0, 300), n.fm?.source || n.fm?.url || null, CONFIDENCE[kk]);
        knowCount++;
      }
      // 6) الملفات الأصلية المستوردة — تحقق وجود وسلامة بالقراءة الفعلية
      const docs = db.prepare("SELECT id, fingerprint, original_path, source FROM document_entities WHERE original_path IS NOT NULL").all();
      const insFile = db.prepare("INSERT INTO file_entities(id, path, size, hash, source, integrity_ok, last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET size=excluded.size, integrity_ok=excluded.integrity_ok, last_seen=excluded.last_seen");
      for (const d of docs) {
        let size = null, exists = 0;
        try { size = fs.statSync(d.original_path).size; exists = 1; } catch { exists = 0; }
        insFile.run(d.fingerprint || d.id, d.original_path, size, d.fingerprint || null, d.source || null, exists, now);
      }
      // 7) علاقات بمصدر ووقت وثقة (م7): wikilinks تُوقَّع، والقرار ينتسب لمشروع له ملاحظة
      const upLink = db.prepare("INSERT OR REPLACE INTO note_links(source, target, kind, origin, confidence, extracted_at) VALUES (?,?,?,?,?,?)");
      for (const n of notes) for (const l of n.links) {
        const target = resolveLink(l);
        if (!target) continue;
        upLink.run(n.id, target, 'wikilink', 'wikilink:auto', 1.0, now);
      }
      const byTitle = new Map(notes.map(n => [n.title.toLowerCase(), n.id]));
      for (const n of notes) {
        if (knowledgeKindOf(n) !== 'decided' || !n.projectName) continue;
        const projNoteId = byTitle.get(String(n.projectName).toLowerCase());
        if (!projNoteId || projNoteId === n.id) continue;
        upLink.run(n.id, projNoteId, 'belongs_to', 'decision_project', 0.9, now);
      }
      return { ok: true, tasks: taskCount, decisions: decisionCount, knowledge: knowCount, files: docs.length };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally { try { db && db.close(); } catch { /* مقفل */ } }
  }
  async function syncEntities(immediate = false) {
    if (!store) return { ok: false, reason: 'sqlite unavailable' };
    if (immediate) {
      const notes = await readNotes();
      return syncEntitiesFromNotes(notes, makeLinkResolver(notes));
    }
    return syncStore(false).then(() => ({ ok: true, scheduled: true }));
  }
  function listTasks(filter = {}) { return store ? store.listTasks(filter) : []; }
  function healthHistory(filter = {}) { return store ? store.healthHistory(filter) : []; }

  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }
  function dosStamp(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
    const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, day };
  }
  // كاتب ZIP بطريقة store (بلا ضغط) لتجنّب الاعتماد على أداة zip الخارجية
  function buildZip(entries) {
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
      const crc = crc32(data);
      const { time, day } = dosStamp(entry.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      parts.push(local, nameBuf, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(day, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, centralBuf, eocd]);
  }
  /* ── قراءة نسخة (2026-11-15) ────────────────────────────────────────────────
     كاتب الـzip في هذا الملف يخزّن بلا ضغط (method 0)، فالقارئ يحتاج تتبّع
     الفهارس المركزية فقط. لا نستخدم مكتبة خارجية: لا اعتماديات جديدة. */
  function readZipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('الملف ليس zip صالحاً');
    const count = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
      const method = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localOff = buf.readUInt32LE(ptr + 42);
      const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lnameLen + lextraLen;
      out.push({ name, method, data: buf.slice(dataStart, dataStart + compSize) });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function listBackups() {
    let files = [];
    try { files = (await fsp.readdir(backupsDir)).filter((f) => f.toLowerCase().endsWith('.zip')); } catch { return []; }
    const items = [];
    for (const name of files.sort().reverse()) {
      try {
        const st = await fsp.stat(path.join(backupsDir, name));
        items.push({ name, size: st.size, at: st.mtime.toISOString() });
      } catch { /* اختفت بين القراءة والإحصاء */ }
    }
    return items;
  }

  /* استعادة حقيقية: نسخة أمان أولاً، ثم كتابة الملفات، ثم إعادة بناء الفهرس.
     قاعدة البيانات الحيّة تُتخطّى عن قصد — الكتابة فوقها والخادم يعمل تُنتج
     تلفاً. الملاحظات ملفات، فالفهرس يُبنى منها بعد الاستعادة بلا فقد. */
  async function restoreBackup(name) {
    const safe = path.basename(String(name || ''));
    const file = path.join(backupsDir, safe);
    if (!safe.toLowerCase().endsWith('.zip') || !fs.existsSync(file)) return { ok: false, error: 'النسخة غير موجودة' };
    const safety = await createBackup().catch(() => null);
    const buf = await fsp.readFile(file);
    let entries = [];
    try { entries = readZipEntries(buf); } catch (e) { return { ok: false, error: e.message }; }
    let written = 0;
    let skipped = 0;
    let dbSkipped = false;
    for (const e of entries) {
      const rel = String(e.name || '').replace(/\\/g, '/');
      if (!rel || rel.includes('..') || rel.startsWith('/')) { skipped += 1; continue; }
      if (rel === 'data/cortex.db') { dbSkipped = true; skipped += 1; continue; }
      if (e.method !== 0) { skipped += 1; continue; }
      const abs = path.join(root, ...rel.split('/'));
      if (!abs.startsWith(root + path.sep)) { skipped += 1; continue; }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, e.data);
      written += 1;
    }
    invalidateCache();
    await appendAudit({ type: 'backup_restored', name: safe, written, skipped, dbSkipped, safety: safety && safety.fileName }).catch(() => {});
    return { ok: true, written, skipped, dbSkipped, safety: safety && safety.fileName, entries: entries.length };
  }

  async function createBackup() {
    const fileName = `cortex-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const out = path.join(backupsDir, fileName);
    const entries = [];
    const addFile = async rel => {
      const abs = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(abs)) return;
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return;
      entries.push({ name: rel, data: await fsp.readFile(abs), mtime: stat.mtime });
    };
    const addDir = async rel => {
      const abs = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(abs)) return;
      const children = await fsp.readdir(abs, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const next = `${rel}/${child.name}`;
        if (child.isDirectory()) await addDir(next);
        else await addFile(next);
      }
    };
    await addDir('vault');
    for (const rel of ['data/settings.json', 'data/workspace-state.json', 'data/vector-index.json']) await addFile(rel);
    for (const rel of ['data/sessions', 'data/history']) await addDir(rel);
    /* عطل مُقاس 2026-11-11: الأصول المُستوردة (بايتات المستند الأصلي) كانت خارج
       النسخة، و`document_entities.asset_path` يشير إليها ⇒ الاستعادة تُعيد صفوفاً
       لملفات غير موجودة، وهي «الأصل الذي يُثبت أن ما استُورد حُفظ». */
    await addDir('data/assets');

    // §24/§38 — العطل الأصلي: النسخة كانت تحوي **ملفات فقط** و0 صف من
    // `data/cortex.db`، أي تُفقد المعرفة (notes) والمهام (agent_tasks) والتدقيق
    // (audit_log) واللقطات (change_snapshots) والبصمات — وكلها المنتج نفسه.
    // نسخة تُنقذ الملفات وتُفقد الذاكرة = نسخة كاذبة. الإصلاح: القاعدة تُضمَّن
    // عبر `VACUUM INTO` لأنها تنسخ **قاعدة متسقة ذرّياً** لا ملفاً حيّاً نصف مكتوب
    // (نسخ الملف أثناء الكتابة يُنتج قاعدة تالفة تُفشل الاسترجاع لاحقاً بصمت).
    let dbIncluded = false;
    try {
      const liveDb = path.join(dataDir, 'cortex.db');
      if (fs.existsSync(liveDb)) {
        const tmpDb = path.join(os.tmpdir(), `cortex-backup-db-${Date.now()}-${process.pid}.sqlite`);
        const { DatabaseSync } = require('node:sqlite');
        const snapDb = new DatabaseSync(liveDb);
        try {
          snapDb.prepare('VACUUM INTO ?').run(tmpDb);
        } finally {
          try { snapDb.close(); } catch { /* إغلاق متكرر مقبول */ }
        }
        entries.push({ name: 'data/cortex.db', data: await fsp.readFile(tmpDb), mtime: new Date() });
        await fsp.rm(tmpDb, { force: true });
        dbIncluded = true;
      }
    } catch (err) {
      // النسخة لا تُعلن نجاحاً ناقصاً: غياب القاعدة يُسجَّل صراحةً في التدقيق
      await appendAudit({ type: 'backup_db_failed', error: String((err && err.message) || err) });
    }

    if (!entries.length) throw new Error('لا يوجد محتوى للنسخ الاحتياطي');
    await fsp.writeFile(out, buildZip(entries));
    await appendAudit({ type: 'backup_created', fileName, entryCount: entries.length, dbIncluded });
    return { fileName, path: out, dbIncluded, entryCount: entries.length };
  }

  return {
    store, // واجهة الطبقة 2 (SQLite) — تُستعمل في الاستئناف وبوابات §36
    root, projectRoot, vaultDir, dataDir, settingsFile, historyDir, sessionsDir, backupsDir, auditFile, vectorIndexFile, vectorDirtyFile, workspaceStateFile, WRITE_TOOLS,
    wasSelfWrite: () => Date.now() - selfWriteAt < 1500,
    agentPaused, agentWritesToday, pausedFile,
    nowIso, sha1, slugify, tokenize, parseFrontmatter, buildFrontmatter, extractTitle, extractWikiLinks,
    deterministicEmbedding, cosine, normalizeVector, snippet, classifyText, classifyNote, extractStructuredInfo, extractEntities, buildBrainModel,
    ensureBaseFiles, readSettings, saveSettings, appendAudit, verifyAuditChain, readNotes, saveNote, deleteNote, syncEntities,
    listHistory, readHistoryEntry, resolveLinkTarget, notesForProject, hybridSearchSyncFallback, relatedNotes, detectContradictions,
    findGaps, healthScore, synthesizeProjectState, buildReview, createSession, readSession,
    appendSessionMessage, listSessions, nextBestAction, updateLivingNote, reviewWorkspace, getDashboardData,
    createBackup, listBackups, restoreBackup, invalidateCache, getRetrievalConfig, embedTexts, rebuildVectorIndex, searchWithEmbeddings, getRetrievalStatus, markVectorIndexDirty, validatePublicHttpUrl, guardOutboundUrl, isBlockedIp,
    readWorkspaceState, writeWorkspaceState, recordActivity, resolveReference, buildContextPacket, isDocumentType, getDocumentType, stripWikiLinks,
    readRelations, addRelation, removeRelation, getRelationsForNote,
    store, syncStore, listTasks, healthHistory
  };
}

module.exports = { createCore };
