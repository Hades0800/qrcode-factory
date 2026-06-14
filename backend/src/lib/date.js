// 台灣時區日期工具

// 把任意時間轉成「台灣日期」（UTC 午夜，當作純日期標記）
export function toTaiwanDate(t) {
  const d = t instanceof Date ? t : new Date(t || Date.now());
  const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
}

// 取得時刻所在「台灣當日 08:00」對應的 UTC 時間
// （Taiwan 08:00 = UTC 00:00 of the same Taiwan date）
export function taiwanDateAt8(t) {
  const d = t instanceof Date ? t : new Date(t || Date.now());
  const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate(), 0, 0, 0));
}
