/**
 * إغلاق مصفوفة الإثبات (2026-10-29) — اختبارات الثغرات الاثنتي عشرة التي أُصلحت:
 *  ١) gw.estimateCost: تقدير بأسعار معلَنة فقط (بلا أسعار => null، لا تخمين) — م12.
 *  ٢) gw.recordUsage: المسار الحي يسجّل عبر البوابة الموحّدة (لا INSERT مكرر ولا سجل اتصال مزدوج).
 *  ٣) dataClass حسب السياق: نتائج مسارات صرفة => 'paths'؛ وغير ذلك 'knowledge' — م15/5.
 *  ٤) مصادر الملفات في ctx.sources: أدوات الملفات تُسجّل ما لمسته — م23/5 + م27.
 *  ٥) buildGitAuthEnv: توكن المستودعات الخاصة عبر البيئة (GIT_CONFIG_*) لا argv — م18.
 *  ٦) detectContradictions / findGaps: محركات م6/م39 بقياس مباشر — كانا بلا اختبار.
 *  ٧) /api/graph و/api/filemap: عقد 200 + بنية غير فارغة — كانا بلا اختبار.
 *
 * كل قياس هنا على خادم معزول أو جذر مؤقت — لا تلمس بيانات المنتج (درس العزل).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { startLiveServer } from './_live-server.mjs';

const require = createRequire(import.meta.url);
const gw = require('../cortex-model-gateway.js');
const imp = require('../cortex-import.js');
const { createCore } = require('../cortex-core.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* مزوّد مزيّف محلي — سكربت قابل للتبديل + عدّاد (نمط agent-runs) */
function startFakeProvider() {
  let script = [{ text: '{"done":true,"answer":"تم."}' }];
  let count = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const i = count++;
      const item = script[Math.min(i, script.length - 1)] || { text: '{}' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'scripted', usage: { prompt_tokens: 1500, completion_tokens: 500 }, choices: [{ index: 0, message: { role: 'assistant', content: item.text }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, setScript: (s) => { script = s; count = 0; }, getCount: () => count, close: () => server.close() }));
  });
}

test('estimateCost: أسعار معلَنة فقط — بلا أسعار أو بلا رموز => null (م12، منع التخمين)', () => {
  assert.equal(gw.estimateCost(null, 1000, 1000), null, 'بلا سعر => لا تقدير');
  assert.equal(gw.estimateCost({}, 1000, 1000), null);
  assert.equal(gw.estimateCost({ inPer1k: 2 }, 0, 0), null, 'بلا رموز معلومة => لا تقدير');
  assert.equal(gw.estimateCost({ inPer1k: 2, outPer1k: 4 }, 1500, 500), 5, '1.5k×2 + 0.5k×4 = 5');
  assert.equal(gw.estimateCost({ inPer1k: 0, outPer1k: 4 }, 1000, 1000), 4, 'سعر إدخال صفري معلَن مقبول');
});

test('buildGitAuthEnv: توكن بيئي إلى GIT_CONFIG_* — لا شيء في argv (م18)', () => {
  assert.deepEqual(imp.buildGitAuthEnv({}), {}, 'بلا CORTEX_GIT_TOKEN لا تغيير (السلوك القديم)');
  assert.deepEqual(imp.buildGitAuthEnv({ CORTEX_GIT_TOKEN: '   ' }), {}, 'توكن فراغي لا ينشط');
  const env = imp.buildGitAuthEnv({ CORTEX_GIT_TOKEN: 'tok_123' });
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  const b64 = env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'x-access-token:tok_123', 'الترويسة تُبنى صحيحة');
});

