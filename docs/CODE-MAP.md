# فهم Cortex من الكود — خريطة مؤكدة بالمراجع

> **قاعدة هذه الوثيقة**: كل سطر هنا مسنود إلى موقع في الكود أو قياس حيّ.
> الحكم يُفصل عن الادعاء: "مؤكد" = قِيس، "مقروء" = من الكود بلا تشغيل، "غير مُثبت" = لم يُفحص.

المصدر المقروء: 29 ملف JS · 21,688 سطر · الواجهة 371 KB
آخر تحديث: 2026-11-15

---

## 1. الأطلاق والنظام كله — قياس لا ادعاء

| الحقيقة | القيمة | المصدر |
|---|---|---|
| **الملف الأكبر** | `server.js` = 4,991 سطراً | `wc -l` |
| **النواة** | `cortex-core.js` = 2,643 سطراً | `wc -l` |
| **الوكيل** | `cortex-agent.js` = 1,352 سطراً | `wc -l` |
| **الطبقات** | 26 ملفاً `cortex-*.js` يتفرع من نواة | `deps-map.cjs` |
| **غلافتان** | `server.js` (HTTP كامل) · `mcp-memory-server.js` (stdio فقط) | 2,643 سطرين |
| **الاعتماديات** | **0** في الإنتاج (electron dev فقط) | `package.json` |

### الحد الأساسي المُحكم
- **`core` (2,643)**: يحمل `createCore()`، دفعة SQLite، البحث، التخزين، النسخ.
- **الاعتماد الدوري:** `i18n` ← 9 مرات · `schema` ← 5 · `policy` ← 4.
- **المُدخل المحظور:** `server.js:3806` يُنشئ `opt` لتستورد الطبقات كسولاً (`optMod`)، وتُحمَّل الطبقات الثقيلة فقط عند مسارها.

---

## 2. مسار PMT — الطلب من الخارج للداخل (∅ خريطة منظمة)

```
طلب HTTP
       ↓
  [1] applyCors + applySecurityHeaders          ← server.js:4798
       ↓
  [2] gzip + Host header check (منع DNS rebinding) ← :4804-4811
       ↓
  [3] isTrustedMutation(isTrustedMutation.isTrustedBlocked_origin) ← :4816
       ↓
  [4] requireSession (رمز الجلسة) أو /mcp رمز MCP ← :1220-1263
       ↓
  [5] body(req) بحد 2MB + JSON ← :1158-1181
       ↓
  [6] i18n.runWithLang (لغة كل الطلب) ← :4828
       ↓
  [7] handleApi(req,res,url) — 123 مساراً ← :1454
       ↓
  [8] fallback: 404 JSON ← :4833
```

**مُثبت بالقياس**: 15/15 مساراً حساساً يرفض المجهول بـ401/403 (`prove-session-gate.cjs`).

---

## 3. قلب الحكم: §33/§35/§38

### سلسلة القرار حين يطلب الوكيل أداة

```
execTool(name,args,ctx)                       ← cortex-agent.js:308
       ↓
execToolInner                                 ← :329
   ├─ idempotencyKey (§36) ← policy.idempotencyKey
   ├─ agentPaused()       ← existence check
   ├─ طابور link_note     ← alwaysDraft سريري :344
   ├─ supervised + write    ← :364 → draft
   ├─ DAILY_WRITE_CAP       ← :370 (25/day)
   ├─ policy.evaluate       ← :382 (الحكم)
   │     ├─ refuse  ⇒ { error } ← :395
   │     └─ draft   ⇒ queued     ← :400
   └─ تنفيذ + ctx.mutations + ctx.sources ← :415+
```

### الجدول الصارم
- **كل 48 أداة** مسجّلة في `TOOL_POLICY` (`cortex-policy.js:24-103`) — **مُثبت بالتقاطع** (0 ثغرة).
- **المستويات:** `read < propose < write < execute` (`:10`)
- **النطاقات:** `vault filesystem repo sandbox models mcp` (`:13`)
- **الأوضاع:** `supervised assisted autonomous` — **قائمة بيضاء صارمة**؛ أي قيمة أخرى ⇒ supervised (`:289-294`)
- `sandbox` لم تُعطَ ضمنياً في `execute` (`cortex-agent.js:1196`: `SAFE_SCOPES`)

