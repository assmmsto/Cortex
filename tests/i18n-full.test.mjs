/**
 * تدقيق i18n شامل عبر مسارات API — قياس فعلي بـ ?lang=en / ?lang=ar على خادم حي.
 *
 * ⚠ هذا الملف **تشخيصي**: لا يصلح أي عطل، بل يقيس ويثبت الفجوة بمخرج حقيقي.
 * اختبارات `LEAK` تفشل عن قصد ما دام التسريب قائماً؛ رسالة الفشل تسرد كل تسريب
 * (مسار JSON + النص + موضع المصدر ملف:سطر). الاختبارات ١–٧ تقيس العقد المطلوب
 * وتبقى حرّاساً بعد أي إصلاح مستقبلي.
 *
 * ── كيف تُحسم اللغة (server.js resolveAgentLang) ──────────────────────────
 *   GET  : ?lang=  >  settings.agent.language  >  'ar'
 *   POST : body.lang  >  settings.agent.language  >  'ar'   ← ?lang= في مسار POST مُهمَل تماماً
 *   settings.lang : يُحفظ ويُعاد في /api/settings، ولا يقرأه أي مولد نص (مفتاح ميت).
 *   settings.agent.language : **غير موجود افتراضياً** (المُخزَّن هو settings.lang='ar')،
 *   ويُزرَع فقط عند POST /api/settings {agent:{language}}. لا /api/lang ولا /api/language ولا /api/i18n (404).
 *
 * ── سجل التسريبات المؤكدة حياً (الأرقام مُتحقَّق منها بـ grep -n على الملف الحالي) ──
 *  [أ] عربية في وضع en:
 *    1. GET  /api/session                       hint              server.js:898
 *    2. GET  /api/status                        model "(لا يوجد)"  server.js:906
 *    3. GET  /api/notes/:id 404                 error             server.js:937
 *       GET  /api/review/:id 404                error             server.js:1026
 *       GET  /api/agent/session/:id 404         error             server.js:1117
 *    4. GET  /api/agent/tasks?runId=            error             server.js:1769
 *       GET  /api/confidence?id=                error             server.js:2131
 *       POST /api/agent/orchestrate            error             server.js:1824
 *       POST /api/stages/prove                 error             cortex-gates.js:126
 *       POST /api/rollback/revert              error             cortex-rollback.js:26
 *    5. GET  /api/workspace-review              gaps[].message    server.js:1028 → cortex-core.js:1389
 *                                                                 (findGaps يقبل lang في 1164 لكن reviewWorkspace لا يمرّره)
 *       POST /api/agent/proactive               findings[].text  نفس المسار
 *       (أيضاً server.js:1210 يستدعي findGaps بلا lang)
 *    6. GET  /api/privacy/notice                policy.*.note     cortex-privacy.js:117 (notice نفسه مترجم)
 *    7. GET  /api/governance                    improvement.*     server.js:2242 (evaluate بلا lang؛ /api/improve عند 2109 مترجم)
 *    8. GET  /api/stages                        stages[].ar       cortex-schema.js:55-61 (حقل واحد عربي، لا en)
 *       GET  /api/connectors                    targets[].ar + capabilities.*.ar   cortex-connectors.js:46,56
 *       POST /api/connectors/test               ar/reason/...     cortex-connectors.js:183,433,502
 *    9. POST /api/gates/check                   gates[].detail    cortex-gates.js:217,233,245,277,295,377,480
 *                                                                 + server.js:1999,2070
 *       POST /api/rollback/verify               steps/error       cortex-rollback.js:29
 *   10. POST /api/import{,/folder,/remote,/web,/sync} error        cortex-import.js:772,934,1040,1184,1275
 *       POST /api/models/probe-provider          error             server.js:1633
 *       POST /api/models/add-provider            error             cortex-model-gateway.js:295
 *       POST /api/mcp/call (404 وخادم مجهول)     error             server.js:1684
 *       POST /api/mcp/call (مسودة بلا approved)  message 202       server.js:1713,1728
 *       POST /api/quarantine/clear               error             cortex-guard.js:473
 *       POST /api/improve/decide                 error             cortex-improve.js:672
 *   11. POST /api/ai/chat (mock)                answer            server.js:556-566 — **خليط لغوي**:
 *                                                                 «Mode: project» إنجليزي، وكل العناوين عربية
 *                                                                 («العنصر الأقرب:»، «المشروع النشط:»، «درجة الصحة:»،
 *                                                                 «أفضل خطوة تالية:»، «التوصية التنفيذية:»)،
 *                                                                 وجملة الذيل «هذه إجابة mock grounded…» عربية دائماً؛
 *                                                                 فقط قيمة الخطوة تتبع lang (next-action).
 *   12. POST /api/context/track                 lastResolved.reasons[]     cortex-core.js:1311-1325
 *       POST /api/agent/review-context           resolved.resolved.reasons[] نفس المصدر
 *  [ب] إنجليزي في وضع ar (الاتجاه المعاكس):
 *   13. GET  /api/project-state                 summary           قالب إنجليزي ثابت "Project: …\nKnowledge items: …"
 *                                                                 بينما nextActions[].text يتبع اللغة
 *   14. POST /api/agent/session/:id/message 500 error "Session not found"  cortex-core.js:1265
 *  [ج] محور اللغة في POST مختلف عن GET (مقيس):
 *   • POST /api/agent/next-action?lang=en بلا body.lang  → نص عربي (query مُهمَل)
 *   • POST /api/agent/next-action {lang:'en'}            → "Record the project's first key decision Probe"
 *   • GET  /api/agent/next-action?lang=en                → 404 text/plain "Not found" (server.js:2268 — مسار POST فقط)
 *  [د] المخزن الاحتياطي 404 ليس JSON ولا يتبع lang: أي مسار/أسلوب غير معروف يعيد
 *      text/plain «Not found» (server.js:2268) — لا رسالة عربية ولا إنجليزية مترجمة.
 *
 * ── شواهد نجاح مقيسة (تتبع الطلب فعلاً) ──────────────────────────────────
 *   /api/privacy/notice.notice · /api/limits · /api/improve.evaluation (label/message/proposals) ·
 *   /api/agent/next-action.text · /api/project-state.nextActions[].text ·
 *   /api/agent/run.error (apiMsg: «أعط الوكيل هدفًا» / "Give the agent a goal" — server.js:1313)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startLiveServer } from './_live-server.mjs';

const AR = /[\u0600-\u06FF]/;

const client = (srv) => async (method, path, body, headers) => {
  const r = await fetch(srv.base + path, {
    method,
    headers: method === 'GET' ? (headers || {}) : (headers || srv.headers()),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ليست JSON */ }
  return { status: r.status, json, text };
};

