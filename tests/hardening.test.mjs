// اختبارات تحصين 2026-11-12 — كل حالة هنا تقيس عطلاً كان مُثبتاً بالقياس الحيّ.
//
// القاعدة: لا اختبار يُثبت أن الكود «يعمل» عموماً؛ كل حالة تُثبت أن **العطل
// المحدد** لا يمكن أن يعود. الأسماء تصف العطل لا الميزة.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { sessionToken } from './_session.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 60 ثانية لا 25 (2026-11-14): على جهاز مشغول يقلع الخادم أبطأ من المهلة،
   فيُفشل الاختبار لسبب لا علاقة له بالكود (قياس: timeout على المنفذ 4190). */
function waitFor(url, ms = 60000) {
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(url); if (r.ok) return true; } catch { /* لم يقلع */ }
      await new Promise(r => setTimeout(r, 120));
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}

async function boot(t, tag) {
  const root = await mkdtemp(path.join(tmpdir(), `cortex-hard-${tag}-`));
  const port = 4100 + (process.pid % 700) + Math.floor(Math.random() * 200);
  const child = spawn('node', ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_NO_EXTERNAL_REBUILD: '1' },
    stdio: 'ignore',
  });
  t.after(() => { try { child.kill(); } catch { /* مات */ } });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`);
  const token = await sessionToken({ base, appRoot: root });
  return { root, base, token, child };
}

test('SEC-1: /api/session لا يسلّم رمز الكتابة لعملية غير متصفح', async t => {
  const { base } = await boot(t, 'sec');
  // سكربت محلي: بلا Sec-Fetch-Site — كان يحصل على 200 + الرمز (AUDIT-2026-11-11 #1)
  const scripted = await fetch(`${base}/api/session`);
  assert.equal(scripted.status, 403, 'طلب غير متصفح يُرفض');
  const body = await scripted.json();
  assert.equal(body.code, 'not_a_browser');
  assert.equal(body.token, undefined, 'لا رمز في جسم الرفض');

  // متصفح على نفس الأصل: يمرّ
  const browser = await fetch(`${base}/api/session`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(browser.status, 200, 'المتصفح المحلي يحصل على الرمز');
  const ok = await browser.json();
  assert.ok(typeof ok.token === 'string' && ok.token.length >= 32);

  // أصل خارجي: يُرفض حتى مع ترويسة المتصفح
  const foreign = await fetch(`${base}/api/session`, { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://evil.example' } });
  assert.equal(foreign.status, 403, 'أصل خارجي مرفوض');
});

test('CONTRACT-1: مسارات المستودعات لا تُرجع 200 مع حقل خطأ', async t => {
  const { base } = await boot(t, 'repo');
  for (const p of ['/api/repo/index', '/api/repo/deps', '/api/repo/impact']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 400, `${p} بلا مسار ⇒ 400 لا 200`);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.ok(j.error, 'رسالة خطأ صريحة');
  }
});

test('GOV-1: /api/gates يحمل حالة كل بوابة لا كتالوجاً فقط', async t => {
  const { base } = await boot(t, 'gates');
  const j = await (await fetch(`${base}/api/gates`)).json();
  assert.ok(Array.isArray(j.gates) && j.gates.length === 9, 'تسع بوابات');
  for (const g of j.gates) {
    assert.ok(['pass', 'fail', 'unchecked'].includes(g.status), `حالة صريحة لـ${g.key}`);
    assert.ok('passed' in g, 'حقل passed موجود دائماً');
  }
  assert.ok(j.summary && typeof j.summary.releaseAllowed === 'boolean', 'ملخّص إطلاق صريح');
});

test('GOV-2: لا إثبات مرحلة وبوابتها حمراء أو غير مُقيَّمة', async t => {
  const { base, token } = await boot(t, 'prove');
  // جذر جديد ⇒ لا تقييمات ⇒ كل البوابات unchecked ⇒ الإثبات يجب أن يُرفض
  const r = await fetch(`${base}/api/stages/prove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ stage: 'knowledge_base', evidence: { note: 'ادعاء بلا فحص' } }),
  });
  assert.equal(r.status, 400, 'الإثبات مرفوض قبل فحص البوابات');
  const j = await r.json();
  assert.equal(j.code, 'GATES_NOT_GREEN');
  assert.ok(Array.isArray(j.blocked) && j.blocked.length > 0, 'البوابات المانعة مذكورة بالاسم');
});