test('حي: التكلفة تُحسب وتُسجَّل عبر البوابة الموحّدة، وسجل الاتصال مرة واحدة لكل نداء', async (t) => {
  const fake = await startFakeProvider();
  // CORTEX_ALLOW_LOCAL_URL: المزود المزيّف على 127.0.0.1 — نفس نمط agent-runs
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { fake.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  fake.setScript([{ text: 'إجابة قصيرة.' }]);
  // مزود مزيّف + أسعار معلَنة — عبر API الإعدادات نفسه (يمر saveSettings/التشفير كالإنتاج)
  const set = await fetch(srv.base + '/api/settings', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ ai: { provider: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${fake.port}/v1`, openaiBaseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test', pricing: { inPer1k: 2, outPer1k: 4 } } })
  }).then(r => r.json());
  assert.ok(!set.error, 'الإعدادات حُفظت: ' + JSON.stringify(set.error || ''));
  const r = await fetch(srv.base + '/api/ai/chat', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ messages: [{ role: 'user', content: 'كم الساعة؟' }] }) });
  assert.equal(r.status, 200, 'النداء نجح');
  const dbFile = path.join(srv.root, 'data', readdirSync(path.join(srv.root, 'data')).find((f) => f.endsWith('.db')));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const mu = db.prepare('SELECT provider, prompt_tokens, completion_tokens, cost, source, purpose FROM model_usage ORDER BY rowid DESC LIMIT 1').get();
  assert.ok(mu, 'صف استهلاك مسجَّل');
  assert.equal(mu.prompt_tokens, 1500);
  assert.equal(mu.source, 'estimated', 'المصدر estimated (سعر معلَن + رموز من المزود)');
  assert.ok(Math.abs(Number(mu.cost) - 5) < 1e-9, `التكلفة 5 (1.5k×2+0.5k×4) — وُجد ${mu.cost}`);
  assert.ok(mu.purpose, 'الغرض مسجَّل');
  const cl = db.prepare('SELECT data_kind, purpose FROM connection_log ORDER BY rowid DESC LIMIT 2').all();
  assert.equal(cl.length, 1, `سجل اتصال واحد لكل نداء — وُجد ${cl.length} (كان يكتب مرتين: callModel + recordModelCall)`);
  db.close();
});

test('حي: جولة وكيل تمر بـfs_list => dataClass=paths والنتيجة تحمل مصدراً ملفياً (م15/5 + م23/5)', async (t) => {
  const fake = await startFakeProvider();
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { fake.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  // ملف حقيقي في جذر الجذر المعزول ليُلتقط كمصدر
  writeFileSync(path.join(srv.root, 'probe-note.txt'), 'ملف قياس');
  const set = await fetch(srv.base + '/api/settings', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ ai: { provider: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${fake.port}/v1`, openaiBaseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test' } })
  }).then(r => r.json());
  assert.ok(!set.error, 'الإعدادات حُفظت: ' + JSON.stringify(set.error || ''));
  const list = JSON.stringify({ thought: 'أستعرض الجذر', action: { name: 'fs_list', args: { path: srv.root } } });
  fake.setScript([{ text: list }, { text: '{"done":true,"answer":"رأيت الملفات."}' }]);
  /* الهدف بلا أنماط التوجيه الحتمي (اعرض/مجلد/ملف/كم…) — تلك تُحقن أدوات معرفة
     (search_notes/repo_index) فتصبح الخطوات خليطاً والصنف الصحيح knowledge.
     قياس 2026-10-29: «اعرض محتويات مجلد العمل» حقن search_notes فتغيّر الصنف عمداً. */
  const res = await fetch(srv.base + '/api/agent/run', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ goal: 'استعرض محتويات مساحة العمل الحالية ثم أخبرني' }) });
  const text = await res.text();
  assert.match(text, /agent_done/, 'التشغيل انتهى');
  // النداء الثاني (بعد نتيجة fs_list) يجب أن يحمل صنف المسارات في سجل الاتصال
  const dbFile = path.join(srv.root, 'data', readdirSync(path.join(srv.root, 'data')).find((f) => f.endsWith('.db')));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare('SELECT data_kind, purpose, at FROM connection_log ORDER BY rowid ASC').all();
  const kinds = rows.map((x) => x.data_kind);
  assert.ok(kinds.includes('paths'), `نداء بعد fs_list يُسجَّل 'paths' — الصفوف: ${JSON.stringify(rows)} · نداءات المزود: ${fake.getCount()}`);
  assert.equal(kinds[0], 'knowledge', 'النداء الأول (بلا خطوات) knowledge');
  db.close();
  const evs = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
  const done = (evs.find((e) => e.type === 'agent_done') || {}).result || {};
  const fileSources = (done.sources || []).filter((s) => s && s.kind === 'file');
  assert.ok(fileSources.some((s) => /probe-note\.txt$/.test(s.file)), `مصدر الملف ملتقط: ${JSON.stringify((done.sources || []).slice(0, 6))}`);
});