const shape = (v) => {
  if (Array.isArray(v)) return v.length ? ['#', shape(v[0])] : ['#'];
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = shape(v[k]);
    return o;
  }
  return typeof v;
};

// قيم يكتبها المستخدم/النظام على القرص (عناوين، مسارات، محتوى) — ليست نصوص واجهة.
const DATA_PATH = [
  /(^|\.)args(\[\d+\])?$/,
  /(^|\.)roots\.allowed\[\d+\]$/,
  /^resolved\.resolved\.title$/,
  /^resolved\.alternatives\[\d+\]\.title$/,
  /^(lastResolved|resolved)\.title$/,
  /((^|\.)note|(^|\.)notes\[\d+\])\.(content|body|title)$/,
];

function arabicStrings(v, prefix = '') {
  const out = [];
  const walk = (node, p) => {
    if (typeof node === 'string') {
      if (AR.test(node) && !DATA_PATH.some((re) => re.test(p))) out.push({ path: p, text: node });
      return;
    }
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], p ? `${p}.${k}` : k);
    }
  };
  walk(v, prefix);
  return out;
}

const fmt = (list) => list.map((x) => `     • ${x.path} = ${JSON.stringify(x.text.slice(0, 80))}`).join('\n');

// يجمع كل التسريبات في قائمة واحدة بدل التوقف عند الأول — التقرير الكامل هو الهدف.
function audit(bucket, label, payload, source) {
  const leaks = arabicStrings(payload);
  if (leaks.length) bucket.push(`   ${label}: ${leaks.length} نص عربي (${source})\n${fmt(leaks)}`);
}

