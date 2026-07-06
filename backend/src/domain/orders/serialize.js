import { getPrevMachineEndAt } from './helpers.js';

// 工序代碼 → 工單欄位對應（時間欄 / 備註欄）
export const STEP_COLS = {
  '21': { time: 'step21At', note: null },
  '22': { time: 'step22At', note: null },
  '23': { time: 'step23At', note: null },
  '1':  { time: 'step1At',  note: null },
  '2':  { time: 'step2At',  note: null },
  '3':  { time: 'step3At',  note: null },
  '4':  { time: 'step4At',  note: null },
  '5':  { time: 'step5At',  note: null },
  '6':  { time: 'step6At',  note: null },
  '7':  { time: 'step7At',  note: null },
  '11': { time: 'step11At', note: 'step11Note' },
  '12': { time: 'step12At', note: 'step12Note' },
  '13': { time: 'step13At', note: 'step13Note' },
};

// Prisma include：工單帶出 leader / 未刪除的 pauseEvents / 未刪除的 stepEntries
export const ORDER_INCLUDE = {
  leader: true,
  pauseEvents: { where: { deletedAt: null } },
  stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' } },
};

export function serializeOrder(o) {
  if (!o) return null;
  const events = o.pauseEvents || [];
  const summarize = (type) => {
    const items = events.filter(e => e.type === type);
    const closed = items.filter(e => e.endAt);
    const active = items.find(e => !e.endAt) || null;
    return {
      count: closed.length,
      totalSec: closed.reduce((s, e) => s + (e.duration || 0), 0),
      active: active ? { id: active.id, startAt: active.startAt, note: active.note, activeStep: active.activeStep } : null,
      history: items.map(e => ({
        id: e.id, activeStep: e.activeStep, startAt: e.startAt, endAt: e.endAt,
        duration: e.duration, note: e.note, qcActualQty: e.qcActualQty ?? null,
      })),
    };
  };
  return {
    orderNo: o.orderNo,
    machineNo: o.machineNo || '',
    plannedMachineNo: o.plannedMachineNo || '',
    leaderId: o.leaderId,
    leaderName: o.leader?.displayName || '',
    step21At: o.step21At, step22At: o.step22At, step23At: o.step23At,
    step1At: o.step1At, step2At: o.step2At, step3At: o.step3At,
    step4At: o.step4At, step5At: o.step5At, step6At: o.step6At,
    step7At: o.step7At, step11At: o.step11At, step11Note: o.step11Note || null,
    step11QcActualQty: o.step11QcActualQty ?? null,
    // 三個日期：
    //   plannedDate     = 上傳的計畫日（生管說「這張要 X 做」）
    //   actualStartDate = 第一筆活動的台灣日期（現場第一次掃 QR 那天）
    //   productionDate  = 兼容舊邏輯，等同於 actualStartDate || plannedDate
    plannedDate: o.plannedDate || o.productionDate || null,
    planSeq: o.planSeq != null ? o.planSeq : null, // 計畫序號：同一天排序用（生管 Excel 列順序）
    actualStartDate: o.actualStartDate || null,
    productionDate: o.actualStartDate || o.plannedDate || o.productionDate || null,
    specType: o.specType || null,           // 'new' | 'mass' | null
    difficultyFactor: o.difficultyFactor || null,  // 新製規格才有
    // 新製規格的差異項目陣列：['raw','mold','dim'] 之子集合（由逗號字串解析）
    newSpecAspects: o.newSpecAspects ? String(o.newSpecAspects).split(',').filter(Boolean) : [],
    changeScope: o.changeScope || null,      // '@' | '#' | '@#' | null
    materialType: o.materialType || null,    // 'coil'(1.0) | 'plate'(1.2) | null
    auxEquipment: o.auxEquipment || null,           // 逗號字串（flat/leveler/...，可多選）
    auxEquipmentCustom: o.auxEquipmentCustom || null,// 自訂輔助設備名稱
    auxEquipmentNos: (() => { try { return o.auxEquipmentNos ? JSON.parse(o.auxEquipmentNos) : {}; } catch (e) { return {}; } })(), // 代碼→編號
    operatorName: o.operatorName || null,           // 設備操作人員姓名（第五步）
    totalWorkers: (o.totalWorkers ?? null),         // 全部作業人數（第五步）
    productSpec: o.productSpec || '',
    customerName: o.customerName || '',
    moldSpec: o.moldSpec || '', material: o.material || '',
    dispatchQty: o.dispatchQty, bladeCount: o.bladeCount,
    machineSPM: o.machineSPM, unitWeight: o.unitWeight, totalWeight: o.totalWeight,
    pause12: summarize('12'),
    pause13: summarize('13'),
    stepEntries: (o.stepEntries || []).map(e => ({
      id: e.id, stepNo: e.stepNo, seq: e.seq,
      recordedAt: e.recordedAt, isManual: e.isManual || false,
      note: e.note || null,
      qcActualQty: e.qcActualQty ?? null,
      leaderName: e.leaderName,
    })),
    // 同機台上一張已完成工單的結束時間（強制接續用；由 caller 預先附上）
    prevMachineEndAt: o.prevMachineEndAt || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

// 序列化工單並附上「上一張同機台完成時間」— 避免每個 endpoint 都要寫兩行
export async function serializeWithPrev(prisma, order) {
  if (!order) return null;
  order.prevMachineEndAt = await getPrevMachineEndAt(prisma, order);
  return serializeOrder(order);
}