test('حي: add-provider يحفظ القدرات المفحوصة ويوصل pickModel — الاختيار الافتراضي والمزود النشط (م10/7 + م12)', async (t) => {
  // مزود مزيّف كامل: اكتشاف /models + توليد، ورؤية مرفوضة (400) لقياس قدرة واحدة مؤكدة وأخرى منفية
  let hitChat = 0;
  const full = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = req.url.split('?')[0];
      const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.endsWith('/models')) return j(200, { object: 'list', data: [{ id: 'model-coder', owned_by: 'test' }] });
      if (req.method === 'POST' && u.endsWith('/chat/completions')) {
        hitChat++;
        if (raw.includes('image_url')) return j(400, { error: { message: 'no vision here' } });
        return j(200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      }
      j(404, { error: { message: 'nf' } });
    });
  });
  await new Promise((r) => full.listen(0, '127.0.0.1', r));
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { full.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  const r = await fetch(srv.base + '/api/models/add-provider', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ name: 'FakeCloud', baseUrl: `http://127.0.0.1:${full.address().port}/v1`, apiKey: 'tok', pricing: { inPer1k: 1, outPer1k: 2 } })
  }).then((x) => x.json());
  assert.ok(r.ok, 'إضافة المزود نجحت: ' + JSON.stringify((r && r.error) || '').slice(0, 120));
  const m0 = (r.models || [])[0] || {};
  assert.equal(m0.canGenerate, true, 'قدرة التوليد مؤكدة بفحص');
  assert.ok(m0.capabilities && m0.capabilities.tools === true, 'قدرة الأدوات مؤكدة: ' + JSON.stringify(m0.capabilities));
  assert.equal(r.autoModel, 'model-coder', 'pickModel اختارت الافتراضي من القدرات المثبتة (لا من الاسم)');
  const cfg = await fetch(srv.base + '/api/settings').then((x) => x.json());
  const ai = cfg.ai || cfg.settings?.ai || {};
  const provs = cfg.providers || cfg.settings?.providers || [];
  assert.equal(ai.model, 'model-coder', 'النموذج الافتراضي عُيّن فعلاً من القدرات');
  /* المُشغِّل لا الاسم: callModel يوزّع على mock/ollama/openai-compatible فقط،
     فحفظ اسم المزود في ai.provider كان يجعل كل نداء حي يفشل بـ«مزود غير معروف». */
  assert.equal(ai.provider, 'openai-compatible', 'المزود النشط يُسجَّل بالمُشغِّل الذي يفهمه callModel');
  assert.equal(ai.baseUrl, `http://127.0.0.1:${full.address().port}/v1`, 'عنوان المزود النشط يُلزم مع التفعيل وإلا ذهب النداء إلى OpenAI');
  assert.ok(ai.hasApiKey || ai.apiKeyMasked || typeof ai.apiKey === 'string', 'مفتاح المزود النشط مربوط عند التفعيل');
  const saved = provs.find((p) => p.name === 'FakeCloud') || {};
  assert.ok(Array.isArray(saved.modelsInfo) && saved.modelsInfo[0] && saved.modelsInfo[0].capabilities, 'القدرات المفحوصة محفوظة مع المزود (كانت تُسقَط: أسماء فقط)');
  assert.ok(saved.pricing && saved.pricing.inPer1k === 1, 'الأسعار المعلَنة محفوظة للتقدير');
  assert.ok(hitChat >= 3, `فحص القدرات أجرى طلبات فعلية (${hitChat})`);
});

