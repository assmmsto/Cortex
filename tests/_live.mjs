import test from 'node:test';

// بوابة §34 + تكامل حيّ: هذه الاختبارات تقيس خادماً حياً على CORTEX_BASE (افتراضياً
// 127.0.0.1:3737). إن لم يكن الخادم مشغّلاً تُتخطّى بدل أن تفشل كذباً — الفشل الكاذب
// يُخفي العطل الحقيقي. شغّل الخادم ثم: node --test tests/<file>.test.mjs
export const BASE = process.env.CORTEX_BASE || 'http://127.0.0.1:3737';

export async function liveServerUp() {
  try {
    const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
