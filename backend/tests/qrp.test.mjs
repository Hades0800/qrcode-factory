// ERP 匯出的 .QRP 解析：用真實樣本驗證（製造單 F1150924004、加工單 G1150929002）。
// 執行：node tests/qrp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseQrp, parseRocDate, toNum, scan } from '../src/lib/qrp.js';
import { toProcessOrderDraft, parseProcessOrderQrp } from '../src/modules/cutting/domain/qrp.js';

const fixture = n => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)));
const PROCESS = fixture('process-order-sample.qrp');      // 加工單 G
const MANUFACTURE = fixture('manufacture-order-sample.qrp'); // 製造單 F
const ymd = d => (d ? d.toISOString().slice(0, 10) : null);

test('EMF 掃描：抓得到文字、邊界框與表格格線', () => {
  for (const buf of [PROCESS, MANUFACTURE]) {
    const { texts, lines } = scan(buf);
    assert.ok(texts.length >= 50, `文字區塊過少：${texts.length}`);
    assert.ok(texts.every(t => Number.isInteger(t.left) && t.right >= t.left));
    assert.ok(lines.filter(l => l.x1 === l.x2).length >= 8, '垂直格線過少');
  }
});

test('民國年日期轉換', () => {
  assert.equal(ymd(parseRocDate('115/09/29')), '2026-09-29');
  assert.equal(ymd(parseRocDate('115.10.01')), '2026-10-01');
  assert.equal(ymd(parseRocDate('99/01/05')), '2010-01-05');
  assert.equal(parseRocDate('2026-09-29'), null); // 西元年不吃，避免誤判
  assert.equal(parseRocDate(''), null);
});

test('空值回 null 不回 0——「沒填」與「填 0」要分得開', () => {
  assert.equal(toNum(''), null);
  assert.equal(toNum(null), null);
  assert.equal(toNum(undefined), null);
  assert.equal(toNum('0'), 0);
  assert.equal(toNum('581.00'), 581);
  assert.equal(toNum('1,200'), 1200);
  assert.equal(toNum('abc'), null);
});

// ── 加工單 G ────────────────────────────────────────────────────────────────
test('加工單 G1150929002：單別、表頭、明細', () => {
  const r = parseQrp(PROCESS);
  assert.equal(r.docType, 'process');
  assert.equal(r.ok, true, `不該有 warning：${r.warnings}`);
  assert.equal(r.fields.docNo, 'G1150929002');
  assert.equal(r.fields.workOrderNo, 'E1150929002');
  assert.equal(r.fields.customer, '凱詮');
  assert.equal(r.fields.area, '北區');
  assert.equal(ymd(r.fields.plannedDate), '2026-09-29');
  assert.equal(ymd(r.fields.dueDate), '2026-10-01');
  assert.equal(r.fields.poNo, null);         // 訂單號碼、產品型號由業助之後補填
  assert.equal(r.fields.productModel, null);
  assert.equal(r.fields.filledBy, '簡玉惠');

  assert.equal(r.materials.length, 1);
  assert.match(r.materials[0].spec, /鋁捲1050/);
  assert.equal(r.materials[0].qty, 1);         // 領用數量
  assert.equal(r.materials[0].total, 581);     // 總數
  assert.equal(r.materials[0].actualQty, null); // 印出後手寫，ERP 不帶值
  assert.equal(r.materials[0].stock, null);

  assert.equal(r.items.length, 1);
  assert.match(r.items[0].spec, /鋁板1050.*1950mm/);
  assert.equal(r.items[0].qty, 45);
});

// ── 製造單 F ────────────────────────────────────────────────────────────────
test('製造單 F1150924004：單別、表頭、製造參數', () => {
  const r = parseQrp(MANUFACTURE);
  assert.equal(r.docType, 'manufacture');
  assert.equal(r.ok, true, `不該有 warning：${r.warnings}`);
  assert.equal(r.fields.docNo, 'F1150924004');
  assert.equal(r.fields.workOrderNo, 'E1150924005');
  assert.equal(r.fields.customer, 'HIGANO日本');
  assert.equal(r.fields.area, '外銷');
  assert.equal(r.fields.poNo, 'EVA口頭指示');       // 訂單號碼可以是文字
  assert.equal(r.fields.productModel, 'SKA20-142 樣品');
  assert.equal(ymd(r.fields.dueDate), '2026-10-02');
  assert.equal(r.fields.filledBy, '張季淳');

  // 品管要點區的製造參數
  assert.equal(r.params.machineSPM, 100);
  assert.equal(r.params.feedSetting, '12.4');
  assert.equal(r.params.moldSpec, '30*100--︵');
  assert.equal(r.params.widthTolerance, null); // 空白欄位不可撿到隔壁的標籤
});

test('製造單：跨行儲存格合併成一筆，數字不重複累加', () => {
  const r = parseQrp(MANUFACTURE);
  // 生產明細三行同為序號 0010 → 一筆，規格接成多行
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].seq, '0010');
  assert.equal(r.items[0].qty, 12);
  assert.match(r.items[0].spec, /SKA20-142/);
  assert.match(r.items[0].spec, /完整孔\(3孔\)/);
  assert.match(r.items[0].spec, /寄日本/);
  assert.equal(r.items[0].spec.split('\n').length, 3);

  // 領用材料兩行同序號 → 一筆，文字接續、數量不變成 2
  assert.equal(r.materials.length, 1);
  assert.equal(r.materials[0].orderQty, 12);
  assert.equal(r.materials[0].qty, 1);
  assert.match(r.materials[0].spec, /零星料/);
  assert.match(r.materials[0].spec, /雙面貼膜/);
});

// ── 建單草稿與防呆 ──────────────────────────────────────────────────────────
test('加工單 → ProcessOrder 草稿', () => {
  const d = toProcessOrderDraft(parseQrp(PROCESS));
  assert.equal(d.processNo, 'G1150929002');
  assert.equal(d.manuOrderNo, 'E1150929002');
  assert.equal(d.qty, 45);
  assert.match(d.spec, /鋁板1050.*, 45/);
  assert.equal(d.sourceMaterials.length, 1);
  assert.equal(d.sourceMaterials[0].total, 581);
  assert.equal(d.sourceMaterials[0].stock, null);
});

test('拿製造單去匯入加工單：擋下來', () => {
  const r = parseProcessOrderQrp(MANUFACTURE);
  assert.equal(r.ok, false);
  assert.match(r.warnings[0], /製造單/);
  assert.equal(parseProcessOrderQrp(PROCESS).ok, true);
});

test('不是 QRP 的檔案：回錯誤而不是丟例外', () => {
  const r = parseQrp(Buffer.from('這不是 QRP', 'utf8'));
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到文字/);
});

test('raw 保留原始列，供人工核對', () => {
  for (const buf of [PROCESS, MANUFACTURE]) {
    const r = parseQrp(buf);
    assert.ok(r.raw.length >= 10);
    assert.ok(r.raw.some(row => row.texts.join(' ').includes('上鎧鋼鐵股份有限公司')));
  }
});