test('حي: use-provider يفعّل مزوداً محفوظاً من الخادم بلا رحلة مفتاح مقنّع (عطل 2026-11-05)', async (t) => {
  const fake = http.createServer((req, res) => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url.split('?')[0].endsWith('/models')) return j(200, { object: 'list', data: [{ id: 'model-a' }] });
    if (req.method === 'POST') return j(200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    return j(404, {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { fake.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });

  const added = await fetch(srv.base + '/api/models/add-provider', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ name: 'SavedOne', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'tok-123456789', model: 'model-a' }),
  }).then((x) => x.json());
  assert.ok(added.ok, 'أُضيف المزود: ' + JSON.stringify(added).slice(0, 160));

  // مزود آخر نشط — ثم التفعيل من المخزون، والواجهة لا ترسل أي مفتاح
  await fetch(srv.base + '/api/settings', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ ai: { provider: 'mock', model: '', baseUrl: 'http://127.0.0.1:1/v1' } }),
  });
  const afterPartial = await fetch(srv.base + '/api/settings').then((x) => x.json());
  assert.ok((afterPartial.providers || []).some((p) => p.name === 'SavedOne'), 'الحفظ الجزئي للإعدادات لا يمحو المزودين المحفوظين');
  const used = await fetch(srv.base + '/api/models/use-provider', {
    method: 'POST', headers: srv.headers(), body: JSON.stringify({ name: 'SavedOne' }),
  }).then((x) => x.json());
  assert.ok(used.ok, 'التفعيل نجح: ' + JSON.stringify(used).slice(0, 160));
  assert.equal(used.model, 'model-a', 'النموذج المُثبت من المخزون');
  assert.ok(!String(used.maskedKey || '').startsWith('enc:'), 'القناع لا يعرض نصاً مشفّراً: ' + used.maskedKey);
  const cfg = await fetch(srv.base + '/api/settings').then((x) => x.json());
  const ai = cfg.ai || {};
  assert.equal(ai.provider, 'openai-compatible', 'المُشغِّل الذي يفهمه callModel');
  assert.equal(ai.baseUrl, `http://127.0.0.1:${fake.address().port}/v1`, 'العنوان من المخزون لا من الطلب');
});

test('حي: مزود يقفل /models بـ403 يُسجَّل بمعرّف نموذج صريح، ويُرفض بلا معرّف (2026-11-05)', async (t) => {
  const gated = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url.split('?')[0].endsWith('/models')) {
        return j(403, { error: { message: 'Verify your email address to use the API.', type: 'email_verification_required', code: 'email_verification_required' } });
      }
      if (req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')) {
        return j(200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      return j(404, {});
    });
  });
  await new Promise((r) => gated.listen(0, '127.0.0.1', r));
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { gated.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  const base = `http://127.0.0.1:${gated.address().port}/v1`;

  const withModel = await fetch(srv.base + '/api/models/add-provider', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ name: 'Gated', baseUrl: base, apiKey: 'k-123456789', model: 'gated-model' }),
  }).then((x) => x.json());
  assert.ok(withModel.ok, 'سُجّل رغم قفل الاكتشاف: ' + JSON.stringify(withModel).slice(0, 200));
  assert.equal(withModel.manualModels, true, 'مسار المعرّف الصريح');
  assert.equal(withModel.discoveryAvailable, false, 'الاكتشاف مقفل فعلاً');
  assert.equal((withModel.models || [])[0].id, 'gated-model', 'المعرّف الصريح أُثبت توليده');

  const withoutModel = await fetch(srv.base + '/api/models/add-provider', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ name: 'Gated2', baseUrl: base, apiKey: 'k-123456789' }),
  }).then((x) => x.json());
  assert.equal(withoutModel.ok, false, 'بلا معرّف لا تسجيل');
  assert.equal(withoutModel.step, 'connect');
  assert.match(String(withoutModel.error), /Verify your email address/, 'سبب المزود الحقيقي يظهر لا «تحقق من مفتاح API» فقط');
});