### الإثباتات بإعادة التجربة
| الادعاء | النتيجة |
|---|---|
| كل أداة محكومة بسياسة | **48/48** — `0` بلا مواصفة |
| عدم تصعيد autonomy من الحمولة | ✔ (الاختبار C3) |
| حدود المسارات | ✔ 3/3 اختراقات مرفوضة |

**ملاحظة صادقة**: اختبار `agent.execute` مباشرةً بنطاقات مختلفة أظهر أن `fs_write` تُكتب فعلاً
حتى في `supervised` إذا تُرك نطاق `filesystem` ضمن النطاقات. **لكن `server.js:2480` يمرّر
القائمة كاملة دائماً** فيبقى القرار للسياسة وهو المحصّن. المظهر السببي في الاختبار المباشر
**لا يمثل المسار الحقيقي** — واعترف أن تسميته "عطلاً" كانت خطأً حتى تحققت.

---

## 4. التخزين × البحث × الجداول

### المصدر الواحد: Markdown
- المصدر الحقيقي: `vault/*.md` (369 ملاحظة اليوم)
- المرآة: `data/cortex.db` SQLite (28 جدولاً، WAL، busy_timeout=8000)
- الفهرس المتجهي: `data/vector-index.json` (30MB، 835 مقطعاً)

### الرفع: SearchWithEmbeddings (cortex-core:1806)
```
1. اقرأ الفهرس (cache مؤقت ببصمة mtime)
2. إذا غاب: اعد البناء متزامناً (نادر)
3. الإسقاط الحي: كل مقطع ←
     score = semantic*0.68 + min(lexical/20,0.38)
       + importance + links + recency + project + active + doc + entity
4. فلترة: lexical>0 OR semantic≥0.12
5. جمع حسب noteId
6. MMR (lambda=0.72)
7. دمج الحاقن (ملاحظات أحدث من الفهرس): مقاطع معكوسة ← 64 ملاحظة بسقف 4000 حرف
```

**نقطة عطل اليوم**: `if (!row.note) continue;` أُضيف `cortex-core.js:1930` — كشف 
 الثغرة التي كانت تنبت لكل استعلام يطابق مقطعاً يتيماً.

### المزامنة
`cortex-store.js:84-115` — تنفّذ `DELETE` ثم `INSERT` **لكل الجدول** في كل sync. 
المسألة: 369 ملاحظة + 1320 رابطاً تُحذف وتُعاد كل مرة. ليست بطيئة اليوم، لكنها تكبر مع الخزنة.

---

## 5. الطبقات — وظيفة كل ملف (مركزة)

| الملف | ما يفعله فعلاً |
|---|---|
| `cortex-agent` | حلقة ReAct (12 خطوة) + 48 أداة + draftSummary |
| `cortex-policy` | جدول الحكم + evaluate + rateLimit |
| `cortex-runs` | جدول agent_events (مصدر الحقيقة للتشغيلات) |
| `cortex-orchestrator` | تفحيط المهام عبر 8 أدوار |
| `cortex-tools-external` | 13 أداة outer (filesystem/repo/git/shell) |
| `cortex-mcp-core` | 28 أداة MCP — 20 قراءة + 8 كتابة |
| `cortex-model-gateway` | اكتشاف مزودات + فحص قدرات |
| `cortex-schema` | 8 مراحل + 9 بوابات إطلاق |
| `cortex-gates` | تقييم المراحل + البوابات |
| `cortex-relations` | استنتاج العلاقات (144+ علاقة) |
| `cortex-import` | استيراد 19 صيغة |
| `cortex-guard` | حجر الملفات المشبوهة |
| `cortex-privacy` | أصناف البيانات + منع التسريب |
| `cortex-readability` | تنقية HTML ← Markdown |
| `cortex-improve` | تجارب التحسين المقاس |
| `cortex-rollback` | لقطات + تراجع موثق |
| `cortex-monitor` | قياس الإنتاجية + التدقيق |
| `cortex-store` | SQLite mirror |
| `cortex-skills` | 4 مهارات مدمجة |
| `cortex-export` | ZIP مُخزّن (لا ضغط) |
| `cortex-i18n` | AsyncLocalStorage للغة الطلب |
| `cortex-mcp-client` | عميل MCP (stdio/HTTP) |

---

## 5.5 الطبقات الأمنية — كل ادعاء بالقياس

كل ما هنا **شُغِّل فعلياً** ونُقل مخرجه حرفياً.

