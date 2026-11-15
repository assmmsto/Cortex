'use strict';
const i18n = require('./cortex-i18n');

/**
 * Cortex — بوابة النماذج (Model Gateway)
 * طبقة مستقلة تختار النموذج وتدير الاتصال والتوافق والحدود والأخطاء.
 * لا ربط بمزود واحد؛ لا بيانات مشروع ترسل — فقط رسائل فحص صغيرة.
 * المفاتيح لا تُسجّل ولا تُعاد كاملة أبداً (§15).
 */

const DEFAULT_TIMEOUT_MS = 10000;

// سقف مسح النماذج عند الاكتشاف التلقائي — بلا سقف يتجمّد نداء الإضافة على بوابات كبيرة
const MAX_PROBED_MODELS = 10;

// بروتوكولات خطرة مرفوضة صراحة
const DANGEROUS_PROTOCOLS = ['file:', 'ftp:', 'javascript:', 'data:'];

// ---- أدوات مشتركة ----

// تنسيق الخطأ دون كشف المفتاح
function safeError(err) {
  if (!err) return 'خطأ غير معروف';
  if (err.name === 'AbortError') return 'انتهت المهلة';
  const msg = typeof err.message === 'string' ? err.message : String(err);
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

// طلب شبكة موحّد مع مهلة وإجهاض
async function request(url, { method = 'GET', apiKey, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return { res };
  } catch (err) {
    return { error: safeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

// قراءة JSON بأمان
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---- 1) التحقق من صحة العنوان ----

function validateUrl(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: 'العنوان فارغ' };
  if (typeof raw !== 'string') return { ok: false, error: 'العنوان يجب أن يكون نصاً' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'العنوان فارغ' };

  const lower = trimmed.toLowerCase();
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto)) return { ok: false, error: `بروتوكول خطير مرفوض: ${proto}` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'صيغة العنوان غير صحيحة' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `بروتوكول غير مدعوم: ${parsed.protocol}` };
  }
  if (!parsed.hostname) return { ok: false, error: 'العنوان بلا مضيف' };

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // 169.254.x.x — link-local مرفوض
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return { ok: false, error: 'عنوان link-local داخلي مرفوض (169.254.x.x)' };
  }
  // نطاقات IPv6 المحلية/الرابطية مرفوضة
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fec0:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:') ||
    host === '::'
  ) {
    return { ok: false, error: 'عنوان IPv6 محلي/رابطي مرفوض' };
  }

  // تطبيع: إزالة الشرطة المائلة الأخيرة
  const normalized = trimmed.replace(/\/+$/, '');
  return { ok: true, url: normalized };
}

// ---- 2) اختبار الاتصال ----

