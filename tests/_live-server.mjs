/**
 * tests/_live-server.mjs — خادم اختبار معزول ببيئة حتمية.
 *
 * لماذا (درس 2026-10-20، مُثبت بالأدلة):
 *   ستة اختبارات كانت تستعمل خادم 127.0.0.1:3737 الحيّ الذي يشغّله المطوّر،
 *   فتفشل لأسباب خارجة عن الكود:
 *     • «daily limit reached for fs (60)» — `DAILY_LIMITS.fs` تُحسب من
 *       data/audit.log المشترك، وجولات التطوير تستهلكه.
 *     • «المسار خارج الجذور المسموحة» — جذور Temp غير معلنة.
 *   اختبار يعتمد على حالة خادم خارجي ليس اختباراً: نتيجته تعتمد على من شغّل
 *   ماذا قبلها. الصواب: كل اختبار حيّ يقلع خادمه المعزول (APP_ROOT مؤقت +
 *   بورت عشوائي + بيئة حتمية)، ويقتله بعد الانتهاء.
 *
 * الاستعمال:
 *   import { startLiveServer } from './_live-server.mjs';
 *   const srv = await startLiveServer();   // { base, token, root, stop() }
 *   ... استخدم srv.base و srv.token ...
 *   await srv.stop();
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** بيئة حتمية — القيم نفسها التي يزرعها tests/run-suite.cjs للحزمة. */
export function deterministicEnv(root, port) {
  return {
    ...process.env,
    APP_ROOT: root,
    APP_PORT: String(port),
    // سقف الكتابة اليومي للوكيل: مرتفع كفاية لجولة اختبار (المنتج 25).
    AGENT_DAILY_WRITES: '100000',
    // الميزانيات اليومية للسياسة (المنتج: vault 200، fs 60، exec 30، import 40).
    CORTEX_DAILY_FS: '100000',
    CORTEX_DAILY_VAULT: '100000',
    CORTEX_DAILY_EXEC: '100000',
    CORTEX_DAILY_IMPORT: '100000',
    // جذور مسموحة: جذر المشروع + Temp (المجلدات المؤقتة تُنشأ تحت Temp).
    CORTEX_ALLOWED_ROOTS: [PROJECT_DIR, tmpdir()].join(path.delimiter),
    CORTEX_TEST_MODE: '1',
    // عطل مُقاس 2026-10-28: حراس البقاء كانت تُطلق لخوادم الاختبارات — وعند قتل
    // الخادم عمداً (نهاية الجولة) كان الحارس يقرأ القتل «عطلاً» ويعيده، فتخلف
    // أشباح على منافذ ثابتة (retrieval:3941) تفسد جولات لاحقة. الحارس الآن لا
    // يقلع في وضع الاختبار ولا بعد listen فاشل (إصلاح بنيوي في server.js/watchdog.cjs).
    CORTEX_NO_WATCHDOG: '1',
  };
}

/** منفذ حرّ فعلي من تجمّع النظام (listen(0)) — لا يقع في نطاق محجوز مثل 50245. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitFor(url, ms = 20000, diag = () => '') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* لم يقلع بعد */ }
    await new Promise((r) => setTimeout(r, 130));
  }
  // التشخيص إلزامي: بلا مخرج الخادم يصبح الإخفاق «لا يعرف سببه» (مُقاس 2026-10-23:
  // csrf-guard سقط مرة في الحزمة ونجح منفرداً 7/7، ولم يكن هناك أي أثر لسبب الفشل).
  throw new Error(`الخادم لم يقلع خلال ${ms}ms — ${url}\n--- مخرج الخادم ---\n${diag() || '(فارغ)'}`);
}

/**
 * يقلع خادماً معزولاً ويعيد مقبضاً مع رمز جلسة جاهز.
 * @param {{appRoot?:string, port?:number, env?:object}} [opts]
 */
