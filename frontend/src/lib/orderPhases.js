// 一張工單在「特定一天」內的工時分配（秒）— 對應原 utils.js 的 computeOrderPhasesForDay
// 回傳 { prepSec, prodSec, abnSec }
export function computeOrderPhasesForDay(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const inToday = (t) => t != null && t >= dayStart && t < dayEnd;

  const entries = o.stepEntries || [];
  const allPauses = [
    ...((o.pause12 && o.pause12.history) || []),
    ...((o.pause13 && o.pause13.history) || []),
  ];

  const todayEventTimes = [];
  entries.forEach(e => { const t = new Date(e.recordedAt).getTime(); if (inToday(t)) todayEventTimes.push(t); });
  allPauses.forEach(p => {
    if (p.startAt && inToday(new Date(p.startAt).getTime())) todayEventTimes.push(new Date(p.startAt).getTime());
    if (p.endAt && inToday(new Date(p.endAt).getTime())) todayEventTimes.push(new Date(p.endAt).getTime());
  });
  const step11Ms = o.step11At ? new Date(o.step11At).getTime() : null;
  if (inToday(step11Ms)) todayEventTimes.push(step11Ms);

  if (todayEventTimes.length === 0) return { prepSec: 0, prodSec: 0, abnSec: 0 };

  const allStep41Times = entries.filter(e => e.stepNo === '41')
    .map(e => new Date(e.recordedAt).getTime())
    .sort((a, b) => a - b);
  const firstStep41Any = allStep41Times[0] || null;
  const todayStep41 = allStep41Times.find(t => inToday(t)) || null;
  const step41WasBefore = firstStep41Any != null && firstStep41Any < dayStart;
  const todayStep11 = inToday(step11Ms) ? step11Ms : null;

  const todayEntryTimes = entries
    .map(e => new Date(e.recordedAt).getTime())
    .filter(t => inToday(t))
    .sort((a, b) => a - b);
  const todayFirstEntry = todayEntryTimes[0] || null;
  const todayLastEvent = Math.max(...todayEventTimes);

  // PREP
  let prepSec = 0;
  let prepStart = null, prepEnd = null;
  if (todayFirstEntry != null) {
    prepStart = todayFirstEntry;
    prepEnd = todayStep41 != null ? todayStep41 : (todayStep11 != null ? todayStep11 : todayLastEvent);
  }
  if (prepStart != null && prepEnd != null && prepEnd > prepStart) {
    const grossPrep = Math.round((prepEnd - prepStart) / 1000);
    let pauseInPrep = 0;
    allPauses.forEach(p => {
      if (!p.startAt) return;
      const ps = new Date(p.startAt).getTime();
      const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
      const a = Math.max(ps, prepStart);
      const b = Math.min(pe, prepEnd);
      if (b > a) pauseInPrep += Math.round((b - a) / 1000);
    });
    prepSec = Math.max(0, grossPrep - pauseInPrep);
  }

  const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;
  const isRecentlyActive = (Date.now() - todayLastEvent) < ACTIVE_THRESHOLD_MS;
  const nowCapped = Math.min(Date.now(), dayEnd);

  // PROD
  let prodSec = 0;
  let prodStart = null, prodEnd = null;
  if (todayStep41 != null) {
    prodStart = todayStep41;
    if (todayStep11 != null) prodEnd = todayStep11;
    else prodEnd = isRecentlyActive ? Math.max(todayLastEvent, nowCapped) : todayLastEvent;
  } else if (step41WasBefore) {
    const todayResumes = allPauses
      .filter(p => p.endAt && inToday(new Date(p.endAt).getTime()))
      .map(p => new Date(p.endAt).getTime())
      .sort((a, b) => a - b);
    const shiftStart = dayStart + 8 * 3600 * 1000;
    prodStart = todayResumes[0] != null ? todayResumes[0] : shiftStart;
    if (todayStep11 != null) prodEnd = todayStep11;
    else prodEnd = isRecentlyActive ? Math.max(todayLastEvent, nowCapped) : (todayLastEvent != null ? todayLastEvent : prodStart);
  }
  if (prodStart != null && prodEnd != null && prodEnd > prodStart) {
    const grossProd = Math.round((prodEnd - prodStart) / 1000);
    let pauseInProd = 0;
    allPauses.forEach(p => {
      if (!p.startAt) return;
      const ps = new Date(p.startAt).getTime();
      const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
      const a = Math.max(ps, prodStart);
      const b = Math.min(pe, prodEnd);
      if (b > a) pauseInProd += Math.round((b - a) / 1000);
    });
    prodSec = Math.max(0, grossProd - pauseInProd);
  }

  // ABN (pause13)
  let abnSec = 0;
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (!p.startAt) return;
    const ps = new Date(p.startAt).getTime();
    const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
    const a = Math.max(ps, dayStart);
    const b = Math.min(pe, dayEnd);
    if (b > a) abnSec += Math.round((b - a) / 1000);
  });

  return { prepSec, prodSec, abnSec };
}

// 一張工單的實際生產數量（QC 回報）
export function actualQtyOf(o) {
  const step30Sum = (o.stepEntries || [])
    .filter(e => e.stepNo === '30' && e.qcActualQty != null)
    .reduce((s, e) => s + (Number(e.qcActualQty) || 0), 0);
  if (o.step11At && o.step11QcActualQty != null) return step30Sum + (Number(o.step11QcActualQty) || 0);
  const offWork = ((o.pause12 && o.pause12.history) || []).filter(e => e.qcActualQty != null);
  if (offWork.length > 0) return step30Sum + (Number(offWork[offWork.length - 1].qcActualQty) || 0);
  return step30Sum;
}

export const ORDER_NO_RE = /^[A-Z]\d{10}$/;
export const validOrderNo = (s) => typeof s === 'string' && ORDER_NO_RE.test(s);
