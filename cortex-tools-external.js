'use strict';
/**
 * Cortex — الأدوات الخارجية (دستور §23/3، §23/8، §23/9)
 *
 * ملفات · مستودعات · تنفيذ · اختبارات
 * كل أداة هنا محصورة: حدود مسار + سقف وقت + سقف مخرجات + قائمة بيضاء.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { isAllowedCommand, checkProgram, CODE_RUNNERS } = require('./cortex-policy');

const MAX_OUTPUT = 240000;      // سقف المخرجات (حرف)
const DEFAULT_TIMEOUT = 30000;  // سقف الوقت (مللي ثانية)
const MAX_FILE_READ = 400000;   // سقف قراءة ملف

// مجلدات مستبعدة من الفهرسة/القراءة
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next',
  '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache',
  'coverage', '.cache', '.idea', '.vscode',
  /* تخزين المنتج ومجلدات الأدوات ليست ملفات مستودع */
  'data', 'vault', 'tmp', 'logs'
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.svgz',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.pyc',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot'
]);

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift',
  '.sh', '.bash', '.ps1', '.sql', '.vue', '.svelte'
]);

// ────────────────────────── حدود المسار ──────────────────────────

/**
 * الجذور المسموحة — دستور §33/§37.
 *
 * العطل الأصلي (مُثبت حياً 2026-10-20): `os.homedir()` كان جذراً مسموحاً
 * *دائماً* — أي أن الأدوات كانت تكتب داخل بيت المستخدم كله (بما فيه
 * .ssh و AppData و Downloads) بينما مجال الإذن المعلن هو مساحة عمل
 * Cortex وحدها. «لا شيء خارجها» في التعليق كان كذباً على الواقع.
 *
 * القاعدة الصحيحة: مساحة العمل جذر إلزامي وحيد، وأي توسيع يمرّ عبر
 * CORTEX_ALLOWED_ROOTS الصريح فقط (لا تُخترع توسعات ضمنياً)، مع منع
 * الجذور الخطرة (المنزل، جذر القرص، مجلدات الإعدادات) من الدخول إطلاقاً.
 */
const EXTRA_ROOTS = (() => {
  try {
    return String(process.env.CORTEX_ALLOWED_ROOTS || '')
      .split(path.delimiter).map(r => r.trim()).filter(Boolean).map(r => path.resolve(r));
  } catch { return []; }
})();

/* الجذر العام لمجلدات النظام المؤقتة — يُضاف تلقائياً عند تشغيل الاختبارات فقط.
   العطل المقيس 2026-10-20: الاختبارات تُنشئ مجلدات مؤقتة بأسماء متغيّرة
   (mkdtemp: cortex-int-XXXXXX، cortex-fixture-XXXXXX) **بعد** تحميل الوحدة،
   فإدراج مسار بعينه في CORTEX_ALLOWED_ROOTS لا يكفي. التجذير العام (os.tmpdir)
   يغطّي كل ما يُنشأ تحته. مقيَّد بـ CORTEX_TEST_MODE كي لا يتوسّع الإنتاج أبداً:
   المنتج يظلّ على مساحة العمل وحدها (§33). */
const EXTRA_TEST_ROOT = (() => {
  if (String(process.env.CORTEX_TEST_MODE || '') !== '1') return null;
  try {
    const t = path.resolve(os.tmpdir());
    return /^[a-z]:\\?$/i.test(t) ? null : t; // لا تُضف جذر قرص مجرّد
  } catch { return null; }
})();
if (EXTRA_TEST_ROOT && !EXTRA_ROOTS.includes(EXTRA_TEST_ROOT)) EXTRA_ROOTS.push(EXTRA_TEST_ROOT);

/** جذور خطرة: السلطات لا تمنحها إلا بوعي صريح — وهي مرفوضة حتماً (§33). */
function isForbiddenRoot(r) {
  const norm = path.resolve(r).replace(/[\\/]+$/, '');
  if (!norm) return true;
  if (/^[a-z]:$/i.test(norm)) return true;                 // جذر قرص: C:\ أو D:\
  let home = '';
  try { home = path.resolve(os.homedir()).replace(/[\\/]+$/, ''); } catch {}
  if (!home) return false;
  if (norm === home) return true;                          // بيت المستخدم نفسه
  // مجلدات حساسة داخل البيت
  const sensitive = ['AppData', 'Application Data', 'Desktop', 'Documents',
                     'Downloads', 'Library', '.ssh', '.aws', '.config', '.gnupg'];
  if (norm.startsWith(home + path.sep)) {
    const rel = norm.slice(home.length + 1).split(/[\\/]/)[0];
    if (sensitive.includes(rel)) return true;
  }
  return false;
}

function buildAllowedRoots(root) {
  return buildAllowedRoots.report(root).allowed;
}

/**
 * نفس البناء مع تقرير صريح عمّا دخل وعمّا رُفض — ليمكن إثبات الحدّ لا ادّعاؤه.
 */