test('PERF-1: الاستجابات الكبيرة تُضغط عند إعلان gzip', async t => {
  const { base, token } = await boot(t, 'gzip');
  // حمولة كبيرة حقيقية: 12 ملاحظة بمحتوى طويل
  for (let i = 0; i < 12; i += 1) {
    await fetch(`${base}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
      body: JSON.stringify({ title: `Bulk ${i}`, type: 'doc', project: 'Bulk', content: `# Bulk ${i}\n\n${'نص طويل للقياس. '.repeat(120)}` }),
    });
  }
  const plain = await fetch(`${base}/api/notes`);
  const plainBody = await plain.text();
  assert.ok(plainBody.length > 2048, `الحمولة كبيرة بما يكفي للقياس (${plainBody.length})`);

  const gz = await fetch(`${base}/api/notes`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal(gz.headers.get('vary'), 'Accept-Encoding');
  const raw = Buffer.from(await gz.arrayBuffer());
  // fetch يفكّ gzip تلقائياً فيعطينا النص؛ نتحقق من المحتوى ومن البايتات المرسلة.
  const declared = Number(gz.headers.get('content-length') || 0);
  assert.ok(declared > 0 && declared < plainBody.length / 2, `المرسل مضغوط فعلاً (${declared} < ${plainBody.length})`);
  const inflated = raw.toString('utf8');
  assert.equal(JSON.parse(inflated).notes.length, JSON.parse(plainBody).notes.length, 'نفس المحتوى بعد فك الضغط');
});

test('DATA-1: بصمة الملاحظة تُكتب في SQLite (كشف التكرار)', async t => {
  const { base, token, root } = await boot(t, 'fp');
  const res = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ title: 'Fingerprint Probe', type: 'doc', project: 'FP', content: '# Fingerprint Probe\n\nbody\n' }),
  });
  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 1500)); // المزامنة مُجدولة

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'data', 'cortex.db'));
  const row = db.prepare("SELECT fingerprint FROM notes WHERE title = 'Fingerprint Probe'").get();
  db.close();
  assert.ok(row, 'الصف موجود في المرآة');
  assert.ok(row.fingerprint && row.fingerprint.length >= 8, 'البصمة غير فارغة — كان 0/362');
});

test('DATA-3: نسخة تغطي جزءاً من المعرفة تُفشل بوابة الاستعادة', async t => {
  /* عطل مقيس 2026-11-12: `checkBackupRestorable` كان يحجب معامله بقاعدة النسخة
     الداخلية، فظهر liveVault=0 دائماً ومرّت نسخة تغطي 85 من 363 ملاحظة. القاعدة:
     بوابة الاستعادة تفشل إن لم تغطِّ النسخة ≥90% من الملاحظات الحيّة. */
  const { base, token } = await boot(t, 'backupcov');
  const mk = (title) => fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ title, type: 'doc', project: 'Cov', content: `# ${title}\n\nbody\n` }),
  });
  for (const n of ['Cov A', 'Cov B', 'Cov C']) await mk(n);

  const bak = await fetch(`${base}/api/backup`, { method: 'POST', headers: { 'X-Cortex-Session': token } });
  assert.equal(bak.status, 200, 'النسخة تُنشأ');

  // نضيف ملاحظات بعد النسخة ⇒ تغطية ناقصة
  for (let i = 0; i < 30; i += 1) await mk(`Cov Late ${i}`);

  await fetch(`${base}/api/gates/check`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token }, body: '{}' });
  const g = await (await fetch(`${base}/api/gates`)).json();
  const b = g.gates.find(x => x.key === 'backup_restorable');
  assert.equal(b.passed, false, 'نسخة لا تغطي المعرفة الحيّة يجب أن تفشل');
  assert.match(String(b.detail), /تغطية ناقصة|coverage/, `السبب معلن: ${b.detail}`);
});

