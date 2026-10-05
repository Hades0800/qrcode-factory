// 生管上傳的加工排單原始檔（ERP 匯出的「加工單-入庫型號日期-明細表」）對應測試。
// 素材是真實檔 加0813-原.xlsx 的 45 列，鍵為表頭文字（模擬前端 SheetJS 的輸出）。
// 執行：node tests/schedule-import.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapScheduleRows, parseRocDate, toNum, splitCustomer } from '../src/modules/cutting/domain/scheduleImport.js';

const ROWS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/schedule-rows.json', import.meta.url)), 'utf8'));
const ymd = d => (d ? d.toISOString().slice(0, 10) : null);

test('民國年日期：年月日與斜線兩種寫法', () => {
  assert.equal(ymd(parseRocDate('115年08月03日')), '2026-08-03');
  assert.equal(ymd(parseRocDate('115/08/03')), '2026-08-03');
  assert.equal(ymd(parseRocDate('115.8.3')), '2026-08-03');
  assert.equal(parseRocDate(''), null);
  assert.equal(parseRocDate('N.否'), null);
  const d = new Date(Date.UTC(2026, 7, 3));
  assert.equal(ymd(parseRocDate(d)), '2026-08-03'); // SheetJS cellDates 已轉好就原樣用
});

test('空值回 null 不回 0', () => {
  assert.equal(toNum(''), null);
  assert.equal(toNum('0'), 0);
  assert.equal(toNum('215.24'), 215.24);
  assert.equal(toNum('1,500', true), 1500);
});

test('公司編號拆成代號與名稱', () => {
  assert.deepEqual(splitCustomer('26-33610003 台鎰'), { code: '26-33610003', name: '台鎰' });
  assert.deepEqual(splitCustomer('22210003+ 昀諭行'), { code: '22210003+', name: '昀諭行' });
  assert.deepEqual(splitCustomer('26-63300001X 銳德利'), { code: '26-63300001X', name: '銳德利' });
  assert.deepEqual(splitCustomer(''), { code: null, name: null });
});

test('真實檔 加0813-原：45 列 → 22 張加工單', () => {
  const r = mapScheduleRows(ROWS);
  assert.equal(ROWS.length, 45);
  assert.equal(r.orders.length, 22);
  assert.equal(r.skipped, 0);
  assert.ok(r.orders.every(o => /^G\d{10}$/.test(o.processNo)), '單號格式應為 G + 10 碼');
});

test('表頭欄位對應', () => {
  const o = mapScheduleRows(ROWS).orders.find(x => x.processNo === 'G1150803006');
  assert.equal(o.customerCode, '26-33610003');
  assert.equal(o.customer, '台鎰');
  assert.equal(o.area, '北區');
  assert.equal(o.category, '擴張網');
  assert.equal(ymd(o.dispatchDate), '2026-08-03');   // 報表「日期」= 派工日期
  assert.equal(o.plannedDate, undefined, '預計日期由生管排單時填，匯入不帶');
  assert.equal(ymd(o.dueDate), '2026-08-24');
  assert.equal(o.erpClosed, false);   // 結案 0.否
  assert.equal(o.oddCutting, false);  // 零星裁剪 N.否
  assert.equal(o.source, 'excel');
});

test('多項次不會被壓成一筆——G1150811002 有 11 個項次', () => {
  const o = mapScheduleRows(ROWS).orders.find(x => x.processNo === 'G1150811002');
  assert.equal(o.items.length, 11);
  assert.deepEqual(o.items.slice(0, 3).map(i => i.seq), ['0010', '0020', '0030']);
  // 各項次數量不同，單頭數量是加總
  const qtys = o.items.map(i => i.qty);
  assert.ok(new Set(qtys).size > 1, '各項次數量應該不同');
  assert.equal(o.qty, qtys.reduce((s, q) => s + q, 0));
  assert.equal(o.items[0].unit, 'PCS');
  assert.equal(o.items[0].materialCode, '鋁');
});

test('明細帶出型號、單重、總數與回單進度', () => {
  const o = mapScheduleRows(ROWS).orders.find(x => x.processNo === 'G1150803006');
  const it = o.items[0];
  assert.equal(it.qty, 500);
  assert.equal(it.unitWeight, 0.43);
  assert.equal(it.totalWeight, 215.24);
  assert.match(it.modelCode, /^00010000AL/);
  assert.equal(it.pendingQty, 500);   // 未回數量
  assert.equal(it.returnedQty, 0);    // 已回數量：這批都還沒回
  assert.equal(o.returnedQty, 0);
  assert.equal(o.pendingQty, 500);
});

test('缺欄位的列不會爆——編織網那幾列沒有型號／材質／單位／類別', () => {
  const o = mapScheduleRows(ROWS).orders.find(x => x.processNo === 'G1150810005');
  assert.ok(o, '應該要有這張單');
  assert.match(o.items[0].spec, /SUS304編織網/);
  assert.equal(o.items[0].unit, '捲');
});

test('沒有工令欄位時要提醒', () => {
  const r = mapScheduleRows(ROWS);
  assert.ok(r.orders.every(o => o.manuOrderNo === null));
  assert.ok(r.warnings.some(w => /工令/.test(w)), `warnings: ${r.warnings}`);
});

test('ERP 之後加了工令欄位就自動吃得到', () => {
  const rows = ROWS.slice(0, 2).map(r => ({ ...r, 工令單號: 'E1150803001' }));
  const r = mapScheduleRows(rows);
  assert.equal(r.orders[0].manuOrderNo, 'E1150803001');
  assert.ok(!r.warnings.some(w => /工令/.test(w)));
});

test('壞資料：單號格式不對要略過並記錄，不是整批失敗', () => {
  const rows = [...ROWS.slice(0, 2), { ...ROWS[0], 加工單號: '不是單號' }, { ...ROWS[0], 加工單號: '' }];
  const r = mapScheduleRows(rows);
  assert.equal(r.orders.length, 2);
  assert.equal(r.skipped, 2);
  assert.ok(r.warnings.some(w => /格式不對/.test(w)));
});

test('同一張單的表頭欄位前後不一致要警告', () => {
  const base = ROWS.filter(x => x['加工單號'] === 'G1150811002').slice(0, 2);
  const rows = [base[0], { ...base[1], 區域編號: '北區' }]; // 原本是南區
  const r = mapScheduleRows(rows);
  assert.ok(r.warnings.some(w => /area/.test(w) && /G1150811002/.test(w)), `warnings: ${r.warnings}`);
});

test('空檔案要講清楚', () => {
  const r = mapScheduleRows([]);
  assert.equal(r.orders.length, 0);
  assert.ok(r.warnings.some(w => /找不到任何加工單/.test(w)));
});
