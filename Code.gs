/**
 * 廠務工單進度記錄 - Google Apps Script 後端（GET 版）
 * 全部使用 GET，避免 doPost / 302 redirect 等 Apps Script 已知問題
 */

const ACCESS_TOKEN = 'shangkaimanu2026';

const SHEET_NAME = '工單進度';

const COLUMNS = [
  '工單號',          // A
  '小組長',          // B
  '1.原料準備',      // C
  '2.模刀具',        // D
  '3.試模確認',      // E
  '4.斷續試稼',      // F
  '4-備註',          // G
  '5.穩定生產',      // H
  '6.後工程',        // I
  '7.異常註記',      // J
  '7-備註',          // K
  '最後更新',        // L
];

const STEP_MAP = {
  '1': { time: '1.原料準備', note: null },
  '2': { time: '2.模刀具',   note: null },
  '3': { time: '3.試模確認', note: null },
  '4': { time: '4.斷續試稼', note: '4-備註' },
  '5': { time: '5.穩定生產', note: null },
  '6': { time: '6.後工程',   note: null },
  '7': { time: '7.異常註記', note: '7-備註' },
};

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = (e && e.parameter) || {};

    // 沒帶 action → 回 health check
    if (!p.action) {
      return jsonOut_({ ok: true, msg: '工單記錄系統運作中' });
    }

    if (p.token !== ACCESS_TOKEN) {
      return jsonOut_({ ok: false, error: '密碼錯誤', code: 'unauthorized' });
    }

    let result;
    if (p.action === 'getOrder') {
      result = getOrder(p.orderNo);
    } else if (p.action === 'setStep') {
      result = setStep(p.orderNo, p.leader, p.step, p.note);
    } else if (p.action === 'clearStep') {
      result = clearStep(p.orderNo, p.step);
    } else {
      result = { ok: false, error: '未知動作: ' + p.action };
    }
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  // 為相容性保留，內容轉給 doGet
  return doGet(e);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLUMNS.length)
      .setFontWeight('bold')
      .setBackground('#f1c232');
  }
  return sh;
}

function findOrCreateRow_(sh, orderNo) {
  const lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    const data = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(orderNo)) {
        return i + 2;
      }
    }
  }
  const newRow = lastRow + 1;
  sh.getRange(newRow, 1).setValue(orderNo);
  return newRow;
}

function rowToObject_(sh, row) {
  const values = sh.getRange(row, 1, 1, COLUMNS.length).getValues()[0];
  const obj = {};
  for (let i = 0; i < COLUMNS.length; i++) {
    let v = values[i];
    if (v instanceof Date) {
      v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    }
    obj[COLUMNS[i]] = v;
  }
  return obj;
}

function getOrder(orderNo) {
  if (!orderNo) return { ok: false, error: '缺少工單號' };
  const sh = getSheet_();
  const row = findOrCreateRow_(sh, orderNo);
  return { ok: true, row: rowToObject_(sh, row) };
}

function setStep(orderNo, leader, step, note) {
  if (!orderNo) return { ok: false, error: '缺少工單號' };
  if (!STEP_MAP[step]) return { ok: false, error: '無效步驟: ' + step };
  const sh = getSheet_();
  const row = findOrCreateRow_(sh, orderNo);

  const stepInfo = STEP_MAP[step];
  const timeCol = COLUMNS.indexOf(stepInfo.time) + 1;

  const existing = sh.getRange(row, timeCol).getValue();
  if (existing) {
    return { ok: false, error: '此項目已記錄過：' + existing, row: rowToObject_(sh, row) };
  }

  const now = new Date();
  const ts = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sh.getRange(row, timeCol).setValue(ts);

  if (stepInfo.note && note) {
    const noteCol = COLUMNS.indexOf(stepInfo.note) + 1;
    sh.getRange(row, noteCol).setValue(note);
  }
  if (leader) {
    sh.getRange(row, 2).setValue(leader);
  }
  sh.getRange(row, COLUMNS.length).setValue(ts);

  return { ok: true, row: rowToObject_(sh, row) };
}

function clearStep(orderNo, step) {
  if (!orderNo) return { ok: false, error: '缺少工單號' };
  if (!STEP_MAP[step]) return { ok: false, error: '無效步驟: ' + step };
  const sh = getSheet_();
  const row = findOrCreateRow_(sh, orderNo);

  const stepInfo = STEP_MAP[step];
  const timeCol = COLUMNS.indexOf(stepInfo.time) + 1;
  sh.getRange(row, timeCol).clearContent();

  if (stepInfo.note) {
    const noteCol = COLUMNS.indexOf(stepInfo.note) + 1;
    sh.getRange(row, noteCol).clearContent();
  }

  const now = new Date();
  const ts = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  sh.getRange(row, COLUMNS.length).setValue(ts);

  return { ok: true, row: rowToObject_(sh, row) };
}