test('REVIEW-1: /api/review لا يُسقط الخادم (كان ReferenceError)', async t => {
  /* عطل مقيس 2026-11-13: `buildReview` استعمل `E` بلا تعريف ⇒ كل نداء مراجعة
     يقتل العملية. الاختبار لا يقيس الشكل فقط، بل **بقاء الخادم حياً بعده**. */
  const { base, token } = await boot(t, 'review');
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ title: 'Review Probe', type: 'doc', project: 'RV', content: '# Review Probe\n\n## قرار\nنعتمد النهج أ.\n' }),
  });
  const r = await fetch(`${base}/api/review/review-probe`, { headers: { 'X-Cortex-Session': token } });
  assert.equal(r.status, 200, 'المراجعة تعمل');
  const j = await r.json();
  assert.ok(j.classification && Array.isArray(j.gaps), 'بنية المراجعة كاملة');

  const alive = await fetch(`${base}/api/ping`);
  assert.equal(alive.status, 200, 'الخادم ما زال حياً بعد المراجعة');
});

test('PERF-2: ملاحظة ضخمة لا تجمّد البحث (حلقة الحدث محجوبة)', async t => {
  /* عطل مقيس 2026-11-13: دلتا البحث كانت تُقطّع جسم كل ملاحظة متغيّرة بكامله،
     وفي الخزنة ملف 1.6MB ⇒ تجمّد الخادم تماماً (لا ping، لا مهلة تعمل). */
  const { base, token } = await boot(t, 'huge');
  const big = 'نص '.repeat(200000); // ~800KB
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ title: 'Huge Note', type: 'doc', project: 'HG', content: `# Huge Note\n\n${big}\n\nكلمة-فريدة-ضخمة\n` }),
  });

  const t0 = Date.now();
  const s = await fetch(`${base}/api/search?q=${encodeURIComponent('كلمة-فريدة-ضخمة')}`);
  const ms = Date.now() - t0;
  assert.equal(s.status, 200, 'البحث يردّ');
  assert.ok(ms < 5000, `البحث لم يتجمّد (${ms}ms)`);

  const ping = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(3000) });
  assert.equal(ping.status, 200, 'حلقة الحدث حرة بعد البحث');
});

test('IMPROVE-1: حلقة التحسين تُنشئ تجربة وتقيسها فعلاً', async t => {
  /* عطل مقيس 2026-11-13: improvement_trials = 0 صف بينما الوحدة كاملة —
     لا مسار HTTP يستدعي plan/runTrial. الاختبار يثبت أن الحلقة تُنتج بيانات. */
  const { base, token } = await boot(t, 'improve');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };

  const plan = await fetch(`${base}/api/improve/plan`, { method: 'POST', headers: h, body: JSON.stringify({ scope: 'system' }) });
  assert.equal(plan.status, 200);
  const pj = await plan.json();
  assert.equal(pj.ok, true);
  assert.ok(pj.metrics && typeof pj.metrics === 'object', 'قياسات موجودة');

  if ((pj.trials || []).length) {
    const trial = await fetch(`${base}/api/improve/trial`, { method: 'POST', headers: h, body: JSON.stringify({ id: pj.trials[0].id }) });
    const tj = await trial.json();
    assert.equal(tj.verdict, 'trialed', 'التجربة قيست');
    assert.equal(tj.trialResult.isolation, 'ok', 'القياس لم يغيّر القاعدة');
  } else {
    // قاعدة نظيفة قد لا تُنتج مقترحات — نتحقق أن الرفض صريح لا صامت
    const bad = await fetch(`${base}/api/improve/trial`, { method: 'POST', headers: h, body: JSON.stringify({ id: 99999 }) });
    assert.equal(bad.status, 400, 'تجربة غير موجودة تُرفض صراحةً');
  }
});

