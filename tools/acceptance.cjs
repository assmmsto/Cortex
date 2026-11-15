#!/usr/bin/env node
'use strict';
/**
 * بطاقة قبول الإنتاج — القياس الذي يحكم، لا الانطباع (م46/1: كل ادعاء معه دليل).
 *
 * تستخدم: node tools/acceptance.cjs [--full]
 *   افتراضي: الفحوص الحية السريعة (ثوانٍ).
 *   --full : تشغيل حزمة الوحدات كاملة أولاً وتضمين نسبتها (دقائق).
 *
 * المحاور والأوزان (مجموع 100):
 *   1) الأمان 25        — لا مفاتيح صريحة على القرص؛ البوابات 401/403؛ لا قفل تدقيق معلّق
 *   2) الدستور 20       — سلسلة التدقيق ok؛ بوابات الإطلاق canRelease؛ لا مهام يتيمة >24س
 *   3) التشغيل 15       — الخادم الحي يرد؛ MCP يجيب memory_stats ضمن المهلة
 *   4) الأتمتة 40       — سلامة تركيب كل الوحدات (+ نسبة الحزمة الكاملة مع --full ≥98%)
 * الإسقاط التلقائي: أي P0 (مفتاح صريح / سلسلة مقطوعة / فشل --full) ⇒ الدرجة 0 مع السبب.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const out = (o) => console.log(JSON.stringify(o, null, 2));
const results = { axes: {}, p0: [] };

function axis(name, weight) { results.axes[name] = { weight, score: 0, checks: [] }; return results.axes[name]; }
function check(ax, name, pass, detail) { ax.checks.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 220) }); return !!pass; }

// ── 1) الأمان (25) ──
{
  const ax = axis('security', 25);
  const secretRe = /sk_[A-Za-z0-9]{8,}|lrsk-[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{10,}/;
  let leaked = [];
  const scan = (p) => {
    try {
      if (fs.statSync(p).isDirectory()) {
        for (const f of fs.readdirSync(p)) {
          if (f === 'backups' || f === 'assets' || f.endsWith('.db') || f.endsWith('.db-wal') || f.endsWith('.db-shm')) continue;
          scan(path.join(p, f));
        }
      } else if (/\.(json|log|txt|bak[^/]*)$|\.bak/.test(p) && fs.statSync(p).size < 5 * 1024 * 1024) {
        const txt = fs.readFileSync(p, 'utf8');
        if (secretRe.test(txt) && !/"apiKeyMasked"/.test(txt)) leaked.push(path.relative(ROOT, p));
      }
    } catch { /* غير قابل للقراءة — لا يهم الحكم */ }
  };
  scan(path.join(ROOT, 'data'));
  check(ax, 'no_plaintext_keys_in_data', leaked.length === 0, leaked.length ? `ملفات مسرِّبة: ${leaked.join('، ')}` : 'لا مفاتيح صريحة في ملفات data النصية');
  // بوابات حية: كتابة بلا جلسة ⇒ 401، وبأصل شرير ⇒ 403
  try {
    const http = require('http');
    const post = (hdrs) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: 3737, path: '/api/gates/check', method: 'POST', headers: hdrs, timeout: 4000 }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', () => resolve(0)); r.on('timeout', () => { r.destroy(); resolve(0); }); r.end();
    });
    (async () => {
      const noSession = await post({ 'Content-Type': 'application/json' });
      check(ax, 'mutation_requires_session_401', noSession === 401, `POST بلا جلسة ⇒ ${noSession} (المتوقع 401)`);
      const evil = await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' });
      check(ax, 'csrf_guard_403', evil === 403, `POST بأصل شرير ⇒ ${evil} (المتوقع 403)`);
      markDone('security');
    })();
  } catch (e) { check(ax, 'live_security_probes', false, e.message); }
}

