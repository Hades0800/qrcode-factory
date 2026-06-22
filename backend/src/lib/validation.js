// 工單號與字串通用驗證／處理
// 基本格式：1 英文字母 + 10 數字（例 F1150622001）
// 過濾網多機台生產可加「@機台號」尾碼（例 F1150622001@1）；後端僅容忍此格式以便存檔，
// 實際「只限過濾網」的限制在前端（生產時態頁依所選機台把關）。每個 @N 為獨立生產紀錄。
export const ORDER_NO_RE = /^[A-Z]\d{10}(@\d{1,2})?$/;

export function validOrderNo(s) { return typeof s === 'string' && ORDER_NO_RE.test(s); }

export function clipStr(s, max) { return s == null ? null : String(s).slice(0, max); }