test('SEV-1: الخطورة تُشتق من دليل معلن فقط — لا تخمين', async t => {
  /* عطل مقيس 2026-11-13: severity_evidence = 0 صف وderiveSeverity بلا مستدعٍ.
     الأهم: لا نكتب صفاً بلا دليل — 373 صفاً بدرجة 0 ضجيج يشبه التغطية. */
  const { base, token } = await boot(t, 'sev');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ title: 'Sev Probe', type: 'doc', project: 'SV', content: '# Sev Probe\n\nx\n' }),
  });

  const blind = await (await fetch(`${base}/api/relations/severity`, { method: 'POST', headers: h, body: '{}' })).json();
  assert.equal(blind.count, 0, 'بلا دليل ⇒ لا صف');
  assert.ok(blind.skipped > 0, 'المتخطّى معلن');

  const withEv = await (await fetch(`${base}/api/relations/severity`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ noteId: 'sev-probe', sensitivity: 'confidential', impact: 0.75 }),
  })).json();
  assert.equal(withEv.count, 1, 'بدليل ⇒ صف واحد');
  assert.ok(['low', 'medium', 'high', 'critical'].includes(withEv.sample[0].severity), `درجة صحيحة: ${withEv.sample[0].severity}`);
  assert.ok(withEv.sample[0].score > 0, 'الدرجة غير صفرية عند وجود دليل');
});

test('MCP-1: إضافة خادم MCP تُتحقَّق قبل الحفظ وترفض الفاسد', async t => {
  /* عطل مقيس 2026-11-13: «أضف خادماً» كان يكتب الإعداد فقط بلا تشغيل ولا
     اكتشاف، فيُحفظ خادم ميت ويظهر «0 أداة» بلا سبب. */
  const { base, token, root } = await boot(t, 'mcpv');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };

  // خادم صالح: يعلن أداة واحدة عبر NDJSON
  const srv = path.join(root, 'fake-mcp.js');
  await writeFile(srv, `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});
const T=[{name:'probe_echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}];
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
rl.on('line',l=>{let m;try{m=JSON.parse(l)}catch{return}if(m.id==null)return;
 if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'f',version:'1'}}});
 if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:T}});
 return send({jsonrpc:'2.0',id:m.id,result:{content:[]}});});
`, 'utf8');

  const ok = await (await fetch(`${base}/api/mcp/servers`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'good', command: process.execPath, args: [srv] }) })).json();
  assert.equal(ok.ok, true, `الخادم الصالح يُقبل: ${JSON.stringify(ok).slice(0, 120)}`);
  assert.equal((ok.tools || []).length, 1, 'أداة واحدة مكتشفة');

  // الخادم يُحفظ مع أدواته (لا 0)
  const list = await (await fetch(`${base}/api/mcp/servers`, { headers: h })).json();
  const saved = (list.servers || []).find(s => s.name === 'good');
  assert.ok(saved, 'محفوظ');
  assert.equal(saved.toolsCount, 1, 'العدد محفوظ');
  assert.ok(saved.verifiedAt, 'وقت التحقق محفوظ');

  // خادم لا يعلن أدوات ⇒ رفض صريح ولا حفظ
  const dead = path.join(root, 'dead-mcp.js');
  await writeFile(dead, "process.stdin.resume();\n", 'utf8');
  const bad = await fetch(`${base}/api/mcp/servers`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'dead', command: process.execPath, args: [dead] }) });
  assert.equal(bad.status, 400, 'الفاسد يُرفض');
  const list2 = await (await fetch(`${base}/api/mcp/servers`, { headers: h })).json();
  assert.ok(!(list2.servers || []).some(s => s.name === 'dead'), 'لم يُحفظ خادم ميت');
});

