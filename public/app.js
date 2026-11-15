'use strict';

/* =====================================================================
   Cortex — Knowledge & Execution Agent (front-end)
   Single file, no modules, no dead code. Loaded via <script src="/app.js">.
   Contract: every $(id) below MUST exist in index.html, and every
   data-i18n key in index.html MUST exist in BOTH T.ar and T.en.
   ===================================================================== */

/* ───────────────────────────── helpers ───────────────────────────── */

function $(id) { return document.getElementById(id); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* تدقيق 2026-10-24: أدوات عرض صغيرة مشتركة —
   stripMd: رسائل الناقد تحمل **ماركداون** خاماً في الواجهة → تُنزع وتُنظّف.
   ltrIso: معرفات/أرقام+وحدات داخل RTL تُعزل LTR وإلا تنقلب (ث21.3).
   shortDate: تاريخ مختصر dd/mm لصفوف المكتبة (تمييز الصفوف المتشابهة). */
function stripMd(s) { return String(s == null ? '' : s).replace(/\*\*/g, '').replace(/^[\s"']+|[\s"']+$/g, ''); }
function ltrIso(s) { return '\u2066' + String(s == null ? '' : s) + '\u2067'; }
function shortDate(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0'); }
/* A1 (تدقيق 2026-10-24): أزرار الشريط الجانبي كانت بلا أي تسمية وصولية (aria=0
   في كامل الواجهة). التسمية تؤخذ من النص المرئي نفسه وتُحدَّث مع تبديل اللغة. */
function applyRailAria() {
  try {
    document.querySelectorAll('#rail .rail-btn').forEach((b) => {
      const lb = b.querySelector('.rail-lbl');
      const txt = lb && lb.textContent ? lb.textContent.trim() : '';
      if (txt) b.setAttribute('aria-label', txt);
    });
  } catch (e) { /* لا يكسر الإقلاع */ }
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

/* ───────────────── §60/§40: نوع العلاقة + المصدر + درجة الثقة ─────────────────
   قرار دستوري: درجة الثقة والمصدر يُعرضان مع العنصر — لا يُكتفى بحفظهما.
   التسمية عربية دائماً، والثقة تُعرض رقماً ونسبة، وغيابها يُعلَن صراحةً. */

const REL_KIND_AR = {
  /* الأنواع التسعة المعتمدة (م7) */
  depends_on: 'يعتمد على', derives_from: 'يستمد من', resulted_in: 'نتج عن',
  responsible_for: 'مسؤول عن', belongs_to: 'تابع لـ', contradicts: 'متعارض مع',
  risks: 'خطر على', tested_by: 'يُختبر بـ', affected_by: 'يتأثر بـ',
  /* الأنواع القديمة تبقى صالحة (توافق خلفي) */
  contains: 'يحتضن', references: 'يستشهد بـ', parent_project: 'مشروع أب', wikilink: 'رابط نصي',
  supports: 'يسند', sources: 'يُؤخذ منه', results_from: 'نتج عنه', owned_by: 'يملكه',
  threatened_by: 'مُهدَّد بـ', tests: 'يختبر', affects: 'يؤثر في'
};

const REL_ORIGIN_AR = {
  'repo_deps': 'تبعيات المستودع', 'title-mention': 'ذكر العنوان في المتن',
  classification: 'تصنيف تلقائي', manual: 'يدوي', user: 'المستخدم', import: 'استيراد',
  inferred: 'استنتاج حتمي', 'relation-infer': 'استنتاج العلاقات'
};

const LEGACY_REL_FALLBACK = { contains: 'يحتضن', references: 'يستشهد بـ', parent_project: 'مشروع أب', wikilink: 'رابط نصي' };

function relKindAr(kind) {
  const k = String(kind == null ? '' : kind);
  if (!k) return 'غير محدَّد';
  return REL_KIND_AR[k] || k;
}

function relOriginAr(origin) {
  if (origin === null || origin === undefined || String(origin).trim() === '') return 'غير محدَّد';
  const o = String(origin);
  return REL_ORIGIN_AR[o] || o;
}

let _REL_KIND_EN = null;
function relKindL(kind) {
  if (!_REL_KIND_EN) {
    _REL_KIND_EN = {
      depends_on: 'Depends on', derives_from: 'Derives from', resulted_in: 'Resulted in',
      responsible_for: 'Responsible for', belongs_to: 'Belongs to', contradicts: 'Contradicts',
      risks: 'Risk to', tested_by: 'Tested by', affected_by: 'Affected by',
      contains: 'Contains', references: 'References', parent_project: 'Parent project', wikilink: 'Text link',
      supports: 'Supports', sources: 'Sourced from', results_from: 'Resulted from', owned_by: 'Owned by',
      threatened_by: 'Threatened by', tests: 'Tests', affects: 'Affects'
    };
  }
  const k = String(kind == null ? '' : kind);
  if (!k) return t('unset');
  return (LANG === 'en' ? (_REL_KIND_EN[k] || k) : relKindAr(k));
}
function relOriginL(origin) {
  if (origin === null || origin === undefined || String(origin).trim() === '') return t('unset');
  const o = String(origin);
  if (LANG === 'en') {
    const EN = {
      'repo_deps': 'Repository dependencies', 'title-mention': 'Title mention in body',
      classification: 'Auto classification', manual: 'Manual', user: 'User', import: 'Import',
      inferred: 'Deterministic inference', 'relation-infer': 'Relation inference'
    };
    return EN[o] || o;
  }
  return relOriginAr(origin);
}

/* الثقة: رقم + نسبة مئوية. لا تُخمَّن قيمة غائبة — تُعلَن غائبة. */
function confText(confidence) {
  if (confidence === null || confidence === undefined || confidence === '') {
    return { num: '—', pct: '—%', low: true, unknown: true };
  }
  const n = Number(confidence);
  if (!Number.isFinite(n)) return { num: '—', pct: '—%', low: true, unknown: true };
  return { num: n.toFixed(2), pct: Math.round(n * 100) + '%', low: n < 0.6, unknown: false };
}

/* صفّ علاقة واحد: العنوان + النوع بالعربي + المصدر + الثقة + وقت الاستخراج.
   العنوان يحمل شارة نصية عند ضعف الثقة.
   ملاحظة تنفيذية: أسماء الوسوم في HTML يجب أن تبدأ بحرف ASCII، لذا `<بيانات نوع="…">`
   لا يُحلّله المتصفح وسمًا بل يعرضه نصًا خامًا. يُحفظ اتّفاق المشروع نفسه في وسم صالح
   يحمل `data-bayn`/`data-bayn-naw3` فلا يظهر أي ترميز خام للمستخدم. */
function renderConfRow(r, dirAr) {
  const rel = r && typeof r === 'object' ? r : {};
  const c = confText(rel.confidence);
  const other = rel.dir === 'in' ? rel.source : rel.target;
  const title = String(other == null ? '' : other);
  const dirL = dirAr === 'out' ? t('rel_out') : (dirAr === 'in' ? t('rel_in') : dirAr);
  const naw3 = c.unknown ? t('conf_unknown_tag') : t('conf_low_tag');
  const titleHtml = c.low
    ? `<span class="bayn-wrap" data-bayn="${t('bayn_data')}" data-bayn-naw3="${escapeHtml(naw3)}" title="${t('bayn_tag')}=&quot;${escapeHtml(naw3)}&quot;">${escapeHtml(title)}</span>`
    : escapeHtml(title);
  return `<div class="ref cfr" data-id="${escapeHtml(title)}" title="${escapeHtml(dirL + ' • ' + relKindL(rel.kind))}">` +
    `<div class="cfr-top"><span class="t">${titleHtml}</span>` +
    `<span class="chip kind">${escapeHtml(relKindL(rel.kind))}</span>` +
    `<span class="chip dir">${escapeHtml(dirL)}</span></div>` +
    `<div class="cfr-meta">` +
    `<span class="chip origin">${t('conf_origin')}: ${escapeHtml(relOriginL(rel.origin))}</span>` +
    `<span class="chip conf ${c.low ? 'low' : 'high'}">${t('conf_label')}: ${c.num} (${c.pct})</span>` +
    `<span class="chip when">${t('conf_extracted')}: ${escapeHtml(rel.extractedAt == null || rel.extractedAt === '' ? t('conf_not_recorded') : String(rel.extractedAt))}</span>` +
    (c.low ? `<span class="conf-warn">${c.unknown ? t('conf_unknown') : t('conf_unconfirmed')}</span>` : '') +
    `</div></div>`;
}

async function loadConfidenceInto(elId, countId, noteId) {
  ctxMsg(elId, '…');
  const data = await API.confidence(noteId);
  if (data && data.error) return ctxMsg(elId, data.error, true);
  const out = (data && Array.isArray(data.outgoing)) ? data.outgoing.map(r => Object.assign({}, r, { dir: 'out' })) : [];
  const inc = (data && Array.isArray(data.incoming)) ? data.incoming.map(r => Object.assign({}, r, { dir: 'in' })) : [];
  const rows = out.concat(inc);
  setCount(countId, rows.length);
  const el = $(elId);
  if (!el) return;
  if (!rows.length) { el.innerHTML = `<div class="hint">${escapeHtml(t('no_relations'))}</div>`; return; }
  const avg = rows.reduce((s, r) => s + (Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0), 0) / rows.length;
  el.innerHTML = `<div class="cfr-sum mono">${rows.length} ${t('rel_units')} • ${t('conf_avg')} ${avg.toFixed(2)} (${Math.round(avg * 100)}%)</div>` +
    rows.map(r => renderConfRow(r, r.dir === 'in' ? 'in' : 'out')).join('');
}

/* ─────────────────────────── app state S ─────────────────────────── */

const S = {
  notes: [],
  dashboard: null,
  activeNote: null,
  settings: null,
  sessionId: null,
  projectFilter: '',
  libSearch: '',
  libType: '',
  findings: [],
  agentBusy: false,
  paletteSemantic: [],
  libRank: [],            // ترتيب نتائج البحث الهجين لقائمة المعرفة (2026-11-14)
  importance: 1
};

const LS_UI = 'cortex.ui';

/* ─────────────────────────── i18n dictionary ─────────────────────── */
/* Every key exists in BOTH dictionaries — never declare one alone. */

const T = {
  ar: {
  'ph_filter_title': 'ابحث في العنوان…',
  'ph_search_all': 'ابحث في كل شيء…',
  'v_knowledge': 'المعرفة',
  'agent_need_goal': '➡️ اكتب هدفاً للوكيل أولاً — أو اختر قالباً جاهزاً بالأزرار.',
  'agent_templates': 'قوالب جاهزة:',
  'tpl_analyze': 'حلّل مشروعي',
  'tpl_gaps': 'اعثر على الفجوات',
  'tpl_status': 'تقرير حالة',
  'v_agents': 'الوكلاء',
  'v_monitor': 'المراقبة',
  'v_repos': 'المستودعات',
  'v_providers': 'المزودون',
  'v_import': 'الاستيراد',
  'v_tools': 'الأدوات',
  'v_governance': 'الحُكم',
    all_projects: 'كل المشاريع', g_docs: 'المستندات', g_decisions: 'القرارات', g_tasks: 'المهام',
    g_meetings: 'الاجتماعات', g_notes: 'الملاحظات', st_items: 'عنصر', none: '—',
    idx_ok: 'الفهرس جاهز ✓', idx_dirty: 'الفهرس يحتاج إعادة بناء ⟳',
    v_edit: 'تحرير', v_split: 'مزدوج', v_graph: 'الخارطة', v_state: 'لوحة المشروع', v_preview: 'معاينة', ph_search_library: 'ابحث في المكتبة...', kk_imported: 'مستورد', kk_decided: 'معتمد', kk_inferred: 'استنتاج', kk_hypothesis: 'فرضية', kk_hint: 'نوع المعرفة: كيف وصل هذا العنصر ولمن يُنسب — والمستنتج والفرضية غير مؤكدين.', ctx_tasks_all: 'مهام مساحة العمل', src_word: 'المصدر', ctx_state: 'الحالة',
    ctx_tasks: 'المهام', ctx_related: 'مرتبطات', ctx_backlinks: 'روابط عكسية', ctx_history: 'السجل',
    c_confidence: 'ثقة العلاقات',
    s_steps: 'الخطوات', s_gaps: 'الفجوات', s_tasks_c: 'المهام', s_timeline: 'خط الصحة عبر الزمن (SQLite)',
    l_health: 'صحة المشروع',
    g_tasksb: 'عناصر الاجتماع', g_contr: 'تناقضات', findings_title: 'مستجدات الذاكرة',
    goal_gaps: 'ما الناقص في هذا المشروع؟ اكتشف الفجوات فقط', goal_tasks: 'استخرج العناصر التنفيذية من هذا المستند وسجّلها كمهام فورًا',
    goal_next: 'ما الخطوة التالية للمشروع؟', goal_contra: 'افحص التعارضات مع المستندات المرتبطة وأخبرني فقط دون تعديل',
    b_living: '🧾 ملاحظة الحالة الحية', b_backup: '🗜 نسخة احتياطية الآن', b_agent: 'وكيل',
    draft_unit: 'مسودة', drafts_unit: 'مسودات', drafts_title: 'مسودات تنتظر اعتمادك — انقر لفتح لوحة الوكيل',
    create_hint_title: 'العنوان هو اسم العنصر الذي ستجده وتُربطه وتبحث به في المكتبة و⌘K — اكتبه واضحاً.',
    create_hint_type_project: 'النوع = تصنيفه الدلالي · المشروع = المجموعة التي يظهر تحتها في القائمة (مثل مجلد) — اكتب اسماً جديداً لإنشاء مجموعة، أو اسماً موجوداً للانضمام إليها.',
    mcp_intro: 'Cortex خادم MCP: ذاكرتك (28 أداة) لأي وكيل خارجي — Claude Code / Codex / OpenCode / هيرمز. والعكس: Cortex يستدعي أدوات خوادم MCP خارجية (كل استدعاء مسودة تحتاج اعتمادك).',
    mcp_test_live: 'اختبر الاتصال الآن',
    mcp_testing: '… يجرّب نداءً حقيقياً (memory_stats)',
    mcp_reached: 'وصل ✓',
    mcp_general: 'الاتصال العام — عنوان واحد لأي نظام',
    b_copy_url: 'نسخ العنوان',
    mcp_general_note: 'أي نظام يدعم MCP عن بُعد يتصل بهذا العنوان مباشرة (بلا مسارات ولا ملفات إعداد). ولمن يدعم stdio فقط: «الكتلة القياسية» أعلاه — نسخ الإعداد.',
    mcp_incoming: 'آخر اتصال وارد',
    mcp_incoming_never: 'لم يتصل أي نظام بعد (اتصالات stdio لا تُرى هنا — كل نداء جلسة خاصة)',
    mcp_check: 'فحص', mcp_unlink: 'إلغاء الربط', mcp_unlinked: 'أُلغي الربط',
    mcp_last_ok: 'آخر فحص: وصل', mcp_last_fail: 'آخر فحص: تعذّر', mcp_last_none: 'لم يُفحص بعد',
    mcp_loading: '… يجلب قائمة الخوادم',
    mcp_general_test: 'فحص الاتصال العام',
    mcp_general_testing: '… يجرّب نداء /mcp',
    mcp_incoming_stop: 'إيقاف استقبال الاتصالات',
    mcp_incoming_start: 'تشغيل استقبال الاتصالات',
    mcp_incoming_on: 'الاستقبال: مفعّل',
    mcp_incoming_off: 'الاستقبال: متوقف',
    mcp_incoming_disabled_note: 'الاستقبال متوقف — الوافدون يُرفضون الآن',
    mcp_external: 'الاتجاه العكسي — خادم MCP خارجي يستدعيه Cortex (مسودات دائماً)',
    mcp_ext_name: 'الاسم', mcp_ext_add: 'أضف واختبر', mcp_ext_need: 'الاسم والأمر مطلوبان',
    mcp_no_external: 'لا خوادم خارجية مربوطة بعد — أضف خادماً من الحقول أدناه، وستظهر له هنا بطاقة بزرّي «فحص» و«إلغاء الربط».',
    mcp_caps_unit: 'قدرة مصنّفة',
    toast_copied: 'نُسخ ✓',
    sess_continue: 'متابعة هذه الجلسة', sess_active: 'نشطة', sess_show: 'عرض الرسائل', sess_hide: 'إخفاء الرسائل',
    c_details: 'تفاصيل العنصر',
    b_meta: 'تصنيف',
    meta_edit_hint: 'تعديل النوع/المشروع/الأهمية — الوكيل يستنتجها تلقائياً',
    saving_word: '… يُحفظ',
    saved_word: 'محفوظ ✓',
    agent_busy_wait: 'الوكيل يعمل الآن — للإيقاف اضغط ⏹ في الشريط أعلى الشات',
    s_maintenance: 'صيانة سريعة',
    maintenance_note: 'الزرّان متاحان أيضاً من ⌘K. الحالة الحية تُلتقط تلقائياً في تشغيلات الوكيل — وهذا للتشغيل اليدوي عند الحاجة.',
    adv_manual: 'تصنيف يدوي (اختياري — الوكيل يستنتجه عادة)',
    sess_no_msgs: 'لا رسائل بعد في هذه الجلسة', sess_resumed: 'سيتابع الوكيل هذه الجلسة ✓',
    sess_role_user: 'أنت', sess_role_assistant: 'الوكيل',
    agent_planning: '🧠 الوكيل يخطط…', agent_done_mut: 'إجراءات فعلية على معرفتك', agent_sources: 'المصادر',
    agent_welcome_sub: 'الوكيل ينفّذ مهاماً على معرفتك بالأدلة: يحلّل، يبحث، يكتشف الفجوات والتناقضات، وينفّذ كتابات معتمدة فقط.',
    agent_welcome_hint: 'اكتب هدفاً بالأسفل أو اختر قالباً — كل إجابة تُسنَد بمصادرها',
    toast_backup: 'تم إنشاء النسخة الاحتياطية', b_export_project: 'تصدير', export_hint: 'حزمة مشروع قابلة للتسليم', export_title: 'تصدير المشروع الحالي كملف ماركداون', export_done: 'صُدّر المشروع', export_need_project: 'اختر مشروعاً أولاً — التصدير يعمل على مشروع واحد', toast_rebuilt: 'أُعيد بناء الفهرس', toast_living: 'حُدّثت ملاحظة الحالة الحية',
    toast_copied: 'نُسخ الإعداد ✓', toast_saved: 'حُفظ ✓', toast_deleted: 'حُذف ✓',
    ask_delete: 'حذف هذا العنصر نهائيًا؟', ask_replace: 'هناك تعديلات غير محفوظة وسيتم استبدالها. متابعة؟',
    snap_loaded: 'تم تحميل اللقطة — راجعها ثم احفظ للاسترجاع', ready: 'Cortex جاهز',
    agent_intro: 'أنا وكيلك المحلي — اكتب ما تريده بجملتك العادية: أقرأ معرفتك ومشاريعك وأنفّذ الخطوات فعلاً، وأي خطوة حساسة أقف عندها كمسودة تنتظر موافقتك. جرّب مثلاً: «كم ملاحظة عندي؟»',
    disc_updated: 'تحديث من القرص', understood: 'فهمت المقصود', best_next: 'أفضل خطوة', no_tasks: 'لا مهام في هذا المشروع بعد',
    extract_btn: 'استخراج مهام تلقائيًا من هذا المستند', extract_btn_mtg: 'استخراج عناصر تنفيذية من هذا الاجتماع',
    no_related: 'لا عناصر مرتبطة — أضف [[روابط]]', no_backlinks: 'لا روابط عكسية', no_history: 'لا لقطات بعد',
    no_entities: 'لا كيانات بعد', no_sessions: 'لا جلسات بعد — كل هدف تعطيه للوكيل يسجّل جلسة هنا',
    mcp_count: 'أداة MCP', no_findings: 'لا تناقضات مرئية ✓',
    state_open: 'مهام مفتوحة', state_steps: 'الخطوات', state_gaps: 'الفجوات', state_tl: 'خط الصحة عبر الزمن',
    living_inline: 'جدد ملاحظة الحالة الحية', open_note_hint: 'افتح ملاحظة المصدر',
    b_new_s: '＋ جديدة', policy: 'إضافات فقط · لا حذف · مدقَّق',
    mcp_title: 'MCP — ذاكرة Cortex لأي نموذج', sessions_title: 'جلسات الوكيل', settings_title: 'الإعدادات', new_title: 'عنصر جديد',
  /* نصوص الوصولية والـplaceholder (2026-11-06): كانت عربية دائماً في الوضع الإنجليزي */
  a11y_skip: 'تخطَّ إلى المحتوى الرئيسي', aria_palette: 'لوحة الأوامر', aria_palette_results: 'نتائج لوحة الأوامر', aria_rail: 'التنقل الرئيسي', aria_goal: 'هدف الوكيل', aria_agent_log: 'سجل الوكيل', aria_gov_tabs: 'أقسام الحُكم', gov_tab_stages: 'المراحل والبوابات', gov_tab_quality: 'الجودة والتقييم', gov_tab_safety: 'الحجر والأثر', gov_tab_rel: 'العلاقات', gov_tab_privacy: 'الخصوصية والاتصالات',
  ph_import_path: 'docs/notes.md — أو مجلد — أو https://...', ph_mcp_cmd: 'command مثل: node / npx', ph_mcp_args: 'args بمسافات: server.js --flag',
    b_save: 'حفظ', b_delete: 'حذف', b_close: 'إغلاق', b_copy: 'نسخ الإعداد',
    b_rebuild: 'إعادة بناء الفهرس', b_create: 'إنشاء', b_cancel: 'إلغاء',
    l_importance: 'الأهمية',
    t_note: 'ملاحظة', t_doc: 'مستند', t_project: 'مشروع', t_decision: 'قرار', t_task: 'مهمة',
    t_meeting: 'اجتماع', t_procedure: 'إجراء', t_state: 'حالة', t_living: 'حالة حية',
    s_chat_model: 'نموذج الدردشة', l_provider: 'المزود',
    s_generation: 'التوليد', b_manage_providers: 'إدارة المزوّدين',
    no_active_model: 'لا مزود نشط — أضف مزوداً من قسم «المزوّدون»',
    providers_single_home: 'المكان الوحيد لإدارة المزوّدين: الإضافة، الفحص، اختيار النموذج، التفعيل، الحذف.',
    b_use_model: 'استخدم هذا النموذج', model_active: 'النموذج النشط', activating: 'جارٍ التفعيل',
    emb_local: 'محلي بلا شبكة (n-gram)',
    acc_amber: 'لون التمييز: كهرماني', acc_teal: 'لون التمييز: تركوازي', acc_violet: 'لون التمييز: بنفسجي',
    l_temp: 'الحرارة',
    l_price_in: 'سعر الإدخال/1k$ (اختياري)', l_price_out: 'سعر الإخراج/1k$ (اختياري)',
    view_file: 'عرض الملف', file_truncated: 'مقصوص عند سقف العرض',
    s_retrieval: 'الاسترجاع', s_appearance: 'المظهر',
    l_ui_lang: 'لغة الواجهة', l_fontsize: 'حجم الخط', l_accent: 'لون التمييز', l_project: 'المشروع', b_open_import: 'استيراد ملف أو مجلد أو رابط ↗', quick_modal_sub: 'اكتب ما تريده الآن — للاستيراد من ملف أو مجلد أو رابط افتح قسم الاستيراد.', b_add_item: 'إضافة عنصر', b_open_tools: 'اعرض الأدوات', deps_code_only: 'ملفات الكود فقط', active_word: 'نشط', b_delete: 'حذف', deleted_word: 'حُذف', confirm_delete_provider: 'حذف المزود',
    appearance_note: 'تُحفظ تلقائيًا في هذا الجهاز، وتُطبق فورًا.',
    s_resolve: 'حلّ المقصود', b_understand: 'افهم', ph_resolve: 'مثال: افتح المستند',
    s_projects: 'المشاريع', s_library: 'المكتبة', s_entities: 'أقوى الكيانات',
    empty_h: 'عقلك المعرفي فارغ الآن',
    empty_p: 'أنشئ أول عنصر، أو اضغط ⌘K وابدأ الكتابة. كل ما تكتبه يصبح ذاكرة.',
    b_first: 'ابدأ بعنصر جديد', ph_palette: 'ابحث عن عنصر أو نفّذ أمرًا…',
    ph_graph: 'فلتر الخارطة…', ph_goal: 'اكتب للوكيل ما تريده… مثال: راجع هذا المستند وسجّل النواقص كمهام',
    b_send: 'أرسل', autosave: 'حفظ تلقائي كل 1.6 ثانية', kb_hint: '⌘K للأوامر',
    no_results: 'لا نتائج',
    f_gap: 'فجوة', f_contra: 'تعارض', f_isolated: 'عنصر معزول', f_stale: 'قديم',
    c_tasks: 'المهام', c_related: 'مرتبطات', c_backlinks: 'روابط عكسية', c_history: 'السجل',
    hb: 'خط الصحة عبر الزمن',
    agent_sub: 'اكتب جملتك — يفهم ويعمل من نصّها',
    l_autonomy: 'وضع الوكيل', l_emb_provider: 'مزود embeddings', l_schedule: 'فحص دوري للوكيل — كل (ساعات)',
    p_autonomous: 'مستقل (تنفيذ فوري)', p_supervised: 'خاضع للإشراف (مسودات)',
    palette_hint: '↑↓ للتنقل • Enter للتنفيذ • Esc للإغلاق',
    policy_note: 'في الوضع الخاضع: تصبح كتابات الوكيل مسودات تعتمدها بنفسك من لوحة الوكيل قبل دمجها.',
    s_policy: 'الوكيل والسياسة', s_tasks: 'المهام المفتوحة',
    l_language: 'لغة الوكيل', lang_auto: 'تلقائي (هدفك يحدد)', lang_ar: 'عربي دائمًا', lang_en: 'English always',
    link_title: 'ربط ذكي', link_from: 'العنصر المختار',
    b_link: '＋ ربط',
    imp_normal: 'عادي', imp_important: 'مهم', imp_critical: 'حرِج',
    conf_word: 'ثقة', source_word: 'مصدر', loading_word: 'جارٍ التحميل', not_found_word: 'العنصر غير موجود',
    no_relations_word: 'لا علاقات مسجّلة بعد', open_in_knowledge: 'افتح في المعرفة', ask_agent: 'اسأل الوكيل',
    goal_about_word: 'اشرح لي', goal_about_body: 'ما هو، وما علاقته بباقي العناصر، وما الخطوة التالية',
    kind_note: 'ملاحظة', kind_project: 'مشروع', kind_document: 'مستند', kind_file: 'ملف',
    kind_repo: 'مستودع', kind_task: 'مهمة', kind_decision: 'قرار', kind_knowledge: 'معرفة',
    d_click_hint: 'انقر عقدة لعرض تعريفها الكامل',
    next_action_word: 'الخطوة التالية المقترحة',
    /* ═══ دفعة i18n الشاملة: كل نصوص الأقسام ═══ */
    title_app: 'Cortex — الذاكرة الحيّة',
    v_graph_h: 'خريطة الترابط', v_monitor_h: 'مراقبة الإنتاجية', v_providers_h: 'مزودو الذكاء', v_tools_h: 'الأدوات الخارجية',
    tools_note: 'هذه أدوات خادم الذاكرة (MCP) المتاحة للوكلاء الخارجيين — كل استدعاء يمرّ ببوابة الصلاحيات ويُسجَّل في التدقيق، والكتابة تبقى مسودات معتمدة.',
    b_refresh: 'تحديث', b_refit: 'إعادة ترتيب', l_labels: 'الأسماء', b_clear_filter: 'مسح الفلتر',
    opt_all_types: 'كل الأنواع', tp_projects: 'مشاريع', tp_docs: 'مستندات', tp_decisions: 'قرارات', tp_tasks: 'مهام', tp_meetings: 'اجتماعات',
    ph_title: 'العنوان', ph_title_ellipsis: 'العنوان…', ph_project: 'المشروع', ph_chat2: 'اطلب شيئاً…', b_send: 'أرسل',
    ph_team_goal: 'هدف للفريق… مثال: راجع مشروع Atlas وأنشئ ملخصاً ثم اختبره',
    team_title: 'الفريق المتوازي', team_pipe: 'محلّل ← منفّذ ← (مختبِر ∥ ناقد) ← (محقّق ∥ مراقب)',
    l_parallelism: 'التوازي', b_team_stop: 'إيقاف العرض', l_parallel: 'متوازٍ',
    role_executor: 'منفّذ', role_critic: 'ناقد', role_monitor: 'مراقب إنتاجية',
    a_steps: 'الخطوات', a_sources: 'المصادر',
    live_working: 'يعمل الآن', live_idle: 'خامل', live_last: 'آخر تشغيل', live_step: 'خطوة', live_stop: 'إيقاف',
    live_stopped: 'طُلب الإيقاف — سيتوقف قبل الخطوة التالية',
    tl_think: 'فكر', tl_args: 'الوسائط', tl_drafts_notice: 'مسودات بانتظار اعتمادك', tl_show_drafts: 'اعرض المسودات',
    tl_verify_req: 'يلزم دليل تحقق قبل الإنهاء', tl_verified_ok: 'تحقق موثّق', tl_verified_bad: 'أنهى بلا دليل تحقق',
    tl_cancelled: 'أُلغي التشغيل بطلبك', tl_failed: 'فشل التشغيل',
    artifact_title: 'تقرير محفوظ في المعرفة', artifact_open: 'افتح التقرير', chars_unit: 'حرف',
    contract_title: 'الصلاحيات والأدوار', contract_autonomy: 'مستوى الاستقلالية', contract_limits: 'سقوف اليوم',
    contract_roles: 'الأدوار ونطاقاتها', contract_tools: 'الأدوات', contract_tools_count: 'أدوات مسجلة',
    contract_save: 'احفظ بتأكيد', contract_confirm_autonomy: 'تغيير مستوى استقلالية الوكيل قرار حوكمة يُدوَّن — هل أنت متأكد؟',
    contract_confirm_limits: 'تغيير السقوف يسري فوراً ويُدوَّن في التدقيق — تأكيد؟',
    contract_saved: 'حُفظ العقد ودُوّن', contract_scope: 'النطاقات', contract_write: 'كتابة', contract_yes: 'نعم', contract_no: 'لا',
    contract_nodraft_tools: 'أدوات لا تُنفَّذ إلا باعتمادك', contract_base: '(الأساسي)', contract_close: 'إغلاق',
    contract_note: 'كل تعديل في هذا العقد يتطلب تأكيداً صريحاً ويُسجَّل في التدقيق — والوكيل لا يمنح نفسه صلاحية أبداً.',
    mode_supervised: 'خاضع للإشراف', mode_assisted: 'مساعد', mode_autonomous: 'مستقل',
    k_verdict: 'حكم المراقب', k_tasks: 'المهام', k_done: 'نُفّذت', k_failed: 'فشلت', k_success: 'نجاح',
    k_parallel: 'توازٍ مُنجَز', k_duration: 'متوسط الزمن',
    opt_last_run: 'آخر تشغيل', s_objections: 'اعتراضات المراقب الصارم', s_recent_tasks: 'آخر المهام',
    th_task: 'المهمة', th_owner: 'الصاحب', th_status: 'الحالة', th_project: 'المشروع', th_due: 'الموعد',
    s_suggested: 'الخطوات المقترحة', s_open_tasks2: 'مهام مفتوحة', s_kgaps: 'فجوات المعرفة',
    ph_repo_path: 'مسار داخل مساحة العمل…', b_index: 'فهرسة', s_files: 'محتوى المستودع', s_deps: 'الترابط', s_impact: 'أثر التغيير',
    repo_empty_hint: 'لا مستودع مفهرس بعد — أدخل مساراً داخل مساحة العمل واضغط «فهرسة».',
    b_sev_derive: 'اشتق الخطورة', sev_rows: 'تقديرات الخطورة', rel_typed: 'علاقات مُصنَّفة', rel_last: 'آخر استنتاج', rel_never: 'لم يُشغَّل قط',
    sev_done: 'كُتب {n} تقديراً · {s} بلا دليل لم تُقدَّر', sev_invalid: 'قيمة غير معروفة: {f}={v} — المسموح: {a}', sev_none: 'لا دليل: أعلن في رأس الملاحظة sensitivity: public|internal|confidential|restricted أو criticality: 1-100',
    ask_title: 'اسأل مكتبتك', ask_chip: 'بمصادر · أو «لا أعرف»', ask_ph: 'ماذا قررت في مشروع…؟', ask_btn: 'اسأل', ask_thinking: 'أبحث وأقرأ…', ask_none: 'لا دليل كافٍ في خزنتك',
        vault_title: 'الخزنة', vault_folders: 'مجلد', vault_nested: 'داخل مجلدات', vault_attach: 'مرفق', vault_src_env: 'من متغير البيئة', vault_src_config: 'من الإعدادات', vault_src_default: 'الافتراضية', vault_need: 'اكتب مسار مجلد', vault_saved: 'حُفظ — أعد التشغيل ليُطبَّق', vault_reset_done: 'أُعيد الافتراضي — أعد التشغيل', vault_set: 'افتح هذا المجلد', vault_reset: 'الافتراضي', vault_note: 'يُطبَّق بعد إعادة التشغيل. المجلدات الفرعية تُقرأ، ومجلد إعدادات Obsidian يُتجاهل، والروابط تُقرأ كما هي.',
    mcplink_title: 'ربط وكيل خارجي', mcplink_note: 'انسخ سطرًا واحدًا في Claude Code أو Cursor — يقرأ من نفس الخزنة.', mcplink_cmd: 'Claude Code', mcplink_json: 'JSON (Cursor / أي عميل)', mcplink_ro: 'قراءة فقط (موصى به)', mcplink_ro_on: 'قراءة فقط', mcplink_ro_off: 'قراءة وكتابة', b_copy: 'نسخ', copied: '✓ نُسخ',
    gov_backup_title: 'النسخ الاحتياطي والاستعادة', b_backup_now: 'أنشئ نسخة الآن', b_restore: 'استعد', backup_none: 'لا نسخ بعد', restore_confirm: 'استعادة {n}؟ تُنشأ نسخة أمان أولاً.', restore_done: 'استُعيد {n} ملفاً', files_unit: 'ملف',
    s_add_skill: 'إضافة مهارة', lib_semantic_hits: 'نتائج البحث الدلالي', lib_semantic_none: 'لا نتائج دلالية — الفلتر النصي يعمل', ph_skill_desc: 'استخدم عند…', chip_skill_caps: 'وصف ≤300 · جسم ≤6000', l_skill_name: 'الاسم', l_skill_desc: 'الوصف (ما يراه الوكيل)', l_skill_body: 'الجسم — الخطوات', skill_need_all: 'املأ الاسم والوصف والجسم', skill_saving: 'أكتب وأفحص…', chars_unit: 'حرفًا',
    s_add_mcp: 'إضافة خادم MCP', chip_verified_add: 'يُفحص قبل الحفظ', l_mcp_name: 'الاسم', l_mcp_cmd: 'الأمر', l_mcp_args: 'الوسائط (بمسافات)', b_verify_add: 'افحص وأضف',
    s_mcp_servers: 'خوادم MCP', verified_word: 'مُتحقَّق منه', unverified_word: 'غير مُتحقَّق',
    s_repo_memory: 'ما يعرفه الوكيل', rb_from_memory: 'من ذاكرة الوكيل — بلا إعادة مسح', rb_stored_edges: 'حواف مخزَّنة:',
    ph_file: 'ملف…', b_analyze: 'حلّل', s_entry_points: 'نقاط الدخول', s_extensions: 'الامتدادات', no_files: 'لا ملفات',
    entry_word: 'مدخل', ext_packages: 'حزم خارجية', no_internal_deps: 'لا ترابط داخلي (ملفات بلا استيراد)',
    no_impact: 'لا أثر (لا استيرادات تشير إليه)', deps_scanned: 'فُحص', deps_internal: 'ترابط داخلي', deps_external: 'خارجي',
    rb_files: 'ملف', rb_dirs: 'مجلد', rb_code: 'كود', rb_docs: 'مستندات', rb_tests: 'اختبارات', rb_partial: 'المسح بلغ السقف — جزئي',
    indexing: 'أفهرس', index_failed: 'فشل الفهرسة', type_file_first: 'اكتب ملفاً أولاً',
    depends_on_cnt: 'يعتمد على', depended_by_cnt: 'يعتمد عليه', affected_cnt: 'متأثر',
    s_add_provider: 'إضافة مزود سحابي', l_name: 'الاسم', l_base_url: 'العنوان (Base URL)', l_api_key: 'مفتاح API',
    l_model_id: 'معرّف النموذج (اختياري — للحالات التي يقفل فيها المزود الاكتشاف)',
    b_test_add: 'اختبر وأضف', s_models_found: 'النماذج المكتشفة', no_providers: 'لا مزودين بعد — أضف واحداً بالأسفل.',
    s_providers_count: 'المزوّدون المسجّلون',
    no_key: 'بلا مفتاح', provider_word: 'مزود', model_word: 'النموذج', models_unit: 'نموذج', enabled: 'مفعّل', disabled: 'معطّل',
    b_use: 'استخدم', b_test: 'اختبر', testing: 'أختبر', ping_ok: 'يعمل', use_ok: '✅ صار المزود النشط:', save_failed: '⚠ فشل الحفظ',
    fill_three: 'املأ الحقول الثلاثة',
    b_edit: 'تعديل', ph_key_keep: 'اتركه فارغاً للإبقاء على المفتاح المحفوظ', b_save_changes: 'احفظ التعديلات',
    b_test_conn: 'اختبر الاتصال', b_save: 'حفظ', s_pick_model: 'النماذج المجلوبة — اختر واحداً ثم احفظ',
    tested_ok: 'نجح الاتصال', pick_one: 'اختر نموذجاً', no_usable_model: 'لا نموذج صالح للتوليد — جرّب معرّفاً يدوياً',
    test_first: 'اختبر الاتصال أولاً', saving_word: 'أحفظ…',
    editing_word: 'تعديل', fill_url_only: 'العنوان مطلوب (المفتاح محفوظ)', saved_word: 'حُفظ',
    err_url_ascii: '⚠ العنوان يجب أن يكون بحروف لاتينية فقط (لا عربية ولا مسافات)',
    err_key_ascii: '⚠ مفتاح API يجب أن يكون بحروف لاتينية فقط (a-z 0-9 - _)',
    err_url_http: '⚠ العنوان يجب أن يبدأ بـ http:// أو https://',
    busy_testing: 'أختبر…', progress_connect: '⏳ أتحقق من العنوان، أتصل، أجلب النماذج…',
    add_ok: '✅ نجح', step_word: '(الخطوة:', failed: 'فشل',
    s_import_file: 'استيراد ملف أو مجلد أو صفحة', l_path: 'المسار أو الرابط', l_format: 'الصيغة', opt_autodetect: 'كشف تلقائي', b_import: 'استورد',
    s_formats_supported: 'الصيغ المدعومة',
    fmt_word: 'صيغة', busy_import: '⏳ أستورد…', done_ok: '✅ تم',
    imp_root: 'المجلد', imp_scanned: 'مفحوص', imp_created: 'أُنشئ', imp_skipped: 'تُخطّي', imp_quar: 'محجور', imp_folder_hint: 'مسار مجلد ⇒ يُستورَد كل ما فيه',
    s_imported_docs: 'ما استُورد', imp_none_yet: 'لا شيء مستورد بعد', imp_src_ok: 'المصدر موجود', imp_src_gone: 'المصدر مفقود', imp_missing_src: 'مصدر مفقود:',
    s_available_tools: 'الأدوات المتاحة', tools_unit: 'أداة', ready_word: 'جاهز', connected: 'متصّل', disconnected: 'غير متصل',
    no_servers: 'لا خوادم مُعرّفة — لكن أدوات الذاكرة المدمجة متاحة أدناه.', busy_tools: '⏳ أحدّث الأدوات…',
    unchecked: 'لم يُفحص',
    gov_stages_title: 'طقوس المراحل الثماني', gov_proven: 'المُثبتة', gov_of: 'من', gov_next_stage: '• المرحلة التالية',
    gov_gates_title: 'بوابات منع الإطلاق', b_gates_check: 'افحص البوابات الآن',
    gov_usage_title: 'الاستهلاك',
    gov_usage_note: 'التكلفة غير المعروفة تُعرض <b>عدداً</b> لنداءات مجهولة التكلفة — لا تُخمَّن تكلفة مطلقاً.',
    gov_privacy_title: 'الخصوصية وسجل الاتصالات', gov_s_privacy: 'سياسة الخصوصية', gov_s_connections: 'سجل الاتصالات',
    gov_eval_title: 'التقييم الذاتي', gov_s_weakness: 'الضعف المرصود', gov_s_proposals: 'المقترحات',
    gov_quarantine_title: 'الحجر', gov_audit_title: 'سلامة التدقيق',
    gov_relations_title: 'تغطية أنواع العلاقات التسعة', b_rel_infer: 'استنتج العلاقات',
    gov_rollback_title: 'التراجع', b_rb_verify: 'أثبت التراجع',
    err_stages: '⚠ تعذّر تحميل المراحل:', failed_short: 'تعذّر', stages_done: 'اكتملت ✓', stages_incomplete: 'غير مكتملة',
    proven_l: 'مُثبتة', locked_l: 'مقفلة', b_prove: 'إثبات الدليل', opens_after_prev: 'تُفتح بعد إثبات سابقتها',
    gates_hint: 'اضغط «افحص البوابات الآن» لتنفيذ الفحص الحتمي', passed_l: 'نجحت', failed_l: 'فشلت',
    gate_rollback_note: '— يُثبت بالكود لا بالادعاء', not_checked_session: 'لم تُفحص في هذه الجلسة',
    check_failed: 'تعذّر الفحص', err_gates: '⚠ فشل فحص البوابات:', release_ok: 'الإطلاق مسموح', release_no: 'الإطلاق ممنوع',
    gates_all_pass: 'كل البوابات نجحت', gates_failed_list: 'بوابات فاشلة ({n}): {list}',
    rollback_desc: '— وصف التراجع: تغيير ← لقطة ← تراجع ← قراءة مطابقة',
    err_usage: '⚠ تعذّر تحميل الاستهلاك:', u_calls: 'النداءات', u_prompt: 'رموز الطلب', u_completion: 'رموز الرد',
    u_known: 'التكلفة المعروفة', u_unknown: 'نداءات مجهولة التكلفة (عدد)',
    err_privacy: '⚠ تعذّر تحميل سياسة الخصوصية:', allowed: 'مسموح', forbidden: 'ممنوع',
    no_privacy_notice: 'لا إشعار خصوصية', url_word: 'العنوان',
    err_connections: '⚠ تعذّر تحميل سجل الاتصالات:', no_connections: 'لا اتصالات خارجية مسجّلة',
    ext_connection: 'اتصال خارجي', res_fail: 'فشل', res_ok: 'نجح',
    err_eval: '⚠ تعذّر تحميل التقييم الذاتي:', ev_scope: 'النطاق', ev_tasks: 'المهام', ev_done: 'نُفّذت', ev_failed: 'فشلت',
    ev_blocked: 'محجوبة', ev_pending: 'معلّقة', ev_rate: 'نسبة النجاح', ev_avgdur: 'متوسط الزمن (ث)',
    ev_noev: 'مهام بلا أثر أداة', ev_noev_pct: 'بلا أثر %', ev_retried: 'مهام أُعيدت', ev_mcp: 'أدوات MCP تحتاج اعتماداً',
    threshold_word: 'الحد:', no_weakness: 'لا ضعف مرصود',
    prop_accepted: 'معتمد', prop_rejected: 'مرفوض', prop_passed: 'مُجرَّب ومتفوّق', prop_trialed: 'مُجرَّب', prop_notried: 'بلا تجربة',
    why_forbidden: 'مقترح ممنوع — مساس بالأمان', why_notried: 'لا اعتماد قبل التجربة — لم تُجرَّب بعد',
    why_failed: 'التجربة لم تتفوّق على الأساس — الاعتماد محجوب',
    acceptance_word: 'معيار القبول:', impact_word: 'الأثر:', trial_delta: '• فرق التجربة:',
    b_accept: 'اعتماد', b_reject: 'رفض', tt_accept: 'اعتماد المقترح', tt_reject: 'رفض المقترح', tt_no_decide: 'لا قرار قبل التجربة',
    no_proposals: 'لا مقترحات حالياً',
    err_quarantine: '⚠ تعذّر تحميل الحجر:', q_total: 'الإجمالي', q_open: 'مفتوح', q_cleared: 'مُرفوع', q_scanned: 'ممسوح',
    q_unscanned: 'غير ممسوح', q_isolations: 'عزل', no_quar_rows: 'لا صفوف في الحجر الآن',
    ph_q_reason: 'سبب رفع الحجر (إلزامي)', b_q_clear: 'ارفع الحجر',
    verify_failed: 'تعذّر التحقق', unexpected: 'رد غير متوقع', audit_ok: 'سجل التدقيق سليم ✓', audit_broken: 'السجل مكسور ✖',
    a_lines: 'أسطر', a_hashed: 'مُهشَّرة من', a_unhashed: 'غير مُهشَّرة', a_dbrows: 'صفوف القاعدة', a_broken_at: 'الكسر عند',
    err_relations: '⚠ تعذّر تحميل تغطية العلاقات:', kind_present: 'موجود', kind_missing: 'غائب', kind_untracked: 'غير مرصود',
    kind_project: 'مشروع', kind_document: 'مستند', kind_repo: 'مستودع', kind_file: 'ملف',
    kind_task: 'مهمة', kind_decision: 'قرار', kind_meeting: 'اجتماع', kind_procedure: 'إجراء',
    kind_knowledge: 'معرفة', kind_note: 'ملاحظة', kind_prd: 'متطلبات', kind_rfc: 'مقترح', kind_adr: 'سجل قرار',
    kind_spec: 'مواصفة', kind_design: 'تصميم', kind_plan: 'خطة', kind_risk: 'خطر', kind_question: 'سؤال',
    kind_reference: 'مرجع', kind_state: 'حالة', kind_living_note: 'ملاحظة حيّة', kind_doc: 'مستند',
    rel_present: 'الموجود', rel_of: 'من', rel_legacy: 'القديمة:', rel_none: 'لا شيء',
    err_rollback: '⚠ تعذّر تحميل التغييرات:', rb_total: 'الإجمالي', rb_reverted: 'مُتراجَع', rb_pending: 'معلّق',
    no_rb_changes: 'لا تغييرات معلّقة قابلة للتراجع', entity_word: 'كيان', b_revert: 'أرجع',
    not_proven: 'لم يُثبت', err_rbproof: '⚠ فشل إثبات التراجع:', rb_proven: 'أُثبت التراجع ✓',
    prove_prompt: 'دليل إثبات المرحلة «{s}» (إلزامي):', prove_default: 'الدليل: المرحلة «{s}» تعمل بالمصدر الحقيقي والقاعدة مبنية',
    evidence_required: 'الدليل إلزامي — لا إثبات بلا دليل', busy_prove: 'يُثبت…', err_prove: 'تعذّر إثبات المرحلة',
    proven_stage: 'أُثبتت المرحلة:', busy_check: 'يفحص…',
    toast_gates_ok: 'البوابات نجحت — الإطلاق مسموح', toast_gates_no: 'الإطلاق ممنوع — {n} بوابة فاشلة',
    busy_infer: 'يستنتج…', err_infer: 'تعذّر الاستنتاج', err_infer_full: 'تعذّر استنتاج العلاقات',
    added_rels: 'أُضيف {n} علاقة', toast_inferred: 'استُنتجت العلاقات — أُضيف {n}',
    err_revert: 'تعذّر التراجع', toast_reverted: 'تم التراجع عن التغيير #{n}',
    q_prompt: 'سبب رفع الحجر عن #{n} إلزامي — اكتبه للمتابعة:', reason_required: 'السبب إلزامي — لم يُرفع الحجر',
    err_q_clear: 'تعذّر رفع الحجر', toast_q_cleared: 'رُفع الحجر عن #{n}',
    no_trial: 'لا اعتماد قبل التجربة — لا تجربة مسجّلة لهذا المقترح', err_decide: 'تعذّر تنفيذ القرار',
    toast_accept: 'اعتُمد المقترح ✓', toast_reject: 'رُفض المقترح', err_gov: '⚠ تعذّر تحميل شاشة الحُكم:',
    health_prefix: 'صحة', state_prefix: 'حالة:', session_goal: 'جلسة وكيل',
  agent_plan_steps: 'الخطة', daemon_next: 'الفحص القادم بعد', daemon_off: 'الفحص الدوري متوقف', daemon_guard: 'الحارس يعمل',
  daemon_guard_off: 'الحارس غير مُدار', daemon_last_ok: 'آخر فحص سليم', daemon_last_fail: 'آخر فحص فشل', daemon_last_check: 'آخر فحص',
    g_nodes: 'عنصر', g_link: 'ارتباط', no_map: '⚠ لا خريطة:', map_empty: 'الخريطة فارغة — أضف عناصر',
    unit_tasks: 'مهمة', unit_done: 'نُفّذت', unit_failed: 'فشلت', unit_par: 'توازٍ', unit_obj: 'اعتراض', sec_unit: 'ث',
    no_runs: 'لا تشغيلات', verdict_accepted: 'مقبول', verdict_rejected: 'مرفوض', verdict_conditional: 'مشروط', verdict_empty: 'بلا تشغيل',
    r_all_terminal: 'اكتملت كل المهام', r_no_failures: 'بلا فشل', r_evidence: 'كل منتهٍ له أثر', r_verifier: 'دور تحقق', r_claims: 'ادعاءات مُتحقّقة',
    sev_high: 'جسيم', sev_medium: 'متوسط', no_objections: 'لا اعتراضات',
    no_objections_body: 'كل مهمة منتهية لها أثر أداة، ولا ادعاء بلا دليل.',
    st_done: 'منتهية', st_failed: 'فشلت', st_blocked: 'مُعلَّقة', ev_unit: 'أثر', no_evidence: 'بلا أثر',
    no_runs_hint: 'لا تشغيلات بعد — شغّل الفريق من شاشة الوكلاء.',
    run_word: 'تشغيل:', no_run_word: 'بلا تشغيل', note_word: 'ملاحظة', no_findings_yet: 'لا نتائج بعد', no_file_tasks: 'لا مهام في الملف',
    waiting: 'في الانتظار', role_word: 'دور', w_running: 'يعمل', tool_word: 'أداة',
    w_done: 'انتهى', w_failed: 'فشل', w_blocked: 'مُعلَّق', sum_result: 'النتيجة:', sum_done: 'انتهت', sum_not: 'لم تكتمل',
    sum_verdict: 'الحكم:', verified: 'مُتحقَّق', unverified: 'غير مُتحقَّق', err_prefix: '⚠ تعذّر:',
    no_sessions_short: 'لا جلسات',
    par_on: 'الوضع المتوازي مفعّل — سيوزّع الهدف على الأدوار', par_off: 'الوضع المتوازي معطّل',
    thinking: '⏳ أفكّر…', no_reply: '(بلا رد)', error_word: 'خطأ', conn_fail: '⚠ تعذّر الاتصال بالوكيل:',
    finished_sources: 'انتهى — {n} مصدر',
    unset: 'غير محدَّد',
    conf_unknown_tag: 'ثقة-غير-محدَّدة', conf_low_tag: 'ثقة-غير-مؤكِّدة', bayn_data: 'بيانات', bayn_tag: 'بيانات نوع',
    conf_origin: 'المصدر', conf_label: 'الثقة', conf_extracted: 'الاستخراج', conf_not_recorded: 'غير مسجَّل',
    conf_unknown: 'ثقة غير محدَّدة', conf_unconfirmed: 'ثقة غير مؤكِّدة', rel_in: 'واردة', rel_out: 'صادرة',
    no_relations: 'لا علاقات مسجَّلة لهذا العنصر', conf_avg: 'متوسط الثقة', rel_units: 'علاقة',
    lang_toggle_title: 'English / العربية',
    l_emb_model: 'نموذج التضمين',
    l_emb_base: 'عنوان التضمين', l_emb_key: 'مفتاح التضمين', l_rerank: 'إعادة الترتيب', l_topk: 'عدد المقاطع (Top K)',
    /* ── إضافة مصدر (＋ جديدة) — قرار 2026-10-27: المستخدم يقدّم مصدراً لا نوعاً ── */
    
    src_tab_quick: 'نص سريع',
    
    ph_quick_text: 'النص الذي تريد أن يصير معرفة…',
    src_folder_hint: 'معاينة التصنيف تعرض ما سيُستورد بلا كتابة — ثم «استورد الآن» يكتب فعلًا.',
    src_preview_btn: 'معاينة التصنيف', 
    
    
    src_total: 'إجمالي الملفات', src_by_kind: 'التصنيف',
    src_sample: 'أول 30 ملفاً', src_col_path: 'المسار', src_col_kind: 'النوع', src_col_size: 'الحجم',
    src_preview_empty: 'لا ملفات قابلة للاستيراد في هذا المسار.', src_created: 'أُنشئ', src_skipped: 'تُخطّي',
    src_quarantined: 'محجور', src_relations: 'علاقات مضافة', src_scanned: 'مفحوص', src_files_unit: 'ملف',
    src_saved_hint: 'الأصل محفوظ والبصمة مسجّلة — الاستيراد المُعاد لا يُنتج نسخة ثانية (§19).',
    src_need_path: 'اكتب مساراً أولاً.', 
    src_busy_preview: 'يصنّف…', busy_save: 'يُحفظ…',
    /* ── ربط ذكي (＋ ربط) — الوكيل يقترح والمستخدم يعتمد ── */
    link_ph_search: 'ابحث عن عنصر بالعنوان…', link_pick_hint: 'اختر عنصراً ليقرأ الوكيل تشابهه الفعلي.',
    link_suggest_title: 'اقتراحات الوكيل', link_approve: 'اعتمد المحدد', link_confidence: 'الثقة',
    link_philosophy: 'الوكيل يقترح من تشابه فعلي (وسوم/روابط/مصطلحات)، والقرار لك — وكل علاقة مسجَّلة بمصدر وثقة وزمن (§7).',
    link_loading: 'يقرأ التشابه…', link_none: 'لا اقتراحات لهذا العنصر — جرّب عنصراً آخر.',
    link_select_first: 'اختر عنصراً أولاً.', link_approve_none: 'حدّد اقتراحاً واحداً على الأقل.',
    link_approved_n: 'اعتُمدت {n} علاقة', link_failed_n: 'فشل {m}',
    link_reason_tpl: 'تشابه فعلي مع «{title}» ({score} نقطة إشارة: وسوم/روابط/تقاطع مصطلحات)',
    /* ── لوحة الوكيل: المجدول والنبضات والمهارات ── */
    advanced_word: 'متقدم', sched_title: 'المهام المجدولة',
    sched_hint: 'هدف + كل كم ساعة ⇒ الوكيل يشغّله وحده ويسجّل نبضه. النتائج في سجل النبضات أدناه.',
    sched_every_lbl: 'كل كم ساعة', sched_add: 'أضف مهمة', ph_sched_goal: 'هدف يعمل دونك… مثال: حدّث ذاكرة المشروع ولخّص المستجدات',
    sched_pulse_every: 'النبض كل {n} ساعات', sched_pulse_off: 'النبض العام معطّل (0)', sched_every_unit: 'كل {n} ساعات',
    sched_due: 'الاستحقاق', sched_now: 'الآن', sched_last: 'آخر تشغيل', sched_never: 'لم تُشغَّل بعد',
    sched_disable: 'تعطيل', sched_enable: 'تفعيل', sched_remove: 'حذف', sched_run_now: 'شغّلها الآن', sched_running: 'تعمل…',
    sched_empty: 'لا مهام مجدولة — أضف هدفاً يعمل دونك.', sched_confirm_remove: 'احذف المهمة المجدولة؟',
    sched_range_err: 'تكرار المهمة خارج النطاق (0.25..720 ساعة)',
    sched_added: 'أُضيفت المهمة المجدولة', sched_removed: 'حُذفت المهمة المجدولة',
    sched_on_word: 'المهمة مفعّلة', sched_off_word: 'المهمة معطّلة', sched_done: 'انتهى التشغيل',
    ticks_title: 'سجل النبضات', ticks_empty: 'لا نبضات مسجّلة بعد — تُسجَّل عند أول تشغيل.',
    ticks_ok: 'سليمة', ticks_err: 'خطأ', ticks_new: 'مستجدات', ticks_brief: 'الموجز', ticks_memory: 'الذاكرة',
    ticks_sched_runs: 'مهام مجدولة: {n}', ticks_ms: 'مدة',
    skills_title: 'المهارات', skills_empty: 'لا مهارات في الفهرس.', skills_unit: 'مهارة',
    skills_col_name: 'الاسم', skills_col_desc: 'الوصف', skills_issue_h: 'ملاحظات الفهرس',
    /* ── ⌘K: التثبيت والمرادفات ── */
    pin_add: 'تثبيت', pin_remove: 'إلغاء التثبيت', pinned_word: 'مثبتة'
  },
  en: {
  'ph_filter_title': 'Filter by title…',
  'ph_search_all': 'Search everything…',
  'v_knowledge': 'Knowledge',
  'v_agents': 'Agents',
  'agent_need_goal': 'Type a goal for the agent first — or pick a ready template.',
  'agent_templates': 'Ready templates:',
  'tpl_analyze': 'Analyze my project',
  'tpl_gaps': 'Find knowledge gaps',
  'tpl_status': 'Status report',
  'v_monitor': 'Monitor',
  'v_repos': 'Repositories',
  'v_providers': 'Providers',
  'v_import': 'Import',
  'v_tools': 'Tools',
  'v_governance': 'Governance',
    all_projects: 'All projects', g_docs: 'Documents', g_decisions: 'Decisions', g_tasks: 'Tasks',
    g_meetings: 'Meetings', g_notes: 'Notes', st_items: 'items', none: '—',
    idx_ok: 'index ready ✓', idx_dirty: 'index needs rebuild ⟳',
    v_edit: 'Edit', v_split: 'Split', v_graph: 'Map', v_state: 'Project board', v_preview: 'Preview', ph_search_library: 'Search the library...', kk_imported: 'Imported', kk_decided: 'Decided', kk_inferred: 'Inferred', kk_hypothesis: 'Hypothesis', kk_hint: 'Knowledge kind: how this item arrived and who owns it — inferred and hypothesis are unconfirmed.', ctx_tasks_all: 'Workspace tasks', src_word: 'Source', ctx_state: 'State',
    ctx_tasks: 'Tasks', ctx_related: 'Related', ctx_backlinks: 'Backlinks', ctx_history: 'History',
    c_confidence: 'Relation confidence',
    s_steps: 'Next steps', s_gaps: 'Gaps', s_tasks_c: 'Open tasks', s_timeline: 'Health over time (SQLite)',
    l_health: 'Project health',
    g_tasksb: 'Meeting items', g_contr: 'Contradictions', findings_title: 'Memory findings',
    goal_gaps: 'What is missing in this project? Find the gaps only', goal_tasks: 'Extract the action items from this document and record them as tasks now',
    goal_next: 'What is the next step for this project?', goal_contra: 'Check contradictions with related documents, report only, no edits',
    b_living: '🧾 Living note', b_backup: '🗜 Backup now', b_agent: 'Agent',
    draft_unit: 'draft', drafts_unit: 'drafts', drafts_title: 'Drafts awaiting your approval — click to open the agent panel',
    create_hint_title: 'The title is the item name you will find, link, and search by in the library and ⌘K — make it clear.',
    create_hint_type_project: 'Type = its semantic classification · Project = the group it appears under in the sidebar (like a folder) — type a new name to create a group, or an existing name to join it.',
    mcp_intro: 'Cortex is an MCP server: your memory (28 tools) for any external agent — Claude Code / Codex / OpenCode / Hermes. And the reverse: Cortex calls external MCP server tools (every call is an approval-gated draft).',
    mcp_test_live: 'Test the connection now',
    mcp_testing: '… running a real call (memory_stats)',
    mcp_reached: 'reached ✓',
    mcp_general: 'Universal connection — one address for any system',
    b_copy_url: 'Copy address',
    mcp_general_note: 'Any system that supports remote MCP connects to this address directly (no file paths, no config files). For stdio-only systems use the standard block above.',
    mcp_incoming: 'Last inbound connection',
    mcp_incoming_never: 'No system has connected yet (stdio sessions are not visible here — each call is its own session)',
    mcp_check: 'Check', mcp_unlink: 'Unlink', mcp_unlinked: 'Unlinked',
    mcp_last_ok: 'last test: reached', mcp_last_fail: 'last test: failed', mcp_last_none: 'not tested yet',
    mcp_loading: '… loading the server list',
    mcp_general_test: 'Test the general connection',
    mcp_general_testing: '… calling /mcp',
    mcp_incoming_stop: 'Stop incoming connections',
    mcp_incoming_start: 'Start incoming connections',
    mcp_incoming_on: 'Incoming: enabled',
    mcp_incoming_off: 'Incoming: disabled',
    mcp_incoming_disabled_note: 'Incoming is stopped — visitors are refused now',
    mcp_external: 'Reverse direction — an external MCP server Cortex calls (always drafts)',
    mcp_ext_name: 'Name', mcp_ext_add: 'Add & test', mcp_ext_need: 'Name and command are required',
    mcp_no_external: 'No external servers linked yet — add one from the fields below and a card with “Check” and “Unlink” appears right here.',
    mcp_caps_unit: 'classified capabilities',
    toast_copied: 'Copied ✓',
    sess_continue: 'Continue this session', sess_active: 'active', sess_show: 'Show messages', sess_hide: 'Hide messages',
    c_details: 'Item details',
    b_meta: 'Meta',
    meta_edit_hint: 'Edit type/project/importance — the agent infers them automatically',
    saving_word: '… saving',
    saved_word: 'Saved ✓',
    agent_busy_wait: 'The agent is working — press ⏹ in the bar above the chat to stop it',
    s_maintenance: 'Quick maintenance',
    maintenance_note: 'Both are also in ⌘K. The living note is captured automatically during agent runs — these are for manual runs.',
    adv_manual: 'Manual meta (optional — the agent usually infers it)',
    sess_no_msgs: 'No messages in this session yet', sess_resumed: 'The agent will continue this session ✓',
    sess_role_user: 'You', sess_role_assistant: 'Agent',
    agent_planning: '🧠 Agent is planning…', agent_done_mut: 'Real mutations applied', agent_sources: 'Sources',
    agent_welcome_sub: 'The agent executes evidence-backed tasks on your knowledge: analysis, search, gaps and contradictions — and only approved writes.',
    agent_welcome_hint: 'Type a goal below or pick a template — every answer cites its sources',
    toast_backup: 'Backup created', b_export_project: 'Export', export_hint: 'a hand-off project bundle', export_title: 'Export the current project as Markdown', export_done: 'Project exported', export_need_project: 'Pick a project first — export works on one project', toast_rebuilt: 'Index rebuilt', toast_living: 'Living note updated',
    toast_copied: 'Config copied ✓', toast_saved: 'Saved ✓', toast_deleted: 'Deleted ✓',
    ask_delete: 'Delete this item permanently?', ask_replace: 'You have unsaved edits that will be replaced. Continue?',
    snap_loaded: 'Snapshot loaded — review then save to restore', ready: 'Cortex ready',
    agent_intro: 'I am your local agent — type what you want in plain words: I read your knowledge and projects and actually execute the steps, and I stop before any sensitive step as a draft awaiting your approval. Try for example: "How many notes do I have?"',
    disc_updated: 'Disk update', understood: 'Understood', best_next: 'Best next step', no_tasks: 'No tasks in this project yet',
    extract_btn: 'Auto-extract tasks from this document', extract_btn_mtg: 'Extract action items from this meeting',
    no_related: 'No related items — add [[links]]', no_backlinks: 'No backlinks', no_history: 'No snapshots yet',
    no_entities: 'No entities yet', no_sessions: 'No sessions yet — every agent goal is recorded here',
    mcp_count: 'MCP tools', no_findings: 'No visible contradictions ✓',
    state_open: 'Open tasks', state_steps: 'Next steps', state_gaps: 'Gaps', state_tl: 'Health timeline',
    living_inline: 'Refresh living note', open_note_hint: 'Open source note',
    b_new_s: '＋ New', policy: 'additive only · no deletes · audited',
    mcp_title: 'MCP — the Cortex memory for any model', sessions_title: 'Agent sessions', settings_title: 'Settings', new_title: 'New item',
  a11y_skip: 'Skip to main content', aria_palette: 'Command palette', aria_palette_results: 'Command palette results', aria_rail: 'Main navigation', aria_goal: 'Agent goal', aria_agent_log: 'Agent log', aria_gov_tabs: 'Governance sections', gov_tab_stages: 'Stages & gates', gov_tab_quality: 'Quality & evaluation', gov_tab_safety: 'Quarantine & impact', gov_tab_rel: 'Relations', gov_tab_privacy: 'Privacy & connections',
  ph_import_path: 'docs/notes.md — or a folder — or https://...', ph_mcp_cmd: 'command, e.g. node / npx', ph_mcp_args: 'args separated by spaces: server.js --flag',
    b_save: 'Save', b_delete: 'Delete', b_close: 'Close', b_copy: 'Copy config',
    b_rebuild: 'Rebuild index', b_create: 'Create', b_cancel: 'Cancel',
    l_importance: 'Importance',
    t_note: 'Note', t_doc: 'Doc', t_project: 'Project', t_decision: 'Decision', t_task: 'Task',
    t_meeting: 'Meeting', t_procedure: 'Procedure', t_state: 'State', t_living: 'Living note',
    s_chat_model: 'Chat model', l_provider: 'Provider',
    s_generation: 'Generation', b_manage_providers: 'Manage providers',
    no_active_model: 'No active provider — add one in the Providers section',
    providers_single_home: 'The single place to manage providers: add, test, pick a model, activate, remove.',
    b_use_model: 'Use this model', model_active: 'Active model', activating: 'Activating',
    emb_local: 'Local, offline (n-gram)',
    acc_amber: 'Accent: amber', acc_teal: 'Accent: teal', acc_violet: 'Accent: violet',
    l_temp: 'Temperature',
    l_price_in: 'Input $/1k (optional)', l_price_out: 'Output $/1k (optional)',
    view_file: 'View file', file_truncated: 'truncated at view cap',
    s_retrieval: 'Retrieval', s_appearance: 'Appearance',
    l_ui_lang: 'Interface language', l_fontsize: 'Font size', l_accent: 'Accent', l_project: 'Project', b_open_import: 'Import a file, folder or URL ↗', quick_modal_sub: 'Write it now — to import a file, folder or URL, open the Import section.', b_add_item: 'Add item', b_open_tools: 'Show tools', deps_code_only: 'code files only', active_word: 'active', b_delete: 'Delete', deleted_word: 'Removed', confirm_delete_provider: 'Delete provider',
    appearance_note: 'Saved locally and applied instantly.',
    s_resolve: 'Resolve', b_understand: 'Understand', ph_resolve: 'e.g. open the document',
    s_projects: 'Projects', s_library: 'Library', s_entities: 'Top entities',
    empty_h: 'Your knowledge brain is empty',
    empty_p: 'Create the first item, or press ⌘K and start typing. Everything becomes memory.',
    b_first: 'Start with a new item', ph_palette: 'Search items or run a command…',
    ph_graph: 'Filter the map…', ph_goal: 'Write to the agent… e.g. review this document and log the gaps as tasks',
    b_send: 'Send', autosave: 'autosave every 1.6s', kb_hint: '⌘K commands',
    no_results: 'No results',
    f_gap: 'Gap', f_contra: 'Contradiction', f_isolated: 'Isolated item', f_stale: 'Stale',
    c_tasks: 'Tasks', c_related: 'Related', c_backlinks: 'Backlinks', c_history: 'History',
    hb: 'Health timeline',
    agent_sub: 'Type your goal — works from your sentence',
    l_autonomy: 'Agent mode', l_emb_provider: 'Embeddings provider', l_schedule: 'Agent sweep — every (hours)',
    p_autonomous: 'Autonomous (immediate)', p_supervised: 'Supervised (drafts)',
    palette_hint: '↑↓ navigate • Enter to run • Esc to close',
    policy_note: 'In supervised mode, agent writes become drafts you approve in the agent panel before merging.',
    s_policy: 'Agent & policy', s_tasks: 'Open tasks',
    l_language: 'Agent language', lang_auto: 'Automatic (your goal decides)', lang_ar: 'Always Arabic', lang_en: 'Always English',
    link_title: 'Smart linking', link_from: 'Selected item',
    b_link: '＋ Link',
    imp_normal: 'Normal', imp_important: 'Important', imp_critical: 'Critical',
    conf_word: 'confidence', source_word: 'source', loading_word: 'Loading', not_found_word: 'Item not found',
    no_relations_word: 'No relations recorded yet', open_in_knowledge: 'Open in Knowledge', ask_agent: 'Ask the agent',
    goal_about_word: 'Explain', goal_about_body: 'what it is, how it relates to other items, and the next step',
    kind_note: 'Note', kind_project: 'Project', kind_document: 'Document', kind_file: 'File',
    kind_repo: 'Repository', kind_task: 'Task', kind_decision: 'Decision', kind_knowledge: 'Knowledge',
    d_click_hint: 'Click a node to see its full profile',
    next_action_word: 'Suggested next step',
    /* ═══ Full i18n batch: every section string ═══ */
    title_app: 'Cortex — Living Memory',
    v_graph_h: 'Association Map', v_monitor_h: 'Productivity Monitor', v_providers_h: 'AI Providers', v_tools_h: 'External Tools',
    tools_note: 'These are the memory server (MCP) tools available to external agents — every call passes the permission gate and is audited; writes stay approval-gated drafts.',
    b_refresh: 'Refresh', b_refit: 'Re-layout', l_labels: 'Labels', b_clear_filter: 'Clear filter',
    opt_all_types: 'All types', tp_projects: 'Projects', tp_docs: 'Docs', tp_decisions: 'Decisions', tp_tasks: 'Tasks', tp_meetings: 'Meetings',
    ph_title: 'Title', ph_title_ellipsis: 'Title…', ph_project: 'Project', ph_chat2: 'Ask something…', b_send: 'Send',
    ph_team_goal: 'Team goal… e.g. review project Atlas, draft a summary, then test it',
    team_title: 'Parallel Team', team_pipe: 'Analyst → Executor → (Tester ∥ Critic) → (Verifier ∥ Monitor)',
    l_parallelism: 'Parallelism', b_team_stop: 'Stop stream', l_parallel: 'Parallel',
    role_executor: 'Executor', role_critic: 'Critic', role_monitor: 'Productivity Monitor',
    a_steps: 'Steps', a_sources: 'Sources',
    live_working: 'Working now', live_idle: 'Idle', live_last: 'last run', live_step: 'step', live_stop: 'Stop',
    live_stopped: 'Stop requested — it will halt before the next step',
    tl_think: 'Thought', tl_args: 'Arguments', tl_drafts_notice: 'drafts awaiting your approval', tl_show_drafts: 'Show drafts',
    tl_verify_req: 'Verification evidence is required before finishing', tl_verified_ok: 'Verified with evidence', tl_verified_bad: 'Finished without verification evidence',
    tl_cancelled: 'Run cancelled on request', tl_failed: 'Run failed',
    artifact_title: 'Report saved to knowledge', artifact_open: 'Open report', chars_unit: 'chars',
    contract_title: 'Permissions & roles', contract_autonomy: 'Autonomy level', contract_limits: 'Daily caps',
    contract_roles: 'Roles and scopes', contract_tools: 'Tools', contract_tools_count: 'registered tools',
    contract_save: 'Save with confirmation', contract_confirm_autonomy: 'Changing autonomy is an audited governance decision — are you sure?',
    contract_confirm_limits: 'Cap changes take effect immediately and are audited — confirm?',
    contract_saved: 'Contract saved and audited', contract_scope: 'Scopes', contract_write: 'Write', contract_yes: 'yes', contract_no: 'no',
    contract_nodraft_tools: 'Tools that only execute with your approval', contract_base: '(base)', contract_close: 'Close',
    contract_note: 'Every change here requires explicit confirmation and is audited — the agent never grants itself a permission.',
    mode_supervised: 'Supervised', mode_assisted: 'Assisted', mode_autonomous: 'Autonomous',
    k_verdict: 'Monitor verdict', k_tasks: 'Tasks', k_done: 'Done', k_failed: 'Failed', k_success: 'Success',
    k_parallel: 'Peak concurrency', k_duration: 'Avg duration',
    opt_last_run: 'Latest run', s_objections: 'Strict monitor objections', s_recent_tasks: 'Recent tasks',
    th_task: 'Task', th_owner: 'Owner', th_status: 'Status', th_project: 'Project', th_due: 'Due',
    s_suggested: 'Suggested steps', s_open_tasks2: 'Open tasks', s_kgaps: 'Knowledge gaps',
    ph_repo_path: 'Path inside the workspace…', b_index: 'Index', s_files: 'Repository content', s_deps: 'Dependencies', s_impact: 'Change impact',
    repo_empty_hint: 'No repository indexed yet — enter a path inside the workspace and press Index.',
    b_sev_derive: 'Derive severity', sev_rows: 'severity estimates', rel_typed: 'typed relations', rel_last: 'last inference', rel_never: 'never run',
    sev_done: '{n} estimates written · {s} without evidence skipped', sev_invalid: 'Unknown value: {f}={v} — allowed: {a}', sev_none: 'No evidence: declare sensitivity: public|internal|confidential|restricted or criticality: 1-100 in the note header',
    ask_title: 'Ask your library', ask_chip: 'with sources · or “I don’t know”', ask_ph: 'What did we decide about…?', ask_btn: 'Ask', ask_thinking: 'Searching and reading…', ask_none: 'Not enough evidence in your vault',
        vault_title: 'Vault', vault_folders: 'folders', vault_nested: 'in subfolders', vault_attach: 'attachments', vault_src_env: 'from env', vault_src_config: 'from settings', vault_src_default: 'default', vault_need: 'Enter a folder path', vault_saved: 'Saved — restart to apply', vault_reset_done: 'Reset — restart to apply', vault_set: 'Open this folder', vault_reset: 'Default', vault_note: 'Applied after restart. Subfolders are read, the Obsidian settings folder is ignored, and links are read as-is.',
    mcplink_title: 'Connect an external agent', mcplink_note: 'Copy one line into Claude Code or Cursor — it reads the same vault.', mcplink_cmd: 'Claude Code', mcplink_json: 'JSON (Cursor / any client)', mcplink_ro: 'Read-only (recommended)', mcplink_ro_on: 'Read-only', mcplink_ro_off: 'Read & write', b_copy: 'Copy', copied: '✓ Copied',
    gov_backup_title: 'Backup & restore', b_backup_now: 'Create backup now', b_restore: 'Restore', backup_none: 'No backups yet', restore_confirm: 'Restore {n}? A safety backup is made first.', restore_done: '{n} files restored', files_unit: 'files',
    s_add_skill: 'Add skill', lib_semantic_hits: 'semantic hits', lib_semantic_none: 'no semantic hits — text filter active', ph_skill_desc: 'Use when…', chip_skill_caps: 'desc ≤300 · body ≤6000', l_skill_name: 'Name', l_skill_desc: 'Description (what the agent sees)', l_skill_body: 'Body — steps', skill_need_all: 'Fill name, description and body', skill_saving: 'Writing and verifying…', chars_unit: 'chars',
    s_add_mcp: 'Add MCP server', chip_verified_add: 'verified before saving', l_mcp_name: 'Name', l_mcp_cmd: 'Command', l_mcp_args: 'Args (space separated)', b_verify_add: 'Verify & add',
    s_mcp_servers: 'MCP servers', verified_word: 'verified', unverified_word: 'not verified',
    s_repo_memory: 'What the agent knows', rb_from_memory: 'from agent memory — no rescan', rb_stored_edges: 'stored edges:',
    ph_file: 'File…', b_analyze: 'Analyze', s_entry_points: 'Entry points', s_extensions: 'Extensions', no_files: 'No files',
    entry_word: 'entry', ext_packages: 'External packages', no_internal_deps: 'No internal dependencies (files without imports)',
    no_impact: 'No impact (no imports point to it)', deps_scanned: 'scanned', deps_internal: 'internal edges', deps_external: 'external',
    rb_files: 'files', rb_dirs: 'dirs', rb_code: 'code', rb_docs: 'docs', rb_tests: 'tests', rb_partial: 'scan hit its cap — partial',
    indexing: 'Indexing', index_failed: 'Indexing failed', type_file_first: 'Type a file first',
    depends_on_cnt: 'depends on', depended_by_cnt: 'depended on by', affected_cnt: 'affected',
    s_add_provider: 'Add a cloud provider', l_name: 'Name', l_base_url: 'Base URL', l_api_key: 'API key',
    l_model_id: 'Model ID (optional — when the provider gates discovery)',
    b_test_add: 'Test & add', s_models_found: 'Discovered models', no_providers: 'No providers yet — add one below.',
    s_providers_count: 'Registered providers',
    no_key: 'no key', provider_word: 'Provider', model_word: 'Model', models_unit: 'models', enabled: 'enabled', disabled: 'disabled',
    b_use: 'Use', b_test: 'Test', testing: 'Testing', ping_ok: '✅ Live', use_ok: '✅ Active provider:', save_failed: '⚠ Save failed',
    fill_three: 'Fill in all three fields',
    b_edit: 'Edit', ph_key_keep: 'Leave empty to keep the saved key', b_save_changes: 'Save changes',
    b_test_conn: 'Test connection', b_save: 'Save', s_pick_model: 'Fetched models — pick one, then save',
    tested_ok: 'Connection OK', pick_one: 'Pick a model', no_usable_model: 'No model can generate — try a manual id',
    test_first: 'Test the connection first', saving_word: 'Saving…',
    editing_word: 'editing', fill_url_only: 'Base URL is required (key is saved)', saved_word: 'Saved',
    err_url_ascii: '⚠ Base URL must be Latin characters only (no Arabic, no spaces)',
    err_key_ascii: '⚠ API key must be Latin characters only (a-z 0-9 - _)',
    err_url_http: '⚠ Base URL must start with http:// or https://',
    busy_testing: 'Testing…', progress_connect: '⏳ Checking URL, connecting, fetching models…',
    add_ok: '✅ OK', step_word: '(step:', failed: 'failed',
    s_import_file: 'Import a file, folder, or page', l_path: 'Path or URL', l_format: 'Format', opt_autodetect: 'Auto-detect', b_import: 'Import',
    s_formats_supported: 'Supported formats',
    fmt_word: 'Format', busy_import: '⏳ Importing…', done_ok: '✅ Done',
    imp_root: 'Folder', imp_scanned: 'scanned', imp_created: 'created', imp_skipped: 'skipped', imp_quar: 'quarantined', imp_folder_hint: 'A folder path imports everything inside it',
    s_imported_docs: 'Imported documents', imp_none_yet: 'Nothing imported yet', imp_src_ok: 'source present', imp_src_gone: 'source missing', imp_missing_src: 'missing sources:',
    s_available_tools: 'Available tools', tools_unit: 'tools', ready_word: 'ready', connected: 'connected', disconnected: 'disconnected',
    no_servers: 'No servers configured — built-in memory tools are available below.', busy_tools: '⏳ Refreshing tools…',
    unchecked: 'Not checked',
    gov_stages_title: 'The Eight Stage Rites', gov_proven: 'Proven', gov_of: 'of', gov_next_stage: '• Next stage',
    gov_gates_title: 'The Eight Release Gates', b_gates_check: 'Check gates now',
    gov_usage_title: 'Usage',
    gov_usage_note: 'Unknown cost is reported as a <b>count</b> of calls with unknown cost — cost is never guessed.',
    gov_privacy_title: 'Privacy & connection log', gov_s_privacy: 'Privacy policy', gov_s_connections: 'Connection log',
    gov_eval_title: 'Self-evaluation', gov_s_weakness: 'Observed weaknesses', gov_s_proposals: 'Proposals',
    gov_quarantine_title: 'Quarantine', gov_audit_title: 'Audit integrity',
    gov_relations_title: 'Coverage of the nine relation kinds', b_rel_infer: 'Infer relations',
    gov_rollback_title: 'Rollback', b_rb_verify: 'Prove rollback',
    err_stages: '⚠ Failed to load stages:', failed_short: 'Failed', stages_done: 'Complete ✓', stages_incomplete: 'Incomplete',
    proven_l: 'Proven', locked_l: 'Locked', b_prove: 'Prove with evidence', opens_after_prev: 'Unlocks after the previous stage',
    gates_hint: 'Press "Check gates now" to run the deterministic check', passed_l: 'Passed', failed_l: 'Failed',
    gate_rollback_note: '— proven by code, not by claims', not_checked_session: 'Not checked in this session',
    check_failed: 'Check failed', err_gates: '⚠ Gates check failed:', release_ok: 'Release allowed', release_no: 'Release blocked',
    gates_all_pass: 'All gates passed', gates_failed_list: 'Failed gates ({n}): {list}',
    rollback_desc: '— rollback drill: change → snapshot → revert → matching read',
    err_usage: '⚠ Failed to load usage:', u_calls: 'Calls', u_prompt: 'Prompt tokens', u_completion: 'Completion tokens',
    u_known: 'Known cost', u_unknown: 'Unknown-cost calls (count)',
    err_privacy: '⚠ Failed to load privacy policy:', allowed: 'Allowed', forbidden: 'Forbidden',
    no_privacy_notice: 'No privacy notice', url_word: 'URL',
    err_connections: '⚠ Failed to load connection log:', no_connections: 'No external connections recorded',
    ext_connection: 'External connection', res_fail: 'Failed', res_ok: 'OK',
    err_eval: '⚠ Failed to load self-evaluation:', ev_scope: 'Scope', ev_tasks: 'Tasks', ev_done: 'Done', ev_failed: 'Failed',
    ev_blocked: 'Blocked', ev_pending: 'Pending', ev_rate: 'Success rate', ev_avgdur: 'Avg duration (s)',
    ev_noev: 'Tasks without tool evidence', ev_noev_pct: 'Without evidence %', ev_retried: 'Retried tasks', ev_mcp: 'MCP tools needing approval',
    threshold_word: 'Threshold:', no_weakness: 'No observed weaknesses',
    prop_accepted: 'Accepted', prop_rejected: 'Rejected', prop_passed: 'Trialed & outperformed', prop_trialed: 'Trialed', prop_notried: 'No trial yet',
    why_forbidden: 'Forbidden proposal — safety-relevant', why_notried: 'No approval before trial — not trialed yet',
    why_failed: 'Trial did not outperform the baseline — approval blocked',
    acceptance_word: 'Acceptance criteria:', impact_word: 'Impact:', trial_delta: '• Trial delta:',
    b_accept: 'Approve', b_reject: 'Reject', tt_accept: 'Approve proposal', tt_reject: 'Reject proposal', tt_no_decide: 'No decision before trial',
    no_proposals: 'No proposals right now',
    err_quarantine: '⚠ Failed to load quarantine:', q_total: 'Total', q_open: 'Open', q_cleared: 'Cleared', q_scanned: 'Scanned',
    q_unscanned: 'Unscanned', q_isolations: 'Isolations', no_quar_rows: 'No rows in quarantine now',
    ph_q_reason: 'Reason to clear quarantine (required)', b_q_clear: 'Clear quarantine',
    verify_failed: 'Verification failed', unexpected: 'unexpected response', audit_ok: 'Audit log intact ✓', audit_broken: 'Audit log broken ✖',
    a_lines: 'Lines', a_hashed: 'Hashed from', a_unhashed: 'Unhashed', a_dbrows: 'DB rows', a_broken_at: 'Broken at',
    err_relations: '⚠ Failed to load relation coverage:', kind_present: 'Present', kind_missing: 'Missing', kind_untracked: 'Untracked',
    // أنواع العناصر في لوحة الخريطة (كانت غائبة ⇒ الاسم العربي يظهر بالإنجليزية)
    kind_project: 'Project', kind_document: 'Document', kind_repo: 'Repository', kind_file: 'File',
    kind_task: 'Task', kind_decision: 'Decision', kind_meeting: 'Meeting', kind_procedure: 'Procedure',
    kind_knowledge: 'Knowledge', kind_note: 'Note', kind_prd: 'PRD', kind_rfc: 'RFC', kind_adr: 'ADR',
    kind_spec: 'Spec', kind_design: 'Design', kind_plan: 'Plan', kind_risk: 'Risk', kind_question: 'Question',
    kind_reference: 'Reference', kind_state: 'State', kind_living_note: 'Living note', kind_doc: 'Document',
    rel_present: 'Present', rel_of: 'of', rel_legacy: 'Legacy:', rel_none: 'none',
    err_rollback: '⚠ Failed to load changes:', rb_total: 'Total', rb_reverted: 'Reverted', rb_pending: 'Pending',
    no_rb_changes: 'No pending changes to roll back', entity_word: 'entity', b_revert: 'Revert',
    not_proven: 'Not proven', err_rbproof: '⚠ Rollback proof failed:', rb_proven: 'Rollback proven ✓',
    prove_prompt: 'Evidence to prove stage "{s}" (required):', prove_default: 'Evidence: stage "{s}" runs on its real source and the database is built',
    evidence_required: 'Evidence is required — no proof without evidence', busy_prove: 'Proving…', err_prove: 'Failed to prove stage',
    proven_stage: 'Stage proven:', busy_check: 'Checking…',
    toast_gates_ok: 'Gates passed — release allowed', toast_gates_no: 'Release blocked — {n} failed gate(s)',
    busy_infer: 'Inferring…', err_infer: 'Inference failed', err_infer_full: 'Failed to infer relations',
    added_rels: '{n} relation(s) added', toast_inferred: 'Relations inferred — {n} added',
    err_revert: 'Rollback failed', toast_reverted: 'Change #{n} rolled back',
    q_prompt: 'A reason is required to clear quarantine of #{n} — type it to continue:', reason_required: 'Reason is required — quarantine not cleared',
    err_q_clear: 'Failed to clear quarantine', toast_q_cleared: 'Quarantine cleared for #{n}',
    no_trial: 'No approval before trial — no recorded trial for this proposal', err_decide: 'Failed to apply the decision',
    toast_accept: 'Proposal approved ✓', toast_reject: 'Proposal rejected', err_gov: '⚠ Failed to load governance screen:',
    health_prefix: 'health', state_prefix: 'mode:', session_goal: 'Agent session',
  agent_plan_steps: 'Plan', daemon_next: 'next sweep in', daemon_off: 'scheduler off', daemon_guard: 'watchdog up',
  daemon_guard_off: 'watchdog untracked', daemon_last_ok: 'last sweep ok', daemon_last_fail: 'last sweep failed', daemon_last_check: 'last sweep',
    g_nodes: 'items', g_link: 'links', no_map: '⚠ No map:', map_empty: 'Map is empty — add items',
    unit_tasks: 'tasks', unit_done: 'done', unit_failed: 'failed', unit_par: 'concurrency', unit_obj: 'objections', sec_unit: 's',
    no_runs: 'No runs', verdict_accepted: 'Accepted', verdict_rejected: 'Rejected', verdict_conditional: 'Conditional', verdict_empty: 'No runs',
    r_all_terminal: 'all tasks terminal', r_no_failures: 'no failures', r_evidence: 'every done task has evidence', r_verifier: 'verifier role ran', r_claims: 'claims verified',
    sev_high: 'Severe', sev_medium: 'Medium', no_objections: 'No objections',
    no_objections_body: 'Every finished task has tool evidence, and no claim lacks proof.',
    st_done: 'Done', st_failed: 'Failed', st_blocked: 'Blocked', ev_unit: 'evidence', no_evidence: 'no evidence',
    no_runs_hint: 'No runs yet — run the team from the Agents screen.',
    run_word: 'Run:', no_run_word: 'No run', note_word: 'Note', no_findings_yet: 'No findings yet', no_file_tasks: 'No tasks in the file',
    waiting: 'Waiting', role_word: 'Role', w_running: 'Running', tool_word: 'tool',
    w_done: 'Done', w_failed: 'Failed', w_blocked: 'Blocked', sum_result: 'Result:', sum_done: 'finished', sum_not: 'incomplete',
    sum_verdict: 'Verdict:', verified: 'Verified', unverified: 'Unverified', err_prefix: '⚠ Error:',
    no_sessions_short: 'No sessions',
    par_on: 'Parallel mode on — the goal will be split across roles', par_off: 'Parallel mode off',
    thinking: '⏳ Thinking…', no_reply: '(no reply)', error_word: 'error', conn_fail: '⚠ Could not reach the agent:',
    finished_sources: 'Done — {n} sources',
    unset: 'Unspecified',
    conf_unknown_tag: 'confidence-unknown', conf_low_tag: 'confidence-unconfirmed', bayn_data: 'data', bayn_tag: 'data kind',
    conf_origin: 'Origin', conf_label: 'Confidence', conf_extracted: 'Extracted', conf_not_recorded: 'not recorded',
    conf_unknown: 'confidence unspecified', conf_unconfirmed: 'confidence unconfirmed', rel_in: 'incoming', rel_out: 'outgoing',
    no_relations: 'No relations recorded for this item', conf_avg: 'avg confidence', rel_units: 'relations',
    lang_toggle_title: 'English / العربية',
    l_emb_model: 'Embedding model',
    l_emb_base: 'Embedding base URL', l_emb_key: 'Embedding API key', l_rerank: 'Rerank', l_topk: 'Top K',
    /* ── Add a source (＋ new) — 2026-10-27: the user hands a source, not a type ── */
    
    src_tab_quick: 'Quick text',
    
    ph_quick_text: 'The text you want to become knowledge…',
    src_folder_hint: 'Classification preview shows what will be imported without writing — then “Import now” really writes.',
    src_preview_btn: 'Preview classification', 
    
    
    src_total: 'Total files', src_by_kind: 'Kind',
    src_sample: 'First 30 files', src_col_path: 'Path', src_col_kind: 'Kind', src_col_size: 'Size',
    src_preview_empty: 'No importable files at this path.', src_created: 'created', src_skipped: 'skipped',
    src_quarantined: 'quarantined', src_relations: 'relations added', src_scanned: 'scanned', src_files_unit: 'file(s)',
    src_saved_hint: 'The original is stored and the fingerprint recorded — a repeated import creates no second copy (§19).',
    src_need_path: 'Type a path first.', 
    src_busy_preview: 'Classifying…', busy_save: 'Saving…',
    /* ── Smart linking (＋ link) — the agent suggests, the user approves ── */
    link_ph_search: 'Search an item by title…', link_pick_hint: 'Pick an item and the agent reads its real similarity.',
    link_suggest_title: 'Agent suggestions', link_approve: 'Approve selected', link_confidence: 'Confidence',
    link_philosophy: 'The agent suggests from real similarity (tags/links/terms) and the decision is yours — every relation is recorded with origin, confidence and time (§7).',
    link_loading: 'Reading similarity…', link_none: 'No suggestions for this item — try another one.',
    link_select_first: 'Pick an item first.', link_approve_none: 'Select at least one suggestion.',
    link_approved_n: '{n} relation(s) approved', link_failed_n: '{m} failed',
    link_reason_tpl: 'Real similarity with “{title}” ({score} signal points: tags/links/term overlap)',
    /* ── Agent screen: scheduler, pulses, skills ── */
    advanced_word: 'Advanced', sched_title: 'Scheduled tasks',
    sched_hint: 'Goal + interval ⇒ the agent runs it on its own and logs each pulse. Results appear in the pulse log below.',
    sched_every_lbl: 'Every (hours)', sched_add: 'Add task', ph_sched_goal: 'A goal that runs without you… e.g. refresh project memory and summarize the new items',
    sched_pulse_every: 'Pulse every {n}h', sched_pulse_off: 'Global pulse off (0)', sched_every_unit: 'every {n} hours',
    sched_due: 'Due', sched_now: 'now', sched_last: 'Last run', sched_never: 'not yet',
    sched_disable: 'Disable', sched_enable: 'Enable', sched_remove: 'Remove', sched_run_now: 'Run now', sched_running: 'Running…',
    sched_empty: 'No scheduled tasks — add a goal that runs without you.', sched_confirm_remove: 'Remove this scheduled task?',
    sched_range_err: 'Task interval out of range (0.25..720h)',
    sched_added: 'Scheduled task added', sched_removed: 'Scheduled task removed',
    sched_on_word: 'Task enabled', sched_off_word: 'Task disabled', sched_done: 'Run finished',
    ticks_title: 'Pulse log', ticks_empty: 'No pulses logged yet — the first run will log one.',
    ticks_ok: 'ok', ticks_err: 'error', ticks_new: 'new', ticks_brief: 'brief', ticks_memory: 'memory',
    ticks_sched_runs: 'scheduled: {n}', ticks_ms: 'took',
    skills_title: 'Skills', skills_empty: 'No skills in the index.', skills_unit: 'skills',
    skills_col_name: 'Name', skills_col_desc: 'Description', skills_issue_h: 'Index issues',
    /* ── ⌘K: pinning + synonyms ── */
    pin_add: 'Pin', pin_remove: 'Unpin', pinned_word: 'Pinned'
  }
};

let LANG = 'ar';
function t(key) {
  const dict = T[LANG] || T.ar;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  if (Object.prototype.hasOwnProperty.call(T.ar, key)) return T.ar[key];
  return key;
}

/* ─────────────────────────── API layer ───────────────────────────── */
/* Every call is try/catch'd and returns JSON or {} on failure — never throws. */

/* §33/§34: رمز الجلسة المحلي — كل كتابة تحمله، والقراءة لا تحتاجه.
   يُجلب مرة واحدة من /api/session (يضبط كوكي httpOnly أيضاً) ثم يُخزَّن. */
let SESSION_TOKEN = null;
async function hdr() { const tk = await getSessionToken(); return tk ? { 'X-Cortex-Session': tk } : {}; }
async function getSessionToken() {
  if (SESSION_TOKEN) return SESSION_TOKEN;
  try {
    const r = await fetch('/api/session');
    const j = await r.json();
    if (j && j.token) SESSION_TOKEN = j.token;
  } catch (_) { /* القراءة لا تحتاج رمزاً */ }
  return SESSION_TOKEN;
}
// يُستدعى عند الإقلاع مبكراً
getSessionToken();

const API = {
  async _req(method, path, body) {
    try {
      const opts = { method, headers: {} };
      const tok = await getSessionToken();
      if (tok) opts.headers['X-Cortex-Session'] = tok;
      opts.credentials = 'same-origin';
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      const text = await res.text();
      let data = {};
      if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }
      if (!res.ok && data && typeof data === 'object' && !data.error) data.error = 'HTTP ' + res.status;
      return data;
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  },
  get(path) { return this._req('GET', path); },
  post(path, body) { return this._req('POST', path, body === undefined ? {} : body); },
  del(path, body) { return this._req('DELETE', path, body); },

  status() { return this.get('/api/status'); },
  dashboard() { return this.get('/api/dashboard'); },
  notes() { return this.get('/api/notes'); },
  note(id) { return this.get('/api/notes/' + encodeURIComponent(id)); },
  saveNote(payload) { return this.post('/api/notes', payload); },
  deleteNote(id) { return this.del('/api/notes/' + encodeURIComponent(id)); },
  tasks(project) { return this.get('/api/tasks' + (project ? '?project=' + encodeURIComponent(project) : '')); },
  healthHistory(project, limit) {
    const q = ['limit=' + encodeURIComponent(limit || 60)];
    if (project) q.push('project=' + encodeURIComponent(project));
    return this.get('/api/health/history?' + q.join('&'));
  },
  review(id) { return this.get('/api/review/' + encodeURIComponent(id)); },
  noteHistory(id) { return this.get('/api/note-history/' + encodeURIComponent(id)); },
  noteHistoryFile(id, file) {
    return this.get('/api/note-history/' + encodeURIComponent(id) + '/' + encodeURIComponent(file));
  },
  backlinks(id) { return this.get('/api/backlinks/' + encodeURIComponent(id)); },
  graph() { return this.get('/api/graph'); },
  links() { return this.get('/api/links'); },
  /* addLink القديم أُزيل (2026-10-27): الربط صار «ربط ذكي» عبر /api/links/suggest
     ثم /api/links/approve — لا ربط يدوي بلا مصدر ولا ثقة (§7). */
  /* ── إضافة مصدر: معاينة تصنيف بلا كتابة، ثم استيراد فعلي بثلاث طرق ── */
  importPreview(path) { return this.post('/api/import/preview', { path }); },
  importFolder(payload) { return this.post('/api/import/folder', payload); },
  importPath(payload) { return this.post('/api/import', payload); },
  importWeb(payload) { return this.post('/api/import/web', payload); },
  /* ── ربط ذكي: اقتراحات من التشابه الفعلي، والاعتماد بوابة التسجيل ── */
  linkSuggest(noteId) { return this.get('/api/links/suggest?noteId=' + encodeURIComponent(noteId)); },
  approveLink(payload) { return this.post('/api/links/approve', payload); },
  /* ── المجدول والمهارات والسجل ── */
  agentSchedule() { return this.get('/api/agent/schedule'); },
  agentScheduleAction(payload) { return this.post('/api/agent/schedule', payload); },
  agentTicks() { return this.get('/api/agent/ticks'); },
  skills() { return this.get('/api/skills'); },
  semanticSearch(q, activeNoteId, limit) {
    const p = ['q=' + encodeURIComponent(q), 'limit=' + encodeURIComponent(limit || 8)];
    if (activeNoteId) p.push('activeNoteId=' + encodeURIComponent(activeNoteId));
    return this.get('/api/semantic-search?' + p.join('&'));
  },
  pending() { return this.get('/api/agent/pending'); },
  sessions() { return this.get('/api/agent/sessions'); },
  findings() { return this.get('/api/agent/findings'); },
  settings() { return this.get('/api/settings'); },
  saveSettings(payload) { return this.post('/api/settings', payload); },
  retrievalStatus() { return this.get('/api/retrieval/status'); },
  rebuildIndex() { return this.post('/api/retrieval/rebuild', {}); },
  mcpInfo() { return this.get('/api/mcp-info'); },
  projectState(project) {
    const q = [];
    if (project) q.push('project=' + encodeURIComponent(project));
    q.push('lang=' + encodeURIComponent(LANG));
    return this.get('/api/project-state?' + q.join('&'));
  },
  livingNote(project) { return this.post('/api/project-state/living-note', { project: project || 'workspace' }); },
  startSession(payload) { return this.post('/api/agent/session/start', payload); },
  nextAction(payload) { return this.post('/api/agent/next-action', Object.assign({ lang: LANG }, payload || {})); },
  execute(mutations, project) { return this.post('/api/agent/execute', { mutations, project }); },
  rejectPending() { return this.post('/api/agent/pending/reject', {}); },
  summarize(content, noteId) { return this.post('/api/ai/summarize', { content, noteId }); },
  meetingActions(content) { return this.post('/api/ai/meeting-actions', { content }); },
  contradictions(noteId) { return this.post('/api/ai/contradictions', { noteId }); },
  models(payload) { return this.post('/api/ai/models', payload); },
  backup() { return this.post('/api/backup', {}); },
  exportProject(project, format) { return this.get('/api/export/project?project=' + encodeURIComponent(project || '') + '&format=' + encodeURIComponent(format || 'md')); },
  resolve(query) { return this.post('/api/resolve', { query }); },

  /* ── §42/§43/§45/§38/§26/§40: الحُكم — المراحل والبوابات والاستهلاك والتحسين ── */
  governance() { return this.get('/api/governance'); },
  stages() { return this.get('/api/stages'); },
  proveStage(stage, evidence) { return this.post('/api/stages/prove', { stage, evidence }); },
  gates() { return this.get('/api/gates'); },
  checkGates() { return this.post('/api/gates/check', {}); },
  usage() { return this.get('/api/usage'); },
  connections(limit) { return this.get('/api/connections' + (limit ? '?limit=' + encodeURIComponent(limit) : '')); },
  // lang يُمرَّر صراحةً: قالب الإشعار يولّد بلغة القارئ من الخادم
  privacyNotice() { return this.get('/api/privacy/notice?lang=' + encodeURIComponent(LANG || 'ar')); },
  quarantine(all) { return this.get('/api/quarantine' + (all ? '?all=1' : '')); },
  clearQuarantine(id, by, reason) { return this.post('/api/quarantine/clear', { id, by, reason }); },
  improve(scope) { return this.get('/api/improve' + (scope ? '?scope=' + encodeURIComponent(scope) : '')); },
  decideImprove(id, accept) { return this.post('/api/improve/decide', { id, accept }); },
  relationsCoverage() { return this.get('/api/relations/coverage'); },
  inferRelations() { return this.post('/api/relations/infer', {}); },
  rollbackChanges(limit) { return this.get('/api/rollback/changes' + (limit ? '?limit=' + encodeURIComponent(limit) : '')); },
  verifyRollback() { return this.post('/api/rollback/verify', {}); },
  revertChange(id, entity) { return this.post('/api/rollback/revert', { id, entity: entity || 'note' }); },
  auditVerify() { return this.get('/api/audit/verify'); },
  confidence(id) { return this.get('/api/confidence?id=' + encodeURIComponent(id)); }
};

/* ────────────────────────── toast + status ───────────────────────── */

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  // toast بصري فقط — انسخه إلى منطقة حيّة كي يسمعه قارئ الشاشة.
  const live = document.getElementById('a11y-live');
  if (live) live.textContent = msg;
  setTimeout(() => el.remove(), 3400);
}

/* تُظهر ما يعمل بالخلفية: موعد الفحص القادم، آخر نتيجة، وحال الحارس.
   كان هذان الخيطان يعملان بلا أي سطح — فيبدو النظام ساكناً أو متصرفاً من نفسه. */
function fmtGap(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h > 0) return LANG === 'en' ? h + 'h ' + m + 'm' : h + 'س ' + m + 'د';
  if (m > 0) return LANG === 'en' ? m + 'm' : m + 'د';
  return LANG === 'en' ? 'under a minute' : 'أقل من دقيقة';
}
function renderDaemon(d) {
  const el = $('status-daemon');
  if (!el) return;
  if (!d || !d.scheduler) { el.textContent = ''; return; }
  const sc = d.scheduler;
  const parts = [];
  if (sc.inFlight) parts.push(LANG === 'en' ? 'sweeping now…' : 'يفحص الآن…');
  else if (sc.nextAt && sc.nextInSec != null) parts.push(t('daemon_next') + ' ' + fmtGap(sc.nextInSec));
  else parts.push(t('daemon_off'));
  if (sc.lastTickAt) {
    const okMark = sc.lastOk === true ? '✓' : (sc.lastOk === false ? '✗' : '·');
    parts.push(okMark + ' ' + (sc.lastOk === false ? t('daemon_last_fail') : t('daemon_last_ok')));
  }
  parts.push(d.watchdog && d.watchdog.alive ? '🛡 ' + t('daemon_guard') : '🛡 ' + t('daemon_guard_off'));
  el.textContent = parts.join(' · ');
  /* حارس لغة (2026-11-06): كان النص عربياً دائماً — وحيداً بين جيرانه المحروسین */
  el.title = sc.lastError ? String(sc.lastError) : (sc.lastTickAt ? t('daemon_last_check') + ': ' + sc.lastTickAt : '');
}
function setStatus(connected, detail) {
  const badge = $('status-badge');
  if (!badge) return;
  badge.textContent = connected ? (detail || t('ready')) : (detail || '…');
  badge.classList.toggle('off', !connected);
  window.__cortexLastStatus = { connected: !!connected, detail: detail || '' };
}

/* ─────────────────────────── appearance ─────────────────────────── */

function loadUI() {
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem(LS_UI) || '{}') || {}; } catch (_) { ui = {}; }
  return {
    lang: ui.lang === 'en' ? 'en' : 'ar',
    fz: ['s', 'm', 'l', 'xl'].indexOf(ui.fz) >= 0 ? ui.fz : 'm',
    accent: ['amber', 'teal', 'violet'].indexOf(ui.accent) >= 0 ? ui.accent : 'amber'
  };
}

let UI = loadUI();

/* لغة الواجهة تتبع كل نداء إلى الخادم.
   عطل مُقاس (2026-11-09): رسائل يولّدها الخادم وتُترجَم عنده (الحُكم/المراحل/التحسين/
   الخصوصية) كانت تعود **عربية** في الواجهة الإنجليزية، لأن الخادم يحلّ اللغة من
   ?lang= أو من إعداداته ولا يعرف لغة الواجهة. الربط هنا في موضع واحد يغطي كل
   النداءات (الواجهة تستدعي fetch مباشرة في مواضع كثيرة). */
(function bindUiLangToApi() {
  if (typeof window === 'undefined' || window.__cortexLangBound) return;
  window.__cortexLangBound = true;
  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') {
        const u = new URL(input, location.origin);
        if (u.origin === location.origin && u.pathname.indexOf('/api/') === 0 && !u.searchParams.has('lang')) {
          u.searchParams.set('lang', UI && UI.lang === 'en' ? 'en' : 'ar');
          input = u.pathname + u.search + u.hash;
        }
      }
    } catch (_) { /* نداء كما هو */ }
    return orig(input, init);
  };
})();

function saveUI() {
  try { localStorage.setItem(LS_UI, JSON.stringify(UI)); } catch (_) { /* storage disabled */ }
}

function applyUI() {
  const root = document.documentElement;
  root.setAttribute('data-accent', UI.accent);
  root.setAttribute('data-fz', UI.fz);
  root.setAttribute('lang', UI.lang);
  root.setAttribute('dir', UI.lang === 'ar' ? 'rtl' : 'ltr');

  /* paint every segmented control (all matching elements, never the first only) */
  $$('[data-ui-accent]').forEach(b => b.classList.toggle('on', b.getAttribute('data-ui-accent') === UI.accent));
  $$('[data-ui-fz]').forEach(b => b.classList.toggle('on', b.getAttribute('data-ui-fz') === UI.fz));
  $$('[data-ui-lang]').forEach(b => b.classList.toggle('on', b.getAttribute('data-ui-lang') === UI.lang));
  /* زر اللغة العلوي أُزيل 2026-10-25 (قرار المستخدم): الترجمة مكانها الوحيد الإعدادات ← المظهر */
  // إعادة رسم الويدجت الديناميكية بلغة الجديدة فورًا (حُكم اللغة: لا شيء يبقى بلغة قديمة)
  try { if (typeof renderFindings === 'function') renderFindings(); } catch (_) {}
  document.title = t('title_app');
  $$('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
}

/* لغة الواجهة تُحفظ على الخادم أيضاً (لا في localStorage وحده).
   السبب: الخادم يولّد **محتوى يُخزَّن** (ملاحظات الوكيل، عناوين المهام، الفجوات).
   حين لا يعرف لغة الواجهة يكتبها بالعربية فتظهر عربية داخل «المعرفة» و«الخريطة»
   في الواجهة الإنجليزية (عطل مُقاس 2026-11-09).
   نُرسل الإعدادات الحالية كاملة ثم نبدّل ui.lang: الإرسال الجزئي يُدمج على
   الافتراضي فيمحو ما لم يُرسَل (هكذا ضاع مؤشر المزوّد سابقاً). */
async function persistUiLang(lang) {
  try {
    const cur = await API.settings();
    if (!cur || cur.error) return;
    const next = Object.assign({}, cur, { ui: Object.assign({}, cur.ui || {}, { lang: lang === 'en' ? 'en' : 'ar' }) });
    await API.saveSettings(next);
  } catch (_) { /* بلا شبكة: تبقى اللغة محلية */ }
}

function setLang(lang) {  UI = Object.assign({}, UI, { lang: lang === 'en' ? 'en' : 'ar' });
  LANG = UI.lang;
  saveUI();
  persistUiLang(UI.lang);
  applyUI();
  translateDom();
  if (S.activeNote) renderPreview(S.activeNote.content || '');
  renderSidebar();
  /* تبديل النصوص الثابتة + الاتجاه، ثم إبلاغ وحدة الرندر الحي (IIFE) لإعادة رسم
     كل الشاشات بمحتوى اللغة الجديدة — القوائم والمحتوى معاً */
  try { if (typeof document !== 'undefined' && document.body && document.body.__langRefresh) document.body.__langRefresh(); } catch (e) { /* noop */ }
  // حُكم اللغة: الرندرات الديناميكية تعاد فوراً بلغة الجديدة (بطاقات الفحص، قوالب الوكيل)
  try { if (typeof renderFindings === 'function') renderFindings(); } catch (e) { /* noop */ }
  /* المسودات (2026-11-06، تدقيق اللغة): كانت تُرسم مرة عند الإقلاع، فتبقى
     أزرارها («حفظ»/«إلغاء») عربية بعد التبديل إلى الإنجليزية — لأن markup
     الواجهة المولّد بـJS لا يحمل data-i18n فلا يمسّه translateDom. */
  try { if (typeof loadPending === 'function') loadPending(); } catch (e) { /* noop */ }
  /* منطقة التنبيهات تحتفظ بآخر رسالة: بعد تبديل اللغة تصبح رسالة بلغة أخرى — تُفرَّغ */
  try { const live = document.getElementById('a11y-live'); if (live) live.textContent = ''; } catch (e) { /* noop */ }
  /* الاستوديو: بطاقات الخط الزمني تحمل نصاً مركّباً (شارات/ملاحظات/أزرار) يُبنى
     وقت الرسم — فتبديل اللغة يعيد رسمها من السجل نفسه بلغة الواجهة الجديدة. */
  try {
    if (window.__studio) {
      if (S.runId) window.__studio.replayRun(S.runId, { force: true });
      window.__studio.renderLiveBar();
    }
  } catch (e) { /* noop */ }
  translateDom();
  /* الرندرات الحية غير متزامنة (fetch) — أعد الترجمة الثابتة بعد استقرارها */
  setTimeout(() => { try { translateDom(); } catch (e) { /* noop */ } }, 350);
  setTimeout(() => { try { translateDom(); } catch (e) { /* noop */ } }, 1400);
}

function translateDom() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  // خيارات <select> (بما فيها المولّدة ديناميكياً) — تُترجم عبر المفتاح أيضاً
  $$('option[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  $$('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  $$('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  /* aria-label (2026-11-06، تدقيق الواجهة): كان المحرّك يترجم النص وplaceholder
     وtitle فقط، فبقيت أسماء قارئ الشاشة عربية في الواجهة الإنجليزية — أي أن
     المستخدم يسمع «التنقل الرئيسي» و«هدف الوكيل» داخل واجهة إنجليزية.
     العطل كان في المحرّك لا في العناصر: لا سبيل لترجمة aria-label إطلاقاً. */
  $$('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
}

/* ─────────────────────── importance control ─────────────────────── */
/* عطل مُقاس 2026-10-24: الأزرار كانت تحمل قيماً **نصية** ("important") والقارئ يحوّلها
   Number() فتصير NaN ثم صفراً — فكل نقرات (عادي/مهم/حرِج) حفظت 0 ولا تمييز ظهر أبداً.
   الإصلاح: سلّم رقمي واحد 1=عادي · 3=مهم · 5=حرِج — متوافق مع حدود النظام القائمة
   (حساب الصحة والمبادرة يعدّان ≥3 «مهماً»، وعلامة المكتبة تعرض 3 كهرماني و≥4 أحمر). */

function setImportance(level) {
  let n = Number(level);
  if (!Number.isFinite(n)) n = 1;      // قيمة غير رقمية ⇒ عادي (لا صفر صامت)
  n = clamp(n, 0, 5);
  S.importance = n;
  $$('[data-ui-importance]').forEach(b => {
    b.classList.toggle('on', Number(b.getAttribute('data-ui-importance')) === n);
  });
  $$('#importance-input, #editor-importance-input').forEach(inp => { inp.value = String(n); });
}

function importanceFromInput() {
  /* مصدر واحد للحقيقة: حالة الواجهة. الحقول المخفية تبقى متزامنة للتوافق فقط. */
  const n = Number(S.importance);
  return Number.isFinite(n) ? clamp(n, 0, 5) : 1;
}

/* ─────────────────────────── markdown ───────────────────────────── */
/* escapeHtml is applied before ANY insertion — no raw HTML reaches the DOM. */

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
    `<span class="wikilink" data-wiki="${target}">${label || target}</span>`);
  s = s.replace(/(^|[\s(])@([\p{L}\p{N}_-]{2,20})/gu, '$1<span class="mchip">@$2</span>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function renderMd(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null, items = [], para = [], code = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(renderInline).join('<br/>')}</p>`); para = []; } };
  const flushList = () => {
    if (!list) return;
    out.push(`<ul${list === 'task' ? ' class="task-list"' : ''}>${items.join('')}</ul>`);
    list = null; items = [];
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    /* fenced code */
    if (code !== null) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushAll(); code = []; continue; }

    /* tables: | a | b |  then  |---|---| */
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const sep = lines[li + 1] || '';
      if (/^\s*\|[\s:\-|]+\|\s*$/.test(sep) && /-/.test(sep)) {
        flushAll();
        const cellsOf = s => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = cellsOf(line);
        const body = [];
        li += 2;
        while (li < lines.length && /^\s*\|.*\|\s*$/.test(lines[li])) { body.push(cellsOf(lines[li])); li++; }
        li--;
        out.push(`<table class="md-table"><thead><tr>${head.map(h => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flushAll(); const lvl = Math.min(heading[1].length, 4); out.push(`<h${lvl}>${renderInline(heading[2])}</h${lvl}>`); continue; }

    /* hr — must precede task/bullet so "---" is not eaten */
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr/>'); continue; }

    /* blockquote */
    if (/^\s*>\s?/.test(line)) {
      flushAll();
      const quote = [];
      while (li < lines.length && /^\s*>\s?/.test(lines[li])) { quote.push(lines[li].replace(/^\s*>\s?/, '')); li++; }
      li--;
      out.push(`<blockquote>${quote.map(q => renderInline(q)).join('<br/>')}</blockquote>`);
      continue;
    }

    /* task list ☐ / ☑ */
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      flushPara();
      if (list !== 'task') { flushList(); list = 'task'; }
      const done = task[1].toLowerCase() === 'x';
      items.push(`<li class="task-item${done ? ' done' : ''}"><span class="task-box">${done ? '☑' : '☐'}</span><span>${renderInline(task[2])}</span></li>`);
      continue;
    }

    /* bullet list */
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (list !== 'ul') { flushList(); list = 'ul'; }
      items.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    if (!line.trim()) { flushAll(); continue; }
    flushList();
    para.push(line);
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushAll();
  return `<div>${out.join('')}</div>`;
}

function bindWikilinks(root) {
  (root || document).querySelectorAll('.wikilink').forEach(el => {
    el.onclick = async () => {
      const target = String(el.getAttribute('data-wiki') || '').toLowerCase();
      const note = S.notes.find(n => n.id === target || (n.title || '').toLowerCase() === target);
      if (note) await openNote(note.id);
    };
  });
}

/* ─────────────────────────── data loading ───────────────────────── */

async function loadNotes() {
  const data = await API.notes();
  S.notes = (data && Array.isArray(data.notes)) ? data.notes : [];
  return S.notes;
}

async function loadDashboard() {
  S.dashboard = await API.dashboard();
  renderSidebar();
  return S.dashboard;
}

async function loadFindings() {
  const data = await API.findings();
  S.findings = (data && Array.isArray(data.findings)) ? data.findings : [];
  renderFindings();
  return S.findings;
}

function projectNames() {
  const set = new Set();
  S.notes.forEach(n => { const p = n.projectName || (n.fm && n.fm.project); if (p) set.add(p); });
  if (S.dashboard && S.dashboard.active && S.dashboard.active.project && S.dashboard.active.project.project) {
    set.add(S.dashboard.active.project.project);
  }
  return Array.from(set).sort();
}

function typeLabel(n) {
  if (!n) return '';
  const raw = (n.fm && n.fm.type) || (n.classification && n.classification.primaryType) || n.documentType || 'note';
  const key = 't_' + raw;
  return (T.ar[key] != null || T.en[key] != null) ? t(key) : raw;
}

function clsOf(n) {
  if (!n) return 'note';
  return (n.classification && n.classification.primaryType) || (n.fm && n.fm.type) || 'note';
}

function filteredNotes() {
  let list = S.notes;
  if (S.projectFilter) list = list.filter(n => (n.projectName || (n.fm && n.fm.project) || '') === S.projectFilter);
  // فلتر النص (العنوان + المحتوى القصير) — كان غائباً فبقيت المكتبة بلا بحث
  const q = String(S.libSearch || '').trim().toLowerCase();
  /* بحث هجين (2026-11-14): كان الفلتر نصياً على العنوان/المقتطف، بينما المحرّك
     يملك بحثاً دلالياً+معجمياً يستخدمه الوكيل ولوحة الأوامر فقط. الآن القائمة
     تستعمل نفس المحرّك: النتائج مرتّبة بالصلة، والفلتر النصي يبقى احتياطاً
     حين لا يعود شيء (أو أثناء الكتابة قبل وصول الرد). */
  if (q) {
    const rank = Array.isArray(S.libRank) ? S.libRank : [];
    if (rank.length) {
      const pos = new Map(rank.map((id, i) => [id, i]));
      list = list.filter(n => pos.has(n.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    } else {
      list = list.filter(n => {
        const hay = [n.title, n.projectName, ((n.fm && n.fm.tags) || []).join(' '), n.excerpt || n.snippet || ''].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
  }
  // فلتر النوع
  const ty = String(S.libType || '');
  if (ty) list = list.filter(n => {
    const t = String(clsOf(n) || n.type || '').toLowerCase();
    if (ty === 'doc') return !!n.isDocument || t === 'doc' || t === 'document';
    return t === ty;
  });
  return list;
}

/* ────────────────────────── sidebar render ─────────────────────── */

function renderSidebar() {
  const listEl = $('projects-list');
  if (listEl) {
    const projects = projectNames();
    let html = `<div class="tree-i${S.projectFilter ? '' : ' active'}" data-project=""><span class="dot"></span><span class="t">${escapeHtml(t('all_projects'))}</span><span class="n">${S.notes.length}</span></div>`;
    html += projects.map(p => {
      const count = S.notes.filter(n => (n.projectName || (n.fm && n.fm.project) || '') === p).length;
      return `<div class="tree-i${S.projectFilter === p ? ' active' : ''}" data-project="${escapeHtml(p)}"><span class="dot"></span><span class="t">${escapeHtml(p)}</span><span class="n">${count}</span></div>`;
    }).join('');
    listEl.innerHTML = html;
  }

  const libEl = $('library-list');
  if (libEl) {
    const notes = filteredNotes();
    if (!notes.length) {
      libEl.innerHTML = `<div class="hint" style="padding:6px 12px">${escapeHtml(t('no_results'))}</div>`;
    } else {
      /* group by knowledge kind, each heading labelled from the dictionary */
      const GROUPS = [
        { label: 'g_docs', match: n => !!n.isDocument && !['decision', 'task', 'meeting'].includes(clsOf(n)) },
        { label: 'g_decisions', match: n => clsOf(n) === 'decision' },
        { label: 'g_tasks', match: n => clsOf(n) === 'task' },
        { label: 'g_meetings', match: n => clsOf(n) === 'meeting' },
        { label: 'g_notes', match: n => !n.isDocument && !['decision', 'task', 'meeting'].includes(clsOf(n)) }
      ];
      libEl.innerHTML = GROUPS.map(g => {
        const items = notes.filter(g.match);
        if (!items.length) return '';
        return `<div class="tree-h">${escapeHtml(t(g.label))}<span class="n">${items.length}</span></div>` +
          items.map(n => {
            // شريحة الأهمية: تُرى بنظرة قبل فتح العنصر — سلّم 1/3/5: ≥4 حرِج (أحمر) · 3 مهم (كهرماني) · 1/2 بلا علامة
            const impN = Number((n.fm && n.fm.importance) || 0);
            const impChip = impN >= 4
              ? `<span class="imp-mark s-2" title="${escapeHtml(t('imp_critical'))}">◆</span>`
              : (impN === 3 ? `<span class="imp-mark s-1" title="${escapeHtml(t('imp_important'))}">◆</span>` : '');
            return `<div class="tree-i${S.activeNote && S.activeNote.id === n.id ? ' active' : ''}" data-id="${escapeHtml(n.id)}">
            <span class="dot"></span>
            ${impChip}
            <span class="t" title="${escapeHtml(n.title || n.id)}">${escapeHtml(n.title || n.id)}</span>
            <span class="n">${escapeHtml(typeLabel(n))}${n.updatedAt && shortDate(n.updatedAt) ? ' · ' + escapeHtml(shortDate(n.updatedAt)) : ''}</span>
          </div>`;
          }).join('');
      }).join('') || `<div class="hint" style="padding:6px 12px">${escapeHtml(t('no_results'))}</div>`;
    }
  }

  const entEl = $('entities-list');
  if (entEl) {
    const ents = (S.dashboard && Array.isArray(S.dashboard.topEntities)) ? S.dashboard.topEntities : [];
    entEl.innerHTML = ents.length
      ? ents.map(e => {
        const first = (e.noteIds && e.noteIds[0]) || '';
        return `<span class="cchip" data-note="${escapeHtml(first)}" title="${escapeHtml(t('open_note_hint'))}">${escapeHtml(e.name)} · ${(e.noteIds || []).length}</span>`;
      }).join('')
      : `<span class="cchip">${escapeHtml(t('no_entities'))}</span>`;
  }

  /* العدّاد: كان يُحدَّث فقط عند لمس فلتر ⇒ «0 / 0» و92 عنصراً في المكتبة */
  const cntEl = $('notes-count');
  if (cntEl) cntEl.textContent = filteredNotes().length + ' / ' + S.notes.length;

  const libTitle = $('library-title');
  if (libTitle) libTitle.textContent = S.projectFilter ? `${t('s_library')} — ${S.projectFilter}` : t('s_library');
}

/* ───────────────────────── note open / edit ─────────────────────── */

const AUTOSAVE_MS = 1600;
let autosaveTimer = null;
let dirty = false;
let lastSavedValue = '';

function editorIsDirty() { return dirty; }

async function openNote(id) {
  if (!id) return;
  if (editorIsDirty() && !confirm(t('ask_replace'))) return;
  const res = await API.note(id);
  if (!res || !res.note) { if (res && res.error) toast(res.error); return; }
  S.activeNote = res.note;
  lastSavedValue = res.note.body != null ? res.note.body : (res.note.content || '');
  dirty = false;
  paintNote();
  await Promise.all([loadContext(id), loadDashboard()]);
}

/* ── عارض الملفات (م27، 2026-10-29): قراءة فقط لملف على القرص — يُفتح من «المصادر»
   أو نقاط الدخول في شاشة المستودعات. الخادم يقرأ بنفس حماية الأدوات الخارجية
   (الجذور المسموحة تُفرض في resolveSafePath)، والواجهة تعرض نصاً خاماً فقط. ── */
async function openFileViewer(file) {
  const drawer = $('file-drawer'), body = $('file-body'), head = $('file-path');
  if (!drawer || !body) return;
  if (head) head.textContent = String(file || '');
  body.textContent = '…';
  drawer.classList.remove('hidden');
  const r = await API.get('/api/file?path=' + encodeURIComponent(file || ''));
  if (r && r.ok) {
    body.textContent = String(r.content || '') + (r.truncated ? '\n\n… (' + t('file_truncated') + ')' : '');
  } else {
    body.textContent = '⚠ ' + ((r && r.error) || t('failed'));
  }
}
window.__openFileViewer = openFileViewer;
function shortPath(p) { const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean); return parts.slice(-2).join('/'); }

function paintNote() {
  const n = S.activeNote;
  const emptyEl = $('empty-state');
  const docEl = $('doc');
  if (!n) {
    if (emptyEl) emptyEl.classList.remove('hidden');
    if (docEl) docEl.classList.add('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (docEl) docEl.classList.remove('hidden');

  const titleEl = $('note-title');
  if (titleEl) titleEl.value = n.title || n.id;
  const contentEl = $('note-content');
  if (contentEl) contentEl.value = lastSavedValue;

  const typeSel = $('type-select');
  if (typeSel) {
    const want = (n.fm && n.fm.type) || (n.classification && n.classification.primaryType) || 'note';
    typeSel.value = want;
    if (!Array.prototype.some.call(typeSel.options, o => o.value === want)) typeSel.value = 'note';
  }
  const projInput = $('project-input');
  if (projInput) projInput.value = n.projectName || (n.fm && n.fm.project) || '';
  setImportance(n.fm && typeof n.fm.importance === 'number' ? n.fm.importance : 1);
  updateDocMeta(n);

  const metaEl = $('note-meta-line');
  if (metaEl) {
    const kind = String(n.knowledgeKind || '');
    const src = String((n.fm && (n.fm.source || n.fm.url)) || '');
    const bits = [typeLabel(n)];
    if (n.documentType && n.documentType !== 'note') bits.push(n.documentType);
    if (n.projectName) bits.push(n.projectName);
    if (n.updatedAt) bits.push(String(n.updatedAt).slice(0, 10));
    let html = bits.filter(Boolean).map((x) => `<span>${escapeHtml(x)}</span>`).join('<span class="sep">•</span>');
    /* نوع المعرفة (المادة 6): المستنتج لا يجوز أن يبدو كالمعتمد */
    if (kind) html += `<span class="chip kk kk-${escapeHtml(kind)}" title="${escapeHtml(t('kk_hint'))}">${escapeHtml(t('kk_' + kind) || kind)}</span>`;
    if (src) html += `<span class="chip kk src" title="${escapeHtml(t('src_word') + ': ' + src)}">${escapeHtml(t('src_word'))} ⧉</span>`;
    metaEl.innerHTML = html;
  }

  renderPreview(lastSavedValue);
  /* الوضع يُطبَّق مع كل عنصر (2026-11-06): كان يُطبَّق مرة واحدة عند الإقلاع،
     فإذا تأخّر الإقلاع أو انقطع بقي المحرّر 74px والمعاينة 434px متراكبين. */
  setView(view === 'preview' ? 'preview' : 'edit');
  renderSidebar();
}

/* بادج التصنيف (2026-10-30): ملخص النوع·المشروع·الأهمية — والحقول اليدوية مخفية خلفه */
function updateDocMeta(note) {
  const el = $('doc-meta-summary');
  if (!el || !note) return;
  const impKey = (({ 5: 'imp_critical', 3: 'imp_important', 1: 'imp_normal' })[note.fm && note.fm.importance]) || 'imp_normal';
  const parts = [typeLabel(note), note.projectName || (note.fm && note.fm.project) || '', t(impKey)].filter(Boolean);
  el.textContent = parts.join(' · ');
}

function renderPreview(text) {
  const el = $('note-preview');
  if (el) el.innerHTML = renderMd(text);
}

async function saveActive(opts) {
  const o = opts || {};
  if (!S.activeNote || !S.activeNote.id) return;
  const titleEl = $('note-title'), contentEl = $('note-content'), typeSel = $('type-select'), projInput = $('project-input');
  const payload = {
    id: S.activeNote.id,
    title: (titleEl ? titleEl.value.trim() : '') || S.activeNote.title || S.activeNote.id,
    content: contentEl ? contentEl.value : lastSavedValue,
    type: typeSel ? typeSel.value : 'note',
    project: projInput ? projInput.value.trim() : '',
    importance: importanceFromInput()
  };
  const res = await API.saveNote(payload);
  if (res && res.error) { toast(res.error); return; }
  dirty = false;
  lastSavedValue = payload.content;
  if (res && res.note) S.activeNote = res.note;
  updateDocMeta(S.activeNote);
  if (!o.silent) toast(t('toast_saved'));
  await Promise.all([loadNotes(), loadDashboard()]);
}

function scheduleAutosave() {
  dirty = true;
  const ss = $('doc-save-state');
  if (ss) ss.textContent = t('saving_word');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    if (!S.activeNote) return;
    await saveActive({ silent: true });
    setStatus(true, t('autosave'));
    const st2 = $('doc-save-state');
    if (st2) st2.textContent = t('saved_word');
  }, AUTOSAVE_MS);
}

/* ───────────────────────── document context ────────────────────── */
/* Each of the 4 ctx columns gets real data OR a visible message — never silence. */

function ctxMsg(col, msg, isErr) {
  const el = $(col);
  if (el) el.innerHTML = `<div class="hint${isErr ? ' err' : ''}">${isErr ? '⚠ ' : ''}${escapeHtml(msg)}</div>`;
}
function setCount(id, n) {
  const el = $(id);
  if (el) el.textContent = String(n == null ? 0 : n);
}

async function loadContext(noteId) {
  const panels = $('ctx-panels');
  if (panels) panels.classList.remove('hidden');
  if (!noteId) {
    ['ctx-tasks', 'ctx-related', 'ctx-backlinks', 'ctx-history', 'ctx-confidence'].forEach(c => ctxMsg(c, t('open_note_hint')));
    return;
  }
  ctxMsg('ctx-tasks', t('none'));
  ctxMsg('ctx-related', t('none'));
  ctxMsg('ctx-backlinks', t('none'));
  ctxMsg('ctx-history', t('none'));
  ctxMsg('ctx-confidence', t('none'));

  const note = S.activeNote || {};
  const project = note.projectName || (note.fm && note.fm.project) || S.projectFilter || '';

  /* column headings keep the ctx_* keys in play and switch language live */
  const heads = { 'ctx-tasks': (project ? 'ctx_tasks' : 'ctx_tasks_all'), 'ctx-related': 'ctx_related', 'ctx-backlinks': 'ctx_backlinks', 'ctx-history': 'ctx_history', 'ctx-confidence': 'c_confidence', 'ctx-state': 'ctx_state' };
  Object.keys(heads).forEach(col => {
    const el = $(col);
    if (el) el.setAttribute('data-lbl', t(heads[col]));
  });

  /* 1) tasks — real project tasks */
  API.tasks(project).then(data => {
    if (data && data.error) return ctxMsg('ctx-tasks', data.error, true);
    const tasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
    const el = $('ctx-tasks');
    if (!el) return;
    el.innerHTML = tasks.length ? tasks.map(tk =>
      `<div class="ref" data-id="${escapeHtml(tk.note_id || '')}" title="${escapeHtml(t('open_note_hint'))}">
        <span class="chip${tk.status === 'done' ? ' done' : ''}">${tk.status === 'done' ? '☑' : '☐'}</span>
        <span class="t">${escapeHtml(tk.text || '')}</span>
        ${tk.owner ? `<span class="chip owner">@${escapeHtml(tk.owner)}</span>` : ''}
        ${tk.due ? `<span class="chip due">${escapeHtml(tk.due)}</span>` : ''}
      </div>`).join('') : `<div class="hint">${escapeHtml(t('no_tasks'))}</div>`;
  });

  /* 2) related — semantic neighbours */
  API.semanticSearch(note.title || noteId, noteId, 6).then(data => {
    if (data && data.error) return ctxMsg('ctx-related', data.error, true);
    const results = (data && Array.isArray(data.results)) ? data.results.filter(r => r.id !== noteId) : [];
    const el = $('ctx-related');
    if (!el) return;
    el.innerHTML = results.length ? results.map(r =>
      `<div class="ref" data-id="${escapeHtml(r.id)}"><span class="t">${escapeHtml(r.title || r.id)}</span><span class="chip">${Math.round((r.score || 0) * 100) / 100}</span></div>`
    ).join('') : `<div class="hint">${escapeHtml(t('no_related'))}</div>`;
  });

  /* 3) backlinks */
  API.backlinks(noteId).then(data => {
    if (data && data.error) return ctxMsg('ctx-backlinks', data.error, true);
    const bl = (data && Array.isArray(data.backlinks)) ? data.backlinks : [];
    const el = $('ctx-backlinks');
    if (!el) return;
    el.innerHTML = bl.length ? bl.map(b =>
      `<div class="ref" data-id="${escapeHtml(b.id)}"><span class="t">${escapeHtml(b.title || b.id)}</span></div>`
    ).join('') : `<div class="hint">${escapeHtml(t('no_backlinks'))}</div>`;
  });

  /* 4) history — disk snapshots */
  API.noteHistory(noteId).then(data => {
    if (data && data.error) return ctxMsg('ctx-history', data.error, true);
    const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
    setCount('ctx-history-count', entries.length);
    const el = $('ctx-history');
    if (!el) return;
    el.innerHTML = entries.length ? entries.slice(0, 12).map(f =>
      `<div class="ref" data-file="${escapeHtml(f)}"><span class="t">${escapeHtml(f.replace(/\.md$/, ''))}</span></div>`
    ).join('') : `<div class="hint">${escapeHtml(t('no_history'))}</div>`;
  });

  /* 5) confidence — §60/§40: نوع العلاقة + المصدر + درجة الثقة + وقت الاستخراج.
     درجة الثقة تُعرض فعلاً في الواجهة (رقم + نسبة) ولم تعد محفوظة فقط. */
  loadConfidenceInto('ctx-confidence', 'ctx-confidence-count', noteId);
}

async function loadSnapshot(file) {
  if (!S.activeNote) return;
  if (editorIsDirty() && !confirm(t('ask_replace'))) return;
  const snap = await API.noteHistoryFile(S.activeNote.id, file);
  if (snap && snap.error) { toast(snap.error); return; }
  const content = snap && (snap.content || snap.text || snap.body);
  if (!content) { toast(t('none')); return; }
  const el = $('note-content');
  if (el) el.value = content;
  renderPreview(content);
  bindWikilinks($('note-preview'));
  dirty = true;
  toast(t('snap_loaded'));
}

/* ─────────────────────────── graph view ────────────────────────── */

let graphData = { nodes: [], edges: [] };
let view = 'edit';

/* ────────────────────────── project state ──────────────────────── */

function stateProject() {
  const note = S.activeNote || {};
  return note.projectName || (note.fm && note.fm.project) || S.projectFilter || '';
}

async function renderState() {
  const project = stateProject();
  const [state, hist] = await Promise.all([
    API.projectState(project),
    API.healthHistory(project, 14)
  ]);

  /* section headings come from the dictionary so they switch with the language */
  const stepsHead = $('sp-actions');
  const gapsHead = $('sp-gaps');
  const tasksHead = $('sp-tasks');
  const barsHead = $('sp-healthbars');
  if (stepsHead) stepsHead.setAttribute('data-lbl', t('state_steps'));
  if (gapsHead) gapsHead.setAttribute('data-lbl', t('state_gaps'));
  if (tasksHead) tasksHead.setAttribute('data-lbl', t('state_open'));
  if (barsHead) barsHead.setAttribute('data-lbl', t('state_tl'));

  if (state && !state.error) {
    const health = $('sp-health');
    if (health) health.textContent = (state.healthScore != null ? state.healthScore + '%' : '—');
    const proj = $('sp-project');
    if (proj) proj.textContent = `${state.project || t('all_projects')} • ${t('st_items')}: ${state.noteCount}`;
    const sum = $('sp-summary');
    if (sum) sum.textContent = (state.summary || '').split('\n').slice(0, 2).join(' — ');

    const steps = $('sp-actions');
    if (steps) {
      const items = Array.isArray(state.nextActions) ? state.nextActions.slice(0, 4) : [];
      steps.innerHTML = items.length ? items.map(s =>
        `<div class="row"><span class="prio ${escapeHtml(s.priority || 'low')}"></span>${escapeHtml(s.text || '')}</div>`
      ).join('') : `<div class="hint">${escapeHtml(t('none'))}</div>`;
    }

    const gapsEl = $('sp-gaps');
    if (gapsEl) {
      const gaps = Array.isArray(state.gaps) ? state.gaps.slice(0, 4) : [];
      gapsEl.innerHTML = gaps.length ? gaps.map(g =>
        `<div class="row">${escapeHtml(g.message || '')}</div>`
      ).join('') : `<div class="hint">${escapeHtml(t('none'))}</div>`;
    }

    const tasksEl = $('sp-tasks');
    if (tasksEl) {
      const open = Array.isArray(state.openTasks) ? state.openTasks.slice(0, 6) : [];
      tasksEl.setAttribute('data-lbl', `${t('s_tasks_c')} (${(state.openTasks || []).length})`);
      tasksEl.innerHTML = open.length ? open.map(tk =>
        `<div class="row"><span>${escapeHtml(tk.text || '')}</span><span class="mono dim">${tk.owner ? '@' + escapeHtml(tk.owner) : ''}${tk.due ? ' · ' + escapeHtml(tk.due) : ''}</span></div>`
      ).join('') : `<div class="hint">${escapeHtml(t('no_tasks'))}</div>`;
    }
  } else {
    const err = (state && state.error) || 'error';
    ctxMsg('sp-actions', err, true);
    ctxMsg('sp-gaps', err, true);
    ctxMsg('sp-tasks', err, true);
    const health = $('sp-health');
    if (health) health.textContent = '—';
  }

  const bars = $('sp-healthbars');
  if (bars) {
    if (hist && hist.error) ctxMsg('sp-healthbars', hist.error, true);
    else {
      const items = (hist && Array.isArray(hist.history)) ? hist.history.slice(0, 12).reverse() : [];
      const maxScore = Math.max(30, ...items.map(h => Number(h.score) || 0));
      bars.setAttribute('title', t('hb'));
      bars.setAttribute('aria-label', t('hb'));
      bars.innerHTML = items.length ? items.map(h => {
        const v = Number(h.score) || 0;
        const px = Math.max(3, Math.round((v / maxScore) * 40));
        return `<span class="hbwrap" title="${escapeHtml(`${h.project} ${v}%`)}"><span class="bar" style="height:${px}px"></span><span class="n">${v}%</span><span class="n">${String(h.at || '').slice(5, 10)}</span></span>`;
      }).join('') : `<span class="hint mono">${escapeHtml(t('none'))}</span>`;
    }
  }

  /* living-note refresh lives in the state pane footer */
  const livingBtn = $('living-note-btn');
  if (livingBtn) livingBtn.setAttribute('title', t('living_inline'));
}

/* ─────────────────────────── views ─────────────────────────────── */

function setView(mode) {
  view = mode;
  $$('#editor-tabs .vpill').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === mode));
  const stack = $('editor-stack');
  const spane = $('state-pane');
  // #graph-pane أُزيل مع تحوّل الخريطة إلى شاشة مستقلة (#view-graph/#filemap-root) —
  // كان المرجع المعلّق يكسر عقد الواجهة (سياسة «كل مرجع عنصر له عنصر»).
  const isGraph = mode === 'graph', isState = mode === 'state';
  // الخريطة صارت شاشة مستقلة؛ نوجّه عبر زر الشريط الحقيقي بدل مرجع عنصر محذوف.
  if (isGraph) { const btn = document.querySelector('#rail .rail-btn[data-view="graph"]'); if (btn) btn.click(); return; }
  if (spane) spane.classList.toggle('hidden', !isState);
  if (stack) {
    stack.classList.toggle('hidden', isGraph || isState);
    stack.classList.toggle('mode-split', mode === 'split');
  }
  if (isGraph) { loadGraph(); return; }
  if (isState) { renderState(); return; }
  const contentEl = $('note-content');
  const previewEl = $('note-preview');
  if (contentEl) contentEl.classList.toggle('hidden', mode === 'preview');
  if (previewEl) previewEl.classList.toggle('hidden', mode === 'edit');
  renderPreview(contentEl ? contentEl.value : (S.activeNote ? S.activeNote.content : ''));
}

/* ─────────────────────────── palette ⌘K ────────────────────────── */

let paletteIndex = 0;
let paletteSearchTimer = null;
let paletteItems = [];
let paletteShown = [];

/* ── §اللوحة: مرادفات عربي/إنجليزي + تثبيت الصفوف (قرار 2026-10-27) ──
   العطل المُقاس: كتابة «add» أو «link» بالعربية الواجهة لا تجد أمر «إضافة/ربط»،
   وكتابة «مهمة» لا تجد شيئاً بالإنجليزية. القاموس ثنائي الاتجاه: أي مصطلح في
   الصف يوسّع نفسه بمرادفه قبل المطابقة — لا مطابقة نصية سطحية.
   والتثبيت في localStorage (cortex.pinnedCommands): الصفوف المثبتة أولاً. */
const PALETTE_SYN = [
  ['إضافة', 'add'], ['جديدة', 'new'], ['مصدر', 'source'], ['استيراد', 'import'], ['تصدير', 'export'],
  ['ربط', 'link'], ['علاقة', 'relation'], ['علاقات', 'relations'], ['مهمة', 'task'], ['مهام', 'tasks'],
  ['بحث', 'search'], ['خريطة', 'map'], ['خريطة', 'graph'], ['وكيل', 'agent'], ['وكلاء', 'agent'],
  ['إعدادات', 'settings'], ['مراقبة', 'monitor'], ['جدولة', 'schedule'], ['مجدولة', 'scheduled'],
  ['نبض', 'pulse'], ['مهارة', 'skill'], ['مهارات', 'skills'], ['حالة', 'state'], ['نسخة', 'backup'],
  ['حكم', 'governance'], ['حُكم', 'governance'], ['مستودع', 'repo'], ['مزود', 'provider'],
  ['أداة', 'tool'], ['أدوات', 'tools'], ['فهرس', 'index'], ['ملاحظة', 'note'], ['مستند', 'doc'],
  ['قرار', 'decision'], ['مشروع', 'project'], ['اجتماع', 'meeting'], ['إجراء', 'procedure'],
  ['نص', 'text'], ['رابط', 'url'], ['مجلد', 'folder'], ['ملف', 'file'], ['مشروع', 'repo']
];

/* توسيع النص بمرادفاته: «إضافة مصدر» ⇒ add/source، و«Add a source» ⇒ إضافة/مصدر */
function paletteSynExpand(s) {
  const low = String(s == null ? '' : s).toLowerCase();
  let out = low;
  for (const pair of PALETTE_SYN) {
    const ar = String(pair[0]).toLowerCase();
    const en = String(pair[1]).toLowerCase();
    if (low.indexOf(ar) !== -1 && out.indexOf(en) === -1) out += ' ' + en;
    if (low.indexOf(en) !== -1 && out.indexOf(ar) === -1) out += ' ' + ar;
  }
  return out;
}

const PALETTE_PIN_KEY = 'cortex.pinnedCommands';
function loadPalettePins() {
  try {
    const a = JSON.parse(localStorage.getItem(PALETTE_PIN_KEY) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
  } catch (_) { return []; }
}
let PALETTE_PINS = loadPalettePins();
function savePalettePins() { try { localStorage.setItem(PALETTE_PIN_KEY, JSON.stringify(PALETTE_PINS)); } catch (_) {} }
function isPalettePinned(id) { return PALETTE_PINS.indexOf(String(id)) !== -1; }
function togglePalettePin(id) {
  const key = String(id || '');
  if (!key) return;
  PALETTE_PINS = isPalettePinned(key) ? PALETTE_PINS.filter(x => x !== key) : PALETTE_PINS.concat([key]);
  savePalettePins();
  renderPalette();
}

function fixedCommands() {
  return [
    { id: 'cmd:source', kind: 'cmd', label: t('b_add_item'), hint: '', run: openNewModal },
    { id: 'cmd:import', kind: 'cmd', label: t('s_import_file'), hint: '', run: openImportView },
    { id: 'cmd:link', kind: 'cmd', label: t('link_title'), hint: '', run: openLinkModal },
    { id: 'cmd:graph', kind: 'cmd', label: t('v_graph'), hint: '', run: () => setView('graph') },
    { id: 'cmd:state', kind: 'cmd', label: t('v_state'), hint: '', run: () => setView('state') },
    { id: 'cmd:living', kind: 'cmd', label: t('b_living'), hint: '', run: doLivingNote },
    { id: 'cmd:backup', kind: 'cmd', label: t('b_backup'), hint: '', run: doBackup },
    { id: 'cmd:export', kind: 'cmd', label: t('b_export_project'), hint: t('export_hint'), run: doExportProject },
    { id: 'cmd:rebuild', kind: 'cmd', label: t('b_rebuild'), hint: '', run: doRebuild },
    { id: 'cmd:extract', kind: 'cmd', label: t('extract_btn'), hint: '', run: doExtractActions },
    { id: 'cmd:contra', kind: 'cmd', label: t('g_contr'), hint: '', run: doContradictions },
    { id: 'cmd:settings', kind: 'cmd', label: t('settings_title'), hint: '', run: openSettings },
    { id: 'cmd:mcp', kind: 'cmd', label: t('mcp_title'), hint: '', run: openMcp },
    { id: 'cmd:sessions', kind: 'cmd', label: t('sessions_title'), hint: '', run: openSessions },
    { id: 'cmd:all', kind: 'cmd', label: t('all_projects'), hint: '', run: () => setProjectFilter('') }
  ];
}

/* مصدر واحد للمطابقة: النص الظاهر + المرادفات (عربي/إنجليزي في الاتجاهين) */
function paletteMatches(it, q) {
  if (!q) return true;
  return paletteSynExpand(it.label + ' ' + (it.hint || '') + ' ' + (it.id || '')).indexOf(q) !== -1;
}

function buildPaletteItems(query) {
  const q = query.trim().toLowerCase();
  const cmds = fixedCommands().filter(c => paletteMatches(c, q));
  const notes = S.notes
    .map(n => ({
      id: 'note:' + n.id,
      kind: 'note',
      label: n.title || n.id,
      hint: `${n.projectName || ''} • ${typeLabel(n)}`.replace(/^ • /, ''),
      run: () => openNote(n.id)
    }))
    .filter(n => paletteMatches(n, q));
  /* semantic hits (arrive after the 220ms debounce) match by meaning, not text */
  const localTitles = new Set(notes.map(n => n.label));
  const semantic = (S.paletteSemantic || [])
    .filter(id => S.notes.some(n => n.id === id))
    .map(id => {
      const n = S.notes.find(x => x.id === id);
      return (n && !localTitles.has(n.title || n.id)) ? {
        id: 'note:' + n.id,
        kind: 'note',
        label: n.title || n.id,
        hint: `${n.projectName || ''} • ${t('ctx_related')}`.replace(/^ • /, ''),
        run: () => openNote(n.id)
      } : null;
    }).filter(Boolean);
  return q ? [...notes, ...semantic, ...cmds] : [...notes.slice(0, 6), ...cmds];
}

function renderPalette() {
  const input = $('palette-input');
  const q = input ? input.value : '';
  paletteItems = buildPaletteItems(q);
  const pinned = paletteItems.filter(it => isPalettePinned(it.id));
  const rest = paletteItems.filter(it => !isPalettePinned(it.id));
  paletteShown = pinned.concat(rest);       // المثبتة أولاً دائماً — ثم الباقي بترتيبه
  paletteIndex = clamp(paletteIndex, 0, Math.max(0, paletteShown.length - 1));
  const box = $('palette-results');
  if (!box) return;
  /* دلالات combobox (وصولية، تدقيق 2026-11-11): التنقّل بالأسهم كان بصرياً فقط —
     لا دور ولا إعلان للمحدَّد، فقارئ الشاشة لا يعرف أن هناك نتائج ولا أيّها مختار. */
  const setActive = (i) => {
    if (input) {
      input.setAttribute('aria-expanded', 'true');
      if (i >= 0 && i < paletteShown.length) input.setAttribute('aria-activedescendant', `palette-opt-${i}`);
      else input.removeAttribute('aria-activedescendant');
    }
  };
  if (!paletteShown.length) {
    box.innerHTML = `<div class="empty-line">${escapeHtml(t('no_results'))}</div>`;
    if (input) { input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant'); }
    return;
  }
  const row = (it) => {
    const i = paletteShown.indexOf(it);
    const pin = isPalettePinned(it.id);
    const pinLabel = pin ? t('pin_remove') : t('pin_add');
    const sel = i === paletteIndex;
    return `<div class="pi${sel ? ' sel' : ''}" data-i="${i}" id="palette-opt-${i}" role="option" aria-selected="${sel ? 'true' : 'false'}">` +
      `<span class="t">${escapeHtml(it.label)}</span><span class="n">${escapeHtml(it.hint || '')}</span>` +
      `<button type="button" class="pi-star${pin ? ' on' : ''}" data-pin="${escapeHtml(it.id)}" title="${escapeHtml(pinLabel)}" aria-label="${escapeHtml(pinLabel)}">${pin ? '★' : '☆'}</button></div>`;
  };
  let html = '';
  if (pinned.length) html += `<div class="pi-group" role="presentation">${escapeHtml(t('pinned_word'))}</div>` + pinned.map(row).join('');
  html += rest.map(row).join('');
  box.innerHTML = html;
  setActive(paletteIndex);
}

/* ═══ إدارة تركيز موحّدة للنوافذ واللوحات ═══════════════════════════════════
   عطل وصولية مؤكد (تدقيق 2026-11-11): لا معالج `Tab` في الملف كله، و`aria-modal`
   في كل نافذة كان **وعداً كاذباً**: Tab يهرب إلى الخلفية، والإغلاق يُخفي العنصر
   فقط فيسقط التركيز إلى `<body>` ويضيع موضع المستخدم.
   القاعدة: عند الفتح نخزّن المُفتِّح ونحبس Tab داخل الحاوية؛ وعند الإغلاق نُعيده. */
const _focusTraps = new WeakMap();

function _focusables(container) {
  return [...container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.getClientRects().length > 0);
}

function trapFocus(container, opener = null) {
  if (!container || _focusTraps.has(container)) return;
  const previous = opener || document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = _focusables(container);
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  _focusTraps.set(container, { previous, onKey });
  const items = _focusables(container);
  if (items.length && !container.contains(document.activeElement)) items[0].focus();
}

function releaseFocus(container) {
  if (!container) return;
  const st = _focusTraps.get(container);
  if (!st) return;
  container.removeEventListener('keydown', st.onKey);
  _focusTraps.delete(container);
  if (st.previous && typeof st.previous.focus === 'function') {
    try { st.previous.focus(); } catch { /* العنصر لم يعد في DOM */ }
  }
}

/* يُركَّب مرة واحدة عند الإقلاع: يتابع ظهور/إخفاء كل نافذة `[role=dialog]` وكل
   لوحة جانبية، فيحبس التركيز عند الفتح ويُعيده عند الإغلاق — بلا لمس أي موقع
   فتح/إغلاق قائم (كلها تعمل بإضافة/إزالة صنف `hidden`). */
function installFocusTraps() {
  const targets = [...document.querySelectorAll('[role="dialog"], .drawer')];
  for (const el of targets) {
    const sync = () => {
      if (el.classList.contains('hidden')) releaseFocus(el);
      else trapFocus(el);
    };
    try { new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] }); } catch { /* بيئة قديمة */ }
    if (!el.classList.contains('hidden')) trapFocus(el);
  }
}

function openPalette() {
  const el = $('palette');
  if (!el) return;
  el.classList.remove('hidden');
  const input = $('palette-input');
  paletteIndex = 0;
  trapFocus(el);
  if (input) { input.value = ''; input.focus(); }
  renderPalette();
}

function closePalette() {
  const el = $('palette');
  if (!el) return;
  el.classList.add('hidden');
  const input = $('palette-input');
  if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  releaseFocus(el);
}

function paletteRun() {
  const it = paletteShown[clamp(paletteIndex, 0, Math.max(0, paletteShown.length - 1))];
  if (!it) return;
  closePalette();
  it.run();
}

function onPaletteInput() {
  const input = $('palette-input');
  const q = input ? input.value.trim() : '';
  paletteIndex = 0;
  renderPalette();
  if (paletteSearchTimer) clearTimeout(paletteSearchTimer);
  paletteSearchTimer = setTimeout(async () => {
    paletteSearchTimer = null;
    if (q.length < 2) return;
    const res = await API.semanticSearch(q, S.activeNote ? S.activeNote.id : '');
    if (res && res.error) return;
    S.paletteSemantic = ((res && res.results) || []).map(r => r.id);
    const cur = $('palette-input');
    if (!$('palette').classList.contains('hidden') && cur && cur.value.trim() === q) renderPalette();
  }, 220);
}

/* ─────────────────────────── resolver ──────────────────────────── */

/* أُزيل حقل «حلّ المقصود» من الواجهة (2026-10-30، نقد «حقل غامض مربك»): نفس الجملة
   («افتح المستند») تُقال للوكيل في المحادثة فيحلّها بأداة resolveReference نفسها — لا حقل تجربة. */

/* ─────────────────────────── agent panel ───────────────────────── */

function addBubble(role, text) {
  const box = $('chat-messages');
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'chat-bubble ' + role;
  div.innerHTML = (role === 'ai' || role === 'system')
    ? `<div class="md-block">${renderMd(text)}</div>`
    : escapeHtml(text).replace(/\n/g, '<br/>');
  bindWikilinks(div);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function addSources(sources) {
  if (!sources || !sources.length) return;
  const box = $('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'chat-bubble system';
  // مصدران: ملاحظة تُفتح بالنقر (data-id) وملف يُفتح في العارض (data-file) — م23/5 + م27
  div.innerHTML = `${escapeHtml(t('agent_sources'))}: ` + sources.map(s => (s && s.file)
    ? `<span class="ref" data-file="${escapeHtml(s.file)}"><span class="t">📄 ${escapeHtml(shortPath(s.file))}</span></span>`
    : `<span class="ref" data-id="${escapeHtml((s && s.id) || '')}"><span class="t">${escapeHtml((s && (s.title || s.id)) || '')}</span></span>`).join(' ');
  div.querySelectorAll('.ref').forEach(el => {
    if (el.getAttribute('data-file')) el.onclick = () => openFileViewer(el.getAttribute('data-file'));
    else el.onclick = () => openNote(el.getAttribute('data-id'));
  });
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setAgentContextLine() {
  const el = $('ai-context-line');
  if (!el) return;
  el.textContent = `${S.activeNote ? S.activeNote.title : t('none')} • ${S.projectFilter || stateProject() || t('none')}`;
}

/* أُزيلت ensureSession (2026-10-30 — تقرير فحص الشات): كانت تنشئ عند كل إقلاع جلسة
   فارغة باسم عام «جلسة وكيل» (تسرب في القائمة + أسماء لا تميّز). الجلسة الآن تُنشأ
   على الخادم من أول رسالة حقيقية — باسمها الصحيح — ومعرّفها يعود في run_started. */

function summarizeStepResult(r) {
  const s = r || {};
  if (s.message) return s.message;
  if (s.title) return s.title;
  if (s.summary) return String(s.summary).slice(0, 110);
  if (s.count != null) return s.count + ' ' + t('st_items');
  if (s.error) return '⚠ ' + s.error;
  return t('agent_planning');
}


/* خريطة نصوص الخادم المتصلبة → إنكليزي (find_gaps في cortex-core يصوغها عربياً/إنجليزياً داخلياً) */
const SERVER_TEXT_EN = [
    [/الملاحظة المهمة (.+?) غير مرتبطة بباقي المعرفة\.?/, 'Important note "$1" is not linked to the rest of the knowledge base.'],
    [/العنصر المهم "(.+?)" غير مرتبط بأي شيء\.?/, 'Important item "$1" is not linked to anything.'],
    [/^لا توجد ملاحظات مخاطر واضحة للمشروع\.$/, 'No explicit risk notes for this project.'],
    // (أُزيلت أنماط `^(.*)` الفضفاضة: كانت تلتهم أي نص ينتهي بعبارة مشابهة)
    [/^العنصر المهم "(.*)" غير مرتبط بأي شي/, 'Important item "$1" is not linked to anything.'],
    // (أُزيل `^(.*) غير مرتبطة$` — كان يطابق أي نص عربي وينتج «is unlinked»)
    // ── قوالب findGaps / buildNextActions (كانت تسرّب عربياً في وضع EN) ──
    [/^يوجد مشروع دون قرارات موثقة\.?$/, 'A project exists without documented decisions.'],
    [/^هناك مهام مفتوحة دون إجراءات أو runbook واضح\.?$/, 'There are open tasks without clear procedures or a runbook.'],
    // الأعمق أولاً: القالب البسيط يُترجم أولاً ثم القالب المحتوي عليه
    [/^وثّق أول قرار رئيسي للمشروع\s*(.*)$/, 'Record the project\u2019s first key decision $1'],
    [/^نفّذ أو قسم المهمة:\s*(.+)$/s, 'Execute or split the task: $1'],
    [/^أجب عن السؤال المفتوح: (.+)$/s, 'Answer the open question: $1'],
    [/^أنشئ ملاحظة مخاطر أساسية للمشروع\.?$/, 'Create a baseline risk note for the project.'],
    [/^راجع آخر مستند: (.+)$/, 'Review the latest document: $1'],
    [/^هناك (\d+) مهمة مفتوحة\.?$/, 'There are $1 open task(s).'],
    [/^العنصر الحالي غير مربوط بما يكفي\.?$/, 'The current item is not linked enough.'],
    [/^سؤال المستخدم: (.*)$/s, 'User question: $1'],
    [/^الملاحظة مهمة لكن بلا روابط\.?$/, 'Important note with no links.'],
    [/^يبدو أن بها قرارًا غير منظم/, 'It looks like it has an unorganized decision'],
    [/^يحتمل وجود مهام غير مستخرجة/, 'Some tasks may not be extracted'],
    [/^حوّل الملاحظة إلى نوع أوضح/, 'Turn the note into a clearer type'],
    [/^راجع التناقضات وأثبت القرار النهائي/, 'Review contradictions and record the final decision'],
    [/^أضف روابط \[\[wiki links\]\]/, 'Add [[wiki links]]'],
    [/^أنشئ ملاحظة حالة أو وثّق القرار التالي\.?$/, 'Write a state note or record the next decision.'],
    /* قوالب مستجدات الوكيل (2026-11-06): تُقاس حرفياً من cortex-agent.js:1250
       (stale) و:284 (create_note). عنوان العنصر داخل علامتي التنصيص يبقى كما
       كتبه المستخدم — بيانات لا واجهة. */
    [/^"(.+)" مهم ولم يُحدَّث منذ (\d+) يوم(?:ًا|اً)?$/, '"$1" is important and has not been updated for $2 day(s)'],
    [/إنشاء "(.+?)"/g, 'Create "$1"'],
  ];

/* ترجمة أعمق جزء: نصوص محفوظة تحوي قالباً داخل قالب.
   مثال حقيقي: «نفّذ أو قسم المهمة: نفّذ أو قسم المهمة: وثّق أول قرار…»
   القالب الداخلي يُترجم أولاً، ثم الخارجي — وإلا فشلت المطابقة من البداية. */
function serverTextDeep(s, depth = 0) {
  if (depth > 3) return s;
  let changed = false;
  for (const [re, rep] of SERVER_TEXT_EN) {
    const next = s.replace(re, rep);
    if (next !== s) { s = next; changed = true; }
  }
  // حاول ترجمة الذيل بعد أول نقطتين (قالب داخل قالب)
  const m = s.match(/^([^:]{2,60}):\s*(.+)$/s);
  if (m) {
    const tail = serverTextDeep(m[2], depth + 1);
    if (tail !== m[2]) { s = m[1] + ': ' + tail; changed = true; }
    // إن كان الذيل نفسه قالباً معروفاً، أعد المحاولة على السلسلة الجديدة
    for (const [re, rep] of SERVER_TEXT_EN) { const nx = s.replace(re, rep); if (nx !== s) { s = nx; changed = true; } }
  }
  return changed ? serverTextDeep(s, depth + 1) : s;
}

/* غطاء أخير لشاشة الحُكم: نصوص الخادم في هذه الشاشة تُصاغ بقوالب متغيّرة
   الترتيب يصعب مطابقتها شكلياً. هذه تعويضات **محصورة** على العبارات المقيسة
   فعلاً (لا تخمين ولا ترجمة آلية) — تُستدعى بعد serverFix. سببها المُثبت
   2026-10-20: بقيت 4 عبارات عربية داخل الواجهة الإنجليزية في gov-notice
   وgov-detail وحقول معيار القبول، فسقط تدقيق اللغة.
   قاعدة صيانة: أي عبارة جديدة هنا يجب أن تكون مقيسة من `/api/gates/check` أو
   من شاشة الحُكم الحيّة — لا تُضاف عبارات «احتياطية». */
const GOV_TAIL_EN = [
  /* معايير القبول الستة المولّدة في cortex-improve.js — تُقاس حرفياً من الملف
     (لا تخمين): 'كل مهمة مكتملة تحمل أثر أداة واحداً على الأقل'، 'نسبة النجاح
     ترتفع 10 نقاط مئوية على الأقل'، 'لا مهمة تتجاوز محاولتين…'، 'متوسط زمن
     المهمة ينخفض 20%…'، 'كل أداة MCP خارجية تُعيد ملخّص أثر قبل التنفيذ'. */
  [/كل مهمة مكتملة تحمل أثر أداة واحداً على الأقل/g, 'Every completed task carries at least one tool trace'],
  [/نسبة النجاح ترتفع (\d+) نقاط مئوية على الأقل/g, 'success rate rises by at least $1 percentage points'],
  [/لا مهمة تتجاوز محاولتين، وكل تكرار يحمل سبباً مسجّلاً/g, 'No task exceeds two attempts, and every retry carries a recorded reason'],
  [/متوسط زمن المهمة ينخفض (\d+)% على الأقل/g, 'Average task time drops by at least $1%'],
  [/كل أداة MCP خارجية تُعيد ملخّص أثر قبل التنفيذ/g, 'Every external MCP tool returns an effect summary before execution'],
  [/خارجية تُعيد ملخّص أثر/g, 'external returns an effect summary'],
  /* النصوص الفعلية المقيسة من /api/gates/check الحيّ (2026-10-20) — كلها بالحرف:
     «أُثبت التراجع عملياً على عنصر حقيقي»، «نسخة قابلة للاستعادة: … تحوي القاعدة
     (127 ملاحظة، 135 مهمة)»، «لا تعارضات مسجّلة»، «حجر سليم: 59 صفاً في الحجر
     بلا سبب مجهول»، «عزل سليم: لا معرّف يتجاوز مشروعه»، «انتقالات سليمة: كل
     حالات المهام مسموحة»، «لا تنفيذ مزدوج: مفاتيح idempotency فريدة». */
  [/أُثبت التراجع عملياً على عنصر حقيقي/g, 'Rollback proven on a real item'],
  [/نسخة قابلة للاستعادة:\s*/g, 'Restorable backup: '],
  [/تحوي القاعدة\s*/g, 'includes the database '],
  [/\((\d+)\s*ملاحظة،\s*(\d+)\s*مهمة\)/g, '($1 note(s), $2 task(s))'],
  [/لا تعارضات مسجّلة/g, 'No conflicts recorded'],
  [/حجر سليم:\s*(\d+) صفاً في الحجر بلا سبب مجهول/g, 'Quarantine OK: $1 row(s) with no unknown reason'],
  [/عزل سليم:\s*لا معرّف يتجاوز مشروعه/g, 'Isolation OK: no id crosses its project'],
  [/انتقالات سليمة:\s*كل حالات المهام مسموحة/g, 'Valid transitions: all task states allowed'],
  [/لا تنفيذ مزدوج:\s*مفاتيح idempotency فريدة/g, 'No double execution: idempotency keys are unique'],
  [/حدود الخصوصية\s*—\s*/g, 'Privacy boundaries — '],
  [/المزود/g, 'provider'], [/سحابي/g, 'cloud'], [/محلي/g, 'local'],
  [/نسبة النجاح ترتفع (\d+) نقاط/g, 'success rate rises by $1 points'],
  [/نسبة النجاح تصل إلى (\d+)/g, 'success rate reaches $1'],
  [/نسبة النجاح/g, 'success rate'],
  // الأطول أولاً: العبارة الكاملة قبل الأجزاء (وإلا استهلك الجزءُ القصير بقيةَ الجملة)
  [/(\d+) أداة MCP تحتاج تدخّلاً — المعاينة تقلّل التدخّل بلا مساس بأي حدّ/g,
   '$1 MCP tool(s) need attention — preview reduces intervention without touching any limit'],
  [/(\d+) أداة MCP تحتاج موافقة يدوية/g, '$1 MCP tool(s) need manual approval'],
  [/(\d+) أداة MCP تحتاج تدخّلاً/g, '$1 MCP tool(s) need attention'],
  [/أداة MCP تحتاج تدخّلاً/g, 'MCP tool needs attention'],
  [/(\d+) أداة MCP/g, '$1 MCP tool(s)'],
  [/(\d+) أدوات MCP/g, '$1 MCP tools'],
  [/بلا مساس بأي حدّ/g, 'without touching any limit'],
  [/المعاينة تقلّل التدخّل/g, 'preview reduces intervention'],
  [/المعاينة تقلّل التدخل/g, 'preview reduces intervention'],
  [/تقلّل التدخّل/g, 'reduces intervention'],
  [/تقليل التدخّل/g, 'reducing intervention'],
  [/(\d+) أداة MCP تحتاج موافقة يدوية/g, '$1 MCP tool(s) need manual approval'],
  [/أداة MCP/g, 'MCP tool'], [/أدوات MCP/g, 'MCP tools'],
  [/تحتاج تدخّلاً/g, 'need attention'], [/تحتاج موافقة يدوية/g, 'need manual approval'],
  [/المعاينة تقلّل التدخّل/g, 'preview reduces intervention'],
  [/\((\d+) نداء\)/g, '($1 call(s))'], [/نداءات/g, 'calls'], [/نداء/g, 'call'],
  [/لا ملف حرج غير ممسوح/g, 'no critical file left unscanned'],
  [/مُسح (\d+)\/(\d+) صفاً/g, 'scanned $1/$2 rows'],
  [/باقٍ (\d+) إجمالاً/g, '$1 remaining overall'],
  [/صفاً/g, 'rows'], [/مهمة/g, 'task'], [/مهام/g, 'tasks'],
  [/تشغيل/g, 'run'], [/الحجر/g, 'quarantine'], [/نقاط/g, 'points'],
];
function govTail(txt) {
  if (LANG !== 'en') return txt;
  let s = String(txt || '');
  if (!/[\u0600-\u06FF]/.test(s)) return s;   // لا عربي ⇒ لا عمل
  for (const [re, rep] of GOV_TAIL_EN) s = s.replace(re, rep);
  return s;
}

function serverText(txt) {
  if (LANG !== 'en') return txt;
  return serverTextDeep(String(txt || '').trim());
}


/* ═══ ترجمة نصوص الخادم الثابتة في شاشة الحُكم (تأتي عربية لا مفاتيح) ═══ */
const SRV_STAGE_NAMES = {
  'قاعدة المعرفة': 'Knowledge base',
  'العلاقات والخريطة': 'Relations & map',
  'الوكيل والمحادثة': 'Agent & chat',
  'بوابة النماذج': 'Model gateway',
  'التنفيذ': 'Execution',
  'MCP': 'MCP',
  'الاستقلال التشغيلي': 'Operational autonomy',
  'جاهزية الشركات': 'Enterprise readiness',
};
const SRV_GATE_NAMES = {
  'لا تجاوز صلاحيات': 'No privilege escape',
  'لا تنفيذ مزدوج': 'No double execution',
  'انتقالات حالة صحيحة': 'Valid state transitions',
  'عزل بيانات المشاريع': 'Project data isolation',
  'عزل الملفات غير الموثوقة': 'Untrusted file quarantine',
  'استعادة المهام المعلقة': 'Recover stuck tasks',
  'تعارض النتائج له مسار حل': 'Conflicts have resolution path',
  'اختبار التراجع المعتمد': 'Approved rollback test',
};
const SRV_GATE_DETAILS = {
  'لا تنفيذ مزدوج: مفاتيح idempotency فريدة': 'No double execution: unique idempotency keys',
  'انتقالات سليمة: كل حالات المهام مسموحة': 'Valid transitions: all task states allowed',
  'عزل سليم: لا معرّف يتجاوز مشروعه': 'Isolation OK: no identifier crosses its project',
  'لم يُقدَّم دليل التراجع': 'No rollback evidence provided',
  'أُثبت التراجع عملياً على عنصر حقيقي': 'Rollback proven on a real record',
};
const SRV_POLICY_NOTES = {
  'مرفوع افتراضياً — محلي أولاً، والفتح قرار صريح للمستخدم': 'Denied by default — local first; opening is your explicit choice',
  'إرسال الأسرار ممنوع': 'Sending secrets is forbidden',
  'أوامر التنفيذ لا تُرسل خارج الجهاز': 'Execution commands never leave the device',
};
/** يترجم نصاً من الخادم للإنكليزي إن أمكن؛ وإلا يعيده كما هو (لا نص وهمي) */
function serverFix(cls, text) {
  if (LANG !== 'en') return text;
  const s = String(text || '').trim();
  if (!s) return s;
  if (cls === 'stage') return SRV_STAGE_NAMES[s] || s;
  if (cls === 'gate') {
    if (SRV_GATE_NAMES[s]) return SRV_GATE_NAMES[s];
    if (SRV_GATE_DETAILS[s]) return SRV_GATE_DETAILS[s];
    let m = s.match(/^تجاوز صلاحيات: (\d+) ملف حرج غير ممسوح في الحجر$/);
    if (m) return 'Privilege escape: ' + m[1] + ' unscanned critical file(s) in quarantine';
    m = s.match(/^حجر سليم: (\d+) صفاً في الحجر بلا سبب مجهول$/);
    if (m) return 'Quarantine OK: ' + m[1] + ' row(s) with no unknown reason';
    m = s.match(/^استعادة سليمة: (\d+) مهمة running لها مسار requeue$/);
    if (m) return 'Recovery OK: ' + m[1] + ' running task(s) have a requeue path';
    m = s.match(/^تعذّر إثبات التراجع: (.+)$/);
    if (m) return 'Rollback not proven: ' + m[1];
    // ── أنماط إضافية فعلية من البوابات والتحسين والحجر ──
    // مطابقة بالبادئة (أكثر متانة من النص الكامل — الشرطات تختلف)
    if (s.startsWith('إرسال الأسرار ممنوع')) return 'Sending secrets is forbidden — no exception, no setting opens it';
    if (s.startsWith('أوامر التنفيذ لا تُرسل')) return 'Execution commands never leave the device';
    if (s.startsWith('لا تعارضات مسجّلة')) return 'No conflicts recorded';
    if (s.startsWith('محتوى مشبوه')) return 'Suspicious content';
    const mRate2 = s.match(/^نسبة النجاح ([\d.]+)% \((\d+) ناجحة، (\d+) فاشلة\)[^\d]*(\d+)%?/);
    if (mRate2) return 'Success rate ' + mRate2[1] + '% (' + mRate2[2] + ' passed, ' + mRate2[3] + ' failed) — minimum ' + mRate2[4] + (s.includes('%') ? '%' : '');
    const mRate3 = s.match(/^نسبة النجاح ([\d.]+)%[^\d]*(\d+) مهمة فاشلة/);
    if (mRate3) return 'Success rate ' + mRate3[1] + '% — ' + mRate3[2] + ' failed task(s) with no declared fix path';
    const mInj = s.match(/^محاولة توجيه الوكيل من محتوى مستورد \((\d+) مطابقة\)/);
    if (mInj) return 'Prompt-injection attempt from imported content (' + mInj[1] + ' match(es))';
    const fixed = {
      'لا تعارضات مسجّلة': 'No conflicts recorded',
      'محتوى مشبوه': 'Suspicious content',
      'إرسال الأسرار ممنوع — لا استثناء ولا إعداد يفتحه': 'Sending secrets is forbidden — no exception, no setting opens it',
      'أوامر التنفيذ لا تُرسل خارج الجهاز': 'Execution commands never leave the device',
    };
    if (fixed[s]) return fixed[s];
    m = s.match(/^نسبة النجاح ([\d.]+)% \((\d+) ناجحة، (\d+) فاشلة\) — الحد الأدنى (\d+)$/);
    if (m) return 'Success rate ' + m[1] + '% (' + m[2] + ' passed, ' + m[3] + ' failed) — minimum ' + m[4];
    m = s.match(/^نسبة النجاح ([\d.]+)% — (\d+) مهمة فاشلة بلا مسار تصحيح معلن$/);
    if (m) return 'Success rate ' + m[1] + '% — ' + m[2] + ' failed task(s) with no declared fix path';
    m = s.match(/^محاولة توجيه الوكيل من محتوى مستورد \((\d+) مطابقة\)$/);
    if (m) return 'Prompt-injection attempt from imported content (' + m[1] + ' match(es))';
    m = s.match(/^نسبة نجاح منخفضة$/);
    if (m) return 'Low success rate';
    /* ── أنماط فعلية مقيسة من شاشة الحُكم (2026-10-20) ──
       القياس الحيّ أظهر بقايا عربية في gov-detail/gov-name بالإنجليزية:
         «لا تجاوز: مُسح 0/0 صفاً، لا ملف حرج غير ممسوح (باقٍ 0 إجمالاً)»
         «لا مهام عالقة — لا شيء يحتاج استعادة»
         «حدود الخصوصية — المزود «…» (سحابي)»
         «أدوات MCP تحتاج تدخّلاً»
       هذه نصوص يولّدها الخادم (cortex-gates) ⇒ تُترجم هنا. المطابقة بالبادئة
       عمداً: الأرقام والتفاصيل تتغيّر بين تشغيل وآخر. */
    if (s.startsWith('لا تجاوز')) {
      const m2 = s.match(/(\d+)\/(\d+) صفاً/);
      const rest = s.match(/باقٍ (\d+) إجمالاً/);
      return 'No privilege escape: scanned ' + (m2 ? m2[1] + '/' + m2[2] : '?') +
        ' rows, no critical file left unscanned' + (rest ? ' (' + rest[1] + ' remaining overall)' : '');
    }
    if (s.startsWith('لا مهام عالقة')) return 'No stuck tasks — nothing needs recovery';
    if (s.startsWith('لا تنفيذ مزدوج')) return s.replace(/^لا تنفيذ مزدوج:\s*/, 'No double execution: ');
    if (s.startsWith('انتقالات سليمة')) return s.replace(/^انتقالات سليمة:\s*/, 'Valid transitions: ');
    if (s.startsWith('عزل سليم')) return s.replace(/^عزل سليم:\s*/, 'Isolation OK: ');
    if (s.startsWith('حجر سليم')) return s.replace(/^حجر سليم:\s*/, 'Quarantine OK: ');
    if (s.startsWith('استعادة سليمة')) return s.replace(/^استعادة سليمة:\s*/, 'Recovery OK: ');
    if (s.startsWith('حدود الخصوصية')) return s.replace(/^حدود الخصوصية\s*—\s*/, 'Privacy boundaries — ');
    if (s.startsWith('أدوات MCP تحتاج تدخّلاً')) return 'MCP tools need attention';
    if (s.startsWith('أدوات MCP')) return s.replace(/^أدوات MCP\s*/, 'MCP tools ');
    if (s.startsWith('مسار الاعتماد')) return s.replace(/^مسار الاعتماد\s*/, 'Approval path ');
    // «لا تجاوز: مُسح …» ⇒ تُرجم الرأس، لكن الذيل ما زال عربياً ⇒ نُكمل العبارات الفعلية.
    if (s.includes('مُسح') && s.includes('ملف حرج')) {
      const m2 = s.match(/(\d+)\/(\d+) صفاً/);
      const rest = s.match(/باقٍ (\d+) إجمالاً/);
      return 'No privilege escape: scanned ' + (m2 ? m2[1] + '/' + m2[2] : '?') +
        ' rows, no critical file left unscanned' + (rest ? ' (' + rest[1] + ' remaining overall)' : '');
    }
    if (s.startsWith('حدود الخصوصية')) {
      return s.replace(/^حدود الخصوصية\s*—\s*/, 'Privacy boundaries — ')
              .replace(/المزود/, 'provider').replace(/سحابي/, 'cloud');
    }
    m = s.match(/^(\d+) أداة MCP تحتاج موافقة يدوية \((\d+) نداء\)(.*)$/);
    if (m) return m[1] + ' MCP tool(s) need manual approval (' + m[2] + ' call(s))' + (m[3] ? ' — ' + m[3].replace(/التحسّن|التحسين/, 'improvement') : '');
    if (s.includes('أداة MCP') && s.includes('موافقة')) return s.replace(/أداة MCP/g, 'MCP tool').replace(/تحتاج موافقة يدوية/g, 'need manual approval').replace(/نداء/g, 'call');
    // «Acceptance criteria: نسبة النجاح ترتفع 10 نقاط» — معيار قبول يولّده الخادم
    return s
      .replace(/نسبة النجاح ترتفع (\d+) نقاط/, 'success rate rises by $1 points')
      .replace(/نسبة النجاح تصل إلى (\d+)/, 'success rate reaches $1')
      .replace(/لا حواف اعتماد في آخر تشغيل/, 'no approval edges in the last run')
      .replace(/لا مهام عالقة/, 'no stuck tasks')
      .replace(/لا شيء يحتاج استعادة/, 'nothing needs recovery')
      .replace(/بلا سبب مجهول/, 'with no unknown reason')
      .replace(/لا ملف حرج غير ممسوح/, 'no critical file left unscanned')
      .replace(/إجمالاً/, 'overall');
  }
  if (cls === 'policy') {
    if (SRV_POLICY_NOTES[s]) return SRV_POLICY_NOTES[s];
    if (s.startsWith('إرسال الأسرار ممنوع')) return 'Sending secrets is forbidden — no exception, no setting opens it';
    if (s.startsWith('أوامر التنفيذ')) return 'Execution commands never leave the device';
    if (s.startsWith('مرفوع افتراضياً')) return 'Denied by default — local first; opening is your explicit choice';
    return s;
  }
  return s;
}

/* (حُذفت قوالب/ترحيب شاشة الوكلاء 2026-10-27 مع توحيد سطح الوكيل:
   اللوحة الجانبية ✦ هي الوكيل الوحيد — وأزرار الأهداف فيها تغني عن القوالب.) */

async function agentRun(goal) {
  goal = String(goal || '').trim();
  if (!goal) { addBubble('system', t('agent_need_goal') || '➡️ اكتب هدفاً للوكيل أولاً — أو اختر قالباً جاهزاً بالأزرار.'); return; }
  if (S.agentBusy) return;
  const input = $('chat-input');
  if (input) input.value = '';
  S.agentBusy = true;
  const line = addBubble('system', t('agent_planning'));

  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await hdr()) },
      credentials: 'same-origin',
      body: JSON.stringify({
        goal,
        project: S.projectFilter || stateProject(),
        noteId: S.activeNote ? S.activeNote.id : '',
        sessionId: S.sessionId,
        lang: UI.lang,
        language: (S.settings && S.settings.agent && S.settings.agent.language) || 'auto',
        autonomy: (S.settings && S.settings.agent && S.settings.agent.autonomy) || 'supervised'
      })
    }).catch(() => null);

    if (!res) { if (line) line.remove(); addBubble('system', '⚠ ' + t('none')); return; }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream')) {
      const j = await res.json().catch(() => ({}));
      if (line) line.remove();
      addBubble('system', '⚠ ' + (j.error || ('HTTP ' + res.status)));
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', final = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const part = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!part.startsWith('data:')) continue;
        let msg = null;
        try { msg = JSON.parse(part.slice(5).trim()); } catch (_) { continue; }
        if (msg.type === 'agent_step') {
          const step = msg.step || {};
          if (line) line.textContent = step.thinking ? t('agent_planning') : `⚙️ ${step.tool || step.type || ''} → ${summarizeStepResult(step.result)}`;
        } else if (msg.type === 'agent_done') {
          final = msg.result;
        }
      }
    }
    if (line) line.remove();
    if (!final) { addBubble('system', '⚠ ' + t('none')); return; }
    if (final.error) { addBubble('system', '⚠ ' + final.error); return; }
    if (final.answer) addBubble('ai', final.answer);
    if (final.mutations && final.mutations.length) {
      addBubble('system', `${t('agent_done_mut')}: ${final.mutations.length}`);
    }
    addSources(final.sources);
    if (final.pending && final.pending.length) {
      addBubble('system', `${t('agent_done_mut')} (${final.pending.length})`);
    }
    const clean = !S.activeNote || !$('note-content') || $('note-content').value === lastSavedValue;
    await Promise.all([loadNotes(), loadDashboard()]);
    if (S.activeNote && clean) await openNote(S.activeNote.id);
    await loadPending();
  } catch (e) {
    if (line) line.remove();
    addBubble('system', '⚠ ' + (e && e.message ? e.message : String(e)));
  } finally {
    S.agentBusy = false;
  }
}

async function loadPending() {
  const data = await API.pending();
  const area = $('ai-pending-area');
  if (!area) return;
  const muts = (data && Array.isArray(data.mutations)) ? data.mutations : [];
  area.innerHTML = '';
  if (!muts.length) { try { if (window.__applyAgentTab) window.__applyAgentTab(); } catch (e) { /* تحسيني */ } return; }
  const card = document.createElement('div');
  card.className = 'fc';
  /* سطر المسودة = نص خادم + عنوان كتبه المستخدم بين علامتي تنصيص (2026-11-06).
     العنوان بيانات لا واجهة → يُعلَّم SPAN.t مثل كل عنوان عنصر في المنتج،
     والنص المحيط يمرّ على مترجم قوالب الخادم. */
  const draftLine = (m) => {
    const label = serverText(String(m.summary || (m.args && m.args.title) || ''));
    const marked = label.split('"').map((seg, i) => (i % 2 ? '<span class="t">' + escapeHtml(seg) + '</span>' : escapeHtml(seg))).join('"');
    return '<div style="margin:4px 0">⚙️ ' + escapeHtml(m.tool || m.type || 'mutation') + ' — ' + marked + '</div>';
  };
  card.innerHTML = `<div class="fk">${escapeHtml(t('agent_done_mut'))}</div>` +
    muts.map(m => draftLine(m)).join('') +
    `<div class="row gap" style="margin-top:8px">
       <button class="btn primary sm" data-act="approve">${escapeHtml(t('b_save'))}</button>
       <button class="btn ghost sm" data-act="reject">${escapeHtml(t('b_cancel'))}</button>
     </div>`;
  card.querySelector('[data-act="approve"]').onclick = async () => {
    const cleaned = await API.execute(muts, S.projectFilter || stateProject());
    if (cleaned && cleaned.error) { toast(cleaned.error); return; }
    card.remove();
    try { if (window.__applyAgentTab) window.__applyAgentTab(); } catch (e) { /* تحسيني */ }
    await Promise.all([loadNotes(), loadDashboard()]);
    toast(t('toast_saved'));
  };
    card.querySelector('[data-act="reject"]').onclick = async () => {
    await API.rejectPending();
    card.remove();
    try { if (window.__applyAgentTab) window.__applyAgentTab(); } catch (e) { /* تحسيني */ }
  };
  area.appendChild(card);
  try { if (window.__applyAgentTab) window.__applyAgentTab(); } catch (e) { /* تحسيني */ }
}

function renderFindings() {
  const btn = $('ai-open-btn');
  if (btn) {
    btn.innerHTML = S.findings.length
      ? `✦ ${escapeHtml(t('b_agent'))}<sup class="badge-n">${S.findings.length}</sup>`
      : `✦ ${escapeHtml(t('b_agent'))}`;
  }
  /* المستجدات خارج سطح المحادثة (2026-10-30 — شكوى المستخدم الحية «كل هذه الأوامر داخل الشات»):
     شريحة هادئة في الشريط السفلي تعرض العدد، والنقر يفتح اللوحة المستقلة. */
  const chip = $('findings-chip');
  if (chip) {
    chip.classList.toggle('hidden', !S.findings.length);
    chip.textContent = `⚡ ${S.findings.length}`;
  }
  const area = $('findings-body');
  if (!area) return;
  const labels = { gap: t('f_gap'), contradiction: t('f_contra'), note_contradiction: t('f_contra'), isolated: t('f_isolated'), stale: t('f_stale') };
  /* نصوص الخادم المتصلّبة (find_gaps في cortex-core) تُعرض بلغة الواجهة عبر مطابقة قوالبها المعروفة */
  
  area.innerHTML = S.findings.length
    ? S.findings.slice(0, 12).map(f =>
      `<div class="review-card sev-${escapeHtml(f.severity || 'medium')}">
         <div class="rh">${escapeHtml(labels[f.kind] || f.kind || '')}</div>
         <div>${renderInline(serverText(f.text || ''))}</div>
       </div>`).join('')
    : `<div class="hint dim">${escapeHtml(t('no_findings'))}</div>`;
  bindWikilinks(area);
}

/* شريط الخطوة التالية — زر فعلي يقترح ويعمل بنقرة (قرار دورة الأدوار: المحادثة) */
function setNextAction(text) {
  const bar = $('next-action-bar');
  const txt = $('next-action-text');
  if (!bar || !txt) return;
  const s = String(text || '').trim();
  if (!s) { bar.classList.add('hidden'); txt.textContent = ''; NEXT_ACTION = null; return; }
  NEXT_ACTION = s;
  txt.textContent = s.length > 140 ? s.slice(0, 140) + '…' : s;
  bar.classList.remove('hidden');
}
let NEXT_ACTION = null;

async function runNextAction() {
  if (NEXT_ACTION) {
    // اقتراح جاهز: نضعه في الخانة ونشغّله مباشرة — بنقرة واحدة.
    // التشغيل المباشر أضمن من click() لأن المعالج قد يُستبدل في مسارات أخرى.
    const inp = $('chat-input');
    /* §6/§8 — لا نُرسل نص الاقتراح كمهمة حرفياً.
       العطل المُثبت حيّاً 2026-10-20: إرسال النص كما هو جعل النظام ينشئ مهمة نصّها
       «نفّذ أو قسم المهمة: …»، ثم يقتبسها الاقتراح التالي داخله ⇒ تضخّم متكرّر
       («نفّذ أو قسم المهمة: نفّذ أو قسم المهمة: …» وُجد فعلاً في tasks).
       الصياغة الآن **هدفية**: نطلب التنفيذ لا نُعيد صياغة الاقتراح كعنوان مهمة. */
    const goal = String(NEXT_ACTION).replace(/^(نفّذ أو قسم المهمة|Execute or split the task):\s*/i, '').trim();
    if (inp) inp.value = goal;
    setNextAction('');
    if (typeof window.__runAgentStream === 'function') window.__runAgentStream(goal);
    else if (typeof runAgentStream === 'function') runAgentStream(goal);
    else if (typeof agentRun === 'function') agentRun(goal);
    return;
  }
  const res = await API.nextAction({
    project: S.projectFilter || stateProject(),
    noteId: S.activeNote ? S.activeNote.id : '',
    question: t('goal_next')
  });
  if (res && res.error) { addBubble('system', '⚠ ' + res.error); return; }
  addBubble('ai', `${t('best_next')}: ${res.text || t('none')}\n\n${res.reason || ''}`);
}

/* ─────────────────────────── modals ───────────────────────────── */

/* ═══ ＋ جديدة = «إضافة مصدر» (قرار 2026-10-27) ═══
   نافذة الأنواع السبعة كانت تطلب من الإنسان ما يفعله الوكيل. هنا: أربع طرق مصدر،
   كل واحدة تنادي نقطة النهاية الفعلية وتعرض التصنيف/النتيجة/الأخطاء نصياً.
   «نص سريع» يعيد استخدام مسار الملاحظة السريعة السابق نفسه (لا تكرار لمسار ثانٍ). */

/* النافذة صارت للكتابة السريعة وحدها (2026-11-06): كانت تحمل أربعة تبويبات،
   ثلاثة منها (مجلد/مسار/رابط) تكرّر قسم «الاستيراد» حرفياً بواجهة أضعف
   (بلا صيغ ولا معاينة كاملة). الآن: مسار استيراد واحد، وزر يفتحه من هنا. */

function openNewModal() {
  const el = $('modal-new');
  if (el) { el.classList.remove('hidden'); trapFocus(el); }
  const title = $('new-title-input');
  if (title) { title.value = ''; setTimeout(() => title.focus(), 60); }
  const content = $('new-content-input');
  if (content) content.value = '';
  const sel = $('new-type-select');
  if (sel) sel.value = 'note';
  const proj = $('new-project-input');
  if (proj) proj.value = S.projectFilter || '';
  setImportance(1); // الافتراضي الموحّد: عادي (سلّم 1/3/5 — القيمة 2 السابقة كانت تُفتح بلا زر مُبرَز)
}

/* يفتح قسم الاستيراد من النافذة: ضغطة زر بدل ثلاثة تبويبات تكرّر ما فيه */
function openImportView() {
  closeNewModal();
  const rail = document.querySelector('#rail .rail-btn[data-view="import"]');
  if (rail) rail.click();
  const f = $('import-path');
  if (f) setTimeout(() => f.focus(), 90);
}

function closeNewModal() {
  const el = $('modal-new');
  if (!el) return;
  el.classList.add('hidden');
  releaseFocus(el);
}

/* ── مسار «نص سريع»: الملاحظة السريعة السابقة + حقل نص فعلي ── */
async function createNote() {
  const titleEl = $('new-title-input');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) { toast(t('none')); return; }
  const typeEl = $('new-type-select');
  const projEl = $('new-project-input');
  const contentEl = $('new-content-input');
  const project = projEl ? projEl.value.trim() : '';
  const typed = contentEl ? contentEl.value.trim() : '';
  const res = await API.saveNote({
    title,
    content: `# ${title}\n\n${project ? 'Project: ' + project + '\n\n' : ''}${typed}`,
    type: typeEl ? typeEl.value : 'note',
    project,
    importance: importanceFromInput()
  });
  if (res && res.error) { toast(res.error); return; }
  closeNewModal();
  await Promise.all([loadNotes(), loadDashboard()]);
  if (res && res.note) await openNote(res.note.id);
}

/* ── مسارات المصادر: معاينة ⇒ استيراد ⇒ ملخص ── */

function srcStatus(id, msg) { const el = $(id); if (el) el.textContent = msg || ''; }
function srcBanner(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.className = 'banner' + (kind ? ' ' + kind : '');
  el.textContent = text;
}
function srcBannerHide(id) { const el = $(id); if (el) el.classList.add('hidden'); }

/* جدول المعاينة: العدد الكلي + byKind + أول 30 (path/kind/size) — بلا كتابة */
function srcPreviewHtml(res) {
  const kinds = Object.keys(res.byKind || {});
  const kindChips = kinds.length
    ? kinds.map(k => `<span class="chip mono">${escapeHtml(k)} · ${escapeHtml(String(res.byKind[k]))}</span>`).join('')
    : `<span class="hint">${escapeHtml(t('src_preview_empty'))}</span>`;
  const rows = (res.sample || []).map(f =>
    `<tr><td class="mono">${escapeHtml(String(f.path == null ? '' : f.path))}</td>` +
    `<td class="mono">${escapeHtml(String(f.kind == null ? '' : f.kind))}</td>` +
    `<td class="mono">${escapeHtml(String(f.size == null ? '' : f.size))}</td>` +
    `<td class="mono">${escapeHtml(String(f.error == null ? '' : f.error))}</td></tr>`).join('');
  return `<div class="row gap preview-head"><span class="chip mono">${escapeHtml(t('src_total'))} · ${escapeHtml(String(res.total == null ? 0 : res.total))}</span>` +
    `<span class="lbl">${escapeHtml(t('src_by_kind'))}</span>${kindChips}</div>` +
    `<div class="table-wrap src-table"><table class="table"><thead><tr>` +
    `<th>${escapeHtml(t('src_col_path'))}</th><th>${escapeHtml(t('src_col_kind'))}</th>` +
    `<th>${escapeHtml(t('src_col_size'))}</th><th>${escapeHtml(t('error_word'))}</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>` +
    (rows ? `<div class="hint">${escapeHtml(t('src_sample'))} · ${escapeHtml(t('src_folder_hint'))}</div>` : '');
}

/* معاينة التصنيف قبل الكتابة — للمسار الواحد في قسم الاستيراد */
async function previewImportNow() {
  const pathEl = $('import-path');
  const path = pathEl ? pathEl.value.trim() : '';
  const out = $('import-preview-out');
  const btn = $('import-preview-btn');
  if (out) out.innerHTML = '';
  if (!path) { srcBanner('import-result', t('src_need_path'), 'bad'); return; }
  if (btn) { btn.disabled = true; btn.textContent = t('src_busy_preview'); }
  const res = await API.importPreview(path);
  if (btn) { btn.disabled = false; btn.textContent = t('src_preview_btn'); }
  if (!res || res.error || res.rejected) { srcBanner('import-result', serverText((res && res.error) || t('failed')), 'bad'); return; }
  if (out) out.innerHTML = srcPreviewHtml(res);
}

/* ملخص حزمة (مجلد/مسارات): created/skipped/quarantined/relationsAdded + §19 */
function srcBatchSummary(r) {
  const head = `${t('src_scanned')}: ${r.scanned == null ? 0 : r.scanned} · ${t('src_created')}: ${r.created == null ? 0 : r.created}` +
    ` · ${t('src_skipped')}: ${r.skipped == null ? 0 : r.skipped} · ${t('src_quarantined')}: ${r.quarantined == null ? 0 : r.quarantined}` +
    ` · ${t('src_relations')}: ${r.relationsAdded == null ? 0 : r.relationsAdded}`;
  return head + '\n' + t('src_saved_hint');
}




async function deleteActiveNote() {
  if (!S.activeNote) return;
  if (!confirm(t('ask_delete'))) return;
  const res = await API.deleteNote(S.activeNote.id);
  if (res && res.error) { toast(res.error); return; }
  toast(t('toast_deleted'));
  S.activeNote = null;
  dirty = false;
  const docEl = $('doc');
  if (docEl) docEl.classList.add('hidden');
  const emptyEl = $('empty-state');
  if (emptyEl) emptyEl.classList.remove('hidden');
  await Promise.all([loadNotes(), loadDashboard()]);
}

/* ─────────────────────────── settings ─────────────────────────── */

async function openSettings() {
  const el = $('modal-settings');
  if (el) el.classList.remove('hidden');
  const data = await API.settings();
  S.settings = (data && data.ai) ? data : (S.settings || {});
  fillSettings(S.settings);
  await refreshRetrievalStatus();
}

function closeSettings() {
  const el = $('modal-settings');
  if (el) el.classList.add('hidden');
}

function fillSettings(settings) {
  const st = (settings && settings.ai) ? settings : { ai: {}, memory: { retrieval: {} }, agent: {} };
  const ai = st.ai || {};
  const rt = (st.memory && st.memory.retrieval) || {};
  const agent = st.agent || {};
  const set = (id, v) => { const e = $(id); if (e && v != null) e.value = v; };

  set('temp-input', ai.temperature != null ? ai.temperature : 0.2);
  const tempLabel = $('temp-label');
  if (tempLabel) tempLabel.textContent = Number(ai.temperature != null ? ai.temperature : 0.2).toFixed(2);
  fillActiveModelLine(ai);

  set('retrieval-provider-select', rt.provider || 'mock');
  set('retrieval-model-input', rt.model || '');
  set('retrieval-base-url-input', rt.baseUrl || '');
  set('retrieval-api-key-input', rt.apiKey || '');
  set('retrieval-rerank-select', rt.rerankStrategy || 'mmr');
  set('retrieval-topk-input', rt.topK != null ? rt.topK : 8);
  const topkLabel = $('retrieval-topk-label');
  if (topkLabel) topkLabel.textContent = String(rt.topK != null ? rt.topK : 8);

  set('autonomy-select', agent.autonomy || 'supervised');
  set('lang-mode-select', agent.language || 'auto');
  set('schedule-hours', agent.schedule_hours != null ? agent.schedule_hours : 0);
}

/* سطر قراءة فقط في الإعدادات: ما هو المزود/النموذج النشط الآن.
   التحرير نفسه في قسم «المزوّدين» وحده (مكان واحد لا مكانان). */
function fillActiveModelLine(ai) {
  const el = $('active-model-line');
  if (!el) return;
  const provider = String((ai && (ai.providerName || ai.provider)) || '').trim();
  const model = String((ai && ai.model) || '').trim();
  if (!provider) { el.textContent = t('no_active_model'); return; }
  /* data-i18n على التسميات كي يُعيد محرّك الترجمة كتابتها عند تبديل اللغة —
     بدونها يبقى «المزود» عربياً في الواجهة الإنجليزية (كشفه تدقيق 06). */
  el.innerHTML = `<span class="k" data-i18n="l_provider">${escapeHtml(t('l_provider'))}</span> <b>${escapeHtml(provider)}</b>`
    + (model ? ` <span class="sep">•</span> <span class="k" data-i18n="model_word">${escapeHtml(t('model_word'))}</span> <b>${escapeHtml(model)}</b>` : '');
}

async function saveSettings() {
  const val = id => { const e = $(id); return e ? e.value : ''; };
  const payload = {
    /* ai: الحرارة وحدها. لا نُرسل provider/baseUrl/apiKey/model — الشاشة لم تعد
       تملكها (المزودون في قسمهم)، وإرسالها فارغة كان سيمحو المزود النشط. */
    ai: {
      temperature: parseFloat(val('temp-input')) || 0
    },
    memory: {
      retrieval: {
        /* لا نكتب provider إن كان الحقل فارغاً: قيمة لا تمثّلها القائمة (مزوّد
           أحدث من الواجهة) تُنتج '' في `select`، وكتابتها كانت تمحو إعداد
           الاسترجاع صامتة (عطل مُقاس 2026-11-08: local-ngram لم يكن في القائمة). */
        ...(val('retrieval-provider-select') ? { provider: val('retrieval-provider-select') } : {}),
        model: val('retrieval-model-input').trim(),
        baseUrl: val('retrieval-base-url-input').trim() || 'https://api.openai.com',
        ollamaBaseUrl: val('retrieval-base-url-input').trim() || 'http://localhost:11434',
        apiKey: val('retrieval-api-key-input').trim(),
        rerankStrategy: val('retrieval-rerank-select'),
        topK: parseInt(val('retrieval-topk-input'), 10) || 8
      }
    },
    agent: {
      autonomy: val('autonomy-select') || 'supervised',
      language: val('lang-mode-select') || 'auto',
      schedule_hours: parseInt(val('schedule-hours'), 10) || 0
    }
  };
  const res = await API.saveSettings(payload);
  if (res && res.error) { toast(res.error); return; }
  const data = await API.settings();
  S.settings = (data && data.ai) ? data : (S.settings || {});
  toast(t('toast_saved'));
  closeSettings();
}

async function doRebuild() {
  const status = $('retrieval-status');
  if (status) status.textContent = '…';
  const res = await API.rebuildIndex();
  if (res && res.error) { if (status) status.textContent = '⚠ ' + res.error; toast(res.error); return; }
  toast(t('toast_rebuilt'));
  await refreshRetrievalStatus();
}

async function refreshRetrievalStatus() {
  const status = $('retrieval-status');
  if (!status) return;
  const res = await API.retrievalStatus();
  if (res && res.error) { status.textContent = '⚠ ' + res.error; return; }
  status.textContent = res.dirty ? t('idx_dirty') : t('idx_ok');
}

/* ─────────────────────────── MCP modal ────────────────────────── */

async function openMcp() {
  const el = $('modal-mcp');
  if (el) el.classList.remove('hidden');
  /* بصمة النسخة داخل النافذة: **مشتقة** من وسم السكربت نفسه لا مكتوبة يدوياً —
     درس هذه الجلسة كله: مصدر واحد. رفع إصدار السكربت يكفي، والبصمة تتبعه. */
  const mtitle = document.querySelector('#modal-mcp .modal-title');
  if (mtitle) {
    const tag = document.querySelector('script[src*="/app.js?v="]');
    const ver = tag ? (String(tag.getAttribute('src')).match(/[?&]v=([^&"']+)/) || [])[1] : '';
    mtitle.textContent = ver ? `MCP · v${ver}` : 'MCP';
  }
  /* عطل مُقاس 2026-10-30: بطاقات الخوادم كانت تُرسم فقط بعد أبطأ رد (mcp-info)، ومن
     خلف انشغال الخادم بلحظة الفتح تتأخر أحياناً ثواني — فيبدو القسم فارغاً ويحكم
     المستخدم «لا يوجد شيء». الآن: مؤشر فوري ثم جلب القائمة مستقلاً وبالتوازي. */
  const listHost = $('mcp-external-list');
  if (listHost) listHost.innerHTML = `<div class="hint" style="padding:6px 0">${escapeHtml(t('mcp_loading'))}</div>`;
  renderExternalServers();
  const info = await API.mcpInfo();
  const display = $('mcp-config-display');
  const root = String((info && info.vaultDir) || '').replace(/\\/g, '/').replace(/\/vault$/, '');
  if (display) {
    /* إعدادَان: stdio (بلا شبكة ولا رمز — الثقة على مستوى العملية) وHTTP موثّق
       برمز MCP في الترويسة. الثاني هو ما يلزم أي عميل بعيد/وكيل خارجي. */
    const cfg = { mcpServers: { 'cortex-memory': { command: (info && info.command) || 'node', args: ['mcp-memory-server.js', '--root', root] } } };
    if (info && info.http && info.http.headers) {
      cfg.mcpServers['cortex-memory-http'] = { type: 'http', url: info.http.url, headers: info.http.headers };
    }
    display.textContent = JSON.stringify(cfg, null, 2);
  }
  /* الاتصال العام (2026-10-30): بطاقات «لكل عميل» أُزيلت — العنوان يُولَّد لحظياً من
     أصل الصفحة نفسه، فيرى كل مستخدم عنوان نسخته. أي نظام يدعم MCP عن بُعد يتصل به
     مباشرة، ولمن يدعم stdio فقط تبقى «الكتلة القياسية» أعلاه. */
  const urlEl = $('mcp-url-display');
  if (urlEl) urlEl.textContent = `${location.origin}/mcp`;
  /* آخر اتصال وارد + مفتاح الاستقبال (2026-10-30): الحالة والأداة في نفس المكان —
     «لا نص بلا أداة»: كل ما تعرضه اللوحة يقابله زر يعمل. */
  const inc = $('mcp-incoming-status');
  const incomingOn = !(info && info.mcpHttp && info.mcpHttp.enabled === false);
  if (inc) inc.textContent = !incomingOn
    ? t('mcp_incoming_disabled_note')
    : ((info && info.mcpHttp && info.mcpHttp.lastAt)
      ? `${t('mcp_incoming')}: ${String(info.mcpHttp.lastAt).slice(0, 16).replace('T', ' ')}`
      : t('mcp_incoming_never'));
  const tog = $('mcp-toggle-incoming');
  if (tog) {
    tog.setAttribute('data-on', incomingOn ? '1' : '0');
    tog.textContent = (incomingOn ? t('mcp_incoming_stop') : t('mcp_incoming_start')) + ' · ' + (incomingOn ? t('mcp_incoming_on') : t('mcp_incoming_off'));
  }
  const tools = (info && Array.isArray(info.tools)) ? info.tools : [];
    /* الأدوات تُعرض في قسم الأدوات وحده — هنا تلميح وزر انتقال (إزالة تكرار 2026-11-07) */
    const hintEl = $('mcp-tools-hint');
    if (hintEl) hintEl.textContent = `${(info && Array.isArray(info.tools) ? info.tools.length : 0)} ${t('mcp_count')}`;
}

/* اختبار اتصال حي: نداء أدوات حقيقي على خادم Cortex المدمج (memory_stats قراءة)
   عبر /api/mcp/call — مع approved:true لأنه فعل صريح من المستخدم، والنتيجة تُسجَّل. */
async function testMcpLive() {
  const st = $('mcp-test-status');
  if (st) st.textContent = t('mcp_testing');
  const t0 = Date.now();
  try {
    const r = await API._req('POST', '/api/mcp/call', { server: 'cortex-memory', tool: 'memory_stats', args: {}, approved: true });
    const ms = Date.now() - t0;
    /* عقد الرد الحقيقي (مثبَت 2026-10-25): النص في `clean` لا في `result.content` —
       الاستخراج القديم كان يجعل المقتطف لا يظهر أبداً. */
    const text = r && (r.clean || (r.result && Array.isArray(r.result.content) ? String(r.result.content[0].text || '') : ''));
    const first = String(text || '').split('\n')[0].trim();
    if (st) st.textContent = (r && !r.error)
      ? `✓ ${t('mcp_reached')} ${ms}ms${first ? ' · ' + first.slice(0, 60) : ''}`
      : `✗ ${(r && r.error) || t('failed')}`;
  } catch (e) { if (st) st.textContent = `✗ ${e.message}`; }
}

/* الاتجاه العكسي: قائمة الخوادم الخارجية (بلا الخادم المدمج).
   لكل خادم: حالته من آخر فحص (سجل التدقيق) + زرّا فحص/إلغاء الربط (2026-10-30 —
   كان الإنشاء بلا حالة وبلا حذف: «مرتبط أم لا؟ وكيف ألغيه؟» بلا جواب في الواجهة). */
async function renderExternalServers() {
  const host = $('mcp-external-list');
  if (!host) return;
  const d = await API._req('GET', '/api/mcp/servers').catch(() => null);
  const list = ((d && d.servers) || []).filter((s) => s.name !== 'cortex-memory');
  if (!list.length) {
    host.innerHTML = `<div class="hint" style="padding:6px 0">${escapeHtml(t('mcp_no_external'))}</div>`;
    return;
  }
  host.innerHTML = list.map((s) => {
    const lt = s.lastTest || null;
    const st = lt
      ? (lt.reached ? `✓ ${t('mcp_last_ok')}` : `✗ ${t('mcp_last_fail')}`) + ' · ' + String(lt.at || '').slice(5, 16).replace('T', ' ')
      : t('mcp_last_none');
    const cls = lt ? (lt.reached ? 'ok' : 'bad') : 'dim';
    return `<div class="ref mcp-srow"><div class="mcp-srow-main"><span class="t mono">${escapeHtml(s.name)}</span><span class="n mono">${escapeHtml((s.command || '') + ' ' + ((s.args || []).join(' ')))}</span><span class="mcp-sst ${cls} mono">${escapeHtml(st)}</span></div><div class="mcp-srow-actions"><button class="btn ghost sm" type="button" data-mcp-check="${escapeHtml(s.name)}">${escapeHtml(t('mcp_check'))}</button><button class="btn ghost sm" type="button" data-mcp-unlink="${escapeHtml(s.name)}">${escapeHtml(t('mcp_unlink'))}</button></div></div>`;
  }).join('');
}

/* إجراءات بطاقة خادم خارجي: فحص فوري أو إلغاء الربط — تفويض على الحاوية لأن
   البطاقات تُعاد بناؤها بعد كل إجراء (ربط مباشر بالمولَّد يفقد المستمعين). */
async function mcpExternalAction(e) {
  const check = e.target.closest('[data-mcp-check]');
  if (check) {
    const name = check.getAttribute('data-mcp-check');
    const old = check.textContent;
    check.disabled = true; check.textContent = '…';
    const t0 = Date.now();
    const disc = await API._req('POST', '/api/connectors/discover', { target: name, server: name }).catch(() => null);
    const ms = Date.now() - t0;
    check.disabled = false; check.textContent = old;
    toast(disc && disc.reached
      ? `✓ ${name}: ${t('mcp_reached')} ${ms}ms · ${((disc.toolsFound || []).length)} ${t('tools_unit')}`
      : `✗ ${name}: ${(disc && (disc.reason || disc.error)) || t('failed')}`);
    renderExternalServers();
    return;
  }
  const un = e.target.closest('[data-mcp-unlink]');
  if (un) {
    const name = un.getAttribute('data-mcp-unlink');
    un.disabled = true;
    const r = await API._req('DELETE', '/api/mcp/servers/' + encodeURIComponent(name)).catch(() => null);
    toast(r && r.ok ? `${t('mcp_unlinked')}: ${name}` : `✗ ${(r && r.error) || t('failed')}`);
    renderExternalServers();
  }
}

/* أضف خادماً خارجياً ثم اختبره فوراً باكتشاف أدواته الحقيقي (tools/list) */
async function addExternalMcpServer() {
  const st = $('mcp-ext-status');
  const name = ($('mcp-ext-name') || {}).value ? $('mcp-ext-name').value.trim() : '';
  const cmd = ($('mcp-ext-cmd') || {}).value ? $('mcp-ext-cmd').value.trim() : '';
  const argsRaw = ($('mcp-ext-args') || {}).value || '';
  const args = argsRaw.split(/\s+/).filter(Boolean);
  if (!name || !cmd) { if (st) st.textContent = '✗ ' + t('mcp_ext_need'); return; }
  if (st) st.textContent = t('mcp_testing');
  const save = await API._req('POST', '/api/mcp/servers', { name, command: cmd, args });
  if (!save || save.error) { if (st) st.textContent = '✗ ' + ((save && save.error) || t('failed')); return; }
  const t0 = Date.now();
  const disc = await API._req('POST', '/api/connectors/discover', { target: name, server: name });
  const ms = Date.now() - t0;
  if (st) st.textContent = (disc && disc.reached)
    ? `✓ ${name}: ${t('mcp_reached')} ${ms}ms · ${((disc.toolsFound || []).length)} ${t('tools_unit')} · ${(disc.capabilities || []).length} ${t('mcp_caps_unit')}`
    : `✗ ${name}: ${(disc && (disc.reason || disc.error)) || t('failed')}`;
  renderExternalServers();
}

/* فحص الاتصال العام (2026-10-30): نداء /mcp حقيقي من الصفحة نفسها — «هل العنوان يستقبل؟» */
async function testGeneralMcp() {
  const st = $('mcp-general-test-status');
  if (st) st.textContent = t('mcp_general_testing');
  const t0 = Date.now();
  try {
    const r = await fetch(`${location.origin}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const ms = Date.now() - t0;
    const j = r.status === 200 ? await r.json().catch(() => null) : null;
    if (st) {
      if (r.status === 200 && j && j.result) st.textContent = `✓ ${t('mcp_reached')} ${ms}ms · ${j.result.serverInfo.name}`;
      else if (r.status === 403) st.textContent = `✗ 403 · ${t('mcp_incoming_off')}`;
      else st.textContent = `✗ ${r.status}`;
    }
  } catch (e) { if (st) st.textContent = `✗ ${e.message}`; }
}

/* إيقاف/تشغيل استقبال /mcp — «فك الاتصال العام» وإعادته (2026-10-30) */
async function toggleIncomingMcp() {
  const tog = $('mcp-toggle-incoming');
  if (!tog) return;
  const wasOn = tog.getAttribute('data-on') !== '0';
  tog.disabled = true;
  const r = await API._req('POST', '/api/mcp/incoming', { enabled: !wasOn }).catch(() => null);
  tog.disabled = false;
  if (r && r.ok) {
    const nowOn = !!r.enabled;
    tog.setAttribute('data-on', nowOn ? '1' : '0');
    tog.textContent = (nowOn ? t('mcp_incoming_stop') : t('mcp_incoming_start')) + ' · ' + (nowOn ? t('mcp_incoming_on') : t('mcp_incoming_off'));
    const incEl = $('mcp-incoming-status');
    if (incEl && !nowOn) incEl.textContent = t('mcp_incoming_disabled_note');
    toast(nowOn ? t('mcp_incoming_on') : t('mcp_incoming_off'));
  } else {
    toast(`✗ ${(r && r.error) || t('failed')}`);
  }
}

function closeMcp() {
  const el = $('modal-mcp');
  if (el) el.classList.add('hidden');
}

function copyMcp() {
  const display = $('mcp-config-display');
  const text = display ? display.textContent : '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(t('toast_copied')), () => toast(t('toast_copied')));
  } else {
    toast(t('toast_copied'));
  }
}

/* ─────────────────────────── sessions ─────────────────────────── */

/* ═══ عدّاد المسودات المعلقة (قرار 2026-10-24): الشارة العليا تعرض ما ينتظر قرارك —
   لا اسم المزود المكرر في شريط الحالة السفلي. صفر مسودات ⇒ مخفية بلا ضجيج. ═══ */
async function refreshPendingBadge() {
  const b = document.getElementById('ai-badge');
  if (!b) return;
  try {
    const d = await API.pending();
    const n = (d && Array.isArray(d.mutations)) ? d.mutations.length : 0;
    const base = b.dataset.provider || '';
    b.textContent = n ? (n + ' ' + t(n === 1 ? 'draft_unit' : 'drafts_unit')) : '';
    b.classList.toggle('hidden', n === 0);
    b.classList.toggle('draft-chip', n > 0);
    b.style.cursor = n ? 'pointer' : '';
    b.title = n ? (t('drafts_title') + (base ? ' · ' + base : '')) : base;
  } catch (e) { /* الشارة لا تكسر الواجهة */ }
}

async function openSessions() {
  const el = $('modal-sessions');
  if (el) el.classList.remove('hidden');
  const list = $('sessions-list');
  if (list) list.innerHTML = `<div class="hint" style="padding:10px">${escapeHtml(t('loading_word'))}…</div>`;
  const res = await API.sessions();
  if (!list) return;
  const sessions = (res && Array.isArray(res.sessions)) ? res.sessions : [];
  if (!sessions.length) { list.innerHTML = `<div class="hint" style="padding:10px">${escapeHtml(t('no_sessions'))}</div>`; return; }
  /* تحسين 2026-10-24: الصفوف كانت «هدف • وضع • عدد» فقط. الآن: الوضع والمشروع وآخر
     تحديث ومعاينة آخر رسالة + فتح الصف يعرض الرسائل + زر «متابعة» يجعل الجلسة نشطة
     للوكيل (يُمرَّر sessionId مع كل تشغيل فيتراكم السجل بدل جلسات فارغة). */
  list.innerHTML = sessions.map((s) => {
    const id = String(s.id || s.sessionId || '');
    const active = (typeof S !== 'undefined' && S.sessionId === id);
    const when = s.updatedAt ? (shortDate(s.updatedAt) + ' ' + new Date(s.updatedAt).toTimeString().slice(0, 5)) : '';
    const msgs = Number(s.messageCount || (Array.isArray(s.messages) ? s.messages.length : 0)) || 0;
    const prev = String(s.lastPreview || '').trim();
    const msgRows = (Array.isArray(s.messages) ? s.messages : []).slice(-12).map((m) => {
      const role = m.role === 'user' ? t('sess_role_user') : t('sess_role_assistant');
      return `<div class="sess-msg"><span class="fk mono">${escapeHtml(role)}</span> ${escapeHtml(String(m.content || '').slice(0, 220))}</div>`;
    }).join('');
    return `<div class="sess-item${active ? ' active' : ''}" data-sid="${escapeHtml(id)}">
      <div class="sess-head">
        <span class="t">${escapeHtml(s.goal || id)}</span>
        ${active ? `<span class="badge-n">${escapeHtml(t('sess_active'))}</span>` : ''}
        <span class="n mono">${escapeHtml(s.mode || '')}${s.project ? ' • ' + escapeHtml(String(s.project)) : ''} • ✉ ${msgs}${when ? ' • ' + escapeHtml(when) : ''}</span>
      </div>
      ${prev ? `<div class="sess-prev hint">${escapeHtml(String(s.lastRole || '') === 'assistant' ? t('sess_role_assistant') + ': ' : '')}${escapeHtml(prev.slice(0, 140))}</div>` : ''}
      <div class="sess-body hidden">${msgRows || `<div class="hint">${escapeHtml(t('sess_no_msgs'))}</div>`}</div>
      <div class="sess-actions">
        <button type="button" class="btn ghost sm" data-act="toggle">${escapeHtml(t('sess_show'))}</button>
        <button type="button" class="btn sm" data-act="continue">${escapeHtml(t('sess_continue'))}</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.sess-item').forEach((row) => {
    const id = row.dataset.sid;
    const body = row.querySelector('.sess-body');
    const toggle = row.querySelector('[data-act="toggle"]');
    if (toggle && body) toggle.onclick = () => { body.classList.toggle('hidden'); toggle.textContent = body.classList.contains('hidden') ? t('sess_show') : t('sess_hide'); };
    const cont = row.querySelector('[data-act="continue"]');
    if (cont) cont.onclick = () => {
      S.sessionId = id;
      list.querySelectorAll('.sess-item').forEach((r) => r.classList.toggle('active', r.dataset.sid === id));
      toast(t('sess_resumed'));
    };
  });
}

function closeSessions() {
  const el = $('modal-sessions');
  if (el) el.classList.add('hidden');
}

/* ─────────────────────────── link modal ───────────────────────── */
/* ═══ ＋ ربط = «ربط ذكي» (قرار 2026-10-27) ═══
   النموذج القديم كان ثلاث قوائم يملؤها الإنسان. الآن: اختيار عنصر ⇒ الوكيل يقرأ
   تشابهه الفعلي (/api/links/suggest: وسوم/روابط/تقاطع مصطلحات) ويعرض شريط ثقة
   وسبباً ⇒ والمستخدم يعتمد. كل اعتماد يمرّ بـ/api/links/approve (رمز الجلسة)،
   والعلاقة تُسجَّل بمصدر وثقة وزمن (§7). */

let LINK_PICK = '';
let LINK_SUGG = [];
let LINK_SRC_TITLE = '';

function openLinkModal() {
  const el = $('modal-link');
  if (el) el.classList.remove('hidden');
  LINK_PICK = S.activeNote ? S.activeNote.id : '';
  LINK_SUGG = [];
  LINK_SRC_TITLE = S.activeNote ? String(S.activeNote.title || S.activeNote.id) : '';
  const src = $('link-source-title');
  if (src) src.textContent = LINK_SRC_TITLE || '—';
  const count = $('link-suggest-count');
  if (count) count.classList.add('hidden');
  const inp = $('link-search-input');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 60); }
  const sum = $('link-approve-summary');
  if (sum) { sum.classList.add('hidden'); sum.textContent = ''; }
  renderLinkPicker();
  if (LINK_PICK) loadLinkSuggestions(LINK_PICK);
  else {
    const host = $('link-suggest-list');
    if (host) host.innerHTML = `<div class="hint">${escapeHtml(t('link_pick_hint'))}</div>`;
  }
}

/* قائمة الاختيار من /api/notes المحمّلة أصلاً (S.notes) — بحث بالعنوان والمعرّف + المرادفات */
function renderLinkPicker() {
  const list = $('link-pick-list');
  if (!list) return;
  const inp = $('link-search-input');
  const q = String(inp ? inp.value : '').trim().toLowerCase();
  const items = S.notes.filter(n => {
    if (!q) return true;
    const hay = (String(n.title || '') + ' ' + String(n.id || '') + ' ' + String(n.projectName || '')).toLowerCase();
    return hay.indexOf(q) !== -1 || paletteSynExpand(hay).indexOf(q) !== -1;
  }).slice(0, 40);
  list.innerHTML = items.length ? items.map(n =>
    `<div class="tree-i${LINK_PICK === n.id ? ' active' : ''}" data-id="${escapeHtml(n.id)}">
       <span class="dot"></span><span class="t">${escapeHtml(n.title || n.id)}</span><span class="n">${escapeHtml(n.projectName || typeLabel(n))}</span>
     </div>`).join('') : `<div class="hint" style="padding:6px 12px">${escapeHtml(t('no_results'))}</div>`;
}

async function loadLinkSuggestions(noteId) {
  const host = $('link-suggest-list');
  const count = $('link-suggest-count');
  if (host) host.innerHTML = `<div class="hint">${escapeHtml(t('link_loading'))}</div>`;
  const res = await API.linkSuggest(noteId);
  if (!res || res.error) {
    LINK_SUGG = [];
    if (host) host.innerHTML = `<div class="hint">${escapeHtml(serverText((res && res.error) || t('failed')))}</div>`;
    if (count) count.classList.add('hidden');
    return;
  }
  LINK_SRC_TITLE = String(res.title || LINK_SRC_TITLE || '');
  const srcEl = $('link-source-title');
  if (srcEl) srcEl.textContent = LINK_SRC_TITLE || '—';
  LINK_SUGG = Array.isArray(res.suggestions) ? res.suggestions : [];
  if (count) { count.classList.toggle('hidden', !LINK_SUGG.length); count.textContent = String(LINK_SUGG.length); }
  renderLinkSuggestions();
}

/* السبب المعروض: نص الخادم بالعربية كما هو، وبالإنجليزية يُصاغ من الأرقام نفسها
   (النقطة لا ترسل lang — فالصياغة الإنجليزبة تُبنى من score الحقيقي لا تُترجم آلياً) */
function linkReason(row) {
  if (LANG !== 'en') return String((row && row.reason) || '');
  return t('link_reason_tpl')
    .replace('{title}', LINK_SRC_TITLE)
    .replace('{score}', String(row && row.score != null ? row.score : ''));
}

function renderLinkSuggestions() {
  const host = $('link-suggest-list');
  if (!host) return;
  if (!LINK_SUGG.length) { host.innerHTML = `<div class="hint">${escapeHtml(t('link_none'))}</div>`; return; }
  host.innerHTML = LINK_SUGG.map((r, i) => {
    const c = confText(r.confidence);
    const pct = c.unknown ? 0 : Math.round(clamp(Number(r.confidence), 0, 1) * 100);
    const reason = linkReason(r);
    return `<div class="sugg${c.low ? ' low' : ''}">
      <label class="sugg-head"><input type="checkbox" class="sugg-check" data-i="${i}" />
        <span class="t">${escapeHtml(String(r.title || r.target || ''))}</span></label>
      <div class="sugg-meta">
        <span class="confbar" aria-hidden="true"><i style="width:${pct}%"></i></span>
        <span class="chip conf ${c.low ? 'low' : 'high'}">${escapeHtml(t('link_confidence'))} ${escapeHtml(c.num)} (${escapeHtml(c.pct)})</span>
        <span class="chip kind">${escapeHtml(relKindL(r.kind))}</span>
      </div>
      ${reason ? `<div class="sugg-reason">${escapeHtml(reason)}</div>` : ''}
    </div>`;
  }).join('');
}

async function approveSelectedLinks() {
  const sum = $('link-approve-summary');
  const btn = $('link-approve-btn');
  if (!LINK_PICK) { toast(t('link_select_first')); return; }
  const boxes = $$('#link-suggest-list .sugg-check').filter(b => b.checked);
  if (!boxes.length) { toast(t('link_approve_none')); return; }
  if (btn) { btn.disabled = true; btn.textContent = t('busy_save'); }
  let okN = 0, badN = 0;
  const errs = [];
  for (const b of boxes) {
    const r = LINK_SUGG[Number(b.getAttribute('data-i'))];
    if (!r || !r.target) { badN++; continue; }
    const res = await API.approveLink({
      source: LINK_PICK, target: r.target, kind: r.kind || 'references',
      confidence: r.confidence, reason: r.reason
    });
    if (res && res.ok) okN++;
    else { badN++; if (res && res.error && errs.length < 3) errs.push(serverText(res.error)); }
  }
  if (btn) { btn.disabled = false; btn.textContent = t('link_approve'); }
  if (sum) {
    sum.classList.remove('hidden');
    sum.className = 'banner ' + (badN === 0 ? 'ok' : 'bad');
    sum.textContent = t('link_approved_n').replace('{n}', String(okN)) +
      (badN ? ' · ' + t('link_failed_n').replace('{m}', String(badN)) : '') +
      (errs.length ? '\n⚠ ' + errs.join(' | ') : '') + '\n' + t('link_philosophy');
  }
  await loadLinkSuggestions(LINK_PICK);
  if (S.activeNote && S.activeNote.id === LINK_PICK) loadContext(LINK_PICK);
}

function closeLinkModal() {
  const el = $('modal-link');
  if (el) el.classList.add('hidden');
}

/* ─────────────────────────── actions ──────────────────────────── */

async function doBackup() {
  const res = await API.backup();
  if (res && res.error) { toast(res.error); return; }
  toast(t('toast_backup'));
}

/* تصدير مشروع (2026-11-06، تدقيق الواجهة): المسار كان موجوداً وكاملاً في الخادم
   (md أو zip مع الأصول) ولا سطح له إطلاقاً — لا زر ولا أمر ولا أداة وكيل.
   النسخة الاحتياطية شيء آخر: لقطة للخزنة كلها، لا حزمة مشروع قابلة للتسليم. */
async function doExportProject() {
  /* المشروع = الفلتر الحالي، وإلا مشروع الملاحظة المفتوحة. لا تخمين من حالة
     الخادم: اسم خاطئ يعيد 404 «لا عناصر» بدل رسالة مفهومة. */
  const cur = S.activeNote || {};
  const project = S.projectFilter || cur.projectName || (cur.fm && cur.fm.project) || '';
  if (!project) { toast(t('export_need_project')); return; }
  const btn = document.getElementById('export-project-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await API.exportProject(project, 'md');
    if (!res || res.error) { toast('⚠ ' + ((res && res.error) || t('failed'))); return; }
    const where = String(res.file || '').split(/[\\/]/).slice(-2).join('/');
    toast('✓ ' + t('export_done') + ': ' + (res.notes || 0) + ' · ' + Math.round((res.size || 0) / 1024) + 'KB' + (where ? ' — ' + where : ''));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doLivingNote() {
  const project = S.projectFilter || stateProject() || 'workspace';
  const res = await API.livingNote(project);
  if (res && res.error) { toast(res.error); return; }
  toast(t('toast_living'));
  await Promise.all([loadNotes(), loadDashboard()]);
}

async function doExtractActions() {
  const content = (S.activeNote && S.activeNote.content) || '';
  if (!content) { toast(t('open_note_hint')); return; }
  const note = S.activeNote || {};
  const isMeeting = (note.classification && note.classification.primaryType === 'meeting') ||
    (note.fm && note.fm.type === 'meeting');
  if (isMeeting) {
    await doMeetingActions();
    return;
  }
  const res = await API.summarize(content, note.id || '');
  if (res && res.error) { toast(res.error); return; }
  addBubble('system', t('goal_tasks'));
  addBubble('ai', res.summary || res.answer || t('none'));
}

async function doMeetingActions() {
  const content = (S.activeNote && S.activeNote.content) || '';
  if (!content) { toast(t('open_note_hint')); return; }
  const res = await API.meetingActions(content);
  if (res && res.error) { toast(res.error); return; }
  const items = (res && (res.actions || res.tasks)) || [];
  addBubble('system', `${t('extract_btn_mtg')}: ${items.length}`);
  items.slice(0, 10).forEach(it => addBubble('system', '• ' + (it.text || it)));
}

async function doContradictions() {
  const res = await API.contradictions(S.activeNote ? S.activeNote.id : '');
  if (res && res.error) { toast(res.error); return; }
  const items = (res && (res.contradictions || res.findings)) || [];
  addBubble('system', `${t('g_contr')}: ${items.length}`);
  items.slice(0, 10).forEach(it => addBubble('system', '• ' + (it.text || it.message || it)));
}

function setProjectFilter(name) {
  S.projectFilter = name || '';
  renderSidebar();
  if (S.activeNote) loadContext(S.activeNote.id);
}

/* ─────────────────────────── SSE vault watch ──────────────────── */

let watchTimer = null;

function startVaultWatch() {
  let es;
  try { es = new EventSource('/api/watch'); } catch (_) { return; }
  es.onmessage = event => {
    let data = {};
    try { data = JSON.parse(event.data || '{}'); } catch (_) { return; }
    if (data.reason === 'startup') return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => refreshFromDisk(data.reason), 350);
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

async function refreshFromDisk(reason) {
  const clean = !S.activeNote || !$('note-content') || $('note-content').value === lastSavedValue;
  await Promise.all([loadNotes(), loadDashboard()]);
  if (S.activeNote) {
    if (clean) await openNote(S.activeNote.id);
    else await loadContext(S.activeNote.id);
  }
  if (reason && reason !== 'save_note') toast(t('disc_updated'));
}

/* ────────────────────────── bootstrap ─────────────────────────── */

async function init() {
  await Promise.all([loadNotes(), loadDashboard()]);
  if (S.notes.length) await openNote(S.notes[0].id);
  else {
    const docEl = $('doc');
    if (docEl) docEl.classList.add('hidden');
    const emptyEl = $('empty-state');
    if (emptyEl) emptyEl.classList.remove('hidden');
  }
  // رسالة الشات الفارغة = تعريف الوكيل بنفسه (شكوى المستخدم 2026-10-30: «الواجهة توضح أنه ليس agent»)
  addBubble('system', t('agent_intro'));
}

function wireEvents() {
  /* appearance + language segments */
  $$('[data-ui-accent]').forEach(b => b.onclick = () => { UI = Object.assign({}, UI, { accent: b.getAttribute('data-ui-accent') }); saveUI(); applyUI(); });
  $$('[data-ui-fz]').forEach(b => b.onclick = () => { UI = Object.assign({}, UI, { fz: b.getAttribute('data-ui-fz') }); saveUI(); applyUI(); });
  $$('[data-ui-lang]').forEach(b => b.onclick = () => setLang(b.getAttribute('data-ui-lang')));

  /* importance — every segment control drives ONE setImportance */
  $$('[data-ui-importance]').forEach(b => b.onclick = () => setImportance(b.getAttribute('data-ui-importance')));

  /* top bar */
  if ($('new-note-btn')) $('new-note-btn').onclick = openNewModal;
  if ($('link-note-btn')) $('link-note-btn').onclick = openLinkModal;
  if ($('export-project-btn')) $('export-project-btn').onclick = doExportProject;
  if ($('palette-open-btn')) $('palette-open-btn').onclick = openPalette;
  /* شارة المسودات: النقر يفتح لوحة الوكيل (حيث يُعتمد أو يُرفض) — واستطلاع خفيف كل 15ث
     لأن المسودات تنشأ من مسارات متعددة (تشغيل/استئناف/أدوات خارجية). */
  if ($('ai-badge')) {
    const b = $('ai-badge');
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.onclick = () => { if (b.classList.contains('draft-chip') && typeof openAgentPanel === 'function') openAgentPanel(); };
  }
  try { refreshPendingBadge(); setInterval(refreshPendingBadge, 15000); } catch (e) { /* لا يكسر الإقلاع */ }
  if ($('settings-btn')) $('settings-btn').onclick = openSettings;
  if ($('mcp-btn')) $('mcp-btn').onclick = openMcp;
  // لوحة الوكيل: تظهر بإزالة hidden + إضافة ai-open على #app (شرط CSS)
  const openAgentPanel = () => {
    $('ai-panel').classList.remove('hidden');
    const app = $('app'); if (app) app.classList.add('ai-open');
    setAgentContextLine(); loadPending(); renderFindings();
    // الخلفية (المجدولة/النبضات) تُحدَّث عند كل فتح — تكلفتها رطلان GET صغيران
    try { if (typeof loadAgentExtras === 'function') loadAgentExtras(); } catch (e) { /* لا يُسقط الفتح */ }
    // تطبيق حالة التبويب على المحتويات (بما فيها المسودات/المستجدات المقروءة الآن)
    try { if (typeof applyAgentTab === 'function') applyAgentTab(); } catch (e) { /* تحسيني */ }
    /* W1/W3: استأنف عرض آخر تشغيل من سجله الدائم إن كانت اللوحة فارغة + شغّل الاستطلاع الحيّ */
    try {
      const st = window.__studio;
      const log = document.getElementById('chat-messages');
      if (st) {
        if (log && !log.querySelector('.tl-item')) st.replayRun();
        st.renderLiveBar();
        st.startLivePoll();
      }
    } catch (e) { /* الاستوديو تحسيني */ }
    if ($('chat-input')) $('chat-input').focus();
  };
  const closeAgentPanel = () => {
    $('ai-panel').classList.add('hidden');
    const app = $('app'); if (app) app.classList.remove('ai-open');
    try { if (window.__studio) window.__studio.stopLivePoll(); } catch (e) { /* تحسيني */ }
  };
  if ($('ai-open-btn')) $('ai-open-btn').onclick = openAgentPanel;
  if ($('ai-close-btn')) $('ai-close-btn').onclick = closeAgentPanel;
  window.__openAgentPanel = openAgentPanel;

  /* editor tabs */
  $$('#editor-tabs .vpill').forEach(tab => tab.onclick = () => setView(tab.getAttribute('data-mode')));

  /* بادج التصنيف (2026-10-30): يُفتح عند الطلب — بدل حقول دائمة في وجه المستخدم */
  if ($('doc-meta-toggle')) $('doc-meta-toggle').onclick = () => { const f = $('doc-meta-fields'); if (f) f.classList.toggle('hidden'); };

  /* sidebar delegation */
  if ($('projects-list')) $('projects-list').onclick = e => {
    const el = e.target.closest('[data-project]');
    if (el) setProjectFilter(el.getAttribute('data-project'));
  };
  if ($('library-list')) $('library-list').onclick = e => {
    const el = e.target.closest('[data-id]');
    if (el) openNote(el.getAttribute('data-id'));
  };
  if ($('entities-list')) $('entities-list').onclick = e => {
    const el = e.target.closest('[data-note]');
    if (el && el.getAttribute('data-note')) openNote(el.getAttribute('data-note'));
  };

  /* تفاصيل العنصر: زر واحد يفتح/يغلق اللوحة (كان خمسة أزرار بعدّادات خام — نقد 2026-10-30) */
  const detailsBtn = $('ctx-details-toggle');
  if (detailsBtn) detailsBtn.onclick = () => {
    const panels = $('ctx-panels');
    if (!panels) return;
    const open = !panels.classList.contains('hidden');
    panels.classList.toggle('hidden', open);
    detailsBtn.classList.toggle('active', !open);
    if (!open && S.activeNote) loadContext(S.activeNote.id);
  };
  if ($('ctx-panels')) $('ctx-panels').onclick = e => {
    const snap = e.target.closest('[data-file]');
    if (snap) { loadSnapshot(snap.getAttribute('data-file')); return; }
    const ref = e.target.closest('[data-id]');
    if (ref && ref.getAttribute('data-id')) openNote(ref.getAttribute('data-id'));
  };
  if ($('note-preview')) $('note-preview').onclick = e => {
    const link = e.target.closest('.wikilink');
    if (link) {
      const target = String(link.getAttribute('data-wiki') || '').toLowerCase();
      const note = S.notes.find(n => n.id === target || (n.title || '').toLowerCase() === target);
      if (note) openNote(note.id);
    }
  };

  /* sidebar footer actions */
  if ($('living-note-btn')) $('living-note-btn').onclick = doLivingNote;
  if ($('backup-btn')) $('backup-btn').onclick = doBackup;

  /* empty state */
  if ($('empty-new-btn')) $('empty-new-btn').onclick = openNewModal;

  /* document editing + autosave */
  if ($('note-content')) $('note-content').addEventListener('input', () => { renderPreview($('note-content').value); bindWikilinks($('note-preview')); scheduleAutosave(); });
  if ($('note-title')) $('note-title').addEventListener('input', scheduleAutosave);
  if ($('project-input')) $('project-input').addEventListener('change', scheduleAutosave);
  if ($('type-select')) $('type-select').addEventListener('change', scheduleAutosave);
  if ($('save-note-btn')) $('save-note-btn').onclick = () => saveActive({});
  if ($('delete-note-btn')) $('delete-note-btn').onclick = deleteActiveNote;

  /* new modal — «إضافة مصدر»: تبويبات الطرق الأربع + أزرار كل مسار */
  if ($('create-note-btn')) $('create-note-btn').onclick = createNote;
  if ($('close-new-btn')) $('close-new-btn').onclick = closeNewModal;
  if ($('new-title-input')) $('new-title-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); createNote(); } };
/* زر واحد يقود إلى مسار الاستيراد الوحيد — لا تبويبات مكرّرة داخل النافذة */
  if ($('open-import-btn')) $('open-import-btn').onclick = openImportView;

  /* settings modal */
  if ($('save-settings-btn')) $('save-settings-btn').onclick = saveSettings;
  if ($('close-settings-btn')) $('close-settings-btn').onclick = closeSettings;
  if ($('rebuild-index-btn')) $('rebuild-index-btn').onclick = doRebuild;
  /* المزودون في مكان واحد: زر الإعدادات ينقل إلى القسم ولا يحرّر مزوداً هنا */
  if ($('goto-providers-btn')) $('goto-providers-btn').onclick = () => { closeSettings(); switchView('providers'); };
  if ($('temp-input')) $('temp-input').oninput = () => { if ($('temp-label')) $('temp-label').textContent = Number($('temp-input').value).toFixed(2); };
  if ($('retrieval-topk-input')) $('retrieval-topk-input').oninput = () => { if ($('retrieval-topk-label')) $('retrieval-topk-label').textContent = String($('retrieval-topk-input').value); };

  /* mcp modal */
  if ($('copy-mcp-btn')) $('copy-mcp-btn').onclick = copyMcp;
  if ($('close-mcp-btn')) $('close-mcp-btn').onclick = closeMcp;
  if ($('mcp-test-btn')) $('mcp-test-btn').onclick = testMcpLive;
  if ($('mcp-ext-add')) $('mcp-ext-add').onclick = addExternalMcpServer;
  if ($('mcp-general-test')) $('mcp-general-test').onclick = testGeneralMcp;
  if ($('mcp-toggle-incoming')) $('mcp-toggle-incoming').onclick = toggleIncomingMcp;
  /* تفويض على الحاوية: البطاقات تُعاد بناؤها بعد كل فحص/إلغاء — ربط المولَّد يفقد المستمعين */
  if ($('mcp-external-list')) $('mcp-external-list').onclick = mcpExternalAction;
  /* أزرار «نسخ» العامة في نافذة MCP: كل زر ينسخ محتوى هدفه (#id) */
  $$('[data-copy]').forEach((b) => {
    b.onclick = () => {
      const el = document.querySelector(b.getAttribute('data-copy'));
      const text = el ? el.textContent : '';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(t('toast_copied')), () => {});
      else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(t('toast_copied')); } catch (e) {} ta.remove(); }
    };
  });

  /* sessions modal */
  if ($('sessions-btn')) $('sessions-btn').onclick = openSessions;
  if ($('close-sessions-btn')) $('close-sessions-btn').onclick = closeSessions;

  /* link modal — «ربط ذكي»: بحث ⇒ اختيار ⇒ اقتراحات ⇒ اعتماد */
  if ($('link-search-input')) $('link-search-input').oninput = renderLinkPicker;
  if ($('link-pick-list')) $('link-pick-list').onclick = e => {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    LINK_PICK = el.getAttribute('data-id');
    LINK_SUGG = [];
    renderLinkPicker();
    loadLinkSuggestions(LINK_PICK);
  };
  if ($('link-approve-btn')) $('link-approve-btn').onclick = approveSelectedLinks;
  if ($('close-link-btn')) $('close-link-btn').onclick = closeLinkModal;

  /* agent panel — سطح الوكيل الوحيد: الشات هو الوكيل (توحيد 2026-10-27)،
     وبلا منتقي وضع (2026-10-30 — «شاشة AGENT»): الوكيل يقرر من الجملة،
     وذكر «فريق» في نصّها يستدعي الفريق المتوازي. */
  if ($('send-chat-btn')) $('send-chat-btn').onclick = () => {
    const inp = $('chat-input'); const goal = inp ? String(inp.value || '').trim() : '';
    if (!goal) return;
    const wantsTeam = /(^|[\s،,.:!؟?])(فريق|كفريق|فريقاً|فريقا|بالفريق)([\s،,.:!؟?]|$)/.test(goal);
    if (wantsTeam) {
      if (typeof window.__runTeam === 'function') { if (inp) inp.value = ''; window.__runTeam(goal, S.projectFilter || '', 3); }
      return;
    }
    if (window.__runAgentStream) window.__runAgentStream(goal);
    else agentRun(goal);
  };
  if ($('chat-input')) $('chat-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if ($('send-chat-btn')) $('send-chat-btn').click(); else agentRun($('chat-input').value); } };
  if ($('q-gaps')) $('q-gaps').onclick = () => agentRun(t('goal_gaps'));
  if ($('q-tasks')) { $('q-tasks').onclick = doExtractActions; $('q-tasks').setAttribute('title', t('g_tasksb')); }
  if ($('q-next')) $('q-next').onclick = runNextAction;
  if ($('q-contradictions')) $('q-contradictions').onclick = () => agentRun(t('goal_contra'));

  /* palette */
  if ($('palette-input')) $('palette-input').oninput = onPaletteInput;
  if ($('palette-results')) $('palette-results').onclick = e => {
    /* النجمة تُثبّت/تُلغي التثبيت ولا تُنفّذ الأمر — النقر على بقية الصف ينفّذ */
    const star = e.target.closest('[data-pin]');
    if (star) { e.preventDefault(); togglePalettePin(star.getAttribute('data-pin')); return; }
    const row = e.target.closest('[data-i]');
    if (!row) return;
    paletteIndex = Number(row.getAttribute('data-i')) || 0;
    paletteRun();
  };
  if ($('palette')) $('palette').onclick = e => { if (e.target === $('palette')) closePalette(); };

  /* global keys */
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!$('palette').classList.contains('hidden')) closePalette(); else openPalette();
      return;
    }
    if ($('palette') && !$('palette').classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = clamp(paletteIndex + 1, 0, Math.max(0, paletteItems.length - 1)); renderPalette(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = clamp(paletteIndex - 1, 0, Math.max(0, paletteItems.length - 1)); renderPalette(); return; }
      if (e.key === 'Enter') { e.preventDefault(); paletteRun(); return; }
      if (e.key === 'Escape') { closePalette(); return; }
    }
    if (e.key === 'Escape') {
      closeNewModal(); closeSettings(); closeMcp(); closeLinkModal(); closeSessions();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  LANG = UI.lang;
  applyUI();
  translateDom();
  wireEvents();
  installFocusTraps();

  const st = await API.status();
  if (!st || st.error) {
    setStatus(false, (st && st.error) || '…');
  } else {
    renderDaemon(st.daemon);
    setStatus(true, `${st.noteCount} ${LANG === 'en' ? (st.noteCount === 1 ? 'item' : 'items') : String.fromCharCode(0x0639, 0x0646, 0x0635, 0x0631)} • ${st.provider || ''}`);
  }

  const settings = await API.settings();
  if (settings && settings.ai) {
    S.settings = settings;
  }

  await init();
  await refreshRetrievalStatus();
  await loadFindings();
  await loadPending();
  setView('edit');
  startVaultWatch();
});


/* ══════════════════════════════════════════════════════════════
   وحدة التصميم الجديد — القائمة الأيقونية + 8 شاشات + الخريطة الفيزيائية
   تُوصِل كل مسارات الخادم بالواجهة. لا تمسّ الكود العامل أعلاه.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $id = (i) => document.getElementById(i);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jget = async (u) => { try { const r = await fetch(u); return await r.json(); } catch (e) { return { error: String(e.message || e) }; } };
  const jpost = async (u, b) => {
    try {
      const tk = await getSessionToken();
      const h = { 'Content-Type': 'application/json' };
      if (tk) h['X-Cortex-Session'] = tk;
      const r = await fetch(u, { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify(b || {}) });
      return await r.json();
    } catch (e) { return { error: String(e.message || e) }; }
  };
  const say = (m, kind) => {
    const el = $id('status-badge'); if (el) el.textContent = m;
    const sb = $id('sb-notes');
    if (kind === 'ok' && sb && sb.textContent.indexOf(t('st_items')) >= 0) return;
  };
  const magic = (m) => {
    const el = $id('sb-notes'); if (!el) return;
    el.textContent = m;
    clearTimeout(magic._t); magic._t = setTimeout(() => { loadStatus(); }, 2600);
  };

  // ─────────── ① تبديل الشاشات ───────────
  const VIEW_INIT = {};
  function switchView(name) {
    document.querySelectorAll('#rail .rail-btn').forEach((b) => {
      const on = b.dataset.view === name;
      b.classList.toggle('on', on);
      // aria-current هو ما يعلن التبويب النشط لقارئ الشاشة؛ class="on" لا يكفي.
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('#work .view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
    // #graph-pane حُذف من HTML (الخريطة صارت شاشة #view-graph) — المرجع المعلّق كان يكسر عقد الواجهة.
    if (!VIEW_INIT[name]) { VIEW_INIT[name] = 1; initView(name).catch((e) => console.warn('view ' + name, e)); }
    if (name === 'graph') {
      // الشاشة صارت مرئية الآن — خريطة «من يعتمد على من» تُبنى بعد ظهور الإطار
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { loadGraph(); }, 80)));
    }
  }
  function initView(name) {
    switch (name) {
      case 'notes': return loadStatus();
      case 'graph': return loadGraph();
      case 'monitor': try { loadAgentExtras(); } catch (e) { /* تحسيني: «في غيابي» انتقلت هنا */ } return loadMonitor();
    case 'repos': repoRestore(); repoLoadSaved(); return Promise.resolve();
      case 'providers': return loadProviders();
      case 'import': return loadImport();
      // المهارات انتقلت إلى قسم الأدوات (توحيد سطح الوكيل 2026-10-27)
      case 'tools': try { loadSkills(); } catch (e) { /* لا يكسر التبديل */ } return loadMcp();
      case 'governance': return loadGovernance();
      default: return Promise.resolve();
    }
  }

  // ─────────── ② الحالة العامة ───────────
  async function loadStatus() {
    const st = await jget('/api/status');
    if (st && !st.error) {
      const n = st.noteCount != null ? st.noteCount : 0;
      const el = $id('sb-notes'); if (el) el.textContent = n + ' ' + (LANG === 'en' ? (n === 1 ? 'item' : 'items') : String.fromCharCode(0x0639, 0x0646, 0x0635, 0x0631));
      const h = $id('status-health'); if (h) h.textContent = st.health != null ? t('health_prefix') + ' ' + st.health : '';
      renderDaemon(st.daemon);
      const b = $id('ai-badge');
      /* تدقيق 2026-10-24: الشارة صارت **عدّاد المسودات المعلقة** (قرار المستخدم) —
         اسم المزود باقٍ في العنوان (tooltip) وفي شريط الحالة السفلي، والنص محجوز للعدّاد. */
      if (b) { b.dataset.provider = st.provider || ''; b.title = st.provider || ''; if (typeof refreshPendingBadge === 'function') refreshPendingBadge(); }
    }
    const r = await jget('/api/retrieval/status').catch(() => null);
    if (r && !r.error) {
      const el = $id('retrieval-status');
      if (el) el.textContent = t('state_prefix') + ' ' + (r.mode || r.provider || '—') + (r.count != null ? ' • ' + r.count : '');
    }
  }

  // ─────────── ③ خريطة «من يعتمد على من» — نظام FileMap (مركز + عمودان) ───────────
  let FILEMAP_DATA = null;
  /* خيارات الخريطة في مكان واحد: العنصر المفتوح (إطار ذهبي + بداية التركيز)
     وفتحه في المعرفة بالنقرة المزدوجة — كلاهما يُمرَّر في كل رندر (بما فيه تبديل اللغة) */
  function filemapOpts() {
    return {
      /* اللغة من المصدرين معاً: متغير التطبيق **أو** وسم html — أيّ سبق الآخر.
         (عطل مُقاس 2026-10-24: الاعتماد على LANG وحده أعاد رندرة عربية بعد التبديل.) */
      lang: (LANG === 'en' || document.documentElement.getAttribute('lang') === 'en') ? 'en' : 'ar',
      activeId: (typeof S !== 'undefined' && S.activeNote && S.activeNote.id) || null,
      onOpen: (id) => { try { switchView('notes'); typeof openNote === 'function' && openNote(id); } catch (e) { /* لا يكسر الخريطة */ } },
    };
  }
  async function loadGraph() {
    const host = $id('filemap-root');
    if (!host) return;
    const data = await jget('/api/filemap');
    if (!data || data.error || !Array.isArray(data.nodes)) { magic(t('no_map') + ' ' + ((data && data.error) || t('error_word'))); return; }
    if (!data.nodes.length) { magic(t('map_empty')); return; }
    FILEMAP_DATA = data;
    window.CortexFilemap.render(host, data, filemapOpts());
    const info = $id('graph-info');
    if (info) info.textContent = data.nodes.length + ' ' + t('g_nodes') + ' • ' + (data.stats ? data.stats.edges : 0) + ' ' + t('g_link');
  }

  // ─────────── ④ المزودون ───────────
  let PROVIDERS_CACHE = null;
  let ACTIVE_PROVIDER = '';
  let ACTIVE_MODEL = '';
  let PROVIDERS_LANG = null;
  async function loadProviders() {
    const d = await jget('/api/models/providers');
    try { const st = await jget('/api/status'); ACTIVE_PROVIDER = (st && st.providerName) || ''; ACTIVE_MODEL = (st && st.model) || ''; } catch (e) { /* بلا حالة: لا شارة */ }
    PROVIDERS_CACHE = d;
    PROVIDERS_LANG = LANG;
    const host = $id('provider-list'); if (!host) return;
    const list = (d && (d.providers || d.items)) || (Array.isArray(d) ? d : []);
    const cntEl = $id('provider-count');
    if (cntEl) cntEl.textContent = list.length ? (t('s_providers_count') + ' (' + list.length + ')') : '';
    if (!list.length) { host.innerHTML = '<div class="hint mono" style="padding:6px 0">' + t('no_providers') + '</div>'; return; }
    host.innerHTML = list.map((p) => {
      const key = p.apiKey || '';
      const masked = key ? key.slice(0, 7) + '…' + key.slice(-4) : t('no_key');
      const models = (p.models || []).length;
      // قدرات مُثبتة بالفحص: تُعرض قبل الاستخدام حتى لا يُفاجأ المستخدم بنموذج بلا رؤية
      const info = p.modelsInfo || [];
      const capChips = [info.some((m) => m.capabilities && m.capabilities.tools === true) ? '🛠' : '', info.some((m) => m.capabilities && m.capabilities.vision === true) ? '👁' : ''].filter(Boolean).join(' ');
      /* آخر فحص محفوظ: حالة حقيقية بدل «مفعّل» المجرّدة (زمن + نجاح + سبب الفشل) */
      const lp = p.lastProbe || null;
      const isActive = String(p.name || '') === String(ACTIVE_PROVIDER || '');
      const activeChip = isActive ? `<span class="gov-badge gov-badge-ok">${t('active_word')}</span>` : '';
      const probeLine = lp
        ? `<div class="pkey ${lp.ok ? 'ok' : 'bad'}">${lp.ok ? '✓ ' + t('b_test') + ': ' + (lp.modelsCount || 0) + ' ' + t('models_unit') : '⚠ ' + esc(String(lp.error || t('failed')).slice(0, 90))}</div>`
        : '';
      /* اختيار النموذج انتقل إلى هنا مع توحيد المكان: كان في الإعدادات، وحذفه
         منها بلا بديل يمنع اختيار النموذج أصلاً (تراجع وظيفي). كل نموذج قابل
         للنقر ⇒ use-provider بالاسم والنموذج معاً. */
      const modelIds = (p.models || []).map((m) => (typeof m === 'string' ? m : (m && m.id) || '')).filter(Boolean);
      const activeModel = ACTIVE_MODEL;
      /* النموذج غير القابل للتوليد لا يُعرض قابلاً للنقر (إصلاح 2026-11-13):
         كان بالإمكان اختياره ثم يفشل كل سؤال — عطل يبدو «عطب المنتج» وهو طاقة مزود. */
      const byId = new Map(info.map((m) => [m && m.id, m]));
      const modelChips = modelIds.length
        ? `<div class="mchips">${modelIds.slice(0, 12).map((m) => {
            const on = isActive && m === activeModel;
            const meta = byId.get(m);
            const dead = Boolean(meta && meta.canGenerate === false);
            const tip = dead ? ('⚠ ' + String(meta.probeError || t('failed')).slice(0, 80)) : (on ? t('model_active') : t('b_use_model'));
            return `<button type="button" class="mchip${on ? ' on' : ''}${dead ? ' off' : ''}"${dead ? ' disabled' : ''} data-model="${esc(m)}" data-prov="${esc(p.name || '')}" title="${esc(tip)}">${esc(m)}${on ? ' ✓' : ''}${dead ? ' ⚠' : ''}</button>`;
          }).join('')}${modelIds.length > 12 ? `<span class="hint mono">+${modelIds.length - 12}</span>` : ''}</div>`
        : '';

      /* سبب تعذّر النموذج (إصلاح 2026-11-13): «غير قابل للاستخدام» بلا سبب كان
         يترك المستخدم يظن العطل في المزود. السبب الآن معروض (طاقة ممتلئة/مفتاح/…). */
      const failed = info.filter((m) => m && m.canGenerate === false && m.probeError);
      const failLine = failed.length
        ? `<div class="pkey bad">⚠ ${esc(String(failed[0].id || ''))}: ${esc(String(failed[0].probeError).slice(0, 100))}</div>`
        : '';

      return `<div class="pcard">
        <div><div class="pname">${esc(p.name || t('provider_word'))}</div>
        <div class="purl">${esc(p.baseUrl || '')}</div>
        <div class="pkey">${esc(masked)} • ${models} ${t('models_unit')} • ${p.enabled === false ? esc(t('disabled')) : esc(t('enabled'))}${capChips ? ' • ' + capChips : ''}</div></div>
        ${probeLine}
        ${modelChips}
        ${failLine}
        <div class="pgrow">
          ${isActive ? '' : `<button class="btn ghost sm" data-use="${esc(p.name || '')}">${t('b_use')}</button>`}<button class="btn ghost sm" data-edit="${esc(p.name || '')}">${t('b_edit')}</button><button class="btn ghost sm" data-del="${esc(p.name || '')}">${t('b_delete')}</button>${activeChip}
          <button class="btn ghost sm" data-ping="${esc(p.name || '')}">${t('b_test')}</button>
        </div></div>`;
    }).join('');
    const sayAp = (msg, kind) => { const el = $id('ap-status'); if (!el) return; el.textContent = msg; el.className = 'hint mono' + (kind ? ' ' + kind : ''); };
    /* نقرة نموذج ⇒ فعّل المزود **بذلك النموذج** (المسار الخلفي يدعم model أصلاً) */
    host.querySelectorAll('[data-model]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.prov, model = b.dataset.model;
        b.disabled = true;
        sayAp(t('activating') + ' ' + name + ' · ' + model + '...');
        const r = await jpost('/api/models/use-provider', { name, model }).catch(() => null);
        b.disabled = false;
        sayAp(r && r.ok ? '✓ ' + name + ' · ' + (r.model || model) : '⚠ ' + ((r && r.error) || t('failed')), r && r.ok ? 'ok' : 'bad');
        if (r && r.ok) {
          const data = await API.settings();
          S.settings = (data && data.ai) ? data : (S.settings || {});
          await loadStatus();
          loadProviders();
        }
      };
    });
    host.querySelectorAll('[data-ping]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.ping;
        b.disabled = true;
        sayAp(t('testing') + ' ' + name + '…');
        const r = await jpost('/api/models/probe-provider', { name }).catch(() => null);
        b.disabled = false;
        sayAp(r && r.ok ? '✓ ' + name + ' — ' + (r.modelsCount || 0) + ' ' + t('models_unit') + (r.latencyMs ? ' · ' + r.latencyMs + 'ms' : '') : '⚠ ' + name + ' — ' + ((r && r.error) || t('failed')), r && r.ok ? 'ok' : 'bad');
        if (r && r.ok) loadProviders();
      };
    });
    host.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.use;
        b.disabled = true;
        sayAp(t('use_ok') + ' ' + name + '…');
        const r = await jpost('/api/models/use-provider', { name }).catch(() => null);
        b.disabled = false;
        sayAp(r && r.ok ? '✓ ' + name + ' — ' + (r.model || '') : '⚠ ' + name + ' — ' + ((r && r.error) || t('save_failed')), r && r.ok ? 'ok' : 'bad');
        loadStatus();
      };
    });
    /* تعديل مزود قائم (2026-11-13): يملأ النموذج بالبيانات الحالية ويحوّله لوضع
       التعديل. المفتاح يبقى فارغاً (لا يُقرأ بعد الحفظ) — تركه فارغاً يُبقيه. */
    host.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const name = b.dataset.edit;
        const list = (PROVIDERS_CACHE && (PROVIDERS_CACHE.providers || PROVIDERS_CACHE.items)) || [];
        const p = list.find((x) => x && x.name === name);
        if (!p) return;
        const set = (id, v) => { const el = $id(id); if (el) el.value = v == null ? '' : v; };
        set('ap-name', p.name);
        set('ap-url', p.baseUrl);
        set('ap-key', '');
        const keyEl = $id('ap-key'); if (keyEl) keyEl.placeholder = t('ph_key_keep');
        set('ap-model', (p.models || []).join(', '));
        const nm = $id('ap-name'); if (nm) nm.readOnly = true;
        /* التعديل يتبع نفس التدفق: افحص ⇒ اختر ⇒ احفظ. لا حفظ بلا فحص جديد
           (المزود قد يكون تغيّر عنوانه أو مفتاحه). */
        AP_TESTED = null; AP_PICKED = '';
        const wrapM = $id('ap-models-wrap'); if (wrapM) wrapM.classList.add('hidden');
        const hostM = $id('ap-models'); if (hostM) hostM.innerHTML = '';
        const saveBtn = $id('ap-save'); if (saveBtn) saveBtn.disabled = true;
        const card = $id('add-provider-card'); if (card) card.open = true;
        const form = $id('add-provider-form'); if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        sayAp('✎ ' + t('editing_word') + ' ' + p.name, '');
      };
    });
    host.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const name = b.dataset.del;
        if (!confirm(t('confirm_delete_provider') + ' ' + name + '؟')) return;
        b.disabled = true;
        const r = await jpost('/api/models/remove-provider', { name }).catch(() => null);
        b.disabled = false;
        sayAp(r && r.ok ? '✓ ' + t('deleted_word') + ' ' + name : '⚠ ' + ((r && r.error) || t('failed')), r && r.ok ? 'ok' : 'bad');
        loadProviders(); loadStatus();
      };
    });
  }

  /* تدفق الإضافة (أُعيد بناؤه 2026-11-13 بناءً على ملاحظة المستخدم):
     كان زر واحد «اختبر وأضف» يحفظ المزود ويختار له نموذجاً **تلقائياً** قبل أن
     يرى المستخدم الخيارات. التدفق الصحيح ثلاث خطوات صريحة:
       ١) املأ البيانات  ٢) اختبر ⇒ تُجلب النماذج  ٣) اختر نموذجاً ⇒ احفظ
     الحفظ لا يُفعَّل قبل اختيار نموذج. وبعد الحفظ: تُنظَّف الحقول ويُطوى القسم. */
  let AP_TESTED = null;   // نتيجة الفحص (نماذج + حالة)
  let AP_PICKED = '';     // معرّف النموذج الذي اختاره المستخدم

  function apRenderModels() {
    const wrap = $id('ap-models-wrap'), host = $id('ap-models');
    if (!wrap || !host) return;
    const models = (AP_TESTED && AP_TESTED.models) || [];
    if (!models.length) { wrap.classList.add('hidden'); host.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    host.innerHTML = models.map((m) => {
      const on = m.id === AP_PICKED;
      const dead = m.canGenerate === false;
      const tip = dead ? ('⚠ ' + String(m.error || t('failed')).slice(0, 90)) : m.id;
      const cls = 'mchip' + (on ? ' on' : '') + (dead ? ' off' : '');
      const dis = dead ? ' disabled' : '';
      const mark = on ? ' ✓' : (dead ? ' ⚠' : '');
      return '<button type="button" class="' + cls + '"' + dis + ' data-pick="' + esc(m.id) + '" title="' + esc(tip) + '">' + esc(m.id) + mark + '</button>';
    }).join('');
    host.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => { AP_PICKED = b.dataset.pick; apRenderModels(); apSyncSave(); };
    });
  }

  function apSyncSave() {
    const save = $id('ap-save');
    if (save) save.disabled = !(AP_TESTED && AP_TESTED.ok && AP_PICKED);
  }

  function apReset(keepOpen) {
    AP_TESTED = null; AP_PICKED = '';
    const f = $id('add-provider-form'); if (f) f.reset();
    const wrap = $id('ap-models-wrap'); if (wrap) wrap.classList.add('hidden');
    const host = $id('ap-models'); if (host) host.innerHTML = '';
    const nm = $id('ap-name'); if (nm) nm.readOnly = false;
    const k = $id('ap-key'); if (k) k.placeholder = 'sk-…';
    apSyncSave();
    if (!keepOpen) { const card = $id('add-provider-card'); if (card) card.open = false; }
  }

  function wireAddProvider() {
    const f = $id('add-provider-form'); if (!f) return;
    const say = (msg, kind) => {
      const el = $id('ap-status'); if (!el) return;
      el.textContent = msg; el.className = 'hint mono' + (kind ? ' ' + kind : '');
    };

    const readForm = () => {
      const nameEl = $id('ap-name');
      const editing = Boolean(nameEl && nameEl.readOnly);
      const name = nameEl.value.trim();
      const url = $id('ap-url').value.trim();
      const key = $id('ap-key').value.trim();
      const manualModel = String($id('ap-model') && $id('ap-model').value || '').trim();
      const manualModels = manualModel ? manualModel.split(',').map((x) => x.trim()).filter(Boolean) : [];
      return { editing: editing, name: name, url: url, key: key, manualModels: manualModels };
    };

    const validate = (v) => {
      if (!v.name || !v.url || (!v.key && !v.editing)) return v.editing ? t('fill_url_only') : t('fill_three');
      const isAscii = (x) => !/[^\x20-\x7E]/.test(x);
      if (!isAscii(v.url)) return t('err_url_ascii');
      if (v.key && !isAscii(v.key)) return t('err_key_ascii');
      if (!/^https?:\/\//i.test(v.url)) return t('err_url_http');
      return '';
    };

    // ٢) الفحص: يجلب النماذج بلا حفظ
    const testBtn = $id('ap-test');
    if (testBtn) testBtn.onclick = async () => {
      const v = readForm();
      const bad = validate(v);
      if (bad) { say(bad, 'bad'); return; }
      testBtn.disabled = true; say(t('progress_connect'));
      const body = { name: v.name, baseUrl: v.url, apiKey: v.key };
      if (v.manualModels.length) body.models = v.manualModels;
      const r = await jpost('/api/models/test-provider', body).catch(() => null);
      testBtn.disabled = false;
      AP_TESTED = r; AP_PICKED = '';
      if (!r || !r.ok) {
        apRenderModels();
        say('⚠ ' + ((r && r.error) || t('failed')) + ((r && r.step) ? ' (' + r.step + ')' : ''), 'bad');
        apSyncSave();
        return;
      }
      const usable = (r.models || []).filter((m) => m.canGenerate !== false);
      apRenderModels();
      say(usable.length ? (t('tested_ok') + ' — ' + usable.length + ' ' + t('models_unit') + ' · ' + t('pick_one')) : t('no_usable_model'), usable.length ? 'ok' : 'bad');
      apSyncSave();
    };

    // ٣) الحفظ: يرسل النموذج المختار صراحةً
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const v = readForm();
      const bad = validate(v);
      if (bad) { say(bad, 'bad'); return; }
      if (!AP_TESTED || !AP_TESTED.ok) { say(t('test_first'), 'bad'); return; }
      if (!AP_PICKED) { say(t('pick_one'), 'bad'); return; }
      const saveBtn = $id('ap-save');
      if (saveBtn) saveBtn.disabled = true;
      say(t('saving_word'));
      const body = { name: v.name, baseUrl: v.url, apiKey: v.key, model: AP_PICKED };
      if (v.manualModels.length) body.models = v.manualModels;
      const r = await jpost('/api/models/add-provider', body).catch(() => null);
      if (r && r.ok) {
        say((v.editing ? t('saved_word') : t('add_ok')) + ' — ' + AP_PICKED, 'ok');
        apReset(false);
        loadProviders(); loadStatus();
      } else {
        say('⚠ ' + ((r && r.error) || t('failed')), 'bad');
        apSyncSave();
      }
    };
  }

  // ─────────── ⑤ الاستيراد ───────────
async function loadImport() {
  const d = await jget('/api/import/supported');
  const host = $id('import-formats'); const sel = $id('import-format');
  const fmts = (d && (d.extensions || d.formats || d.items)) || (Array.isArray(d) ? d : []);
  if (host) host.innerHTML = fmts.map((x) => { const s = typeof x === 'string' ? x : (x.ext || x.name || ''); return `<span class="fmt-chip mono">${esc(s)}</span>`; }).join('') || '<span class="hint mono">—</span>';
  if (sel && sel.options.length <= 1) fmts.forEach((x) => { const s = typeof x === 'string' ? x : (x.ext || x.name || ''); const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
  /* المشروع: كان الحقل في النافذة وحدها فيُستورد بلا مشروع من هنا (تدقيق 2026-11-06) */
  const proj = $id('import-project');
  if (proj && !proj.value) proj.value = S.projectFilter || '';
  loadImportedDocs();
}

/* ما استُورد — مرآة (2026-11-13): كان الاستيراد يكتب في القاعدة ولا يعرض شيئاً،
   فلا المستخدم يرى ما أدخله ولا يعرف أن مصدره ذهب. */
async function loadImportedDocs() {
  const host = $id('imports-list'); if (!host) return;
  const d = await jget('/api/imports?limit=50').catch(() => null);
  const docs = (d && d.documents) || [];
  const cnt = $id('imports-count');
  if (cnt) cnt.textContent = docs.length ? `(${docs.length}${d && d.missingSources ? ' · ' + t('imp_missing_src') + ' ' + d.missingSources : ''})` : '';
  if (!docs.length) { host.innerHTML = '<div class="hint mono">' + t('imp_none_yet') + '</div>'; return; }
  host.innerHTML = docs.map((x) => {
    const gone = x.source && x.sourceExists === false;
    const when = x.importedAt ? String(x.importedAt).slice(0, 10) : '—';
    const src = x.source ? String(x.source) : '—';
    return `<div class="tree-i">
      <span class="t mono">${esc(x.title || x.id)}</span>
      <span class="n mono dim">${esc(x.kind || '')} · ${esc(when)}</span>
      <span class="n mono ${gone ? 'bad' : 'dim'}" title="${esc(src)}">${gone ? '⚠ ' + t('imp_src_gone') : '✓ ' + t('imp_src_ok')}</span>
    </div>`;
  }).join('');
}
function wireImport() {
  const f = $id('import-form'); if (!f) return;
  const pv = $id('import-preview-btn'); if (pv) pv.onclick = previewImportNow;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const path = $id('import-path').value.trim(), format = $id('import-format').value;
    const project = $id('import-project') ? $id('import-project').value.trim() : '';
    const st = $id('import-status'), out = $id('import-result');
    if (!path) return;
    if (st) st.textContent = t('busy_import');
/* أي مسار يخصّ هذا المصدر؟ مستودع git ⇒ /api/import/remote (استنساخ حقيقي)،
   رابط عام ⇒ /api/import/web، وإلا مسار محلي (الخادم يفرّق بين ملف ومجلد).
   قبل هذا: كل https كان يذهب لجالب الويب — فرابط GitHub يرجع صفحة HTML فارغة
   (مُقاس 2026-11-06: kind=code و0 حرف) رغم وجود محرّك استنساخ كامل معطَّل. */
function importRouteFor(value) {
  const v = String(value || '').trim();
  if (!/^https?:\/\//i.test(v)) return 'local';
  if (/\.git$/i.test(v)) return 'git';
  try {
    const h = new URL(v).hostname.toLowerCase();
    if (h === 'github.com' || h === 'www.github.com' || h === 'gitlab.com' || h === 'bitbucket.org') return 'git';
    return 'web';
  } catch (e) { return 'web'; }
}
    /* كشف تلقائي: رابط http(s) ⇒ استيراد ويب · وإلا مسار ملف أو مجلد (الخادم يفرّق) */
    const route = importRouteFor(path);
    const r = route === 'git'
      ? await jpost('/api/import/remote', { url: path, project, depth: 1 })
      : (route === 'web'
        ? await jpost('/api/import/web', { url: path, project })
        : await jpost('/api/import', { path, format, project }));
    const ok = !!(r && !r.error);
    /* الاستيراد الدفعي (مجلد أو مستودع git) يعيد scanned/created — كان السطر يفترض
       «عنصر واحد» فيُعلن «أُنشئ 1» بعد استنساخ مستودع أنشأ 8 (مُقاس 2026-11-06). */
    const isBatch = ok && (r.folder || r.scanned !== undefined);
    const line = !ok ? '' : (isBatch
      ? `${t('imp_scanned')} ${r.scanned} · ${t('imp_created')} ${r.created} · ${t('imp_skipped')} ${r.skipped}${r.quarantined != null ? ' · ' + t('imp_quar') + ' ' + r.quarantined : ''}`
      : `${t('imp_created')} 1 — ${r.path || ''}${r.deduplicated ? ' · ' + (r.note || '') : ''}`);
    if (st) st.textContent = ok ? t('done_ok') + ' ' + line : '⚠ ' + ((r && r.error) || t('failed'));
    if (out) {
      out.classList.remove('hidden'); out.className = 'banner ' + (ok ? 'ok' : 'bad');
      out.textContent = ok && isBatch
        ? [line, ...((r.perFile || []).slice(0, 40).map(x => `• ${x.path || ''} — ${x.error ? serverText(x.error) : (x.quarantined ? t('src_quarantined') : 'ok')}`))].join('\n')
        : (ok ? line : JSON.stringify(r, null, 2).slice(0, 2500));
    }
    if (ok) { f.reset(); loadNotes(); loadDashboard(); loadStatus(); loadImportedDocs(); }
  };
}

  // ─────────── ⑥ المستودعات ───────────
  // المسارات الفعلية GET بمعامل path — (كانت الواجهة تنادي POST فتحصل 404).
  let REPO_PATH = '';
  const REPO_KEY = 'cortex.repoIndex';
  /* آخر فهرسة تُحفظ محلياً: كانت تضيع مع أول تحديث، فيعود القسم فراغاً. */
  function repoSave(d, path) {
    try {
      const keep = { path, at: Date.now(), root: d.root, files: d.files, dirs: d.dirs, bytes: d.bytes, code: d.code, docs: d.docs, tests: d.tests, byExt: d.byExt, entryPoints: d.entryPoints, truncated: !!d.truncated };
      localStorage.setItem(REPO_KEY, JSON.stringify(keep));
    } catch (e) { /* تخزين محلي ممتلئ/محجوب */ }
  }
  /* ذاكرة الوكيل في قسم المستودعات (إصلاح 2026-11-13): كان القسم يستعيد من
     localStorage فقط، فيبدو فارغاً ولو فهرس الوكيل مستودعات. الآن يُقرأ من
     الخادم: ما يعرفه الوكيل يظهر، والضغط على صف يحمّل حوافه المخزَّنة بلا مسح. */
  async function repoLoadSaved() {
    const host = $id('repo-saved');
    if (!host) return;
    const d = await jget('/api/repos');
    const repos = (d && d.repos) || [];
    if (!repos.length) { host.innerHTML = ''; return; }
    const hint = document.getElementById('repo-hint'); if (hint) hint.remove();
    host.innerHTML = '<div class="sec">' + t('s_repo_memory') + '</div>' + repos.map((r) => {
      const base = String(r.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r.path;
      const when = r.lastIndexed ? new Date(r.lastIndexed).toLocaleString() : '—';
      return `<div class="tree-i" data-repo="${esc(r.id)}" data-path="${esc(r.path)}" role="button" tabindex="0">
        <span class="t mono">${esc(base)}</span>
        <span class="n">${r.files} ${esc(t('rb_files'))} · ${r.edges} ${esc(t('s_deps'))}</span>
        <span class="n mono dim">${esc(when)}</span>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-repo]').forEach((el) => {
      const open = () => repoSavedOpen(el.dataset.repo, el.dataset.path);
      el.onclick = open;
      el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
  }

  async function repoSavedOpen(id, path) {
    REPO_PATH = path || REPO_PATH;
    const f = $id('repo-path'); if (f && !f.value) f.value = path || '';
    repoBanner('⬡ «' + String(path || '').split(/[\\/]/).pop() + '» — ' + t('rb_from_memory'), 'ok');
    const host = $id('repo-deps');
    if (host) host.innerHTML = '<div class="hint mono">⏳…</div>';
    const d = await jget('/api/repo/deps?repo=' + encodeURIComponent(id));
    if (!host) return;
    if (!d || d.error) { host.innerHTML = '<div class="hint mono">⚠ ' + esc((d && d.error) || t('failed')) + '</div>'; return; }
    const edges = d.edges || [];
    const cnt = $id('repo-file-count'); if (cnt) cnt.textContent = String((d.repo && d.repo.file_count) || 0);
    host.innerHTML = '<div class="hint">' + t('rb_stored_edges') + ' ' + edges.length + '</div>' +
      (edges.slice(0, 60).map((e) => `<div class="hint mono">${esc(e.from_file)} → ${esc(e.to_file)}</div>`).join('') || '<div class="hint mono">' + t('no_internal_deps') + '</div>');
  }

  function repoRestore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(REPO_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.path) return;
    const f = $id('repo-path'); if (f && !f.value) f.value = saved.path;
    REPO_PATH = saved.path;
    repoRenderResult(saved, saved.path);
  }

  function repoBanner(msg, kind) {
    const st = $id('repo-status'); if (!st) return;
    st.classList.remove('hidden');
    st.className = 'banner' + (kind ? ' ' + kind : '');
    st.textContent = msg;
  }

  /* عرض نتيجة الفهرس — مشترك بين الفهرسة الحيّة والاستعادة من التخزين المحلي */
  function repoRenderResult(d, path) {
    const total = Number(d.files) || 0;
    const cnt = $id('repo-file-count'); if (cnt) cnt.textContent = String(total);
    const hint = document.getElementById('repo-hint'); if (hint) hint.remove();
    repoBanner('✅ «' + path + '»: ' + total + ' ' + t('rb_files') + ' · ' + (d.dirs || 0) + ' ' + t('rb_dirs') + ' · ' + Math.round((d.bytes || 0) / 1024) + 'KB · ' + t('rb_code') + ' ' + (d.code || 0) + ' · ' + t('rb_docs') + ' ' + (d.docs || 0) + ' · ' + t('rb_tests') + ' ' + (d.tests || 0) + (d.truncated ? ' · ⚠ ' + t('rb_partial') : ''), 'ok');
    // توزيع الامتدادات
    const host = $id('repo-files');
    if (host) {
      const by = d.byExt || {};
      const rows = Object.keys(by).sort((a, b) => by[b] - by[a]).slice(0, 40)
        .map((e) => `<div class="tree-i"><span class="t mono">${esc(e)}</span><span class="n">${by[e]}</span></div>`).join('');
      const root = String(d.root || '').replace(/[\\/]+$/, '');
      const eps = (d.entryPoints || []).slice(0, 10).map((p2) => `<div class="tree-i" data-file="${esc(p2)}"><span class="t mono">${esc(p2)}</span><button class="icon-btn mini" data-view-file="${esc(root + '/' + p2)}" title="${esc(t('view_file'))}">↗</button><span class="n">${t('entry_word')}</span></div>`).join('');
      host.innerHTML = (eps ? '<div class="sec">' + t('s_entry_points') + '</div>' + eps : '') +
        (rows ? '<div class="sec">' + t('s_extensions') + '</div>' + rows : '<div class="hint mono">' + t('no_files') + '</div>');
      host.querySelectorAll('[data-file]').forEach((el) => { el.onclick = () => { const i2 = $id('impact-file'); if (i2) i2.value = el.dataset.file; }; });
      // عرض الملف بنقرة (م27): يفتح عارض القراءة على المسار المطلق نفسه
      host.querySelectorAll('[data-view-file]').forEach((el) => { el.onclick = (ev) => { ev.stopPropagation(); openFileViewer(el.getAttribute('data-view-file')); }; });
    }
  }

  async function repoIndex() {
    const path = ($id('repo-path') && $id('repo-path').value.trim()) || '.';
    REPO_PATH = path;
    repoBanner('⏳ ' + t('indexing') + ' «' + path + '»...');
    const d = await jget('/api/repo/index?path=' + encodeURIComponent(path));
    if (!d || d.error) { repoBanner('⚠ ' + ((d && d.error) || t('index_failed')), 'bad'); return; }
    repoSave(d, path);
    repoRenderResult(d, path);
    await repoDeps(path);
  }

  async function repoDeps(path) {
    const d = await jget('/api/repo/deps?path=' + encodeURIComponent(path || REPO_PATH));
    const host = $id('repo-deps');
    if (!host) return;
    if (!d || d.error) { host.innerHTML = '<div class="hint mono">⚠ ' + esc((d && d.error) || t('failed')) + '</div>'; return; }
    const edges = d.edges || [];
    const ext = d.external || [];
    host.innerHTML = '<div class="hint">' + t('deps_scanned') + ' ' + (d.filesScanned || 0) + ' ' + t('rb_files') + ' (' + t('deps_code_only') + ') · ' + (d.internalEdges || 0) + ' ' + t('deps_internal') + ' · ' + (d.externalCount || 0) + ' ' + t('deps_external') + '</div>' +
      (edges.slice(0, 60).map((e) => `<div class="hint mono">${esc(e.from || e.source)} → ${esc(e.to || e.target)}</div>`).join('') || '<div class="hint mono">' + t('no_internal_deps') + '</div>') +
      (ext.length ? '<div class="sec">' + t('ext_packages') + '</div>' + ext.slice(0, 20).map((x) => `<div class="hint mono">${esc(typeof x === 'string' ? x : (x.name || JSON.stringify(x)))}</div>`).join('') : '');
  }

  async function repoImpact() {
    const file = ($id('impact-file') && $id('impact-file').value.trim()) || '';
    const host = $id('impact-list'); if (!host) return;
    if (!file) { host.innerHTML = '<div class="hint mono">' + t('type_file_first') + '</div>'; return; }
    host.innerHTML = '<div class="hint mono">⏳…</div>';
    const path = REPO_PATH || '.';
    const d = await jget('/api/repo/impact?path=' + encodeURIComponent(path) + '&file=' + encodeURIComponent(file));
    if (!d || d.error) { host.innerHTML = '<div class="hint mono">⚠ ' + esc((d && d.error) || t('failed')) + '</div>'; return; }
    const dep = d.dependsOn || [], db = d.dependedBy || [], aff = d.affectedFiles || [];
    host.innerHTML = `<div class="hint">${t('depends_on_cnt')} ${d.dependsOnCount || 0} · ${t('depended_by_cnt')} ${d.dependedByCount || 0} · ${t('affected_cnt')} ${aff.length}</div>` +
      (aff.slice(0, 40).map((x) => `<div class="hint mono">${esc(typeof x === 'string' ? x : (x.path || x.file))}</div>`).join('') ||
       dep.concat(db).slice(0, 40).map((x) => `<div class="hint mono">${esc(typeof x === 'string' ? x : (x.path || x.file))}</div>`).join('') ||
       '<div class="hint mono">' + t('no_impact') + '</div>') +
      `<div class="hint mono">${esc(d.note || '')}</div>`;
  }

  function wireRepos() {
    const b = $id('repo-index'); if (b) b.onclick = () => repoIndex();
    const i2 = $id('impact-run'); if (i2) i2.onclick = () => repoImpact();
    const f = $id('repo-path');
    if (f) f.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); repoIndex(); } };
  }

  // ─────────── ⑦ المراقبة ───────────
    async function loadMonitor() {
    const set = (id, v) => { const e = $id(id); if (e) e.textContent = v; };

    // ① قائمة التشغيلات — نملأ القائمة ونختار المطلوب أو الأحدث
    const sel = $id('mon-run');
    const pick = sel ? sel.value : '';
    const runsData = await jget('/api/agent/runs');
    const runs = (runsData && runsData.runs) || [];
    if (sel) {
      sel.innerHTML = runs.length
        ? runs.map((r) => `<option value="${esc(r.runId)}">${esc(r.runId.slice(-12))} — ${r.tasks} ${t('unit_tasks')} · ${r.done} ${t('unit_done')}${r.failed ? ' · ' + r.failed + ' ' + t('unit_failed') : ''}</option>`).join('')
        : '<option value="">' + t('no_runs') + '</option>';
      if (pick) sel.value = pick;
      if (!sel.value && runs.length) sel.value = runs[0].runId;
    }
    const runId = sel ? sel.value : (runs[0] ? runs[0].runId : '');

    // ② حكم المراقب الصارم
    const m = await jget('/api/agent/monitor' + (runId ? '?runId=' + encodeURIComponent(runId) : ''));
    const verdictMap = { accepted: t('verdict_accepted'), rejected: t('verdict_rejected'), conditional: t('verdict_conditional'), empty: t('verdict_empty') };
    const vEl = $id('mon-verdict');
    if (vEl) {
      const v = m && m.verdict ? m.verdict : 'empty';
      vEl.textContent = verdictMap[v] || v;
      vEl.className = 'card-v ' + (v === 'accepted' ? 'ok' : (v === 'rejected' ? 'bad' : ''));
    }
    set('mon-steps', m && m.steps != null ? m.steps : 0);
    set('mon-ok', m && m.done != null ? m.done : 0);
    set('mon-fail', m && m.failed != null ? m.failed : 0);
    set('mon-avg', m && m.successRate != null ? m.successRate + '%' : '—');
    set('mon-parallel', m && m.peakConcurrency != null ? m.peakConcurrency : 0);
    set('mon-dur', m && m.avgDurationMs ? ltrIso(m.avgDurationMs >= 1000 ? (m.avgDurationMs / 1000).toFixed(1) + t('sec_unit') : m.avgDurationMs + 'ms') : '—');
    const up = $id('mon-updated'); if (up) up.textContent = new Date().toLocaleTimeString(LANG === 'en' ? 'en-US' : 'ar-EG');

    // ③ أسباب الحكم — الشفافية
    const rEl = $id('mon-reasons');
    if (rEl && m && m.reasons) {
      const r = m.reasons;
      const tick = (v) => (v ? '✔' : '✖');
      rEl.textContent = [tick(r.allTasksTerminal) + ' ' + t('r_all_terminal'),
        tick(r.noFailures) + ' ' + t('r_no_failures'),
        tick(r.allDoneHaveEvidence) + ' ' + t('r_evidence'),
        tick(r.hasVerifier) + ' ' + t('r_verifier'),
        tick(r.claimsVerified) + ' ' + t('r_claims')].join(' · ');
      // حُكم المراقبة: إرشاد «ماذا أفعل» تحت الأسباب مباشرة — يصل من الخادم (advice[])
      const advEl = $id('mon-advice');
      if (advEl) {
        const adv = Array.isArray(m.advice) ? m.advice : [];
        advEl.innerHTML = adv.length
          ? adv.map((a) => `<div class="fc"><div class="fk">→ ${esc(a.reason)} · ${esc(a.fix || '')}</div>${esc(stripMd(a.text))}</div>`).join('')
          : '';
      }
    }

    // ④ الاعتراضات — جوهر الصرامة
    const ob = (m && m.objections) || [];
    const oh = $id('mon-objections');
    if (oh) {
      oh.innerHTML = ob.length
        ? ob.map((o) => `<div class="fc sev-${esc(o.severity)}"><div class="fk">${esc(o.severity === 'high' ? t('sev_high') : t('sev_medium'))} · ${esc(o.code)}</div>${esc(stripMd(o.message))}</div>`).join('')
        : '<div class="fc" style="border-inline-start-color:var(--teal)"><div class="fk">' + t('no_objections') + '</div>' + t('no_objections_body') + '</div>';
    }

    // ⑤ مهام التشغيل من سجلّ المنسّق
    const tb = $id('sp-tasks');
    const rt = runId ? await jget('/api/agent/tasks?runId=' + encodeURIComponent(runId)) : { tasks: [] };
    const tasks = (rt && rt.tasks) || [];
    const evCount = {};
    for (const e of ((rt && rt.events) || [])) {
      const k = e.task_id != null ? e.task_id : e.taskId;
      if (e.type === 'tool_result') evCount[k] = (evCount[k] || 0) + 1;
    }
    if (tb) tb.innerHTML = tasks.length
      ? tasks.map((tk) => {
          const short = String(tk.id).split('-').pop();
          const cls = tk.status === 'done' ? 'ok' : (tk.status === 'failed' ? 'bad' : '');
          const st = tk.status === 'done' ? t('st_done') : (tk.status === 'failed' ? t('st_failed') : (tk.status === 'blocked' ? t('st_blocked') : tk.status));
          const ev = evCount[tk.id] || 0;
          return `<tr><td class="mono dim">${esc(short)}</td><td>${esc(tk.role)}</td><td class="${cls}">${esc(String(st))}</td><td>${ev ? ev + ' ' + t('ev_unit') : '<span class="dim">' + t('no_evidence') + '</span>'}</td><td class="mono dim">${esc(String(tk.goal || '').slice(0, 60))}</td></tr>`;
        }).join('')
      : '<tr><td colspan="5" class="hint mono">' + t('no_runs_hint') + '</td></tr>';

    // ⑥ مهام الملف (ملاحظات) — القسم السفلي
    const d = await jget('/api/tasks');
    const vaultRows = (d && (d.tasks || d.items)) || [];
    const hb = $id('sp-healthbars');
    if (hb) {
      hb.innerHTML = tasks.slice(0, 24).map((t) => {
        const n = evCount[t.id] || 0;
        const h = Math.max(4, Math.min(60, n * 7));
        return `<span class="hbwrap"><i class="bar" style="height:${h}px"></i><i class="n">${esc(String(t.role || '').slice(0, 4))}</i></span>`;
      }).join('') || '<span class="hint mono">—</span>';
    }

    set('sp-health', m && m.successRate != null ? m.successRate : '—');
    const sp = $id('sp-project');
    if (sp) sp.textContent = runId ? t('run_word') + ' ' + ltrIso(runId) : t('no_run_word');
    const ss = $id('sp-summary');
    if (ss) ss.textContent = m
      ? `${m.steps} ${t('unit_tasks')} · ${m.done} ${t('unit_done')} · ${m.failed} ${t('unit_failed')} · ${t('unit_par')} ${m.peakConcurrency} · ${((m.objections || []).length)} ${t('unit_obj')}`
      : '—';

    const fin = await jget('/api/agent/findings');
    const fl = fin && !fin.error ? (fin.findings || fin.items || (Array.isArray(fin) ? fin : [])) : [];
    const ah = $id('sp-actions');
    // نصوص الوكيل تُترجم عبر serverText (قوالب الخادم معروفة) — العرض في وضع EN لا يبقى عربياً
    if (ah) ah.innerHTML = fl.slice(0, 30).map((f) => `<div class="fc"><div class="fk">${esc(f.kind || f.role || t('note_word'))}</div>${esc(serverText(String(f.text || f.message || f.summary || '')).slice(0, 320))}</div>`).join('') || '<div class="hint mono">' + t('no_findings_yet') + '</div>';
    const gEl = $id('sp-gaps');
    if (gEl) gEl.innerHTML = vaultRows.length
      /* نصوص التوصيات/الفجوات يولّدها الخادم عربياً ⇒ تمرّ بـserverText() في وضع EN.
         العطل المُثبت حياً 2026-10-20 (06-i18n-audit): كانت تُدرج مباشرةً فتظهر
         «هناك مهام مفتوحة دون إجراءات أو runbook واضح» و«أجب عن السؤال المفتوح: …»
         داخل واجهة إنجليزية — عطل ترجمة حقيقي في شاشتَي المراقبة والمستودعات. */
      ? vaultRows.slice(0, 20).map((t) => `<div class="hint">${esc(serverText(String(t.text || t.title || '')).slice(0, 140))}</div>`).join('')
      : '<div class="hint mono">' + t('no_file_tasks') + '</div>';
  }

  // ═══ تشغيل الفريق المتوازي — بثّ حيّ لكل دور ═══
  let TEAM_CTRL = null;
  async function runTeam(goal, project, maxParallel) {
    const live = $id('team-live');
    const sum = $id('team-summary');
    const stop = $id('team-stop');
    if (live) live.innerHTML = '';
    if (sum) { sum.classList.add('hidden'); sum.textContent = ''; }
    const counters = document.querySelectorAll('.tcard');
    counters.forEach((c) => c.remove());
    if (stop) stop.hidden = false;

    const roles = new Map();
    const card = (role, id) => {
      const key = role + ':' + id;
      if (roles.has(key)) return roles.get(key);
      const el = document.createElement('div');
      el.className = 'tcard';
      el.innerHTML = `<div class="tcard-h"><span class="trole">${esc(role)}</span><span class="tst">${t('waiting')}</span></div><div class="tcard-b"></div>`;
      if (live) live.appendChild(el);
      const rec = { el, body: el.querySelector('.tcard-b'), st: el.querySelector('.tst') };
      roles.set(key, rec);
      return rec;
    };

    try {
      TEAM_CTRL = new AbortController();
      const res = await fetch('/api/agent/orchestrate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(await hdr()) },
        body: JSON.stringify({ goal, project, maxParallel, stream: true }),
        signal: TEAM_CTRL.signal
      });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      let final = null;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const ln of lines) {
          const s = ln.trim(); if (!s.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }

          if (ev.type === 'orc_event' && ev.event) {
            const e = ev.event, p = e.payload || {};
            // أحداث التشغيل العامة (run_created/run_finished) بلا دور وبلا مهمة —
            // إنشاء بطاقة لها يولّد بطاقات وهمية (عطل مؤكد: 11 بطاقة لـ5 مهام).
            const tid = String(e.taskId || '').split('-').pop();
            const role = p.role || (tid ? t('role_word') : '');
            if (!role) continue;
            const rec = card(role, tid);
            if (e.type === 'task_started') { rec.st.textContent = t('w_running'); rec.el.classList.add('running'); }
            else if (e.type === 'task_evidence') { rec.body.insertAdjacentHTML('beforeend', `<span class="tchip">⚙ ${esc(p.tool || t('tool_word'))}</span>`); rec.el.classList.add('has-ev'); }
            else if (e.type === 'task_done') { rec.st.textContent = t('w_done'); rec.el.classList.add('done'); rec.el.classList.remove('running'); }
            else if (e.type === 'task_failed') { rec.st.textContent = t('w_failed'); rec.el.classList.add('failed'); rec.el.classList.remove('running'); rec.body.insertAdjacentHTML('beforeend', `<div class="terr">${esc(p.error || '')}</div>`); }
            else if (e.type === 'task_blocked') { rec.st.textContent = t('w_blocked'); rec.el.classList.add('failed'); rec.el.classList.remove('running'); }
          } else if (ev.type === 'orc_done') {
            final = ev;
          } else if (ev.type === 'orc_error') {
            if (sum) { sum.classList.remove('hidden'); sum.className = 'banner bad'; sum.textContent = '⚠ ' + (ev.error || t('failed')); }
          }
        }
      }

      if (final) {
        const okN = (final.tasks || []).filter((t) => t.status === 'done').length;
        const badN = (final.tasks || []).filter((t) => t.status === 'failed' || t.status === 'blocked').length;
        if (sum) {
          sum.classList.remove('hidden');
          sum.className = 'banner ' + (badN === 0 ? 'ok' : 'bad');
          sum.innerHTML = `<b>${t('sum_result')}</b> ${okN} ${t('sum_done')} · ${badN} ${t('sum_not')} · ${t('sum_verdict')} ${final.verified ? t('verified') : t('unverified')}<br><span class="mono dim">runId: ${esc(final.runId || '')}</span>`;
        }
        // حدّث المراقبة فوراً وانتقل إليها
        await loadMonitor();
      }
    } catch (e) {
      if (e.name !== 'AbortError' && sum) { sum.classList.remove('hidden'); sum.className = 'banner bad'; sum.textContent = t('err_prefix') + ' ' + e.message; }
    } finally {
      if (stop) stop.hidden = true;
      TEAM_CTRL = null;
    }
  }

  // ═══ فلترة المعرفة: بحث + نوع + عدّاد ═══
  function applyNotesFilter() {
    const q = $id('notes-search'), ty = $id('notes-type'), cl = $id('notes-clear'), cnt = $id('notes-count');
    if (q) S.libSearch = q.value;
    if (ty) S.libType = ty.value;
    if (cl) cl.hidden = !(S.libSearch || S.libType);
    try { if (typeof renderSidebar === 'function') renderSidebar(); } catch (e) { console.warn('renderSidebar', e); }
    // الترتيب بالصلة يأتي من المحرّك بعد وصول الرد (تحديث ثانٍ للقائمة)
    scheduleLibSemantic();
    const empty = $id('empty-state');
    if (empty) {
      const total = (S.notes || []).length;
      const shown = cnt ? parseInt(String(cnt.textContent).split('/')[0], 10) || 0 : total;
      empty.classList.toggle('hidden', !(total === 0 || (shown === 0 && (S.libSearch || S.libType))));
    }
  }
  /* بحث المعرفة الدلالي — مؤجَّل 260ms، ولا يُلغي الفلتر النصي عند الفشل */
  let libSemTimer = null;
  let libSemSeq = 0;
  function scheduleLibSemantic() {
    const q = String(S.libSearch || '').trim();
    if (libSemTimer) clearTimeout(libSemTimer);
    if (q.length < 2) { S.libRank = []; return; }
    const seq = ++libSemSeq;
    libSemTimer = setTimeout(async () => {
      libSemTimer = null;
      const r = await jget('/api/search?q=' + encodeURIComponent(q) + '&limit=60').catch(() => null);
      if (seq !== libSemSeq) return;                 // رد قديم: تُجوهل
      const ids = ((r && r.results) || []).map(x => x.id).filter(Boolean);
      S.libRank = ids;
      try { renderSidebar(); } catch (e) { /* القائمة تحسينية */ }
      updateLibHint(ids.length, q);
    }, 260);
  }

  function updateLibHint(n, q) {
    const el = $id('notes-count');
    if (!el) return;
    if (!q) return;
    el.title = n ? (t('lib_semantic_hits') + ': ' + n) : t('lib_semantic_none');
  }

  /* عرض جواب «اسأل مكتبتك» (2026-11-15): كان يُعرض خاماً فتظهر ## و** حرفياً.
     الترتيب مهم: هروب أولاً ثم إضافة وسومنا — لا يُقبل HTML من النموذج. */
  function renderAskAnswer(md) {
    return esc(String(md || ''))
      .replace(/^###\s+(.+)$/gm, '<div class="ask-h3">$1</div>')
      .replace(/^##\s+(.+)$/gm, '<div class="ask-h2">$1</div>')
      .replace(/^#\s+(.+)$/gm, '<div class="ask-h1">$1</div>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/^[-*]\s+(.+)$/gm, '<div class="ask-li">• $1</div>')
      .replace(/\[(\d+)\]/g, '<span class="ask-cite">[$1]</span>')
      .replace(/\n{2,}/g, '<div style="height:6px"></div>')
      .replace(/\n/g, '<br>');
  }

  /* اسأل مكتبتك (2026-11-15): جواب بمقاطع ومصادر مرقّمة — أو «لا أعرف».
     المصادر أزرار: نقرة تفتح الملاحظة التي جاء منها الجواب. */
  function wireAsk() {
    const f = $id('ask-form');
    if (!f) return;
    const out = $id('ask-out');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const q = String(($id('ask-input') || {}).value || '').trim();
      const btn = $id('ask-submit');
      if (q.length < 2) return;
      if (btn) btn.disabled = true;
      if (out) out.innerHTML = '<div class="hint mono">' + t('ask_thinking') + '</div>';
      const r = await jpost('/api/ask', { question: q }).catch(() => null);
      if (btn) btn.disabled = false;
      if (!out) return;
      if (!r || (!r.answer && r.error)) { out.textContent = '⚠ ' + ((r && r.error) || t('failed')); return; }
      const chips = (r.citations || []).map(c => '<button type="button" class="mchip" data-open-note="' + esc(c.id) + '">[' + c.n + '] ' + esc(c.title) + '</button>').join(' ');
      out.innerHTML = '<div class="ask-answer">' + renderAskAnswer(r.answer) + '</div>' +
        (chips ? '<div class="row gap" style="margin-top:6px;flex-wrap:wrap">' + chips + '</div>' : '') +
        '<div class="hint mono">' + (r.noEvidence ? '⚠ ' + t('ask_none') + ' · ' : '') + (r.ms || 0) + 'ms</div>';
      out.querySelectorAll('[data-open-note]').forEach((b) => {
        b.onclick = () => { try { switchView('notes'); openNote(b.dataset.openNote); } catch (e) { /* الملاحظة قد تكون محذوفة */ } };
      });
    };
  }

  function wireNotesFilter() {
    const q = $id('notes-search'), ty = $id('notes-type'), cl = $id('notes-clear');
    let t = null;
    if (q) q.oninput = () => { clearTimeout(t); t = setTimeout(applyNotesFilter, 180); };
    if (ty) ty.onchange = applyNotesFilter;
    if (cl) cl.onclick = () => {
      if (q) q.value = ''; if (ty) ty.value = '';
      S.libSearch = ''; S.libType = ''; S.libRank = [];
      applyNotesFilter();
    };
    applyNotesFilter();
  }

  function wireTeam() {
    /* بلا منتقي وضع (2026-10-30): الوكيل يقرر من الجملة — «فريق» في نصّها يستدعي الفريق.
       بقيت أدوات التحكم الحيّ فقط (إيقاف التشغيل الجاري + منتقي تشغيل المراقبة). */
    const st = $id('team-stop');
    if (st) st.onclick = () => { if (TEAM_CTRL) TEAM_CTRL.abort(); };
    const sel = $id('mon-run');
    if (sel) sel.onchange = () => loadMonitor();
  }
  // بث الفريق يجب أن يصل لمنتقي الوضع في أعلى النطاق
  try { window.__runTeam = runTeam; } catch (e) { /* لا نطاق نوافذ */ }

  // ═══ شاشة الوكلاء — المجدول وسجل النبضات والمهارات (قرار 2026-10-27) ═══
  // «الوكيل يعمل دونك» لا يُصدَّق بادعاء: هنا الهدف المجدول، ونبضه المسجّل، ومهاراته.
  function schedSay(msg) { const el = $id('sched-status'); if (el) el.textContent = msg || ''; }

  function fmtStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(LANG === 'en' ? 'en-GB' : 'ar-EG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  async function loadSchedule() {
    const host = $id('sched-list');
    const hoursEl = $id('sched-hours');
    if (!host) return;
    const d = await jget('/api/agent/schedule');
    if (!d || d.error) { host.innerHTML = '<div class="hint mono">' + esc((d && d.error) || t('error_word')) + '</div>'; return; }
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    if (hoursEl) hoursEl.textContent = Number(d.effectiveHours) > 0
      ? t('sched_pulse_every').replace('{n}', String(d.effectiveHours))
      : t('sched_pulse_off');
    if (!tasks.length) { host.innerHTML = '<div class="hint">' + esc(t('sched_empty')) + '</div>'; return; }
    host.innerHTML = tasks.map((tk) => {
      const dueMs = Number(tk.due);
      const dueTxt = Number.isFinite(dueMs) ? (dueMs <= Date.now() ? t('sched_now') : fmtStamp(new Date(dueMs).toISOString())) : '—';
      const off = tk.enabled === false;
      return `<div class="sched-row${off ? ' off' : ''}" data-id="${esc(tk.id || '')}">
        <div class="sched-top"><span class="t" title="${esc(tk.goal || '')}">${esc(tk.goal || '')}</span></div>
        <div class="sched-meta">
          <span class="chip mono">${esc(t('sched_every_unit').replace('{n}', String(tk.every_hours == null ? '' : tk.every_hours)))}</span>
          <span class="chip mono">${esc(t('sched_due'))}: ${esc(dueTxt)}</span>
          <span class="chip mono">${esc(t('sched_last'))}: ${esc(tk.last_run_at ? fmtStamp(tk.last_run_at) : t('sched_never'))}</span>
        </div>
        <div class="row gap sched-acts">
          <button class="btn ghost sm" type="button" data-act="toggle">${esc(off ? t('sched_enable') : t('sched_disable'))}</button>
          <button class="btn ghost sm" type="button" data-act="run-now">${esc(t('sched_run_now'))}</button>
          <button class="btn ghost sm" type="button" data-act="remove">${esc(t('sched_remove'))}</button>
        </div></div>`;
    }).join('');
    host.querySelectorAll('.sched-row').forEach((row) => {
      const id = row.getAttribute('data-id');
      const task = tasks.find(x => x.id === id) || {};
      const tg = row.querySelector('[data-act="toggle"]');
      if (tg) tg.onclick = async () => {
        const r = await jpost('/api/agent/schedule', { action: 'toggle', id, enabled: task.enabled === false });
        if (r && r.error) { schedSay('⚠ ' + serverText(r.error)); return; }
        schedSay(task.enabled === false ? t('sched_on_word') : t('sched_off_word'));
        await loadSchedule();
      };
      const rm = row.querySelector('[data-act="remove"]');
      if (rm) rm.onclick = async () => {
        if (!confirm(t('sched_confirm_remove'))) return;
        const r = await jpost('/api/agent/schedule', { action: 'remove', id });
        if (r && r.error) { schedSay('⚠ ' + serverText(r.error)); return; }
        schedSay(t('sched_removed'));
        await loadSchedule();
      };
      const run = row.querySelector('[data-act="run-now"]');
      if (run) run.onclick = async () => {
        // قد يستغرق دقائق: يُعطَّل الزر أثناء الانتظار ثم يُعاد التحميل بعده
        run.disabled = true;
        run.textContent = t('sched_running');
        schedSay(t('sched_running'));
        const r = await jpost('/api/agent/schedule', { action: 'run-now', id });
        run.disabled = false;
        run.textContent = t('sched_run_now');
        if (r && r.error) { schedSay('⚠ ' + serverText(r.error)); return; }
        schedSay(r && r.run && r.run.ok === false ? '⚠ ' + serverText((r.run && r.run.error) || t('failed')) : t('sched_done'));
        await Promise.all([loadSchedule(), loadTicks()]);
      };
    });
  }

  async function loadTicks() {
    const host = $id('ticks-list');
    if (!host) return;
    const d = await jget('/api/agent/ticks');
    const items = (d && Array.isArray(d.items) ? d.items : []).slice(0, 5);
    if (!items.length) { host.innerHTML = '<div class="hint">' + esc(t('ticks_empty')) + '</div>'; return; }
    host.innerHTML = items.map((it) => {
      const ok = it.ok !== false;
      const bits = [];
      if (it.findings != null) bits.push(t('ticks_new') + ': ' + it.findings);
      bits.push(t('ticks_brief') + ': ' + (it.briefCreated ? '✓' : '—'));
      bits.push(t('ticks_memory') + ': ' + (it.memoryRefreshed ? '✓' : '—'));
      if (it.ms != null) bits.push(t('ticks_ms') + ': ' + it.ms + 'ms');
      if (Array.isArray(it.scheduled) && it.scheduled.length) bits.push(t('ticks_sched_runs').replace('{n}', String(it.scheduled.length)));
      return '<div class="tick-row">' +
        '<span class="chip mono">' + esc(fmtStamp(it.at)) + '</span>' +
        '<span class="chip ' + (ok ? 'done' : 'overdue') + '">' + esc(String(it.reason || '') + ' · ' + (ok ? t('ticks_ok') : t('ticks_err'))) + '</span>' +
        '<span class="mono dim tick-bits">' + esc(bits.join(' · ')) + '</span>' +
        (it.error ? '<span class="t tick-err">' + esc(serverText(String(it.error))) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  async function loadSkills() {
    const host = $id('skills-list');
    const cnt = $id('skills-count');
    if (!host) return;
    const d = await jget('/api/skills');
    if (!d || d.error) { host.innerHTML = '<div class="hint mono">' + esc((d && d.error) || t('error_word')) + '</div>'; return; }
    const list = Array.isArray(d.skills) ? d.skills : [];
    const issues = Array.isArray(d.issues) ? d.issues : [];
    if (cnt) cnt.textContent = list.length + ' ' + t('skills_unit');
    const rows = list.map(sk => '<tr>' +
      '<td class="mono">' + esc(sk.name || '') + '</td>' +
      '<td class="dim">' + esc(sk.description || '') + '</td></tr>').join('');
    const issueRows = issues.map((iss) => {
      const name = typeof iss === 'string' ? '' : (iss.name || iss.file || '');
      const text = typeof iss === 'string' ? iss : (iss.error || iss.message || iss.reason || JSON.stringify(iss));
      return '<tr class="warn-row"><td class="mono">' + esc(name) + '</td><td class="dim">' + esc(String(text)) + '</td></tr>';
    }).join('');
    if (!rows && !issueRows) { host.innerHTML = '<div class="hint">' + esc(t('skills_empty')) + '</div>'; return; }
    host.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>' + esc(t('skills_col_name')) + '</th><th>' + esc(t('skills_col_desc')) + '</th>' +
      '</tr></thead><tbody>' + rows + issueRows + '</tbody></table></div>' +
      (issues.length ? '<div class="hint warn">⚠ ' + esc(t('skills_issue_h')) + ' · ' + issues.length + '</div>' : '');
  }

  /* إنشاء مهارة من الواجهة (2026-11-14): كانت تتطلب وضع مجلد على القرص.
     الآن: املأ ⇒ افحص ⇒ أُضيفت وظهرت في الفهرس فوراً. */
  function wireSkillAdd() {
    const f = $id('skill-add-form');
    if (!f) return;
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const st = $id('skill-add-status'), btn = $id('skill-add-submit');
      const name = String(($id('skill-add-name') || {}).value || '').trim();
      const desc = String(($id('skill-add-desc') || {}).value || '').trim();
      const body = String(($id('skill-add-body') || {}).value || '').trim();
      if (!name || !desc || !body) { if (st) st.textContent = t('skill_need_all'); return; }
      if (btn) btn.disabled = true;
      if (st) st.textContent = t('skill_saving');
      const r = await jpost('/api/skills/create', { name, description: desc, body }).catch(() => null);
      if (btn) btn.disabled = false;
      if (r && r.ok) {
        if (st) st.textContent = '✓ ' + r.name + ' · ' + r.chars + ' ' + t('chars_unit');
        f.reset();
        loadSkills();
      } else if (st) {
        st.textContent = '⚠ ' + ((r && r.error) || t('failed'));
      }
    };
  }

  async function loadAgentExtras() { await Promise.all([loadSchedule(), loadTicks(), loadSkills()]); }

  function wireAgentExtras() {
    const rf = $id('sched-refresh'); if (rf) rf.onclick = () => { schedSay(''); loadAgentExtras(); };
    const f = $id('sched-form');
    if (f) f.onsubmit = async (ev) => {
      ev.preventDefault();
      const goalEl = $id('sched-goal'), everyEl = $id('sched-every');
      const goal = goalEl ? String(goalEl.value || '').trim() : '';
      const every = Number(everyEl ? everyEl.value : NaN);
      if (!goal) { schedSay('⚠ ' + t('none')); return; }
      if (!Number.isFinite(every) || every < 0.25 || every > 720) { schedSay('⚠ ' + t('sched_range_err')); return; }
      schedSay(t('busy_save'));
      const r = await jpost('/api/agent/schedule', { action: 'add', goal, every_hours: every });
      if (r && r.error) { schedSay('⚠ ' + serverText(r.error)); return; }
      if (goalEl) goalEl.value = '';
      schedSay(t('sched_added'));
      await loadSchedule();
    };
  }

  function wireMonitor() { const b = $id('mon-refresh'); if (b) b.onclick = () => { try { loadAgentExtras(); } catch (e) { /* تحسيني */ } loadMonitor(); }; }

  // ─────────── ⑧ الأدوات الخارجية ───────────
  // /api/mcp-info هو مصدر الأدوات الفعلي — والقائمة موحّدة في cortex-mcp-tools.js (28 أداة)،
  // و /api/mcp/servers يسرد الخوادم المُعرَّفة في الإعداد (قد تكون فارغة).
  async function loadMcp() {
    loadVault(); loadMcpConfig();
    const info = await jget('/api/mcp-info');
    const srv = await jget('/api/mcp/servers');
      const list = (srv && (srv.servers || srv.items)) || [];
      /* تدقيق 2026-10-24: الخادم نفسه كان يُعرض مرتين (بطاقة الحيّ من /api/mcp-info
         + بطاقة الإعداد) — التكرار يُزال، تكفي بطاقة واحدة حيّة. */
      const uniq = list.filter((s) => !(info && info.server && (s.name || '') === info.server));

    const host = $id('mcp-servers');
    if (host) {
      let html = '';
      if (info && !info.error && info.server) {
        html += `<div class="pcard"><div><div class="pname">${esc(info.server)}</div><div class="purl mono">${esc(info.command || 'node')} ${esc((info.args || []).join(' '))}</div><div class="pkey">${(info.tools || []).length} ${t('tools_unit')} · ${t('ready_word')}</div></div></div>`;
      }
      /* حالة صادقة (2026-11-13): «متصل/غير متصل» كانت تُقرأ من حقل لا يرسله
         الخادم فتظهر دائماً «غير متصل». الآن: مُتحقَّق منه (وقت الفحص + عدد الأدوات). */
      html += uniq.map((s) => {
        const n = Number(s.toolsCount || (s.tools || []).length || 0);
        const verified = Boolean(s.verifiedAt);
        const state = verified ? ('✓ ' + t('verified_word') + ' · ' + n + ' ' + t('tools_unit')) : ('⚠ ' + t('unverified_word'));
        return `<div class="pcard"><div><div class="pname">${esc(s.name || '')}</div><div class="purl mono">${esc(s.command || '')} ${esc((s.args || []).join(' '))}</div><div class="pkey">${state}</div></div></div>`;
      }).join('');
      host.innerHTML = html || '<div class="hint mono" style="padding:6px 16px">' + t('no_servers') + '</div>';
      const sc = $id('mcp-servers-count');
      if (sc) sc.textContent = String((info && info.server ? 1 : 0) + uniq.length);
    }

    const tools = ((info && info.tools) || []);
    const grid = $id('mcp-tools-grid2');
    if (grid) grid.innerHTML = tools.length ? tools.map((t) => `<span class="tg">${esc(t)}</span>`).join('') : '<span class="hint mono">—</span>';
  const c = $id('tools-count'); if (c) c.textContent = String(tools.length);
  }
  /* ── الخزنة: المسار والإحصاء (2026-11-15) ── */
  async function loadVault() {
    const d = await jget('/api/vault').catch(() => null);
    const pathEl = $id('vault-path');
    const chip = $id('vault-chip');
    if (!d || d.error) { if (pathEl) pathEl.textContent = '⚠ ' + ((d && d.error) || t('failed')); return; }
    if (pathEl) pathEl.textContent = d.dir;
    if (chip) chip.textContent = govInt(d.notes) + ' · ' + govInt(d.folders) + ' ' + t('vault_folders');
    const st = $id('vault-status');
    if (st) {
      const src = d.source === 'env' ? t('vault_src_env') : (d.source === 'config' ? t('vault_src_config') : t('vault_src_default'));
      st.textContent = src + (d.nested ? ' · ' + govInt(d.nested) + ' ' + t('vault_nested') : '') + (d.attachments ? ' · ' + govInt(d.attachments) + ' ' + t('vault_attach') : '');
    }
  }
  function wireVault() {
    const save = $id('vault-save');
    if (save) save.onclick = async () => {
      const dir = String(($id('vault-input') || {}).value || '').trim();
      const st = $id('vault-status');
      if (!dir) { if (st) st.textContent = '⚠ ' + t('vault_need'); return; }
      save.disabled = true;
      const r = await jpost('/api/vault', { dir }).catch(() => null);
      save.disabled = false;
      if (st) st.textContent = (r && r.ok) ? '✓ ' + t('vault_saved') : '⚠ ' + ((r && r.error) || t('failed'));
    };
    const reset = $id('vault-reset');
    if (reset) reset.onclick = async () => {
      const r = await jpost('/api/vault', { reset: true }).catch(() => null);
      const st = $id('vault-status');
      if (st) st.textContent = (r && r.ok) ? '✓ ' + t('vault_reset_done') : '⚠ ' + ((r && r.error) || t('failed'));
    };
  }

  /* ── ربط وكيل خارجي (2026-11-15) ── */
  async function loadMcpConfig() {
    const d = await jget('/api/mcp/config').catch(() => null);
    if (!d || d.error) return;
    const c = $id('mcplink-claude');
    const j = $id('mcplink-json');
    const ro = $id('mcplink-readonly');
    if (c) c.value = d.claude || '';
    if (j) j.value = JSON.stringify(d.json || {});
    if (ro) ro.checked = d.readOnly !== false;
    const st = $id('mcplink-status');
    if (st) st.textContent = (d.readOnly !== false ? '🔒 ' : '✎ ') + (d.readOnly !== false ? t('mcplink_ro_on') : t('mcplink_ro_off'));
    document.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        const el = $id(b.dataset.copy);
        if (!el) return;
        try {
          await navigator.clipboard.writeText(el.value);
          const old = b.textContent;
          b.textContent = t('copied');
          setTimeout(() => { b.textContent = old; }, 1200);
        } catch { try { el.select(); } catch (e) { /* اختيار يدوي */ } }
      };
    });
    if (ro) ro.onchange = async () => {
      const r = await jpost('/api/mcp/settings', { readOnly: ro.checked }).catch(() => null);
      if (st) st.textContent = (r && r.ok)
        ? ((ro.checked ? '🔒 ' : '✎ ') + (ro.checked ? t('mcplink_ro_on') : t('mcplink_ro_off')))
        : '⚠ ' + t('failed');
    };
  }

  /* ── النسخ الاحتياطي (2026-11-15) ── */
  async function loadBackups() {
    const host = $id('gov-backups');
    if (!host) return;
    const d = await jget('/api/backups').catch(() => null);
    const items = (d && d.items) || [];
    if (!items.length) { host.innerHTML = '<div class="hint">' + t('backup_none') + '</div>'; return; }
    host.innerHTML = items.slice(0, 10).map((b) => '<div class="gov-row">' +
      '<span class="gov-name mono" dir="ltr">' + esc(b.name) + '</span>' +
      '<span class="hint mono">' + Math.max(1, Math.round(b.size / 1024)) + 'KB</span>' +
      '<button class="btn ghost sm" type="button" data-restore="' + esc(b.name) + '">' + t('b_restore') + '</button></div>').join('');
    host.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.dataset.restore;
        if (!confirm(t('restore_confirm').replace('{n}', name))) return;
        btn.disabled = true;
        const r = await jpost('/api/backups/restore', { name }).catch(() => null);
        btn.disabled = false;
        const hint = $id('gov-backup-hint');
        if (hint) hint.textContent = (r && r.ok) ? '✓ ' + t('restore_done').replace('{n}', govInt(r.written)) : '⚠ ' + ((r && r.error) || t('failed'));
        try { loadNotes(); loadDashboard(); } catch (e) { /* تحديث تحسيني */ }
        loadBackups();
      };
    });
  }
  function wireBackups() {
    const now = $id('gov-backup-now');
    if (now) now.onclick = async () => {
      now.disabled = true;
      const r = await jpost('/api/backup', {}).catch(() => null);
      now.disabled = false;
      const hint = $id('gov-backup-hint');
      if (hint) hint.textContent = (r && r.fileName) ? '✓ ' + r.fileName + ' · ' + govInt(r.entryCount) + ' ' + t('files_unit') : '⚠ ' + ((r && r.error) || t('failed'));
      loadBackups();
    };
  }

  function wireMcp() {
    const b = $id('mcp-refresh');
    if (b) b.onclick = () => { loadMcp(); magic(t('busy_tools')); };
    /* إضافة خادم MCP من قسم الأدوات (2026-11-14): كانت في نافذة منفصلة بعيدة،
       فيبدو القسم بلا وسيلة إضافة. الآن: نموذج مطويّ هنا، والفحص قبل الحفظ. */
    const f = $id('mcp-add-form');
    if (f) f.onsubmit = async (ev) => {
      ev.preventDefault();
      const st = $id('mcp-add-status'), btn = $id('mcp-add-submit');
      const name = String(($id('mcp-add-name') || {}).value || '').trim();
      const cmd = String(($id('mcp-add-cmd') || {}).value || '').trim();
      const args = String(($id('mcp-add-args') || {}).value || '').split(/\s+/).filter(Boolean);
      if (!name || !cmd) { if (st) st.textContent = t('mcp_ext_need'); return; }
      if (btn) btn.disabled = true;
      if (st) st.textContent = t('mcp_testing');
      const r = await jpost('/api/mcp/servers', { name, command: cmd, args }).catch(() => null);
      if (btn) btn.disabled = false;
      if (r && r.ok) {
        if (st) st.textContent = '✓ ' + name + ' · ' + (r.tools || []).length + ' ' + t('tools_unit');
        f.reset();
        loadMcp();
      } else if (st) {
        st.textContent = '⚠ ' + ((r && r.error) || t('failed'));
      }
    };
  }
  const openTools = $id('mcp-open-tools');
  if (openTools) openTools.onclick = () => { const m = $id('modal-mcp'); if (m) m.classList.add('hidden'); const rail = document.querySelector('#rail .rail-btn[data-view="tools"]'); if (rail) rail.click(); };

  // ─────────── ⑨ الوكيل (سطح واحد: اللوحة الجانبية) ───────────
  function wireAgents() {
    const naBtn = $('next-action-btn');
    if (naBtn && !naBtn.__wired) { naBtn.__wired = true; naBtn.onclick = () => runNextAction(); }
    /* أزرار الأوامر الجاهزة أُزيلت (2026-10-30، قرار المستخدم الحيّ): «وكيل حقيقي = أكتب
       جملتي» — لا نسخ أوامر تحتل سطح المحادثة. الهدف يمر عبر حقل الكتابة نفسه. */
  }

  // سطح الوكيل الوحيد: اللوحة الجانبية (توحيد 2026-10-27 — لا شاشة ثانية).
  function agentHosts() {
    return {
      root: document.getElementById('ai-panel') || document,
      log: document.getElementById('chat-messages'),
      steps: document.getElementById('agent-steps'),
      sources: document.getElementById('agent-sources')
    };
  }

  /* شاشة AGENT (2026-10-30): بلا تبويبات — المحادثة هي الشاشة، والخطوات والمصادر
     والاعتمادات تعيش في السطح نفسه تحت الرسائل (الفارغ منها صفر مساحة، والممتلئ يظهر).
     عطل 2026-10-27 القديم (تراكم المحتويات) مُغلق بنفس آلية `.hidden` الموحّدة. */
  function applyAgentTab() {
    const panel = document.getElementById('ai-panel'); if (!panel) return;
    const setVis = (el, show) => { if (!el) return; el.hidden = !show; el.classList.toggle('hidden', !show); };
    setVis(panel.querySelector('#chat-messages'), true);
    setVis(panel.querySelector('#agent-steps'), true);
    setVis(panel.querySelector('#agent-sources'), true);
    const pend = panel.querySelector('#ai-pending-area');
    setVis(pend, !!(pend && pend.children.length > 0));
    setVis(panel.querySelector('#team-live'), true);
    setVis(panel.querySelector('#agent-panes'), true);
    // المستجدات خارج اللوحة (شريحة مستقلة 2026-10-30)، والخلفية انتقلت لشاشة المراقبة
  }

  // مُبقاة بلا تبويبات (مستدعياتها في فتح اللوحة وبثّ التشغيل لا تتغير)
  function showAgentTab() { applyAgentTab(); }
  // جسر للنطاقات الأخرى (المسودات/المستجدات تُملأ في دوال خارج هذا النطاق)
  try { window.__applyAgentTab = applyAgentTab; } catch (e) { /* لا نطاق نوافذ */ }

  function wireAgentTabs() { /* لا تبويبات بعد اليوم — دالة محفوظة لمسار النداء نفسه */ }

  /* ═══════════ الاستوديو (W1-W5): الحالة الحيّة · الخط الزمني · المخرَجات · عقد الصلاحيات ═══════════
     المبدأ: كل جملة = «تشغيل» أوّل-درجة له معرّف وسجل دائم على الخادم؛ الواجهة ترسمه من السجل
     (فيُروى كاملاً عند إعادة الفتح)، والحالة الحيّة دائماً ظاهرة، والإلغاء حقيقي تعاوني. */
  const fmtHM = (iso) => { try { return new Date(iso).toLocaleTimeString(LANG === 'en' ? 'en-GB' : 'ar-EG', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  function setLastRun(runId, sessionId) {
    S.runId = runId || '';
    S.lastEventId = 0;
    S.runRenderedFinal = false;
    try { if (runId) localStorage.setItem('cortex.lastRun', JSON.stringify({ runId, sessionId: sessionId || S.sessionId || '' })); } catch (e) { /* تخزين اختياري */ }
  }
  function readLastRun() { try { return JSON.parse(localStorage.getItem('cortex.lastRun') || 'null'); } catch (e) { return null; } }

  function renderRunTimeline(container, events) {
    if (!container) return;
    container.innerHTML = '';
    let toolCard = null; let toolCount = 0;
    const push = (html) => container.insertAdjacentHTML('beforeend', `<div class="tl-item">${html}</div>`);
    let finished = null;
    for (const e of events) {
      const p = e.payload || {};
      switch (e.type) {
        case 'run_created':
          push(`<div class="tl-user">${esc(p.goal || '')}</div>`);
          break;
        case 'thought':
          push(`<details class="tl-thought"><summary>💭 ${esc(t('tl_think'))}</summary><div class="body">${esc(p.text || '')}</div></details>`);
          break;
        case 'action':
          toolCount++;
          push(`<div class="tl-tool"><div class="head"><span class="tstep">#${toolCount}</span><span class="tname">${esc(p.tool || '')}</span></div><details><summary>${esc(t('tl_args'))}</summary><div class="args">${esc(p.args || '')}</div></details><div class="tl-obs"></div></div>`);
          toolCard = container.lastElementChild.querySelector('.tl-obs');
          break;
        case 'observation':
          if (toolCard) { toolCard.classList.add(p.ok ? 'ok' : 'bad'); toolCard.textContent = String(p.summary || ''); toolCard = null; }
          break;
        case 'approval_required':
          push(`<div class="tl-approval"><div class="fk">⏳ ${esc(t('tl_drafts_notice'))}</div>⚙ ${esc(p.tool || '')} — ${esc(p.summary || '')}<div class="row gap" style="margin-top:6px"><button class="btn ghost sm" data-tl-drafts="1">${esc(t('tl_show_drafts'))}</button></div></div>`);
          break;
        case 'verification_required':
          push(`<div class="tl-note">⚠ ${esc(t('tl_verify_req'))}</div>`);
          break;
        case 'verification':
          push(`<div class="tl-note ${p.verified ? 'ok' : 'bad'}">${p.verified ? '✓' : '✗'} ${esc(p.verified ? t('tl_verified_ok') : t('tl_verified_bad'))}</div>`);
          break;
        case 'cancel_requested':
          push(`<div class="tl-note">⏹ ${esc(t('live_stopped'))}</div>`);
          break;
        case 'run_cancelled':
          push(`<div class="tl-cancel">⏹ ${esc(t('tl_cancelled'))}</div>`);
          break;
        case 'run_failed':
          push(`<div class="tl-fail">✗ ${esc(t('tl_failed'))}: ${esc(String(p.error || '').slice(0, 400))}</div>`);
          break;
        case 'run_finished': {
          finished = p;
          const ansHtml = esc(String(p.answer || '')).replace(/\n/g, '<br>');
          push(`<div class="tl-answer">${ansHtml}</div>`);
          const ansEl = container.lastElementChild.querySelector('.tl-answer');
          try { if (ansEl && typeof bindWikilinks === 'function') bindWikilinks(ansEl); } catch (e) { /* تحسيني */ }
          const badges = [];
          if (p.verified === true) badges.push(`<span class="tl-badge ok">✓ ${esc(t('tl_verified_ok'))}</span>`);
          else if (p.verified === false) badges.push(`<span class="tl-badge bad">✗ ${esc(t('tl_verified_bad'))}</span>`);
          if (typeof p.stepsUsed === 'number') badges.push(`<span class="tl-badge">${p.stepsUsed} ${esc(t('unit_tasks'))}</span>`);
          if (badges.length) container.lastElementChild.insertAdjacentHTML('beforeend', badges.join(''));
          if (p.artifact && p.artifact.noteId) {
            push(`<div class="tl-artifact"><span class="ic">📄</span><div><div>${esc(t('artifact_title'))}</div><div class="meta">${esc(String(p.artifact.noteId))} · ${Number(p.artifact.chars) || 0} ${esc(t('chars_unit'))}</div></div><button class="btn ghost sm" data-tl-open="${esc(String(p.artifact.noteId))}">${esc(t('artifact_open'))}</button></div>`);
          }
          break;
        }
        default: break;
      }
    }
    container.querySelectorAll('[data-tl-drafts]').forEach((b) => {
      b.onclick = () => { try { showAgentTab('chat'); } catch (e) {} try { if (typeof loadPending === 'function') loadPending(); } catch (e) {} };
    });
    container.querySelectorAll('[data-tl-open]').forEach((b) => {
      b.onclick = () => { try { window.__openNoteById && window.__openNoteById(b.getAttribute('data-tl-open')); } catch (e) { /* تحسيني */ } };
    });
    container.scrollTop = container.scrollHeight;
    return finished;
  }

  // ── الحالة الحيّة: ماذا يعمل الآن / ماذا ينتظرك — بلا نقر ──
  async function renderLiveBar() {
    const bar = document.getElementById('agent-live'); if (!bar) return;
    let act = []; let pend = 0;
    try { act = ((await API.get('/api/agent/runs/active')) || {}).active || []; } catch (e) { act = []; }
    try { pend = (((await API.pending()) || {}).mutations || []).length; } catch (e) { pend = 0; }
    const mine = act.find((r) => r.runId === S.runId) || act[0] || null;
    const last = mine ? null : readLastRun();
    const parts = [];
    if (mine) {
      bar.classList.add('working');
      parts.push(`<span class="dot"></span><span>${esc(t('live_working'))}:</span><span class="al-goal">${esc(mine.goal || '')}</span>`);
      parts.push(`<button class="btn ghost sm al-cancel" data-live-cancel="${esc(mine.runId)}">⏹ ${esc(t('live_stop'))}</button>`);
    } else {
      bar.classList.remove('working');
      parts.push(`<span>● ${esc(t('live_idle'))}${last && last.runId ? ' · ' + esc(t('live_last')) + ' ' + esc(String(last.runId).slice(-8)) : ''}</span>`);
    }
    if (pend > 0) parts.push(`<span class="chip mono">⏳ ${pend} ${esc(t('tl_drafts_notice'))}</span>`);
    bar.innerHTML = parts.join(' ');
    bar.classList.remove('hidden');
    const c = bar.querySelector('[data-live-cancel]');
    if (c) c.onclick = async () => {
      c.disabled = true;
      try {
        const r = await API.post('/api/agent/cancel', { runId: c.getAttribute('data-live-cancel') });
        if (r && r.error) throw new Error(r.error);
        toast((r && r.note) || t('live_stopped'));
      } catch (e) { toast('⚠ ' + e.message); }
      setTimeout(() => { try { replayRun(S.runId, { force: true }); renderLiveBar(); } catch (e) {} }, 900);
    };
  }
  let LIVE_TIMER = null;
  function startLivePoll() {
    if (LIVE_TIMER) return;
    LIVE_TIMER = setInterval(async () => {
      const p = document.getElementById('ai-panel');
      if (!p || p.classList.contains('hidden')) return;
      try { await tickLive(); } catch (e) { /* الاستطلاع لا يكسر شيئاً */ }
    }, 1200);
    try { tickLive(); } catch (e) { /* تحسيني */ }
  }
  function stopLivePoll() { if (LIVE_TIMER) { clearInterval(LIVE_TIMER); LIVE_TIMER = null; } }
  async function tickLive() {
    await renderLiveBar();
    const runId = S.runId || (readLastRun() || {}).runId;
    if (!runId) return;
    try {
      const data = await API.get('/api/agent/runs/' + encodeURIComponent(runId));
      const evs = (data && data.events) || [];
      if (!evs.length) return;
      S.lastEventId = evs[evs.length - 1].id;
      const finished = !!(data.summary && !data.summary.active);
      const log = document.getElementById('chat-messages');
      const hasContent = log && log.querySelector('.tl-item');
      // أثناء بثٍّ حيّ من هذه اللوحة لا نرسم فوق الرسم الحيّ؛ وبعد الاكتمال نرسم من السجل (مصدر الحقيقة)
      if (!S.streaming && (!hasContent || (finished && !S.runRenderedFinal))) {
        S.runRenderedFinal = finished;
        renderRunTimeline(log, evs);
      }
    } catch (e) { /* لا سجل بعد */ }
  }
  async function replayRun(runId, opts = {}) {
    const id = runId || (readLastRun() || {}).runId;
    if (!id) return;
    const log = document.getElementById('chat-messages'); if (!log) return;
    try {
      const data = await API.get('/api/agent/runs/' + encodeURIComponent(id));
      const evs = (data && data.events) || [];
      if (!evs.length) return;
      S.runId = id;
      S.lastEventId = evs[evs.length - 1].id;
      S.runRenderedFinal = !!(data.summary && !data.summary.active);
      renderRunTimeline(log, evs);
      if (opts.force) S.runRenderedFinal = S.runRenderedFinal;
    } catch (e) { /* لا تشغيل محفوظ — لا شيء يُعاد */ }
  }

  // ── عقد الصلاحيات والأدوار (W5): عرض حقيقة النظام + تعديل بتأكيد صريح ──
  async function openContract() {
    const d = document.getElementById('contract-drawer'); if (!d) return;
    d.classList.remove('hidden');
    const body = document.getElementById('contract-body');
    body.innerHTML = '<div class="hint mono">…</div>';
    let c = null;
    try { c = await API.get('/api/agent/contract'); } catch (e) { body.innerHTML = `<div class="tl-fail">${esc(e.message)}</div>`; return; }
    const rolesRows = Object.entries(c.roles || {}).map(([k, r]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(r.description || '')}</td><td class="mono">${esc((r.scopes || []).join(', '))}</td><td class="mono">${r.canWrite ? esc(t('contract_yes')) : esc(t('contract_no'))}</td></tr>`).join('');
    const draftTools = Object.entries(c.tools || {}).filter(([, s]) => s.alwaysDraft || s.level === 'propose').map(([k]) => `<span class="tg">${esc(k)}</span>`).join(' ');
    body.innerHTML = [
      `<div class="contract-sec"><h4>${esc(t('contract_autonomy'))}</h4>
        <div class="contract-row"><span class="seg" id="ct-autonomy">${(c.modes || []).map((m) => `<button data-mode="${esc(m)}" class="${m === c.autonomy ? 'on' : ''}">${esc(t('mode_' + m))}</button>`).join('')}</span><span class="hint mono" id="ct-msg"></span></div>
      </div>`,
      `<div class="contract-sec"><h4>${esc(t('contract_limits'))}</h4>${
        Object.entries(c.limits || {}).map(([k, v]) => `<div class="contract-row"><span class="lbl">${esc(k)}</span><input type="number" min="0" max="100000" id="ct-limit-${esc(k)}" value="${Number(v)}" class="input sm"><span class="hint mono">${esc(t('contract_base'))} ${esc(String((c.limitsBase || {})[k] ?? ''))}</span></div>`).join('')
      }<div class="contract-row"><button class="btn primary sm" id="ct-save">${esc(t('contract_save'))}</button></div></div>`,
      `<div class="contract-sec"><h4>${esc(t('contract_roles'))}</h4>
        <table class="contract-table"><thead><tr><th>${esc(t('role_word'))}</th><th></th><th>${esc(t('contract_scope'))}</th><th>${esc(t('contract_write'))}</th></tr></thead><tbody>${rolesRows}</tbody></table>
      </div>`,
      `<div class="contract-sec"><h4>${esc(t('contract_tools'))}</h4>
        <div class="hint mono" style="margin-bottom:5px">${Object.keys(c.tools || {}).length} ${esc(t('contract_tools_count'))}</div>
        <div class="hint" style="margin-bottom:4px">${esc(t('contract_nodraft_tools'))}:</div><div class="tools-grid">${draftTools}</div>
      </div>`,
      `<div class="contract-note">${esc(t('contract_note'))}</div>`
    ].join('');
    const msg = (s, bad) => { const m = document.getElementById('ct-msg'); if (m) { m.textContent = s; m.style.color = bad ? 'var(--red)' : 'var(--teal)'; } };
    body.querySelectorAll('#ct-autonomy button').forEach((b) => {
      b.onclick = async () => {
        const mode = b.getAttribute('data-mode');
        if (mode === c.autonomy) return;
        if (!confirm(t('contract_confirm_autonomy'))) return;
        try {
          const r = await API.post('/api/agent/contract-update', { confirm: true, autonomy: mode });
          if (r && r.error) throw new Error(r.error);
          toast(t('contract_saved'));
          openContract();
        } catch (e) { msg(String(e.message || ''), true); }
      };
    });
    const save = document.getElementById('ct-save');
    if (save) save.onclick = async () => {
      if (!confirm(t('contract_confirm_limits'))) return;
      const limits = {};
      for (const k of Object.keys(c.limits || {})) { const el = document.getElementById('ct-limit-' + k); if (el) limits[k] = Number(el.value); }
      try {
        const r = await API.post('/api/agent/contract-update', { confirm: true, limits });
        if (r && r.error) throw new Error(r.error);
        toast(t('contract_saved'));
        openContract();
      } catch (e) { msg(String(e.message || ''), true); }
    };
  }
  function closeContract() { const d = document.getElementById('contract-drawer'); if (d) d.classList.add('hidden'); }
  try {
    if ($id('contract-btn')) $id('contract-btn').onclick = openContract;
    if ($id('contract-close-btn')) $id('contract-close-btn').onclick = closeContract;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContract(); });
  } catch (e) { /* الربط تحسيني */ }
  // عارض الملفات: زر الإغلاق + Esc (بنفس نمط عقد الصلاحيات)
  try {
    const closeFileViewer = () => { const d = document.getElementById('file-drawer'); if (d) d.classList.add('hidden'); };
    if ($id('file-close-btn')) $id('file-close-btn').onclick = closeFileViewer;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFileViewer(); });
  } catch (e) { /* الربط تحسيني */ }
  // لوحة المستجدات (2026-10-30): شريحة في الشريط السفلي تفتحها + إغلاق بزر/Esc
  try {
    const openFindings = () => { const d = document.getElementById('findings-drawer'); if (d) d.classList.remove('hidden'); };
    const closeFindings = () => { const d = document.getElementById('findings-drawer'); if (d) d.classList.add('hidden'); };
    if ($id('findings-chip')) $id('findings-chip').onclick = openFindings;
    if ($id('findings-close-btn')) $id('findings-close-btn').onclick = closeFindings;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFindings(); });
  } catch (e) { /* الربط تحسيني */ }

  // جسر نطاقي: اللوحة/الإغلاق في نطاق آخر يستخدمون الاستوديو عبره
  try { window.__studio = { replayRun, tickLive, renderLiveBar, startLivePoll, stopLivePoll, openContract }; } catch (e) { /* لا نطاق نوافذ */ }

  async function runAgentStream(goal) {
    /* حارس الإرسال أثناء العمل (2026-10-30 — تقرير فحص الشات): تشغيل واحد في كل مرة.
       كان الإرسال أثناء البثّ يمحو عرض التشغيل الجاري ويطلق تشغيلين متوازيين. */
    if (S.streaming) { toast(t('agent_busy_wait')); return; }
    /* سطح واحد (توحيد 2026-10-27): أي تشغيل يفتح اللوحة ويُظهر تبويب المحادثة. */
    try { if (window.__openAgentPanel) window.__openAgentPanel(); } catch (e) { /* اللوحة اختيارية */ }
    try { showAgentTab('chat'); } catch (e) { /* التبويب تحسيني */ }
    try { window.__runAgentStream = runAgentStream; } catch (e) { /* لا نطاق نوافذ */ }
    const H = agentHosts();
    const log = H.log;
    if (H.steps) H.steps.innerHTML = '';
    if (H.sources) H.sources.innerHTML = '';
    // خط زمني حيّ أولي: نيّتك + مؤشر تفكير — ثم يُعاد الرسم الكامل من السجل عند الختام
    if (log) {
      log.innerHTML = `<div class="tl-item"><div class="tl-user">${esc(goal)}</div></div><div class="tl-item"><div class="tl-note">⋯</div></div>`;
      log.scrollTop = log.scrollHeight;
    }
    S.streaming = true;
    S.runRenderedFinal = false;
    const sendBtnRun = document.getElementById('send-chat-btn');
    if (sendBtnRun) sendBtnRun.disabled = true;
    const appendLiveTool = (step) => {
      if (!log) return;
      const note = log.querySelector('.tl-note'); if (note && note.textContent === '⋯') note.textContent = '';
      log.insertAdjacentHTML('beforeend', `<div class="tl-item"><div class="tl-tool"><div class="head"><span class="tstep">#${esc(String(step.step || ''))}</span><span class="tname">${esc(step.tool || '')}</span></div><div class="tl-obs">${esc(JSON.stringify(step.result || {}).slice(0, 160))}</div></div></div>`);
      log.scrollTop = log.scrollHeight;
    };
    let doneResult = null;
    try {
      const res = await fetch('/api/agent/run', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(await hdr()) },
        /* عطل مُقاس 2026-10-24: كان `window.S &&` — و`S` معرّف محلياً ولا يُصدَّر
           إلى window أبداً، فكانت المشروع/العنصر المفتوح/الجلسة تُرسل فارغة دائماً.
           الإصلاح: قراءة S مباشرة (نفس نطاق هذه الدالة). */
        body: JSON.stringify({ goal, project: (S && S.projectFilter) || '', noteId: (S && S.activeNote ? S.activeNote.id : '') || '', sessionId: (S && S.sessionId) || '' })
      });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const ln of lines) {
          const s = ln.trim(); if (!s.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
          if (ev.type === 'run_started' && ev.runId) {
            setLastRun(ev.runId, ev.sessionId);
            if (ev.sessionId) S.sessionId = ev.sessionId;
            // معرّف الجلسة لا يُعرض للمستخدم (قرار 2026-10-30) — يبقى في الحالة فقط
            try { renderLiveBar(); } catch (e) { /* تحسيني */ }
          } else if (ev.type === 'agent_step' && ev.step && Array.isArray(ev.step.plan) && ev.step.plan.length) {
            /* الخطة تُعرض قبل التنفيذ — لا تُحسب خطوة أدوات */
            try {
              const box = addBubble('system', t('agent_plan_steps') + ': ' + ev.step.plan.map((x, i) => (i + 1) + '. ' + x).join(' · '));
              if (box) box.dataset.plan = '1';
            } catch (e) { /* العرض لا يُسقط التشغيل */ }
          } else if (ev.type === 'agent_step' && ev.step) {
            appendLiveTool(ev.step);
            if (H.steps) {
              H.steps.insertAdjacentHTML('beforeend', `<li class="ok">${esc(ev.step.tool || '')} — ${esc(JSON.stringify(ev.step.result || {}).slice(0, 90))}</li>`);
            }
          } else if (ev.type === 'agent_done' && ev.result) {
            doneResult = ev.result;
            const src = ev.result.sources || [];
            if (H.sources) {
              H.sources.innerHTML = src.slice(0, 40).map((sr) => (sr && sr.file)
                ? `<div class="ref" data-file="${esc(sr.file)}"><span class="t">📄 ${esc(shortPath(sr.file))}</span></div>`
                : `<div class="ref" data-id="${esc(sr.id)}"><span class="t">${esc(sr.title || sr.id)}</span></div>`).join('');
              H.sources.querySelectorAll('.ref').forEach((el) => {
                if (el.getAttribute('data-file')) el.onclick = () => window.__openFileViewer && window.__openFileViewer(el.getAttribute('data-file'));
                else el.onclick = () => window.__openNoteById && window.__openNoteById(el.dataset.id);
              });
            }
            try {
              const na = ev.result.nextAction || ev.result.bestNext || null;
              const naTxt = typeof na === 'string' ? na : (na && (na.text || na.reason)) || '';
              if (typeof setNextAction === 'function') setNextAction(naTxt);
            } catch (e) { /* تحسيني */ }
            // ب5 (2026-10-30): المستجدات تُحدَّث عند اكتمال التشغيل — كانت تُحمَّل مرة واحدة عند الإقلاع فتتقادم
            try { if (typeof loadFindings === 'function') loadFindings(); } catch (e) { /* تحسيني */ }
          } else if (ev.type === 'agent_error') {
            if (log) log.insertAdjacentHTML('beforeend', `<div class="tl-item"><div class="tl-fail">⚠ ${esc(ev.error || t('error_word'))}</div></div>`);
          }
        }
      }
    } catch (e) {
      if (log) log.insertAdjacentHTML('beforeend', `<div class="tl-item"><div class="tl-fail">${esc(t('conn_fail'))} ${esc(e.message)}</div></div>`);
    } finally {
      S.streaming = false;
      const sendBtnEnd = document.getElementById('send-chat-btn');
      if (sendBtnEnd) sendBtnEnd.disabled = false;
    }
    // الرسم النهائي من السجل (مصدر الحقيقة) — يُروي التشغيل كاملاً حتى لو أغلق المتصفح وأُعيد فتحه
    if (S.runId) {
      try { await replayRun(S.runId, { force: true }); } catch (e) { /* بلا سجل نكتفي بالحيّ */ }
    }
    if (doneResult && doneResult.error && log && !log.querySelector('.tl-fail')) {
      log.insertAdjacentHTML('beforeend', `<div class="tl-item"><div class="tl-fail">⚠ ${esc(String(doneResult.error).slice(0, 400))}</div></div>`);
    }
    magic(t('finished_sources').replace('{n}', String(((H.sources && H.sources.children.length) || 0))));
    try { if (typeof refreshPendingBadge === 'function') refreshPendingBadge(); } catch (e) { /* الشارة لا تكسر الشات */ }
    try { await renderLiveBar(); } catch (e) { /* تحسيني */ }
  }

  // ─────────── ⑨ الحُكم — المراحل والبوابات والاستهلاك والحجر والتحسين والتدقيق والتراجع ───────────
  /* شاشة «الحُكم»: كل طقس دستوري هنا بمصدره الحقيقي، وكل زر يعطّل نفسه أثناء التحميل،
     وكل خطأ يظهر للمستخدم نصاً — لا فشل صامت. */

  const GOV_GATE_AR = {
    no_privilege_escape: 'لا تجاوز صلاحيات',
    no_double_execution: 'لا تنفيذ مزدوج',
    valid_state_transitions: 'انتقالات حالة صحيحة',
    project_isolation: 'عزل بيانات المشاريع',
    quarantine_intact: 'عزل الملفات غير الموثوقة',
    tasks_recoverable: 'استعادة المهام المعلقة',
    conflicts_have_path: 'تعارض النتائج له مسار حل',
    rollback_proven: 'اختبار التراجع المعتمد'
  };
  const GOV_GATE_EN = {
    no_privilege_escape: 'No privilege escape',
    no_double_execution: 'No double execution',
    valid_state_transitions: 'Valid state transitions',
    project_isolation: 'Project data isolation',
    quarantine_intact: 'Untrusted-file quarantine intact',
    tasks_recoverable: 'Pending tasks recoverable',
    conflicts_have_path: 'Result conflicts have a resolution path',
    rollback_proven: 'Approved rollback test'
  };
  const gateNameL = (g) => (LANG === 'en' ? (GOV_GATE_EN[g] || g) : (GOV_GATE_AR[g] || g));
  /* لا قائمة ثابتة: الكتالوج يأتي من /api/gates (9 بوابات) — كانت هنا 8 تُخفي واحدة. */
  const GOV_KINDS_9 = ['depends_on', 'derives_from', 'resulted_in', 'responsible_for', 'belongs_to', 'contradicts', 'risks', 'tested_by', 'affected_by'];
  const GOV_SEV = ['low', 'medium', 'high', 'critical'];
  let GOV_WIRED = false;
  /* تبويبات الحُكم (2026-11-06): كان القسم 9 بطاقات و18,941 حرفاً في عمود واحد
     بلا أي تنقّل — أثقل شاشة وأقلها قابلية للقراءة. التقسيم داخلي (5 تبويبات)
     لا شاشة تاسعة، لأن الشريط فيه 8 أصلاً ولا يُثقل بمزيد. */
  let GOV_TAB = 'stages';
  const GOV_TABS = ['stages', 'quality', 'safety', 'relations', 'privacy'];
  function showGovTab(name) {
    GOV_TAB = GOV_TABS.indexOf(name) === -1 ? 'stages' : name;
    document.querySelectorAll('#gov-tabs [data-gov-tab]').forEach((b) => {
      const on = b.getAttribute('data-gov-tab') === GOV_TAB;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#view-governance .gov-card').forEach((c) => {
      c.classList.toggle('hidden', c.getAttribute('data-gov-tab') !== GOV_TAB);
    });
  }

  const govInt = (n) => (n == null || !Number.isFinite(Number(n))) ? '0' : Number(n).toLocaleString('en-US');
  const govSevBadge = (s) => (s === 'critical' || s === 'high') ? 'bad' : (s === 'medium' ? 'warn' : 'idle');
  /* تدقيق 2026-10-24: الأدلة كانت JSON خاماً `{"مرجع":"..."}` والتواريخ ISO خاماً.
     prettyEvidence تفكّ JSON إلى «مفتاح: قيمة» (وتترك النص العربي كما هو)،
     fmtWhen تحوّل ISO إلى تاريخ/وقت محلي مقروء. */
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso || '')
      : d.toLocaleString(LANG === 'en' ? 'en-GB' : 'ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const prettyEvidence = (s) => {
    const raw = String(s == null ? '' : s).trim();
    if (!/^[{[]/.test(raw)) return raw;
    /* مفاتيح الأدلة عربية في البيانات — تُعرض بمفتاح مترجم حتى لا يبقى نص
       عربي في وضع EN؛ القيمة نفسها بيانات مرحلة تبقى كما هي (تدقيق 2026-10-24). */
    const KEY_L = { 'مرجع': LANG === 'en' ? 'reference' : 'مرجع', 'علل': LANG === 'en' ? 'rationale' : 'علل', 'دليل': LANG === 'en' ? 'evidence' : 'دليل' };
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const pairs = Object.entries(o).map(([k, v]) => (KEY_L[k] || k) + ': ' + (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)));
        if (pairs.length) return pairs.join(' · ');
      }
      return Array.isArray(o) ? o.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' · ') : raw;
    } catch { return raw; }
  };

  function govMsg(id, msg, isErr) {
    const el = $id(id); if (!el) return;
    el.innerHTML = '<div class="hint' + (isErr ? ' gov-err' : '') + '">' + esc(msg) + '</div>';
  }
  function govErr(msg) {
    const el = $id('gov-error'); if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg; el.classList.remove('hidden');
  }
  function govBadge(id, kind, text) {
    const el = $id(id); if (!el) return;
    el.className = 'gov-badge gov-badge-' + kind;
    if (text != null) el.textContent = text;
  }
  function govDisable(id, on, busyLabel) {
    const b = $id(id); if (!b) return;
    if (on) { if (!b.dataset.lbl) b.dataset.lbl = b.textContent; b.disabled = true; b.textContent = busyLabel || '…'; }
    else { b.disabled = false; if (b.dataset.lbl) { b.textContent = b.dataset.lbl; delete b.dataset.lbl; } }
  }

  /* ① المراحل الثماني + زر إثبات الدليل للمرحلة القابلة للفتح وحدها */
  function renderStages(data) {
    const el = $id('gov-stages'); if (!el) return;
    if (!data || data.error || !Array.isArray(data.stages)) {
      govMsg('gov-stages', t('err_stages') + ' ' + ((data && data.error) || t('unexpected')), true);
      govBadge('gov-stages-badge', 'bad', t('failed_short')); return;
    }
    const st = data.stages;
    const p = $id('gov-stages-proven'); if (p) p.textContent = String(data.proven != null ? data.proven : st.filter(s => s.proven).length);
    const tt = $id('gov-stages-total'); if (tt) tt.textContent = String(data.total != null ? data.total : st.length);
    const nx = $id('gov-stages-next'); if (nx) nx.textContent = data.next || '—';
    govBadge('gov-stages-badge', data.complete ? 'ok' : 'idle', data.complete ? t('stages_done') : t('stages_incomplete'));
    el.innerHTML = st.map(s => {
      const proven = !!s.proven;
      return '<div class="gov-row ' + (proven ? 'ok' : 'locked') + '">' +
        '<span class="gov-n mono">' + esc(String(s.n)) + '</span>' +
        '<span class="gov-name">' + esc(govTail(serverFix('stage', serverText(s.name || s.key)))) + ' <span class="hint mono">' + esc(s.key) + '</span></span>' +
        '<span class="gov-badge gov-badge-' + (proven ? 'ok' : 'locked') + '">' + (proven ? t('proven_l') : t('locked_l')) + '</span>' +
        (proven
          ? '<span class="hint gov-detail mono">' + esc(prettyEvidence(govTail(String(s.evidence || ''))).slice(0, 160)) + '</span>' +
            '<span class="hint mono">' + esc(fmtWhen(s.provenAt || '')) + '</span>'
          : (s.canOpen
            ? '<button class="btn primary sm gov-prove" type="button" data-prove="' + esc(s.key) + '" data-ar="' + esc(s.name || s.key) + '">' + t('b_prove') + '</button>'
            : '<span class="hint">' + t('opens_after_prev') + '</span>')) +
        '</div>';
    }).join('');
  }

  /* ② البوابات الثماني — كتالوج (GET) ثم نتيجة فحص (POST) */
  function renderGatesCatalog(data) {
    const el = $id('gov-gates'); if (!el) return;
    if (!data || data.error) {
      govMsg('gov-gates', t('err_gates') + ' ' + ((data && data.error) || t('unexpected')), true); return;
    }
    const catalog = Array.isArray(data.gates) ? data.gates : [];
    const last = {};
    (Array.isArray(data.history) ? data.history : []).forEach(h => { if (h && h.gate && !(h.gate in last)) last[h.gate] = h; });
    /* شارة الإصدار من آخر فحص مسجَّل: كان الإعداد يعيدها «لم يُفحص» بعد فحص فاشل. */
    const newest = (Array.isArray(data.history) ? data.history : []).reduce((acc, h) => (h && (!acc || String(h.at) > String(acc.at)) ? h : acc), null);
    if (newest) {
      const at = String(newest.at || "");
      const rows = (Array.isArray(data.history) ? data.history : []).filter((h) => h && String(h.at) === at);
      const allPass = rows.length > 0 && rows.every((h) => h.passed === true);
      govBadge('gov-gates-release', allPass ? 'ok' : 'bad', allPass ? t('release_ok') : t('release_no'));
      govBadge('gov-release-badge', allPass ? 'ok' : 'bad', allPass ? t('release_ok') : t('release_no'));
    } else {
      govBadge('gov-gates-release', 'idle', t('unchecked'));
    }
    const hint = $id('gov-gates-hint'); if (hint) hint.textContent = t('gates_hint');
    el.innerHTML = catalog.map(g => {
      const h = last[g.key];
      const known = !!h;
      const pass = h ? h.passed === true : false;
      const stateAr = !known ? t('unchecked') : (pass ? t('passed_l') : t('failed_l'));
      const cls = !known ? 'idle' : (pass ? 'ok' : 'bad');
      return '<div class="gov-row ' + (!known ? '' : (pass ? 'ok' : 'bad')) + '">' +
        '<span class="gov-name">' + esc(gateNameL(g.key)) + (g.key === 'rollback_proven' ? ' <span class="hint">' + t('gate_rollback_note') + '</span>' : '') + '</span>' +
        '<span class="mono dim gov-key">' + esc(g.key) + '</span>' +
        '<span class="gov-badge gov-badge-' + cls + '">' + stateAr + '</span>' +
        '<span class="hint gov-detail">' + esc(known ? serverFix('gate', h.detail || '') : t('not_checked_session')) + '</span>' +
        '</div>';
    }).join('');
  }

  function renderGatesResult(out) {
    if (!out || out.error || !Array.isArray(out.gates)) {
      govBadge('gov-gates-release', 'bad', t('check_failed'));
      govBadge('gov-release-badge', 'bad', t('check_failed'));
      govMsg('gov-gates', t('err_gates') + ' ' + ((out && out.error) || t('unexpected')), true);
      return;
    }
    const can = out.canRelease === true;
    govBadge('gov-gates-release', can ? 'ok' : 'bad', can ? t('release_ok') : t('release_no'));
    govBadge('gov-release-badge', can ? 'ok' : 'bad', can ? t('release_ok') : t('release_no'));
    const failed = out.gates.filter(g => g && !g.pass);
    const hint = $id('gov-gates-hint');
    if (hint) hint.textContent = can ? t('gates_all_pass') : t('gates_failed_list').replace('{n}', String(failed.length)).replace('{list}', failed.map(g => gateNameL(g.key)).join(', '));
    const el = $id('gov-gates'); if (!el) return;
    el.innerHTML = out.gates.map(g => {
      const label = gateNameL(g.key);
      const pass = g.pass === true;
      return '<div class="gov-row ' + (pass ? 'ok' : 'bad') + '">' +
        '<span class="gov-name">' + esc(label) + (g.key === 'rollback_proven' ? ' <span class="hint">' + t('rollback_desc') + '</span>' : '') + '</span>' +
        '<span class="mono dim gov-key">' + esc(g.key) + '</span>' +
        '<span class="gov-badge gov-badge-' + (pass ? 'ok' : 'bad') + '">' + (pass ? t('passed_l') : t('failed_l')) + '</span>' +
        '<span class="hint gov-detail">' + esc(govTail(serverFix('gate', serverText(g.detail || '')))) + '</span>' +
        '</div>';
    }).join('');
  }

  /* ③ الاستهلاك — التكلفة غير المعروفة تُعرض عدداً، ولا تُخمَّن */
  function renderUsage(u) {
    const el = $id('gov-usage'); if (!el) return;
    if (!u || u.error) { govMsg('gov-usage', t('err_usage') + ' ' + ((u && u.error) || t('unexpected')), true); return; }
    const cells = [
      [t('u_calls'), govInt(u.calls)],
      [t('u_prompt'), govInt(u.promptTokens)],
      [t('u_completion'), govInt(u.completionTokens)],
      [t('u_known'), '$' + (Number.isFinite(Number(u.knownCost)) ? Number(u.knownCost).toFixed(4) : '0.0000')],
      [t('u_unknown'), govInt(u.unknownCostCalls)]
    ];
    el.innerHTML = cells.map(([k, v]) =>
      '<div class="card soft gov-cell"><div class="card-k">' + esc(k) + '</div><div class="card-v">' + esc(v) + '</div></div>'
    ).join('');
  }

  /* ④ سياسة الخصوصية (كما هي) + سجل الاتصالات */
  function renderPrivacy(p) {
    const el = $id('gov-privacy'); if (!el) return;
    if (!p || p.error) {
      el.innerHTML = '<div class="hint gov-err">' + t('err_privacy') + ' ' + esc((p && p.error) || t('unexpected')) + '</div>';
      return;
    }
    let pol = '';
    if (p.policy && typeof p.policy === 'object') {
      pol = Object.keys(p.policy).map(k => {
        const v = p.policy[k] || {};
        return '<div class="gov-row"><span class="gov-name mono">' + esc(k) + '</span>' +
          '<span class="gov-badge gov-badge-' + (v.allowed ? 'ok' : 'locked') + '">' + (v.allowed ? t('allowed') : t('forbidden')) + '</span>' +
          '<span class="hint gov-detail">' + esc(govTail(serverFix('policy', v.note || ''))) + '</span></div>';
      }).join('');
    }
    el.innerHTML = '<div class="gov-notice">' + esc(govTail(serverText(p.notice || '')) || t('no_privacy_notice')) + '</div>' +
      '<div class="hint mono gov-line">' + t('l_provider') + ': ' + esc(p.provider || '—') + ' • ' + t('url_word') + ': ' + esc(p.baseUrl || '—') + '</div>' + pol;
  }

  function renderConnections(c) {
    const el = $id('gov-connections'); if (!el) return;
    if (!c || c.error) { govMsg('gov-connections', t('err_connections') + ' ' + ((c && c.error) || t('unexpected')), true); return; }
    const items = Array.isArray(c.items) ? c.items : [];
    if (!items.length) { el.innerHTML = '<div class="hint">' + t('no_connections') + '</div>'; return; }
    el.innerHTML = items.map(it => {
      const bad = it.ok === false || !!it.error;
      return '<div class="gov-row">' +
        '<span class="hint mono">' + esc(it.at || '') + '</span>' +
        '<span class="gov-name">' + esc(it.provider || it.purpose || it.kind || t('ext_connection')) + '</span>' +
        '<span class="gov-badge gov-badge-' + (bad ? 'bad' : 'ok') + '">' + (bad ? t('res_fail') : t('res_ok')) + '</span>' +
        '<span class="hint gov-detail mono">' + esc(it.url || it.baseUrl || it.detail || it.error || '') + '</span></div>';
    }).join('');
  }

  /* ⑤ التقييم الذاتي: المقاييس + الضعف + المقترحات (اعتماد/رفض، والاعتماد محجوب بلا تجربة) */
  function renderImprovement(data) {
    const mEl = $id('gov-eval-metrics');
    const wEl = $id('gov-weaknesses');
    const pEl = $id('gov-proposals');
    if (!data || data.error || !data.evaluation) {
      if (mEl) mEl.innerHTML = '';
      govMsg('gov-weaknesses', t('err_eval') + ' ' + ((data && data.error) || t('unexpected')), true);
      if (pEl) pEl.innerHTML = '<div class="hint">—</div>';
      return;
    }
    const ev = data.evaluation || {};
    const m = ev.metrics || {};
    if (mEl) {
      const cells = [
        [t('ev_scope'), ev.scope || m.scope || '—'], [t('ev_tasks'), govInt(m.tasks)], [t('ev_done'), govInt(m.done)],
        [t('ev_failed'), govInt(m.failed)], [t('ev_blocked'), govInt(m.blocked)], [t('ev_pending'), govInt(m.pending)],
        [t('ev_rate'), m.successRatePct != null ? String(m.successRatePct) + '%' : '—'],
        [t('ev_avgdur'), m.avgDurationMs != null ? String(Math.round(Number(m.avgDurationMs) / 1000)) : '—'],
        [t('ev_noev'), govInt(m.tasksWithoutEvidence)],
        [t('ev_noev_pct'), m.noEvidencePct != null ? String(m.noEvidencePct) + '%' : '—'],
        [t('ev_retried'), govInt(m.retriedTasks)],
        [t('ev_mcp'), govInt(m.mcpApprovalTools)]
      ];
      mEl.innerHTML = cells.map(([k, v]) =>
        '<div class="card soft gov-cell"><div class="card-k">' + esc(k) + '</div><div class="card-v">' + esc(String(v)) + '</div></div>'
      ).join('');
    }

    const weak = Array.isArray(ev.weaknesses) ? ev.weaknesses : [];
    if (wEl) {
      wEl.innerHTML = weak.length ? weak.map(w =>
        '<div class="gov-row sev-' + esc(GOV_SEV.indexOf(w.severity) >= 0 ? w.severity : 'low') + '">' +
        '<span class="gov-badge gov-badge-' + govSevBadge(w.severity) + '">' + esc(w.severity || '—') + '</span>' +
        '<span class="gov-name">' + esc(govTail(serverFix('gate', serverText(w.label || w.code || '')))) + '</span>' +
        '<span class="hint gov-detail">' + esc(govTail(serverFix('gate', serverText(w.message || '')))) + '</span>' +
        (w.threshold ? '<span class="hint mono">' + t('threshold_word') + ' ' + esc(w.threshold) + '</span>' : '') +
        '</div>').join('') : '<div class="hint">' + t('no_weakness') + '</div>';
    }

    /* حالة التجربة من history: لا اعتماد قبل تجربة مُنجزة وتفوّق مُثبَت */
    const hist = Array.isArray(data.history) ? data.history : [];
    const trials = {};
    hist.forEach(h => { const pid = h && h.proposal && h.proposal.id; if (pid && !trials[pid]) trials[pid] = h; });
    const props = Array.isArray(ev.proposals) ? ev.proposals : [];
    if (pEl) {
      pEl.innerHTML = props.length ? props.map(pr => {
        const tr = trials[pr.id] || null;
        const verdict = tr ? String(tr.verdict || '') : '';
        const trialed = verdict === 'trialed';
        const passed = !!(tr && tr.trialResult && tr.trialResult.passed === true);
        const allowed = pr.allowed !== false;
        const canDecide = !!tr && trialed;
        const canAccept = canDecide && passed;
        const stateAr = verdict === 'accepted' ? t('prop_accepted') : verdict === 'rejected' ? t('prop_rejected')
          : trialed ? (passed ? t('prop_passed') : t('prop_trialed')) : t('prop_notried');
        const vBadge = verdict === 'accepted' ? 'ok' : (verdict === 'rejected' ? 'bad' : (trialed ? 'warn' : 'idle'));
        const why = !allowed ? (pr.rejectReason || t('why_forbidden'))
          : (!trialed ? t('why_notried')
            : (!passed ? t('why_failed') : ''));
        return '<div class="gov-row ' + (canAccept ? 'ok' : 'locked') + '">' +
          '<span class="gov-name">' + esc(pr.title || pr.id) + ' <span class="hint mono">' + esc(pr.target || '') + '</span></span>' +
          '<span class="gov-badge gov-badge-' + vBadge + '">' + esc(stateAr) + '</span>' +
          '<span class="hint gov-detail">' + esc(govTail(serverFix('gate', serverText(pr.reason || '')))) + '</span>' +
          '<span class="hint mono">' + t('acceptance_word') + ' ' + esc(govTail(serverText(pr.acceptance || ''))) + '</span>' +
          '<span class="hint mono">' + t('impact_word') + ' ' + esc(String(pr.impact == null ? '—' : pr.impact)) +
          (tr && tr.trialResult && tr.trialResult.delta != null ? ' ' + t('trial_delta') + ' ' + esc(String(tr.trialResult.delta)) : '') + '</span>' +
          '<button class="btn primary sm gov-imp-accept" type="button" data-trial="' + esc(tr ? String(tr.id) : '') + '" data-pid="' + esc(pr.id) + '"' +
          (canAccept ? '' : ' disabled') + ' title="' + esc(why || t('tt_accept')) + '">' + t('b_accept') + '</button>' +
          '<button class="btn ghost sm gov-imp-reject" type="button" data-trial="' + esc(tr ? String(tr.id) : '') + '" data-pid="' + esc(pr.id) + '"' +
          (canDecide ? '' : ' disabled') + ' title="' + esc(canDecide ? t('tt_reject') : t('tt_no_decide')) + '">' + t('b_reject') + '</button>' +
          (why ? '<span class="hint gov-err gov-why">' + esc(why) + '</span>' : '') +
          '</div>';
      }).join('') : '<div class="hint">' + t('no_proposals') + '</div>';
    }
  }

  /* ⑥ الحجر: الإحصاء + الجدول + رفع الحجر بسبب إلزامي */
  function renderQuarantine(q) {
    const statsEl = $id('gov-quarantine-stats');
    const el = $id('gov-quarantine');
    if (!q || q.error) {
      if (statsEl) statsEl.innerHTML = '';
      govMsg('gov-quarantine', t('err_quarantine') + ' ' + ((q && q.error) || t('unexpected')), true);
      return;
    }
    const s = q.stats || {};
    if (statsEl) {
      const cells = [[t('q_total'), s.total], [t('q_open'), s.open], [t('q_cleared'), s.cleared],
        [t('q_scanned'), s.scanned], [t('q_unscanned'), s.unscanned], [t('q_isolations'), s.isolations]];
      statsEl.innerHTML = cells.map(([k, v]) =>
        '<div class="card soft gov-cell"><div class="card-k">' + esc(k) + '</div><div class="card-v">' + esc(govInt(v)) + '</div></div>'
      ).join('');
    }
    if (!el) return;
    const items = Array.isArray(q.items) ? q.items : [];
    if (!items.length) { el.innerHTML = '<div class="hint">' + t('no_quar_rows') + '</div>'; return; }
    el.innerHTML = items.map(it => {
      const sev = GOV_SEV.indexOf(it.severity) >= 0 ? it.severity : 'low';
      const id = String(it.id);
      return '<div class="gov-row sev-' + esc(sev) + '">' +
        '<span class="mono dim">#' + esc(id) + '</span>' +
        '<span class="gov-name">' + esc(it.path || '—') + '</span>' +
        '<span class="gov-badge gov-badge-' + govSevBadge(sev) + '">' + esc(sev) + '</span>' +
        '<span class="hint gov-detail">' + esc(govTail(serverFix('gate', serverText(it.reason || '')))) + '</span>' +
        '<input class="input sm gov-q-reason" data-qid="' + esc(id) + '" dir="auto" placeholder="' + t('ph_q_reason') + '" />' +
        '<button class="btn primary sm gov-q-clear" type="button" data-qid="' + esc(id) + '">' + t('b_q_clear') + '</button>' +
        '</div>';
    }).join('');
  }

  /* ⑦ سلامة التدقيق: شارة خضراء/حمراء */
  function renderAudit(a) {
    const det = $id('gov-audit-detail');
    if (!a || a.error) {
      govBadge('gov-audit-badge', 'bad', t('verify_failed'));
      if (det) det.textContent = (a && a.error) || t('unexpected');
      return;
    }
    const ok = a.ok === true;
    govBadge('gov-audit-badge', ok ? 'ok' : 'bad', ok ? t('audit_ok') : t('audit_broken'));
    const parts = [t('a_lines') + ' ' + govInt(a.lines)];
    if (a.hashedFrom != null) parts.push(t('a_hashed') + ' ' + govInt(a.hashedFrom));
    if (a.unhashed != null) parts.push(t('a_unhashed') + ' ' + govInt(a.unhashed));
    parts.push(t('a_dbrows') + ' ' + govInt(a.dbRows));
    if (a.brokenAt != null) parts.push(t('a_broken_at') + ' ' + a.brokenAt);
    if (det) det.textContent = parts.join(' • ');
  }

  /* ⑧ تغطية أنواع العلاقات التسعة (موجود/غائب) */
  function renderRelations(rel) {
    const el = $id('gov-relations'); if (!el) return;
    const sum = $id('gov-rel-summary');
    if (!rel || rel.error) {
      if (sum) sum.textContent = '';
      govMsg('gov-relations', t('err_relations') + ' ' + ((rel && rel.error) || t('unexpected')), true);
      return;
    }
    const present = Array.isArray(rel.kindsPresent) ? rel.kindsPresent : [];
    const missing = Array.isArray(rel.kindsMissing) ? rel.kindsMissing : [];
    const legacy = Array.isArray(rel.legacyPresent) ? rel.legacyPresent : [];
    let kindList = GOV_KINDS_9;
    if (rel.kinds) {
      if (Array.isArray(rel.kinds)) kindList = rel.kinds.map(k => (typeof k === 'string' ? k : (k && k.key) || '')).filter(Boolean);
      else if (typeof rel.kinds === 'object') kindList = Object.keys(rel.kinds);
    }
    if (!kindList.length) kindList = GOV_KINDS_9;
    if (sum) {
      /* الحقيقة كاملة (2026-11-14): «0 من 9» وحدها لا تفرّق بين «لم يُشغَّل»
         و«شُغِّل ولم يجد». الصفوف المُصنَّفة ووقت آخر استنتاج يوضّحان الفرق. */
      const typed = Number(rel.typedRows || 0);
      const last = rel.lastInferredAt ? new Date(rel.lastInferredAt) : null;
      const lastTxt = last && !isNaN(last)
        ? last.toLocaleString(LANG === 'en' ? 'en-US' : 'ar-EG', { hour12: false })
        : t('rel_never');
      sum.textContent = t('rel_present') + ' ' + govInt(rel.present != null ? rel.present : present.length) +
        ' ' + t('rel_of') + ' ' + govInt(rel.total != null ? rel.total : kindList.length) +
        ' • ' + t('rel_typed') + ' ' + govInt(typed) +
        ' • ' + t('rel_last') + ' ' + lastTxt +
        ' • ' + t('rel_legacy') + ' ' + (legacy.length ? legacy.join(', ') : t('rel_none')) +
        ' • ' + t('sev_rows') + ' ' + govInt(rel.severityRows || 0);
    }
    const pset = new Set(present), mset = new Set(missing);
    el.innerHTML = kindList.map(k => {
      const ar = (rel.kinds && !Array.isArray(rel.kinds) && rel.kinds[k] && rel.kinds[k].ar) ? rel.kinds[k].ar : relKindL(k);
      const has = pset.has(k);
      const known = has || mset.has(k);
      const cls = has ? 'ok' : (known ? 'bad' : 'idle');
      const txt = has ? t('kind_present') : (known ? t('kind_missing') : t('kind_untracked'));
      /* الاسم العربي كاملاً والمفتاح في التلميح (2026-11-14): كان القصّ
         يبتر النص إلى «…sponsible_for» داخل بطاقة ضيقة. المفتاح الإنجليزي
         أداة تشخيص لا عنوان — مكانه title. */
      return '<div class="gov-kind ' + cls + '" title="' + esc(k) + '">' +
        '<span class="gov-name">' + esc(ar) + '</span>' +
        '<span class="gov-badge gov-badge-' + cls + '">' + txt + '</span></div>';
    }).join('');
  }

  /* ⑨ التراجع: قائمة التغييرات + زر أرجع + إثبات التراجع */
  function renderRollback(roll) {
    const el = $id('gov-rollback'); if (!el) return;
    const st = $id('gov-rollback-stats');
    if (!roll || roll.error) {
      if (st) st.textContent = '';
      govMsg('gov-rollback', t('err_rollback') + ' ' + ((roll && roll.error) || t('unexpected')), true);
      return;
    }
    const s = roll.stats || {};
    if (st) st.textContent = t('rb_total') + ' ' + govInt(s.total) + ' • ' + t('rb_reverted') + ' ' + govInt(s.reverted) + ' • ' + t('rb_pending') + ' ' + govInt(s.pending);
    const items = Array.isArray(roll.items) ? roll.items : [];
    if (!items.length) { el.innerHTML = '<div class="hint">' + t('no_rb_changes') + '</div>'; return; }
    el.innerHTML = items.map(it =>
      '<div class="gov-row">' +
      '<span class="mono dim">#' + esc(String(it.id)) + '</span>' +
      '<span class="gov-name">' + esc(it.entity || t('entity_word')) + ' • ' + esc(it.entityId || '') + '</span>' +
      '<span class="gov-badge gov-badge-idle">' + esc(it.op || 'update') + '</span>' +
      '<span class="hint mono">' + esc(it.at || '') + '</span>' +
      '<button class="btn ghost sm gov-rb-revert" type="button" data-id="' + esc(String(it.id)) + '" data-entity="' + esc(it.entity || 'note') + '">' + t('b_revert') + '</button>' +
      '</div>').join('');
  }

  function renderRollbackProof(out) {
    const stepsEl = $id('gov-rollback-steps');
    if (!out || out.error) {
      govBadge('gov-rollback-badge', 'bad', t('not_proven'));
      govMsg('gov-rollback-steps', t('err_rbproof') + ' ' + ((out && out.error) || t('unexpected')), true);
      return;
    }
    const proven = out.proven === true;
    govBadge('gov-rollback-badge', proven ? 'ok' : 'bad', proven ? t('rb_proven') : t('not_proven'));
    const hint = $id('gov-rollback-hint');
    if (hint) hint.textContent = proven ? 'proven = true' : 'proven = false';
    const steps = Array.isArray(out.steps) ? out.steps : [];
    if (stepsEl) {
      stepsEl.innerHTML = steps.map(s =>
        '<span class="gov-step ' + (s.ok ? 'ok' : 'bad') + '">' + esc(s.step || '') + (s.note ? ' — ' + esc(s.note) : '') + '</span>'
      ).join('');
    }
  }

  /* ── الأفعال: كل واحد يعطّل زرّه ويُظهر نتيجته أو خطأه نصاً ── */
  async function proveStageNow(btn) {
    const key = btn.getAttribute('data-prove');
    const ar = btn.getAttribute('data-ar') || key;
    const def = t('prove_default').replace('{s}', ar);
    const asked = window.prompt(t('prove_prompt').replace('{s}', ar), def);
    if (asked == null) return;
    const evidence = String(asked).trim();
    if (!evidence) { toast(t('evidence_required')); return; }
    btn.disabled = true; const lbl = btn.textContent; btn.textContent = t('busy_prove');
    const out = await jpost('/api/stages/prove', { stage: key, evidence: { text: evidence, by: 'user' } });
    if (!out || out.error || out.ok === false) {
      toast('⚠ ' + ((out && out.error) || t('err_prove')));
      btn.disabled = false; btn.textContent = lbl; return;
    }
    toast(t('proven_stage') + ' ' + (out.name || ar));
    await loadGovernance();
  }

  async function checkGatesNow() {
    govDisable('gov-gates-check', true, t('busy_check'));
    const out = await jpost('/api/gates/check', {});
    renderGatesResult(out);
    govDisable('gov-gates-check', false);
    if (out && Array.isArray(out.gates)) {
      const failed = out.gates.filter(g => g && !g.pass).length;
      toast(out.canRelease === true ? t('toast_gates_ok') : t('toast_gates_no').replace('{n}', String(failed)));
    }
  }

  async function inferRelationsNow() {
    govDisable('gov-rel-infer', true, t('busy_infer'));
    const hint = $id('gov-rel-hint');
    const out = await jpost('/api/relations/infer', {});
    if (!out || out.error || out.ok === false) {
      if (hint) hint.textContent = '⚠ ' + ((out && out.error) || t('err_infer'));
      toast('⚠ ' + ((out && out.error) || t('err_infer_full')));
    } else {
      const added = out.added != null ? out.added : (out.count != null ? out.count : 0);
      if (hint) hint.textContent = t('added_rels').replace('{n}', govInt(added));
      toast(t('toast_inferred').replace('{n}', govInt(added)));
      renderRelations(await jget('/api/relations/coverage'));
    }
    govDisable('gov-rel-infer', false);
  }

  /* اشتقاق الخطورة (2026-11-14): المسار كان موجوداً في الخادم بلا زر —
     فبقي severity_evidence = 0 أبداً. الاشتقاق صادق: لا يكتب صفاً بلا دليل،
     ويقول كم ملاحظة لم تُقدَّر وكم كُتب. */
  async function deriveSeverityNow() {
    govDisable('gov-sev-derive', true, t('busy_infer'));
    const hint = $id('gov-rel-hint');
    const out = await jpost('/api/relations/severity', {});
    govDisable('gov-sev-derive', false);
    if (!out || out.error || out.ok === false) {
      if (hint) hint.textContent = '⚠ ' + ((out && out.error) || t('err_infer'));
      return;
    }
    const written = Number(out.count || 0);
    const skipped = Number(out.skipped || 0);
    const bad = Number(out.invalidCount || 0);
    const msg = t('sev_done').replace('{n}', govInt(written)).replace('{s}', govInt(skipped));
    if (hint) {
      if (bad) {
        /* قيمة حساسية غير معروفة لا تُحسب — تُقال بالاسم وبالمسموح */
        const one = (out.invalid || [])[0] || {};
        hint.textContent = '⚠ ' + t('sev_invalid').replace('{f}', one.field || 'sensitivity').replace('{v}', one.value || '').replace('{a}', (one.allowed || []).join(' / '));
      } else if (written) hint.textContent = msg;
      else hint.textContent = '⚠ ' + t('sev_none');
    }
    toast(bad ? t('sev_invalid').replace('{f}', 'sensitivity').replace('{v}', ((out.invalid || [])[0] || {}).value || '').replace('{a}', (((out.invalid || [])[0] || {}).allowed || []).join(' / ')) : msg);
    renderRelations(await jget('/api/relations/coverage'));
  }

  async function verifyRollbackNow() {
    govDisable('gov-rollback-verify', true, t('busy_prove'));
    const out = await jpost('/api/rollback/verify', {});
    renderRollbackProof(out);
    govDisable('gov-rollback-verify', false);
    toast(out && out.proven === true ? t('rb_proven') : t('err_rbproof'));
  }

  async function revertChangeNow(btn) {
    const id = btn.getAttribute('data-id');
    const entity = btn.getAttribute('data-entity') || 'note';
    btn.disabled = true; const lbl = btn.textContent; btn.textContent = '…';
    const out = await jpost('/api/rollback/revert', { id: Number(id), entity });
    if (!out || out.error || out.ok === false) {
      toast('⚠ ' + ((out && out.error) || t('err_revert')));
      btn.disabled = false; btn.textContent = lbl; return;
    }
    toast(t('toast_reverted').replace('{n}', String(id)));
    await loadGovernance();
  }

  async function clearQuarantineNow(btn) {
    const id = btn.getAttribute('data-qid');
    const row = btn.closest('.gov-row');
    const input = row ? row.querySelector('.gov-q-reason') : null;
    let reason = input ? String(input.value || '').trim() : '';
    if (!reason) {
      const asked = window.prompt(t('q_prompt').replace('{n}', String(id)), '');
      reason = asked == null ? '' : String(asked).trim();
    }
    if (!reason) {
      if (input) input.classList.add('req');
      toast(t('reason_required'));
      return;
    }
    if (input) input.classList.remove('req');
    btn.disabled = true; const lbl = btn.textContent; btn.textContent = '…';
    const out = await jpost('/api/quarantine/clear', { id: Number(id), by: 'user', reason });
    if (!out || out.error || out.ok === false) {
      toast('⚠ ' + ((out && out.error) || t('err_q_clear')));
      btn.disabled = false; btn.textContent = lbl; return;
    }
    toast(t('toast_q_cleared').replace('{n}', String(id)));
    await loadGovernance();
  }

  async function decideProposal(btn, accept) {
    const trialId = btn.getAttribute('data-trial');
    if (!trialId) { toast(t('no_trial')); return; }
    btn.disabled = true; const lbl = btn.textContent; btn.textContent = '…';
    const out = await jpost('/api/improve/decide', { id: Number(trialId), accept: !!accept, by: 'user' });
    if (!out || out.error || out.ok === false) {
      toast('⚠ ' + ((out && out.error) || t('err_decide')));
      btn.disabled = false; btn.textContent = lbl; return;
    }
    toast(accept ? t('toast_accept') : t('toast_reject'));
    await loadGovernance();
  }

  function govWire() {
    if (GOV_WIRED) return;
    GOV_WIRED = true;
    const on = (id, fn) => { const el = $id(id); if (el) el.onclick = fn; };
    on('gov-refresh', () => loadGovernance());
    on('gov-gates-check', () => checkGatesNow());
    on('gov-rel-infer', () => inferRelationsNow());
    on('gov-sev-derive', () => deriveSeverityNow());
    on('gov-rollback-verify', () => verifyRollbackNow());
    /* التبويبات: حالة واحدة مصدرها GOV_TAB — النقر يبدّل البطاقات المرئية */
    document.querySelectorAll('#gov-tabs [data-gov-tab]').forEach((b) => {
      b.onclick = () => showGovTab(b.getAttribute('data-gov-tab'));
    });
    showGovTab(GOV_TAB);
    const deleg = (id, sel, fn) => {
      const root = $id(id); if (!root) return;
      root.addEventListener('click', (e) => { const b = e.target.closest(sel); if (b) fn(b); });
    };
    deleg('gov-stages', '[data-prove]', (b) => proveStageNow(b));
    deleg('gov-quarantine', '.gov-q-clear', (b) => clearQuarantineNow(b));
    deleg('gov-proposals', '.gov-imp-accept', (b) => decideProposal(b, true));
    deleg('gov-proposals', '.gov-imp-reject', (b) => decideProposal(b, false));
    deleg('gov-rollback', '.gov-rb-revert', (b) => revertChangeNow(b));
  }

  async function loadGovernance() {
    govWire();
    govErr(null);
    govDisable('gov-refresh', true, '…');
    try {
      const [stages, gates, usage, conns, privacy, quar, improve, rel, rollback, audit] = await Promise.all([
        jget('/api/stages'),
        jget('/api/gates'),
        jget('/api/usage'),
        jget('/api/connections'),
        jget('/api/privacy/notice?lang=' + encodeURIComponent(LANG || 'ar')),
        jget('/api/quarantine'),
        jget('/api/improve?lang=' + encodeURIComponent(LANG || 'ar')),
        jget('/api/relations/coverage'),
        jget('/api/rollback/changes'),
        jget('/api/audit/verify')
      ]);
      renderStages(stages);
      if (gates && Array.isArray(gates.gates) && gates.gates.length && gates.gates[0] && ('pass' in gates.gates[0])) renderGatesResult(gates);
      else renderGatesCatalog(gates);
      renderUsage(usage);
      renderConnections(conns);
      renderPrivacy(privacy);
      renderQuarantine(quar);
      renderImprovement(improve);
      renderRelations(rel);
      renderRollback(rollback);
      renderAudit(audit);
      loadBackups();
      const upd = $id('gov-updated');
      if (upd) upd.textContent = new Date().toLocaleString(LANG === 'en' ? 'en-US' : 'ar-EG', { hour12: false });
    } catch (e) {
      govErr(t('err_gov') + ' ' + (e && e.message ? e.message : String(e)));
    } finally {
      govDisable('gov-refresh', false);
    }
  }

  // ─────────── ⑩ الإقلاع ───────────
  function boot() {
    // تبديل الشاشات
    document.querySelectorAll('#rail .rail-btn[data-view]').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });
    // Omnibox يفتح لوحة الأوامر
    const ob = $id('palette-open-btn');
    if (ob) ob.onclick = () => { const p = $id('palette'); if (p) { p.classList.remove('hidden'); const i = $id('palette-input'); if (i) i.focus(); } else if (typeof openPalette === 'function') openPalette(); };
    wireAddProvider(); wireImport(); wireRepos(); wireMonitor(); wireMcp(); wireSkillAdd(); wireAsk(); wireVault(); wireBackups(); wireAgents(); wireAgentTabs(); wireTeam(); wireNotesFilter(); wireAgentExtras();
    window.__runAgentStream = runAgentStream;   // يستخدمه زر الإرسال
    // إعادة رندر حية عند تبديل لغة الواجهة (يستدعيها setLang عبر body.__langRefresh)
    document.body.__langRefresh = () => {
      const onView = (id) => { const v = document.getElementById(id); return !!(v && v.classList.contains('on')); };
      try { loadStatus(); } catch (e) {}
      try {
        const sb = document.getElementById('status-badge');
        const LS = window.__cortexLastStatus;
        if (sb && LS && LS.connected) {
          const m = String(LS.detail).match(/^(\d+)\s+\S+\s*•\s*(.*)$/);
          if (m) sb.textContent = m[1] + ' ' + (LANG === 'en' ? (Number(m[1]) === 1 ? 'item' : 'items') : String.fromCharCode(0x0639, 0x0646, 0x0635, 0x0631)) + ' • ' + m[2];
        }
      } catch (e) {}
      /* إعادة رندر الخريطة المخفية باللغة الجديدة — بعد استقرار الدورة (300ms):
         السباق المُقاس 2026-10-24: __langRefresh تُنادى **قبل** استقرار وسم اللغة
         وLANG، فرندرنا المباشر ثم يطغى عليه جلب loadGraph المتأخر بالعربية.
         التأخير يضمن قراءة الحالة النهائية؛ وloadGraph اللاحق يستخدم نفس الحالة. */
      setTimeout(() => {
        try {
          const fmHost = document.getElementById('filemap-root');
          if (typeof FILEMAP_DATA !== 'undefined' && FILEMAP_DATA && fmHost && window.CortexFilemap) {
            window.CortexFilemap.render(fmHost, FILEMAP_DATA, filemapOpts());
          }
        } catch (e) { console.error('fm relang', e); }
      }, 300);
      try { if (onView('view-graph')) loadGraph(); } catch (e) {}
      try { applyRailAria(); } catch (e) {}
      try { if (typeof loadGovernance === 'function' && (onView('view-governance') || GOV_WIRED)) loadGovernance(); } catch (e) {}
      try { if (typeof renderFindings === 'function') renderFindings(); } catch (e) {}
      // العنصر المفتوح: بياناته الوصفية (النوع/المرحلة) تُعاد بلغة الواجهة الجديدة
      try { if (typeof paintNote === 'function' && S.activeNote) paintNote(); } catch (e) {}
      try { if (typeof renderSidebar === 'function') renderSidebar(); } catch (e) {}
      try { if (typeof renderTypeOptions === 'function') renderTypeOptions(); } catch (e) {}
      try { if (typeof refreshNodePanel === 'function') refreshNodePanel(); } catch (e) {}
      try { if (onView('view-monitor')) loadMonitor(); } catch (e) {}
      try { if (onView('view-providers')) loadProviders(); } catch (e) {}
      try { if (onView('view-import')) loadImport(); } catch (e) {}
      try { if (onView('view-tools')) { loadMcp(); loadSkills(); } } catch (e) {}
      try { wireTeam(); wireAgentExtras(); } catch (e) {}
      try {
        document.querySelectorAll('#mcp-servers .pkey, #provider-list .pkey').forEach((pk) => {
          const s = pk.textContent;
          const m = s.match(/^(\d+)\s+[^\s·]+\s*·\s*(.+)$/);
          if (m && /أداة|tools/i.test(s)) pk.textContent = m[1] + ' ' + t('tools_unit') + ' · ' + (/جاهز|ready/i.test(s) ? t('ready_word') : (/متصّل|connected/i.test(s) ? t('connected') : t('disconnected')));
        });
        document.querySelectorAll('#provider-list .pkey').forEach((pk) => {
          pk.textContent = pk.textContent
            .replace(/\d+\s*(?:نموذج|models?)/, (w) => w.replace(/\s*(?:نموذج|models?)$/, ' ' + t('models_unit')))
            .replace(/مفعّل|enabled/, t('enabled'))
            .replace(/معطّل|disabled/, t('disabled'));
        });
      } catch (e) {}
      try { if (S.activeNote) loadContext(S.activeNote.id); } catch (e) {}
    };
    // اجعل فتح المحرر يبدّل للشاشة الأولى
    window.__openNoteById = (id) => { switchView('notes'); try { typeof openNote === 'function' && openNote(id); } catch (e) { console.warn(e); } };
    applyRailAria();
    /* فتح قسم مباشرة عبر ?view= — تستعمله بوابة «مركز التشغيل» في الواجهة الجديدة (/next/)
       فكل بطاقة تفتح قسمها الكلاسيكي بعمق نقرة واحدة، لا مجرد الصفحة الأولى. */
    try {
      const want = new URLSearchParams(location.search).get('view');
      if (want && document.querySelector('.rail-btn[data-view="' + want.replace(/[^a-z]/g, '') + '"]')) switchView(want);
    } catch (e) { /* تحسيني */ }
    if (!VIEW_INIT.notes) { VIEW_INIT.notes = 1; loadStatus().catch(() => {}); }
    loadStatus().catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 60));
  else setTimeout(boot, 60);
})();