// الخادم الرئيسي: settings.lang='ar'، فقياس ?lang=en منفصل عن الافتراضي.
const SRV = await startLiveServer({ lang: 'ar' });
const http = client(SRV);
after(async () => { await SRV.stop(); });

const GET_ROUTES = [
  '/api/status', '/api/dashboard', '/api/notes', '/api/workspace-review',
  '/api/project-state?project=Probe', '/api/settings', '/api/privacy/notice', '/api/stages',
  '/api/improve', '/api/connectors', '/api/governance', '/api/gates', '/api/quarantine',
  '/api/agent/monitor', '/api/rollback/changes', '/api/relations/coverage', '/api/search?q=test',
  '/api/brain/map', '/api/agent/tasks?runId=1', '/api/mcp/servers',
];
const POST_ROUTES = [
  ['/api/agent/next-action', { project: '' }],
  ['/api/agent/proactive', { project: '' }],
  ['/api/ai/chat', { message: 'hello' }],
  ['/api/gates/check', {}],
  ['/api/connectors/test', {}],
  ['/api/rollback/verify', { id: '__nope__' }],
  ['/api/stages/prove', {}],
  ['/api/agent/run', { goal: '' }],
];

// ═══ ١) سطح الإعدادات ═══════════════════════════════════════════════════════
test('١ — المفتاح المُخزَّن settings.lang موجود، وagent.language يُزرع عند الحفظ ويُقرأ', async () => {
  const s = (await http('GET', '/api/settings')).json;
  assert.equal(typeof s.lang, 'string', 'settings.lang موجود');
  assert.equal(typeof s.agent, 'object', 'settings.agent موجود');
  assert.equal(s.agent.language, undefined,
    "agent.language غير موجود افتراضياً — resolveAgentLang يسقط إلى 'ar'");

  assert.equal((await http('POST', '/api/settings', { agent: { language: 'en' } })).status, 200);
  assert.equal((await http('GET', '/api/settings')).json.agent.language, 'en', 'agent.language محفوظ');
  await http('POST', '/api/settings', { agent: { language: 'ar' } });
  assert.equal((await http('GET', '/api/settings')).json.agent.language, 'ar', 'أُعيد إلى ar');
});

// ═══ ٢) settings.lang ميت + لا مسار تبديل لغوي ═════════════════════════════
test('٢ — settings.lang يُحفظ ولا يغيّر أي نص، ولا يوجد /api/lang', async () => {
  assert.equal((await http('POST', '/api/settings', { lang: 'en' })).status, 200);
  assert.equal((await http('GET', '/api/settings')).json.lang, 'en', 'القيمة محفوظة ومعروضة');
  const notice = (await http('GET', '/api/privacy/notice')).json.notice;
  assert.ok(AR.test(notice), 'النص بقي عربياً رغم settings.lang=en — المفتاح ميت');
  for (const p of ['/api/lang', '/api/language', '/api/i18n', '/api/settings/lang']) {
    assert.equal((await http('GET', p)).status, 404, `${p} غير موجود`);
  }
  await http('POST', '/api/settings', { lang: 'ar' });
});

// ═══ ٣) الثبات البنيوي ══════════════════════════════════════════════════════
test('٣ — نفس بنية JSON في اللغتين: ٢١ مسار GET + ٨ مسارات POST', async () => {
  /* حالتان حيّتان لا تُقارَنان بالشكل العميق (2026-11-15): /api/status و/api/notes
     تعكسان اللحظة (نبضة مجدولة تكتب ملاحظة بين النداءين، أو lastReason يتحوّل من
     null إلى نص). مقارنة الشكل العميق عليهما تقيس استقرار الخزنة لا الترجمة.
     المقارنة الصحيحة لهما: مفاتيح المستوى الأول — وهي عقد الترجمة فعلاً. */
  const LIVE_STATE = new Set(['/api/status', '/api/notes']);
  const diffs = [];
  for (const p of GET_ROUTES) {
    const sep = p.includes('?') ? '&' : '?';
    const en = await http('GET', `${p}${sep}lang=en`);
    const ar = await http('GET', `${p}${sep}lang=ar`);
    if (en.status !== ar.status) diffs.push(`   GET ${p} — الحالة en=${en.status} ar=${ar.status}`);
    const a = LIVE_STATE.has(p.split('?')[0])
      ? JSON.stringify(Object.keys(en.json || {}).sort())
      : JSON.stringify(shape(en.json));
    const b = LIVE_STATE.has(p.split('?')[0])
      ? JSON.stringify(Object.keys(ar.json || {}).sort())
      : JSON.stringify(shape(ar.json));
    if (a !== b) diffs.push(`   GET ${p}\n     en=${a.slice(0, 220)}\n     ar=${b.slice(0, 220)}`);
  }
  for (const [p, body] of POST_ROUTES) {
    const en = await http('POST', p, { ...body, lang: 'en' });
    const ar = await http('POST', p, { ...body, lang: 'ar' });
    if (en.status !== ar.status) diffs.push(`   POST ${p} — الحالة en=${en.status} ar=${ar.status}`);
    const a = JSON.stringify(shape(en.json));
    const b = JSON.stringify(shape(ar.json));
    if (a !== b) diffs.push(`   POST ${p}\n     en=${a.slice(0, 220)}\n     ar=${b.slice(0, 220)}`);
  }
  assert.deepEqual(diffs, [], 'اختلاف بنيوي بين اللغتين:\n' + diffs.join('\n'));
});

