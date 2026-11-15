'use strict';
/**
 * مسار متصفّح Chrome لمجموعة اختبارات الواجهة — عبر المنصات.
 *
 * العطل المقاس (تدقيق 2026-11-11): كل ملف اختبار كان يثبّت
 * `C:\Program Files\Google\Chrome\Application\chrome.exe` (أحدها بلا احترام
 * `CHROME_PATH` أصلاً)، فتفشل السويتة كاملة على macOS/Linux بلا سبب مفهوم.
 *
 * الترتيب: CHROME_PATH (صريح) ← مسارات المنصّة المعتادة ← خطأ واضح يشرح الحل.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

function resolveChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`CHROME_PATH يشير إلى ملف غير موجود: ${explicit}`);
  }
  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  for (const c of list) {
    if (!c) continue;
    try { if (fs.existsSync(c)) return c; } catch { /* مسار غير صالح */ }
  }
  throw new Error(
    `لم يُعثر على متصفّح Chrome/Chromium على ${process.platform} (${os.arch()}).` +
    ' ثبّت Chrome أو Edge، أو اضبط CHROME_PATH على مسار الملف التنفيذي.'
  );
}

module.exports = { resolveChrome };