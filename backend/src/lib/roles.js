// 角色(對照「QR Code MES 關聯表」的擔當同仁欄)。帳號的 roles 是逗號字串,可多個。
export const ROLES = {
  sales: '業務助理',       // 建標籤、上傳製造單/加工單/出貨單
  warehouse: '倉管人員',   // 入庫 / 出庫 / 出貨 QR 檢核
  planner: '生管人員',     // 每周生產計畫上傳
  production: '生產人員',  // 生產工單完成、再製 QR
  processing: '加工人員',  // 裁切工單完成、QR 結案
};

export function parseRoles(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(x => x in ROLES);
}