// ═══ ٤) أسماء الحقول ════════════════════════════════════════════════════════
test('٤ — أسماء الحقول لا تُترجم: لا مفتاح عربي، و`error` يبقى error', async () => {
  const bad = [];
  const scan = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${p}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (AR.test(k)) bad.push(`${p}.${k}`);
      scan(v[k], p ? `${p}.${k}` : k);
    }
  };
  for (const p of GET_ROUTES) scan((await http('GET', p + (p.includes('?') ? '&' : '?') + 'lang=en')).json, p);
  for (const [p, body] of POST_ROUTES) scan((await http('POST', p, { ...body, lang: 'en' })).json, 'POST ' + p);

  const en = await http('GET', '/api/notes/__nope__?lang=en');
  const ar = await http('GET', '/api/notes/__nope__?lang=ar');
  assert.deepEqual(Object.keys(en.json).sort(), Object.keys(ar.json).sort(), 'مفاتيح 404 متطابقة في اللغتين');
  assert.ok('error' in en.json && 'error' in ar.json, 'مفتاح error بقي error');
  assert.deepEqual(bad, [], 'مفاتيح عربية في JSON:\n' + bad.join('\n'));
});

// ═══ ٥) وضع ar يعيد عربية فعلاً ════════════════════════════════════════════
test('٥ — وضع ar يعيد عربية في النصوص المولّدة', async () => {
  await http('POST', '/api/settings', { agent: { language: 'ar' } });
  const notice = (await http('GET', '/api/privacy/notice?lang=ar')).json.notice;
  const label = (await http('GET', '/api/improve?lang=ar')).json.evaluation?.weaknesses?.[0]?.label;
  const next = (await http('POST', '/api/agent/next-action', { project: 'Probe', lang: 'ar' })).json.text;
  const psNext = (await http('GET', '/api/project-state?project=Probe&lang=ar')).json.nextActions?.[0]?.text;
  for (const [what, text] of [['privacy/notice', notice], ['improve.label', label],
    ['agent/next-action.text', next], ['project-state.nextActions[0].text', psNext]]) {
    assert.ok(text && AR.test(text), `${what} عربي في وضع ar: ${String(text).slice(0, 70)}`);
  }
});

// ═══ ٦) ?lang=en يتقدّم على المحفوظ ═════════════════════════════════════════
test('٦ — ?lang=en يتغلّب على settings.agent.language=ar في الطلب نفسه', async () => {
  await http('POST', '/api/settings', { agent: { language: 'ar' } });
  const en = (await http('GET', '/api/privacy/notice?lang=en')).json.notice;
  const ar = (await http('GET', '/api/privacy/notice?lang=ar')).json.notice;
  assert.ok(!AR.test(en), 'en بلا حروف عربية: ' + en);
  assert.ok(AR.test(ar), 'ar عربي: ' + ar);
  assert.notEqual(en, ar, 'النصان مختلفان');
});