### الاستيراد — `cortex-import.js` (1,592 سطراً)
| المحاولة | النتيجة |
|---|---|
| `C:/Windows/win.ini` | ✔ مرفوض: "خارج الجذور المسموحة" |
| `../../outside.md` | ✔ مرفوض |
| بايت صفري في المسار | ✔ مرفوض |
| `.env` (ملف حقيقي موجود) | ✔ مرفوض `secretRefused:true` |
| `server.key` (ملف حقيقي موجود) | ✔ مرفوض `secretRefused:true` |
| `evil.exe` | ✔ مرفوض "صيغة غير مدعومة" |
| `normal.md` | • مرّ — كما يجب |
| `https://127.0.0.1/admin` | ✔ مرفوض SSRF |
| `http://example.com` | ✔ مرفوض (https فقط) |
| `https://169.254.169.254/repo.git` | ✔ مرفوض (metadata endpoint) |

### تنقية HTML — `cortex-readability.js` (899 سطراً)
| الحالة | النتيجة |
|---|---|
| مقال غني بالهوامش | `extraction=main` · `ratio=0.58` · الأسطُر الجانبية أُسقطت · الجدول محفوظ · HTML خام = 0 |
| قالب بلا محتوى | `extraction=fallback` · `reasons=[no_content]` — لا ادعاء نجاح |
| صفحة قصيرة | `fallback` — صادق |

**البوابة** من 9 فحوص (`safetyGate` :746): طول · عناوين · فقرات · خلايا جدول · قوائم · صور · إشارات (كود/جداول/عناوين) · تغطية · خط أساس.

### الحجر — `cortex-guard.js` (570 سطراً)
| الاختبار | النتيجة |
|---|---|
| حقن إنجليزي/عربي | ✔ `instruction_injection:critical` |
| `<script>` / `eval(` | ✔ `script_payload:critical` |
| `../../etc/passwd` | ✔ `path_traversal:high` |
| `curl … \| sh` | ✔ `shell_danger:critical` |
| كتلة ثنائية 200 بايت | ✔ `binary_blob:high` |
| `C:\Windows\win.ini` (بلا محتوى) | ✔ `path_traversal` |
| `/etc/passwd` · `/usr/bin/node` | ✔ مرصود |
| `\Windows\win.ini` (بلا حرف قرص) | ✖ **لم يُرصد** — حالة حدّية |
| `<home>\proj\doc.md` | • نظيف (صحيح — لا حجر كاذب) |

### حارس الأوامر — `cortex-policy.js`
| الأمر | النتيجة |
|---|---|
| `node -e "…"` | ✖ مرفوض (محرف صدفة) |
| `node -p` / `node --eval` | ✖ مرفوض (فحص مشغّل) |
| `git init C:/Windows/Temp` | ✖ مرفوض (مسار خارج الجذور) |
| `rm -rf /` | ✖ مرفوض (خارج القائمة) |
| `curl … \| sh` · `… && del /f *` | ✖ مرفوض (محرف صدفة) |
| `node server.js` · `node tests/run-suite.cjs` | ✓ مسموح |
| `git status` · `ls -la` | ✓ مسموح |

**المحصلة: 9/12 مرفوضة، 3/3 من المسموح مشروعة.**

### كشف الأسرار — `cortex-privacy.js` (406 سطراً)
`sk-proj-…` · `ghp_…` · `Bearer …` ⇒ **3/3 مرصودة ومقنّعة** (القيمة الكاملة غير مكشوفة في التقرير).

### العلاقات المستنتجة — في القاعدة الحيّة
| الأصل | العدد |
|---|---|
| `title-mention` | **1,111** |
| `repo_deps` | **174** |
| `classification` | 21 |
| `wikilink:auto` | 14 |

### التحسين المقاس — `cortex-improve.js`
تجربتان مسجَّلتان في `improvement_trials` (`agent:attempt-budget` و`mcp:dry-run`) — أي أن الحلقة **تُنشئ تجارب فعلاً** لا تصفها.

---

## 6. العيوب المؤكدة اليوم (لا سابقاً)

