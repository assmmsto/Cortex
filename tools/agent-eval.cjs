#!/usr/bin/env node
'use strict';
/**
 * مقياس نجاح الوكيل الحقيقي (2026-11-05).
 *
 * لماذا: نسبة النجاح كانت رقماً في تقرير قديم (79.46%) بلا أداة تعيد قياسه.
 * هذه الأداة تشغّل مهامّ ممثِّلة على المزود النشط فعلياً، وتحكم على النجاح
 * بمعيار صريح: حدث agent_done + جواب غير فارغ + بلا خطأ + ضمن المهلة.
 *
 * الاستخدام:
 *   node tools/agent-eval.cjs                 # الخادم على 127.0.0.1:3737
 *   CORTEX_URL=http://127.0.0.1:3737 node tools/agent-eval.cjs
 *   node tools/agent-eval.cjs --keep          # لا تحذف تقارير التشغيل
 *
 * ملاحظة: الوكيل قد ينشئ ملاحظة تقرير لكل مهمة؛ تُحذف تلقائياً بعد القياس
 * (فقط ما أُنشئ بعد بدء التشغيل) ما لم تُمرَّر --keep.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.CORTEX_URL || 'http://127.0.0.1:3737').replace(/\/+$/, '');
const KEEP = process.argv.includes('--keep');
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS || 120000);

const GOALS = [
  { id: 'count-notes', goal: 'كم عدد الملاحظات المخزنة الآن؟ اذكر الرقم فقط.', check: /\d{2,}/ },
  { id: 'recent-titles', goal: 'اذكر عناوين آخر ثلاث ملاحظات.', check: /./ },
  { id: 'find-note', goal: 'ابحث عن ملاحظة عنوانها يحتوي «agent-memory» واذكر عنوانها كما هو.', check: /agent|ذاكرة/i },
  { id: 'tasks-status', goal: 'هل توجد مهام مفتوحة؟ اذكر العدد.', check: /./ },
  { id: 'gaps', goal: 'ما الفجوات المعرفية الظاهرة الآن؟ اذكر فجوة واحدة على الأقل أو قل لا توجد.', check: /./ },
  { id: 'projects', goal: 'ما أسماء المشاريع النشطة؟', check: /./ },
  { id: 'summarize-note', goal: 'لخّص ملاحظة agent-memory في ثلاث نقاط.', check: /1|١|•|-/ },
  { id: 'arabic-quality', goal: 'اكتب جملة عربية سليمة واحدة عن أهمية الذاكرة للوكيل.', check: (a) => (String(a).match(/[\u0600-\u06FF]/g) || []).length >= 15 },
];

function token() {
  if (process.env.CORTEX_TOKEN) return process.env.CORTEX_TOKEN.trim();
  const p = path.join(ROOT, 'data', 'session.token');
  if (!fs.existsSync(p)) throw new Error('لا رمز جلسة: مرّر CORTEX_TOKEN أو شغّل الخادم أولاً');
  return fs.readFileSync(p, 'utf8').trim();
}

async function runGoal(tok, g) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': tok },
      body: JSON.stringify({ goal: g.goal, lang: 'ar' }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, ms: Date.now() - t0, reason: `HTTP ${res.status}` };
    const raw = await res.text();
    const done = /"type":"agent_done"/.test(raw) || /agent_done/.test(raw);
    const m = raw.match(/"answer":"((?:[^"\\]|\\.)*)"/);
    const answer = m ? JSON.parse(`"${m[1]}"`) : '';
    const errorEvent = /"type":"error"|"error":"/.test(raw);
    const ms = Date.now() - t0;
    if (!done) return { ok: false, ms, reason: 'بلا agent_done' };
    if (errorEvent && !answer) return { ok: false, ms, reason: 'حدث خطأ' };
    if (!answer || answer.trim().length < 2) return { ok: false, ms, reason: 'جواب فارغ' };
    if (!(typeof g.check === 'function' ? g.check(answer) : g.check.test(answer))) return { ok: false, ms, reason: 'الجواب لا يطابق المطلوب', answer };
    if (ms > TIMEOUT_MS) return { ok: false, ms, reason: 'تجاوز المهلة' };
    return { ok: true, ms, answer };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.name === 'AbortError' ? 'مهلة' : String(e.message).slice(0, 80) };
  } finally { clearTimeout(killer); }
}

async function listNotes(tok) {
  const r = await fetch(`${BASE}/api/notes`, { headers: { 'X-Cortex-Session': tok } });
  const j = await r.json();
  return j.notes || [];
}

(async () => {
  const tok = token();
  const before = await listNotes(tok);
  const startedAt = new Date().toISOString();

  console.log(`Cortex agent eval — ${BASE}\nالمهام: ${GOALS.length}\n`);
  const rows = [];
  for (const g of GOALS) {
    const r = await runGoal(tok, g);
    rows.push({ id: g.id, ...r });
    console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${String(r.ms).padStart(6)}ms | ${g.id}${r.reason ? ' — ' + r.reason : ''}`);
  }

  const pass = rows.filter((r) => r.ok).length;
  const rate = Math.round((pass / rows.length) * 1000) / 10;
  console.log(`\nالنتيجة: ${pass}/${rows.length} = ${rate}%`);

  if (!KEEP) {
    const after = await listNotes(tok);
    const beforeIds = new Set(before.map((n) => n.id));
    const created = after.filter((n) => !beforeIds.has(n.id) && String(n.title || '').startsWith('تقرير:'));
    for (const n of created) {
      try {
        await fetch(`${BASE}/api/notes/${encodeURIComponent(n.id)}`, { method: 'DELETE', headers: { 'X-Cortex-Session': tok } });
      } catch { /* التنظيف لا يُسقط القياس */ }
    }
    if (created.length) console.log(`حُذفت ${created.length} ملاحظة تقرير أنشأها القياس (منذ ${startedAt}).`);
  }

  process.exitCode = pass === rows.length ? 0 : 1;
})().catch((e) => { console.error('فشل القياس:', e.message); process.exit(2); });