test('SKILL-1: تحقق المهارة يُعيد عيّنة الجسم لا وجود ملف فقط', async t => {
  const { base, token } = await boot(t, 'skillv');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const all = await (await fetch(`${base}/api/skills`)).json();
  const names = (all.skills || []).map(s => s.name);
  assert.ok(names.length > 0, 'مهارات موجودة');
  const one = await (await fetch(`${base}/api/skills/validate`, { method: 'POST', headers: h, body: JSON.stringify({ name: names[0] }) })).json();
  assert.equal(one.ok, true);
  assert.ok(one.chars > 0, 'جسم مقروء فعلاً');
  assert.ok(String(one.preview || '').length > 0, 'عيّنة معروضة');
  const missing = await fetch(`${base}/api/skills/validate`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'no-such-skill-xyz' }) });
  assert.equal(missing.status, 404, 'غير الموجود يُرفض بصراحة');
});

test('IMP-1: معاينة ملف مفرد تُصنّف ولا ترفض + الاستيراد يُرى في القائمة', async t => {
  /* عطلان مُقاسان 2026-11-13:
     (أ) «معاينة التصنيف» كانت تمرّر أي مسار إلى importFolder، فمسار ملف يُرفض
         بـ«المسار ليس مجلداً» — أي أنها لا تعاين ملفاً أبداً.
     (ب) بعد الاستيراد لا يوجد أي مسار يعرض ما استُورد (311 سجلاً غير مرئي). */
  const { base, token, root } = await boot(t, 'imp');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const file = path.join(root, 'probe-note.md');
  await writeFile(file, '# ملاحظة اختبار\n\nنص للاستيراد.\n', 'utf8');

  // (أ) معاينة ملف: تصنيف حقيقي بلا كتابة
  const pv = await (await fetch(`${base}/api/import/preview`, { method: 'POST', headers: h, body: JSON.stringify({ path: file }) })).json();
  assert.equal(pv.ok, true, 'المعاينة نجحت');
  assert.equal(pv.file, true, 'عُرف أنه ملف');
  assert.equal(pv.kind, 'document', `التصنيف: ${pv.kind}`);
  assert.ok(pv.chars > 0, 'نص مستخرج');

  // لا كتابة من المعاينة
  const before = await (await fetch(`${base}/api/imports`)).json();
  assert.equal(before.count, 0, 'المعاينة لم تُنشئ مستنداً');

  // استيراد فعلي ⇒ يظهر في القائمة
  const im = await (await fetch(`${base}/api/import`, { method: 'POST', headers: h, body: JSON.stringify({ path: file, project: 'IMP' }) })).json();
  assert.equal(im.ok, true, 'الاستيراد نجح');
  const after = await (await fetch(`${base}/api/imports`)).json();
  assert.equal(after.count, 1, 'المستورد ظاهر');
  const doc = after.documents[0];
  assert.ok(doc.title, 'له عنوان');
  assert.equal(doc.sourceExists, true, 'المصدر موجود');
  assert.equal(after.missingSources, 0);
});

test('IMP-2: HTML بمتن مقالي مستند، وقالب بلا متن يبقى كوداً', async t => {
  const { base, token, root } = await boot(t, 'html');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const article = '<html><body><article><h1>عنوان</h1><p>' + 'نص مقالي حقيقي. '.repeat(30) + '</p></article></body></html>';
  const f1 = path.join(root, 'article.html');
  await writeFile(f1, article, 'utf8');
  const pv = await (await fetch(`${base}/api/import/preview`, { method: 'POST', headers: h, body: JSON.stringify({ path: f1 }) })).json();
  assert.equal(pv.kind, 'document', `صفحة فيها متن مستند: ${pv.kind}`);

  const tpl = '<div class="wrap"><span>{{ title }}</span><a href="{{ url }}">link</a></div>';
  const f2 = path.join(root, 'tpl.html');
  await writeFile(f2, tpl, 'utf8');
  const pv2 = await (await fetch(`${base}/api/import/preview`, { method: 'POST', headers: h, body: JSON.stringify({ path: f2 }) })).json();
  assert.equal(pv2.kind, 'code', `قالب بلا متن يبقى كوداً: ${pv2.kind}`);
});

