'use strict';
/**
 * Cortex — منسّق الوكلاء المتوازيين (دستور §24، §25، §33، §35، §36، §46/1)
 *
 * يحوّل هدفاً واحداً إلى مهام متخصصة بأدوار محدودة الصلاحيات، ينفّذها متوازياً
 * بحد أقصى صريح، يمنع التنفيذ المكرر عبر مفاتيح idempotency، ويحقّق في النتائج
 * بكود حتمي لا بنموذج.
 *
 * لا مكتبات خارجية: fs, path, crypto فقط.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
/* مفاتيح idempotency نفسها التي يستعملها الوكيل — لازمة لإعادة بناء «ما نُفّذ»
   عند الاستئناف من سجل التشغيل (لا سياسة جديدة هنا، نفس الدالة). */
const policy = require('./cortex-policy');

// ── حدود صريحة: لا حلقة بلا سقف — دستور «ممنوع حلقات لانهائية» ──
const MAX_ROUNDS = 200;        // سقف جولات حلقة الجدولة
const MAX_TASKS = 64;          // سقف عدد المهام الناتجة عن التقسيم

// ── الأدوار وصلاحياتها — كل دور محصور بنطاقه ولا يخرج عنه ──
// تجميد عميق: تجميد الكائن الخارجي وحده تجميد سطحي ويمكن الكتابة على الدور
const ROLES = deepFreeze({
  analyst:  { scopes: ['vault'],                                     description: 'قراءة وتحليل المعرفة',   canWrite: false },
  builder:  { scopes: ['vault', 'filesystem'],                       description: 'تنفيذ التعديلات',        canWrite: true },
  tester:   { scopes: ['sandbox', 'filesystem', 'repo'],             description: 'تشغيل الاختبارات',       canWrite: false },
  critic:   { scopes: ['vault', 'filesystem', 'repo'],               description: 'نقد الناتج وكشف الخلل',  canWrite: false },
  verifier: { scopes: ['vault', 'filesystem', 'sandbox', 'repo'],    description: 'التحقق المستقل',         canWrite: false },
  monitor:  { scopes: ['vault', 'repo'],                             description: 'مراقبة الإنتاجية والأدلة', canWrite: false }
});

