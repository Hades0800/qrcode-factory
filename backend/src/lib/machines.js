// 允許的機台號（後端單一來源）
// 前端各頁（index.html、plan-stats.html、realtime.html…）另有對應清單，新增機台時需一併更新。
export const ALLOWED_MACHINES = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40',
  'No12','No13','No16','No17','No18','No19','No20']);

export function validMachine(s) { return !s || ALLOWED_MACHINES.has(String(s)); }
