# وصلة كورتكس لوكلاء البناء — OpenCode / Claude / Codex

> **الفكرة بجملة واحدة:** وكيل البناء (OpenCode أو غيره) لا يقرأ المشروع كله في كل مرة.
> يسأل كورتكس أولاً: «ماذا في هذا الملف وما يتصل به وما جرى عليه؟» — فيرد كورتكس
> بالجزء اللازم + المسار الكامل + تلخيص دقيق. وبعد كل خطوة يسجّل وكيل البناء ما فعله
> في مسير المشروع، فتتراكم ذاكرة تعيش خارج جلسة النموذج ولا تتلاشى مع السياق.

## ما الذي يعمل تحت الغطاء

| العملية | الأداة | ماذا تفعل فعلاً | متى |
|---|---|---|---|
| **الاحتضان** | `project_absorb` | مسح فعلي للمصدر → خريطة مرجعية (أهم الملفات بدرجة الاعتماد، نقاط الدخول) + خريطة اعتمادية (حواف الاستيراد محلولة) + سياق (manifest/README) → ملاحظة في قاعدة المعرفة | أول مرة تربط مشروعاً — أو عند تغيّر كبير |
| **قاطع السياق** | `memory_slice` | يختار الملف الهدف، يحل مساره الكامل، يجمع «يعتمد على» و«يعتمد عليه» والملفات المتأثرة والملاحظات ذات الصلة → يرد **مسارات + تلخيصاً دقيقاً، لا محتوى ملفات** | **قبل** أي إضافة/تصحيح/حذف — بدل قراءة المشروع كله |
| **المسير** | `memory_record` | يسجّل ما جرى فعلاً (خطوة/إصلاح/اختبار/قرار) مع الملفات المصابة — سجل دائم لكل مشروع | **بعد** كل خطوة ذات معنى |
| **قراءة المسير** | `project_trail` | «أين وصلنا؟» — خطوات الجلسات السابقة (منك ومن وكلاء آخرين)، الأحدث أولاً | **عند استئناف** العمل على مشروع قائم |

الذاكرة **خرائط لا ملفات**: لا يُنسخ مصدرك إلى كورتكس. الخريطة تُبنى من الاستيرادات الفعلية
(`repo_deps` تقرأ `import`/`require` حقيقية) — لا تخمين.

## الأسرع — اتصال عام بعنوان واحد

كورتكس يقدّم نفسه كخادم MCP على `http://127.0.0.1:3737/mcp` — أي نظام يدعم MCP عن بُعد
يتصل بهذا العنوان مباشرة، بلا مسارات ملفات ولا صيغ خاصة بكل عميل. والطرق التالية لِمَن
يدعم stdio فقط.

## التركيب — ثلاث نسخ

المبدأ واحد: عرّف خادم MCP باسم `cortex` يشغّل `mcp-memory-server.js`.
- `--root` = **مقر كورتكس** (حيث تقع ذاكرته `data/`) — ثابت في كل الأمثلة.
- `CORTEX_ALLOWED_ROOTS` = مجلدات **مشاريعك** التي يحق لكورتكس قراءتها (فاصلة منقوطة على ويندوز، `path.delimiter` عموماً). أي مشروع تحت `--root` مسموح تلقائياً.

### OpenCode — `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cortex": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\cortex\\mcp-memory-server.js", "--root", "C:\\path\\to\\cortex"],
      "environment": { "CORTEX_ALLOWED_ROOTS": "E:\\projects" },
      "enabled": true
    }
  }
}
```

### Claude Code — `claude mcp add`

```bash
claude mcp add cortex -- node "C:\path\to\cortex\mcp-memory-server.js" --root "C:\path\to\cortex"
```

أو في ملف الإعداد (`mcpServers`):

```json
{ "mcpServers": { "cortex": {
    "command": "node",
    "args": ["C:\\path\\to\\cortex\\mcp-memory-server.js", "--root", "C:\\path\\to\\cortex"],
    "env": { "CORTEX_ALLOWED_ROOTS": "E:\\projects" }
} } }
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.cortex]
command = "node"
args = ["C:\\path\\to\\cortex\\mcp-memory-server.js", "--root", "C:\\path\\to\\cortex"]
env = { CORTEX_ALLOWED_ROOTS = "E:\\projects" }
```

## البروتوكول — علّم وكيل البناء بهذه الأربع (قاعدة تشغيلية)

ضع النص التالي في تعليمات المشروع (`AGENTS.md` في جذر مشروعك أو rules الوكيل):

```markdown
## ذاكرة كورتكس (MCP: cortex)
- قبل أي تعديل على ملف: استدعِ `memory_slice` بـ {project, file, query} واقرأ الرد
  (الجزء اللازم + المسار + من يعتمد على من). لا تقرأ المشروع كله ولا تخمّن العلاقات.