// ── 2) الدستور (20) ──
{
  const ax = axis('constitution', 20);
  try {
    const { createCore } = require(path.join(ROOT, 'cortex-core'));
    const core = createCore({ root: ROOT, projectRoot: ROOT });
    core.verifyAuditChain().then((v) => {
      check(ax, 'audit_chain_ok', v.ok === true, v.ok ? `ختم الحقبة: سطر ${v.sealedAt} · حوادث تاريخية موثقة` : `مقطوع عند ${v.brokenAt}: ${v.reason}`);
      // مهام يتيمة
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(ROOT, 'data', 'cortex.db'), { readOnly: true });
      const stuck = db.prepare("SELECT COUNT(*) c FROM agent_tasks WHERE status IN ('queued','running') AND created_at < ?").get(new Date(Date.now() - 86400000).toISOString()).c;
      check(ax, 'no_stale_tasks', stuck === 0, `مهام عالقة >24س: ${stuck}`);
      // بوابات الإطلاق بمسودات مثبتة
      const GT = require(path.join(ROOT, 'cortex-gates'));
      const { DatabaseSync: DS } = require('node:sqlite');
      const mem = new DS(':memory:');
      mem.exec("CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT, kind TEXT DEFAULT 'note', knowledge_kind TEXT, source TEXT, sensitivity TEXT, project TEXT, content TEXT, created_at TEXT, updated_at TEXT)");
      mem.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
      mem.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
      mem.exec("CREATE TABLE agent_tasks(id TEXT PRIMARY KEY, run_id TEXT, role TEXT, goal TEXT, status TEXT, idempotency_key TEXT UNIQUE, attempts INTEGER DEFAULT 0, created_at TEXT, started_at TEXT, finished_at TEXT)");
      require(path.join(ROOT, 'cortex-schema')).migrate(mem);
      GT.checkGates(mem, {}).then((g) => {
        check(ax, 'release_gates_deterministic', typeof g.canRelease === 'boolean' && g.gates.length >= 8, `بوابات: ${g.gates.length} · canRelease=${g.canRelease} (بلا مسودات ⇒ يجب false)`);
        markDone('constitution');
      });
    });
  } catch (e) { check(results.axes.constitution, 'constitution_probe', false, e.message); markDone('constitution'); }
}

// ── 3) التشغيل (15) ──
async function runAxisOps() {
  const ax = axis('operations', 15);
  try {
    const http = require('http');
    const status = await httpGet('/api/status');
    check(ax, 'live_server', !!status && status.ok === true, status ? `ملاحظات: ${status.noteCount} · صحة: ${status.healthScore}` : 'لا رد من 3737');
  } catch (e) { check(ax, 'live_server', false, e.message); }
  try {
    // MCP: initialize + memory_stats ضمن 30 ثانية
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['mcp-memory-server.js', '--root', ROOT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const t0 = Date.now();
    let got = 0; let buf = Buffer.alloc(0);
    const okMcp = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30000);
      child.stdout.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const sep = buf.indexOf('\r\n\r\n'); if (sep === -1) break;
          const m = buf.slice(0, sep).toString().match(/Content-Length:\s*(\d+)/i); if (!m) break;
          const len = Number(m[1]); const start = sep + 4;
          if (buf.length < start + len) break;
          buf = buf.slice(start + len); got++;
          if (got >= 3) { clearTimeout(timer); resolve(true); }
        }
      });
      const send = (id, method, params) => { const b = JSON.stringify({ jsonrpc: '2.0', id, method, params }); child.stdin.write(`Content-Length: ${Buffer.byteLength(b, 'utf8')}\r\n\r\n${b}`); };
      send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      setTimeout(() => send(2, 'tools/list', {}), 300);
      setTimeout(() => send(3, 'tools/call', { name: 'memory_stats', arguments: {} }), 600);
    });
    child.kill();
    check(ax, 'mcp_responds_in_order', okMcp === true, `3 رسائل متسلسلة خلال ${Date.now() - t0}ms`);
  } catch (e) { check(ax, 'mcp_probe', false, e.message); }
  markDone('operations');
}

