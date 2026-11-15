'use strict';
/**
 * tests/browser/_isolate.cjs — خادم معزول حتمي لاختبارات المتصفح.
 *
 * لماذا (عطل مُثبت 2026-10-20 بأدلة قياس):
 *   اختبارات المتصفح كانت تستهدف `http://127.0.0.1:3737` — أي **خادم المنتج**
 *   ومعه `data/cortex.db` الحقيقي. فكل اختبار يستورد/ينشئ عناصر يكتب على قاعدة
 *   المنتج، فتنمو القاعدة بلا حد (قِيس: 179 → 239 → 255 عنصراً) وتُفسد الاختبارات
 *   اللاحقة التي تقيس أرقاماً مطلقة:
 *     • `01-notes-graph`: «مسح البحث يستعيد الكل — 180» (توقّع 179 فصار 180).
 *     • `02-sections`: «العنصر المضاف هو ROADMAP المستورد فعلاً — Atlas»
 *       (العنصر الأحدث ليس المستورَد لأن بيانات قديمة تسبقه طبيعياً).
 *   اختبار يعتمد على تاريخ قاعدة مشتركة ليس اختباراً — نتيجته تعتمد على من شغّل
 *   ماذا قبله. القاعدة نفسها المطبَّقة على اختبارات الوحدة (`tests/_live-server.mjs`):
 *   كل جولة تقلع خادمها المعزول وتزرع أرضية معرفة ثابتة.
 *
 * الاستعمال:
 *   const iso = await require('./_isolate.cjs').start();
 *   ... CORTEX_URL = iso.base ...
 *   await iso.stop();
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');

/**
 * أرضية حتمية: N عنصراً بنوع متنوّع + روابط wiki حقيقية بينها.
 *
 * التصميم مقيَّد بما تقيسه الاختبارات فعلاً (لا افتراض):
 *   • `01-notes-graph` يكتب «Atlas» في البحث وينتظر `0 < nf < n0` ⇒ لزم أن يكون
 *     «Atlas» في **بعض** العناوين لا كلها (وإلا فلترة 0 أو الكل).
 *   • وينتظر «المشاريع» وفلترة النوع ⇒ لزم تنويع `type` و`project`.
 *   • `02-sections` يستورد ملفاً حقيقياً ويريد أن يظهر العنصر الأحدث ⇒ الأرضية
 *     **لا** تحمل عنصراً بعنوانه «ROADMAP».
 *   • `04-graph-interactive` يحتاج عقدة لها علاقة **غير ذاتية** ⇒ روابط دائرية
 *     بين عقد مختلفة (لا `A → A`).
 */
function seedPlan(n) {
  const kinds = ['note', 'decision', 'risk', 'question', 'meeting', 'doc'];
  const files = [];
  const notes = [];
  const stamp = new Date('2026-01-01T00:00:00.000Z').toISOString();
  for (let i = 0; i < n; i++) {
    const id = String(i + 1).padStart(3, '0');
    const next = String(((i + 1) % n) + 1).padStart(3, '0');
    // الهدف البعيد (قفزة 5) — يصنع روابط عابرة لا سلسلة.
    const farId = ((i + 5) % n) + 1;
    const far = `${farId % 3 === 0 ? 'Atlas ' : ''}عنصر بذرة ${String(farId).padStart(3, '0')}`;
    // عنصر عنقودي ثابت لكل ثالثة — يجمع كل ثالثة في عنقود مشترك.
    const hubId = (i % 3) * 7 + 1;
    const hub = String(hubId).padStart(3, '0');
    // ثلث العناوين تحمل «Atlas» ⇒ بحث «Atlas» يُفلتر بلا أن يمحو الكل.
    const marker = i % 3 === 0 ? 'Atlas ' : '';
    const title = `${marker}عنصر بذرة ${id}`;
    const type = kinds[i % kinds.length];
    const project = i % 3 === 0 ? 'core' : 'cortex';
    const slug = `seed-${id}`;
    const body = [
      '---',
      `tags: ["seed", "اختبار"]`,
      `importance: ${(i % 5) + 1}`,
      `type: ${type}`,
      `project: ${project}`,
      `created: "${stamp}"`,
      `updated: "${stamp}"`,
      '---',
      `# ${title}`,
      '',
      `محتوى العنصر ${id} — أرضية اختبار حتمية.`,
      '',
      /* شبكة معرفة حقيقية لا سلسلة خطية (تقوية 2026-10-20):
         كان كل عنصر يحمل [[wikilink]] واحداً للعنصر التالي ⇒ 24 عقدة تُنتج
         **16 رابطاً فريداً فقط** (سلسلة مكرّرة تُدمج)، فاختبار «الروابط تُرسم ≥20»
         كان يسقط على أرضية أضعف من أن تقيس خريطة. الأرضية الصحيحة تُنتج شبكة:
         (أ) حلقة أساسية i → i+1 (تُبقي الاتصال)،
         (ب) قفزة i → i+5 بعنوان أقرب لعنصر ثالث (روابط مركّبة/عناقيد)،
         (ج) جسر كل ثلاثة عناصر إلى عنصر في الوسط (يصنع عناقيد).
         النتيجة: ~3 روابط فريدة لكل عنصر ⇒ شبكة تتجاوز حد الرسم بمرجّح. */
      `انظر [[عنصر بذرة ${next}]] للتفاصيل.`,
      `ومترابط أيضاً بـ[[عنصر بذرة ${far}]] في السياق.`,
      `مرجع شبكي: [[Atlas عنصر بذرة ${hub}]] (عنقود ${i % 3}).`,
      '',
    ].join('\n');
    files.push([`${slug}.md`, body]);
    notes.push({ id: slug, title, type, project });
  }
  return { files, notes };
}

