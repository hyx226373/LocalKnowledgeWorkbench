'use strict';
/**
 * native-app-helper entry — exports createHelper() for win32Helper.createWin32Helper().
 * On non-win32 or koffi load failure: throws (caller falls back to StubWin32Helper).
 * Product Win32 APIs only; no injection / hooks / exploit paths.
 */

function createHelper() {
  if (process.platform !== 'win32') {
    const err = new Error(
      `native-app-helper createHelper requires win32 (current: ${process.platform})`,
    );
    err.code = 'PLATFORM_UNSUPPORTED';
    throw err;
  }

  let koffi;
  try {
    koffi = require('koffi');
  } catch (e) {
    const err = new Error(
      `koffi not available (${e && e.message ? e.message : e}). ` +
        `On PC worktree run: npm install koffi   ` +
        `or: cd native/native-app-helper && npm install`,
    );
    err.code = 'HELPER_UNAVAILABLE';
    throw err;
  }

  const { Win32KoffiHelper } = require('./src/win32KoffiHelper');
  return new Win32KoffiHelper(koffi);
}

module.exports = { createHelper };