async function probeConnection(baseUrl, apiKey, opts = {}) {
  const started = Date.now();
  const check = validateUrl(baseUrl);
  if (!check.ok) return { ok: false, error: check.error, latencyMs: 0 };

  const url = `${check.url}/models`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const { res, error } = await request(url, { method: 'GET', apiKey, timeoutMs });
  const latencyMs = Date.now() - started;

  if (error) return { ok: false, error: `فشل الشبكة: ${error}`, latencyMs };

  const status = res.status;
  if (status === 401 || status === 403) {
    /* سبب الرفض الحقيقي من المزود، لا تخمين (§10). 403 ليس دائماً «مفتاح خاطئ»:
       ثبت حياً 2026-11-05 على tokenharbor.ai — المفتاح صالح والتوليد يعمل، لكن
       /v1/models يُرفض بـ 403 {code:"email_verification_required"}. رسالة
       «تحقق من مفتاح API» كانت تُرسل المستخدم للتحقق من شيء سليم. */
    const detail = await readJson(res);
    const message = detail && detail.error && (detail.error.message || detail.error.type);
    const code = detail && detail.error && detail.error.code;
    return {
      ok: false,
      status,
      code: code || undefined,
      providerError: message ? String(message) : undefined,
      /* الصياغة المعتمدة «فشل المصادقة» تبقى (اختبار + عقد UX)، ويُلحق بها سبب
         المزود الحقيقي: 403 قد يعني «وثّق بريدك» لا مفتاحاً خاطئاً. */
      error: message
        ? `فشل المصادقة — تحقق من مفتاح API (رفض المزود ${status}: ${message})`
        : 'فشل المصادقة — تحقق من مفتاح API',
      latencyMs,
    };
  }
  if (status === 404) {
    return { ok: false, status, error: 'النقطة /models غير متوفرة (404)', latencyMs };
  }
  if (status < 200 || status >= 300) {
    /* سبب المزود يُقرأ من جسم الاستجابة ويُعرض بصياغة مفهومة:
       402 = رصيد غير كافٍ، 429 = تجاوز حد المعدل، 5xx = خطأ عند المزود. */
    const detail = await readJson(res);
    const message = (detail && detail.error && (detail.error.message || detail.error.type || detail.error.code)) || '';
    const known = {
      400: 'طلب غير صالح عند المزود',
      402: 'رصيد المزود غير كافٍ',
      408: 'انتهت مهلة المزود',
      429: 'تجاوزت حد المعدل لدى المزود',
    };
    const label = known[status] || (status >= 500 ? 'خطأ عند المزود' : 'استجابة غير متوقعة');
    return {
      ok: false,
      status,
      providerError: message || undefined,
      error: message ? `${label} (${status}: ${message})` : `${label} (${status})`,
      latencyMs,
    };
  }
  // نجاح حقيقي بإجابة فعلية
  return { ok: true, status, latencyMs };
}

// ---- 3) اكتشاف النماذج ----

const NO_DISCOVERY = {
  ok: false,
  models: [],
  discoveryAvailable: false,
  error: 'واجهة اكتشاف النماذج غير متاحة',
};

async function discoverModels(baseUrl, apiKey, opts = {}) {
  const check = validateUrl(baseUrl);
  if (!check.ok) {
    return { ok: false, models: [], discoveryAvailable: false, error: check.error };
  }

  const url = `${check.url}/models`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const { res, error } = await request(url, { method: 'GET', apiKey, timeoutMs });
  if (error) {
    return { ok: false, models: [], discoveryAvailable: false, error: `فشل الشبكة: ${error}` };
  }
  if (res.status === 404) return { ...NO_DISCOVERY };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, models: [], discoveryAvailable: false, error: 'فشل المصادقة — تحقق من مفتاح API' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, models: [], discoveryAvailable: false, error: `استجابة غير متوقعة (${res.status})` };
  }

  const data = await readJson(res);
  const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : null;
  if (!list) return { ...NO_DISCOVERY };

  const models = list
    .filter((m) => m && typeof m.id === 'string' && m.id.trim() !== '')
    .map((m) => {
      const entry = { id: m.id };
      if (typeof m.owned_by === 'string') entry.owned_by = m.owned_by;
      return entry;
    });

  if (models.length === 0) return { ...NO_DISCOVERY };
  return { ok: true, models, discoveryAvailable: true };
}

// ---- 4) اختبار التوليد (نجاح الاتصال ≠ القدرة على التوليد) ----

