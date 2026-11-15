/**
 * نبضة الحارس (2026-11-05) — عطل مُقاس حياً قتل الخادم في منتصف تشغيل وكيل.
 *
 * الدليل من data/watchdog.log على المنتج الحقيقي:
 *   miss ×3 على /api/status (كل فحص مهلة 5ث) ← hang_detected_killing ← revived.
 * السبب: /api/status يشغّل reviewWorkspace + قراءة كل الملاحظات + حالة الاسترجاع
 * (≈3–4 ثوانٍ على قاعدة بـ90 ملاحظة)، فأي حمل يجعله يتجاوز 5 ثوانٍ فيُقرأ «تعلّقاً».
 *
 * الحل: /api/ping بلا أي عمل ثقيل، والحارس يفحصها.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('نبضة الحارس: /api/ping رخيصة ولا تحمل عمل /api/status الثقيل', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });

  const t0 = Date.now();
  const res = await fetch(srv.base + '/api/ping');
  const body = await res.json();
  const ms = Date.now() - t0;

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(ms < 2000, `النبضة سريعة (${ms}ms)`);
  // لو حملت النبضة أي بند من بنود /api/status الثقيلة لعاد العطل نفسه
  assert.equal(body.noteCount, undefined, 'النبضة لا تقرأ كل الملاحظات');
  assert.equal(body.healthScore, undefined, 'النبضة لا تشغّل مراجعة المساحة');
  assert.equal(body.retrieval, undefined, 'النبضة لا تحسب حالة الاسترجاع');
  assert.equal(typeof body.uptime, 'number', 'تحمل مدة التشغيل فقط');
});

test('الحارس يفحص /api/ping لا /api/status — وإلا قتل الخادم في منتصف عمل طويل', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'watchdog.cjs'), 'utf8');
  assert.match(src, /\/api\/ping/, 'الحارس يستعمل النبضة الرخيصة');
  assert.ok(
    !/fetch\(`http:\/\/127\.0\.0\.1:\$\{PORT\}\/api\/status`/.test(src),
    'لم يبقَ فحص /api/status الثقيل في الحارس'
  );
});