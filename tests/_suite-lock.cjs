#!/usr/bin/env node
/**
 * قفل تفرّد موحّد لاختبارات Cortex — يغطي حزمة الوحدات (`npm test`) وحزمة
 * المتصفح (`npm run test:browser`) معاً.
 *
 * لماذا (درس مُثبت ثلاث مرات — 2026-10-20):
 *   تشغيل حزمتين **متوازيتين** على نفس مجلد `data/` أعطى نتائج كاذبة بنفس الكود:
 *     - جولتان لـ`npm test`: 234/252 ← ثم 256/256 مفردة.
 *     - الجولة الحاسمة: تسع عمليات خلفية متصاحبة أعطت في `test:browser`
 *       خمسة أقسام «فاشلة» (03,04,05,06,07) ثم **صفر فشل** عند التشغيل المفرد.
 *       والدليل الحاسم أن `FIN_browser` أعلن «56 نجح · 0 فشل» في الأقسام
 *       ومع ذلك حكم بفشل `04` — أي أن القسم فشل ثم نجح في نفس الجولة.
 *   السبب المشترك: `data/audit.log` (سقف `fs` اليومي) و`data/cortex.db`
 *   وقفل الحزمة نفسه — كلها ملفات واحدة يتسابق عليها المشغّلان.
 *
 * العقد:
 *   acquire('unit' | 'browser') → يرمي `ConcurrentSuiteError` إن كانت حزمة أخرى
 *   تعمل. القفل يتيم (PID ميت) يُستَلَم تلقائياً. التخطّي الواعي:
 *   `CORTEX_ALLOW_CONCURRENT_TESTS=1` (تشخيص متعمّد فقط، ويُعلَن صراحةً).
 *
 * ملاحظة تنفيذية مهمة: `process.on('exit')` لا يُنفَّذ تحت `node --test`، و`spawnSync`
 * يحجب `SIGINT`. لذلك الابن أيضًا يحمل مرجع `pid` فيتحقق كل دخول من حياة المالك.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/* القفل في مجلد النظام المؤقت لا داخل `data/` — حتى لا يُفحَص كملف منتج،
   ولأن `data/` نفسها موضع التنازع (فلا نضيف كاتباً إليها). */
const LOCK = path.join(os.tmpdir(), 'cortex-suite.lock');

class ConcurrentSuiteError extends Error {
  constructor(owner) {
    super(`حزمة اختبار أخرى تعمل الآن (${owner.suite || '؟'} · PID ${owner.pid})`);
    this.name = 'ConcurrentSuiteError';
    this.owner = owner;
  }
}

function ownerAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = موجود بلا صلاحية ⇒ حيّ
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}

/**
 * محاولة الحصول على القفل لحزمة واحدة.
 * @param {string} suite اسم الحزمة ('unit' | 'browser') — للتشخيص فقط.
 * @param {{waitMs?:number}} [opts] انتظار اختياري بدل الفشل الفوري.
 * @returns {() => void} دالة الإفراج (idempotent).
 */
function acquire(suite, opts = {}) {
  if (process.env.CORTEX_ALLOW_CONCURRENT_TESTS === '1') {
    console.log(`⚠ CORTEX_ALLOW_CONCURRENT_TESTS=1 — القفل معطَّل عمداً (${suite})`);
    return () => {};
  }
  const deadline = Date.now() + (opts.waitMs || 0);
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(LOCK), { recursive: true });
      const fd = fs.openSync(LOCK, 'wx'); // ذرّي على كل الأنظمة
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid, suite, at: new Date().toISOString()
      }));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        /* لا نحذف قفل غيرنا (حالة تملّك يتيم بعد فشل نادر) */
        const cur = readLock();
        if (!cur || Number(cur.pid) === process.pid) {
          try { fs.unlinkSync(LOCK); } catch { /* أُزيل مسبقاً */ }
        }
      };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { release(); process.exit(sig === 'SIGINT' ? 130 : 143); });
      }
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = readLock() || {};
      if (owner.pid && ownerAlive(owner.pid)) {
        if (Date.now() < deadline) { // انتظار واعٍ إن طُلب
          const wait = Math.min(500, deadline - Date.now());
          try { require('node:child_process').execSync(`sleep ${wait / 1000}`, { stdio: 'ignore' }); } catch { /* لا sleep */ }
          continue;
        }
        throw new ConcurrentSuiteError(owner);
      }
      console.log(`⚠ قفل يتيم (${owner.suite || '؟'} · PID ${owner.pid || '؟'} ميت) — يُستَلَم`);
      try { fs.unlinkSync(LOCK); } catch { /* سبقنا أحد */ }
    }
  }
}

module.exports = { acquire, release: null, ConcurrentSuiteError, LOCK, ROOT };
