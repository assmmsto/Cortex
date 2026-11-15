'use strict';
/**
 * Cortex — بوابة الصلاحيات الموحّدة (Constitution §35–§38)
 *
 * تصنيف واحد لكل أداة. لا أداة تُنفَّذ خارج هذا الجدول.
 * الفحوص الحتمية هنا تُنفَّذ بالكود، لا بالنموذج — دستور §35.
 */

// مستويات التنفيذ: read < propose < write < execute
const LEVELS = { read: 0, propose: 1, write: 2, execute: 3 };

// النطاقات: أين تعمل الأداة
const SCOPES = ['vault', 'filesystem', 'repo', 'sandbox', 'models', 'mcp'];

/**
 * جدول الصلاحيات — المصدر الوحيد للحقيقة.
 * level        : أدنى صلاحية مطلوبة
 * scope        : النطاق الذي تعمل ضمنه
 * needsPath    : تتطلب مساراً صريحاً
 * alwaysDraft  : تُسجَّل مسودة حتى في الوضع المستقل
 * allowlist    : تمر عبر قائمة الأوامر البيضاء
 * limitKey     : مفتاح الميزانية اليومية
 */
const TOOL_POLICY = Object.freeze({
  // ── قراءة المعرفة (vault) ──
  search_notes:        { level: 'read',    scope: 'vault' },
  get_note:            { level: 'read',    scope: 'vault' },
  list_tasks:          { level: 'read',    scope: 'vault' },
  project_state:       { level: 'read',    scope: 'vault' },
  find_gaps:           { level: 'read',    scope: 'vault' },
  find_contradictions: { level: 'read',    scope: 'vault' },
  summarize_document:  { level: 'read',    scope: 'vault' },
  resolve_reference:   { level: 'read',    scope: 'vault' },
  suggest_links:       { level: 'read',    scope: 'vault' },
  use_skill:           { level: 'read',    scope: 'vault' },
  runs_list:           { level: 'read',    scope: 'vault' },
  budget_report:       { level: 'read',    scope: 'vault' },
  schedule_list:       { level: 'read',    scope: 'vault' },
  /* ── الاستيراد (2026-11-13) ──
     القراءة بلا مسار، والكتابة تحتاج مساراً. الاستيراد يُنشئ ملاحظات ⇒ write،
     فيصير مسودة تُعتمد في الوضع supervised ويُنفَّذ في auto — حوكمة قائمة لا مخترعة. */
  import_list:         { level: 'read',    scope: 'vault', needsPath: false },
  import_path:         { level: 'write',   scope: 'vault', needsPath: true  },
  import_url:          { level: 'write',   scope: 'vault', needsPath: false },

  /* ── الإدارة الذاتية للوكيل (خطة الاستوديو W4) ──
     عقد التوجيه: الوكيل يقترح، والتنفيذ لا يقع إلا عبر مسار الاعتماد الصريح
     (alwaysDraft في كل الأوضاع) — فلا يعدّل الوكيل جدوله أو يلغي تشغيلاً
     من تلقاء نفسه أبداً. */
  run_cancel:          { level: 'execute', scope: 'vault', alwaysDraft: true },
  schedule_add:        { level: 'execute', scope: 'vault', alwaysDraft: true },
  schedule_toggle:     { level: 'execute', scope: 'vault', alwaysDraft: true },
  schedule_remove:     { level: 'execute', scope: 'vault', alwaysDraft: true },

  // ── كتابة المعرفة (vault) ──
  create_note:         { level: 'write',   scope: 'vault', limitKey: 'vault' },
  append_tasks:        { level: 'write',   scope: 'vault', limitKey: 'vault' },
  append_section:      { level: 'write',   scope: 'vault', limitKey: 'vault' },
  living_note:         { level: 'write',   scope: 'vault', limitKey: 'vault' },
  extract_meeting_actions: { level: 'write', scope: 'vault', limitKey: 'vault' },
  link_note:           { level: 'propose', scope: 'vault' }, // دائماً مسودة — دستور §38

  // ── الملفات (خارج الـ vault) ──
  fs_list:   { level: 'read',  scope: 'filesystem', needsPath: true },
  fs_read:   { level: 'read',  scope: 'filesystem', needsPath: true },
  fs_stat:   { level: 'read',  scope: 'filesystem', needsPath: true },
  fs_search: { level: 'read',  scope: 'filesystem', needsPath: true },
  fs_write:  { level: 'write', scope: 'filesystem', needsPath: true, alwaysDraft: true, limitKey: 'fs' },
  fs_edit:   { level: 'write', scope: 'filesystem', needsPath: true, alwaysDraft: true, limitKey: 'fs' },
  fs_mkdir:  { level: 'write', scope: 'filesystem', needsPath: true, alwaysDraft: true, limitKey: 'fs' },

  // ── المستودعات ──
  repo_index:   { level: 'read', scope: 'repo', needsPath: true },
  repo_tree:    { level: 'read', scope: 'repo', needsPath: true },
  repo_deps:    { level: 'read', scope: 'repo', needsPath: true },
  repo_impact:  { level: 'read', scope: 'repo', needsPath: true },
  // تعداد المستودعات المفهرسة: قراءة قاعدة الطبقة، بلا مسار ⇒ needsPath=false
  repo_list:    { level: 'read', scope: 'repo', needsPath: false },  git_status:   { level: 'read', scope: 'repo', needsPath: true },
  git_log:      { level: 'read', scope: 'repo', needsPath: true },
  git_diff:     { level: 'read', scope: 'repo', needsPath: true },

  /* ── ذاكرة المشاريع لوكلاء البناء (الهدفان 2026-10-28) ──
     absorb يكتب ملاحظة خريطة مشتقة حتمياً من المصدر (لا يمسّ المصدر نفسه).
     slice قراءة تخدم الرد؛ احتضانها التلقائي كتابة مشتقة كذلك — ولهذا read.
     المسير: قراءة حرة، وتسجيل الخطوة كتابة idempotent (إلحاق بسقف). */
  project_absorb: { level: 'write', scope: 'repo', needsPath: true },
  memory_slice:   { level: 'read',  scope: 'repo' },
  project_trail:  { level: 'read',  scope: 'repo' },
  trail_append:   { level: 'write', scope: 'repo' },

  // ── التنفيذ (sandbox) ──
  shell_exec:      { level: 'execute', scope: 'sandbox', alwaysDraft: true, allowlist: true, limitKey: 'exec' },
  run_tests:       { level: 'execute', scope: 'sandbox', alwaysDraft: true, limitKey: 'exec' },
  read_test_result:{ level: 'read',    scope: 'sandbox' },

  // ── الاستيراد ──
  import_file: { level: 'write', scope: 'vault', needsPath: true, limitKey: 'import' },
  import_repo: { level: 'write', scope: 'vault', needsPath: true, alwaysDraft: true, limitKey: 'import' },

  // ── بوابة النماذج ──
  list_providers: { level: 'read', scope: 'models' },
  probe_model:    { level: 'read', scope: 'models' }
});

