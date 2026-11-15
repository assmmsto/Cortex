'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// cortex-skills — مهارات الوكيل ببروتوكول Anthropic ثلاثي الطبقات
// (النمط مستمد من knowledge-work-plugins: التكلفة تُحمَّل بحسب الحاجة لا دفعة واحدة).
//
//   الطبقة 1 (ميتاداتا دائماً في السياق): name + description فقط → list() / renderIndex()
//   الطبقة 2 (جسم المهارة عند التفعيل):   SKILL.md بحد أقصى 6000 حرف → get().body / renderSkill()
//   الطبقة 3 (مراجع عند الطلب فقط):       references/*.md → readReference()
//
// بنية المهارة على القرص:
//   <dir>/<name>/SKILL.md
//   <dir>/<name>/references/*.md      (اختياري)
//
// مبدآن غير قابلين للكسر (محفوران بالكود والاختبار):
//   • مهارة فاسدة لا تُسقط الوحدة أبداً: تُتخطى وتُدرج مشكلة {name, reason} في issues.
//   • المراجع محبوسة داخل مجلد المهارة: رفض .. و / و \ في اسم المرجع، ثم فحص
//     resolve نهائي، ورفض الروابط الرمزية (lstat) — لا قراءة خارج الحدود بأي حال.
//
// قرارات موثقة:
//   • reload() يقرأ كل ملف كاملاً في كل نداء — mtime يُعرض في updatedAt ولا يُستخدم
//     مفتاحَ كاش، حتى لا يفوت تعديل كتبه أداة في نفس الطابع الزمني.
//   • تطبيع الاسم (slug): تقليم + خفض اللاتيني + طيّ المسافات إلى شرطة، ثم فرض
//     النمط [a-z0-9\u0600-\u06FF-]{2,64} — فالاسم «Project Analysis» يصبح project-analysis.
//   • لا console.log هنا: مكتبة صامتة تُعيد قيماً — نمط بقية وحدات cortex-*.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MAX_BODY_CHARS = 6000;   // سقف جسم المهارة (الطبقة 2) — قرار التصميم
const MAX_DESC_CHARS = 300;    // سقف الوصف (الطبقة 1)
const MAX_REF_CHARS = 20000;   // سقف قراءة المرجع الواحد (الطبقة 3)
const NAME_RE = /^[a-z0-9\u0600-\u06FF-]{2,64}$/;

/** تطبيع الاسم إلى slug: تقليم + خفض اللاتيني + طيّ المسافات إلى شرطة. لا يرمي. */
function normName(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '-');
}