buildAllowedRoots.report = function report(root) {
  const allowed = [];
  const rejected = [];
  /* §33: مساحة عمل Cortex جذر **إلزامي غير مشروط** — تُضاف أولاً وقبل الفلترة.
     العطل المُثبت حياً 2026-10-20: كانت المساحة تمرّ على isForbiddenRoot،
     ولأنها تقع تحت البيت (…\Downloads\…) رُفضت كـ«مجلد حساس» — فصارت
     الجذور المسموحة `[]`، وتوقّفت كل كتابة داخل المشروع نفسه، بينما
     isForbiddenRoot كان قد بُني أصلاً ليمنع os.homedir() لا لكي يحجب المشروع.
     الحدّ الصحيح: الجذر المعلن إلزامي؛ الفلترة تحكم التوسعات الصريحة فقط. */
  const workspace = path.resolve(root);
  if (workspace && !allowed.includes(workspace)) allowed.push(workspace);
  // فقط إذا كانت مساحة العمل نفسها جذراً مطلقاً/بيتاً حرفياً (حالة مشوّهة) نرفضها صراحةً
  const norm = workspace.replace(/[\\/]+$/, '');
  let home = ''; try { home = path.resolve(os.homedir()).replace(/[\\/]+$/, ''); } catch {}
  if (/^[a-z]:$/i.test(norm) || (home && norm === home)) {
    rejected.push({ root: workspace, why: 'مساحة العمل جذر حساس/مطلق — مرفوض §33' });
    allowed.length = 0;
  }
  /* §33 — التوسيع الصريح قرار واعٍ من المشغّل، لا حالة ضمنية.
     العطل المُثبت حياً 2026-10-20: `os.tmpdir()` على ويندوز = …\AppData\Local\Temp،
     وisForbiddenRoot يرفض كل ما تحت AppData/Downloads — فكانت جذور البيئة الحتمية
     تُرفض كلها، وتفشل اختبارات مجلدات مؤقتة بـ403 كاذب. الحدّ الصحيح: isForbiddenRoot
     يحكم الحالات الضمنية (os.homedir() والمجلدات الحساسة إن دخلت بلا طلب)؛ أما
     CORTEX_ALLOWED_ROOTS فهو إعلان صريح يُقبل، ويبقى مرفوضاً فقط ما هو خطر موضوعياً:
     جذر قرص مجرّد أو بيت المستخدم نفسه (لا يمكن حصره → ليس مساحة عمل). */
  for (const r of EXTRA_ROOTS) {
    const abs = path.resolve(r);
    const normR = abs.replace(/[\\/]+$/, '');
    let homeR = ''; try { homeR = path.resolve(os.homedir()).replace(/[\\/]+$/, ''); } catch {}
    const objectivelyDangerous = /^[a-z]:$/i.test(normR) || (homeR && normR === homeR);
    if (objectivelyDangerous) {
      rejected.push({ root: abs, why: 'CORTEX_ALLOWED_ROOTS: جذر قرص/بيت مجرّد — مرفوض §33 (لا مساحة عمل)' });
      continue;
    }
    if (!allowed.includes(abs)) allowed.push(abs);
  }
  return { allowed, rejected };
};

/**
 * التحقق الحتمي من المسار — دستور §37.
 * يرفض: المسارات النسبية الفاررة، والمسارات خارج الجذور، والروابط الرمزية الفارّة.
 */
function resolveSafePath(input, allowedRoots) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty path' };
  if (raw.includes('\0')) return { ok: false, error: 'null byte in path' };

  const abs = path.resolve(raw);

  const inside = allowedRoots.some(r => abs === r || abs.startsWith(r + path.sep));
  if (!inside) {
    // §33: رسالة صريحة — الرفض يجب أن يشرح نفسه لا أن يبقى لغزاً
    return { ok: false, error: `المسار خارج الجذور المسموحة (${allowedRoots.join(' · ')}) — أضف جذراً عبر CORTEX_ALLOWED_ROOTS`, path: abs, allowedRoots };
  }

  // منع الهروب بالرابط الرمزي — دستور §33/§19.
  // العطل المُثبت حياً 2026-10-20: كان الفحص يسقط عند ENOENT ويعيد {ok:true} بلا فحص،
  // فيكفي أن يكون **أحد أسلاف** المسار رابطاً رمزياً/ junction (مثل vault/_link → C:\Windows\Temp)
  // ليُكتب الملف خارج الجذور. القاعدة: نرفع المسار إلى أقرب سلف **موجود فعلاً**،
  // ونتحقّق من realpath له — وهذا يغطي: ملفاً جديداً، مجلداً جديداً، رابطاً وسطاً، وجذراً مربوطاً.
  const realInside = p => allowedRoots.some(r => p === r || p.startsWith(r + path.sep));

  const verifyExistingAncestor = target => {
    /* الفحص الصحيح ضد روابط الـjunction على ويندوز: نمرّ على **كل مقطع** من المسار
       من الجذر إلى الهدف، ونتحقّق من realpath لكل مقطع **موجود**. سبب فشل الفحص السابق
       (مُثبت حيّاً 2026-10-20): كان يصعد إلى أقرب سلف موجود فقط، فيتخطّى الرابط الأوسط
       (`vault/_link` → C:\Windows\Temp) لأن المقطع الأخير غير موجود فيفشل lstat للرابط
       كاملاً. القاعدة: أي مقطع موجود يكون realpath له **داخل الجذور**، وإلا فرفض.
       وإذا كان المقطع رابطاً رمزياً/unction، يُبنى المسار النهائي من realpath المقطع،
       فيصبح المسار المُعاد هو **الوجهة الحقيقية** لا المسار الرمزي. */
    const realInside = p => allowedRoots.some(r => p === r || p.startsWith(r + path.sep));
    const segs = path.relative(path.parse(target).root, target).split(path.sep).filter(Boolean);
    let built = path.parse(target).root;   // C:\
    let followed = false;

    for (const seg of segs) {
      const next = path.join(built, seg);
      let st = null;
      try { st = fs.lstatSync(next); } catch (e) { st = null; }

      if (st && st.isSymbolicLink()) {
        // مقطع رابط: ننتقل إلى وجهته الحقيقية ونواصل من هناك
        let real;
        try { real = fs.realpathSync(next); } catch (e) { return { ok: false, error: e.message }; }
        if (!realInside(real)) {
          return { ok: false, error: 'symlink/junction يهرب من الجذور المسموحة', path: real, via: next };
        }
        built = real;
        followed = true;
        continue;
      }
      built = next;
    }

    if (!realInside(built)) {
      return { ok: false, error: `المسار خارج الجذور المسموحة (${allowedRoots.join(' · ')}) — أضف جذراً عبر CORTEX_ALLOWED_ROOTS`, path: built, allowedRoots };
    }
    return { ok: true, path: built, followedLink: followed };
  };

  return verifyExistingAncestor(abs);
}

