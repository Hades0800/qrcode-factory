// QR 標籤內容的規則:欄位 ↔ 六項文字要能互相還原,對照關聯表的範例一~三。
// 執行:node tests/labels.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQrText, parseQrText, parseDate, fmtDate, makeLabelCode } from '../src/modules/inventory/domain/label.js';

test('範例一:單一規格六項文字', () => {
  const text = buildQrText({
    customer: '光輝  (北)', poNo: 'PO-12345', manuOrderNo: 'F1150810001', processOrderNo: 'G1150810006',
    location: 'D-C-F123', machineNo: 'No.3', dueDate: parseDate('2026.08.12'), remark: null,
    specs: [{ spec: "鋁 SKA20-8*4'*1200mm", qty: 100, weight: 860 }],
  });
  assert.equal(text, [
    '光輝  (北)', 'PO-12345', 'F1150810001 , G1150810006', 'D-C-F123 , No.3', '2026.08.12',
    "鋁 SKA20-8*4'*1200mm , 100 , 860",
  ].join('\n'));
  const f = parseQrText(text);
  assert.equal(f.manuOrderNo, 'F1150810001');
  assert.equal(f.processOrderNo, 'G1150810006');
  assert.equal(f.location, 'D-C-F123');
  assert.equal(f.machineNo, 'No.3');
  assert.equal(fmtDate(f.dueDate), '2026.08.12');
  assert.deepEqual(f.specs, [{ spec: "鋁 SKA20-8*4'*1200mm", qty: 100, weight: 860 }]);
});

test('範例二:多規格、數字前後空格不一致也要讀得對', () => {
  const f = parseQrText([
    '光輝  (北)', 'PO-12345', 'F1150810001 , G1150810006', 'D-C-F123 , No.3', '2026.08.12',
    "鋁 SKA20-8*4'*1200mm , 11 , 860", "鋁 SKA20-8*4'*3180mm ,78 ,3160", "鋁 SKA20-8*5'*3180mm , 4 , 880",
  ].join('\n'));
  assert.equal(f.specs.length, 3);
  assert.deepEqual(f.specs[1], { spec: "鋁 SKA20-8*4'*3180mm", qty: 78, weight: 3160 });
});

test('範例三:原料標籤,訂單與製造單是「-」,納期後面接備註', () => {
  const text = buildQrText({
    customer: '天禧  (分條加工)', location: 'D-C-F123', dueDate: parseDate('2026.08.12'),
    remark: '庫存1995+1995=3990', specs: [{ spec: "GI 0.28T * 595 * 2C'" }],
  });
  assert.equal(text, ['天禧  (分條加工)', '-', '-', 'D-C-F123', '2026.08.12 , 庫存1995+1995=3990', "GI 0.28T * 595 * 2C'"].join('\n'));
  const f = parseQrText(text);
  assert.equal(f.poNo, null);
  assert.equal(f.manuOrderNo, null);
  assert.equal(f.remark, '庫存1995+1995=3990');
  assert.deepEqual(f.specs, [{ spec: "GI 0.28T * 595 * 2C'", qty: null, weight: null }]);
});

test('不是標籤的文字回 null;標籤碼有日期', () => {
  assert.equal(parseQrText('STEP:3'), null);
  assert.match(makeLabelCode(new Date('2026-09-27T10:00:00+08:00')), /^LB-20260927-[A-Z0-9]{6}$/);
});
