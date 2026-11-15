import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// النبض الزمني: الوكيل يعمل دون سؤال — فحص عند الإقلاع + موجز صباحي واحد فقط لليوم
test('Scheduler pulses automatically: startup tick + findings + one daily morning brief + audit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-sched-'));
  const port = 3973 + (process.pid % 1000);
  const child = spawn('node', ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_SCHED_MINUTES: '5' },
    stdio: 'ignore'
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  const base = `http://127.0.0.1:${port}`;

  // 1) نبضة الإقلاع تنتج ملف المستجدات دون أي طلب من المستخدم
  let findings = null;
  for (let i = 0; i < 60 && !findings; i++) {
    await new Promise(r => setTimeout(r, 250));
    findings = await fetch(`${base}/api/agent/findings`).then(r => r.json()).catch(() => null);
    if (!findings?.at) findings = null;
  }
  assert.ok(findings, 'findings file produced by scheduler without any user request');
  assert.ok(Array.isArray(findings.findings), 'findings array present');

  // 2) موجز الصباح أُنشئ مرة واحدة — التاريخ بالمعرف يمنع التكرار في نفس اليوم.
  // انتظار محدود إلزامي: ملف المستجدات يُكتب قبل الموجز بـ69ms (مقاس 2026-10-23)،
  // فالقراءة الفورية بعده سباق زمني لا عقد منتج — العقد هو «موجز واحد لليوم» لا «قبل المستجدات».
  let briefs1 = [];
  for (let i = 0; i < 80 && briefs1.length === 0; i++) {
    const notes1 = await fetch(`${base}/api/notes`).then(r => r.json());
    briefs1 = notes1.notes.filter(n2 => n2.id.startsWith('morning-brief-'));
    if (briefs1.length === 0) await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(briefs1.length, 1, 'exactly one morning brief for today');

  /* سباق قتل مقيس 2026-11-14: الموجز يُحفظ ثم يُكتب حدث التدقيق بعده بسطرين،
     والاختبار كان يقتل الخادم لحظة ظهور الملاحظة — فتضيع `morning_brief_created`
     أحياناً (فشل 1 من 458 تحت الحِمل). العقد هو «الإنشاء مُدقَّق»، فانتظاره
     قبل القتل هو الصواب، لا تخفيف الشرط. */
  {
    const auditPath = path.join(root, 'data', 'audit.log');
    let seen = false;
    for (let i = 0; i < 24 && !seen; i++) {
      const a = await readFile(auditPath, 'utf8').catch(() => '');
      seen = /morning_brief_created/.test(a);
      if (!seen) await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(seen, 'morning brief creation is audited before shutdown');
  }

  // 3) إجبار نبضة ثانية (تغيير الإعدادات يسليح المؤقت — هنا نكفي بحقن مؤقت قصير عبر إعادة تشغيل بحرف زمن أصغر ليس ممكنًا داخل نفس العملية؛ إذن نتحقق من التكرار بتشغيل رست ثانية على نفس الجذر)
  child.kill();
  // إيقاف فعلي قبل الإقلاع الثاني: على Windows قد يتأخر إنهاء العملية، فيفشل
  // الخادم الثاني في الربط على المنفذ نفسه ⇒ نبضة واحدة فقط. ننتظر تحرّر المنفذ.
  for (let i = 0; i < 40; i++) {
    const up = await fetch(`${base}/api/status`).then(() => true).catch(() => false);
    if (!up) break;
    await new Promise(r => setTimeout(r, 150));
  }
  const child2 = spawn('node', ['server.js'], { cwd: projectDir, env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_SCHED_MINUTES: '5' }, stdio: 'ignore' });
  t.after(() => child2.kill());
  await waitFor(`http://127.0.0.1:${port}/api/status`);
  const notes2 = await fetch(`${base}/api/notes`).then(r => r.json());
  const briefs2 = notes2.notes.filter(n2 => n2.id.startsWith('morning-brief-'));
  assert.equal(briefs2.length, 1, 'brief not duplicated on reboot same day');

  // 4) التدقيق يحمل آثار النبض الفعلية (نبضتا إقلاع على الأقل + إنشاء موجز واحد)
  // انتظار محدود لا نوم ثابت: الكتابة على القرص تتأخر تحت حِمل الحزمة الكاملة
  // (قِيس: 1 نبضة بعد 2500ms في تشغيل كامل، و2 في تشغيل منفرد — سباق لا عطل).
  let ticks = 0;
  let audit = '';
  for (let i = 0; i < 60; i++) {
    audit = await readFile(path.join(root, 'data', 'audit.log'), 'utf8').catch(() => '');
    ticks = audit.split('\n').filter(l2 => l2.includes('"type":"scheduler_tick"')).length;
    if (ticks >= 2 && /morning_brief_created/.test(audit)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ticks >= 2, `scheduler ticks recorded in audit (${ticks})`);
  assert.match(audit, /morning_brief_created/);
});

function waitFor(url, ms = 8000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { const r = await fetch(url); if (r.ok) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}