function isBinary(filePath) {
  return BINARY_EXT.has(path.extname(filePath).toLowerCase());
}
function isCode(filePath) {
  return CODE_EXT.has(path.extname(filePath).toLowerCase());
}

function clip(text, max = MAX_OUTPUT) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + `\n…[اقتُطع ${s.length - max} حرفاً]`;
}

// ────────────────────────── تنفيذ العمليات ──────────────────────────

/**
 * تشغيل أمر ضمن قيود صارمة — بلا صدفة (shell:false)، بسقف وقت ومخرجات.
 */
function runCommand(command, { cwd, timeout = DEFAULT_TIMEOUT, env = {}, allowedRoots } = {}) {
  return new Promise(resolve => {
    const check = isAllowedCommand(command);
    if (!check.ok) {
      return resolve({ ok: false, error: `الأمر مرفوض: ${check.reason}`, blocked: true });
    }

    const parts = String(command).trim().split(/\s+/);
    const program = parts[0];
    const argv = parts.slice(1);

    /* §37 — فحص الاستخدام لا اسم البرنامج فقط.
       `node x.js` و`git init C:/Windows/Temp/x` كانا يمرّان لأن الاسم في القائمة البيضاء،
       ثم كتب السكربت/الأمر خارج الجذور (مُثبت حيّاً 2026-10-20). الفحص هنا حتمي بالكود. */
    const roots = allowedRoots && allowedRoots.length ? allowedRoots : buildAllowedRoots(cwd || process.cwd());
    const usage = checkProgram(program, argv, p => resolveSafePath(p, roots));
    if (!usage.ok) {
      return resolve({ ok: false, error: `الأمر مرفوض: ${usage.reason}`, blocked: true });
    }
    /* §37 — المشغّلات التي لا صندوق نظام لها (python/pytest/npm/npx): `--permission`
       خاصية Node وحدها، فكانت هذه تعمل بلا أي حاجز وتكتب في C:\Windows\Temp.
       الحاجز الممكن من هنا حتمي بثلاث طبقات، والدليل معلن في التقرير:
         (١) كل معامل يشبه مساراً يجب أن يبقى داخل الجذور وإلا يُرفض الأمر،
         (٢) cwd يُحلّ داخل الجذور (يُرفض خارجه) وإلا فمجلد مهد داخل الجذر الأول،
         (٣) TEMP/TMP/TMPDIR ومخابئ npm/py تُوجَّه إلى المجلد المهد ⇒ الكتابات
             العرضية (وهي ما قيس فعلاً) تسقط داخل الجذور لا في مجلد النظام.
       الحد الذي لا يُفرَض من هنا: كود python نفسه يستطيع الكتابة بأي مسار صريح؛
       لذلك تبقى هذه الأدوات في مستوى «تنفيذ» بالسياسة (تحتاج اعتماداً). */
    const sandboxDir = path.join(roots[0], '.cortex-sandbox');
    const escapeArg = argv.find((raw) => {
      const s = String(raw);
      if (!s || s.startsWith('-')) return false;
      const looksPath = /^([a-zA-Z]:[\\/]|[/\\]|\.\.?[\\/])/.test(s) || /[\\/]/.test(s) || /[.]\w{1,5}$/.test(s);
      if (!looksPath) return false;
      return !resolveSafePath(path.resolve(cwd || process.cwd(), s), roots).ok;
    });
    if (escapeArg !== undefined) {
      return resolve({ ok: false, error: `الأمر مرفوض: المعامل «${escapeArg}» خارج الجذور المسموحة`, blocked: true });
    }
    let safeCwd = cwd;
    if (safeCwd) {
      const r = resolveSafePath(safeCwd, roots);
      if (!r.ok) return resolve({ ok: false, error: 'الأمر مرفوض: مجلد العمل خارج الجذور المسموحة', blocked: true });
    } else {
      try { fs.mkdirSync(sandboxDir, { recursive: true }); } catch { /* يُنشأ عند الحاجة */ }
      safeCwd = sandboxDir;
    }

    const started = Date.now();
    let stdout = '', stderr = '', killed = false, settled = false;

    const done = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...payload, durationMs: Date.now() - started });
    };

    /* §37 — احتواء حقيقي لمشغّلات الكود (لا مجرد فحص اسم).
       العطل المُثبت حيّاً 2026-10-20: `node x.js` يمرّ الفحص، والسكربت المُنفَّذ يملك بيت
       Node كاملاً فيكتب في C:\Windows\Temp. لا يمكن احتواء Node بـJS؛ فيُنزَل إلى
       **صندوق صلاحيات نظام**: `--permission` مع سماح القراءة/الكتابة داخل الجذور فقط.
       هذه ليست نصيحة بل حاجز في نظام التشغيل — السكربت لا يستطيع تجاوزه (مُقاس حيّاً). */
    let spawnArgv = argv;
    const execArgv = [];
    const sysDirs = [];
    if (CODE_RUNNERS.has(String(program).toLowerCase()) && String(program).toLowerCase() === 'node') {
      execArgv.push('--permission');
      // الكتابة: الجذور المسموحة **فقط** — هذا هو الحاجز الحاسم.
      for (const r of roots) execArgv.push(`--allow-fs-write=${r}`);
      // القراءة: الجذور + نظام Node نفسه (مكتبات/لغة) — لا تمنح كتابة بحال.
      for (const r of roots) execArgv.push(`--allow-fs-read=${r}`);
      for (const sysDir of [path.dirname(process.execPath), process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || '']) {
        if (sysDir) { sysDirs.push(sysDir); execArgv.push('--allow-fs-read=' + sysDir); }
      }
      /* العطل المُقاس 2026-10-27: مشغّل الاختبارات الرسمي `node --test` يشغّل عملية
         لكل ملف اختبار، ونموذج الصلاحيات يمنع child_process افتراضياً — فيفشل الأمر
         بمخرج فارغ أو يفلت الأطفال من الصندوق لو سمحنا بهم. الحل الصحيح: وضع
         «لا عزل» (--test-isolation=none) — كل الاختبارات داخل العملية نفسها،
         فتبقى قيود الصلاحيات (الجذور + منع الكتابة خارجها) سارية بلا ثقوب. */
      if (spawnArgv.includes('--test') && !spawnArgv.includes('--test-isolation=none')) {
        execArgv.push('--test-isolation=none');
      }
    }

    let child;
    try {
      child = spawn(program, [...execArgv, ...spawnArgv], {
        cwd: safeCwd || undefined,
        shell: false,                    // لا صدفة — لا تفسير محارف
        windowsHide: true,
        env: {
          ...process.env, ...env, CORTEX_SANDBOX: '1',
          /* الطبقة (٣): الكتابات العرضية ومخابئ الأدوات داخل الجذور لا في مجلد النظام. */
          TEMP: sandboxDir, TMP: sandboxDir, TMPDIR: sandboxDir,
          npm_config_cache: path.join(sandboxDir, 'npm-cache'),
          PYTHONPYCACHEPREFIX: path.join(sandboxDir, 'pycache'),
          PIP_CACHE_DIR: path.join(sandboxDir, 'pip-cache'),
        }
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, durationMs: 0 });
    }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeout);

    child.stdout?.on('data', d => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr?.on('data', d => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    child.on('error', e => done({ ok: false, error: e.message, stdout, stderr }));
    child.on('close', code => done({
      ok: !killed && code === 0,
      exitCode: code,
      timedOut: killed,
      stdout: clip(stdout),
      stderr: clip(stderr)
    }));
  });
}

