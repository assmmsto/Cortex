'use strict';
/**
 * Cortex — المراقب الصارم (Strict Monitor)
 *
 * يقرأ سجلّ أحداث تشغيل الوكلاء ويعيد بناء الحقيقة منه — لا من كلام الوكلاء.
 * حتمي بالكامل: لا يستدعي نموذجاً ولا يثق بادعاء بلا دليل (دستور §35، §8، §6).
 *
 * مبدأه: «الدليل أو لا شيء». كل مهمة تُقيَّم بما تُرك في السجل، لا بما قالته.
 * لا اعتماد خارجي.
 */

const TERMINAL = new Set(['done', 'failed', 'blocked']);
const DONE = 'done', FAILED = 'failed', BLOCKED = 'blocked';

/** مقاييس الإنتاجية من سجل الأحداث — حساب صرف بلا تخمين */
function productivity(events = [], tasks = []) {
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, { id: t.id, role: t.role, goal: t.goal, status: t.status, startedAt: null, endedAt: null, evidence: [], error: null });

  for (const e of events) {
    // صفوف SQL تُرجع task_id بينما كائنات JS ترسل taskId — نقرأ الاثنين،
    // وإلا فقدت كل الأدلة وبدا التشغيل الناجح «بلا دليل» (عطل تكامل مؤكد).
    const key = e.taskId != null ? e.taskId : e.task_id;
    const rec = byId.get(key);
    if (!rec) continue;
    const at = e.at || e.createdAt || e.ts || null;
    const type = String(e.type || '');
    if (type === 'task_started') { if (!rec.startedAt) rec.startedAt = at; }
    else if (type === 'task_done') { rec.endedAt = at; rec.status = DONE; }
    else if (type === 'task_failed') { rec.endedAt = at; rec.status = FAILED; rec.error = (e.payload && e.payload.error) || null; }
    else if (type === 'task_blocked') { rec.endedAt = at; rec.status = BLOCKED; rec.error = (e.payload && e.payload.reason) || null; }
    else if (type === 'task_evidence' || type === 'tool_result') {
      const pl = e.payload || {};
      rec.evidence.push({ at, tool: pl.tool || '', ok: !pl.error });
    }
  }

  const list = [...byId.values()];
  let durSum = 0, durCount = 0;
  for (const r of list) {
    if (r.startedAt && r.endedAt) {
      const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
      if (Number.isFinite(ms) && ms >= 0) { r.durationMs = ms; durSum += ms; durCount++; }
    }
  }

  const done = list.filter(r => r.status === DONE).length;
  const failed = list.filter(r => r.status === FAILED).length;
  const blocked = list.filter(r => r.status === BLOCKED).length;
  const pending = list.filter(r => !TERMINAL.has(r.status)).length;

  // التوازي المُنجَز فعلاً: أقصى عدد مهام كانت تعمل في وقت واحد
  const points = [];
  for (const r of list) {
    if (r.startedAt) points.push({ t: new Date(r.startedAt).getTime(), d: +1 });
    if (r.endedAt) points.push({ t: new Date(r.endedAt).getTime(), d: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0;
  for (const p of points) { cur += p.d; if (cur > peak) peak = cur; }

  return {
    totals: { tasks: list.length, done, failed, blocked, pending },
    avgDurationMs: durCount ? Math.round(durSum / durCount) : 0,
    totalDurationMs: durSum,
    peakConcurrency: peak,
    successRate: list.length ? Math.round((done / list.length) * 100) : 0,
    tasks: list.map(r => ({
      id: r.id, role: r.role, status: r.status, durationMs: r.durationMs || 0,
      evidence: r.evidence.length, error: r.error
    }))
  };
}

/**
 * الفحص الصارم: يكشف ما لا يقبله التحقق.
 * يعيد قائمة اعتراضات مبنية على أدلة من السجل — لا انطباعات.
 * كل اعتراض يحمل: الشدة، المهمة، السبب، والدليل المبني عليه.
 */
function strictAudit({ events = [], tasks = [], claims = [], verdicts = [] } = {}) {
  const findings = [];
  const add = (severity, code, message, evidence) => findings.push({ severity, code, message, evidence: evidence || null });

  const prod = productivity(events, tasks);
  const byId = new Map(prod.tasks.map(t => [t.id, t]));

  // ① مهمة أعلنت الاكتمال بلا أي أثر أداة = ادعاء بلا دليل
  for (const t of prod.tasks) {
    if (t.status === DONE && t.evidence === 0) {
      add('high', 'claim_without_evidence',
        `المهمة ${t.id} (${t.role}) أعلنت الاكتمال دون أي أثر أداة في السجل`,
        { taskId: t.id, role: t.role, evidence: 0 });
    }
  }

  // ② مهام فشلت — لا يجوز إخفاؤها
  for (const t of prod.tasks) {
    if (t.status === FAILED) {
      add('high', 'task_failed', `المهمة ${t.id} (${t.role}) فشلت: ${t.error || 'بلا سبب مسجّل'}`,
        { taskId: t.id, role: t.role, error: t.error });
    }
  }

  // ③ مهام مُعلّقة بسبب تبعية فاشلة
  for (const t of prod.tasks) {
    if (t.status === BLOCKED) {
      add('medium', 'task_blocked', `المهمة ${t.id} (${t.role}) مُنعت بسبب تبعية: ${t.error || 'بلا سبب'}`,
        { taskId: t.id, role: t.role });
    }
  }

  // ④ ادعاءات لم تُتحقّق — جوهر الصرامة
  for (const v of (Array.isArray(verdicts) ? verdicts : [])) {
    if (v && v.verified === false) {
      add('high', 'claim_unverified',
        `ادعاء غير مُتحقّق: ${(v.claim && (v.claim.type || v.claim.id)) || 'ادعاء'} — ${v.reason || 'بلا سبب'}`,
        v.claim || null);
    }
  }

  // ⑤ ادعاء بلا نوع معروف = لا يمكن التحقق منه ⇒ لا يُقبل
  for (const c of (Array.isArray(claims) ? claims : [])) {
    const known = ['file_exists', 'file_modified', 'note_exists', 'tool_ran', 'test_passed'];
    if (!c || !known.includes(String(c.type))) {
      add('medium', 'unverifiable_claim', `ادعاء بنوع غير قابل للتحقق: ${c && c.type ? c.type : '(بلا نوع)'}`, c || null);
    }
  }

  // ⑤.٥ مهام لم تُنفَّذ (queued/running) = تشغيل مقطوع ⇒ لا يُقبل أبداً.
  // بدون هذا الفحص يمر تشغيل أنهى مهمة من خمس ويُوصف «مقبول» (عطل منطقي مؤكد).
  for (const t of prod.tasks) {
    if (!TERMINAL.has(t.status) || t.status === 'queued' || t.status === 'running') {
      add('high', 'task_incomplete',
        `المهمة ${t.id} (${t.role}) لم تكتمل — حالتها «${t.status}»`,
        { taskId: t.id, role: t.role, status: t.status });
    }
  }

  // ⑥ دور لم يُشغَّل رغم أنه مطلوب للهدف = ثغرة تغطية
  const roles = new Set(prod.tasks.map(t => t.role));
  for (const must of ['verifier']) {
    if (!roles.has(must)) {
      add('high', 'missing_role', `الدور الإلزامي «${must}» لم يُشغَّل — لا تحقق مستقل`, { roles: [...roles] });
    }
  }

  // ⑦ توقف مبكر: لا شيء نُفّذ
  if (prod.totals.tasks === 0) add('high', 'empty_run', 'لا مهام في هذا التشغيل', null);

  const high = findings.filter(f => f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  const verdict = high > 0 ? 'rejected' : (medium > 0 ? 'conditional' : 'accepted');

  return {
    verdict,
    counts: { high, medium, total: findings.length },
    findings,
    productivity: prod,
    // الرأي مبني على الأدلة: يُقبل فقط إذا نُفّذ كل شيء ونجح وله أدلة
    reasons: {
      allTasksTerminal: prod.totals.pending === 0,
      noFailures: prod.totals.failed === 0,
      allDoneHaveEvidence: prod.tasks.filter(t => t.status === DONE).every(t => t.evidence > 0),
      hasVerifier: roles.has('verifier'),
      claimsVerified: (Array.isArray(verdicts) ? verdicts : []).every(v => v && v.verified === true)
    },
    // إرشاد مرافق لكل سبب — «ماذا أفعل لو رُفض الحكم؟» (قرار دورة الأدوار: المراقبة)
    advice: buildAdvice({
      allTasksTerminal: prod.totals.pending === 0,
      noFailures: prod.totals.failed === 0,
      allDoneHaveEvidence: prod.tasks.filter(t => t.status === DONE).every(t => t.evidence > 0),
      hasVerifier: roles.has('verifier'),
      claimsVerified: (Array.isArray(verdicts) ? verdicts : []).every(v => v && v.verified === true)
    })
  };
}

// كل سبب رفض → جملة إرشاد مفهومة للمستخدم + مكان الإصلاح
const REASON_ADVICE = Object.freeze({
  allTasksTerminal: 'بعض المهام ما زالت معلّقة (لم تنتهِ). انتظر انتهاء الفريق أو أعد التشغيل — المهام المعلقة تُستأنف تلقائياً.',
  noFailures: 'فشلت مهمة أو أكثر. افتح جدول المهام بالأسفل واقرأ عمود «الخطأ» لكل مهمة فاشلة، ثم أعد التشغيل بهدف أدق.',
  allDoneHaveEvidence: 'هناك مهام أعلنت النجاح بلا أثر أداة (لا استدعاء مسجّل). هذا ادعاء غير مسند — أعد التشغيل وسيتدخل المراقب الصارم.',
  hasVerifier: 'الفريق اكتمل بدون دور «مُتحقِّق». فعّل دور verifier في إعداد الفريق حتى تُفحص النتائج قبل الاعتماد.',
  claimsVerified: 'ادعاؤات الوكيل لم تُتحقق تجريبياً. اجعل هدف المهمة يتضمن تشغيل اختبار أو أمر فحص قابل للقياس.',
});

function buildAdvice(reasons) {
  return Object.entries(REASON_ADVICE)
    .filter(([k]) => reasons[k] === false)
    .map(([k, text]) => ({ reason: k, text, fix: k === 'hasVerifier' ? 'agent:team-config' : (k === 'noFailures' ? 'agent:tasks' : 'agent:rerun') }));
}

/** تقرير إنتاجية مختصر للعرض في الواجهة */
function report({ events = [], tasks = [], claims = [], verdicts = [] } = {}) {
  const a = strictAudit({ events, tasks, claims, verdicts });
  return {
    verdict: a.verdict,
    accepted: a.verdict === 'accepted',
    steps: a.productivity.totals.tasks,
    done: a.productivity.totals.done,
    failed: a.productivity.totals.failed,
    blocked: a.productivity.totals.blocked,
    successRate: a.productivity.successRate,
    avgDurationMs: a.productivity.avgDurationMs,
    peakConcurrency: a.productivity.peakConcurrency,
    objections: a.findings,
    tasks: a.productivity.tasks,
    reasons: a.reasons,
    advice: a.advice || []
  };
}

module.exports = { productivity, strictAudit, report, TERMINAL };