| # | العطل | الدليل | الأثر |
|---|---|---|---|
| **1** | البحث 500 لـ8 استعلامات | **8/8 = 500 قبل، 8/8 = 200 بعد** | أُصلح ✅ |
| **2** | اعتماد مسودة يمحو كل المسودات | `prove-pending-wipe.cjs`: `2→0` | **مفتوح** |
| **3** | فشل listen يُبلغ نجاح `exit 0` | `prove-exit-code.cjs` | **مفتوح** |
| **4** | `syncStore` يمحو الجداول كلها | `cortex-store.js:84` | قيد المراقبة |
| **5** | البوابات لا تُقيَّم دورياً | 13 نوفمبر وليس اليوم | **مفتوح** |
| **6** | `assess` لا يرصد `\Windows\…` بلا حرف قرص | `prove-guard-paths.cjs` | حدّي |
| **7** | `syncStore` يمحو ملاحظات `notes` قبل إعادة الإدراج | `cortex-store.js:87-91` | قيد المراقبة |
| **8** | **XSS: محقون في `renderInline`** | `app.js:1195-1196` · `prove-xss2` 9/10 | **مفتوح** |

### تفصيل العطل 8 (الأهم أمنياً)
عند ادخال ويكي-لينك في نص ملاحظة ثم عرضها:

```js
// app.js:1195-1196 — التهريب يحدث قبل التوليد، لكن الناتج يعاد إدخاله في HTML
s = escapeHtml(text);                                   // سليم
s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
  (_, target, label) => `<span class="wikilink" data-wiki="${target}">${label || target}</span>`);
```

`${target}` مُهرَّب (آمن HTML) لكنه **يُحقن في سمة** بلا معرفة سياق:
`data-wiki="...."` — لذا مخرَج الاختبار:
`data-wiki="&quot;&gt;&lt;img ... onerror=alert(1)&gt;"`.

**الحكم بصدق**: الكيانات `&quot;` **لا تُغلِق** السمة في HTML5، و`<img>` مهرَّب، فالنتيجة الموثوقة هي **لكنة نصية لا تنفيذ**.
لكن الاختبار ثبّت سمة `onerror` قراءةً، و**لم أُثبت التنفيذ في متصفح**. لذلك يصنَّف: **حقن سمة مؤكد القابلية للتزييف، إثباته يحتاج متصفحاً**.
الإصلاح المقترح: بناء العنصر بـ`document.createElement` و`setAttribute('data-wiki', target)` — إدخال DOM لا سلسلة.

---

## 7. ما لا أقوله — حد الصدق

### ما قُرئ سطراً سطراً (كامل)
`cortex-core.js` (2,643) · `cortex-agent.js` (1,352) · `cortex-import.js` (1,592) ·
`cortex-guard.js` (570) · `cortex-policy.js` (382) · `cortex-store.js` (178) ·
`cortex-readability.js` (899 — كل الدوال الحاكمة + بوابة السلامة) ·
`server.js` (4,991 — كل الأنظمة الـ11 بنيوياً + المسارات الحساسة).

### ما قُرئ عقده لا جسمه كاملاً
`cortex-schema.js` · `cortex-relations.js` · `cortex-gates.js` · `cortex-improve.js` ·
`cortex-tools-external.js` · `cortex-model-gateway.js` · `cortex-mcp-client.js` ·
`cortex-connectors.js` · `cortex-monitor.js` · `cortex-rollback.js` · `cortex-skills.js` ·
`cortex-export.js` · `cortex-orchestrator.js` · `cortex-project-memory.js` · `cortex-privacy.js` ·
`cortex-mcp-core.js` · `cortex-runs.js` · `cortex-i18n.js`.

### ما لم يُقرأ بعد
- **`public/app.js`** (5,932 سطراً / 371 KB): قرأت الطبقة الحرجة فقط — `escapeHtml` · `renderInline` · `renderMd` · `API._req` · `getSessionToken` · الخريطة البنيوية (34 قسماً). لم أقرأ كل الأقسام.
   - **قياس بنيوي**: `innerHTML=116` مقابل `esc()=243` و`textContent=169` — استخدام نصي سليم في الأساس.
- `cortex-mcp-tools.js` (43) · `electron-main.js` (71) · `mcp-memory-server.js` (60) — صغيرة، قرأت جوهرها.

### ما لم يُقَس
- **جودة الاسترجاع على أسئلة حقيقية**: لم أجرِ تقييماً بمجموعة أسئلة معروفة.
- **الأداء تحت حمل** (500+ طلب متزامن).
- **الواجهة في متصفح حقيقي**: لم أشغّل `tests/browser/`. لذلك حقن السمة (عطل 8) **لم يُثبَت تنفيذاً**.

**القاعدة: ما قِيس مكتوب بقيمته. ما لم يُقَس لا أُسمّيه "مؤكد".**