// ────────────────────────── أدوات الملفات ──────────────────────────

/**
 * غلاف موحّد: كل أداة ملفات ترجّع { error } ولا ترمي أبداً.
 * دستور §46/1: لا ادعاء بلا دليل — والفشل يُعلن، لا يتحوّل لاستثناء صامت.
 */
function guard(fn) {
  return async (args, ctx) => {
    try { return await fn(args, ctx); }
    catch (e) {
      const code = e && e.code ? e.code : '';
      return { error: e && e.message ? e.message : String(e), code };
    }
  };
}

const fsList = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const entries = await fsp.readdir(r.path, { withFileTypes: true });
  return {
    path: r.path,
    count: entries.length,
    entries: entries.slice(0, 500).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      ignored: IGNORED_DIRS.has(e.name)
    }))
  };
});

const fsRead = guard(async ({ path: p, limit }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  if (isBinary(r.path)) return { error: 'ملف ثنائي — القراءة النصية غير مدعومة', path: r.path };

  const stat = await fsp.stat(r.path);
  if (stat.isDirectory()) return { error: 'المسار مجلد لا ملف', path: r.path };

  const cap = Math.min(Number(limit) || MAX_FILE_READ, MAX_FILE_READ);
  const handle = await fsp.open(r.path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, cap));
    await handle.read(buf, 0, buf.length, 0);
    const content = buf.toString('utf8');
    return {
      path: r.path, size: stat.size, truncated: stat.size > cap,
      lines: content.split('\n').length, content
    };
  } finally {
    await handle.close();
  }
});

const fsStat = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const s = await fsp.stat(r.path);
  return {
    path: r.path, type: s.isDirectory() ? 'dir' : 'file',
    size: s.size, modified: s.mtime.toISOString(),
    binary: isBinary(r.path), code: isCode(r.path)
  };
});

/**
 * بحث نصي — يعيد الملفات المطابقة، مع استبعاد المجلدات المثقلة.
 */
