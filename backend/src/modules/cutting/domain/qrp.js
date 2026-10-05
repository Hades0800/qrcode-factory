// 加工單 QRP → 建立 ProcessOrder 的草稿。格式解析在 lib/qrp.js（製造單 / 加工單共用）。
export { parseQrp, parseRocDate, scan, toRows } from '../../../lib/qrp.js';
import { parseQrp } from '../../../lib/qrp.js';

// 人工核對後才送出建單；這裡只負責把解析結果排成表單預設值
export function toProcessOrderDraft(parsed) {
  const { fields, items, materials } = parsed;
  return {
    processNo: fields.docNo,
    manuOrderNo: fields.workOrderNo, // 工令單號 E：製造單與加工單靠它對應
    customer: fields.customer,
    spec: items.map(i => (i.qty == null ? i.spec : `${i.spec} , ${i.qty}`)).join('\n') || null,
    qty: items.reduce((s, i) => s + (i.qty || 0), 0) || null,
    machineNo: fields.machineNo,
    dispatchDate: fields.dispatchDate,
    dueDate: fields.dueDate,
    remark: [fields.cutMethod, fields.packMethod].filter(Boolean).join('；') || null,
    sourceMaterials: materials.map(m => ({ spec: m.spec, qty: m.qty, total: m.total, stock: m.stock })),
  };
}

// 只收加工單；拿到製造單要擋下來
export function parseProcessOrderQrp(buf) {
  const parsed = parseQrp(buf);
  if (parsed.docType === 'manufacture') {
    return { ...parsed, ok: false, warnings: ['這是【製造單】，不是加工單——請改從生產模組匯入', ...parsed.warnings] };
  }
  return parsed;
}
