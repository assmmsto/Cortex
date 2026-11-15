import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const GW = require('../cortex-model-gateway');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────
// مزود وهمي حقيقي على 127.0.0.1 — كل قياس هنا شبكة فعلية لا محاكاة
// ─────────────────────────────────────────────────────────────────
function fakeProvider(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      hits.push(key);
      const handler = routes[key] || routes[`${req.method} *`];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
      const out = handler(body ? JSON.parse(body) : null, req);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body === undefined ? {} : out.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const MODELS_OK = { body: { object: 'list', data: [{ id: 'alpha-1', owned_by: 'fake' }, { id: 'beta-2', owned_by: 'fake' }] } };

function genOk() {
  return { body: { choices: [{ message: { role: 'assistant', content: 'pong' } }] } };
}

// ─────────────────────────────────────────────────────────────────
// المادة 9 — لا ارتباط بمزود واحد
// ─────────────────────────────────────────────────────────────────
test('المادة 9: لا عنوان مزود مثبّت في أي نداء شبكة، والافتراضي لا يغادر الجهاز', () => {
  // العنوان مسموح كقيمة افتراضية قابلة للتعديل في الإعدادات،
  // لكن مرفوض أن يكون مثبّتاً داخل نداء fetch نفسه (حينها لا يغيّره أي إعداد).
  const VENDOR = /api\.openai\.com|openrouter\.ai|api\.anthropic\.com|generativelanguage\.googleapis\.com/;
  for (const file of ['cortex-core.js', 'cortex-agent.js', 'cortex-orchestrator.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const hardcoded = src
      .split('\n')
      .filter((line) => /fetch\s*\(|safeJsonFetch\s*\(|fetchWithTimeout\s*\(/.test(line))
      .filter((line) => VENDOR.test(line));
    assert.equal(hardcoded.length, 0, `${file} يثبّت عنوان مزود في نداء: ${hardcoded[0]?.trim()}`);
  }

  // الافتراضي محلي/وهمي: لا عنوان خارجي يُستخدم قبل أن يضبطه المستخدم
  const coreSrc = fs.readFileSync(path.join(ROOT, 'cortex-core.js'), 'utf8');
  const defaults = coreSrc.slice(coreSrc.indexOf('function defaultSettings()'));
  assert.match(
    defaults.slice(0, defaults.indexOf('}') + 400),
    /provider: 'mock'/,
    'المزود الافتراضي ليس محلياً/وهمياً'
  );

  // البوابة طبقة مستقلة: يستوردها الخادم ولا يستورد الخادم أي SDK مزود
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/cortex-model-gateway'\)/, 'الخادم لا يمرّ عبر بوابة النماذج');
  assert.doesNotMatch(server, /require\('openai'\)|require\('@anthropic/, 'الخادم مربوط بـ SDK مزود بعينه');
});

test('المادة 9: أي اسم مزود وعنوان يعملان بالتساوي — لا اسم مميّز مبرمَج', async () => {
  const mk = () => fakeProvider({
    'GET /v1/models': () => MODELS_OK,
    'POST /v1/chat/completions': () => genOk(),
  });
  const a = await mk();
  const b = await mk();
  try {
    const ra = await GW.probeConnection(a.baseUrl, 'k-aaaa1111');
    const rb = await GW.probeConnection(b.baseUrl, 'k-bbbb2222');
    assert.equal(ra.ok, true, 'المزود الأول لم يُفحص');
    assert.equal(rb.ok, true, 'المزود الثاني لم يُفحص');
  } finally {
    await a.close();
    await b.close();
  }
});

// ─────────────────────────────────────────────────────────────────
// المادة 10 §1 — التحقق من صحة الصيغة قبل أي اتصال
// ─────────────────────────────────────────────────────────────────
test('المادة 10§1: عناوين خطرة أو غير صالحة تُرفض قبل الشبكة', () => {
  const bad = [
    'file:///etc/passwd',
    'ftp://example.com/v1',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'not a url',
    '',
    '   ',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080/v1',
  ];
  for (const raw of bad) {
    const r = GW.validateUrl(raw);
    assert.equal(r.ok, false, `قبل عنواناً خطراً/تالفاً: ${JSON.stringify(raw)}`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, 'رفض بلا سبب مذكور');
  }
  assert.equal(GW.validateUrl(null).ok, false);
  assert.equal(GW.validateUrl(42).ok, false);
  assert.equal(GW.validateUrl('https://api.example.com/v1/').url, 'https://api.example.com/v1', 'التطبيع لم يزل الشرطة الأخيرة');
});

// ─────────────────────────────────────────────────────────────────
// المادة 10 §2-§7 — التسلسل الإلزامي عند الإضافة، بقدرات مُختبَرة فعلاً
// ─────────────────────────────────────────────────────────────────
test('المادة 10§2-§7: إضافة مزود تفحص الاتصال وتكتشف النماذج وتختبر التوليد والقدرات', async () => {
  const fake = await fakeProvider({
    'GET /v1/models': () => MODELS_OK,
    'POST /v1/chat/completions': (b) => {
      // alpha-1 يرفض الأدوات والرؤية، beta-2 يرفض السياق الطويل
      if (b.model === 'alpha-1') {
        if (Array.isArray(b.tools)) return { status: 400, body: { error: { message: 'tools unsupported' } } };
        const content = b.messages[0].content;
        if (Array.isArray(content)) return { status: 400, body: { error: { message: 'vision unsupported' } } };
        return genOk();
      }
      if (b.model === 'beta-2') {
        const content = b.messages[0].content;
        if (typeof content === 'string' && content.length > 4000) {
          return { status: 400, body: { error: { message: 'context too long' } } };
        }
        return genOk();
      }
      return { status: 400, body: { error: { message: 'model not found' } } };
    },
  });
  try {
    const r = await GW.addProvider({ name: 'fake-local', baseUrl: fake.baseUrl, apiKey: 'sk-test-1234' });
    assert.equal(r.ok, true, `الإضافة فشلت: ${r.error}`);
    assert.equal(r.connected, true);
    assert.equal(r.discoveryAvailable, true);
    assert.equal(r.models.length, 2, `عدد النماذج المكتشفة ${r.models.length} لا 2`);

    const alpha = r.models.find((m) => m.id === 'alpha-1');
    const beta = r.models.find((m) => m.id === 'beta-2');
    assert.ok(alpha && beta, 'معرّفات النماذج ليست الفعلية');
    assert.equal(alpha.canGenerate, true);
    assert.equal(alpha.capabilities.tools, false, 'أدوات لم تُرفض فعلاً لكن سُجّلت true');
    assert.equal(alpha.capabilities.vision, false);
    assert.equal(alpha.capabilities.longContext, true);
    assert.equal(beta.capabilities.longContext, false, 'سياق طويل رُفض فعلاً لكن سُجّل true');
    assert.equal(beta.capabilities.tools, true);
  } finally {
    await fake.close();
  }
});

test('المادة 10§6: «نجح الاتصال» لا يُخلط مع «قدر فعلاً على التوليد»', async () => {
  const empty = await fakeProvider({
    'POST /v1/chat/completions': () => ({ body: { choices: [{ message: { content: '   ' } }] } }),
  });
  const down = await fakeProvider({
    'POST /v1/chat/completions': () => ({ status: 503, body: { error: { message: 'overloaded' } } }),
  });
  try {
    const e = await GW.probeGeneration(empty.baseUrl, 'k', 'm1');
    assert.equal(e.reachable, true, 'الخدمة ردّت لكنها لم تُعتبر قابلة للوصول');
    assert.equal(e.canGenerate, false, 'محتوى فارغ عُدّ توليداً ناجحاً');
    assert.ok(e.error, 'لا سبب مذكور للفشل');

    const d = await GW.probeGeneration(down.baseUrl, 'k', 'm1');
    assert.equal(d.reachable, true, 'استجابة 503 تعني أن الخدمة ردّت فعلاً');
    assert.equal(d.canGenerate, false);
  } finally {
    await empty.close();
    await down.close();
  }
});

// ─────────────────────────────────────────────────────────────────
// المادة 11 — المحرمات: لا نماذج وهمية، لا ادعاء نجاح، لا مزود بديل تلقائي
// ─────────────────────────────────────────────────────────────────
test('المادة 11: غياب واجهة الاكتشاف يُعلن صراحةً ولا يُلفّق نماذج', async () => {
  const noModels = await fakeProvider({ 'GET /v1/models': () => ({ status: 404, body: { error: { message: 'no' } } }) });
  try {
    const r = await GW.addProvider({ name: 'no-discovery', baseUrl: noModels.baseUrl, apiKey: 'k' });
    assert.equal(r.ok, true, 'غياب الاكتشاف ليس فشل اتصال (المادة 11)');
    assert.equal(r.connected, true);
    assert.equal(r.discoveryAvailable, false);
    assert.deepEqual(r.models, [], 'نماذج ملفّقة عند غياب الاكتشاف');
    assert.equal(r.retry, true, 'لا خيار إعادة محاولة');
    assert.match(r.note, /يدوياً/, 'لا توجيه لإدخال المعرّف يدوياً');
  } finally {
    await noModels.close();
  }
});

test('المادة 11: قائمة نماذج فارغة لا تُنتج نماذج وهمية', async () => {
  const empty = await fakeProvider({ 'GET /v1/models': () => ({ body: { object: 'list', data: [] } }) });
  try {
    const r = await GW.addProvider({ name: 'empty', baseUrl: empty.baseUrl, apiKey: 'k' });
    assert.equal(r.discoveryAvailable, false);
    assert.deepEqual(r.models, []);
  } finally {
    await empty.close();
  }
});

test('المادة 11: 401 لا يُعلن نجاحاً بأي شكل', async () => {
  const denied = await fakeProvider({ 'GET /v1/models': () => ({ status: 401, body: { error: { message: 'bad key' } } }) });
  try {
    const r = await GW.addProvider({ name: 'denied', baseUrl: denied.baseUrl, apiKey: 'sk-wrong' });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'connect');
    assert.match(r.error, /المصادقة/);
    assert.equal(r.connected, undefined, 'حقل connected ظهر مع فشل المصادقة');
    assert.ok(!JSON.stringify(r).includes('sk-wrong'), 'المفتاح ظهر في نتيجة الفحص');
  } finally {
    await denied.close();
  }
});

test('المادة 13: فشل المزود الأساسي لا يُرسل شيئاً لمزود آخر', async () => {
  const primary = await fakeProvider({ 'GET /v1/models': () => ({ status: 500, body: { error: { message: 'boom' } } }) });
  const secondary = await fakeProvider({ 'GET /v1/models': () => MODELS_OK });
  try {
    const r = await GW.addProvider({ name: 'primary', baseUrl: primary.baseUrl, apiKey: 'k1' });
    assert.equal(r.ok, false, 'فشل المزود الأساسي لم يُعلن');
    assert.equal(secondary.hits.length, 0, `تحويل تلقائي حصل: ${secondary.hits.join(', ')}`);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

// ─────────────────────────────────────────────────────────────────
// المادة 12 — قدرات مُثبتة، استهلاك بلا تخمين، تعطيل بلا حذف
// ─────────────────────────────────────────────────────────────────
test('المادة 12: القدرات تُسجّل من فحص فعلي لا من الاسم', async () => {
  const fake = await fakeProvider({
    'POST /v1/chat/completions': (b) => {
      if (Array.isArray(b.tools)) return { status: 400, body: { error: { message: 'no tools' } } };
      return genOk();
    },
  });
  try {
    const caps = await GW.probeCapabilities(fake.baseUrl, 'k', 'm-1');
    assert.deepEqual(caps, { longContext: true, tools: false, vision: true });
  } finally {
    await fake.close();
  }
});

test('المادة 12: تكلفة مجهولة تُسجّل null/unknown — لا تخمين', () => {
  const rows = [];
  const fakeDb = {
    prepare(sql) {
      assert.match(sql, /INSERT INTO model_usage/);
      return { run: (...args) => { rows.push(args); return { lastInsertRowid: 1 }; } };
    },
  };
  const unknown = GW.recordUsage(fakeDb, { provider: 'p', model: 'm', promptTokens: 10, completionTokens: 5 });
  assert.equal(unknown.cost, null, 'تكلفة مُخمّنة سُجّلت');
  assert.equal(unknown.source, 'unknown');
  assert.equal(rows[0][5], null);

  const trusted = GW.recordUsage(fakeDb, { provider: 'p', model: 'm', cost: 0.0021, source: 'provider' });
  assert.equal(trusted.cost, 0.0021);
  assert.equal(trusted.source, 'provider');
  assert.equal(rows[1][5], 0.0021);

  const guessed = GW.recordUsage(fakeDb, { provider: 'p', model: 'm', cost: 0.5, source: 'hand-wave' });
  assert.equal(guessed.source, 'unknown', 'مصدر تكلفة غير موثوق قُبل');
});

test('المادة 12: التعطيل يمنع الاختيار ويُبقي الإعداد', () => {
  const providers = [
    {
      name: 'off',
      enabled: false,
      apiKey: 'sk-off-key-9999',
      models: [{ id: 'vision-1', canGenerate: true, capabilities: { vision: true, tools: true, longContext: true } }],
    },
    {
      name: 'on',
      apiKey: 'sk-on-key-8888',
      models: [{ id: 'plain-1', canGenerate: true, capabilities: { vision: false, tools: false, longContext: true } }],
    },
  ];
  const pick = GW.pickModel(providers, 'vision');
  assert.equal(pick.error, 'لا يتوفر نموذج مؤهل للدور \'vision\' بقدرات مثبتة', 'اختار من مزود معطّل');

  const listed = GW.listProviders({ providers });
  assert.equal(listed.length, 2, 'المزود المعطّل حُذف من العرض');
  assert.equal(listed[0].enabled, false, 'حالة التعطيل لم تُعرض');
  assert.equal(listed[1].enabled, true);
  for (const p of listed) {
    // المقنّع يعرض أطرافاً لا المفتاح: لا تسلسل كامل ولا أرقام الذيل كاملة
    assert.ok(p.apiKey.includes('...'), `مفتاح غير مُقنّع: ${p.apiKey}`);
    assert.ok(!p.apiKey.includes('9999') && !p.apiKey.includes('8888'), `إفشاء مفتاح: ${p.apiKey}`);
  }
});

test('المادة 12: نموذج بقدرات مجهولة (null) لا يُختار لدور يطلب قدرة', () => {
  const providers = [{ name: 'p', models: [{ id: 'unknown-1', canGenerate: true, capabilities: null }] }];
  const r = GW.pickModel(providers, 'code');
  assert.ok(r.error, 'اختار نموذجاً قدراته مجهولة');
  const ok = GW.pickModel(
    [{ name: 'p', models: [{ id: 'ok-1', canGenerate: true, capabilities: { tools: true, vision: false, longContext: true } }] }],
    'code'
  );
  assert.equal(ok.model, 'ok-1');
  assert.equal(ok.provider, 'p');
});

test('المادة 15: المفتاح لا يُعاد كاملاً ولا يظهر في رسائل الخطأ', () => {
  const full = 'sk-live-abcdef1234567890';
  const masked = GW.maskKey(full);
  assert.ok(!masked.includes(full));
  assert.ok(masked.length < full.length);
  assert.equal(GW.maskKey(''), '');
  assert.equal(GW.maskKey('short'), '****');
});