// ── القائمة البيضاء للأوامر — دستور §37 ──
const ALLOWED_COMMANDS = Object.freeze(new Set([
  'git', 'node', 'npm', 'npx', 'python', 'python3', 'py',
  'pytest', 'ls', 'dir', 'cat', 'type', 'find', 'grep',
  'wc', 'head', 'tail', 'echo', 'where', 'which'
]));

// محارف تفسير الصدفة — تُرفض دائماً (منع حقن الأوامر)
const SHELL_METACHARS = /[;&|`$(){}<>\n\r\\]/;

/**
 * §37 — أدوات التنفيذ العامة **ليست** مشغّلات كود حرّ.
 * العطل المُثبت حياً 2026-10-20 (أخطر ثغرة في التقرير): `node script.js` كان يمرّ
 * من القائمة البيضاء بحجّة أن `node` مسموح، والسكربت المُنفَّذ يملك كامل حرية نظام
 * الملفات — فكُتب ملف في `C:\Windows\Temp` (خارج الجذور) عبر سكربت وُضع داخل الجذر.
 * القاعدة الآن: المشغّلات (`node`/`python`/`py`) مسموحة **فقط** لتشغيل ملف سكربت
 * حقيقي **داخل الجذور المسموحة**، وممنوعة مع أي معامل تنفيذ حرّ (`-e`, `-c`, `--eval`,
 * `-m`, `-p`, `--require`, `-r`, `--import`, `-`…). وباقي الأدوات (تُحرَّر مساراتها)
 * لا يجوز أن تشير خارج الجذور — بما فيها `git` الذي يقبل مساراً حراً (`git init <path>`).
 */
const CODE_RUNNERS = Object.freeze(new Set(['node', 'python', 'python3', 'py']));
// معاملات تجعل المشغّل ينفّذ نصّاً/وحدة بدل ملف — مرفوضة دائماً
const RUNNER_EVAL_ARGV = Object.freeze(new Set([
  '-e', '--eval', '-c', '--command', '-m', '', '-p', '--print',
  '--require', '-r', '--import', '--loader', '--experimental-loader',
  '--eval-file', '--stdin', '-'
]));
// أدوات تقبل مساراً حرّاً كمُعامل أول (git init/submodule/--git-dir …)
const PATH_ARG_COMMANDS = Object.freeze(new Set(['git']));

/** يستخرج كل المعاملات التي تبدو مسارات من سطر الأمر (مطلقة أو صاعدة أو بامتداد). */
function pathLikeArgs(argv) {
  return (argv || []).filter(a => {
    const s = String(a);
    if (!s || s.startsWith('-')) return false;
    return /^([a-zA-Z]:[\\/]|[/\\]|\.\.?[/\\])/.test(s) || /[.][a-z0-9]{1,5}$/i.test(s) || s.includes('/') || s.includes('\\');
  });
}

/**
 * فحص إضافي فوق قائمة الأوامر — يحوّل «اسم برنامج مسموح» إلى «استخدام مسموح».
 * يُستدعى من runCommand بعد بناء argv. قرار حتمي بالكود، بلا نموذج (§35).
 * @param {string} program البرنامج (بعد التحقق من القائمة البيضاء)
 * @param {string[]} argv
 * @param {(p:string)=>{ok:boolean,path?:string,error?:string}} resolve مسار الحل الآمن
 */
function checkProgram(program, argv, resolve) {
  const prog = String(program || '').toLowerCase();
  const args = (argv || []).map(String);
  const resolvePath = typeof resolve === 'function' ? resolve : null;

  if (CODE_RUNNERS.has(prog)) {
    // المشغّل يجب أن يشغّل ملفاً واحداً داخل الجذور — لا نصّاً حرّاً
    const evalArg = args.find(a => RUNNER_EVAL_ARGV.has(a) || a === '-e' || a === '-c');
    if (evalArg !== undefined) {
      return { ok: false, reason: `مشغّل الكود «${prog}» ممنوع مع معامل التنفيذ الحرّ (${evalArg}) — شغّل ملف سكربت داخل الجذور` };
    }
    const script = args.find(a => !a.startsWith('-'));
    if (!script) {
      /* العطل المُقاس 2026-10-27: `node --test` (مشغّل الاختبارات الرسمي، بلا ملف)
         كان يُرفض «بلا ملف سكربت» — فكل تشخيص «الاختبارات لم تمر» كان كذباً على
         النظام لا على الكود. وضع --test مكتفٍ بذاته: يكتشف ملفات الاختبار تحت cwd،
         وصندوق الصلاحيات (--permission + الجذور) يبقى مطبقاً على العملية وأطفالها. */
      if (prog === 'node' && args.includes('--test')) return { ok: true, script: '--test' };
      return { ok: false, reason: `مشغّل الكود «${prog}» بلا ملف سكربت — مرفوض` };
    }
    if (resolvePath) {
      const r = resolvePath(script);
      if (!r || !r.ok) return { ok: false, reason: `سكربت «${prog}» خارج الجذور المسموحة: ${(r && r.error) || 'مرفوض'}` };
    }
    return { ok: true, script };
  }

  if (PATH_ARG_COMMANDS.has(prog) && resolvePath) {
    for (const a of pathLikeArgs(args)) {
      const r = resolvePath(a);
      if (!r || !r.ok) return { ok: false, reason: `مسار مرفوض في «${prog} ${a}»: ${(r && r.error) || 'خارج الجذور'}` };
    }
  }
  return { ok: true };
}

// ── الميزانيات اليومية ──
// العطل المُثبت حياً 2026-10-20: السقف كان 60 كتابة/يوم — فبعد جولة عمل عادية
// يُرفض كل كتابة بـ«daily limit reached for fs (60)»، وتبدو الواجهة معطّلة.
// كل مفتاح قابل للضبط عبر بيئة صريحة CORTEX_DAILY_<KEY> (مثال CORTEX_DAILY_FS=100000).
function _limitFromEnv(key, def) {
  try {
    const raw = process.env['CORTEX_DAILY_' + String(key).toUpperCase()];
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* بيئة غير متاحة */ }
  return def;
}
/* قراءة عدد صحيح من البيئة (لتجاوز الحدّ في الاختبارات أو خفضه في الإنتاج). */
function _envInt(name, def) {
  try {
    const n = Number(process.env[name]);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* بيئة غير متاحة */ }
  return def;
}

// ── الميزانيات اليومية ──
/* قرار المالك (2026-11-03): لا ميزانية يومية على المعرفة والملفات.
   السقوف القديمة (vault 200 · fs 500 · exec 100 · import 200) كانت ترفض كل
   كتابة بـ«daily limit reached» بعد جولة عمل عادية، والصفحة تبدو معطّلة بلا سبب.
   ما يحمي فعلاً موجود ومقيس تحت: بوابة السياسة (قراءة/كتابة/تنفيذ + نطاقات +
   مسودة إلزامية للخارجي)، جذور الملفات المسموحة، المهلة و SIGKILL، سقف المخرَج،
   وحدّ المعدّل أدناه. القيمة 0 = بلا سقف في evaluate. */
const DAILY_LIMITS = Object.freeze({
  vault:  _limitFromEnv('vault', 0),
  fs:     _limitFromEnv('fs', 0),
  exec:   _limitFromEnv('exec', 0),
  import: _limitFromEnv('import', 0)
});

/* ── حدّ معدّل الطلبات (2026-10-26) ──────────────────────────────────
   الثغرة المقيسة في التقرير الهجومي: 20 استيراداً سريعاً ⇒ 200×20 و429=0.
   السقف اليومي وحده لا يردع رشقة — يستهلك الميزانية كلها ثم يصمت. هنا نافذة
   منزلقة لكل صنف ولكل عميل، على المسارات المكلفة فقط (استيراد/تصدير/وكيل/
   نماذج) والكتابة فقط؛ القراءة والمسارات الخفيفة لا تُقيَّد. */
const RATE_BUDGETS = Object.freeze({
  import: Object.freeze({ limit: _envInt('CORTEX_RATE_IMPORT', 30), windowMs: 10000 }),
  export: Object.freeze({ limit: _envInt('CORTEX_RATE_EXPORT', 20), windowMs: 10000 }),
  agent:  Object.freeze({ limit: _envInt('CORTEX_RATE_AGENT', 30),  windowMs: 10000 }),
  ai:     Object.freeze({ limit: _envInt('CORTEX_RATE_AI', 30),     windowMs: 10000 }),
  models: Object.freeze({ limit: _envInt('CORTEX_RATE_MODELS', 60), windowMs: 10000 })
});

const _rateHits = new Map(); // `${bucket}|${client}` → [ts, ts, …]
let _rateCalls = 0;

/** هل يسمح ميزان الرشقة بهذا الطلب؟ يعيد {ok, limit, remaining, retryAfter}. */
function rateLimit(bucket, client = '-', now = Date.now()) {
  const budget = RATE_BUDGETS[bucket];
  if (!budget) return { ok: true, bucket: null, limit: 0, remaining: 0, retryAfter: 0 };
  const key = `${bucket}|${client}`;
  const hits = _rateHits.get(key) || [];
  const from = now - budget.windowMs;
  let start = 0;
  while (start < hits.length && hits[start] <= from) start++;
  if (start) hits.splice(0, start);
  if (hits.length >= budget.limit) {
    const retryAfter = Math.max(1, Math.ceil((hits[0] + budget.windowMs - now) / 1000));
    _rateHits.set(key, hits);
    return { ok: false, bucket, limit: budget.limit, remaining: 0, retryAfter, windowMs: budget.windowMs };
  }
  hits.push(now);
  _rateHits.set(key, hits);
  // تنظيف دوري بلا مؤقّت خلفي: كل 500 نداء نمحو المفاتيح الخالية.
  if (++_rateCalls % 500 === 0) {
    for (const [k, v] of _rateHits) if (!v.length) _rateHits.delete(k);
  }
  return { ok: true, bucket, limit: budget.limit, remaining: budget.limit - hits.length, retryAfter: 0, windowMs: budget.windowMs };
}

/** إعادة التهيئة — للاختبارات الحتمية فقط. */
function resetRateLimits() { _rateHits.clear(); _rateCalls = 0; }

function isAllowedCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return { ok: false, reason: 'empty command' };
  if (SHELL_METACHARS.test(raw)) return { ok: false, reason: 'shell metacharacter blocked' };
  const first = raw.split(/\s+/)[0].toLowerCase();
  if (!ALLOWED_COMMANDS.has(first)) return { ok: false, reason: `command not in allowlist: ${first}` };
  return { ok: true, program: first };
}

function levelAtLeast(actual, required) {
  return (LEVELS[actual] ?? -1) >= (LEVELS[required] ?? 99);
}

/**
 * تقييم السياسة — قرار حتمي بلا نموذج (دستور §35).
 * يعيد: allow | draft | refuse
 */
/**
 * §33 — الوضع لا يُصعَّد من الحمولة، ولا تُقبل قيمة غير معروفة.
 * العطل المُثبت حياً 2026-10-20: كان `evaluate` يعطي `allow` لأي قيمة ≠ 'supervised'،
 * فمرّت `autonomy:"full"` (وهي ليست في أي قائمة) وفتحت بوابة الاعتماد على مصراعيها.
 * القاعدة الآن: **قائمة بيضاء صارمة**. أي قيمة غير معروفة تُعامَل كـ`supervised`
 * (الأشدّ رقابة)، والدالة تُبلّغ عن التصيير كي يُسجَّل الرفض بدل أن يُبتلع صامتاً.
 */
const AUTONOMY_MODES = Object.freeze(['supervised', 'assisted', 'autonomous']);
function normalizeAutonomy(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (AUTONOMY_MODES.includes(v)) return { autonomy: v, coerced: false, requested: v };
  return { autonomy: 'supervised', coerced: true, requested: v };  // الأشدّ رقابة هو الملاذ
}

function evaluate({ tool, level, scope, allowedScopes, autonomy, dailyUsed = {}, path, caps = null }) {
  /* أدوات MCP (2026-11-13): أسماؤها ديناميكية mcp__<server>__<tool>، فلا يمكن
     حصرها في جدول ثابت. المواصفة مُشتقّة: قراءة + مسودة دائمة (§31). أي أداة
     MCP تبقى تحتاج اعتماداً صريحاً — لا تُنفَّذ من حلقة الوكيل مباشرة. */
  const spec = TOOL_POLICY[tool] || (String(tool || '').startsWith('mcp__')
    ? { level: 'read', scope: 'mcp', alwaysDraft: true }
    : null);
  // أي وضع غير معروف = supervised (§33). لا استنتاج، لا اجتهاد.
  const norm = normalizeAutonomy(autonomy);
  const autonomyCoerced = norm.coerced;
  autonomy = norm.autonomy;

  // أداة غير معرّفة = مرفوضة دائماً
  if (!spec) return { decision: 'refuse', reason: `unknown tool: ${tool}` };

  // الصلاحية الفعلية يجب أن تغطي مستوى الأداة
  if (!levelAtLeast(level, spec.level)) {
    return { decision: 'refuse', reason: `insufficient level: have ${level}, need ${spec.level}` };
  }

  // النطاق يجب أن يكون مصرّحاً للمهمة
  if (scope !== 'vault' && !(allowedScopes || []).includes(scope)) {
    return { decision: 'refuse', reason: `scope not granted: ${scope}` };
  }

  // المسارات: صريحة وإلزامية عند الطلب
  if (spec.needsPath && !String(path || '').trim()) {
    return { decision: 'refuse', reason: 'path is required for this tool' };
  }

  // الميزانية اليومية — السقف القابل للضبط من لوحة العقد (settings.agent.limits)
  // يتقدم على الافتراضي، والقيمة 0 تبقى «بلا سقف» كما في العقد الأصلي.
  if (spec.limitKey) {
    const override = caps && Number.isFinite(Number(caps[spec.limitKey])) ? Number(caps[spec.limitKey]) : null;
    const cap = override === null ? DAILY_LIMITS[spec.limitKey] : override;
    const used = Number(dailyUsed[spec.limitKey]) || 0;
    if (cap > 0 && used >= cap) {
      return { decision: 'refuse', reason: `daily limit reached for ${spec.limitKey} (${cap})` };
    }
  }

  // المسودة الإلزامية — دستور §38
  // أي أداة تمسّ ما هو خارج الـ vault، أو تنفّذ أمراً، تمرّ باعتماد صريح دائماً.
  // لا وجود لتنفيذ أو كتابة خارجية بلا موافقة بشرية — ولو كان الوضع «مستقلاً».
  if (spec.alwaysDraft) {
    return { decision: 'draft', reason: 'tool requires explicit approval', spec };
  }
  if (spec.level === 'propose') {
    return { decision: 'draft', reason: 'proposal tool always drafts', spec };
  }

  // الوضع الخاضع للإشراف — كل كتابة تصير مسودة
  if (autonomy === 'supervised' && spec.level !== 'read') {
    return { decision: 'draft', reason: 'supervised mode: write requires approval', spec };
  }

  const out = { decision: 'allow', spec };
  if (autonomyCoerced) {
    out.autonomyCoerced = true;
    out.reason = `autonomy '${norm.requested}' غير معروف → أُجبر supervised (§33)`;
  }
  return out;
}

// بصمة منع التكرار — دستور §36
function idempotencyKey(runId, tool, args) {
  const raw = `${runId}|${tool}|${JSON.stringify(args || {}, Object.keys(args || {}).sort())}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return `${runId}:${h.toString(16)}`;
}

module.exports = {
  AUTONOMY_MODES, normalizeAutonomy, checkProgram, CODE_RUNNERS, RUNNER_EVAL_ARGV, pathLikeArgs,
  TOOL_POLICY,
  LEVELS,
  SCOPES,
  ALLOWED_COMMANDS,
  DAILY_LIMITS,
  RATE_BUDGETS,
  rateLimit,
  resetRateLimits,
  isAllowedCommand,
  levelAtLeast,
  evaluate,
  idempotencyKey
};
