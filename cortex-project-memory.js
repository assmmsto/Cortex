'use strict';
/**
 * ذاكرة المشاريع لوكلاء البناء الخارجيين (2026-10-28)
 * ────────────────────────────────────────────────────
 * الهدف الثاني — الاحتضان والذاكرة التلقائية:
 *   absorbProject: يمسح المشروع فعلياً (repo_index + repo_deps) ويبني ذاكرة
 *   «خرائط لا ملفات»: خريطة مرجعية (أهم الملفات/نقاط الدخول) + خريطة اعتمادية
 *   (حواف الاستيراد الفعلية محلولة) + سياق (manifest/README) — في بيانات
 *   data/projects/<slug>.map.json + ملاحظة بشرية في القبو.
 *   تدعم الحالتين: مشروع مبني (احتضان مرة واحدة) ومن الصفر (refresh متكرر).
 *
 * الهدف الأول — التبادل بين النظامين:
 *   buildMemorySlice: وكيل البناء (OpenCode/Claude/Codex) يطلب → يُردّ له
 *   الجزء اللازم فقط + المسار + تلخيص دقيق، بدل قراءة المشروع كله.
 *
 * مسير النموذج (trajectory):
 *   appendTrail/readTrail: خطوات وكيل البناء على المشروع (jsonl مع rotation)
 *   — هو ذاكرة «ما جرى»، منفصلة عن «ما بُني».
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAP_VERSION = 1;
const TRAIL_MAX_LINES = 800;
const STALE_MS = 10 * 60 * 1000;
const MAX_MAP_EDGES = 900;
const MAX_TOPFILES = 40;
const SLICE_SUMMARY_MAX = 1200;

function createProjectMemory({ core, extTools, allowedRoots, root }) {
  const projectsDir = path.join(root, 'data', 'projects');
  const mapFile = slug => path.join(projectsDir, `${slug}.map.json`);
  const trailFile = slug => path.join(projectsDir, `${slug}.trail.jsonl`);

  function slug(name) {
    const clean = String(name || 'project').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
    return clean || 'project';
  }

  function ensureDir() {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  /* ── مسح قائمة الملفات: اللازمة لحل أهداف الاستيراد بدقة (calc → calc.js).
     نفس تجاهُل الطبقة الخارجية (IGNORED_DIRS) — لا قائمة موازية تُنحرف عنها. */
  function scanFiles(projectRoot, maxFiles = 4000) {
    const out = [];
    const queue = [''];
    while (queue.length && out.length < maxFiles) {
      const rel = queue.pop();
      let entries;
      try { entries = fs.readdirSync(path.join(projectRoot, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (out.length >= maxFiles) break;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!extTools.IGNORED_DIRS.has(e.name)) queue.push(relPath);
        } else {
          out.push(relPath);
        }
      }
    }
    return out;
  }

  /* ── حل أهداف الاستيراد: './b' من src/a.js → src/b.js إن وُجد فعلاً.
     الحواف الخام قد تشير بلا امتداد؛ الحل يجرّب امتدادات معروفة + index. */
  const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs'];
  function resolveEdgeTo(from, to, known) {
    const raw = String(to || '').replace(/\\/g, '/');
    if (!raw.startsWith('.')) return raw; // استيراد غير نسبي (مكتبة/حزمة)
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), raw));
    if (known.has(joined)) return joined;
    for (const ext of RESOLVE_EXTS) if (known.has(joined + ext)) return joined + ext;
    for (const ext of RESOLVE_EXTS) if (known.has(`${joined}/index${ext}`)) return `${joined}/index${ext}`;
    return joined;
  }

  /* دور الملف — تصنيف موضوعي من الاسم/المسار (م39/6: تصنيف قابل للقياس بلا تخمين). */
  function fileRole(p) {
    const s = String(p || '');
    if (/\.(test|spec)\.[a-z]+$/i.test(s) || /(^|\/)(tests?|__tests__)(\/|$)/.test(s)) return 'test';
    if (/\.(md|txt|rst)$/i.test(s)) return 'doc';
    if (/(^|\/)(index|main|app|server|__main__)\.[a-z]+$/i.test(s)) return 'entry';
    if (/\.(json|ya?ml|toml|ini)$/i.test(s) || /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(s)) return 'config';
    return 'module';
  }

  function buildMaps(indexOut, depsOut) {
    // كل ملفات المشروع فعلياً (مسح) + كل مصادر الحواف — أساس الحل الدقيق
    const known = new Set(scanFiles(indexOut.root));
    for (const e of depsOut.edges || []) known.add(e.from);
    // أحلّ الأهداف قدر المستطاع ثم احسب الدرجات
    const edges = (depsOut.edges || []).slice(0, MAX_MAP_EDGES).map(e => ({
      from: e.from, to: resolveEdgeTo(e.from, e.to, known), kind: e.kind, line: e.line
    }));
    const inDeg = new Map(), outDeg = new Map();
    for (const e of edges) {
      outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
      if (known.has(e.to)) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }
    const topFiles = [...new Set([...inDeg.keys(), ...outDeg.keys()])]
      .map(f => ({ path: f, inbound: inDeg.get(f) || 0, outbound: outDeg.get(f) || 0, type: fileRole(f) }))
      .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound) || a.path.localeCompare(b.path))
      .slice(0, MAX_TOPFILES);
    /* تحذيرات الخريطة — سجل مخاطر دائم محسوب عند الاحتضان (م39/5: كان لحظياً فقط
       في القاطع ولا يُحفظ). كلها مشتقة من أرقام المسح الفعلية، بلا تخمين. */
    const warnings = [];
    if (indexOut.truncated) warnings.push('المسح بلغ سقفه — الخريطة جزئية');
    if (!(indexOut.tests > 0)) warnings.push('لا اختبارات في المشروع — لا شبكة أمان للتغييرات');
    if (!(indexOut.entryPoints || []).length) warnings.push('لا نقطة دخول معروفة (index/main/app/server)');
    const extCount = (depsOut.external || []).length;
    if (extCount > 30) warnings.push(`${extCount} حزمة خارجية — سطح تبعية واسع`);
    if (edges.length === 0 && (indexOut.code || 0) > 0) warnings.push('لا حواف استيراد داخلية — العلاقات غير مقروءة آلياً');
    return {
      version: MAP_VERSION,
      kind: 'cortex-project-map',
      edges,
      topFiles,
      warnings,
      entryPoints: (indexOut.entryPoints || []).slice(0, 20),
      byExt: indexOut.byExt || {},
      external: (depsOut.external || []).slice(0, 30),
      counts: {
        files: indexOut.files || 0, dirs: indexOut.dirs || 0, code: indexOut.code || 0,
        tests: indexOut.tests || 0, docs: indexOut.docs || 0, bytes: indexOut.bytes || 0,
        internalEdges: edges.length, externalPackages: extCount
      },
      manifest: indexOut.manifest || null,
      truncated: Boolean(indexOut.truncated)
    };
  }

  function mapMarkdown(project, repoPath, maps, absorbedAt) {
    const c = maps.counts;
    const ext = Object.entries(maps.byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `${k}:${v}`).join(' · ');
    const top = maps.topFiles.slice(0, 15).map(f => `- \`${f.path}\` — ${f.type || 'module'} · وارد:${f.inbound} صادر:${f.outbound}`).join('\n');
    const entry = maps.entryPoints.length ? maps.entryPoints.map(p => `\`${p}\``).join(' · ') : '—';
    const extPkgs = maps.external.slice(0, 12).map(x => `${x.name}(${x.uses})`).join(' · ') || '—';
    const warn = (maps.warnings || []).length ? '\n\n## ⚠ تحذيرات الخريطة\n' + maps.warnings.map(w => `- ${w}`).join('\n') : '';
    const ch = maps.changes ? `\n\n## التغيّر منذ آخر احتضان (${String(maps.changes.at).slice(0, 16)})\n`
      + `- الملفات: ${maps.changes.filesBefore} → ${maps.changes.filesAfter} · الحواف: ${maps.changes.edgesBefore} → ${maps.changes.edgesAfter}`
      + (maps.changes.added.length ? `\n- دخلت أهم الملفات: ${maps.changes.added.map(a => '`' + a + '`').join(' · ')}` : '')
      + (maps.changes.removed.length ? `\n- خرجت من أهم الملفات: ${maps.changes.removed.map(a => '`' + a + '`').join(' · ')}` : '') : '';
    return `# خريطة مشروع — ${project}

> ذاكرة آلية من مسح فعلي للمصدر — خرائط لا ملفات. آخر احتضان: ${absorbedAt}
> المسار: \`${repoPath}\`${maps.truncated ? '\n> ⚠ المسح بلغ السقف (truncated) — الخريطة جزئية.' : ''}

## سياق المشروع
- الملفات: ${c.files} (كود: ${c.code} · اختبارات: ${c.tests} · وثائق: ${c.docs}) · المجلدات: ${c.dirs}
- التوزيع: ${ext}
- نقاط الدخول: ${entry}
${maps.manifest ? `- الحزمة (${maps.manifest.file}):\n\`\`\`\n${String(maps.manifest.excerpt).slice(0, 1200)}\n\`\`\`` : '- لا ملف حزمة معروف (package.json/pyproject/Cargo…)'}

