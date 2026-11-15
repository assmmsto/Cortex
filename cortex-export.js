'use strict';
/**
 * cortex-export.js — إكسپورت مشروع كامل (md / zip) بلا مكتبات خارجية.
 *
 * ما يفعله:
 *  - يبني manifest.json موثقاً كل عنصر: id, title, kind, knowledge_kind,
 *    source, sensitivity, علاقاته (origin/confidence من note_links)،
 *    وأصل document_entities (مصدر الأصل المستورد — دستور §19).
 *  - format=md: ملف واحد بفواصل واضحة وfrontmatter متناسق + manifest كامل في الذيل.
 *  - format=zip: أرشيف ZIP مخزّن (stored — بلا ضغط) بكاتب داخلي: zlib غير مستخدم
 *    هنا إطلاقاً، وCRC32 مكتوب يدوياً حسب مواصفة PKWARE APPNOTE.
 *
 * مبادئ صارمة:
 *  - لا شبكة، لا تنفيذ، لا حذف — بناء سلاسل ومخازن بايتات فقط.
 *  - كل الدوال حتمية على مدخلاتها (التاريخ الوحيد المتحول هو generatedAt).
 *  - names بترميز UTF-8 (flag 0x0800) — الأسماء العربية سليمة في الأرشيف.
 */

// ───────────────────────────── CRC32 ─────────────────────────────

/** جدول CRC-32 (IEEE 802.3، البولينوم 0xEDB88320 منعكساً) — يُبنى مرة واحدة. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 لمخزن بايتات — مطابق لتعريف ZIP (دليل PKWARE، §4.4.1.7).
 * @param {Buffer|Uint8Array} buf
 * @returns {number} قيمة 32بت موجبة.
 */
function crc32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  let crc = -1;
  for (let i = 0; i < b.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// ─────────────────────────── كاتب ZIP مخزّن ───────────────────────────

/** طابع DOS الزمني للـ ZIP: {time, day} بتقسيم 16بت. */
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

/**
 * يبني أرشيف ZIP بطريقة STORED (method 0 — بلا ضغط) من إدخالات جاهزة.
 * لا أرشيف خارجي، لا zlib — المخازن تُنسخ كما هي والبنية تُكتب يدوياً:
 * local file header + data لكل إدخال، ثم central directory، ثم EOCD.
 *
 * @param {Array<{name:string, data:Buffer|string}>} entries — أسماء بمسارات / فقط.
 * @param {{mtime?:Date}} [options]
 * @returns {Buffer} الأرشيف الكامل.
 */
function buildStoredZip(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new Error('أرشيف فارغ مرفوض: لا إدخالات');
  const parts = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosStamp(options.mtime);

  for (const entry of list) {
    const name = String((entry && entry.name) || '');
    if (!name.trim()) throw new Error('إدخال ZIP بلا اسم');
    if (name.includes('\\')) throw new Error('اسم إدخال ZIP يجب أن يستخدم / لا \\ : ' + name);
    if (name.includes('..')) throw new Error('اسم إدخال ZIP يحتوي ../ — مرفوض');
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xFFFF) throw new Error('اسم إدخال أطول من حد ZIP');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String((entry && entry.data) ?? ''), 'utf8');
    if (data.length > 0xFFFFFFFF) throw new Error('إدخال أكبر من 4GB غير مدعوم في STORED');
    const crc = crc32(data);

    // 4.3.7 Local file header — 30 بايت
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);           // version needed: 2.0
    local.writeUInt16LE(0x0800, 6);       // flags: bit11 = UTF-8 names
    local.writeUInt16LE(0, 8);            // method: 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed (= raw في stored)
    local.writeUInt32LE(data.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    parts.push(local, nameBuf, data);

    // 4.3.12 Central directory entry — 46 بايت
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    central.writeUInt16LE(0, 10);         // method stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // إزاحة الرأس المحلي
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  if (list.length > 0xFFFF) throw new Error('عدد الإدخالات يتجاوز حد 16بت');

  // 4.3.16 End of central directory — 22 بايت
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);             // رقم القرص
  eocd.writeUInt16LE(0, 6);             // قرص الـ CD
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // حجم الأجزاء قبل الـ CD
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ─────────────────────── بناء محتوى العنصر الواحد ───────────────────────