const fsSearch = guard(async ({ path: p, query, limit = 60, glob }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const needle = String(query || '').trim();
  if (!needle) return { error: 'query مطلوب' };

  const maxResults = Math.min(Number(limit) || 60, 300);
  const extFilter = glob ? String(glob).replace(/^\*/, '').toLowerCase() : null;
  const matches = [];
  let scanned = 0;

  async function walk(dir, depth) {
    if (matches.length >= maxResults || depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (matches.length >= maxResults) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (extFilter && !e.name.toLowerCase().endsWith(extFilter)) continue;
      if (isBinary(full)) continue;
      scanned++;
      try {
        const text = await fsp.readFile(full, 'utf8');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (matches.length < maxResults && line.toLowerCase().includes(needle.toLowerCase())) {
            matches.push({ file: full, line: i + 1, text: line.trim().slice(0, 200) });
          }
        });
      } catch {}
    }
  }

  await walk(r.path, 0);
  return { query: needle, scanned, count: matches.length, matches };
});

const fsWrite = guard(async ({ path: p, content }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  await fsp.mkdir(path.dirname(r.path), { recursive: true });
  let before = null;
  try { before = (await fsp.stat(r.path)).size; } catch {}
  await fsp.writeFile(r.path, String(content ?? ''), 'utf8');
  const after = await fsp.stat(r.path);
  return { path: r.path, bytes: after.size, created: before === null, replaced: before !== null };
});

/**
 * تحرير دقيق: استبدال مقطع فريد. يرفض إن لم يكن المقطع فريداً.
 */
const fsEdit = guard(async ({ path: p, find, replace }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const before = await fsp.readFile(r.path, 'utf8');
  const needle = String(find ?? '');
  if (!needle) return { error: 'find مطلوب' };

  const first = before.indexOf(needle);
  if (first === -1) return { error: 'المقطع غير موجود في الملف' };
  const second = before.indexOf(needle, first + 1);
  if (second !== -1) return { error: `المقطع غير فريد — ${before.split(needle).length - 1} تكرار` };

  const after = before.slice(0, first) + String(replace ?? '') + before.slice(first + needle.length);
  await fsp.writeFile(r.path, after, 'utf8');
  return { path: r.path, replaced: needle.slice(0, 80), bytesBefore: before.length, bytesAfter: after.length };
});

const fsMkdir = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  await fsp.mkdir(r.path, { recursive: true });
  return { path: r.path, ok: true };
});

// ────────────────────────── أدوات المستودعات ──────────────────────────

const repoIndex = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const stats = { files: 0, dirs: 0, byExt: {}, code: 0, docs: 0, tests: 0, bytes: 0, entryPoints: [] };
  const ENTRY = new Set(['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'server.js',
                         'main.py', '__main__.py', 'app.py', 'index.html', 'main.go', 'main.rs']);

  // ═══ حماية DoS: سقف صلب للملفات + سقف زمني + إفساح للحدث ═══
  // العطل المُثبت: مجلد واحد كبير (C:/Users) كان يشلّ الخادم كاملاً بطلب GET.
  const MAX_FILES = 20000;          // سقف مطلق — يتجاوزه الفهرس يُعلن truncated
  const MAX_DEPTH = 8;              // كان 12 — عمق مفرط يضاعف الكلفة أسّياً
  const MAX_MS = 8000;              // سقف زمني: بعدها نتوقف ونعلن truncated
  const startedAt = Date.now();
  let truncated = false;
  let yielded = 0;

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    if (stats.files >= MAX_FILES) { truncated = true; return; }
    if (Date.now() - startedAt > MAX_MS) { truncated = true; return; }
    // إفساح حلقة الحدث كل 200 مدخل — يمنع تجميد بقية الطلبات
    if (++yielded % 200 === 0) await new Promise((r) => setImmediate(r));
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stats.files >= MAX_FILES || Date.now() - startedAt > MAX_MS) { truncated = true; return; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        stats.dirs++;
        await walk(full, depth + 1);
        continue;
      }
      stats.files++;
      const ext = path.extname(e.name).toLowerCase() || '(none)';
      const rel = path.relative(r.path, full).replace(/\\/g, '/');
      stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
      if (isCode(full)) stats.code++;
      if (['.md', '.txt', '.rst'].includes(ext)) stats.docs++;
      if (/\.(test|spec)\.[a-z]+$/i.test(e.name) || /(^|\/)(tests?|__tests__)(\/|$)/.test(rel)) stats.tests++;
      if (ENTRY.has(e.name)) stats.entryPoints.push(rel);
      try { stats.bytes += (await fsp.stat(full)).size; } catch {}
    }
  }

  await walk(r.path, 0);

  // مخطوطات التشغيل/الحزم — أدلة ملموسة لا تخمين
  let manifest = null;
  for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod']) {
    const mf = path.join(r.path, name);
    if (fs.existsSync(mf)) {
      const raw = await fsp.readFile(mf, 'utf8');
      manifest = { file: name, excerpt: clip(raw, 4000) };
      break;
    }
  }

  return { root: r.path, ...stats, manifest, truncated, limits: { maxFiles: MAX_FILES, maxDepth: MAX_DEPTH, maxMs: MAX_MS } };
});