## الخريطة المرجعية — أهم الملفات (بدرجة الاعتماد)
${top || '—'}

## الخريطة الاعتمادية
- حواف داخلية: ${c.internalEdges} · حزم خارجية: ${c.externalPackages}
- أهم الحزم: ${extPkgs}${warn}${ch}

## كيف تُستعمل
- وكيل البناء يسأل كورتكس أولاً: \`memory_slice\` (المسار + الجزء اللازم + تلخيص) بدل قراءة المشروع كله.
- بعد كل خطوة عمل: \`memory_record\` لتسجيل المسير. التفاصيل في docs/opencode-bridge.md.
`;
  }

  /* ── كتابة خريطة الاعتماديات في SQLite (إصلاح 2026-11-12) ──
     القياس الذي فرض هذا: `repo_deps` كان 0 صف بينما المستخرج ينتج حواف فعلية
     ويكتبها JSON فقط. النتيجة كانت: لا استعلام SQL، ولا ربط بالقرارات، ولا أثر
     على اشتقاق الخطورة (severity_evidence = 0). الجدول موجود ومخططه مطابق لحواف
     المستخرج، فالسلك الوحيد المفقود كان هذه الكتابة.
     الثقة مشتقة من طريقة الاستخراج لا من ادعاء: regex للنمط الواحد = 0.6،
     ووسوم HTML = 0.55، ولغات بلا محلل = 0.5. لا شيء يُعلن 1.0 وهو تخمين. */
  const KIND_CONFIDENCE = { esm: 0.6, 'esm-bare': 0.6, require: 0.6, dynamic: 0.6, python: 0.5, go: 0.5, script: 0.55, link: 0.55 };
  function persistRepoGraph({ id, root, files, edges, absorbedAt }) {
    let db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(root, 'data', 'cortex.db'));
      db.exec('PRAGMA busy_timeout = 4000');
      db.exec(`CREATE TABLE IF NOT EXISTS repos(id TEXT PRIMARY KEY, path TEXT, remote TEXT, branch TEXT, last_indexed TEXT, file_count INTEGER, meta TEXT)`);
      db.exec(`CREATE TABLE IF NOT EXISTS repo_deps(repo_id TEXT, from_file TEXT, to_file TEXT, kind TEXT, confidence REAL, extracted_at TEXT)`);
      db.prepare('DELETE FROM repo_deps WHERE repo_id = ?').run(id);
      db.prepare('INSERT OR REPLACE INTO repos(id, path, remote, branch, last_indexed, file_count, meta) VALUES (?,?,?,?,?,?,?)')
        .run(id, String(root || ''), null, null, absorbedAt, Number(files) || 0, JSON.stringify({ source: 'absorb' }));
      /* عطل مقيس 2026-11-12: الجدول عليه UNIQUE(repo_id, from_file, to_file, kind)
         والمستخرج يُعيد حواف مكرّرة (ملف يستورد نفس الوحدة مرتين) ⇒ INSERT عادي
         يفشل عند أول تكرار ويُسقط كل ما بعده (كُتب صف واحد من 189). OR IGNORE +
         إزالة التكرار قبل العدّ: النتيجة عدد الحواف الفعلية لا محاولات الإدراج. */
      const ins = db.prepare('INSERT OR IGNORE INTO repo_deps(repo_id, from_file, to_file, kind, confidence, extracted_at) VALUES (?,?,?,?,?,?)');
      const seen = new Set();
      let written = 0;
      for (const e of edges || []) {
        if (!e || !e.from || !e.to) continue;
        const key = `${e.from}\u0000${e.to}\u0000${e.kind || 'unknown'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ins.run(id, String(e.from), String(e.to), String(e.kind || 'unknown'), KIND_CONFIDENCE[e.kind] ?? 0.5, absorbedAt);
        written += 1;
      }
      return { written };
    } catch (err) {
      return { written: 0, error: err.message };
    } finally {
      try { if (db) db.close(); } catch { /* إغلاق غير حرج */ }
    }
  }

  /* ── الاحتضان: مسح فعلي (لا تخمين) → خريطة مخزنة + ملاحظة قبو */
  async function absorbProject({ path: repoPath, project, refresh = true } = {}) {
    const target = String(repoPath || '').trim();
    if (!target) return { error: 'path مطلوب (جذر المشروع)' };
    const indexOut = await extTools.TOOL_IMPLS.repo_index({ path: target }, { allowedRoots });
    if (indexOut.error) return { error: indexOut.error, path: target };
    const depsOut = await extTools.TOOL_IMPLS.repo_deps({ path: target }, { allowedRoots });
    if (depsOut.error) return { error: depsOut.error, path: target };

    const maps = buildMaps(indexOut, depsOut);
    const name = String(project || path.basename(indexOut.root) || 'project').trim();
    const id = slug(name);
    const absorbedAt = new Date().toISOString();

    /* فرق التحليلين (م39/8: «ما الذي تغيّر منذ آخر تحليل») — عند إعادة الاحتضان فقط.
       المقارنة على أهم الملفات والعدادات لا diff سطرياً — الصدق في التسمية لا التوسّع. */
    const prevMap = readMap(id);
    let changes = null;
    if (prevMap && prevMap.absorbedAt) {
      const before = new Set((prevMap.topFiles || []).map(f => f && f.path).filter(Boolean));
      const after = new Set(maps.topFiles.map(f => f.path));
      changes = {
        at: absorbedAt,
        filesBefore: prevMap.counts?.files ?? null, filesAfter: maps.counts.files,
        edgesBefore: prevMap.counts?.internalEdges ?? null, edgesAfter: maps.counts.internalEdges,
        added: [...after].filter(p => !before.has(p)).slice(0, 20),
        removed: [...before].filter(p => !after.has(p)).slice(0, 20)
      };
    }

    // ذاكرة «المسار ↔ الاسم»: يسمح بالاحتضان التلقائي لاحقاً بلا تكرار للمسار
    const known = readKnownProjects();
    const prev = known[id] || {};
    known[id] = { project: name, path: indexOut.root, absorbedAt, files: maps.counts.files };
    ensureDir();
    await fsp.writeFile(path.join(projectsDir, 'index.json'), JSON.stringify(known, null, 2), 'utf8');

    const map = { project: name, id, path: indexOut.root, absorbedAt, changes, ...maps };
    await fsp.writeFile(mapFile(id), JSON.stringify(map, null, 2), 'utf8');

    /* السلك المفقود: نفس الحواف التي كُتبت JSON تُكتب في القاعدة الآن،
       فتصبح قابلة للاستعلام ومتاحة لاشتقاق الخطورة وربط القرارات. */
    const persisted = persistRepoGraph({
      id, root, files: maps.counts.files, edges: maps.edges, absorbedAt,
    });

    // ملاحظة القبو — الذاكرة البشرية الدائمة (snapshot + audit عبر saveNote)
    const note = await core.saveNote({
      id: `خريطة-مشروع-${id}`,
      title: `خريطة مشروع — ${name}`,
      type: 'project', project: name, importance: 3,
      tags: ['خريطة-مشروع', 'ذاكرة-وكلاء'],
      content: mapMarkdown(name, indexOut.root, { ...maps, changes }, absorbedAt)
    });

    await core.appendAudit({
      type: 'project_absorbed', project: name, id, path: indexOut.root,
      files: maps.counts.files, edges: maps.counts.internalEdges, noteId: note.id
    }).catch(() => {});

    return {
      ok: true, project: name, id, path: indexOut.root,
      files: maps.counts.files, edges: maps.counts.internalEdges,
      entryPoints: maps.entryPoints, topFiles: maps.topFiles.slice(0, 10),
      external: maps.external.slice(0, 10), truncated: maps.truncated,
      warnings: maps.warnings, changes,
      repoDepsWritten: persisted.written || 0,
      ...(persisted.error ? { repoDepsError: persisted.error } : {}),
      noteId: note.id, absorbedAt, refreshed: Boolean(prev.absorbedAt)
    };
  }

  function readKnownProjects() {
    try { return JSON.parse(fs.readFileSync(path.join(projectsDir, 'index.json'), 'utf8')); } catch { return {}; }
  }

  function readMap(id) {
    try { return JSON.parse(fs.readFileSync(mapFile(id), 'utf8')); } catch { return null; }
  }

  /* ── قاطع السياق: ردّ دقيق بلا قراءة المشروع كله */
  async function buildMemorySlice({ project, query, file, intent = '', path: repoPath, refresh = false } = {}) {
    let id = slug(project || '');
    let map = id ? readMap(id) : null;
    const known = readKnownProjects();
    if (!map && id && known[id]) map = readMap(id);
    if (!map) {
      // احتضان تلقائي: بالمسار الممرَّر أو المسار المحفوظ سابقاً لهذا الاسم
      const autoPath = String(repoPath || known[id]?.path || '').trim();
      if (!autoPath) {
        return { error: 'لا خريطة لهذا المشروع — مرّر path مرة واحدة للاحتضان، أو احتضنه عبر project_absorb (العملية: احتضان)', needAbsorb: true, project: project || null };
      }
      const absorbed = await absorbProject({ path: autoPath, project: project || id });
      if (absorbed.error) return absorbed;
      id = absorbed.id;
      map = readMap(id);
      map = { ...map, _justAbsorbed: true };
    } else {
      // تقادُم: أحدث ملفات المشروع قد تغيّرت (بناء من الصفر) — refresh عند الطلب أو التقادم
      const age = Date.now() - Date.parse(map.absorbedAt || 0);
      if ((refresh || age > STALE_MS) && map.path) {
        const absorbed = await absorbProject({ path: map.path, project: map.project });
        if (!absorbed.error) { id = absorbed.id; map = readMap(id); }
      }
    }

    const knownFiles = new Set(map.edges.map(e => e.from).concat(map.topFiles.map(f => f.path)));
    const wantFile = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    let target = wantFile;
    if (wantFile && !knownFiles.has(wantFile)) {
      const onDisk = path.join(map.path, wantFile);
      if (fs.existsSync(onDisk) && fs.statSync(onDisk).isFile()) {
        target = wantFile; // موجود فعلاً على القرص — المسار الأدق حتى لو خارج الحواف
      } else {
        const base = path.posix.basename(wantFile);
        const near = [...knownFiles].filter(f => f.endsWith('/' + wantFile) || path.posix.basename(f) === base);
        target = near.length ? near.sort((a, b) => a.length - b.length)[0] : wantFile;
      }
    }

    const dependsOn = target ? map.edges.filter(e => e.from === target) : [];
    const dependedBy = target ? map.edges.filter(e => e.to === target || e.to === target.replace(/\.[^./]+$/, '')) : [];
    const affected = [...new Set(dependedBy.map(e => e.from))].slice(0, 40);

    // الذاكرة الدلالية: ملاحظات مرتبطة بالطلب أو بالملف (مع تنقية ضجيج الخرائط نفسها)
    let relatedNotes = [];
    const memQuery = [query, intent, target ? path.posix.basename(target) : '', map.project].filter(Boolean).join(' ').trim();
    if (memQuery) {
      try {
        const out = await core.searchWithEmbeddings(memQuery, { limit: 6, project: '' });
        relatedNotes = (out.results || [])
          .filter(r => !/^خريطة-مشروع-|^living-/.test(r.id))
          .slice(0, 5)
          .map(r => ({ id: r.id, title: r.title, type: r.type, snippet: String(r.snippet || '').slice(0, 140) }));
      } catch { relatedNotes = []; }
    }
    const decisions = relatedNotes.filter(r => r.type === 'decision');

    const role = !target ? 'general'
      : map.entryPoints.includes(target) ? 'entry'
      : /\.(test|spec)\.[a-z]+$/i.test(target) ? 'test' : 'module';
    const depList = dependsOn.map(e => e.to);
    const lines = [];
    lines.push(`المطلوب: ${String(intent || query || '').trim() || `سياق العمل على ${map.project}`}`);
    lines.push(`المشروع: ${map.project} — ${map.counts.files} ملفاً · ${map.counts.internalEdges} حافة اعتماد · آخر احتضان ${String(map.absorbedAt).slice(0, 16)}${map._justAbsorbed ? ' (احتضان تلقائي الآن)' : ''}`);
    if (target) {
      lines.push(`الملف المستهدف: ${target} (${role}) — مسار كامل: ${path.posix.join(map.path.replace(/\\/g, '/'), target)}`);
      lines.push(`يعتمد على (${depList.length}): ${depList.slice(0, 10).join(', ') || 'لا شيء'}`);
      lines.push(`يعتمد عليه (${dependedBy.length}): ${affected.slice(0, 10).join(', ') || 'لا شيء — ملف طرفي'}`);
    } else {
      lines.push(`أهم الملفات: ${map.topFiles.slice(0, 8).map(f => f.path).join(', ')}`);
      lines.push(`نقاط الدخول: ${map.entryPoints.join(', ') || '—'}`);
    }
    if (relatedNotes.length) lines.push(`ذاكرة ذات صلة: ${relatedNotes.map(r => `«${r.title}»`).join(' · ')}`);
    if (decisions.length) lines.push(`قرارات قائمة تخص الطلب: ${decisions.map(d => d.title).join(' · ')}`);
    const warnings = [];
    if (target && role === 'module') {
      if (dependedBy.length === 0) warnings.push('لا يستورده أحد — تعديله لا ينتشر آلياً');
      else if (dependsOn.length === 0) warnings.push('جذر تبعية: يُستورد ولا يستورد — تعديله ينتشر في ' + dependedBy.length + ' ملفاً');
    }
    if (map.truncated) warnings.push('الخريطة جزئية (سقف المسح) — تحقق بالمسار عند الشك');
    if (warnings.length) lines.push(`تحذيرات: ${warnings.join(' · ')}`);
    // سجل التحذيرات الدائم وفرق التحليلين (م39/5 و/8) — من الخريطة المخزنة لا من لحظة الطلب
    if ((map.warnings || []).length) lines.push(`تحذيرات الخريطة: ${map.warnings.slice(0, 3).join(' · ')}`);
    if (map.changes) lines.push(`منذ آخر احتضان: الملفات ${map.changes.filesBefore}→${map.changes.filesAfter} · الحواف ${map.changes.edgesBefore}→${map.changes.edgesAfter}${(map.changes.added || []).length ? ' · دخلت: ' + map.changes.added.slice(0, 3).join(', ') : ''}${(map.changes.removed || []).length ? ' · خرجت: ' + map.changes.removed.slice(0, 3).join(', ') : ''}`);
    const summary = lines.join('\n').slice(0, SLICE_SUMMARY_MAX);

    await core.appendAudit({
      type: 'memory_slice_served', project: map.project, file: target || null,
      relatedNotes: relatedNotes.length, autoAbsorbed: Boolean(map._justAbsorbed)
    }).catch(() => {});

    return {
      ok: true, project: map.project, root: map.path,
      targets: target ? [{ path: target, fullPath: path.posix.join(map.path.replace(/\\/g, '/'), target), role }] : [],
      dependsOn: depList.slice(0, 40), dependedBy: affected,
      affectedFiles: affected, relatedNotes, decisions,
      entryPoints: map.entryPoints, topFiles: map.topFiles.slice(0, 12),
      warnings: map.warnings || [], changes: map.changes || null,
      summary, absorbedAt: map.absorbedAt, autoAbsorbed: Boolean(map._justAbsorbed)
    };
  }

  /* ── مسير النموذج الباني: ما جرى فعلاً (jsonl مع rotation) */
  function appendTrail({ project, source = 'external', entries } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return { error: 'entries مطلوبة (قائمة)' };
    ensureDir();
    const id = slug(project);
    const file = trailFile(id);
    let existing = [];
    try {
      existing = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch { existing = []; }
    const now = new Date().toISOString();
    const added = list.slice(0, 50).map(e => JSON.stringify({
      at: e.at || now, source: e.source || source,
      kind: String(e.kind || 'step').slice(0, 40),
      text: String(e.text || '').slice(0, 800),
      files: Array.isArray(e.files) ? e.files.slice(0, 20).map(String) : [],
      status: e.status ? String(e.status).slice(0, 40) : undefined
    }));
    const merged = existing.concat(added);
    const kept = merged.slice(-TRAIL_MAX_LINES);
    fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8');
    return { ok: true, project: String(project || ''), added: added.length, kept: kept.length, rotated: merged.length > kept.length };
  }

  function readTrail({ project, limit = 30 } = {}) {
    const id = slug(project);
    let lines = [];
    try { lines = fs.readFileSync(trailFile(id), 'utf8').split('\n').filter(Boolean); } catch { return { ok: true, project: String(project || ''), entries: [], count: 0 }; }
    const entries = lines.slice(-Math.min(Number(limit) || 30, 200)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    return { ok: true, project: String(project || ''), entries, count: lines.length };
  }

  function listProjectMaps() {
    const known = readKnownProjects();
    return Object.entries(known).map(([id, meta]) => {
      const map = readMap(id);
      return { id, project: meta.project, path: meta.path, absorbedAt: meta.absorbedAt, files: meta.files, hasMap: Boolean(map) };
    });
  }

  return { absorbProject, buildMemorySlice, appendTrail, readTrail, listProjectMaps, readMap, slug };
}

module.exports = { createProjectMemory };
