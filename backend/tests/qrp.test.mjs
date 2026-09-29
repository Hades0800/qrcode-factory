// ERP 匯出的加工單 .QRP 解析：用真實樣本（G1150929002）驗證欄位與明細。
// 執行：node tests/qrp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseQrp, parseRocDate, scan, toRows, toProcessOrderDraft } from '../src/modules/cutting/domain/qrp.js';

const buf = readFileSync(fileURLToPath(new URL('./fixtures/process-order-sample.qrp', import.meta.url)));
const ymd = d => (d ? d.toISOString().slice(0, 10) : null);

test('EMF 掃描：抓得到文字、邊界框與表格格線', () => {
  const { texts, lines } = scan(buf);
  assert.ok(texts.length >= 50, `文字區塊過少：${texts.length}`);
  assert.ok(texts.every(t => Number.isInteger(t.left) && t.right >= t.left));
  assert.ok(texts.some(t => t.text.includes('加工單')));
  const verticals = lines.filter(l => l.x1 === l.x2);
  assert.ok(verticals.length >= 8, `垂直格線過少：${verticals.length}`);
});

test('民國年日期轉換', () => {
  assert.equal(ymd(parseRocDate('115/09/29')), '2026-09-29');
  assert.equal(ymd(parseRocDate('115.10.01')), '2026-10-01');
  assert.equal(ymd(parseRocDate('99/01/05')), '2010-01-05');
  assert.equal(parseRocDate('2026-09-29'), null); // 西元年不吃，避免誤判
  assert.equal(parseRocDate(''), null);
});

test('樣本單 G1150929002：表頭欄位', () => {
  const r = parseQrp(buf);
  assert.equal(r.fields.processNo, 'G1150929002');
  assert.equal(r.fields.manuOrderNo, 'E1150929002');
  assert.equal(r.fields.customer, '凱詮');
  assert.equal(r.fields.area, '北區');
  assert.equal(ymd(r.fields.plannedDate), '2026-09-29');
  assert.equal(ymd(r.fields.dueDate), '2026-10-01');
  assert.equal(r.fields.poNo, null);        // 這張單沒填訂單號碼
  assert.equal(r.fields.productModel, null); // 也沒填產品型號
  assert.equal(r.fields.filledBy, '簡玉惠');
  assert.equal(r.pages, 1);
});

test('樣本單 G1150929002：領用材料與裁剪明細', () => {
  const r = parseQrp(buf);
  assert.equal(r.materials.length, 1);
  assert.match(r.materials[0].spec, /鋁捲1050/);
  assert.match(r.materials[0].spec, /2\.0T\*4'\*C'/);
  assert.equal(r.materials[0].qty, 1);      // 領用數量
  assert.equal(r.materials[0].total, 581);  // 總數
  assert.equal(r.materials[0].actualQty, null); // 實際使用數量：印出後手寫，ERP 不帶值
  assert.equal(r.materials[0].stock, null);     // 餘庫存：同上，不可變成 0

  assert.equal(r.cuts.length, 1);
  assert.match(r.cuts[0].spec, /鋁板1050/);
  assert.match(r.cuts[0].spec, /1950mm/);
  assert.equal(r.cuts[0].qty, 45);
});

test('轉成建單草稿', () => {
  const d = toProcessOrderDraft(parseQrp(buf));
  assert.equal(d.processNo, 'G1150929002');
  assert.equal(d.manuOrderNo, 'E1150929002');
  assert.equal(d.qty, 45);
  assert.match(d.spec, /鋁板1050.*, 45/);
  assert.equal(d.sourceMaterials.length, 1);
  assert.equal(d.sourceMaterials[0].total, 581);
  assert.equal(d.sourceMaterials[0].stock, null);
});

test('不是 QRP 的檔案：回錯誤而不是丟例外', () => {
  const r = parseQrp(Buffer.from('這不是 QRP', 'utf8'));
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到文字/);
});

test('明細欄位靠格線切，尾欄空白不會錯位', () => {
  const r = parseQrp(buf);
  // 領用材料表尾兩欄（實際使用數量、餘庫存）空白，數值不可被往前擠
  assert.equal(r.materials[0].qty, 1);
  assert.equal(r.materials[0].total, 581);
  // 裁剪表尾兩欄同樣空白
  assert.equal(r.cuts[0].qty, 45);
  assert.equal(r.cuts[0].actualSpecQty, null);
  assert.equal(r.cuts[0].oddSizeQty, null);
});

test('raw 保留原始列，供人工核對', () => {
  const r = parseQrp(buf);
  assert.ok(r.raw.length >= 10);
  assert.ok(r.raw.some(row => row.texts.join(' ').includes('上鎧鋼鐵股份有限公司')));
});