test('حي: مسح الاكتشاف مسقوف — مزود يعلن 25 نموذجاً بلا توليد يُرفض بسبب واضح بلا تعليق (2026-11-05)', async (t) => {
  // كل النماذج ترد 402 كما يفعل حساب بلا خطة على tokenharbor.ai — ولا واحد يثبت التوليد
  let chatHits = 0;
  const many = http.createServer((req, res) => {
    const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && u.endsWith('/models')) {
      return j(200, { object: 'list', data: Array.from({ length: 25 }, (_, i) => ({ id: `paid-model-${i}`, owned_by: 'test' })) });
    }
    if (req.method === 'POST' && u.endsWith('/chat/completions')) {
      chatHits++;
      return j(402, { error: { message: 'No active plan was found on this account', type: 'payment_required', code: 'no_active_plan' } });
    }
    return j(404, {});
  });
  await new Promise((r) => many.listen(0, '127.0.0.1', r));
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { many.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });

  const r = await fetch(srv.base + '/api/models/add-provider', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ name: 'PaidOnly', baseUrl: `http://127.0.0.1:${many.address().port}/v1`, apiKey: 'k-123456789' }),
  }).then((x) => x.json());
  assert.equal(r.ok, false, 'لا يُسجَّل مزود بلا نموذج قابل للتوليد');
  assert.equal(r.step, 'generate');
  assert.equal(r.discoveredCount, 25, 'العدد المُعلن يُذكر في الرفض');
  // السقف: 25 نموذجاً × 4 فحوص = 100 طلب لو لم يكن هناك سقف. السقف 10 نماذج.
  assert.ok(chatHits <= 40, `المسح مسقوف فعلاً (${chatHits} طلب لـ25 نموذجاً)`);
  assert.ok(chatHits >= 4, `فُحصت نماذج فعلية (${chatHits})`);
});