/** frontmatter مصغّر متناسق لكل عنصر داخل الإكسپورت. */
function noteFmBlock(item) {
  const lines = [
    `id: ${item.id}`,
    `title: ${item.title}`,
    `kind: ${item.kind}`,
    `knowledge_kind: ${item.knowledge_kind || 'none'}`,
    `sensitivity: ${item.sensitivity || 'internal'}`,
  ];
  if (item.source) lines.push(`source: ${item.source}`);
  // إصلاح 2026-10-20: كان يطبع `exported_at: undefined` لأن العنصر لا يحمله —
  // الآن يُشتق وقت البناء نفسه، فالتصدير يحمل تاريخاً حقيقياً لا عنواناً ميتاً (§19).
  lines.push(`exported_at: ${item.exported_at || new Date().toISOString()}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/** نص العنصر الواحد كاملاً (fm + body) — يُستخدم في ملف md وفي إدخالات zip. */
function buildNoteMarkdown(item, bodyText) {
  return `${noteFmBlock(item)}\n${String(bodyText || '').replace(/\s+$/, '')}\n`;
}

// ─────────────────────────── تجميع المشروع ───────────────────────────

/**
 * يجمّع إكسپورت مشروع من عناصر القاعدة الحقيقية.
 * @param {object} input
 * @param {string} input.project                              اسم المشروع
 * @param {Array<object>} input.notes                         عناصر core.readNotes() مرشّحة للمشروع
 * @param {Array<{source,target,kind,origin,confidence}>} [input.links] صفوف note_links الكاملة
 * @param {Map<string,object>} [input.docEntities]            id → صف document_entities
 * @param {Set<string>} [input.quarantinedPaths]              مسارات مصادر محجورة حالياً
 * @param {string} [input.generatedAt]
 * @returns {{manifest:object, markdown:string, zipEntries:Array<{name:string,data:Buffer}>}}
 */
function buildProjectExport(input) {
  const {
    project,
    notes,
    links = [],
    docEntities = new Map(),
    quarantinedPaths = new Set(),
    generatedAt = new Date().toISOString(),
  } = input || {};

  const safeNotes = Array.isArray(notes) ? notes : [];
  const safeLinks = Array.isArray(links) ? links : [];

  const items = safeNotes.map((n) => {
    const fm = n.fm || {};
    const doc = docEntities instanceof Map ? docEntities.get(n.id) : null;
    const quarantined = quarantinedPaths instanceof Set
      ? (quarantinedPaths.has(fm.source) || quarantinedPaths.has(n.source) || false)
      : false;
    return {
      id: n.id,
      title: n.title || n.id,
      kind: (n.classification && n.classification.primaryType) || n.fm?.type || 'note',
      knowledge_kind: fm.knowledge_kind || null,
      source: fm.source || null,
      sensitivity: fm.sensitivity || 'internal',
      updatedAt: n.updatedAt || null,
      quarantined,
      document: doc ? {
        source: doc.source || null,
        doc_type: doc.doc_type || null,
        version: doc.version ?? null,
        fingerprint: doc.fingerprint || null,
        imported_at: doc.imported_at || null,
        original_path: doc.original_path || null,
      } : null,
      entities: Array.isArray(n.entities) ? n.entities : [],
      relations: safeLinks
        .filter((l) => l.source === n.id)
        .map((l) => ({
          target: l.target,
          kind: l.kind,
          origin: l.origin ?? null,
          confidence: typeof l.confidence === 'number' ? l.confidence : null,
        })),
    };
  });

  const manifest = {
    generator: 'cortex-export v5 (stored-zip, internal CRC32)',
    generatedAt,
    project: String(project || ''),
    notesCount: items.length,
    quarantinedCount: items.filter((i) => i.quarantined).length,
    items,
  };

  // ملف md واحد: ترويسة + عنصر بعنصر بفواصل + manifest كامل في الذيل
  const head = [
    '---',
    `exported_at: ${generatedAt}`,
    `project: ${manifest.project}`,
    `notes: ${items.length}`,
    'generator: Cortex v5 export',
    '---',
    '',
    `# تصدير المشروع: ${manifest.project}`,
    '',
    `أُنشئ في ${generatedAt} — ${items.length} عنصراً.`,
    '',
  ].join('\n');

  const sections = items.map((item) => {
    const n = safeNotes.find((x) => x.id === item.id) || {};
    return [
      '<!-- ══ عنصر ══ -->',
      buildNoteMarkdown(item, n.body || n.content || ''),
      '',
    ].join('\n');
  });

  const manifestSection = [
    '<!-- ══ MANIFEST ══ -->',
    '# Cortex Manifest',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
  ].join('\n');

  const markdown = head + sections.join('\n') + manifestSection;

  // إدخالات zip: manifest.json + ملف md مستقل لكل عنصر + الأصول الأصلية (م19)
  const zipEntries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...items.map((item) => {
      const n = safeNotes.find((x) => x.id === item.id) || {};
      return { name: `${item.id}.md`, data: Buffer.from(buildNoteMarkdown(item, n.body || n.content || ''), 'utf8') };
    }),
  ];
  /* الأصول تُرحَّل بايتاً ببايت — التصدير بلا أصول لا يعيد بناء المشروع (تدقيق 2026-10-19). */
  const exportedAssets = [];
  for (const a of (input.assets || [])) {
    const safeName = String(a.name || '').replace(/[\\/:*?"<>|]/g, '_') || 'asset.bin';
    zipEntries.push({ name: `assets/${safeName}`, data: a.data });
    exportedAssets.push({ docId: a.docId || null, name: safeName, bytes: a.data.length });
  }
  if (exportedAssets.length && manifest && typeof manifest === 'object') manifest.assets = exportedAssets;

  return { manifest, markdown, zipEntries };
}

module.exports = {
  crc32,
  buildStoredZip,
  buildProjectExport,
  buildNoteMarkdown,
  dosStamp,
};