async function probeGeneration(baseUrl, apiKey, modelId, opts = {}) {
  const check = validateUrl(baseUrl);
  if (!check.ok) return { reachable: false, canGenerate: false, error: check.error };

  const url = `${check.url}/chat/completions`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  /* 64 لا 5: نماذج التفكير (reasoning) تستهلك الميزانية في التفكير فيرجع content=null،
     فيُرفض مزود سليم. مُقاس 2026-11-07 على inceptionlabs: mercury-3 يرد 200 بلا نص عند 5 رموز. */
  const body = { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 64 };
  /* إعادة محاولة واحدة عند 429 (إصلاح 2026-11-13): مزودون يفرضون سقف تزامن
     ويردّون model_concurrency — وهذا «مشغول» لا «معطوب». بلا إعادة محاولة
     يُصنَّف نموذج سليم غير قابل للاستخدام بسبب لحظة ازدحام. */
  let res = null;
  let error = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ({ res, error } = await request(url, { method: 'POST', apiKey, body, timeoutMs }));
    if (error || !res || res.status !== 429) break;
    if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
  }

  // فشل الشبكة = غير قابل للوصول أصلاً
  if (error) return { reachable: false, canGenerate: false, error: `فشل الشبكة: ${error}` };

  // الخدمة ردّت فعلًا → reachable true
  const data = await readJson(res);
  if (res.status < 200 || res.status >= 300) {
    const detailRaw = data && data.error && (data.error.message || data.error.type || data.error);
    const detail = detailRaw == null ? '' : (typeof detailRaw === 'string' ? detailRaw : JSON.stringify(detailRaw).slice(0, 200));
    return {
      reachable: true,
      canGenerate: false,
      error: detail ? `خطأ المزود: ${detail}` : `استجابة خطأ (${res.status})`,
    };
  }
  /* دليل التوليد: رسالة مساعد سليمة — نص، أو تفكير (reasoning_details)، أو نداء أداة.
     الاعتماد على «نص غير فارغ» وحده كان يرفض نماذج التفكير السليمة.
     إصلاح 2026-11-13 (عطل مقيس على مزود vLLM حقيقي: Dahl/GLM-5.3): بعض المزودين
     يُعيدون `reasoning` كنص مفرد لا `reasoning_details` كمصفوفة، فكان نموذج يعمل
     فعلاً (أثبتّ محادثة معه) يُصنَّف canGenerate=false ويُستبعد من الاختيار. */
  const choice = data && data.choices && data.choices[0];
  const msg = choice && choice.message;
  const content = msg ? msg.content : undefined;
  const reasoned = !!(msg && (
    (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length)
    || (typeof msg.reasoning === 'string' && msg.reasoning.trim())
  ));
  const calledTool = !!(msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length);
  const piece = choice && typeof choice.text === 'string' ? choice.text.trim() : '';
  if ((typeof content === 'string' && content.trim()) || reasoned || calledTool || piece) {
    return { reachable: true, canGenerate: true };
  }
  return { reachable: true, canGenerate: false, error: 'استجابة بلا محتوى مُنتَج' };
}

// ---- 5) إثبات القدرات باختبار فعلي (§12) ----

const VISION_PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

async function probeCapabilities(baseUrl, apiKey, modelId, opts = {}) {
  const check = validateUrl(baseUrl);
  if (!check.ok) return { longContext: false, tools: false, vision: false };

  const url = `${check.url}/chat/completions`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  // يرسل طلباً ويعيد true فقط إن قُبل بلا خطأ
  async function accepts(body) {
    try {
      const { res, error } = await request(url, { method: 'POST', apiKey, body, timeoutMs });
      if (error) return false;
      if (res.status < 200 || res.status >= 300) return false;
      const data = await readJson(res);
      if (!data) return false;
      const hasChoice = Array.isArray(data.choices) && data.choices.length > 0;
      if (!hasChoice) {
        // خطأ صريح داخل جسم الاستجابة
        if (data.error) return false;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // الأدوات: يُقبل إن لم يُرفض بـ 400
  const tools = await accepts({
    model: modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 5,
    tools: [
      {
        type: 'function',
        function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
      },
    ],
  });

  // السياق الطويل: رسالة ~8000 حرف
  const longText = 'a'.repeat(8000);
  const longContext = await accepts({
    model: modelId,
    messages: [{ role: 'user', content: longText }],
    max_tokens: 5,
  });

  // الرؤية: محتوى من نوع مصفوفة مع صورة
  const vision = await accepts({
    model: modelId,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'ping' }, { type: 'image_url', image_url: { url: VISION_PIXEL } }],
      },
    ],
    max_tokens: 5,
  });

  return { longContext, tools, vision };
}

// ---- 6) إضافة مزود بالتسلسل الإلزامي (§10) ----