// ═══ ٧) الديمومة بعد إعادة التشغيل ═════════════════════════════════════════
test('٧ — تبديل اللغة عبر /api/settings يبقى بعد إعادة التشغيل ويحكم ما يُولَّد لاحقاً', async () => {
  const s1 = await startLiveServer({ lang: 'ar', env: { CORTEX_SCHED_MINUTES: '0.02' } });
  const h1 = client(s1);
  let brief1;
  try {
    assert.ok(AR.test((await h1('GET', '/api/privacy/notice')).json.notice), 'قبل التبديل: عربي');
    assert.equal((await h1('POST', '/api/settings', { agent: { language: 'en' } })).status, 200);
    assert.ok(!AR.test((await h1('GET', '/api/privacy/notice')).json.notice), 'بعد التبديل: إنجليزي بلا ?lang');
    // النبض الدوري (0.02 دقيقة ≈ ١.٢ث) يولّد «موجز الصباح» بلغة الإعداد الجديد.
    await new Promise((r) => setTimeout(r, 3500));
    brief1 = (await h1('GET', '/api/notes')).json.notes.find((n) => /morning-brief-/.test(n.id));
    assert.ok(brief1, 'موجز الصباح أُنشئ بالمجذول');
    assert.ok(!AR.test(brief1.title), 'عنوان الموجز إنجليزي: ' + brief1.title);
  } finally { await s1.stop(); }

  // mcpServers:null حتى لا يُعاد زرع settings.json فوق ما حفظناه.
  const s2 = await startLiveServer({ appRoot: s1.root, mcpServers: null });
  const h2 = client(s2);
  try {
    assert.equal((await h2('GET', '/api/settings')).json.agent.language, 'en', 'الإعداد نجا من إعادة التشغيل');
    assert.ok(!AR.test((await h2('GET', '/api/privacy/notice')).json.notice), 'النص بقي إنجليزياً بعد الإعادة');
    const next = (await h2('POST', '/api/agent/next-action', { project: 'Probe' })).json.text;
    assert.ok(!AR.test(next), 'next-action إنجليزي بعد الإعادة: ' + next);
    const brief2 = (await h2('GET', '/api/notes')).json.notes.find((n) => /morning-brief-/.test(n.id));
    assert.ok(brief2 && brief2.title === brief1.title, 'الموجز الإنجليزي لم يُعَد توليده بلغة أخرى');
  } finally { await s2.stop(); }
});

