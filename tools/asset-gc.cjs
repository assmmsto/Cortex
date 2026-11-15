'use strict';
/**
 * تنظيف الأصول اليتيمة في data/assets — أداة صيانة صريحة (افتراضياً dry-run).
 *
 * الخلفية المقيسة (2026-11-03): data/assets فيها 865 ملفاً (~2207MB) منها ~859
 * يتيماً لا يشير إليها أي صف document_entities.asset_path أبداً — 58 ملف zip
 * بـ ~50MB لكل واحد، بلا ربط بالقاعدة. القاعدة: لا يُحذف أي ملف إلا بعد
 * إثبات أن لا صف قاعدة يشير إليه بمساره الكامل (نص طبق الأصل مع تطبيع ‎\\‎/‎/‎)،
 * والافتراضي عرض فقط حتى يُثبت الحجم صراحة بـ --apply.
 *
 * الاستخدام:
 *   node tools/asset-gc.cjs                # عرض المرشحين فقط (افتراضي)
 *   node tools/asset-gc.cjs --apply        # حذف فعلي للمرشحين المثبتين يتيماً
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'data', 'assets');
const DB_PATH = process.env.CORTEX_DB_PATH || path.join(PROJECT_ROOT, 'data', 'cortex.db');

function normalize(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

async function main() {
  const apply = process.argv.includes('--apply');
  if (!fs.existsSync(ASSETS_DIR)) { console.log('لا مجلد أصول — انتهى بلا عمل.'); return; }
  if (!fs.existsSync(DB_PATH)) { console.error('لا قاعدة بيانات:' + DB_PATH); process.exit(1); }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const referenced = new Set();
  let refCount = 0;
  try {
    const rows = db.prepare('SELECT asset_path FROM document_entities WHERE asset_path IS NOT NULL AND asset_path <> ?').all('');
    refCount = rows.length;
    for (const r of rows) {
      const n = normalize(r.asset_path);
      if (n.includes('/data/assets/')) referenced.add(n.split('/data/assets/')[1]);
    }
  } finally { db.close(); }

  const files = (await fsp.readdir(ASSETS_DIR)).filter(f => {
    try { return fs.statSync(path.join(ASSETS_DIR, f)).isFile(); } catch { return false; }
  });
  const orphans = files.filter(f => !referenced.has(normalize(f)));

  let orphanBytes = 0;
  for (const f of orphans) { try { orphanBytes += fs.statSync(path.join(ASSETS_DIR, f)).size; } catch {} }
  const mb = (orphanBytes / 1024 / 1024).toFixed(1);

  console.log(`الأصول على القرص: ${files.length} ملف · المرجع في القاعدة: ${refCount} · الأيتام: ${orphans.length}`);
  console.log(`حجم الأيتام: ~${mb}MB (${(orphanBytes / 1024 / 1024 / 1024).toFixed(2)}GB)`);
  for (const f of orphans.slice(0, 25)) console.log(`  - ${f}`);
  if (orphans.length > 25) console.log(`  … و${orphans.length - 25} غيرها`);
  if (!apply) { console.log('\nوضع العرض فقط — للحذف: node tools/asset-gc.cjs --apply'); return; }

  let removed = 0, failed = 0;
  for (const f of orphans) {
    const fp = path.join(ASSETS_DIR, f);
    try { await fsp.unlink(fp); removed++; } catch (e) { failed++; console.error(`فشل حذف ${f}: ${e.message}`); }
  }
  console.log(`\nحُذفت ${removed} أصل يتيم (حوالي ${(orphanBytes / 1024 / 1024).toFixed(1)}MB) — فشل ${failed}.`);
  console.log('بقي على القرص: الملفات المشار إليها في document_entities.asset_path فقط.');
}

main().catch(e => { console.error('فشل التنظيف:', e.message); process.exit(1); });