/** بيئة حتمية — نفس قيم `tests/_live-server.mjs` و`tests/run-suite.cjs`. */
function deterministicEnv(root, port) {
  return {
    ...process.env,
    APP_ROOT: root,
    APP_PORT: String(port),
    AGENT_DAILY_WRITES: '100000',
    CORTEX_DAILY_FS: '100000',
    CORTEX_DAILY_VAULT: '100000',
    CORTEX_DAILY_EXEC: '100000',
    CORTEX_DAILY_IMPORT: '100000',
    CORTEX_ALLOWED_ROOTS: [PROJECT_DIR, root, os.tmpdir()].join(path.delimiter),
    CORTEX_TEST_MODE: '1',
  };
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* لم يقلع */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`الخادم المعزول لم يقلع خلال ${ms}ms — ${url}`);
}

/**
 * يقلع خادماً معزولاً ويزرع الأرضية، ويعيد `{ base, root, port, token, stop() }`.
 * @param {{seed?:number, autonomy?:string, lang?:string}} [opts]
 */
async function start(opts = {}) {
  const seedN = opts.seed === undefined ? 24 : opts.seed;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ui-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true });
  // إعدادات حتمية: مزود mock محلي (لا شبكة)، وضع الوكيل، اللغة.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', temperature: 0.2 },
    agent: { defaultMode: 'project', autonomy: opts.autonomy || 'supervised' },
    lang: opts.lang || 'ar',
  }, null, 1), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({
    mcpServers: {
      'cortex-memory': {
        command: process.execPath,
        args: [path.join(PROJECT_DIR, 'mcp-memory-server.js')],
        cwd: PROJECT_DIR,
        timeoutMs: 15000,
        allowedTools: [],
      },
    },
  }, null, 1), 'utf8');

  // ── الخزنة تُزرع **قبل** الإقلاع (عطل مُثبت 2026-10-20) ──
  // `ensureBaseFiles` يزرع `vault/welcome.md` **فقط إن كانت الخزنة فارغة**.
  // خادم معزول بخزنة فارغة ⇒ يُزرع `Welcome` (وكذلك `ai-roadmap`) فيصير `Welcome`
  // العنصر الأحدث، فاختبار `02-sections` الذي يستورد `docs/ROADMAP.md` ويريد أن
  // يظهر **هو** الأحدث يقرأ `Welcome` ⇒ إخفاق بلا أي عطل في الاستيراد.
  // القاعدة: الأرضية تُكتب قبل إقلاع الخادم، فلا يبقى للزرع التلقائي محل.
  if (seedN > 0) {
    const { files } = seedPlan(seedN);
    for (const [name, body] of files) fs.writeFileSync(path.join(root, 'vault', name), body, 'utf8');
  }

  /* عطل مُقاس 2026-10-28 (بعد إعادة تشغيل Windows): النطاق الثابت 41000-53000
     يتقاطع مع نطاقات محجوزة نظامياً (`netsh excludedportrange` — Hyper-V/WSL) ⇒
     EACCES عند الربط وفشل إقلاع المعزول عشوائياً. الصواب: يمنح النظام منفذاً حراً
     فعلياً (listen على 0 يختار من العابر ويستبعد المحجوز بنيوياً). */
  const port = opts.port || await (() => new Promise((resolve, reject) => {
    const probe = require('node:net').createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  }))();
  const env = deterministicEnv(root, port);
  const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT_DIR, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let token = null;
  try {
    await waitFor(`${base}/api/session`);
    const r = await fetch(`${base}/api/session`);
    token = ((await r.json().catch(() => null)) || {}).token || null;
    const h = { 'Content-Type': 'application/json', ...(token ? { 'x-cortex-session': token } : {}) };

    // (1) مزوّد مُعدّ: `02-sections` يقيس «المفتاح مُقنَّع لا مكشوف» وعدد النماذج.
    //     لا نستدعي `/api/models/add-provider` لأنه **يجري اتصال HTTP حقيقياً**
    //     (gw.addProvider) فيفشل مع أي عنوان غير قابل للوصول. نكتب الإعداد مباشرة
    //     في `settings.json` — وهو ما يقرؤه الخادم. المفتاح **وهمي** (للقياس وحده).
    try {
      const sf = path.join(dataDir, 'settings.json');
      const cur = JSON.parse(fs.readFileSync(sf, 'utf8'));
      // إصلاح أمني/حتمية (2026-10-20): المزوّد الافتراضي عند الإقلاع `mock`
      // (محلي بلا شبكة، §الخصوصية). نُبقيه ونضيف مزوّداً ثانياً بنموذجين كي
      // يقيس `02-sections` «المفتاح مُقنَّع لا مكشوف» وعدد النماذج فعلاً.
      // المفتاح **وهمي** (لا سرّ حقيقي) والتنقيح هو المقيس.
      cur.providers = [
        { name: 'mock', baseUrl: 'local://mock', apiKey: '', enabled: true, models: ['cortex-local'] },
        {
          name: opts.providerId || 'seedprov',
          baseUrl: 'https://api.example.invalid/v1',
          // نص اختباري بلا قالب «sk-» — لا شيء في العزل يجب أن يوحي بمفتاح حقيقي
          // (حتى مقياس التقنيع يعمل على أي نص؛ تنبيه الحارس الأمني 2026-10-28).
          apiKey: opts.providerKey || 'test-provider-key-seed-0001',
          enabled: true,
          models: ['seed-model-a', 'seed-model-b'],
        },
      ];
      fs.writeFileSync(sf, JSON.stringify(cur, null, 1), 'utf8');
    } catch { /* اختياري */ }

    if (seedN > 0) {
      // الأرضية كُتبت في الخزنة قبل الإقلاع؛ هنا نُعيد بناء فهرس الاسترجاع فقط
      // كي تُبنى الروابط والعُقد من الملفات الفعلية (لا زرع مكرّر عبر الـAPI).
      await fetch(`${base}/api/retrieval/rebuild`, { method: 'POST', headers: h, body: '{}' }).catch(() => {});
    }

    // (2) تشغيل فريق حقيقي أرضي: `03-team-monitor` يقيس «اختيار تشغيل من القائمة»
    //     و«قائمة التشغيلات السابقة» — فخادم بلا أي تشغيل يُخفق بلا عطل في اللوحة.
    //     نُشغّل تشغيلين عبر المسار الحقيقي (أدلة حيّة لا محاكاة).
    try {
      for (const g of ['تشغيل أرضي أول', 'تشغيل أرضي ثانٍ']) {
        await fetch(`${base}/api/agent/orchestrate`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ goal: g, project: 'core' }),
        }).catch(() => {});
      }
    } catch { /* تشغيل الفريق الأرضي اختياري */ }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch { /* مات */ }
    throw e;
  }
  return {
    base, root, port, token,
    headers: () => ({ 'Content-Type': 'application/json', ...(token ? { 'x-cortex-session': token } : {}) }),
    async stop() {
      try { child.kill('SIGKILL'); } catch { /* مات */ }
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

module.exports = { start, seedPlan, deterministicEnv, PROJECT_DIR };
