// tests/backup-gate.test.mjs — §24 + §35: بوابة «قابلية الاستعادة» يجب أن
// تقيس الواقع. الفخ الذي وقع الأصل فيه: النسخة تُنقذ الملفات وتُفقد القاعدة.
// هذا الاختبار يثبت أن البوابة **تُفشل** نسخةً بلا قاعدة (لا تُوهم بالنجاح).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = path.resolve(import.meta.dirname, '..');
const backupDir = path.join(root, 'data', 'backups');

// ZIP بلا أي قاعدة — ملف نصي واحد فقط (يحاكي العطل الأصلي بالضبط)
function minimalZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = require('node:zlib').crc32 ? require('node:zlib').crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

test('البوابة تُفشل نسخةً بلا قاعدة — لا تُوهم بالنجاح', async () => {
  fs.mkdirSync(backupDir, { recursive: true });
  const real = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip'));
  const target = path.join(backupDir, 'zzz-gate-probe-fake.zip');
  // نسخة «كاذبة»: ملفات فقط، بلا data/cortex.db — وهذا هو العطل الأصلي بالحرف
  fs.writeFileSync(target, minimalZip([
    ['vault/note.md', Buffer.from('# ملاحظة\nلا قاعدة هنا\n', 'utf8')],
    ['data/settings.json', Buffer.from('{}', 'utf8')],
  ]));
  try {
    const gates = require(path.join(root, 'cortex-gates.js'));
    const { DatabaseSync } = require('node:sqlite');
    // `canRelease` تقييم محض بلا كتابة (checkGates يكتب في release_gates)
    const db = new DatabaseSync(path.join(root, 'data', 'cortex.db'), { readOnly: true });
    const res = await gates.canRelease(db, {});
    db.close();
    assert.ok(res.blocking.includes('backup_restorable'),
      `نسخة بلا قاعدة يجب أن تحجب الإطلاق، والحاجب: ${JSON.stringify(res.blocking)}`);
  } finally {
    fs.rmSync(target, { force: true });
  }
});