export async function startLiveServer(opts = {}) {
  const root = opts.appRoot || await mkdtemp(path.join(tmpdir(), 'cortex-live-'));
  // تهيئة خادم MCP الافتراضي: `data/mcp-servers.json` يقع في جذر الخادم، فالبيئة
  // المعزولة تبدأ بلا أي خادم ⇒ اختبارات الحوكمة تفشل بـ404 «خادم MCP غير مهيّأ»
  // بلا أي عطل في الحوكمة (مُثبت 2026-10-20). نزرع نفس تهيئة المشروع: خادم ذاكرة
  // محلي (mcp-memory-server.js) — بلا شبكة وبلا اعتماد خارجي.
  if (opts.mcpServers !== null) {
    try {
      await mkdir(path.join(root, 'data'), { recursive: true });
      // إعدادات أساسية حتمية: مزود mock محلي + وضع الوكيل.
      // العطل المُثبت 2026-10-20: `autonomy` يُقرأ من **إعدادات الخادم** لا من
      // حمولة الطلب (قرار أمني صحيح §35 — منع التصعيد من الحمولة). فاختبار يطلب
      // `autonomy:'autonomous'` في الحمولة يبقى monitored/supervised ⇒ كتابته
      // تُسجَّل مسودة ⇒ «task actually added» يفشل بلا عطل في الوكيل. الاختبار
      // الذي يريد التنفيذ المستقل يضبط الإعداد في جذر الخادم.
      await writeFile(
        path.join(root, 'data', 'settings.json'),
        JSON.stringify({
          ai: { provider: opts.provider || 'mock', model: '', temperature: 0.2 },
          agent: { defaultMode: 'project', autonomy: opts.autonomy || 'supervised' },
          lang: opts.lang || 'ar',
        }, null, 1),
        'utf8'
      );
      await writeFile(
        path.join(root, 'data', 'mcp-servers.json'),
        JSON.stringify({
          mcpServers: opts.mcpServers || {
            'cortex-memory': {
              command: process.execPath,
              args: [path.join(PROJECT_DIR, 'mcp-memory-server.js')],
              cwd: PROJECT_DIR,
              timeoutMs: 30000,
              allowedTools: [],
            },
          },
        }, null, 1),
        'utf8'
      );
    } catch { /* التهيئة اختيارية */ }
  }
  // اختيار منفذ: نطلب من النظام منفذاً حرّاً فعلياً (listen(0)) بدل تخمين نطاق.
  // العطل المُثبت 2026-10-23: `listen EACCES: permission denied 127.0.0.1:50245` —
  // ويندوز يحجز نطاقات منافذ (Hyper-V/WinNAT) داخل النطاق العالي، فالمنفذ العشوائي
  // يقع في نطاق محجوز فيموت الخادم قبل أن يقلع. المنفذ من listen(0) يأتي من تجمّع
  // النظام نفسه، ومع ذلك نعيد المحاولة إن فشل الإقلاع (سباق محتمل بعد الإغلاق).
  let port = 0;
  let base = '';
  let token = null;
  let child = null;
  const attempts = opts.port ? 1 : 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    port = opts.port || (await freePort());
    const env = { ...deterministicEnv(root, port), ...(opts.env || {}) };
    base = `http://127.0.0.1:${port}`;
    // الإقلاع تحت قياس: نحتفظ بآخر ما كتبه الخادم كي يكون أي إخفاق مُشخَّصاً لا مجهولاً.
    child = spawn(process.execPath, ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverOut = '';
    const keep = (b) => { serverOut = (serverOut + b.toString('utf8')).slice(-8000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', (code, sig) => { exited = `exit=${code} signal=${sig}`; });
    const diag = () => `${exited ? exited + '\n' : ''}${serverOut || '(لا مخرج)'}`;
    try {
      /* إصلاح 2026-11-12 (سبب تعليق الحزمة 13 دقيقة): كان الانتظار على
         /api/session — وهي نقطة **تسليم سرّ** لا نبضة حياة. بعد إغلاق ثغرة
         AUDIT-2026-11-11 صارت تُرجع 403 لغير المتصفح، فكل اختبار يقلع خادماً
         ينتظر 45 ثانية × 4 محاولات ثم يفشل. الجاهزية تُقاس بـ/api/ping
         (نبضة رخيصة مخصّصة للحارس)، والرمز يُطلب بترويسة متصفح صريحة. */
      await waitFor(`${base}/api/ping`, 45000, diag);
      const fromDisk = await tokenFromRoot(root);
      if (fromDisk) token = fromDisk;
      else {
        const r = await fetch(`${base}/api/session`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
        const j = await r.json().catch(() => null);
        token = (j && j.token) || null;
      }
      lastErr = null;
      break;
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { /* مات بالفعل */ }
      lastErr = e;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (lastErr) throw lastErr;
  return {
    base,
    root,
    port,
    token,
    /** ترويسات جاهزة لأي كتابة (§34) */
    headers: () => ({ 'Content-Type': 'application/json', ...(token ? { 'X-Cortex-Session': token } : {}) }),
    async stop() {
      try { child.kill('SIGKILL'); } catch { /* مات */ }
      // ننتظر قليلاً كي يُحرَّر المنفذ قبل الاختبار التالي
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}

/** يقرأ رمز جلسة من مجلد app root (بدل الشبكة) — للاختبارات التي لا تقلع خادماً. */
export async function tokenFromRoot(appRoot) {
  try {
    return (await readFile(path.join(appRoot, 'data', 'session.token'), 'utf8')).trim();
  } catch { return null; }
}
