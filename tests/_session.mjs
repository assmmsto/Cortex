// مساعد اختبارات: يقرأ رمز الجلسة من نفس الخندق الذي تستعمله الواجهة (§34).
//
// لماذا: بعد إغلاق ثغرة الكتابة غير المصادق عليها (2026-10-20) صار كل مسار كتابة
// يشترط رمز جلسة. الاختبارات تكتب على القرص ⇒ تحتاج الرمز. الحل ليس استثناءً في
// الكود الإنتاجي (استثناء «للاختبارات» = ثغرة تنتظر الانفجار)، بل أن تقرأ
// الاختبارات نفس الرمز من نفس المكان: ملف `data/session.token`، وإلا من /api/session.
//
// الاستعمال:  import { sessionHeaders } from './_session.mjs';
//             await fetch(url, { ..., headers: sessionHeaders() })

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** رمز الجلسة: من ملف الرمز، وإلا من نقطة التسليم الحيّة.
 *  2026-11-12: الرمز مشترك بين كل نسخ نفس المستخدم (ملف واحد في المشروع)، فقراءة
 *  جذر مؤقت بلا ملف كانت تفشل ثم تلجأ إلى /api/session — وقد صار لا يخدم غير
 *  المتصفح (إغلاق ثغرة AUDIT-2026-11-11). الترتيب الآن: جذر التشغيل ← جذر المشروع
 *  ← HTTP. لا استثناء في كود الإنتاج. */
export async function sessionToken({ base = null, appRoot = null } = {}) {
  const roots = [appRoot, projectDir].filter(Boolean);
  for (const root of roots) {
    try {
      const t = fs.readFileSync(path.join(root, 'data', 'session.token'), 'utf8').trim();
      if (t && t.length >= 32) return t;
    } catch { /* لا ملف في هذا الجذر — نجرّب التالي */ }
  }
  if (base) {
    try {
      const r = await fetch(`${base}/api/session`);
      const j = await r.json();
      if (j && typeof j.token === 'string') return j.token;
    } catch { /* لا خادم */ }
  }
  return null;
}

/** ترويسات جاهزة للكتابة — تُضاف إلى أي طلب كتابة. */
export async function sessionHeaders(opts = {}) {
  const t = await sessionToken(opts);
  return t ? { 'X-Cortex-Session': t } : {};
}

export { projectDir };
