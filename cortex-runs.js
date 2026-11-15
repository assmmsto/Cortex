'use strict';
/**
 * طبقة «التشغيل أوّل-درجة» — خطة الاستوديو، الموجة W1 (2026-10-27).
 *
 * العطل البنيوي الذي تُغلق هذه الوحدة (مُقاس في تقرير 11-agent-studio-plan):
 *   التشغيل المفرد كان يعيش داخل طلب HTTP واحد بلا معرّف وبلا سجل، وخطواته تموت
 *   مع الصفحة، و«الإيقاف» كان قطع fetch من المتصفح فقط — والخادم يواصل التنفيذ.
 *
 * العقد الآن: كل تشغيل (مفرد/مجدول/فريقي-لاحقاً) له:
 *   - معرّف دائم `run-<ts>-<hex>`،
 *   - سجل أحداث منظّم في agent_events (نفس بنية المنسّق: saveEvent/events)،
 *   - حالة قابلة للاستعلام (نشط/منتهٍ/ملغى) تُشتق من السجل لا من الذاكرة،
 *   - إلغاء حقيقي: راية يفحصها الوكيل قبل كل خطوة (تعاوني — لا قتل عنيف).
 * كل شيء في نفس قاعدة cortex.db ونفس الجدول — فالمفرد والفريق يُقرآن بأداة واحدة.
 */
const crypto = require('node:crypto');
const orc = require('./cortex-orchestrator');

const TERMINAL_EVENTS = new Set(['run_finished', 'run_failed', 'run_cancelled']);

function createRunStore(db) {
  // إعادة استخدام مخزن المنسّق: نفس مخطط الجدول والاستعلامات (لا ازدواج أسماء)
  const store = orc.createStore(db);
  const cancelFlags = new Map();

  function newRunId() {
    return `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  function begin(meta = {}) {
    const runId = newRunId();
    event(runId, 'run_created', {
      goal: String(meta.goal || '').slice(0, 400),
      project: String(meta.project || ''),
      noteId: String(meta.noteId || ''),
      sessionId: String(meta.sessionId || ''),
      trigger: ['chat', 'schedule', 'api', 'resume'].includes(meta.trigger) ? meta.trigger : 'chat',
      lang: meta.lang === 'en' ? 'en' : 'ar'
    });
    return runId;
  }

  function event(runId, type, payload = null) {
    if (!runId) throw new Error('run event: runId إلزامي');
    store.saveEvent({ runId: String(runId), taskId: null, type: String(type), payload: payload == null ? null : payload });
  }

  function events(runId, { since = 0 } = {}) {
    const sinceN = Number(since) || 0;
    return store.events(String(runId)).filter((e) => Number(e.id) > sinceN);
  }

  function finish(runId, type, payload = null) {
    if (!TERMINAL_EVENTS.has(type)) throw new Error(`finish: نوع ختامي غير صالح «${type}»`);
    event(runId, type, payload);
    cancelFlags.delete(String(runId));
  }

  /** إلغاء تعاوني: الراية تُفحص في حلقة الوكيل قبل كل خطوة، وحدثها يُدوَّن فوراً */
  function requestCancel(runId) {
    cancelFlags.set(String(runId), true);
    event(runId, 'cancel_requested', { at: new Date().toISOString() });
  }
  function isCancelled(runId) { return cancelFlags.get(String(runId)) === true; }

  /** ملخص تشغيل من سجله مباشرة — مصدر الحقيقة هو الأحداث لا الذاكرة */
  function summarize(runId) {
    const list = store.events(String(runId));
    if (!list.length) return null;
    const created = list.find((e) => e.type === 'run_created');
    const terminal = [...list].reverse().find((e) => TERMINAL_EVENTS.has(e.type));
    const last = list[list.length - 1];
    return {
      runId: String(runId),
      startedAt: list[0].at,
      lastAt: last.at,
      lastType: last.type,
      active: !terminal,
      terminal: terminal ? terminal.type : null,
      goal: (created && created.payload && created.payload.goal) || '',
      sessionId: (created && created.payload && created.payload.sessionId) || '',
      trigger: (created && created.payload && created.payload.trigger) || 'chat',
      eventCount: list.length,
      verified: terminal && terminal.type === 'run_finished' && terminal.payload ? (terminal.payload.verified ?? null) : null
    };
  }

  function recent(limit = 12) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 50));
    const ids = db.prepare('SELECT run_id, MAX(id) AS mid FROM agent_events GROUP BY run_id ORDER BY mid DESC LIMIT ?').all(n);
    return ids.map((r) => summarize(r.run_id)).filter(Boolean);
  }

  function active() { return recent(30).filter((r) => r.active); }

  /* عطل مُقاس (تحقق حي 2026-10-27): تشغيل قتله انقطاع العملية لا يملك حدثاً ختامياً،
     فيبقى «نشطاً» في الاستعلام للأبد ويُشوّه شريط الحالة. المصالحة عند الإقلاع:
     كل تشغيل بلا نشاط منذ maxAgeMs يُغلق كـ«متروك» — لا راية إلغاء في الذاكرة
     بعد إقلاع جديد، فالوضع الحقيقي «انقطع» لا «يعمل». */
  function reconcileAbandoned(maxAgeMs = 15 * 60 * 1000) {
    const stale = recent(50).filter((r) => r.active && (Date.now() - Date.parse(r.lastAt || 0)) > maxAgeMs);
    for (const r of stale) {
      try { finish(r.runId, 'run_failed', { error: 'run abandoned (process restart)', abandoned: true }); } catch { /* سباق */ }
    }
    return stale.length;
  }

  return { db, begin, event, events, finish, requestCancel, isCancelled, summarize, recent, active, reconcileAbandoned };
}

module.exports = { createRunStore, TERMINAL_EVENTS };
