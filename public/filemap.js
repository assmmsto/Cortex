'use strict';
/**
 * Cortex — خريطة «من يعتمد على من» بنظام FileMap (مركز + عمودان + شريط أرقام).
 *
 * النسخة الداكنة (قرار 2026-10-24 مساءً): نفس تصميم وسلوك المرجع
 * (E:\هيرمز\ءء\filemap\template.html) لكن **بألوان نظام Cortex** (amber/accent
 * الداكن) بدل اللوحة الفاتحة — لا وميض تباين داخل التطبيق. الإضافات فوق المرجع:
 *   • ملء الشاشة: height:calc(100vh-210px) + شبكة نقاط خافتة + قائمة هجينة
 *     (شرائح المجلدات + أعلى العناصر بالأسماء) + اقتراحات في العمود الفارغ.
 *   • أسلاك من الشرائح أيضاً، لا من البطاقات فقط.
 *   • نقرة = تمركز · نقرة مزدوجة = فتح في المعرفة (onOpen).
 *   • العنصر المفتوح حالياً يُعلَّم بإطار ذهبي + شارة «مفتوح الآن» في المحور.
 *   • مسطرة سياق للفلتر النشط + مسار فتات للرجوع لأي مستوى.
 * الثوابت المطابقة للمرجع: CAP_SMALL=8, ROLLUP_AT=12, CAP_EXPANDED=14, WIRE_LIMIT=60.
 */