// نتيجة غياب الاكتشاف: المزود سليم لكن يتطلب إدخال النموذج يدوياً (§11)
function noDiscoveryResult(name) {
  return {
    ok: true,
    provider: name,
    connected: true,
    discoveryAvailable: false,
    models: [],
    note: 'المزود لا يتيح اكتشاف النماذج — أدخل معرّف النموذج يدوياً',
    retry: true,
    testedAt: new Date().toISOString(),
  };
}

// فحص قائمة معرّفات نماذج معطاة: توليد فعلي + قدرات. يُستعمل للاكتشاف التلقائي
// وللإدخال اليدوي معاً (مزود يقفل /models ويخدم /chat/completions).
async function probeModelList(baseUrl, apiKey, ids, opts = {}) {
  const runCapabilities = opts.probeCapabilities !== false;
  const tested = [];
  for (const id of ids) {
    const gen = await probeGeneration(baseUrl, apiKey, id, opts);
    // استبعاد أي نموذج غير قابل للوصول
    if (!gen.reachable) continue;
    const capabilities = runCapabilities
      ? await probeCapabilities(baseUrl, apiKey, id, opts)
      : { longContext: null, tools: null, vision: null }; // مجهولة صراحةً، لا false
    tested.push({ id, reachable: true, canGenerate: gen.canGenerate, capabilities, error: gen.canGenerate ? undefined : gen.error });
  }
  return tested;
}

// مزود سليم بلا اكتشاف: يُسجَّل بمعرّفات النماذج المُدخلة بعد إثبات التوليد (§11)
function manualResult(name, tested, note) {
  return {
    ok: true,
    provider: name,
    connected: true,
    discoveryAvailable: false,
    manualModels: true,
    models: tested,
    note,
    retry: true,
    testedAt: new Date().toISOString(),
  };
}

async function addProvider({ name, baseUrl, apiKey, models: manualModels } = {}, opts = {}) {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return { ok: false, step: 'validate', error: i18n.T('اسم المزود مطلوب', 'Provider name is required') };
  }

  const check = validateUrl(baseUrl);
  if (!check.ok) return { ok: false, step: 'validate', error: check.error };

  // قائمة نماذج يدوية اختيارية — الحل حين يقفل المزود نقطة الاكتشاف (§11)
  const manual = (Array.isArray(manualModels) ? manualModels : [])
    .map((m) => String(m == null ? '' : m).trim())
    .filter(Boolean);

