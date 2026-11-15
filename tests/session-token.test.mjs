/**
 * بوابة الهوية + رمز الجلسة + حدود الكتابة (§33 + §34 + §35)
 *
 * يفشل هذا الاختبار صراحةً لو رجع النظام إلى أي مما يلي:
 *   1. كتابة بلا رمز جلسة (401 مفقود).
 *   2. تصعيد الوضع (supervised → autonomous) من حمولة الطلب.
 *   3. توسيع النطاقات من حمولة الطلب (منح «sandbox» ضمنياً).
 *   4. كتابة داخل مساحة العمل **معطّلة** (عطل جذري مُثبت 2026-10-20:
 *      isForbiddenRoot رفض مساحة العمل نفسها لأنها تحت البيت).
 *   5. كتابة خارج مساحة العمل.
 *   6. اجتياز المسار (../).
 *   7. رفض صامت لا يُبلَّغ (§35: الرفض يُعلَن ويُدقّق).
 *
 * يتطلب خادماً شغّالاً على 3737 (يقيس الواقع لا الثوابت).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// خادم معزول ببيئة حتمية (بدل 3737 الحيّ — عطل 2026-10-20)
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
test.after(async () => { await SRV.stop(); });
const ROOT = process.cwd();

async function call(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function token() {
  /* 2026-11-12: بعد إغلاق F1 لم يعد /api/session يخدم غير المتصفح. نُعلن أنفسنا
     متصفحاً على الأصل نفسه (وهو ما تفعله الواجهة) — لا نُضعف الشرط في الإنتاج. */
  const r = await call('/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 200, 'مسار تسليم الجلسة يجب أن يعمل للمتصفح');
  assert.ok(r.json?.token, 'يجب أن يُعاد رمز جلسة');
  return r.json.token;
}

const exec = (mutations, headers, extra = {}) =>
  call('/api/agent/execute', { method: 'POST', headers, body: { mutations, ...extra } });


test('1) الكتابة بلا رمز جلسة مرفوضة والملف لا يُنشأ (§34)', async () => {
  const f = path.join(ROOT, 'data', '_t_unauth.txt');
  try { fs.unlinkSync(f); } catch {}
  const r = await exec([{ tool: 'fs_write', args: { path: f, content: 'x' } }], {});
  assert.equal(r.status, 401, 'يجب 401 بلا رمز');
  assert.equal(fs.existsSync(f), false, 'الملف يجب ألا يُنشأ أبداً');
});

test('2) الكتابة المشروعة داخل مساحة العمل تعمل (لا حجب أعمى)', async () => {
  const f = path.join(ROOT, 'data', '_t_legit.txt');
  try { fs.unlinkSync(f); } catch {}
  const H = { 'X-Cortex-Session': await token() };
  const r = await exec([{ tool: 'fs_write', args: { path: f, content: 'legit' } }], H);
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(f), 'الكتابة داخل مساحة العمل يجب أن تنجح');
  fs.unlinkSync(f);
});

test('3) الجذور المسموحة تشمل مساحة العمل ولا تشمل البيت (§33)', async () => {
  const H = { 'X-Cortex-Session': await token() };
  const r = await exec([], H);
  const roots = r.json?.roots?.allowed || [];
  const norm = s => path.resolve(s).toLowerCase();
  assert.ok(roots.some(x => norm(x) === norm(ROOT)), 'مساحة العمل جذر إلزامي');
  assert.ok(!roots.some(x => norm(x) === norm(os.homedir())), 'البيت ليس جذراً');
});

test('4) تصعيد الوضع من حمولة الطلب مرفوض ومُعلَن (§33)', async () => {
  const H = { 'X-Cortex-Session': await token() };
  const r = await exec([], H, { autonomy: 'autonomous' });
  assert.equal(r.json?.autonomy, 'supervised', 'الوضع يبقى من إعداد النظام');
  assert.equal(r.json?.autonomyOverrideRefused?.requested, 'autonomous',
    '§35: الرفض يُعلَن ولا يُبتلع');
  assert.equal(r.json?.autonomyOverrideRefused?.granted, 'supervised');
});

test('5) توسيع النطاقات من حمولة الطلب مرفوض (§33)', async () => {
  const H = { 'X-Cortex-Session': await token() };
  const r = await exec([], H, { allowedScopes: ['vault', 'filesystem', 'repo', 'sandbox', 'root'] });
  assert.ok(!(r.json?.scopes || []).includes('sandbox'), 'sandbox لا يُمنح ضمنياً');
  assert.ok(!(r.json?.scopes || []).includes('root'));
});

test('6) الكتابة خارج مساحة العمل مرفوضة', async () => {
  const H = { 'X-Cortex-Session': await token() };
  const bad = path.join(os.homedir(), '_t_escape.txt');
  try { fs.unlinkSync(bad); } catch {}
  await exec([{ tool: 'fs_write', args: { path: bad, content: 'e' } }], H);
  assert.equal(fs.existsSync(bad), false, 'لا كتابة خارج الجذور المعلنة');
});

test('7) اجتياز المسار (..) مرفوض', async () => {
  const H = { 'X-Cortex-Session': await token() };
  const target = path.join(path.dirname(ROOT), '_t_traversal.txt');
  try { fs.unlinkSync(target); } catch {}
  await exec([{ tool: 'fs_write', args: { path: '../../../' + path.basename(path.dirname(ROOT)) + '/_t_traversal.txt', content: 't' } }], H);
  assert.equal(fs.existsSync(target), false, 'اجتياز المسار مرفوض');
});