const repoTtree = guard(async ({ path: p, depth = 3 }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const maxDepth = Math.min(Number(depth) || 3, 6);
  const lines = [];

  async function walk(dir, d, prefix) {
    if (d > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries = entries.filter(e => !IGNORED_DIRS.has(e.name)).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries.slice(0, 200)) {
      lines.push(`${prefix}${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
      if (e.isDirectory()) await walk(path.join(dir, e.name), d + 1, prefix + '  ');
    }
  }
  await walk(r.path, 0, '');
  return { root: r.path, lines: lines.slice(0, 800), total: lines.length };
});

/**
 * تحليل الاعتماديات — يقرأ الاستيرادات فعلياً، لا يخمّنها (دستور §5).
 */
const repoDeps = guard(async ({ path: p, limit = 400 }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const PATTERNS = [
    { kind: 'esm',       re: /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm },
    { kind: 'esm-bare',  re: /^\s*import\s+['"]([^'"]+)['"]/gm },
    { kind: 'require',   re: /require\(\s*['"]([^'"]+)['"]\s*\)/gm },
    { kind: 'dynamic',   re: /import\(\s*['"]([^'"]+)['"]\s*\)/gm },
    { kind: 'python',    re: /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm },
    { kind: 'go',        re: /^\s*"([\w./-]+)"\s*$/gm }
  ];

  const edges = [];
  const external = new Map();
  let filesScanned = 0;
  let codeFiles = 0;

  async function walk(dir, depth) {
    if (depth > 12 || edges.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (edges.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      const __ext = path.extname(full).toLowerCase();
      /* صفحات HTML تربط سكربتاتها وأنماطها بسمات لا باستيراد — تُحتسب حوافاً.
         قبل حماية isCode وإلا لن تُزار ملفات .html أصلاً (عطل مُقاس). */
      if (__ext === '.html' || __ext === '.htm') {
        let __html = '';
        try { __html = await fsp.readFile(full, 'utf8'); } catch { __html = ''; }
        const __rel0 = path.relative(r.path, full).replace(/\\/g, '/');
        const __tags = [
          { re: /<script[^>]*\ssrc=["']([^"']+)["']/gi, kind: 'script' },
          { re: /<link[^>]*\shref=["']([^"']+)["']/gi, kind: 'link' },
        ];
        for (const __t of __tags) {
          let __m;
          while ((__m = __t.re.exec(__html)) !== null && edges.length < limit) {
            const __rawT = String(__m[1] || '').trim();
            /* /app.js?v=67 ⇒ app.js — الشكل الذي يكتبه HTML فعلاً */
            const __target = __rawT.split('?')[0].split('#')[0].replace(/^\.?\//, '');
            if (!__target || /^(https?:)?\/\//i.test(__target) || /^data:/i.test(__target) || /^mailto:/i.test(__target)) continue;
            edges.push({ from: __rel0, to: __target, kind: __t.kind, line: __html.slice(0, __m.index).split('\n').length });
          }
        }
        codeFiles++;
        filesScanned++;
        continue;
      }
      if (!isCode(full)) continue;
      codeFiles++;
      filesScanned++;
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      const rel = path.relative(r.path, full).replace(/\\/g, '/');

      for (const { kind, re } of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null && edges.length < limit) {
          const target = m[1] || m[2];
          if (!target) continue;
          const isExternal = !target.startsWith('.') && !target.startsWith('/');
          if (isExternal) {
            external.set(target, (external.get(target) || 0) + 1);
          } else {
            edges.push({ from: rel, to: target, kind, line: text.slice(0, m.index).split('\n').length });
          }
        }
      }
    }
  }

  await walk(r.path, 0);

  return {
    root: r.path,
    filesScanned,
    codeFiles,
    internalEdges: edges.length,
    externalCount: external.size,
    edges: edges.slice(0, limit),
    external: [...external.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name, uses]) => ({ name, uses }))
  };
});

/**
 * تحليل الأثر — دستور §39/3.
 * من ملف → ما الذي يستورده فعلياً + ما الذي يستورده (بحث عكسي في الحواف).
 */
const repoImpact = guard(async ({ path: p, file }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  const target = String(file || '').trim();
  if (!target) return { error: 'file مطلوب' };

  const deps = await repoDeps({ path: r.path }, { allowedRoots });
  if (deps.error) return deps;

  const norm = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = path.basename(norm, path.extname(norm));

  const dependsOn = deps.edges.filter(e => e.from === norm || e.from.endsWith('/' + norm));
  const dependedBy = deps.edges.filter(e => {
    const to = String(e.to).replace(/^\.\//, '');
    return to.includes(base) || to.endsWith('/' + base);
  });

  const files = new Set([...dependsOn.map(e => e.from), ...dependedBy.map(e => e.from)]);
  return {
    root: r.path,
    target: norm,
    dependsOnCount: dependsOn.length,
    dependedByCount: dependedBy.length,
    dependsOn: dependsOn.slice(0, 80),
    dependedBy: dependedBy.slice(0, 80),
    affectedFiles: [...files].slice(0, 120),
    note: 'مشتق من حواف الاستيراد الفعلية — لا تخمين'
  };
});

/* repo_list: تعداد المستودعات المفهرسة من قاعدة الطبقة (قراءة فقط، اتصال قصير).
   لا يمرّ بـguard لأنه لا يلمس مساراً — ولا يحتاج صلاحية كتابة. */
function repoList() {
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const root = process.env.APP_ROOT || path.join(__dirname);
    db = new DatabaseSync(path.join(root, 'data', 'cortex.db'), { readOnly: true });
    const repos = db.prepare('SELECT id, path, file_count, last_indexed FROM repos ORDER BY last_indexed DESC').all();
    const c = db.prepare('SELECT COUNT(*) c FROM repo_deps WHERE repo_id = ?');
    const out = repos.map(r => ({
      id: r.id,
      path: r.path,
      files: Number(r.file_count) || 0,
      edges: Number(c.get(r.id).c) || 0,
      lastIndexed: r.last_indexed,
    }));
    return { count: out.length, repos: out, note: 'استعمل repo_deps?repo=<id> أو repo_impact?repo=<id> بلا إعادة مسح' };
  } catch (e) {
    return { count: 0, repos: [], error: `repo_list: ${e.message}` };
  } finally {
    try { if (db) db.close(); } catch { /* أُغلق */ }
  }
}

function gitRun(args, cwd) {
  return runCommand(`git ${args}`, { cwd, timeout: 20000 });
}

const gitStatus = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const res = await gitRun('status --porcelain=v1 --branch', r.path);
  if (!res.ok && res.blocked) return res;
  const lines = String(res.stdout || '').split('\n').filter(Boolean);
  return {
    root: r.path,
    branch: (lines.find(l => l.startsWith('##')) || '').replace('## ', ''),
    changed: lines.filter(l => !l.startsWith('##')).slice(0, 200),
    count: lines.filter(l => !l.startsWith('##')).length
  };
});

const gitLog = guard(async ({ path: p, limit }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const n = Math.min(Number(limit) || 15, 100);
  const res = await gitRun(`log --oneline -n ${n}`, r.path);
  if (!res.ok && !res.stdout) return { error: res.error || 'git log failed' };
  return { root: r.path, commits: String(res.stdout || '').split('\n').filter(Boolean).slice(0, n) };
});

const gitDiff = guard(async ({ path: p, staged }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const res = await gitRun(`diff ${staged ? '--staged' : ''}`, r.path);
  if (!res.ok && res.blocked) return res;
  return { root: r.path, diff: clip(res.stdout || '', 60000), bytes: (res.stdout || '').length };
});

// ────────────────────────── أدوات التنفيذ ──────────────────────────

const shellExec = guard(async ({ command, cwd, timeout }, { allowedRoots }) => {
  const dir = cwd ? resolveSafePath(cwd, allowedRoots) : { ok: true, path: undefined };
  if (!dir.ok) return { error: dir.error };

  const allow = isAllowedCommand(command);
  if (!allow.ok) return { error: `الأمر مرفوض: ${allow.reason}`, blocked: true, command };

  const t = Math.min(Number(timeout) || DEFAULT_TIMEOUT, 120000);
  return runCommand(command, { cwd: dir.path, timeout: t });
});

/**
 * يكتشف أمر الاختبارات من ملفات المشروع الفعلية — لا افتراض (دستور §23/9).
 * الأولوية: سكربت package.json → مجلد tests → ملفات إعداد لغات أخرى.
 */
async function detectTestCommand(root) {
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    let scripts = {};
    try { scripts = JSON.parse(await fsp.readFile(pkgFile, 'utf8')).scripts || {}; } catch {}
    const raw = scripts.test ? String(scripts.test).trim() : '';
    // نقبل فقط الأوامر التي برنامجها الأول في القائمة البيضاء — بلا صدفة
    if (raw && /^(node|npx|npm|python|python3|py|pytest)\b/.test(raw)) {
      return { command: raw, detected: 'package.json:scripts.test' };
    }
  }

  const testsDir = path.join(root, 'tests');
  if (fs.existsSync(testsDir)) {
    let names = [];
    try { names = await fsp.readdir(testsDir); } catch {}
    const suites = names.filter(f => /\.test\.(mjs|cjs|js)$/.test(f)).sort();
    if (suites.length) {
      return {
        command: `node --test ${suites.map(f => 'tests/' + f).join(' ')}`,
        detected: 'tests/*.test.*'
      };
    }
  }

  for (const [marker, command] of [
    ['pytest.ini', 'python -m pytest -q'],
    ['pyproject.toml', 'python -m pytest -q'],
    ['Cargo.toml', 'cargo test'],
    ['go.mod', 'go test ./...']
  ]) {
    if (fs.existsSync(path.join(root, marker))) return { command, detected: marker };
  }

  return { command: null, detected: null };
}

/**
 * تشغيل الاختبارات — دستور §23/9.
 * يكتشف الأداة من ملفات المشروع الفعلية، لا من الافتراض.
 */
const runTests = guard(async ({ path: p, command, timeout }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };

  let cmd = command;
  let detected = 'explicit';

  if (!cmd) {
    const found = await detectTestCommand(r.path);
    cmd = found.command;
    detected = found.detected;
    if (!cmd) return { error: 'لم يُكتشف أمر اختبارات في المشروع', root: r.path, detected: null };
  }

  const allow = isAllowedCommand(cmd);
  if (!allow.ok) return { error: `أمر الاختبار مرفوض: ${allow.reason}`, blocked: true, command: cmd };

  const t = Math.min(Number(timeout) || 180000, 300000);
  const res = await runCommand(cmd, { cwd: r.path, timeout: t });

  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const passed = (out.match(/pass(?:ed)?\s+(\d+)/i) || out.match(/(\d+)\s+pass(?:ed|ing)/i) || [])[1];
  const failed = (out.match(/fail(?:ed)?\s+(\d+)/i) || [!/(\d+)\s+fail/i.test(out) ? null : out.match(/(\d+)\s+fail/i)[1]])[1];

  return {
    root: r.path, command: cmd, detected,
    ok: res.ok, exitCode: res.exitCode, timedOut: res.timedOut,
    // خطأ المشغّل كان يُبتلع هنا — فيبدو الفشل «اختبارات لم تمر» بلا سبب (عطل مُقاس 2026-10-27)
    error: res.error || null, blocked: !!res.blocked,
    passed: passed ? Number(passed) : null,
    failed: failed && Number(failed) > 0 ? Number(failed) : null,
    durationMs: res.durationMs,
    output: clip(out, 40000)
  };
});

const readTestResult = guard(async ({ path: p }, { allowedRoots }) => {
  const r = resolveSafePath(p, allowedRoots);
  if (!r.ok) return { error: r.error };
  const text = await fsp.readFile(r.path, 'utf8').catch(() => null);
  if (text === null) return { error: 'لا يوجد ملف نتائج' };
  return { path: r.path, output: clip(text, 40000) };
});

// ────────────────────────── السجل ──────────────────────────

const TOOL_IMPLS = {
  fs_list: fsList,
  fs_read: fsRead,
  fs_stat: fsStat,
  fs_search: fsSearch,
  fs_write: fsWrite,
  fs_edit: fsEdit,
  fs_mkdir: fsMkdir,
  repo_index: repoIndex,
  repo_tree: repoTtree,
  repo_deps: repoDeps,
  repo_impact: repoImpact,
  repo_list: repoList,
  git_status: gitStatus,
  git_log: gitLog,
  git_diff: gitDiff,
  shell_exec: shellExec,
  run_tests: runTests,
  read_test_result: readTestResult
};

const TOOL_DEFS = [
  { name: 'fs_list',    description: 'اسرد محتويات مجلد على القرص',                    descAr: 'اسرد محتويات مجلد', args: { path: 'string' } },
  { name: 'fs_read',    description: 'اقرأ محتوى ملف نصي',                           descAr: 'اقرأ ملفاً', args: { path: 'string', limit: 'number?' } },
  { name: 'fs_stat',    description: 'بيانات ملف: الحجم والنوع والتاريخ',            descAr: 'بيانات ملف', args: { path: 'string' } },
  { name: 'fs_search',  description: 'ابحث نصياً داخل ملفات مجلد',                   descAr: 'ابحث في الملفات', args: { path: 'string', query: 'string', limit: 'number?' } },
  { name: 'fs_write',   description: 'اكتب ملفاً (يتطلب موافقة)',                    descAr: 'اكتب ملفاً', args: { path: 'string', content: 'string' } },
  { name: 'fs_edit',    description: 'استبدل مقطعاً فريداً داخل ملف (يتطلب موافقة)', descAr: 'حرّر ملفاً', args: { path: 'string', find: 'string', replace: 'string' } },
  { name: 'fs_mkdir',   description: 'أنشئ مجلداً (يتطلب موافقة)',                   descAr: 'أنشئ مجلداً', args: { path: 'string' } },
  { name: 'repo_index', description: 'فهرس مستودعاً: الملفات والأنواع ونقاط الدخول', descAr: 'فهرس مستودعاً', args: { path: 'string' } },
  { name: 'repo_tree',  description: 'اعرض شجرة المستودع',                           descAr: 'شجرة المستودع', args: { path: 'string', depth: 'number?' } },
  { name: 'repo_deps',  description: 'حلّل اعتماديات المستودع من الاستيرادات الفعلية', descAr: 'اعتماديات المستودع', args: { path: 'string' } },
  { name: 'repo_impact',description: 'حدّد أثر تغيير ملف على بقية المستودع',          descAr: 'أثر التغيير', args: { path: 'string', file: 'string' } },
  /* إصلاح 2026-11-13: الوكيل كان يملك فهرسة/اعتماديات/أثر — لكن لا أداة
     **تُعدّد** المستودعات المفهرسة، فلا يعرف أنها موجودة ولا يستعمل ?repo=.
     بلا هذه الأداة يبقى القسم بشرياً: البشر يرون القائمة والوكيل لا. */
  { name: 'repo_list',  description: 'اعرض المستودعات المفهرسة (المسار، عدد الملفات، الحواف، آخر فهرسة) — ابدأ بها قبل أي سؤال عن كود', descAr: 'المستودعات المفهرسة', args: {} },
  { name: 'git_status', description: 'حالة مستودع Git',                              descAr: 'حالة Git', args: { path: 'string' } },
  { name: 'git_log',    description: 'سجل التزامات Git',                             descAr: 'سجل Git', args: { path: 'string', limit: 'number?' } },
  { name: 'git_diff',   description: 'فرق Git غير المرحّل',                           descAr: 'فرق Git', args: { path: 'string', staged: 'boolean?' } },
  { name: 'shell_exec', description: 'نفّذ أمراً من القائمة البيضاء (يتطلب موافقة)', descAr: 'نفّذ أمراً', args: { command: 'string', cwd: 'string?', timeout: 'number?' } },
  { name: 'run_tests',  description: 'شغّل اختبارات المشروع واكتشف نتيجتها',          descAr: 'شغّل الاختبارات', args: { path: 'string', command: 'string?' } },
  { name: 'read_test_result', description: 'اقرأ ملف نتائج اختبارات',                descAr: 'نتائج الاختبارات', args: { path: 'string' } }
];

module.exports = {
  TOOL_IMPLS,
  TOOL_DEFS,
  buildAllowedRoots,
  resolveSafePath,
  runCommand,
  detectTestCommand,
  isBinary,
  isCode,
  clip,
  IGNORED_DIRS,
  LIMITS: { MAX_OUTPUT, DEFAULT_TIMEOUT, MAX_FILE_READ }
};