(function (global) {
  const CSS = `
  .fm-root{font-family:var(--sans,"Segoe UI",system-ui,sans-serif);font-size:14px;line-height:1.5;
    color:var(--txt);max-width:none;margin:0;padding:0 0 4px}
  .fm-root *{box-sizing:border-box}
  .fm-stage{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:6px;
    padding:22px 20px;flex:1 1 auto;min-height:320px;overflow:hidden;
    background-image:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px);
    background-size:26px 26px;
    display:grid;grid-template-columns:300px minmax(0,1fr) 300px;grid-template-rows:minmax(0,1fr);gap:18px;align-items:stretch}
  .fm-stage::before{content:"";position:absolute;inset:0;border-radius:6px;pointer-events:none;
    background:radial-gradient(46% 52% at 50% 50%,rgba(232,179,75,.05),transparent 70%)}
  .fm-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
  .fm-wires path.fm-wire{fill:none;stroke:var(--line2);stroke-width:1;transition:stroke .18s,stroke-width .18s,opacity .18s}
  .fm-wires path.fm-wire.chip{stroke-dasharray:3 5;stroke-opacity:.55}
  .fm-wires path.fm-wire.fm-hot{stroke:var(--amber);stroke-width:1.7;filter:drop-shadow(0 0 4px rgba(232,179,75,.45))}
  .fm-wires path.fm-wire.fm-hot-in{stroke-dasharray:5 7;animation:fm-flow 1.1s linear infinite}
  .fm-wires path.fm-wire.fm-dim{opacity:.3}
  @keyframes fm-flow{to{stroke-dashoffset:-24}}
  .fm-col{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;gap:9px;
    min-width:0;min-height:0;max-height:100%;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px}
  .fm-col::-webkit-scrollbar{width:8px}
  .fm-col::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:8px}
  .fm-col::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.18)}
  .fm-col.dense{justify-content:flex-start;mask-image:linear-gradient(to bottom,#000 calc(100% - 26px),transparent 100%)}
  .fm-col-title{font-size:12px;color:var(--txt);opacity:.85;font-weight:600;margin:0 0 2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .fm-col-title > span:last-child{color:var(--dim2);font-weight:400}
  .fm-filter-badge{font:inherit;font-size:10.5px;color:var(--amber);background:transparent;border:1px solid var(--amber);
    border-radius:999px;padding:1px 8px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fm-filter-badge:hover{background:var(--amber-dim)}
  .fm-group-label{font-size:11px;color:var(--dim);font-weight:600;margin:8px 2px 0}
  .fm-node{position:relative;display:flex;align-items:center;gap:9px;background:var(--panel2);
    border:1px solid var(--line2);border-radius:4px;padding:9px 12px;cursor:pointer;text-align:start;
    font:inherit;color:inherit;width:100%;min-width:0;transition:border-color .16s,box-shadow .16s,transform .16s}
  .fm-node:hover,.fm-node:focus-visible{border-color:var(--amber);box-shadow:0 2px 10px rgba(0,0,0,.35);outline:none}
  .fm-node:active{transform:translateY(1px)}
  .fm-node.fm-active{border-color:var(--amber);box-shadow:0 0 0 1px var(--amber) inset}
  .fm-node .fm-dot{width:7px;height:7px;border-radius:50%;background:var(--amber);flex:none;opacity:.85}
  .fm-node.fm-active .fm-dot{background:var(--teal);opacity:1}
  .fm-node .fm-nm{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;unicode-bidi:isolate}
  .fm-node .fm-ext{font-size:10.5px;color:var(--dim);flex:none}
  .fm-node::after{content:"";position:absolute;top:50%;width:7px;height:7px;border-radius:50%;
    background:var(--panel2);border:1px solid var(--line2);transform:translateY(-50%)}
  .fm-col-left .fm-node::after{left:-4px}
  .fm-col-right .fm-node::after{right:-4px}
  .fm-node.ghost{border-style:dashed;color:var(--dim);background:transparent;font-size:12px;justify-content:center;padding:7px 12px}
  .fm-node.ghost::after{display:none}
  .fm-chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0}
  .fm-chip{font:inherit;font-size:12px;color:var(--dim);background:transparent;border:1px solid var(--line2);
    border-radius:999px;padding:4px 11px;cursor:pointer;display:inline-flex;gap:5px;align-items:center;
    max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fm-chip b{font-weight:600;color:var(--txt);font-variant-numeric:tabular-nums}
  .fm-chip:hover,.fm-chip:focus-visible{border-color:var(--amber);color:var(--txt);outline:none}
  .fm-hub-wrap{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;min-width:0}
  .fm-hub{background:var(--panel3);color:var(--txt);border:1px solid var(--line2);border-radius:12px;
    padding:16px 22px;min-width:230px;max-width:100%;
    box-shadow:0 14px 36px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03) inset;
    display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center}
  .fm-hub .fm-mark{display:flex;align-items:flex-end;gap:2px;height:20px}
  .fm-hub .fm-mark i{display:block;width:3px;border-radius:2px;background:var(--amber)}
  .fm-hub .fm-mark i:nth-child(1){height:9px;opacity:.55}
  .fm-hub .fm-mark i:nth-child(2){height:15px;opacity:.8}
  .fm-hub .fm-mark i:nth-child(3){height:20px}
  .fm-hub .fm-name{font-size:16px;font-weight:600;unicode-bidi:isolate;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
  .fm-hub .fm-dir{font-size:11px;color:var(--dim);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fm-hub .fm-meta{font-size:11.5px;color:var(--dim)}
  .fm-open-badge{font-size:10px;border:1px solid var(--teal);color:var(--teal);border-radius:999px;padding:1px 8px}
  .fm-hub .fm-back{margin-top:3px;background:transparent;border:1px solid var(--line2);color:var(--dim);
    border-radius:4px;padding:3px 12px;font:inherit;font-size:11px;cursor:pointer}
  .fm-hub .fm-back:hover,.fm-hub .fm-back:focus-visible{border-color:var(--amber);color:var(--txt);outline:none}
  .fm-crumbs{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:2px;max-width:100%}
  .fm-crumbs button{font:inherit;font-size:10.5px;color:var(--dim);background:transparent;border:1px solid var(--line2);
    border-radius:999px;padding:1px 8px;cursor:pointer;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fm-crumbs button:hover,.fm-crumbs button:focus-visible{border-color:var(--amber);color:var(--txt);outline:none}
  .fm-empty{border:1px dashed var(--line2);border-radius:4px;padding:11px;color:var(--dim);font-size:12px;text-align:center}
  .fm-suggest{border:1px dashed var(--line2);border-radius:4px;padding:12px;display:flex;flex-direction:column;gap:8px}
  .fm-suggest .fm-sg-t{font-size:11px;color:var(--dim)}
  .fm-footer{margin-top:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:22px;flex-wrap:wrap}
  .fm-stat{display:flex;flex-direction:column;align-items:flex-start;gap:0}
  .fm-stat b{font-size:30px;font-weight:300;letter-spacing:-.02em;line-height:1.1;color:var(--txt)}
  .fm-stat span{font-size:12px;color:var(--dim)}
  .fm-stat.small{margin-top:7px}
  .fm-stat.small b{font-size:18px}
  .fm-foot-note{color:var(--dim);font-size:11.5px;margin-top:7px;line-height:1.6;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  /* ═══ المستوى الأول: «الجزر» (2026-11-06) ═══
     السبب المقيس: شاشة التركيز ترسم 5 عقد من 94، وتمنع الأسلاك فوق 60 عنصراً.
     فتُعرض المجلدات أولاً (50 مجلداً تُرى كاملة) والتفاصيل عند الطلب. */
  .fm-root{display:flex;flex-direction:column;flex:1;min-height:0}
  .fm-overview{flex:none;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:11px 13px;margin:0 0 10px}
  .fm-ov-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 9px}
  .fm-ov-search{flex:1 1 220px;min-width:0;background:var(--panel2);border:1px solid var(--line2);border-radius:4px;
    color:var(--txt);font:inherit;font-size:12.5px;padding:7px 11px}
  .fm-ov-search:focus-visible{outline:none;border-color:var(--amber)}
  .fm-ov-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
  .fm-ov-btn{font:inherit;font-size:11.5px;color:var(--dim);background:transparent;border:1px solid var(--line2);
    border-radius:999px;padding:5px 11px;cursor:pointer;display:inline-flex;gap:6px;align-items:center;max-width:100%}
  .fm-ov-btn:hover,.fm-ov-btn:focus-visible{border-color:var(--amber);color:var(--txt);outline:none}
  .fm-ov-btn.on{border-color:var(--amber);color:var(--amber);background:var(--amber-dim)}
  .fm-ov-btn b{color:var(--txt);font-variant-numeric:tabular-nums}
  /* اسم العنصر داخل زر إنجليزي: عزل الاتجاه يمنع قلب النقطتين والاسم العربي */
  .fm-ov-btn .fm-nm{unicode-bidi:isolate;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22ch}
  .fm-ov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(188px,1fr));gap:8px;max-height:112px;overflow-y:auto;padding:2px}
  .fm-folder{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;align-items:center;text-align:start;
    background:var(--panel2);border:1px solid var(--line2);border-radius:4px;padding:8px 10px;cursor:pointer;font:inherit;color:inherit;min-width:0}
  .fm-folder:hover,.fm-folder:focus-visible{border-color:var(--amber);outline:none}
  .fm-folder.on{border-color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber)}
  .fm-folder .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
  .fm-folder .ct{font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600}
  .fm-folder .bar{grid-column:1/-1;height:3px;border-radius:2px;background:var(--line2);overflow:hidden;display:flex}
  .fm-folder .bar i{display:block;height:100%;background:var(--teal)}
  .fm-folder .bar u{display:block;height:100%;background:var(--dim2);flex:1}
  .fm-list{flex:none;border:1px solid var(--line);border-radius:6px;background:var(--panel);margin:0 0 10px;padding:10px 12px;max-height:196px;overflow:auto}
  .fm-list-h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 8px;font-size:12.5px}
  .fm-list-h button{font:inherit;font-size:12px;background:transparent;border:1px solid var(--line2);border-radius:3px;color:var(--dim);cursor:pointer;padding:2px 8px}
  .fm-wire-note{flex:none;font-size:11.5px;color:var(--dim);margin:6px 2px 0}
  .fm-wire-note.warn{color:var(--amber)}
  @media (max-width:900px){
    .fm-stage{grid-template-columns:1fr;height:auto;min-height:0;gap:14px}
    .fm-wires{display:none}
    .fm-col{justify-content:flex-start;max-height:none;overflow:visible}
    .fm-hub-wrap{order:-1}
    .fm-node::after{display:none}
  }
  @media (prefers-reduced-motion:reduce){
    .fm-wires path.fm-wire.fm-hot-in{animation:none}
    .fm-root *{transition:none!important}
  }`;

  const CAP_SMALL = 8;
  const ROLLUP_AT = 12;
  const CAP_EXPANDED = 14;
  const WIRE_LIMIT = 60;
  const KIND_ORDER = ['doc', 'project', 'decision', 'task', 'note', 'other'];
  /* ثنائية اللغة كاملة — اللغة تُمرَّر صريحاً من التطبيق (O.lang) لأن الاعتماد
     على قراءة DOM بعد تبديل اللغة ظهر متأخراً في الفحص ⑥ (رندر مخفي قديم). */
  const LABELS = (L) => ({
    in: L('يعتمدون عليه', 'depended on by'),
    out: L('يعتمد على', 'depends on'),
    item: L('عنصر', 'item'),
    items_all: L('عنصراً بالاسم', 'items by name'),
    project: L('مشروع', 'project'),
    projects_fold: L('مشروعاً', 'projects'),
    cycles: L('دورات', 'cycles'),
    orphans: L('يتيمة', 'orphans'),
    edges: L('ارتباط', 'links'),
    back: L('رجوع', 'back'),
    less: L('↩ أقل', '↩ less'),
    all_folders: L('↩ كل المشاريع', '↩ all projects'),
    other: L('أخرى', 'other'),
    none_in: L('لا شيء يعتمد على هذا العنصر', 'Nothing depends on this item'),
    none_out: L('لا عناصر يشير إليها هذا العنصر', 'No items referenced by this item'),
    no_project: L('(بلا مشروع)', '(no project)'),
    lines: L('سطراً', 'lines'),
    most: L('الأكثر ارتباطاً', 'most connected'),
    meta_in: L('يعتمد عليه', 'depended on by'),
    meta_out: L('يعتمد على', 'depends on'),
    view_all: L('عرض كل', 'show all'),
    open_now: L('مفتوح الآن', 'open now'),
    suggest_hint: L('جرّب الأكثر ارتباطاً:', 'try the most connected:'),
    isolated: L('العنصر شبه معزول', 'This item is nearly isolated'),
    click_hint: L('نقرة: تمركز · نقرتان: فتح', 'click: center · double-click: open'),
    clear_filter: L('إزالة الفلتر', 'clear filter'),
    islands: L('الجزر (المجلدات)', 'Islands (folders)'),
    search_ph: L('ابحث في المجلدات والعناصر...', 'Search folders and items...'),
    orphans_list: L('عناصر معزولة عن كل شيء', 'Items isolated from everything'),
    cycles_list: L('دورات الترابط', 'Relation cycles'),
    close: L('إغلاق', 'Close'),
    no_match: L('لا مطابقة', 'No match'),
    wires_hidden: L('الأسلاك مخفية: العناصر المعروضة أكثر من الحد', 'Wires hidden: more elements than the limit'),
    narrow_hint: L('اختر مجلداً أو عنصراً لتضييق العرض', 'pick a folder or item to narrow it'),
    wires_count: L('سلكاً', 'wires'),
    reset: L('↩ عرض الكل', '↩ show all'),
    no_orphans: L('لا عناصر معزولة — كل عنصر مرتبط', 'No isolated items — everything is linked'),
    folder_jump: L('افتح العنصر الأكثر ارتباطاً في هذا المجلد', 'open the most connected item in this folder'),
    kinds: {
      doc: L('مستندات', 'documents'), project: L('مشاريع', 'projects'),
      decision: L('قرارات', 'decisions'), task: L('مهام', 'tasks'),
      note: L('ملاحظات', 'notes'), other: L('أخرى', 'other'),
    },
    kind_short: {
      doc: L('مستند', 'doc'), project: L('مشروع', 'proj'), decision: L('قرار', 'decision'),
      task: L('مهمة', 'task'), note: L('ملاحظة', 'note'), other: L('عنصر', 'item'),
    },
  });

  function render(host, DATA, opts) {
    if (!host || !DATA || !Array.isArray(DATA.nodes) || !DATA.nodes.length) return;
    const O = opts || {};
    const lg = (O.lang === 'en' || (!O.lang && document.documentElement.getAttribute('lang') === 'en')) ? 'en' : 'ar';
    const L = (ar, en) => (lg === 'en' ? en : ar);
    const LB = LABELS(L);
    if (!document.getElementById('fm-style')) {
      const st = document.createElement('style'); st.id = 'fm-style'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    host.classList.add('fm-root');
    host.dir = lg === 'en' ? 'ltr' : 'rtl';
    host.innerHTML = `
      <section class="fm-overview" id="fm-overview" aria-label="${LB.islands}">
        <div class="fm-ov-head">
          <input class="fm-ov-search" id="fm-ov-search" type="search" placeholder="${LB.search_ph}" aria-label="${LB.search_ph}">
          <div class="fm-ov-actions" id="fm-ov-actions"></div>
        </div>
        <div class="fm-ov-grid" id="fm-ov-grid"></div>
      </section>
      <div id="fm-list"></div>
      <section class="fm-stage" aria-label="${LB.in} / ${LB.out}">
        <svg class="fm-wires" aria-hidden="true">
          <defs>
            <marker id="fm-tip" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="context-stroke"></path>
            </marker>
          </defs>
        </svg>
        <div class="fm-col fm-col-left" id="fm-left"></div>
        <div class="fm-hub-wrap" id="fm-hub"></div>
        <div class="fm-col fm-col-right" id="fm-right"></div>
      </section>
      <div class="fm-footer">
        <div class="fm-stat"><b id="fm-st-files">0</b><span>${LB.item}</span></div>
        <div class="fm-stat small"><b id="fm-st-folders">0</b><span>${LB.project}</span></div>
        <div class="fm-stat small"><b id="fm-st-cycles">0</b><span>${LB.cycles}</span></div>
        <div class="fm-stat small"><b id="fm-st-orphans">0</b><span>${LB.orphans}</span></div>
        <div class="fm-stat"><b id="fm-st-edges">0</b><span>${LB.edges}</span></div>
      </div>
      <div class="fm-foot-note" id="fm-note"></div>
      <div class="fm-wire-note" id="fm-wire-note"></div>`;

    const byId = new Map(DATA.nodes.map(n => [n.id, n]));
    const outgoing = new Map(), incoming = new Map(), degree = new Map();
    DATA.nodes.forEach(n => { outgoing.set(n.id, []); incoming.set(n.id, []); degree.set(n.id, 0); });
    (DATA.edges || []).forEach(e => {
      if (!byId.has(e.from) || !byId.has(e.to)) return;
      outgoing.get(e.from).push(e.to);
      incoming.get(e.to).push(e.from);
      degree.set(e.from, degree.get(e.from) + 1);
      degree.set(e.to, degree.get(e.to) + 1);
    });
    const byDegree = (ids) => [...ids].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0));
    const activeId = O.activeId && byId.has(O.activeId) ? O.activeId : null;

    /* المركز الافتتاحي (إصلاح 2026-11-14): كان العنصر المفتوح يتقدّم دائماً،
       فملاحظة جديدة بلا روابط تفتح الخريطة على «لا يعتمد على شيء / لا يعتمد
       عليه شيء» — تبدو معطّلة وهي سليمة. الآن: العنصر المفتوح يُستعمل فقط إن
       كان له ارتباط واحد على الأقل، وإلا فالمحور الأكثر ارتباطاً. */
    const startId = (activeId && (degree.get(activeId) || 0) > 0)
      ? activeId
      : ((DATA.stats && byId.has(DATA.stats.hub)) ? DATA.stats.hub : DATA.nodes[0].id);
    const state = { center: startId, history: [], filter: new Map(), limit: new Map(), folders: new Set(), hover: null, ovQuery: '', ovList: null, ovFolder: null };

    const stageEl = host.querySelector('.fm-stage');
    const leftEl = host.querySelector('#fm-left');
    const rightEl = host.querySelector('#fm-right');
    const hubEl = host.querySelector('#fm-hub');
    const wiresEl = host.querySelector('.fm-wires');

    /* ═══ المستوى الأول: الجزر — مجلدات + ما هو معزول + دورات ═══ */
    const orphanIds = () => DATA.nodes.filter(n => !(degree.get(n.id) > 0)).map(n => n.id);
    function drillFolder(f) {
      const ids = DATA.nodes.filter(n => (n.folder || '') === f).map(n => n.id);
      if (!ids.length) return;
      const top = byDegree(ids)[0];
      if (top !== state.center) state.history.push(state.center);
      state.center = top; state.filter.clear(); state.limit.clear(); state.folders.clear();
      state.ovFolder = f;
      render();
      if (stageEl.scrollIntoView) stageEl.scrollIntoView({ block: 'nearest' });
    }
    function showList(kind) {
      const box = host.querySelector('#fm-list');
      if (!box) return;
      if (state.ovList === kind) { state.ovList = null; box.replaceChildren(); renderOverview(); return; }
      state.ovList = kind;
      const ids = (kind === 'orphans' ? orphanIds() : (DATA.stats.cycleGroups || []).flat()).filter(id => byId.has(id));
      box.replaceChildren();
      const card = document.createElement('div'); card.className = 'fm-list';
      const head = document.createElement('div'); head.className = 'fm-list-h';
      const t = document.createElement('span');
      t.textContent = (kind === 'orphans' ? LB.orphans_list : LB.cycles_list) + ' · ' + ids.length;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = LB.close;
      x.addEventListener('click', () => showList(kind));
      head.append(t, x); card.append(head);
      if (!ids.length) {
        const e = document.createElement('div'); e.className = 'fm-empty';
        e.textContent = kind === 'orphans' ? LB.no_orphans : LB.no_match; card.append(e);
      } else ids.slice(0, 200).forEach(id => card.append(nodeButton(id)));
      box.append(card);
      renderOverview();
    }
    function renderOverview() {
      const grid = host.querySelector('#fm-ov-grid');
      const acts = host.querySelector('#fm-ov-actions');
      if (!grid || !acts) return;
      const stats = new Map();
      DATA.nodes.forEach(n => {
        const f = n.folder || '';
        const s = stats.get(f) || { total: 0, orphan: 0 };
        s.total += 1; if (!(degree.get(n.id) > 0)) s.orphan += 1;
        stats.set(f, s);
      });
      const q = String(state.ovQuery || '').trim().toLowerCase();
      const entries = Array.from(stats.entries())
        .filter(([f]) => !q || (f ? folderLabel(f) : LB.no_project).toLowerCase().includes(q) || String(f).toLowerCase().includes(q))
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 60);
      grid.replaceChildren();
      entries.forEach(([f, s]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fm-folder' + (state.ovFolder === f ? ' on' : '');
        btn.title = (f || LB.no_project) + ' · ' + LB.folder_jump;
        const nm = document.createElement('span'); nm.className = 'nm fm-nm'; nm.textContent = f ? folderLabel(f) : LB.no_project;
        const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = String(s.total);
        const bar = document.createElement('span'); bar.className = 'bar';
        const good = document.createElement('i');
        good.style.width = Math.round(((s.total - s.orphan) / s.total) * 100) + '%';
        const bad = document.createElement('u');
        bar.append(good, bad);
        btn.append(nm, ct, bar);
        btn.addEventListener('click', () => drillFolder(f));
        grid.append(btn);
      });
      if (!entries.length) { const e = document.createElement('div'); e.className = 'fm-empty'; e.textContent = LB.no_match; grid.append(e); }
      const mkBtn = (label, count, onClick, active) => {
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'fm-ov-btn' + (active ? ' on' : '');
        b2.append(document.createTextNode(label));
        if (count != null) { const s2 = document.createElement('b'); s2.textContent = String(count); b2.append(' ', s2); }
        b2.addEventListener('click', onClick);
        return b2;
      };
      acts.replaceChildren();
      acts.append(mkBtn(LB.orphans, (DATA.stats.orphans != null ? DATA.stats.orphans : orphanIds().length), () => showList('orphans'), state.ovList === 'orphans'));
      if ((DATA.stats.cycles || 0) > 0) acts.append(mkBtn(LB.cycles, DATA.stats.cycles, () => showList('cycles'), state.ovList === 'cycles'));
      /* اسم العنصر **بيانات مستخدم** لا نص واجهة (§21): يُعلَّم `fm-nm` كما في بقية
         الخريطة، فلا يُحسب نصاً واجهياً عربياً في الواجهة الإنجليزية (تدقيق اللغة). */
      if (DATA.stats.hub && byId.has(DATA.stats.hub)) {
        const hubBtn = mkBtn(LB.most + ': ', null, () => focusOn(DATA.stats.hub));
        const ref = document.createElement('span');
        ref.className = 'fm-nm';
        ref.textContent = nameOf(DATA.stats.hub);
        ref.title = DATA.stats.hub;
        hubBtn.append(ref);
        acts.append(hubBtn);
      }
      if (state.ovFolder) acts.append(mkBtn(LB.reset, null, () => { state.ovFolder = null; render(); }));
    }
    const ovSearch = host.querySelector('#fm-ov-search');
    if (ovSearch) ovSearch.addEventListener('input', () => { state.ovQuery = ovSearch.value; renderOverview(); });
    function setCount(titleEl, res) {
      const el = titleEl.querySelector('.fm-count');
      if (el && res && res.total > res.shown) el.textContent = res.shown + ' / ' + res.total;
    }
    function updateWireNote(total, drawn) {
      const el = host.querySelector('#fm-wire-note'); if (!el) return;
      if (total > WIRE_LIMIT) {
        el.className = 'fm-wire-note warn';
        el.textContent = LB.wires_hidden + ' (' + total + ' > ' + WIRE_LIMIT + ') — ' + LB.narrow_hint;
      } else if (drawn) { el.className = 'fm-wire-note'; el.textContent = drawn + ' ' + LB.wires_count; }
      else { el.className = 'fm-wire-note'; el.textContent = ''; }
    }

    host.querySelector('#fm-st-files').textContent = DATA.stats.files;
    host.querySelector('#fm-st-edges').textContent = DATA.stats.edges;
    host.querySelector('#fm-st-folders').textContent = (DATA.stats.folders != null) ? DATA.stats.folders : '—';
    host.querySelector('#fm-st-cycles').textContent = DATA.stats.cycles;
    host.querySelector('#fm-st-orphans').textContent = DATA.stats.orphans;
    const tinyCycles = (DATA.stats.cycleGroups || []).filter(g => g.length <= 6).slice(0, 2);
    host.querySelector('#fm-note').textContent =
      (tinyCycles.length ? LB.cycles + ': ' + tinyCycles.map(g => g.join(' ⇄ ')).join(' · ') + ' · ' : '') +
      LB.most + ': ' + (DATA.stats.hub ? ((byId.get(DATA.stats.hub) || {}).name || DATA.stats.hub) : '—') +
      ' · ' + DATA.generatedAt + ' · ' + (DATA.root || '');

    const folderOf = id => (byId.get(id) || {}).folder || '';
    const nameOf = id => (byId.get(id) || {}).name || id;
    const extLabel = n => LB.kind_short[n.kind] || LB.other;
    /* المسارات الطويلة تُعرض بذيلها — الكامل في title */
    const folderLabel = f => {
      const parts = String(f).replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length && /^[a-zA-Z]:$/.test(parts[0])) return parts.slice(1, 3).join('/') || f;
      return parts.length > 2 ? parts.slice(-2).join('/') : f;
    };

    function nodeButton(id, opts2) {
      const n = byId.get(id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fm-node' + (id === activeId ? ' fm-active' : '');
      b.dataset.id = id;
      const dot = document.createElement('span'); dot.className = 'fm-dot';
      const nm = document.createElement('span'); nm.className = 'fm-nm'; nm.textContent = nameOf(id);
      const ext = document.createElement('span'); ext.className = 'fm-ext'; ext.textContent = extLabel(n || {});
      b.append(dot, nm, ext);
      b.title = id + ' · ' + extLabel(n || {}) + (n && n.folder ? ' · ' + n.folder : '') +
        (n && n.loc ? ' · ' + n.loc + ' ' + LB.lines : '') + ' — ' + LB.click_hint;
      b.addEventListener('click', () => focusOn(id));
      if (typeof O.onOpen === 'function') {
        b.addEventListener('dblclick', () => { try { O.onOpen(id); } catch (e) { /* المستمع لا يكسر الخريطة */ } });
      }
      if (!opts2 || !opts2.static) {
        b.addEventListener('mouseenter', () => highlight(id, true));
        b.addEventListener('mouseleave', () => highlight(id, false));
        b.addEventListener('focus', () => highlight(id, true));
        b.addEventListener('blur', () => highlight(id, false));
      }
      return b;
    }
    function ghostButton(label, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fm-node ghost'; b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }
    function chip(label, count, onClick) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fm-chip'; b.textContent = label;
      if (count != null) { const c = document.createElement('b'); c.textContent = count; b.append(' ', c); }
      b.addEventListener('click', onClick);
      return b;
    }
    /* مسطرة السياق: الفلتر النشط على العمود يظهر كشارة قابلة للإزالة */
    function attachFilterBadge(titleEl, key) {
      const active = state.filter.get(key);
      if (active === null || active === undefined) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fm-filter-badge';
      b.textContent = (active === '*' ? LB.items_all : folderLabel(active) + '/') + ' ✕';
      b.title = LB.clear_filter;
      b.addEventListener('click', () => { state.filter.delete(key); state.limit.delete(key); render(); });
      titleEl.appendChild(b);
    }
    function renderList(el, ids, key) {
      const active = state.filter.has(key) ? state.filter.get(key) : null;
      const frag = document.createDocumentFragment();
      if (active === null && ids.length > ROLLUP_AT) {
        const counts = new Map();
        ids.forEach(id => { const f = folderOf(id); counts.set(f, (counts.get(f) || 0) + 1); });
        const all = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const wide = state.folders.has(key);
        const shown = all.slice(0, wide ? 40 : 8);
        const row = document.createElement('div'); row.className = 'fm-chips';
        shown.forEach(entry => row.append(chip(entry[0] ? folderLabel(entry[0]) + '/' : '·/', entry[1], () => { state.filter.set(key, entry[0]); state.limit.delete(key); render(); })));
        if (all.length > shown.length) {
          row.append(chip('+' + (all.length - shown.length) + ' ' + LB.projects_fold, null, () => { state.folders.add(key); render(); }));
        } else if (wide && all.length > 8) {
          row.append(chip(LB.less, null, () => { state.folders.delete(key); render(); }));
        }
        frag.append(row);
        const HYBRID_N = 6;
        byDegree(ids).slice(0, HYBRID_N).forEach(id => frag.append(nodeButton(id)));
        frag.append(ghostButton(LB.view_all + ' ' + ids.length + ' ' + LB.items_all, () => { state.filter.set(key, '*'); state.limit.delete(key); render(); }));
        const shownCount = frag.querySelectorAll('.fm-node[data-id]').length;
        el.append(frag);
        return { shown: shownCount, total: ids.length };
      }
      let list = ids;
      if (active !== null && active !== '*' && active !== '__all__') list = ids.filter(id => folderOf(id) === active);
      list = byDegree(list);
      const cap = state.limit.get(key) || (active === null ? CAP_SMALL : CAP_EXPANDED);
      list.slice(0, cap).forEach(id => frag.append(nodeButton(id)));
      if (list.length > cap) frag.append(ghostButton('+' + (list.length - cap), () => { state.limit.set(key, cap + 100); render(); }));
      if (active !== null) frag.append(ghostButton(LB.all_folders, () => { state.filter.delete(key); state.limit.delete(key); render(); }));
      const shownCount = frag.querySelectorAll('.fm-node[data-id]').length;
      el.append(frag);
      return { shown: shownCount, total: list.length };
    }
    function focusOn(id) {
      if (id === state.center) return;
      state.history.push(state.center);
      state.center = id; state.filter.clear(); state.limit.clear(); state.folders.clear();
      render();
    }
    function goBackTo(i) {
      const target = state.history[i];
      if (!target) return;
      state.history = state.history.slice(0, i);
      state.center = target; state.filter.clear(); state.limit.clear(); state.folders.clear();
      render();
    }
    function render() {
      const center = state.center;
      const outs = (outgoing.get(center) || []).slice();
      const ins = (incoming.get(center) || []).slice();
      const n = byId.get(center) || {};
      const groups = new Map(KIND_ORDER.map(k => [k, []]));
      outs.forEach(id => { const k = (byId.get(id) || {}).kind || 'other'; (groups.get(k) || groups.get('other')).push(id); });

      leftEl.replaceChildren(); rightEl.replaceChildren(); hubEl.replaceChildren();

      const leftTitle = document.createElement('p');
      leftTitle.className = 'fm-col-title';
      leftTitle.innerHTML = '<span>' + LB.in + '</span><span class="fm-count">' + ins.length + '</span>';
      attachFilterBadge(leftTitle, '__in');
      leftEl.append(leftTitle);
      if (!ins.length) {
        const e = document.createElement('div'); e.className = 'fm-empty'; e.textContent = LB.none_in;
        leftEl.append(e);
        leftEl.append(suggestCard(outs.concat(ins)));
      } else setCount(leftTitle, renderList(leftEl, ins, '__in'));

      const hub = document.createElement('div'); hub.className = 'fm-hub';
      const mark = document.createElement('span'); mark.className = 'fm-mark'; mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = '<i></i><i></i><i></i>';
      const name = document.createElement('div'); name.className = 'fm-name'; name.textContent = nameOf(center); name.title = center;
      const dir = document.createElement('div'); dir.className = 'fm-dir'; dir.textContent = n.folder ? folderLabel(n.folder) : LB.no_project; dir.title = n.folder || '';
      const meta = document.createElement('div'); meta.className = 'fm-meta';
      meta.textContent = LB.meta_in + ' ' + ins.length + ' · ' + LB.meta_out + ' ' + outs.length + (n.loc ? ' · ' + n.loc + ' ' + LB.lines : '');
      hub.append(mark, name, dir, meta);
      if (center === activeId) {
        const badge = document.createElement('span'); badge.className = 'fm-open-badge'; badge.textContent = LB.open_now;
        hub.append(badge);
      }
      if (state.history.length) {
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'fm-back'; back.textContent = LB.back;
        back.addEventListener('click', () => { const p = state.history.pop(); if (p) { state.center = p; state.filter.clear(); state.limit.clear(); state.folders.clear(); render(); } });
        hub.append(back);
        const crumbs = document.createElement('div'); crumbs.className = 'fm-crumbs';
        state.history.forEach((hid, i) => {
          const cb = document.createElement('button');
          cb.type = 'button'; cb.textContent = nameOf(hid); cb.title = nameOf(hid);
          cb.addEventListener('click', () => goBackTo(i));
          crumbs.appendChild(cb);
        });
        hub.append(crumbs);
      }
      hubEl.append(hub);

      const rightTitle = document.createElement('p');
      rightTitle.className = 'fm-col-title';
      rightTitle.innerHTML = '<span>' + LB.out + '</span><span class="fm-count">' + outs.length + '</span>';
      rightEl.append(rightTitle);
      if (!outs.length) {
        const e = document.createElement('div'); e.className = 'fm-empty'; e.textContent = LB.none_out;
        rightEl.append(e);
        rightEl.append(suggestCard(ins.concat(outs)));
      } else {
        let outShown = 0;
        KIND_ORDER.forEach(k => {
          const list = groups.get(k);
          if (!list || !list.length) return;
          const lab = document.createElement('div'); lab.className = 'fm-group-label';
          lab.textContent = LB.kinds[k] + ' · ' + list.length;
          rightEl.append(lab);
          const rl = renderList(rightEl, list, 'out:' + k);
          if (rl && rl.total > rl.shown) lab.textContent = LB.kinds[k] + ' · ' + rl.shown + ' / ' + rl.total;
          if (rl) outShown += rl.shown;
          attachFilterBadge(lab, 'out:' + k);
        });
        setCount(rightTitle, { shown: outShown, total: outs.length });
      }

      drawWires();
      renderOverview();
      requestAnimationFrame(() => {
        [leftEl, rightEl].forEach(el => el.classList.toggle('dense', el.scrollHeight > el.clientHeight + 2));
      });
    }
    /* العمود الفارغ لا يترك فراغاً: يقترح أعلى عنصرين ارتباطاً للقفز إليهما */
    function suggestCard(excludeIds) {
      const excl = new Set([state.center, ...excludeIds]);
      const top = byDegree(DATA.nodes.map(x => x.id).filter(id => !excl.has(id))).slice(0, 2);
      const card = document.createElement('div'); card.className = 'fm-suggest';
      const t = document.createElement('div'); t.className = 'fm-sg-t'; t.textContent = LB.suggest_hint;
      card.appendChild(t);
      top.forEach(id => card.appendChild(nodeButton(id, { static: true })));
      return card;
    }
    function drawWires() {
      wiresEl.querySelectorAll('path.fm-wire').forEach(p => p.remove());
      const leftNodes = [...leftEl.querySelectorAll('.fm-node[data-id]')];
      const rightNodes = [...rightEl.querySelectorAll('.fm-node[data-id]')];
      const leftChips = [...leftEl.querySelectorAll('.fm-chip')];
      const rightChips = [...rightEl.querySelectorAll('.fm-chip')];
      const total = leftNodes.length + rightNodes.length + leftChips.length + rightChips.length;
      if (!total || total > WIRE_LIMIT) { updateWireNote(total, 0); return; }
      /* مرجع القياس = صندوق SVG نفسه، وviewBox يطابق صندوقه المرئي.
         عطل مُقاس (2026-11-11): كانت الإحداثيات تُشتق من getBoundingClientRect
         (بكسل **مرئي** مضخَّم بـzoom) بينما وحدة SVG بكسل CSS بلا viewBox ⇒ كل خيط
         ينزاح بمقدار (zoom−1)×المسافة: عند XL 101px وعند S 66px، فتظهر الخيوط
         مشوَّهة ولا تصل أهدافها. بضبط viewBox على الصندوق المرئي صارت الوحدة
         واحدة (والحل يصحّ لتكبير المتصفح أيضاً بلا قراءة قيمة zoom).
         preserveAspectRatio=none لأن النسبتين متطابقتان بالبناء، فيمنع أي إزاحة
         ناتجة عن تقريب. */
      const base = wiresEl.getBoundingClientRect();
      wiresEl.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
      wiresEl.setAttribute('preserveAspectRatio', 'none');
      const hub = hubEl.firstElementChild; if (!hub) return;
      const hr = hub.getBoundingClientRect();
      const midY = hr.top - base.top + hr.height / 2;
      const hubLeftX = hr.left - base.left;
      const hubRightX = hr.right - base.left;
      function draw(from, to, node, dir, isChip) {
        const sign = to.x >= from.x ? 1 : -1;
        const dx = Math.max(40, Math.abs(to.x - from.x) * 0.45) * sign;
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('class', 'fm-wire' + (isChip ? ' chip' : ''));
        p.setAttribute('d', 'M ' + from.x + ' ' + from.y + ' C ' + (from.x + dx) + ' ' + from.y + ', ' + (to.x - dx) + ' ' + to.y + ', ' + to.x + ' ' + to.y);
        if (node) p.dataset.node = node;
        p.dataset.dir = dir;
        wiresEl.append(p);
      }
      leftNodes.forEach(btn => {
        const r = btn.getBoundingClientRect();
        draw({ x: r.left - base.left, y: r.top - base.top + r.height / 2 }, { x: hubRightX, y: midY }, btn.dataset.id, 'in', false);
      });
      rightNodes.forEach(btn => {
        const r = btn.getBoundingClientRect();
        draw({ x: hubLeftX, y: midY }, { x: r.right - base.left, y: r.top - base.top + r.height / 2 }, btn.dataset.id, 'out', false);
      });
      /* أسلاك الشرائح (إضافة 2026-10-24): الطيّ كان بلا خطوط فيبدو العمود منفصلاً */
      leftChips.forEach(c => {
        const r = c.getBoundingClientRect();
        draw({ x: r.left - base.left, y: r.top - base.top + r.height / 2 }, { x: hubRightX, y: midY }, null, 'in', true);
      });
      rightChips.forEach(c => {
        const r = c.getBoundingClientRect();
        draw({ x: hubLeftX, y: midY }, { x: r.right - base.left, y: r.top - base.top + r.height / 2 }, null, 'out', true);
      });
      applyHighlight();
      updateWireNote(total, wiresEl.querySelectorAll('path.fm-wire').length);
    }
    function applyHighlight() {
      wiresEl.querySelectorAll('path.fm-wire').forEach(p => {
        const related = state.hover !== null && p.dataset.node === state.hover;
        p.classList.toggle('fm-hot', related);
        p.classList.toggle('fm-hot-in', related && p.dataset.dir === 'in');
        p.classList.toggle('fm-dim', state.hover !== null && !related && !!p.dataset.node);
        if (related) p.setAttribute('marker-end', 'url(#fm-tip)');
        else p.removeAttribute('marker-end');
      });
    }
    function highlight(id, on) {
      state.hover = on ? id : (state.hover === id ? null : state.hover);
      applyHighlight();
    }
    host.__fmKeyHandler = (ev) => {
      if (ev.key === 'Escape' && state.history.length) {
        state.center = state.history.pop(); state.filter.clear(); state.limit.clear(); state.folders.clear(); render();
      }
    };
    document.addEventListener('keydown', host.__fmKeyHandler);
    host.__fmResize = () => drawWires();
    window.addEventListener('resize', host.__fmResize);
    [leftEl, rightEl].forEach(el => el.addEventListener('scroll', () => requestAnimationFrame(drawWires), { passive: true }));
    render();
    requestAnimationFrame(drawWires);
  }

  global.CortexFilemap = { render };
})(window);