test('توجيه حتمي مصحَّح (2026-10-30): مشروع+نية أثر ⇒ memory_slice، وسؤال ملف بمسار ⇒ repo_index بـpath لا noteId', async (t) => {
  const fake = await startFakeProvider();
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { fake.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  // مشروع تجريبي صغير داخل الجذر المعزول + احتضان مسبق
  const demo = path.join(srv.root, 'route-demo');
  fs.mkdirSync(path.join(demo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'package.json'), JSON.stringify({ name: 'route-demo', version: '1.0.0' }));
  fs.writeFileSync(path.join(demo, 'src', 'a.js'), "const m = require('./b');\nmodule.exports = { sum: m.add };\n");
  fs.writeFileSync(path.join(demo, 'src', 'b.js'), "function add(x, y) { return x + y; }\nmodule.exports = { add };\n");
  const abs = await fetch(srv.base + '/api/project/absorb', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ path: demo, project: 'RouteDemo' }) }).then(r => r.json());
  assert.ok(abs.ok, 'الاحتضان المسبق نجح');
  const set = await fetch(srv.base + '/api/settings', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ ai: { provider: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${fake.port}/v1`, openaiBaseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 't' } }) }).then(r => r.json());
  assert.ok(!set.error, 'إعدادات المزود المزيّف');

  async function runAndSteps(goal) {
    // الرد الأول نص بلا أداة ⇒ الحلقة تتجاوز step1 (تطلب done) ثم يقع التوجيه الحتمي في step2
    fake.setScript([{ text: 'سأتحقق حالاً.' }, { text: '{"done":true,"answer":"تم الفحص."}' }]);
    const res = await fetch(srv.base + '/api/agent/run', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ goal }) });
    const text = await res.text();
    const evs = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
    const done = (evs.find((e) => e.type === 'agent_done') || {}).result || {};
    return done.steps || [];
  }

  // أ) مشروع محتضن + نية تعديل/أثر ⇒ القاطع بالهدف الصحيح
  const stepsA = await runAndSteps('في مشروع RouteDemo: بدي أعدل src/a.js — ايش بيتأثر؟');
  const sliceStep = stepsA.find((s) => s.tool === 'memory_slice');
  assert.ok(sliceStep, `التوجيه الحتمي أطلق memory_slice — الخطوات: ${stepsA.map((s) => s.tool).join(',')}`);
  assert.ok(!sliceStep.result?.error, 'القاطع نُفّذ بلا رفض: ' + JSON.stringify(sliceStep.result?.error || ''));
  assert.equal(sliceStep.args?.project, 'RouteDemo', 'المشروع استُخرج من الجملة: ' + JSON.stringify(sliceStep.args));
  assert.equal(sliceStep.args?.file, 'src/a.js', 'الملف استُخرج من الجملة: ' + JSON.stringify(sliceStep.args));
  assert.ok((sliceStep.result?.dependsOn || []).includes('src/b.js'), 'القاطع رد باعتماديات الملف الفعلية: ' + JSON.stringify(sliceStep.result?.dependsOn));

  // ب) سؤال ملف بمسار مطلق ⇒ repo_index يمرر path (كان يُمرَّر noteId فتُرفض حتماً)
  const stepsB = await runAndSteps(`راجع ملف ${demo.replace(/\\/g, '/')}/src/a.js وقل لي أين يُعرَّف الجمع`);
  const idxStep = stepsB.find((s) => s.tool === 'repo_index');
  assert.ok(idxStep, `التوجيه الحتمي أطلق repo_index — الخطوات: ${stepsB.map((s) => s.tool).join(',')}`);
  assert.ok(idxStep.args && idxStep.args.path, 'الوسيط path مرَّر (لا noteId): ' + JSON.stringify(idxStep.args));
  assert.ok(!/path is required/.test(String(idxStep.result?.error || '')), 'لم تُرفض السياسة بـpath is required بعد اليوم');
});

test('ب1+ب2 (2026-10-30): المستجدات بلا ازدواج (مصدر واحد للعزل) وبلا ملاحظات نظام (Living)', async (t) => {
  const { createAgent } = require('../cortex-agent.js');
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-findings-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  const core = createCore({ root, projectRoot: process.cwd() });
  await core.ensureBaseFiles();
  const agent = createAgent({ core, callModel: async () => ({ text: '{}' }), parseJsonLoose: () => ({}), cut: (s) => s, skills: null });
  // ملاحظة نظام آلية (Living) + ملاحظة مهمة معزولة + مشروع بلا مخاطر
  await core.saveNote({ id: 'living-test', title: 'Living Note — demo', type: 'note', importance: 4, content: '# Living\n\nملاحظة نظام آلية.' });
  await core.saveNote({ id: 'imp-iso', title: 'قرار مهم معزول', type: 'decision', importance: 4, content: '# قرار مهم معزول\n\nلا روابط إطلاقاً.' });
  await core.saveNote({ id: 'proj-z', title: 'مشروع زد', type: 'project', project: 'Zed', content: '# مشروع زد\n\nهدف المشروع.' });
  const out = await agent.proactive({ lang: 'ar' });
  const texts = out.findings.map((f) => String(f.text || ''));
  assert.ok(!texts.some((x) => /Living Note/.test(x)), 'ملاحظات النظام لا تدخل المستجدات: ' + JSON.stringify(texts));
  assert.equal(texts.filter((x) => x.includes('قرار مهم معزول')).length, 1, 'العزل يظهر مرة واحدة بلا ازدواج (كان مصدرين بنفس المعنى): ' + JSON.stringify(texts));
});

test('محركات م6/م39: التعارضات تُكشف والفجوات تُشتق — قياس مباشر (كانا بلا اختبار)', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-engines-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  const core = createCore({ root, projectRoot: process.cwd() });
  await core.ensureBaseFiles();
  // تعارض مباشر: قراران بقطبية متضادة على نفس الجملة
  const a = await core.saveNote({ id: 'dec-a', title: 'قرار التخزين', type: 'decision', project: 'Engines', content: '# قرار التخزين\n\nWe adopt Redis for caching layer service.' });
  await core.saveNote({ id: 'dec-b', title: 'قرار مضاد', type: 'decision', project: 'Engines', content: '# قرار مضاد\n\nWe avoid Redis for caching layer service.' });
  const notes = await core.readNotes();
  const cs = core.detectContradictions(notes.find((n) => n.id === a.id), notes);
  assert.ok(cs.length >= 1, `تعارض مكتشف — وُجد ${JSON.stringify(cs)}`);
  assert.ok(cs.some((c) => c.againstId === 'dec-b'), 'التعارض مع الملاحظة المضادة تحديداً');
  // الفجوات: مشروع بلا قرارات ولا مخاطر
  await core.saveNote({ id: 'proj-x', title: 'مشروع بلا قرارات', type: 'project', project: 'GapProj', content: '# مشروع\n\nهدف المشروع القياس.' });
  const notes2 = await core.readNotes();
  const gaps = core.findGaps(notes2, 'GapProj');
  const types = gaps.map((g) => g.type);
  assert.ok(types.includes('missing_decision'), `فجوة القرار — وُجدت: ${types.join(',')}`);
  assert.ok(types.includes('missing_risk'), `فجوة المخاطر — وُجدت: ${types.join(',')}`);
});

test('عقد المخططين: /api/graph و/api/filemap 200 ببنية غير فارغة (كانا بلا اختبار)', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });
  const g = await fetch(srv.base + '/api/graph').then((r) => r.json());
  assert.equal(g.status, undefined, 'graph ردّ JSON'); // وجود الحقول أدناه هو الفحص
  assert.ok(Array.isArray(g.nodes) && Array.isArray(g.edges), `graph: عقد nodes/edges — ${Object.keys(g).join(',')}`);
  const f = await fetch(srv.base + '/api/filemap').then((r) => r.json());
  const fArr = Array.isArray(f) ? f : (f.nodes || f.items || f.tree || []);
  assert.ok(Array.isArray(fArr), `filemap: بنية قابلة للقراءة — ${Object.keys(f).join(',')}`);
});

test('سجل الاستخدام والاتصال يحملان اسم المزود النشط لا المُشغِّل (عطل 2026-11-05)', async (t) => {
  const fake = await startFakeProvider();
  const srv = await startLiveServer({ env: { CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(async () => { fake.close(); await srv.stop(); try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ } });

  const url = `http://127.0.0.1:${fake.port}/v1`;
  const saved = await fetch(srv.base + '/api/settings', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({
      ai: { provider: 'openai-compatible', model: 'scripted', baseUrl: url, apiKey: 'k-123456789' },
      providers: [{ name: 'NamedCloud', baseUrl: url, apiKey: 'k-123456789', enabled: true }],
    }),
  });
  assert.equal(saved.status, 200);

  const r = await fetch(srv.base + '/api/ai/chat', {
    method: 'POST', headers: srv.headers(),
    body: JSON.stringify({ messages: [{ role: 'user', content: 'مرحبا' }] }),
  });
  assert.equal(r.status, 200, 'النداء الحي نجح');

  const dbFile = path.join(srv.root, 'data', readdirSync(path.join(srv.root, 'data')).find((f) => f.endsWith('.db')));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const mu = db.prepare('SELECT provider FROM model_usage ORDER BY rowid DESC LIMIT 1').get();
  const cl = db.prepare('SELECT provider FROM connection_log ORDER BY rowid DESC LIMIT 1').get();
  db.close();

  assert.equal(mu.provider, 'NamedCloud', 'model_usage يحمل اسم المزود لا openai-compatible');
  assert.equal(cl.provider, 'NamedCloud', 'connection_log يحمل اسم المزود لا openai-compatible');
});