// 2 اختبار الاتصال — 404 تعني أن الخدمة ردّت لكن بلا نقطة /models، فهي غياب اكتشاف لا فشل اتصال (§11)
  const conn = await probeConnection(check.url, apiKey, opts);

  /* معرّفات صريحة: تُفحص وحدها. سببان مقاسان على tokenharbor.ai (2026-11-05):
     (أ) /v1/models قد يُرفض 403 («وثّق بريدك») والتوليد يعمل بالمفتاح نفسه؛
     (ب) البوابة تعلن 77 نموذجاً، ومسحها كلها بتوليد+قدرات ≈ 300 طلب → نداء الإضافة
         لا يعود أبداً. المعرّف الصريح يجعل الإضافة ثوانٍ ومقصودة. */
  if (manual.length) {
    const tested = await probeModelList(check.url, apiKey, manual, opts);
    if (tested.length === 0) {
      const reached = conn.ok || conn.status === 404;
      return {
        ok: false,
        step: reached ? 'generate' : 'connect',
        error: reached ? i18n.T('لم يثبت التوليد لأي معرّف نموذج مُدخل', 'None of the supplied model ids proved generation') : conn.error,
        code: conn.code,
        latencyMs: conn.latencyMs,
      };
    }
    return { ...manualResult(name, tested, i18n.T('فُحصت المعرّفات المُدخلة يدوياً فقط', 'Only the supplied model ids were probed')), discoveryAvailable: conn.ok };
  }

  if (!conn.ok && conn.status !== 404) {
    return { ok: false, step: 'connect', error: conn.error, code: conn.code, latencyMs: conn.latencyMs };
  }
  if (conn.status === 404) return noDiscoveryResult(name);

  // 3 محاولة الاكتشاف
  const disc = await discoverModels(check.url, apiKey, opts);
  if (!disc.discoveryAvailable) return noDiscoveryResult(name);

  /* 4 فحص النماذج المكتشفة — بسقف. إثبات القدرات يكفي لعيّنة، والقائمة الكاملة
     تبقى معروضة للإضافة الصريحة. بلا سقف: 77 نموذجاً × 4 طلبات = تجميد النداء. */
  const probeIds = disc.models.slice(0, MAX_PROBED_MODELS).map((m) => m.id);
  const tested = await probeModelList(check.url, apiKey, probeIds, opts);
  const ownedBy = new Map(disc.models.map((m) => [m.id, m.owned_by]));
  for (const m of tested) {
    const owner = ownedBy.get(m.id);
    if (typeof owner === 'string') m.owned_by = owner;
  }

  /* بوابة تعلن نماذج لا يخدمها الحساب (tokenharbor.ai: 77 نموذجاً و73 منها ترد
     402 «لا خطة نشطة» — المتاح أربعة بمعرّف :free في آخر القائمة). بلا هذا الفحص
     يُسجَّل مزود بلا نموذج قابل للتوليد ثم يفشل كل نداء لاحق بلا سبب واضح. */
  if (!tested.some((m) => m.canGenerate === true)) {
    return {
      ok: false,
      step: 'generate',
      error: i18n.T(
        `لم يثبت التوليد لأي نموذج من ${probeIds.length} فُحصت (المزود يعلن ${disc.models.length}) — أدخل معرّف النموذج صراحةً`,
        `No probed model proved generation (${probeIds.length} of ${disc.models.length} announced) — supply a model id`
      ),
      models: tested,
      discoveredCount: disc.models.length,
    };
  }

  return {
    ok: true,
    provider: name,
    connected: true,
    discoveryAvailable: true,
    models: tested,
    discoveredCount: disc.models.length,
    note: disc.models.length > probeIds.length
      ? i18n.T(`فُحص ${probeIds.length} من ${disc.models.length} نموذجاً — أضف معرّف النموذج صراحةً لفحص غيره`, `Probed ${probeIds.length} of ${disc.models.length} models — supply a model id to probe another`)
      : undefined,
    testedAt: new Date().toISOString(),
  };
}

// ---- 8) إخفاء المفتاح ----