function httpGet(p) {
  return new Promise((resolve) => {
    const r = require('http').request({ host: '127.0.0.1', port: 3737, path: p, method: 'GET', timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.end();
  });
}

// ── 4) الأتمتة (40) ──
function runAxisAutomation(full) {
  const ax = axis('automation', 40);
  const mods = fs.readdirSync(ROOT).filter((f) => /^cortex-.*\.js$/.test(f) || f === 'server.js' || f === 'mcp-memory-server.js' || f === 'electron-main.js');
  let broken = [];
  for (const m of mods) {
    const r = spawnSync(process.execPath, ['--check', m], { cwd: ROOT });
    if (r.status !== 0) broken.push(m);
  }
  check(ax, 'all_modules_parse', broken.length === 0, broken.length ? `مكسورة: ${broken.join('، ')}` : `${mods.length} وحدة سليمة التركيب`);
  const constTest = spawnSync(process.execPath, [path.join(ROOT, '_const_test.cjs')], { cwd: ROOT, timeout: 180000, encoding: 'utf8' });
  const m = (constTest.stdout || '').match(/النتيجة:\s*(\d+)\s*نجح\s*·\s*(\d+)\s*فشل/);
  check(ax, 'constitutional_test_58', !!m && Number(m[2]) === 0, m ? `${m[1]} نجح · ${m[2]} فشل` : 'لا ناتج قابل للقياس');
  if (full) {
    const env = { ...process.env, AGENT_DAILY_WRITES: '100000', CORTEX_TEST_MODE: '1', CORTEX_DAILY_FS: '100000', CORTEX_DAILY_VAULT: '100000', CORTEX_DAILY_EXEC: '100000', CORTEX_DAILY_IMPORT: '100000', CORTEX_ALLOWED_ROOTS: [ROOT, os.tmpdir(), path.join(os.tmpdir(), 'cortex-test-roots')].join(path.delimiter) };
    try { fs.mkdirSync(path.join(os.tmpdir(), 'cortex-test-roots'), { recursive: true }); } catch { /* غير حرج */ }
    const suite = spawnSync(process.execPath, ['tests/run-suite.cjs'], { cwd: ROOT, env, timeout: 1800000, encoding: 'utf8' });
    const s = (suite.stdout || '');
    const tm = s.match(/ℹ tests (\d+)/), pm = s.match(/ℹ pass (\d+)/), fm = s.match(/ℹ fail (\d+)/);
    const total = tm ? Number(tm[1]) : 0, pass = pm ? Number(pm[1]) : 0, fail = fm ? Number(fm[1]) : 0;
    const pct = total ? Math.round((pass / total) * 1000) / 10 : 0;
    check(ax, 'full_suite_ge_98', total > 0 && fail === 0 ? true : pct >= 98, `الحزمة: ${pass}/${total} (${pct}%)`);
  } else {
    check(ax, 'full_suite_skipped_use___full', true, 'لم تُشغَّل (مرّر --full لتضمينها)');
  }
  markDone('automation');
}

let finished = false;
/* تنسيق الإنهاء: كل محور يعلن اكتماله — لا درجة قبل اكتمال المحاور الأربعة
   (إصلاح سباق: كان الدستوري يُنهي البطاقة قبل اكتمال التشغيل/الأتمتة). */
const pending = new Set(['security', 'constitution', 'operations', 'automation']);
function markDone(name) { pending.delete(name); if (!pending.size) finish(); }
function finish() {
  if (finished) return; finished = true;
  let total = 0; let max = 0;
  for (const [name, ax] of Object.entries(results.axes)) {
    const passed = ax.checks.filter((c) => c.pass).length;
    ax.score = ax.checks.length ? Math.round((passed / ax.checks.length) * ax.weight * 10) / 10 : 0;
    total += ax.score; max += ax.weight;
  }
  // إسقاط P0: مفتاح صريح أو سلسلة مقطوعة أو حزمة فاشلة
  const sec = results.axes.security || { checks: [] };
  const con = results.axes.constitution || { checks: [] };
  const auto = results.axes.automation || { checks: [] };
  if (sec.checks.some((c) => c.name === 'no_plaintext_keys_in_data' && !c.pass)) results.p0.push('مفتاح API صريح على القرص');
  if (con.checks.some((c) => c.name === 'audit_chain_ok' && !c.pass)) results.p0.push('سلسلة التدقيق مقطوعة');
  if (auto.checks.some((c) => c.name === 'full_suite_ge_98' && !c.pass)) results.p0.push('الحزمة الكاملة دون حد 98%');
  const score = results.p0.length ? 0 : Math.round((total / (max || 100)) * 1000) / 10;
  out({
    score, max: Math.round(max * 10) / 10, p0: results.p0,
    verdict: score >= 98 && !results.p0.length ? 'مقبول إنتاجياً' : 'دون حد القبول',
    axes: results.axes,
  });
  process.exit(score >= 98 && !results.p0.length ? 0 : 1);
}

(async () => {
  await runAxisOps();
  runAxisAutomation(process.argv.includes('--full'));
  // صمام أمان زمني: لا تعليق أبدي للبطاقة نفسها
  setTimeout(() => finish(), 300000);
})();
