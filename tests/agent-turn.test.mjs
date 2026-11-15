/**
 * سلوك الدور الحقيقي — عقود نهاية إلى نهاية على خادم حي.
 *
 * كل عقد هنا يقيس عطلاً كان قائماً ومُثبتاً بالسبر الحيّ، لا وجود دالة:
 * 1) استيراد مسار مجلد: كان `/api/import` يرفض كل مجلد بـ«المسار ليس ملفاً» (400)
 *    رغم وجود `/api/import/folder` — والواجهة ترسل مساراً نصياً واحداً لا تعرف نوعه.
 *    فالمستخدم يكتب مسار مجلد فيحصل على رفض، بلا أي طريق في الواجهة لاستيراد حزمة.
 * 2) رسائل الحرّاس كانت عربية دائماً: طلب `lang:'en'` يعيد «أعط الوكيل هدفًا».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
test.after(async () => { await SRV.stop(); });

async function post(p, body) {
  const r = await fetch(SRV.base + p, { method: 'POST', headers: SRV.headers(), body: JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* SSE أو نص */ }
  return { status: r.status, text: t, json: j };
}

test('استيراد مسار مجلد يُستوعَب كحزمة بدل رفضه كملف', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-folder-'));
  try {
    await fsp.writeFile(path.join(dir, 'a.md'), '# ملاحظة ألف\n\nنص تجريبي للملف الأول.\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'ملاحظة باء بسيطة\n', 'utf8');
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'sub', 'c.md'), '# ملاحظة جيم\n\nداخل مجلد فرعي.\n', 'utf8');

    const r = await post('/api/import', { path: dir });
    assert.equal(r.status, 200, `رد غير متوقع: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json.folder, true, 'الرد لا يعلن أنه استيراد مجلد');
    assert.ok(r.json.scanned >= 3, `المفحوص ${r.json.scanned} أقل من 3 ملفات`);
    assert.ok(r.json.created >= 3, `أُنشئ ${r.json.created} أقل من 3`);
    assert.ok(Array.isArray(r.json.perFile) && r.json.perFile.length >= 3, 'لا تفصيل لكل ملف');
    // المسار الكامل للمجلد يُعاد للعرض، ومسار فرعي واحد على الأقل ظهر بالتفصيل
    assert.ok(String(r.json.root || '').length > 0, 'الجذر مفقود');
    assert.ok(r.json.perFile.some(f => /sub[\\/]c\.md$/.test(String(f.path || ''))), 'الملف داخل مجلد فرعي لم يُستورد');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('استيراد مسار ملف يبقى مفرداً (لا يتحوّل لحزمة)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-onefile-'));
  try {
    const f = path.join(dir, 'solo.md');
    await fsp.writeFile(f, '# ملاحظة وحيدة\n\nمحتوى.\n', 'utf8');
    const r = await post('/api/import', { path: f });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.notEqual(r.json.folder, true, 'ملف مفرد عومل كحزمة');
    assert.ok(r.json.id || r.json.note, 'لا معرّف ملاحظة في الرد');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('رفض مسار غير موجود يبقى 400 برسالة بلا تسريب نظام', async () => {
  const r = await post('/api/import', { path: 'C:/لا-يوجد-مسار-كهذا-' + Date.now() + '/x.md' });
  assert.equal(r.status, 400);
  const msg = String(r.json.error || '');
  assert.ok(msg.length > 0, 'لا رسالة');
  assert.ok(!/EPERM|ENOENT|EACCES|at .*\.js:\d+/.test(msg), `تسريب نص نظام: ${msg}`);
});

test('رسالة هدف فارغ تُرجَّم بلغة الطلب (ar/en)', async () => {
  const en = await post('/api/agent/run', { goal: '   ', lang: 'en' });
  assert.equal(en.status, 400);
  assert.equal(en.json.error, 'Give the agent a goal');
  const ar = await post('/api/agent/run', { goal: '   ', lang: 'ar' });
  assert.equal(ar.status, 400);
  assert.equal(ar.json.error, 'أعط الوكيل هدفًا');
});

test('الوكيل الموقوف يرفض بـ423 ورسالة مترجمة', async () => {
  // الإيقاف ملف حقيقي (data/agent.paused) لا مسار API — هذا هو العقد الفعلي للمنتج.
  const paused = path.join(SRV.root, 'data', 'agent.paused');
  await fsp.mkdir(path.dirname(paused), { recursive: true });
  await fsp.writeFile(paused, '', 'utf8');
  try {
    const en = await post('/api/agent/execute', { lang: 'en' });
    assert.equal(en.status, 423);
    assert.equal(en.json.error, 'The agent is paused');
    const ar = await post('/api/agent/execute', { lang: 'ar' });
    assert.equal(ar.status, 423);
    assert.equal(ar.json.error, 'الوكيل موقوف');
  } finally { await fsp.rm(paused, { force: true }); }
});