function maskKey(key) {
  if (typeof key !== 'string' || key === '') return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-2)}`;
}

// ---- 7) عرض المزودين بإخفاء المفاتيح ----

function listProviders(settings) {
  const raw = settings && (settings.providers || settings);
  if (!raw || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  return entries
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ? maskKey(p.apiKey) : '',
      enabled: p.enabled !== false,
      models: Array.isArray(p.models) ? p.models : [],
      /* القدرات المفحوصة تُعرض أيضاً: بلا هذا لا تعرف الواجهة أن النموذج بلا رؤية
         إلا بعد فشل الاستخدام (عطل UX 2026-11-05). */
      modelsInfo: Array.isArray(p.modelsInfo)
        ? p.modelsInfo.map((m) => ({ id: m && m.id, canGenerate: !!(m && m.canGenerate === true), capabilities: (m && m.capabilities) || null }))
        : [],
    }));
}

// ---- 9) تسجيل الاستهلاك ----

const USAGE_SOURCES = ['provider', 'estimated', 'unknown'];

/**
 * تقدير التكلفة — من **أسعار معلَنة صراحةً** فقط (م12: «عند توفر بيانات موثوقة»).
 * عطل مُصلَح 2026-10-29: كان المسار الحي في server.js ينادي دالة تقدير غير موجودة
 * في أي ملف (`privacyMod?.estimateCost`) فتبقى التكلفة null أبداً. القاعدة هنا:
 * بلا سعر معلن (inPer1k/outPer1k من إعداد المستخدم) أو بلا رموز معلومة => null،
 * لا جدول أسعار مفترضاً في الكود — منع التخمين.
 */
function estimateCost(pricing, promptTokens, completionTokens) {
  // انتبه: Number(null) === 0 — لا Number() مباشرة على غياب (خطأ أُمسك باختبار)
  const rate = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const inRate = rate(pricing && pricing.inPer1k);
  const outRate = rate(pricing && pricing.outPer1k);
  const hasIn = Number.isFinite(inRate);
  const hasOut = Number.isFinite(outRate);
  if (!hasIn && !hasOut) return null;
  const p = Number.isFinite(promptTokens) ? promptTokens : 0;
  const c = Number.isFinite(completionTokens) ? completionTokens : 0;
  if (!p && !c) return null;
  return (p / 1000) * (hasIn ? inRate : 0) + (c / 1000) * (hasOut ? outRate : 0);
}

function recordUsage(db, { provider, model, promptTokens, completionTokens, cost, source, purpose, ok } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('قاعدة بيانات غير صالحة');

  const hasTrustedCost = typeof cost === 'number' && Number.isFinite(cost);
  const finalCost = hasTrustedCost ? cost : null; // ممنوع التخمين
  const finalSource = hasTrustedCost && USAGE_SOURCES.includes(source) ? source : 'unknown';

  const stmt = db.prepare(
    `INSERT INTO model_usage (provider, model, at, prompt_tokens, completion_tokens, cost, source, purpose, ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(
    provider === undefined ? null : provider,
    model === undefined ? null : model,
    new Date().toISOString(),
    Number.isFinite(promptTokens) ? promptTokens : null,
    Number.isFinite(completionTokens) ? completionTokens : null,
    finalCost,
    finalSource,
    purpose === undefined || purpose === null ? null : String(purpose).slice(0, 40),
    ok === undefined || ok === null ? null : (ok ? 1 : 0)
  );
  return { id: result && result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : null, cost: finalCost, source: finalSource };
}

// ---- 10) اختيار النموذج حسب القدرة المثبتة ----

const ROLE_REQUIREMENTS = {
  plan: (m) => m.canGenerate === true,
  code: (m) => m.canGenerate === true && m.capabilities && m.capabilities.tools === true,
  vision: (m) => m.canGenerate === true && m.capabilities && m.capabilities.vision === true,
};

function pickModel(providers, role) {
  const req = ROLE_REQUIREMENTS[role];
  if (!req) return { error: `دور غير معروف: ${role}` };
  if (!Array.isArray(providers)) return { error: 'قائمة المزودين غير صالحة' };

  // نقبل شكلين: قائمة مزودين يحمل كل منهم models، أو قائمة نماذج مباشرة.
  const flat = [];
  for (const entry of providers) {
    if (!entry || entry.enabled === false) continue;
    if (Array.isArray(entry.models)) {
      for (const m of entry.models) {
        if (m) flat.push({ model: m, providerName: entry.name !== undefined ? entry.name : entry.provider });
      }
    } else if (typeof entry.id === 'string') {
      flat.push({ model: entry, providerName: entry.provider || null });
    }
  }

  for (const { model: m, providerName } of flat) {
    // لا نختار نموذجاً قدراته مجهولة (null) لدور يطلب قدرة
    if (!m.capabilities) continue;
    if (req(m)) {
      return {
        model: m.id,
        provider: providerName,
        reason: `موديل مطابق للدور '${role}' بقدرات مُثبتة اختبارياً`,
      };
    }
  }
  return { error: `لا يتوفر نموذج مؤهل للدور '${role}' بقدرات مثبتة` };
}

module.exports = {
  validateUrl,
  probeConnection,
  discoverModels,
  probeGeneration,
  probeCapabilities,
  addProvider,
  listProviders,
  maskKey,
  estimateCost,
  recordUsage,
  pickModel,
};