/** ar إلا أن تبدأ السلسلة بـ en — نفس دلالة cortex-i18n.norm. لا يرمي. */
function normLang(lang) {
  return String(lang || '').toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/** ترتيب حتمي بالاسم (مقارنة نقاط كود — لا يتغير مع الّلوكيل). */
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * YAML مبسّط: سطر لكل `key: value`؛ `tags` بصيغة [a, b]. أسطر غير صالحة تُتجاهل.
 * لا يرمي أبداً — العقد أن التحقق يقع في parseSkillFile برسائل واضحة.
 */
function parseFrontmatter(text) {
  const meta = {};
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (key === 'tags') {
      const inner = (val.startsWith('[') && val.endsWith(']')) ? val.slice(1, -1) : val;
      meta.tags = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return meta;
}

/**
 * يقرأ محتوى SKILL.md ويرمي Error برسالة عربية واضحة عند أي مخالفة:
 * frontmatter مفقود · name غائب/غير صالح · description غائب/>300 · body >6000.
 */
function parseSkillFile(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) throw new Error('frontmatter مفقود: يجب أن يبدأ SKILL.md بسطر ---');
  const meta = parseFrontmatter(m[1]);
  const body = text.slice(m[0].length).trim();
  const name = normName(meta.name);
  if (!name) throw new Error('حقل name مطلوب في frontmatter');
  if (!NAME_RE.test(name)) throw new Error(`اسم غير صالح «${name}»: المسموح حروف لاتينية صغيرة/أرقام/عربية/شرطة، 2–64`);
  const description = String(meta.description == null ? '' : meta.description).trim();
  if (!description) throw new Error('حقل description مطلوب في frontmatter');
  if (description.length > MAX_DESC_CHARS) throw new Error(`الوصف يتجاوز ${MAX_DESC_CHARS} حرفاً (${description.length})`);
  if (body.length > MAX_BODY_CHARS) throw new Error(`الجسم يتجاوز ${MAX_BODY_CHARS} حرفاً (${body.length})`);
  return { name, description, tags: Array.isArray(meta.tags) ? meta.tags : [], body };
}

/** أسماء مراجع المهارة (ملفات .md فقط) مرتبة — الطبقة 3. لا يرمي. */
function listReferences(skillDir) {
  try {
    const refDir = path.join(skillDir, 'references');
    if (!fs.existsSync(refDir)) return [];
    return fs.readdirSync(refDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** يبني نص SKILL.md من حقول البذرة — فلا ينحرف المُكتوب عمّا يتحقق منه القارئ. */
function buildSkillFile(s) {
  return `---\nname: ${s.name}\ndescription: ${s.description}\ntags: [${(s.tags || []).join(', ')}]\n---\n\n${s.body}\n`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   المهارات البذرية الأربع — إرشادات تشغيلية لوكيل يعمل على مشاريع كود.
   الوصف بصيغة «استخدم عند… / Use when:» = عبارات الاستدعاء (الطبقة 1)،
   والجسم imperative بلا «يبدو» و«غالباً»: كل حكم يُسند إلى قياس.
   ───────────────────────────────────────────────────────────────────────────── */
const DEFAULT_SKILLS = Object.freeze([
  {
    name: 'project-analysis',
    description: 'استخدم عند تحليل مشروع أو مستودع كود. Use when: «حلّل المشروع»، «ما بنية الملفات»، "analyze the repo", "file impact". التسلسل: repo_index ثم repo_tree ثم repo_impact، وكل حكم بلا مسار دليل مرفوض.',
    tags: ['analysis', 'repo', 'evidence'],
    body: `# تحليل مشروع/مستودع — القياس قبل الحكم

English: index → tree → impact; every claim needs a file path.

## متى تُستدعى
- «حلّل المشروع» أو «اعرض بنية المستودع» أو «ما الملفات المرتبطة بهذا الملف؟».
- قبل أي تعديل واسع النطاق: لمعرفة ما قد ينكسر.

## التسلسل الإلزامي (لا تُخلّ بالترتيب)
1. repo_index أولاً — ابنِ فهرس الملفات وعددها الإجمالي. لا تُصدر أي حكم قبل هذه الخطوة.
2. repo_tree ثانياً — استخرج الشجرة الكاملة وحدّد: مجلدات المصدر، الاختبارات، البناء، الإعدادات.
3. repo_impact عند كل لمس — استخرج الملفات المعتمدة قبل التعديل لا بعده.

## قاعدتان محفورتان
- لكل ملف تذكره: اكتب مساره الكامل من جذر المشروع (مثال: cortex-core.js). بلا مسار = بلا ذكر.
- ممنوع «يبدو أن» و«غالباً» و«من المحتمل»: إن لم يكن هناك مخرج أداة أو سطر ملف فاكتب «غير مقيس» صراحة.

## شكل المخرجات
- جدول: ملف | دوره | الدليل (أداة أو ملف:سطر).
- قسم «حدود التحليل»: ما لم يُفحص يُعلن ولا يُوارى.`,
    references: {
      'tools.md': `# أدوات التحليل — تفاصيل الاستدعاء

- repo_index: يمسح جذر المشروع ويُعيد قائمة الملفات وعددها الإجمالي مع تصفية مجلدات البناء.
  استخدمه أولاً دائماً؛ نتيجته أرضية الأرقام لكل ما بعدها.
- repo_tree: يُعيد الشجرة الهرمية حتى عمق محدد. استخدمه لتحديد حدود المشروع قبل أي ادعاء عن «البنية».
- repo_impact: يُعيد الملفات المتأثرة بتعديل هدف (imports/links) قبل التنفيذ.
  استخدمه قبل كل تعديل على ملف مشترك، واذكر الناتج كدليل في التقرير.

قاعدة: كل مخرج أداة يُنقل بأرقامه؛ لا نسب تقديرية.`,
    },
  },
  {
    name: 'run-tests',
    description: 'استخدم عند تشغيل الاختبارات والتحقق قبل التسليم. Use when: «شغّل الاختبارات»، «هل يمر كل شيء»، "run the tests", "verify". run_tests ثم read_test_result، ولا ادعاء نجاح بلا مخرجات فعلية، مع تفسير exitCode.',
    tags: ['tests', 'verification', 'evidence'],
    body: `# تشغيل الاختبارات والتحقق

English: run_tests → read_test_result; no success claim without output.

## متى تُستدعى
- قبل أي تسليم: «تم» و«يعمل» لا تُقبلان إلا بمخرج فعلي.
- بعد كل تعديل كود، وقبل أي التزام (commit) أو تقرير.

## التسلسل الإلزامي
1. run_tests بالأمر المحدد في المشروع (مثال: node --test).
2. read_test_result فوراً — اقرأ المخرجات كاملة: عدد الناجح، عدد الفاشل، آخر الأسطر.
3. لا تعديل جديد قبل قراءة النتيجة؛ ولا إعلان حالة قبلها.

## منع الادعاء
- «الاختبارات تمر» بلا مخرج فعلي = ادعاء مرفوض يُعاد به إلى القياس.
- عند الفشل: انقل أول سطر فشل حرفياً مع الملف ورقم السطر، ثم أصلح، ثم أعد التشغيل من أوله.

## قراءة exitCode
- 0 = نجاح — يُؤكَّد بمخرج يعرض عدد الاختبارات، لا بصمت.
- 1 = فشل اختبار — اقرأ سبباً واحداً على الأقل قبل أي إصلاح.
- أكبر من 1 أو قتل/مهلة = خطأ تشغيل (بيئة أو سقف زمن) وليس فشل منطق: عالج البيئة أولاً وصرّح بالفرق.
- مجهول = اكتب «exitCode غير معروف» ولا تخمّن.

## الحدود
- انتهاء المهلة الزمنية فشل قياس لا فشل كود — أعلن الفرق.
- اختبارات تحتاج شبكة أو بيئة خارجية تُذكر في «حدود» التقرير.`,
    references: {},
  },
  {
    name: 'write-report',
    description: 'استخدم عند كتابة تقرير أو ملخص نتائج. Use when: «اكتب تقريراً»، «لخّص ما فعلت»، "write a report". البنية: خلاصة/أدلة ملف:سطر/استثناءات/حدود، وممنوع ادعاء بلا مصدر.',
    tags: ['report', 'evidence'],
    body: `# كتابة تقرير بإثباتات

English: summary / evidence file:line / exceptions / limits — no claim without a source.

## البنية الإلزامية
1. خلاصة (3–5 أسطر): ماذا تم فعلاً، وهل النتيجة نهائية أم مشروطة.
2. أدلة: لكل بند دليل ملموس — ملف:سطر أو مخرج أمر. الدليل يُكتب أولاً والحكم يتبعه.
3. استثناءات: ما فشل، ما تأجل، ما لم يُختبر — بلا تجميل ولا حذف.
4. حدود: ما لم يُقس بعد، وما يعتمد على بيئة غير مثبتة.

## قواعد الكتابة
- كل جملة حكم تحمل مصدرها؛ الجملة بلا مصدر تُحذف أو تُوسم «غير موثّق».
- الأرقام من مخرجات حقيقية، لا تقديرات.
- الفشل يُكتب صريحاً مع سببه والخطوة التالية للإصلاح.

## فحص ما قبل التسليم
- [ ] كل ادعاء له دليل ملف:سطر أو مخرج
- [ ] الاستثناءات مذكورة صراحة
- [ ] الحدود مذكورة
- [ ] لا عبارة «تم بنجاح» بلا مخرج يسندها`,
    references: {},
  },
  {
    name: 'import-source',
    description: 'استخدم عند استيراد مصدر خارجي إلى الخزنة. Use when: «استورد هذا الملف»، «أضف هذا الرابط»، "import this source". احفظ الأصل أولاً، نوع المعرفة imported، بصمة المحتوى، واذكر المصدر في العلاقات.',
    tags: ['import', 'provenance'],
    body: `# قواعد استيراد مصدر

English: raw first, knowledge type imported, hash, and source named in relations.

## التسلسل الإلزامي
1. احفظ الأصل أولاً — انسخ المصدر كما ورد (نصه الكامل أو ملفه) قبل أي تلخيص أو معالجة. لا معالجة بلا أصل محفوظ.
2. نوع المعرفة: imported — لا note ولا doc، حتى لا يختلط المنقول بالمُنتَج محلياً.
3. البصمة: اكتب هاش المحتوى (sha256) + الطول بالبايت + وقت الاستيراد. تعذّر الحساب؟ صرّح ولا تخمّن.
4. العلاقات: كل علاقة تُنشأ تذكر المصدر الأصلي صراحة (الرابط أو المسار أو المرجع).

## قواعد السلامة
- الأصل لا يُعدّل بعد الحفظ؛ كل تصحيح يُكتب في الملاحظة المشتقة فقط.
- الاستيراد بلا مصدر قابل للتتبع مرفوض ويُعاد لصاحبه.
- عند تعارض المحتوى المستورد مع معرفة موجودة: أبقِ الاثنين مع علاقة تعارض، لا تحذف.

## فحص ما قبل التسليم
- [ ] الأصل محفوظ كما ورد
- [ ] النوع imported
- [ ] البصمة والطول والوقت مسجلة
- [ ] العلاقات تذكر المصدر`,
    references: {},
  },
]);

/**
 * مصنع وحدة المهارات — نمط cortex-core.js: دالة مصنع تُغلق على جذر واحد.
 * @param {{dir?: string}} config مجلد المهارات الجذري (<dir>/<name>/SKILL.md)
 */
function createSkills(config = {}) {
  const rawDir = typeof config === 'string' ? config : (config && config.dir);
  const dir = path.resolve(String(rawDir || path.join(process.cwd(), 'skills')));

  let index = new Map();

  /** يفحص القرص ويبني الفهرس من الصفر. لا يرمي أبداً: الفشل يصير issues. */
  function reload() {
    const next = new Map();
    const issues = [];
    let count = 0;
    try {
      if (fs.existsSync(dir)) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          const entryName = ent.name;
          try {
            const skillDir = path.join(dir, entryName);
            const skillFile = path.join(skillDir, 'SKILL.md');
            let st;
            try {
              st = fs.statSync(skillFile);
            } catch {
              issues.push({ name: entryName, reason: 'SKILL.md مفقود' });
              continue;
            }
            const parsed = parseSkillFile(fs.readFileSync(skillFile, 'utf8'));
            if (next.has(parsed.name)) {
              issues.push({ name: parsed.name, reason: 'اسم مكرر — أُبقيت النسخة الأولى' });
              continue;
            }
            next.set(parsed.name, {
              name: parsed.name,
              description: parsed.description,
              tags: parsed.tags,
              body: parsed.body,
              bodyChars: parsed.body.length,
              updatedAt: st.mtime.toISOString(),
              references: listReferences(skillDir),
              dir: skillDir,
            });
            count++;
          } catch (e) {
            issues.push({ name: entryName, reason: (e && e.message) ? e.message : String(e) });
          }
        }
      }
    } catch (e) {
      issues.push({ name: '(جذر المهارات)', reason: (e && e.message) ? e.message : String(e) });
    }
    index = next;
    return { count, issues };
  }

  /** يكتب المهارات البذرية الناقصة فقط (لا يمس موجوداً) ثم يفحص. */
  function ensureDefaults() {
    let created = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* جذر غير قابل للإنشاء — تُعالج الكتابات أدناه */ }
    for (const s of DEFAULT_SKILLS) {
      try {
        const skillDir = path.join(dir, s.name);
        const file = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(file)) {
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(file, buildSkillFile(s), 'utf8');
          created++;
        }
        for (const [refName, refBody] of Object.entries(s.references || {})) {
          const refFile = path.join(skillDir, 'references', refName);
          if (!fs.existsSync(refFile)) {
            fs.mkdirSync(path.dirname(refFile), { recursive: true });
            fs.writeFileSync(refFile, refBody, 'utf8');
          }
        }
      } catch { /* بذرة فاشلة لا تُسقط البقية */ }
    }
    reload();
    return { created };
  }

  /** الطبقة 1 فقط: [{name, description, tags, updatedAt, bodyChars, referenceCount}] — بلا أجسام. */
  function list() {
    return [...index.values()].sort(byName).map((s) => ({
      name: s.name,
      description: s.description,
      tags: s.tags.slice(),
      updatedAt: s.updatedAt,
      bodyChars: s.bodyChars,
      referenceCount: s.references.length,
    }));
  }

  /** المهارة كاملة (الطبقة 2 + أسماء الطبقة 3) أو null. نسخة جديدة كي لا تُعدَّل الداخليات. */
  function get(name) {
    const s = index.get(normName(name));
    if (!s) return null;
    return { name: s.name, description: s.description, body: s.body, references: s.references.slice(), dir: s.dir };
  }

  /**
   * الطبقة 3 عند الطلب فقط. يرمي بخطأ عربي واضح عند أي مخالفة.
   * الحماية: رفض .. و / و \ في الاسم، ثم فحص أن المسار المحلول داخل references/،
   * ورفض ما ليس ملفاً عادياً (روابط رمزية/مجلدات) — وحد 20000 حرف.
   */
  function readReference(name, refName) {
    const s = index.get(normName(name));
    if (!s) throw new Error(`مهارة غير موجودة: ${String(name)}`);
    const ref = String(refName == null ? '' : refName).trim();
    if (!ref) throw new Error('اسم المرجع مطلوب');
    if (ref.includes('..') || ref.includes('/') || ref.includes('\\') || ref.includes('\0')) {
      throw new Error(`اسم مرجع غير صالح: «${ref}» — ممنوع .. أو / أو \\`);
    }
    if (!/\.md$/i.test(ref)) throw new Error(`المراجع ملفات .md فقط: «${ref}»`);
    const refDir = path.resolve(path.join(s.dir, 'references'));
    const full = path.resolve(refDir, ref);
    const rel = path.relative(refDir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`مسار المرجع خارج مجلد المهارة: «${ref}»`);
    }
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      throw new Error(`المرجع غير موجود: «${ref}»`);
    }
    if (!st.isFile()) throw new Error(`المرجع ليس ملفاً عادياً (رابط رمزي أو مجلد): «${ref}»`);
    let text = fs.readFileSync(full, 'utf8');
    if (text.length > MAX_REF_CHARS) text = text.slice(0, MAX_REF_CHARS);
    return text;
  }

  /**
   * الطبقة 1 كنص أسطر «اسم — وصف» لسقف maxChars مع «… والمزيد» إن تجاوز.
   * ضمان: الناتج لا يتجاوز maxChars أبداً (وقد يعود '' إن كان السقف أصغر من المؤشر نفسه).
   */
  function renderIndex(lang = 'ar', opts = {}) {
    const en = normLang(lang) === 'en';
    const marker = en ? '… and more' : '… والمزيد';
    const requested = (opts && opts.maxChars != null) ? Number(opts.maxChars) : 900;
    const cap = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 900;
    const lines = [...index.values()].sort(byName).map((s) => `${s.name} — ${s.description}`);
    const full = lines.join('\n');
    if (full.length <= cap) return full;
    if (cap <= marker.length) return '';
    const budget = cap - marker.length - 1;
    let out = '';
    for (const line of lines) {
      const cand = out ? `${out}\n${line}` : line;
      if (cand.length > budget) break;
      out = cand;
    }
    if (!out) out = lines[0].slice(0, budget);
    return out ? `${out}\n${marker}` : marker;
  }

  /**
   * الطبقة 2 كنص جاهز للحقن: ترويسة + الوصف + الجسم (مقصوص عند maxBody مع إعلان
   * القصّ) + أسماء المراجع إن وُجدت. يعيد null لمهارة غير موجودة.
   */
  function renderSkill(name, lang = 'ar', opts = {}) {
    const s = index.get(normName(name));
    if (!s) return null;
    const en = normLang(lang) === 'en';
    const requested = (opts && opts.maxBody != null) ? Number(opts.maxBody) : 4000;
    const cap = (Number.isFinite(requested) && requested >= 0) ? Math.floor(requested) : 4000;
    const truncated = s.body.length > cap;
    const body = truncated ? s.body.slice(0, cap) : s.body;
    const parts = [
      en ? `# Skill: ${s.name}` : `# المهارة: ${s.name}`,
      s.description,
      en ? '## Instructions' : '## إرشادات التنفيذ',
      body,
    ];
    if (truncated) {
      parts.push(en
        ? `… [body truncated at ${cap} of ${s.body.length} chars — full SKILL.md: ${path.join(s.dir, 'SKILL.md')}]`
        : `… [قُصّ الجسم عند ${cap} حرفاً من أصل ${s.body.length} — للجسم الكامل: ${path.join(s.dir, 'SKILL.md')}]`);
    }
    if (s.references.length) {
      parts.push(en ? '## On-demand references' : '## مراجع تُقرأ عند الطلب');
      parts.push(s.references.map((r) => `- ${r}`).join('\n'));
    }
    return parts.join('\n\n');
  }

  reload(); // الفهرس جاهز عند الإنشاء؛ وإن غاب الجذر فعشرة صفرية بلا رمي.

  return { ensureDefaults, reload, list, get, readReference, renderIndex, renderSkill };
}

module.exports = { createSkills };