- إن لم تكن للمشروع خريطة: مرّر `path` مرة واحدة في أول نداء — يحتضنه كورتكس تلقائياً.
- بعد كل خطوة ذات معنى (إصلاح/إضافة/حذف/نتيجة اختبار): `memory_record`
  بـ {project, source: "<اسمك>", entries:[{kind, text, files}]}.
- عند استئناف العمل على مشروع قديم: `project_trail` أولاً لتعرف أين توقّف العمل.
- عند تغيّر كبير في المشروع: `project_absorb` بـ {path, project, refresh:true}.
```

## مثال دورة كاملة (OpenCode على مشروع `rent-app`)

```
١) أول مرة:
   project_absorb { path: "E:/projects/rent-app", project: "rent-app" }
   → Absorbed: rent-app · Files: 214 · internal edges: 187
     Entry points: src/index.js · Top files: src/db.js (in:14 out:3) …

٢) المستخدم يطلب: "أضف حقل خصم في الفاتورة"
   memory_slice { project: "rent-app", file: "src/billing.js", query: "إضافة خصم على الفاتورة" }
   → المطلوب: إضافة خصم على الفاتورة
     الملف المستهدف: src/billing.js (module) — مسار كامل: E:/projects/rent-app/src/billing.js
     يعتمد على (3): ./db.js, ./money.js, ./invoice.js
     يعتمد عليه (5): src/routes/pay.js, src/routes/admin.js, test/billing.test.js …
     تحذيرات: تعديله ينتشر في 5 ملفات
   ← الآن افتح src/billing.js وsrc/invoice.js فقط — لا المشروع كله.

٣) بعد التعديل والاختبار:
   memory_record { project: "rent-app", source: "opencode",
     entries: [{ kind: "add", text: "أضفت حقل discount إلى الفاتورة وحدّثت الاختبارات",
                 files: ["src/billing.js", "test/billing.test.js"], status: "ok" }] }

٤) غداً — جلسة جديدة بلا سياق:
   project_trail { project: "rent-app" }
   → [2026-10-28T14:02] (opencode/add/ok) أضفت حقل discount … — files: src/billing.js …
   ← تعرف أين توقّف العمل في سطر واحد، دون إعادة قراءة أي شيء.
```

## الحدود — بصراحة

- **سقوف المسح**: حتى 4000 ملف لكل مسح، حتى 900 حافة في الخريطة (يُعلَن `truncated` إن بلغ السقف).
- **سقف المسير**: 800 مدخل لكل مشروع (الأقدم يُدوَّر)، وكل نص مدخل ≤ 800 حرف.
- **القراءة خارج الجذور**: ممنوعة — كورتكس لا يقرأ إلا ما أُذن له (`--root` + `CORTEX_ALLOWED_ROOTS`).
- **كورتكس لا يعدّل مشروعك أبداً** عبر هذه الأدوات — القراءة والخرائط والمسير فقط.
- **التقادم**: القاطع يعيد الاحتضان تلقائياً إذا مضى على الخريطة أكثر من 10 دقائق (المشروع يتغيّر أثناء البناء — الحالة «من الصفر»).
- **ليست بديلاً عن القراءة**: الرد يعطيك المسارات والعلاقات والتلخيص — الملف الذي ستعدّله اقرأه أنت.

## التحقق من الوصلة

```bash
# ابدأ خادم كورتكس (الذاكرة)
node server.js          # http://127.0.0.1:3737

# اختبر الأدوات الأربع من سطر الأوامر مباشرة عبر HTTP
curl -X POST http://127.0.0.1:3737/api/project/absorb -H "Content-Type: application/json" -d '{"path":"E:/projects/rent-app","project":"rent-app"}'
curl -X POST http://127.0.0.1:3737/api/memory/slice  -H "Content-Type: application/json" -d '{"project":"rent-app","file":"src/billing.js"}'
curl -X POST http://127.0.0.1:3737/api/memory/record -H "Content-Type: application/json" -d '{"project":"rent-app","entries":[{"text":"خطوة"}]}'
curl "http://127.0.0.1:3737/api/project/trail?project=rent-app"
```

خرائط المشاريع في `data/projects/<المشروع>.map.json`، والمسير في `data/projects/<المشروع>.trail.jsonl`،
والملخص البشري في قاعدة المعرفة كملاحظة «خريطة مشروع — …».