// تجميد عميق متكرر — Object.freeze وحده سطحي
function deepFreeze(obj) {
  for (const k of Object.getOwnPropertyNames(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

// كلمات الكشف الحتمي عن نوع العمل المطلوب في الهدف
const WRITE_WORDS = ['عدّل', 'عدل', 'اكتب', 'أنشئ', 'انشئ', 'أضف', 'اضف', 'edit', 'write', 'create', 'add'];
const TEST_WORDS = ['اختبر', 'اختبار', 'شغّل', 'شغل', 'test', 'run'];

// معرّف تشغيل فريد: طابع زمني + عشوائي
function newRunId() {
  return `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ── تدقيق التبعيات: إسقاط المراجع المجهولة وكسر الحلقات — لا دورة تُترك ──
// تعيد { tasks, notes } حيث notes يشرح كل تعديل أُجري.
function sanitizeDependencies(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_TASKS) : [];
  const notes = [];
  const seenIds = new Set();

  // 1) إسقاط المهام بلا معرّف ومعرّفات مكررة
  const tasks = [];
  for (const t of list) {
    const id = String(t && t.id || '').trim();
    if (!id) { notes.push('dropped task without id'); continue; }
    if (seenIds.has(id)) { notes.push(`dropped duplicate task id: ${id}`); continue; }
    if (!ROLES[t.role]) { notes.push(`dropped task ${id}: unknown role ${t.role}`); continue; }
    seenIds.add(id);
    tasks.push({
      id,
      role: t.role,
      goal: String(t.goal == null ? '' : t.goal),
      dependsOn: Array.isArray(t.dependsOn) ? [...new Set(t.dependsOn.map(String))] : []
    });
  }

  // 2) إسقاط أي تبعية تشير إلى مهمة غير موجودة أو إلى المهمة نفسها
  const ids = new Set(tasks.map(t => t.id));
  for (const t of tasks) {
    const kept = t.dependsOn.filter(d => d !== t.id && ids.has(d));
    if (kept.length !== t.dependsOn.length) notes.push(`dropped dangling dependency on ${t.id}`);
    t.dependsOn = kept;
  }

  // 3) كسر الحلقات: حذف الحافة التي تغلق الدورة (كشف دوري حتمي)
  const state = new Map(); // id → 0 لم يُزر | 1 في المكدس | 2 انتهى
  const cyclesBroken = [];
  function visit(id) {
    state.set(id, 1);
    for (const dep of [...tasks.find(t => t.id === id).dependsOn]) {
      if (state.get(dep) === 1) { // حافة خلفية = دورة
        const t = tasks.find(x => x.id === id);
        t.dependsOn = t.dependsOn.filter(d => d !== dep);
        cyclesBroken.push(`${id}->${dep}`);
        continue;
      }
      if (state.get(dep) !== 2) visit(dep);
    }
    state.set(id, 2);
  }
  for (const t of tasks) if (state.get(t.id) !== 2) visit(t.id);
  if (cyclesBroken.length) notes.push(`broke dependency cycles: ${cyclesBroken.join(', ')}`);

  return { tasks, notes };
}

// ── التقسيم الحتمي بلا نموذج: يعمل دائماً ولو غاب المزوّد ──
function deterministicTasks(goal, runId) {
  const g = String(goal || '');
  const low = g.toLowerCase();
  const hasWrite = WRITE_WORDS.some(w => low.includes(w.toLowerCase()));
  const hasTest = TEST_WORDS.some(w => low.includes(w.toLowerCase()));

  // المعرّفات مشتقّة من runId — لأن id هو المفتاح الأساسي في agent_tasks،
  // فمعرّف ثابت يكسر كل تشغيل بعد الأول (تصادم UNIQUE يبتلع المهام بصمت).
  const t = n => `${runId}-t${n}`;

  // المسار: تحليل ← بناء ← (اختبار ∥ نقد) ← (تحقق ∥ مراقبة إنتاجية)
  // المرحلتان الأخيرتان تعملان بالتوازي فعلاً — لا تسلسل زائف.
  const tasks = [{ id: t(1), role: 'analyst', goal: `تحليل المعرفة المطلوبة للهدف: ${g}`, dependsOn: [] }];

  let last = t(1);
  if (hasWrite) {
    tasks.push({ id: t(2), role: 'builder', goal: `تنفيذ التعديلات المطلوبة: ${g}`, dependsOn: [t(1)] });
    last = t(2);
  }

  let testId = null, criticId = null;
  if (hasTest) {
    testId = t(3);
    tasks.push({ id: testId, role: 'tester', goal: `تشغيل الاختبارات وتحقق من عمل الناتج: ${g}`, dependsOn: [last] });
  }
  // الناقد يعمل بالتوازي مع المختبِر: ينقد الناتج ويكشف الخلل بالأدلة
  criticId = t(5);
  tasks.push({ id: criticId, role: 'critic', goal: `انقد ناتج العمل واكشف أي خلل أو نقص بالأدلة عبر أدواتك: ${g}`, dependsOn: [last] });

  // المرحلة الأخيرة: تحقق مستقل ∥ مراقبة إنتاجية (توازٍ حقيقي)
  const verifyDeps = [testId, criticId].filter(Boolean);
  tasks.push({ id: t(4), role: 'verifier', goal: `التحقق المستقل من كل نتائج الهدف وذكر الأدلة: ${g}`, dependsOn: verifyDeps });
  tasks.push({ id: t(6), role: 'monitor', goal: `راجع أثر التنفيذ وقِس الإنتاجية واذكر أي ادعاء بلا دليل: ${g}`, dependsOn: verifyDeps });

  return tasks;
}

/**
 * تقسيم الهدف إلى مهام بتبعيات.
 * يستدعي ctx.callModel إن وُجد (دالة محقونة — لا اتصال بمزوّد مباشرة)،
 * ويسقط حتمياً إلى deterministicTasks عند غيابه أو فشله.
 */
async function decompose(goal, ctx = {}) {
  const runId = ctx.runId || newRunId();
  let raw = null;
  const notes = [];

  if (typeof ctx.callModel === 'function') {
    try {
      const system = 'أنت مقسّم مهام. أعد JSON فقط: {"tasks":[{"id","role","goal","dependsOn":[]}]}';
      const user = `الأدوار المسموحة: ${Object.keys(ROLES).join(', ')}.\nالهدف: ${goal}`;
      const out = await ctx.callModel(system, user);
      const parsed = typeof out === 'string' ? JSON.parse(out) : out;
      if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length) raw = parsed.tasks;
      else notes.push('model returned no tasks; used deterministic split');
    } catch (e) {
      notes.push(`model split failed (${e.message}); used deterministic split`);
    }
  } else {
    notes.push('no callModel provided; used deterministic split');
  }

  const source = raw || deterministicTasks(goal, runId);
  const { tasks, notes: depNotes } = sanitizeDependencies(source);
  const finalTasks = tasks.length ? tasks : sanitizeDependencies(deterministicTasks(goal, runId)).tasks;
  return { runId, tasks: finalTasks, notes: [...notes, ...depNotes] };
}

// ── التحقق المستقل — بكود حتمي لا بنموذج (دستور §35، §46/1) ──
async function verifyClaims(claims, ctx = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const store = ctx.store || {};
  const results = [];

  for (const claim of list) {
    const c = claim || {};
    try {
      switch (c.type) {
        case 'file_exists': {
          const ok = !!c.path && fs.existsSync(String(c.path));
          results.push(ok
            ? { claim: c, verified: true, evidence: `file found: ${c.path}` }
            : { claim: c, verified: false, reason: c.path ? `file not found: ${c.path}` : 'path missing' });
          break;
        }
        case 'file_modified': {
          if (!c.path) { results.push({ claim: c, verified: false, reason: 'path missing' }); break; }
          let actual;
          try { actual = sha256(fs.readFileSync(String(c.path), 'utf8')); }
          catch (e) { results.push({ claim: c, verified: false, reason: `cannot read file: ${e.message}` }); break; }
          const expected = String(c.afterHash || '');
          if (!expected) { results.push({ claim: c, verified: false, reason: 'afterHash missing' }); break; }
          const ok = actual === expected && actual !== String(c.beforeHash || '');
          results.push(ok
            ? { claim: c, verified: true, evidence: `sha256=${actual}` }
            : { claim: c, verified: false, reason: expected === String(c.beforeHash || '') ? 'afterHash equals beforeHash — no change' : `hash mismatch (actual ${actual})` });
          break;
        }
        case 'note_exists': {
          if (typeof store.getNote !== 'function') { results.push({ claim: c, verified: false, reason: 'store.getNote unavailable' }); break; }
          const note = await store.getNote(c.id);
          results.push(note
            ? { claim: c, verified: true, evidence: `note id=${c.id}` }
            : { claim: c, verified: false, reason: `note not found: ${c.id}` });
          break;
        }
        case 'task_status': {
          if (typeof store.getTaskStatus !== 'function') { results.push({ claim: c, verified: false, reason: 'store.getTaskStatus unavailable' }); break; }
          const actual = await store.getTaskStatus(c.id);
          const ok = actual === c.expected;
          results.push(ok
            ? { claim: c, verified: true, evidence: `status=${actual}` }
            : { claim: c, verified: false, reason: `status is ${actual}, expected ${c.expected}` });
          break;
        }
        case 'tests_passed': {
          if (typeof c.runFn !== 'function') { results.push({ claim: c, verified: false, reason: 'runFn missing' }); break; }
          const r = await c.runFn();
          const ok = !!(r && r.ok);
          results.push(ok
            ? { claim: c, verified: true, evidence: r.evidence || 'runFn returned ok' }
            : { claim: c, verified: false, reason: (r && r.reason) || 'runFn did not return ok' });
          break;
        }
        default: {
          if (typeof ctx.modelCheck === 'function') {
            const r = await ctx.modelCheck(c);
            if (r && typeof r === 'object' && 'verified' in r) {
              results.push({ claim: c, verified: !!r.verified, evidence: r.evidence, reason: r.reason, knowledge_kind: r.verified ? 'verified' : 'inferred' });
            } else {
              const ok = r === true;
              results.push({ claim: c, verified: ok, ...(ok ? { evidence: 'modelCheck accepted' } : { reason: 'modelCheck rejected' }), knowledge_kind: ok ? 'verified' : 'inferred' });
            }
          } else {
            // نوع غير مدعوم بلا دليل حتمي: يُعلن غير متحقق صراحةً — لا ادعاء نجاح بلا دليل
            results.push({ claim: c, verified: false, reason: `unsupported claim type: ${c.type}`, unverified: true, knowledge_kind: 'inferred' });
          }
        }
      }
    } catch (e) {
      results.push({ claim: c, verified: false, reason: `verification threw: ${e.message}` });
    }
  }

  const verified = results.filter(r => r.verified).length;
  return { claims: list, verified, unverified: results.length - verified, results };
}

// ── الطابور الدائم: مهام + أحداث في SQLite (دستور §36) ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tasks(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  depends_on TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  idempotency_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_run ON agent_tasks(run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, id);
`;

const TERMINAL = new Set(['done', 'failed', 'blocked']);

/**
 * تنفيذ حقيقي لواجهة store على DatabaseSync.
 * openDb(pathOrDb): مسار ملف، أو ':memory:'، أو كائن db قائم.
 */
function createStore(openDb = ':memory:') {
  const isConn = openDb && typeof openDb.prepare === 'function' && typeof openDb.exec === 'function';
  const source = isConn ? openDb : String(openDb || ':memory:');
  if (!isConn && source !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(source)), { recursive: true });
  const db = isConn ? openDb : new DatabaseSync(source);
  db.exec(SCHEMA);

  const q = {
    insertTask: db.prepare('INSERT INTO agent_tasks(id, run_id, role, goal, status, depends_on, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM agent_tasks WHERE id = ?'),
    byRun: db.prepare('SELECT * FROM agent_tasks WHERE run_id = ? ORDER BY rowid'),
    byRunStatus: db.prepare('SELECT * FROM agent_tasks WHERE run_id = ? AND status = ? ORDER BY rowid'),
    setRunning: db.prepare("UPDATE agent_tasks SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = ?"),
    setDone: db.prepare("UPDATE agent_tasks SET status = 'done', result = ?, finished_at = ? WHERE id = ? AND status NOT IN ('done','failed','blocked')"),
    setFailed: db.prepare("UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status NOT IN ('done','failed','blocked')"),
    setBlocked: db.prepare("UPDATE agent_tasks SET status = 'blocked', error = ?, finished_at = ? WHERE id = ? AND status NOT IN ('done','failed','blocked')"),
    requeue: db.prepare("UPDATE agent_tasks SET status = 'queued', started_at = NULL, finished_at = NULL, error = NULL WHERE id = ? AND status IN ('running','queued')"),
    insertEvent: db.prepare('INSERT INTO agent_events(run_id, task_id, type, payload, at) VALUES (?, ?, ?, ?, ?)'),
    eventsByRun: db.prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY id')
  };

  function at() { return new Date().toISOString(); }
  function parse(row) {
    if (!row) return null;
    return { ...row, depends_on: JSON.parse(row.depends_on || '[]') };
  }

  function createTasks(tasks) {
    if (!Array.isArray(tasks)) throw new Error('createTasks expects an array');
    db.exec('BEGIN');
    try {
      for (const t of tasks) {
        const deps = JSON.stringify(Array.isArray(t.dependsOn) ? t.dependsOn : []);
        try {
          q.insertTask.run(t.id, t.runId, t.role, t.goal, 'queued', deps, t.idempotencyKey || null, at());
        } catch (e) {
          // تصادم idempotency_key مسموح فقط إذا كانت المهمة سُجّلت لنفس التشغيل سابقاً.
          // أي تصادم آخر (خصوصاً على id) يُعلن ولا يُبتلع — دستور §46/1.
          const isIdem = /UNIQUE.*idempotency_key/i.test(e.message);
          const same = isIdem && q.byId.get(String(t.id));
          if (same && same.run_id === String(t.runId)) continue;
          throw new Error(`createTasks failed for task ${t.id}: ${e.message}`);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  // استعلام واحد: المهام queued التي كل تبعياتها done (json_each)
  function readyTasks(runId) {
    return db.prepare(`
      SELECT t.* FROM agent_tasks t
      WHERE t.run_id = ? AND t.status = 'queued'
        AND (SELECT COUNT(*) FROM json_each(t.depends_on) d
             LEFT JOIN agent_tasks dep ON dep.id = d.value
             WHERE dep.status IS NULL OR dep.status <> 'done') = 0
      ORDER BY t.rowid
    `).all(runId).map(parse);
  }

  function markRunning(id) {
    const r = q.setRunning.run(at(), String(id), 'queued');
    if (!r.changes) return { ok: false, reason: 'task not in queued state' };
    return { ok: true, task: parse(q.byId.get(String(id))) };
  }

  function markDone(id, result) {
    const r = q.setDone.run(JSON.stringify(result == null ? null : result), at(), String(id));
    if (!r.changes) return { ok: false, reason: 'task already terminal — result not overwritten' };
    return { ok: true };
  }

  function markFailed(id, error) {
    const r = q.setFailed.run(String(error == null ? 'unknown error' : error), at(), String(id));
    if (!r.changes) return { ok: false, reason: 'task already terminal' };
    return { ok: true };
  }

  function markBlocked(id, reason) {
    const r = q.setBlocked.run(String(reason == null ? 'blocked by dependency' : reason), at(), String(id));
    if (!r.changes) return { ok: false, reason: 'task already terminal' };
    return { ok: true };
  }

  function getTask(id) { return parse(q.byId.get(String(id))); }
  function listTasks(runId) { return q.byRun.all(String(runId)).map(parse); }

  // واجهة التحقق: حالة مهمة بعينها — بلا نموذج
  function getTaskStatus(id) {
    const t = q.byId.get(String(id));
    return t ? t.status : null;
  }

  // الدوال المساعدة على الاستئناف: إعادة المعلّقة إلى queued.
  // عطل مُثبت 2026-10-20: النسخة السابقة أعادت **`running` فقط**، فمهام بحالة
  // `queued` (لم تُشغَّل قط) بقيت معلّقة للأبد — تشغيل توقّف عند 220ث بقي
  // 2 running + 2 queued + 1 done بلا أي إعادة محاولة. القياس: القاعدة تحمل
  // تشغيلاً مهجوراً لا يُنظَّف عند الإقلاع ولا عند الاستئناف.
  // الإصلاح: تُستخدم `requeue` نفسها (تستهدف running **و** queued) على كل
  // مهمة غير منتهية، لا على `running` وحدها.
  function requeuePending(runId) {
    const open = q.byRun.all(String(runId)).map(parse).filter(t => !TERMINAL.has(t.status));
    for (const t of open) q.requeue.run(t.id);
    return open.map(t => t.id);
  }

  // تشغيلات مهجورة: مهام غير منتهية في أي run_id انقضى عليه زمن بلا حركة.
  // بوابة §42 (`tasks_recoverable`) تحتاج أدلة حقيقية على أن العالق يُستأنف.
  const qStale = db.prepare(`
    SELECT run_id AS runId, COUNT(*) AS stuck
    FROM agent_tasks
    WHERE status NOT IN ('done','failed','blocked')
    GROUP BY run_id
    ORDER BY MIN(rowid) DESC
    LIMIT 20
  `);
  function pendingRuns() {
    try { return qStale.all().map(r => ({ runId: String(r.runId), stuck: Number(r.stuck) })); }
    catch { return []; }
  }

  function saveEvent(ev) {
    const e = ev || {};
    q.insertEvent.run(e.runId, e.taskId == null ? null : e.taskId, String(e.type || 'event'), JSON.stringify(e.payload == null ? null : e.payload), e.at || at());
  }

  function events(runId) {
    return q.eventsByRun.all(String(runId)).map(r => ({ ...r, payload: JSON.parse(r.payload || 'null') }));
  }

  return { db, createTasks, readyTasks, markRunning, markDone, markFailed, markBlocked, getTask, getTaskStatus, listTasks, requeuePending, pendingRuns, saveEvent, events };
}

// ── المنسّق ──
class Orchestrator {
  constructor({ store, runAgent, callModel, maxParallel = 3, onEvent } = {}) {
    if (!store) throw new Error('Orchestrator requires a store');
    if (typeof runAgent !== 'function') throw new Error('Orchestrator requires runAgent(goal, subCtx)');
    this.store = store;
    this.runAgent = runAgent;
    this.callModel = callModel;
    this.maxParallel = Math.max(1, Math.min(Number(maxParallel) || 3, 8));
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
  }

  _emit(ev) {
    // كل حدث يحمل مهمة يجب أن يحمل دورها أيضاً — وإلا عجز أي مستهلك (الواجهة
    // والسجلات) عن ربط الحدث بصاحبه فتظهر بطاقات وهمية بلا دور (عطل مؤكد).
    let out = ev;
    if (ev && ev.taskId && !(ev.payload && ev.payload.role)) {
      try {
        const t = this.store.getTask(ev.taskId);
        if (t && t.role) out = { ...ev, payload: { ...(ev.payload || {}), role: t.role } };
      } catch { /* الحدث لا يُسقط التشغيل */ }
    }
    this.store.saveEvent(out);           // الطابور الدائم أولاً — قبل أي تغيير حالة
    if (this.onEvent) { try { this.onEvent(out); } catch { /* المستمع لا يكسر المنسّق */ } }
  }

  // المهام الجاهزة = queued وكل تبعياتها done (استعلام واحد في المتجر)
  _ready(runId) { return this.store.readyTasks(runId); }

  _dependents(runId, taskId) {
    return this.store.listTasks(runId).filter(t => t.depends_on.includes(taskId) && !TERMINAL.has(t.status));
  }

  // تعليم التابع blocked والانحدار عبر سلسلة التبعيات — لا مهمة تبقى معلقة
  _blockDependents(runId, taskId, reason) {
    const queue = this._dependents(runId, taskId).map(t => t.id);
    const blocked = [];
    const guard = new Set();
    let rounds = 0;
    while (queue.length) {
      if (++rounds > MAX_ROUNDS) throw new Error(`dependency walk exceeded ${MAX_ROUNDS} rounds`);
      const id = queue.shift();
      if (guard.has(id)) continue;
      guard.add(id);
      this._emit({ runId, taskId: id, type: 'task_blocked', payload: { reason } });
      this.store.markBlocked(id, reason);
      blocked.push(id);
      for (const d of this._dependents(runId, id)) if (!guard.has(d.id)) queue.push(d.id);
    }
    return blocked;
  }

  // اتخاذ الخطوة التالية للمهمة: تنفيذ → done | failed
  async _step(task, ctx, runId) {
    const started = this.store.markRunning(task.id);
    if (!started.ok) throw new Error(`cannot start task ${task.id}: ${started.reason}`);
    this._emit({ runId, taskId: task.id, type: 'task_started', payload: { role: task.role } });

    const subCtx = {
      ...(ctx || {}),
      role: task.role,
      taskId: task.id,
      allowedScopes: ROLES[task.role].scopes,
      runId,
      seen: new Set()
    };

    /* منع التنفيذ المزدوج بعد الاستئناف (عطل مُقاس 2026-11-11): الاستئناف يعيد
       تشغيل المهمة من أولها، و`seen` يبدأ فارغاً ⇒ أي أداة نفّذت أثرها قبل
       الانقطاع تُنفَّذ مرتين (كتابة مكررة). الحل بلا تغيير مخطط: نُعيد بناء
       `seen` من أحداث `tool_result` المحفوظة في سجل التشغيل نفسه، بمفاتيح
       idempotency نفسها التي يستعملها الوكيل ⇒ النداء المكرر يُرفض كـduplicate. */
    if (ctx && ctx.resumed && this.store && typeof this.store.events === 'function') {
      try {
        let replayed = 0;
        for (const ev of this.store.events(runId) || []) {
          if (ev.type !== 'tool_result') continue;
          const pl = ev.payload || {};
          if (!pl.tool) continue;
          subCtx.seen.add(policy.idempotencyKey(runId, pl.tool, pl.args));
          replayed += 1;
        }
        if (replayed) this._emit({ runId, taskId: task.id, type: 'resume_idempotency', payload: { replayed } });
      } catch { /* سجل غير مقروء: نكمل بلا منع تكرار (لا نُسقط المهمة) */ }
    }

    /* إلغاء تعاوني حقيقي (عطل مُقاس 2026-11-11): المنسّق كان يبني سياق المهمة بلا
       `hooks`، وفحص الإلغاء في الوكيل (`ctx.hooks.shouldCancel`) لا يتحقق أبداً ⇒
       `run_cancel` و`/api/agent/cancel` يَعِدان بما لا يحدث («سيتوقف قبل الخطوة
       التالية») والتشغيل يكمل. الآن الراية تُقرأ من مخزن التشغيل نفسه، وأحداث
       الوكيل تُبَثّ في سجل التشغيل (كانت تُفقَد في المسار المنسَّق). */
    subCtx.hooks = {
      ...(ctx && ctx.hooks ? ctx.hooks : {}),
      onEvent: (ev) => {
        try { if (ctx && ctx.hooks && typeof ctx.hooks.onEvent === 'function') ctx.hooks.onEvent(ev); } catch { /* مستمع خارجي */ }
        try { this._emit({ runId, taskId: task.id, type: (ev && ev.type) || 'agent_event', payload: (ev && ev.payload) || null }); } catch { /* السجل لا يُسقط المهمة */ }
      },
      shouldCancel: () => {
        try {
          if (ctx && ctx.hooks && typeof ctx.hooks.shouldCancel === 'function' && ctx.hooks.shouldCancel()) return true;
          return !!(this.store && typeof this.store.isCancelled === 'function' && this.store.isCancelled(runId));
        } catch { return false; }
      }
    };

    // قناة الأثر: كل أداة ينفّذها الوكيل تُكتب حدثاً في السجل —
    // فالمراقب يبني حكمه على أثر فعلي لا على ادعاء (§8، §35).
    subCtx.emit = (entry) => {
      try {
        this.store.saveEvent({
          runId,
          taskId: task.id,
          type: 'tool_result',
          payload: { tool: (entry && entry.tool) || '', args: entry && entry.args, result: entry && entry.result }
        });
        this._emit({ runId, taskId: task.id, type: 'task_evidence', payload: { tool: (entry && entry.tool) || '' } });
      } catch { /* الأثر لا يُسقط المهمة */ }
    };

    try {
      const result = await this.runAgent(task.goal, subCtx);
      this._emit({ runId, taskId: task.id, type: 'task_done', payload: { role: task.role } });
      this.store.markDone(task.id, result);
      return { id: task.id, role: task.role, status: 'done', result };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._emit({ runId, taskId: task.id, type: 'task_failed', payload: { error: msg } });
      this.store.markFailed(task.id, msg);
      const blocked = this._blockDependents(runId, task.id, `dependency ${task.id} failed: ${msg}`);
      return { id: task.id, role: task.role, status: 'failed', error: msg, blocked };
    }
  }

  // الحلقة الأساسية: تُعاد في run وفي resume
  async _schedule(runId, ctx) {
    const executed = [];
    let rounds = 0;
    const live = () => this.store.listTasks(runId).filter(t => !TERMINAL.has(t.status));
    let pending = live();

    /* سقف زمني للمهمة الواحدة (إصلاح 2026-11-13، عطل مقيس: فريق متوازٍ علّق
       الطلب أكثر من 200 ثانية ثم انقطع). السبب: مهمة تبقى `running` إلى الأبد
       إذا لم يستقر وعد النموذج (شبكة/DNS)، فالحلقة تنتظرها بلا نهاية حتى
       MAX_ROUNDS. الآن: كل مهمة لها سقف، وعند تجاوزه تُعلَّم failed صراحةً
       وتُحجب توابعها — فينتهي التشغيل بخطأ مفهوم بدل تعليق الخادم. */
    const TASK_TIMEOUT_MS = Math.max(30000, Number(process.env.CORTEX_TASK_TIMEOUT_MS) || 180000);
    const withTimeout = (p, ms, id) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`task_timeout: ${id} exceeded ${ms}ms`)), ms);
      if (typeof timer.unref === 'function') timer.unref();
      p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
    const reapOrphans = () => {
      for (const t of this.store.listTasks(runId)) {
        if (t.status !== 'running') continue;
        const age = Date.now() - Date.parse(t.started_at || t.created_at || 0);
        if (Number.isFinite(age) && age > TASK_TIMEOUT_MS * 2) {
          this.store.markFailed(t.id, `task_timeout: stale running task (${Math.round(age / 1000)}s)`);
          this._blockDependents(runId, t.id, 'dependency timed out while running');
        }
      }
    };

    while (pending.length) {
      reapOrphans();
      const ready = this._ready(runId);
      if (!ready.length) {
        // لا جاهز وبقيت مهام غير منتهية = مسار تبعيات غير قابل للحل: علّمها blocked ثم ارفض بخطأ واضح
        const stuck = pending.filter(t => t.status === 'queued');
        const reasons = [];
        for (const t of stuck) {
          this._emit({ runId, taskId: t.id, type: 'task_blocked', payload: { reason: 'unresolvable dependencies' } });
          this.store.markBlocked(t.id, 'unresolvable dependencies: no satisfiable dependency path');
          executed.push({ id: t.id, role: t.role, status: 'blocked', reason: 'unresolvable dependencies' });
          reasons.push(t.id);
        }
        const leftover = live();
        if (leftover.length) throw new Error(`orchestrator deadlock: ${leftover.map(t => `${t.id}:${t.status}`).join(', ')}`);
        throw new Error(`orchestrator stalled: no ready tasks while dependencies unsatisfiable (${reasons.join(', ') || 'unknown'})`);
      }

      if (++rounds > MAX_ROUNDS) throw new Error(`orchestrator exceeded ${MAX_ROUNDS} scheduling rounds for run ${runId}`);

      const batch = ready.slice(0, this.maxParallel);
      const settled = await Promise.allSettled(batch.map(t => withTimeout(this._step(t, ctx, runId), TASK_TIMEOUT_MS, t.id)));
      for (let i = 0; i < settled.length; i++) {
        if (settled[i].status === 'fulfilled') executed.push(settled[i].value);
        else {
          const msg = settled[i].reason && settled[i].reason.message;
          /* المهمة التي انتهت مهلتها قد تبقى `running` في المخزن (لأن _step لم
             يُكمل) ⇒ نُغلقها هنا وإلا بقيت الحلقة تدور عليها. */
          if (String(msg || '').startsWith('task_timeout')) {
            try { this.store.markFailed(batch[i].id, msg); this._blockDependents(runId, batch[i].id, 'dependency timed out'); } catch { /* المخزن أغلق */ }
          }
          executed.push({ id: batch[i].id, role: batch[i].role, status: 'failed', error: msg });
        }
      }
      pending = live();
    }
    return executed;
  }

  async run(goal) {
    const { runId, tasks } = await decompose(goal, { callModel: this.callModel });
    const ctx = { goal };

    const rows = tasks.map(t => ({
      ...t,
      runId,
      idempotencyKey: crypto.createHash('sha256').update(`${runId}|${t.role}|${t.id}`).digest('hex').slice(0, 32)
    }));
    this._emit({ runId, type: 'run_created', payload: { goal: String(goal), count: rows.length } });
    this.store.createTasks(rows);

    const executed = await this._schedule(runId, ctx);
    return this._finish(runId, goal, executed);
  }

  // الاستئناف: المعلّقة تعود queued، والمنجزة لا تُعاد (دستور §36)
  async resume(runId) {
    if (typeof this.store.requeuePending !== 'function') throw new Error('store does not support resume (requeuePending missing)');
    const requeued = this.store.requeuePending(runId);
    this._emit({ runId, type: 'run_resumed', payload: { requeued } });
    const executed = await this._schedule(runId, { resumed: true });
    return this._finish(runId, '', executed);
  }

  async _finish(runId, goal, executed) {
    const tasks = this.store.listTasks(runId);
    const doneTasks = tasks.filter(t => t.status === 'done');
    const failed = tasks.filter(t => t.status === 'failed').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;

    // الأمانة في التقرير: التحقق من حالة كل مهمة منجزة في المتجر بكود حتمي.
    // ولا يوصف التشغيل بالمتحقق إطلاقاً إن وُجد فشل أو تعليق — دستور §46/1.
    const gen = await verifyClaims(
      doneTasks.map(t => ({ type: 'task_status', id: t.id, expected: 'done' })),
      { store: this.store }
    );
    const verified = !!(gen.results.length && gen.verified === gen.results.length && failed === 0 && blocked === 0);

    const summary = {
      goal: goal || null,
      total: tasks.length,
      done: doneTasks.length,
      failed,
      blocked,
      executed,
      verified
    };
    /* إغلاق صادق: تشغيل أُلغي يُغلق بـ`run_cancelled` (حدث ختامي) لا `run_finished`
       — وإلا بقي `summarize().active=true` بعد الإلغاء وقال الشريط «يعمل الآن» كذباً. */
    const wasCancelled = !!(this.store && typeof this.store.isCancelled === 'function' && this.store.isCancelled(runId));
    this._emit({ runId, type: wasCancelled ? 'run_cancelled' : 'run_finished', payload: wasCancelled ? { ...summary, cancelled: true } : summary });
    return { runId, tasks, verified, summary, cancelled: wasCancelled };
  }
}

module.exports = { ROLES, decompose, verifyClaims, createStore, Orchestrator };