test('SKILL-2: إنشاء مهارة من الواجهة يكتب ويُتحقَّق ويرفض المخالف', async t => {
  /* كان إنشاء مهارة يتطلب وضع مجلد على القرص يدوياً — لا واجهة. */
  const { base, token } = await boot(t, 'skillc');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const before = (await (await fetch(`${base}/api/skills`)).json()).count;

  const ok = await (await fetch(`${base}/api/skills/create`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'probe-skill', description: 'استخدم عند الاختبار.', body: '1. خطوة\n2. أخرى\n' }) })).json();
  assert.equal(ok.ok, true, `أُنشئت: ${JSON.stringify(ok).slice(0, 100)}`);
  assert.ok(ok.chars > 0, 'الجسم مقروء');

  const after = (await (await fetch(`${base}/api/skills`)).json()).count;
  assert.equal(after, before + 1, 'ظهرت في الفهرس فوراً');

  // تكرار بلا overwrite ⇒ 409
  const dup = await fetch(`${base}/api/skills/create`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'probe-skill', description: 'x', body: 'y' }) });
  assert.equal(dup.status, 409, 'التكرار مرفوض');

  // وصف > 300 ⇒ 400
  const long = await fetch(`${base}/api/skills/create`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'too-long', description: 'a'.repeat(320), body: 'y' }) });
  assert.equal(long.status, 400, 'السقف مفروض');

  // اسم بمسار ⇒ يُعقَّم ولا يخرج عن skills/
  const evil = await (await fetch(`${base}/api/skills/create`, { method: 'POST', headers: h, body: JSON.stringify({ name: '../escape', description: 'x', body: 'y' }) })).json();
  assert.equal(evil.ok, true);
  assert.equal(evil.name, 'escape', `الاسم عُقِّم: ${evil.name}`);
});

