// 工單號與字串通用驗證／處理
export const ORDER_NO_RE = /^[A-Z]\d{10}$/;

export function validOrderNo(s) { return typeof s === 'string' && ORDER_NO_RE.test(s); }

export function clipStr(s, max) { return s == null ? null : String(s).slice(0, max); }