// ═══ ٨) LEAK: 404 ═══════════════════════════════════════════════════════════
test('LEAK ١ — أخطاء 404 في وضع en تبقى عربية', async () => {
  const b = [];
  audit(b, 'GET /api/notes/:id', (await http('GET', '/api/notes/__nope__?lang=en')).json, 'server.js:937');
  audit(b, 'GET /api/review/:id', (await http('GET', '/api/review/__nope__?lang=en')).json, 'server.js:1026');
  audit(b, 'GET /api/agent/session/:id', (await http('GET', '/api/agent/session/__nope__?lang=en')).json, 'server.js:1117');
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ٩) LEAK: session/status ════════════════════════════════════════════════
/* 2026-11-12: /api/session لم يعد يخدم غير المتصفح (إغلاق F1)، فاختباره عبر
   عميل HTTP عادي يقيس 403 لا الترجمة. نتحقق من /api/status، ونتحقق من أن رفض
   الجلسة نفسه مترجم في الوضعين — وهذا ما يهم مستخدم en فعلاً. */
test('LEAK ٢ — /api/status.model ورفض الجلسة مترجمان في en', async () => {
  const b = [];
  audit(b, 'GET /api/status', (await http('GET', '/api/status?lang=en')).json, 'server.js:906');
  const denied = await http('GET', '/api/session?lang=en');
  audit(b, 'GET /api/session (رفض)', denied.json, 'server.js:session');
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ١٠) LEAK: أخطاء التحقق 400/500 ════════════════════════════════════════
test('LEAK ٣ — أخطاء 400 في وضع en عربية (tasks/confidence/orchestrate/prove/revert)', async () => {
  const b = [];
  const cases = [
    ['GET', '/api/agent/tasks?lang=en', undefined, 'server.js:1769'],
    ['GET', '/api/confidence?lang=en', undefined, 'server.js:2131'],
    ['POST', '/api/agent/orchestrate', { goal: '', lang: 'en' }, 'server.js:1824'],
    ['POST', '/api/stages/prove', { lang: 'en' }, 'cortex-gates.js:126'],
    ['POST', '/api/rollback/revert', { lang: 'en' }, 'cortex-rollback.js:26'],
  ];
  for (const [m, p, body, src] of cases) {
    const r = m === 'GET' ? await http('GET', p) : await http('POST', p, body);
    if (r.status < 400) { b.push(`   ${m} ${p}: لم يُعد خطأ بل ${r.status} — الحالة غير متوقعة للتدقيق`); continue; }
    audit(b, `${m} ${p} [${r.status}]`, r.json, src);
  }
  // شاهد نجاح في نفس العائلة: /api/agent/run يمرّر lang عبر apiMsg (server.js:1313).
  const runEn = (await http('POST', '/api/agent/run', { goal: '', lang: 'en' })).json;
  const runAr = (await http('POST', '/api/agent/run', { goal: '', lang: 'ar' })).json;
  if (AR.test(runEn.error || '')) b.push(`   POST /api/agent/run (en): عاد عربياً ${JSON.stringify(runEn.error)}`);
  if (!AR.test(runAr.error || '')) b.push(`   POST /api/agent/run (ar): لم يعد عربياً ${JSON.stringify(runAr.error)}`);
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ١١) LEAK: الاستيراد/النماذج/MCP/الحجر/improve ═════════════════════════
test('LEAK ٤ — كتالوج أخطاء en عربية: استيراد، نماذج، MCP، حجر، improve/decide', async () => {
  const b = [];
  const cases = [
    ['/api/import', {}, 'cortex-import.js:772'],
    ['/api/import/folder', {}, 'cortex-import.js:934'],
    ['/api/import/remote', {}, 'cortex-import.js:1040'],
    ['/api/import/web', {}, 'cortex-import.js:1184'],
    ['/api/import/sync', {}, 'cortex-import.js:1275'],
    ['/api/models/probe-provider', { name: 'mock' }, 'server.js:1633'],
    ['/api/models/add-provider', {}, 'cortex-model-gateway.js:295'],
    ['/api/mcp/call', { server: '__nope__', tool: 'x' }, 'server.js:1684'],
    ['/api/mcp/call', { server: 'cortex-memory', tool: '__nope__' }, 'server.js:1713,1728'],
    ['/api/quarantine/clear', {}, 'cortex-guard.js:473'],
    ['/api/improve/decide', {}, 'cortex-improve.js:672'],
  ];
  for (const [p, body, src] of cases) {
    const r = await http('POST', p, { ...body, lang: 'en' });
    audit(b, `POST ${p} [${r.status}]`, r.json, src);
  }
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ١٢) LEAK: workspace-review / proactive ════════════════════════════════
test('LEAK ٥ — findGaps يقبل lang لكن reviewWorkspace لا يمرّره', async () => {
  const b = [];
  audit(b, 'GET /api/workspace-review', (await http('GET', '/api/workspace-review?lang=en')).json,
    'server.js:1028 → cortex-core.js:1389 (findGaps:1164 يقبل lang؛ server.js:1210 يستدعيها بلا lang)');
  const pr = await http('POST', '/api/agent/proactive', { project: '', lang: 'en' });
  audit(b, `POST /api/agent/proactive [${pr.status}]`, pr.json, 'نفس reviewWorkspace بلا lang');
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ١٣) LEAK: سياسة الخصوصية ══════════════════════════════════════════════
test('LEAK ٦ — notice مترجم لكن policy.*.note عربي دائماً', async () => {
  const j = (await http('GET', '/api/privacy/notice?lang=en')).json;
  assert.ok(!AR.test(j.notice), 'notice مترجم (شاهد نجاح): ' + j.notice);
  const b = [];
  audit(b, 'GET /api/privacy/notice → policy', { policy: j.policy }, 'cortex-privacy.js:117');
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
});

// ═══ ١٤) LEAK: governance يُسقط lang ═══════════════════════════════════════
test('LEAK ٧ — /api/governance يسقط lang عن /api/improve (نفس البيانات بلغتين)', async () => {
  const gov = (await http('GET', '/api/governance?lang=en')).json;
  const imp = (await http('GET', '/api/improve?lang=en')).json;
  const impW = imp.evaluation?.weaknesses || [];
  assert.ok(impW.length > 0, 'improve يعيد ضعفاً واحداً على الأقل');
  assert.ok(!AR.test(impW[0].label), 'improve وحدها مترجمة: ' + impW[0].label);

  const b = [];
  audit(b, 'GET /api/governance → improvement', { improvement: gov.improvement },
    'server.js:2242 (evaluate بلا lang) مقابل server.js:2109');
  assert.deepEqual(b, [], 'تسريبات في وضع en:\n' + b.join('\n'));
  assert.deepEqual((gov.improvement?.weaknesses || []).map((w) => w.label), impW.map((w) => w.label),
    'labels متطابقة في en لأن governance تكرّر النص العربي');
});

// ═══ ١٥) عقد ثنائي اللغة: مراحل/موصلات بحقل label يتبع lang ═════════════════
// كان التسريب: stages[].ar وحده وtargets[].ar وحده — مستخدم en يرى عربية.
// الإصلاح: كل تسمية تحمل ar+en+label، وlabel يُحسب من lang الطلب.
test('BILINGUAL ٨ — /api/stages و/api/connectors تسمية واحدة تتبع اللغة', async () => {
  const es = (await http('GET', '/api/stages?lang=en')).json;
  assert.ok(es.stages?.length > 0, 'stages غير فارغة');
  for (const s of es.stages) {
    assert.ok(typeof s.name === 'string' && s.name.trim(), 'كل مرحلة لها name');
    assert.ok(!AR.test(s.name), `اسم المرحلة إنجليزي في en: ${s.name}`);
  }
  const as = (await http('GET', '/api/stages?lang=ar')).json;
  for (const s of as.stages) {
    // أسماء علم لاتينية (MCP) تبقى كما هي — الشرط: عربي، أو لاتيني بلا خلط
    assert.ok(AR.test(s.name) || /^[A-Za-z0-9][A-Za-z0-9 .&/+-]*$/.test(s.name), `اسم المرحلة في ar: ${s.name}`);
  }

  const en = (await http('GET', '/api/connectors?lang=en')).json;
  assert.ok(en.targets?.length > 0, 'targets غير فارغة');
  for (const t of en.targets) {
    assert.ok(t.en, `target ${t.id} بلا حقل en`);
    assert.ok(t.label && !AR.test(t.label), `label ليس إنجليزياً: ${t.id} → ${t.label}`);
    assert.equal(t.label, t.en, `label ≠ en لـ${t.id}`);
  }
  const caps = Object.values(en.capabilities || {});
  assert.ok(caps.length > 0, 'capabilities غير فارغة');
  for (const c of caps) {
    assert.ok(c.en, 'قدرة بلا en');
    assert.ok(c.label && !AR.test(c.label), `label قدرة ليس إنجليزياً: ${c.label}`);
  }
  const ar = (await http('GET', '/api/connectors?lang=ar')).json;
  for (const t of ar.targets) {
    // اسم علم لاتيني (OpenCode) يبقى لاتينياً في ar — الشرط: عربي، أو لاتيني خالص
    assert.ok(t.label && (AR.test(t.label) || /^[A-Za-z0-9][A-Za-z0-9 .&/+-]*$/.test(t.label)), `label في ar: ${t.id} → ${t.label}`);
  }

  const t = await http('POST', '/api/connectors/test', { lang: 'en' });
  assert.ok(t.json && t.json.label && !AR.test(t.json.label), `رد الاختبار بلا label إنجليزي: ${t.text.slice(0, 120)}`);
  assert.ok(!AR.test(String(t.json.reason || '')), `سبب الاختبار عربي في en: ${t.json.reason}`);
});

// ═══ ١٦) عقد ثنائي اللغة: الأدلة، المحادثة، الأسباب، أسبقية اللغة ═════════════
test('BILINGUAL ٩ — الأدلة والمحادثة والأسباب تتبع lang، والجسم يسبق ?lang', async () => {
  const g = (await http('POST', '/api/gates/check', { lang: 'en' })).json;
  assert.ok(g.gates?.length > 0, 'gates غير فارغة');
  for (const x of g.gates) {
    assert.ok(!AR.test(String(x.name || '')), `اسم بوابة عربي في en: ${x.name}`);
    assert.ok(!AR.test(String(x.detail || '')), `detail بوابة عربي في en: ${x.detail}`);
  }

  const rb = await http('POST', '/api/rollback/verify', { id: '__nope__', lang: 'en' });
  assert.ok(!AR.test(rb.text), `rollback/verify عربي في en: ${rb.text.slice(0, 120)}`);

  // المحادثة: العناوين تتبع اللغة، وأسماء المحتوى (بيانات المستخدم) لا تُترجم.
  const EN_LABELS = ['Closest item', 'Active project', 'Health score', 'Next best step', 'Executive recommendation'];
  const AR_LABELS = ['العنصر الأقرب', 'المشروع النشط', 'درجة الصحة', 'أفضل خطوة تالية', 'التوصية التنفيذية'];
  const chatEn = (await http('POST', '/api/ai/chat', { message: 'hello', lang: 'en' })).json.answer || '';
  assert.ok(EN_LABELS.some((l) => chatEn.includes(l)), `المحادثة في en بلا أي عنوان إنجليزي: ${chatEn.slice(0, 120)}`);
  for (const l of AR_LABELS) assert.ok(!chatEn.includes(l), `عنوان عربي في محادثة en: ${l}`);
  const chatAr = (await http('POST', '/api/ai/chat', { message: 'hello', lang: 'ar' })).json.answer || '';
  assert.ok(AR_LABELS.some((l) => chatAr.includes(l)), `المحادثة في ar بلا عنوان عربي: ${chatAr.slice(0, 120)}`);
  for (const l of EN_LABELS) assert.ok(!chatAr.includes(l), `عنوان إنجليزي في محادثة ar: ${l}`);

  const ctx = (await http('POST', '/api/context/track', { noteId: 'mcp-memory', lang: 'en' })).json;
  for (const r of ctx.lastResolved?.reasons || []) assert.ok(!AR.test(String(r)), `سبب سياق عربي في en: ${r}`);

  const rc = (await http('POST', '/api/agent/review-context', { project: '', query: 'MCP Memory', lang: 'en' })).json;
  for (const r of rc.resolved?.resolved?.reasons || []) assert.ok(!AR.test(String(r)), `سبب مراجعة عربي في en: ${r}`);

  // ?lang= في POST صار يُقرأ (كان مُهملاً) — والجسم يسبق المسار.
  const q = (await http('POST', '/api/agent/next-action?lang=en', { project: 'Probe' })).json;
  assert.ok(!AR.test(String(q.text || '')), `?lang=en في POST لم يبدّل: ${q.text}`);
  const both = (await http('POST', '/api/agent/next-action?lang=en', { project: 'Probe', lang: 'ar' })).json;
  assert.ok(AR.test(String(both.text || '')), `body.lang=ar لم يسبق ?lang=en: ${both.text}`);

  // الاتجاه المعاكس: القوالب العربية موجودة فعلاً في ar (كانت إنجليزية ثابتة).
  const psAr = (await http('GET', '/api/project-state?project=Probe&lang=ar')).json;
  assert.ok(/^المشروع:/.test(psAr.summary || ''), `project-state ar ليس عربياً: ${String(psAr.summary).slice(0, 40)}`);
  assert.ok(AR.test(psAr.nextActions?.[0]?.text || ''), 'nextActions ليست عربية في ar');
  const psEn = (await http('GET', '/api/project-state?project=Probe&lang=en')).json;
  assert.ok(/^Project:/.test(psEn.summary || ''), `project-state en ليس إنجليزياً: ${String(psEn.summary).slice(0, 40)}`);

  const msgAr = await http('POST', '/api/agent/session/__nope__/message', { role: 'user', content: 'x', lang: 'ar' });
  assert.equal(msgAr.status, 500, `حالة رسالة جلسة مجهولة: ${msgAr.status}`);
  assert.ok(AR.test(msgAr.text), `رسالة الجلسة غير عربية في ar: ${msgAr.text.slice(0, 80)}`);
  const msgEn = await http('POST', '/api/agent/session/__nope__/message', { role: 'user', content: 'x', lang: 'en' });
  assert.ok(/Session not found/i.test(msgEn.text), `رسالة الجلسة غير إنجليزية في en: ${msgEn.text.slice(0, 80)}`);
});