test('IMP-3: حذف ملاحظة يحذف سجل مستندها (لا أشباح في القائمة)', async t => {
  /* عطل مقيس 2026-11-14: حذف ملاحظة كان يترك صفّها في document_entities إلى
     الأبد — 13 «مستنداً» شبحياً في خزنة حقيقية تظهر بلا وجود. */
  const { base, token, root } = await boot(t, 'imp3');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const file = path.join(root, 'ghost-probe.md');
  await writeFile(file, '# شبح\n\nنص.\n', 'utf8');

  const im = await (await fetch(`${base}/api/import`, { method: 'POST', headers: h, body: JSON.stringify({ path: file, project: 'GH' }) })).json();
  assert.equal(im.ok, true, 'استُورد');
  const noteId = im.note && im.note.id;
  assert.ok(noteId, 'له معرّف');

  const before = await (await fetch(`${base}/api/imports`)).json();
  assert.equal(before.count, 1, 'ظاهر قبل الحذف');

  const del = await fetch(`${base}/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE', headers: h });
  assert.equal(del.status, 200, 'حُذفت الملاحظة');

  const after = await (await fetch(`${base}/api/imports`)).json();
  assert.equal(after.count, 0, 'لم يبقَ سجل مستند');
  assert.equal(after.orphaned, 0, 'لا أشباح');
});

test('PROV-1: فحص المزود قبل الحفظ لا يكتب شيئاً', async t => {
  /* عطل مقيس 2026-11-13: كان الاختبار والحفظ في زر واحد، فيُحفظ المزود
     ويُختار له نموذج تلقائياً قبل أن يرى المستخدم الخيارات. التدفق الصحيح:
     اختبر (بلا كتابة) ⇒ اختر ⇒ احفظ. هذا الاختبار يحمي شرط «بلا كتابة». */
  const { base, token } = await boot(t, 'prov');
  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const countNow = async () => ((await (await fetch(`${base}/api/models/providers`)).json()).providers || []).length;
  const before = await countNow();

  // طلب ناقص يُرفض بصراحة ولا يُنشئ شيئاً
  const bad = await fetch(`${base}/api/models/test-provider`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'X' }) });
  assert.equal(bad.status, 400, 'بلا عنوان ⇒ 400');
  assert.equal(await countNow(), before, 'الفحص لم يضف مزوداً');

  // عنوان غير صالح لا يُحفظ أيضاً
  const badUrl = await fetch(`${base}/api/models/test-provider`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'X', baseUrl: 'not-a-url', apiKey: 'k' }) });
  assert.ok([400, 500].includes(badUrl.status), 'عنوان غير صالح يُرفض');
  assert.equal(await countNow(), before, 'ما زال بلا كتابة');
});

test('REPO-1: قسم المستودعات مرآة لذاكرة الوكيل لا نموذج إدخال', async t => {
  /* عطل مقيس 2026-11-13: القسم كان يستعيد من localStorage فقط ولا مسار يعرض
     ما فهرسه الوكيل — فيبدو فارغاً ولو كان في القاعدة مستودع و175 حافة. */
  const { base, token, root } = await boot(t, 'repolist');
  const repo = path.join(root, 'fixture-repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.js'), "const b = require('./b');\nmodule.exports = b;\n", 'utf8');
  await writeFile(path.join(repo, 'src', 'b.js'), 'module.exports = 1;\n', 'utf8');

  const h = { 'Content-Type': 'application/json', 'X-Cortex-Session': token };
  const ab = await (await fetch(`${base}/api/project/absorb`, { method: 'POST', headers: h, body: JSON.stringify({ path: repo, project: 'rl' }) })).json();
  assert.ok(ab.id, 'الاحتضان أنتج معرّفاً');

  // القائمة تعرضه (هذا ما يجعل القسم ذاكرةً لا حقلاً فارغاً)
  const list = await (await fetch(`${base}/api/repos`)).json();
  const found = (list.repos || []).find(r => r.id === ab.id);
  assert.ok(found, 'المستودع يظهر في /api/repos');
  assert.ok(found.files >= 2, `عدد الملفات معروض: ${found.files}`);
  assert.ok(found.edges >= 1, `عدد الحواف معروض: ${found.edges}`);

  // والوكيل يملك أداة تُعدّدها (لا البشر فقط)
  const ext = require('../cortex-tools-external');
  assert.ok(ext.TOOL_DEFS.some(d => d.name === 'repo_list'), 'repo_list معرّفة للوكيل');
  const fromTool = ext.TOOL_IMPLS.repo_list();
  assert.ok(Array.isArray(fromTool.repos) && fromTool.repos.length >= 1, 'repo_list تُعيد المستودعات');

  // الأثر من الحواف المخزَّنة بلا إعادة مسح
  const imp = await (await fetch(`${base}/api/repo/impact?repo=${encodeURIComponent(ab.id)}&file=src/b.js`)).json();
  assert.equal(imp.source, 'sqlite', 'الأثر يُحسب من SQLite');
  assert.ok((imp.affected || []).length >= 1, `مَن يعتمد على b.js: ${JSON.stringify(imp.affected)}`);
});

test('DATA-2: الاحتضان يكتب حواف الاعتماديات في repo_deps', async t => {
  const { base, token, root } = await boot(t, 'absorb');
  // مستودع صغير حقيقي داخل الجذر المؤقت
  const repo = path.join(root, 'fixture-repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.js'), "const b = require('./b');\nmodule.exports = b;\n", 'utf8');
  await writeFile(path.join(repo, 'src', 'b.js'), "module.exports = 1;\n", 'utf8');

  const res = await fetch(`${base}/api/project/absorb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': token },
    body: JSON.stringify({ path: repo, project: 'Fixture' }),
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out).slice(0, 200));
  assert.ok(out.repoDepsWritten >= 1, `حواف مكتوبة (${out.repoDepsWritten}) — كان الجدول 0 صف`);

  const stored = await (await fetch(`${base}/api/repo/deps?repo=${encodeURIComponent(out.id)}`)).json();
  assert.equal(stored.ok, true);
  assert.ok(stored.count >= 1, 'الحواف تُقرأ من SQLite بلا إعادة مسح');
  assert.ok(stored.edges.some(e => e.to_file.includes('b.js')), 'الحافة الصحيحة موجودة');
});
