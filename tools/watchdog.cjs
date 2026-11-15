'use strict';
/**
 * حارس بقاء Cortex (2026-10-28) — عطل مُقاس مرتين: تحت حِمل طويل يتجمّد الخادم
 * (المعالج يشوي وحتى /api/ping لا يجيب). وكيل «لا ينهار بعد يوم» لا يكفي فيه
 * الرجاء: يحتاج مشرفاً خارج العملية نفسها — لأن الحلقة العالقة لا تستطيع أن
 * تشفي نفسها (النبضات داخل العملية لا تجري أصلاً).
 *
 * العقد: يفحص /api/ping كل 10ث. ثلاث فشلات متتالية (مهلة 5ث لكل فحص) ⇒
 * يقتل الخادم المتجمد ويقلع خادماً جديداً (والإقلاع نفسه يستأنف/يصالح كل شيء
 * بفضل W1: مصالحة التشغيلات + إعادة مؤشر الاسترجاع + النبضة).
 *
 * الاستعمال: node tools/watchdog.cjs --pid <serverPid> --port 3737
 * (يُقلع تلقائياً من server.js بلا مرجعية — يكفي أن يبقى ملفه حيّاً.)
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const numOf = (name, def, min, max) => {
  const raw = argOf(name, '');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return raw === '' || raw === undefined ? def : NaN;
  return n;
};
const PORT = numOf('--port', 3737, 1, 65535);
// pid رقمي صارم فقط — لا يُبنى أي أمر من نص خارجي (حارس أمني: يمنع حقن الأوامر)
let pid = numOf('--pid', 0, 0, 2 ** 31 - 1);
if (Number.isNaN(pid)) pid = 0;
const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'data', 'watchdog.log');

function log(obj) {
  try { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch { /* السجل تحسيني */ }
}

async function ping() {
  try {
    /* 8s لا 5: بناء فهرس كبير يحجب الحلقة الواحدة ثوانٍ، فالمهل القصيرة تُقرأ
       «جموداً» فتُقتل عملية سليمة (عاصفة مُقاسة 2026-11-11). الحارس يحرس التجمّد
       الحقيقي لا الحمل الثقيل. */
    const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}

function killStuck() {
  // execFileSync بلا صدفة: لا تفسير محارف؛ وpid مُتحقَّق رقمياً عند الإقلاع
  try { if (Number.isInteger(pid) && pid > 0) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* مات سابقاً */ }
}

function revive() {
  const out = fs.openSync(path.join(ROOT, 'data', 'server-live.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env }
  });
  child.unref();
  pid = child.pid;
  log({ event: 'revived', newPid: pid });
}

(async () => {
  log({ event: 'watchdog_started', pid, port: PORT });
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    /* تمييز حاسم (عطل مُقاس 2026-10-28): تصرّف الحارس كان واحداً للموت والجمود معاً،
       فقتلُ الأب (إيقاف متعمّد أو نهاية اختبار) كان يُقرأ «عطلاً» فيُحيا الميت —
       وخلّف خوادم أشباح على منافذ ثابتة أفسدت اختبارات لاحقة (retrieval/import-deep).
       العقد الصحيح: الحارس يحرس **الجمود** (عملية حيّة لا تجيب) فقط؛ أما انتهاء
       العملية عمداً فحكمه الاحترام — يُنهي الحارس نفسه بسلام. */
    if (pid && !(() => { try { process.kill(pid, 0); return true; } catch { return false; } })()) {
      // الأب انتهى: هل وُجد بديل يستمع على المنفذ (ليس من فعلنا)؟
      try {
        // بلا صدفة: netstat خالص ثم فرز في JS (لا أي تركيب نصوص أوامر)
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        const line = out.split(/\r?\n/).find((l) => l.includes(`:${PORT}`) && l.includes('LISTENING'));
        pid = line ? Number(line.trim().split(/\s+/).pop()) || 0 : 0;
      } catch { pid = 0; }
      if (!pid) {
        log({ event: 'parent_dead_exit', note: 'انتهى الخادم ولم يستمع بديل — إنهاء الحراسة بسلام' });
        return; // لا إحياء للموت المتعمد
      }
    }
    const ok = await ping();
    /* قفل صيانة: عمليات ثقيلة (بناء فهرس المتجهات) تحجب الحلقة الواحدة عشرات
       الثواني. وجود data/.maintenance يعني «حيّ ويَنتج» لا «متجمّد» ⇒ نتخطّى
       القتل ونصفّر الإخفاقات (عطل مُقاس 2026-11-11: 206 قتلة متتالية). */
    let maintenance = false;
    try { maintenance = fs.existsSync(path.join(ROOT, 'data', '.maintenance')); } catch { maintenance = false; }
    if (maintenance) { if (misses) log({ event: 'maintenance_skip', misses }); misses = 0; continue; }
    if (ok) { if (misses) log({ event: 'recovered' }); misses = 0; continue; }
    misses++;
    log({ event: 'miss', misses, pid });
    /* 4 إخفاقات لا 3: مع مهلة 8s ودورة 10s صار التسامح ~72s — يكفي لإعادة بناء
       فهرس كبير ثم العودة، ويمنع سلسلة «قتل ← بناء ← قتل» التي لا تُشفى. */
    if (misses >= 4) {
      log({ event: 'hang_detected_killing', pid });
      killStuck();
      await new Promise((r) => setTimeout(r, 2500));
      revive();
      misses = 0;
    }
  }
})().catch((e) => { log({ event: 'watchdog_crash', error: String(e.message || e) }); process.exit(1); });
