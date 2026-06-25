import { toTaiwanDate } from '../../lib/date.js';

// 「公司編號」欄格式為「77960005 禾鉅」或「26-62530001+ 毅欣」→ 去掉開頭編號只留客戶名稱
export function stripCustomerCode(s) {
  if (s == null) return null;
  const t = String(s).replace(/^[\d][\d\-+]{4,}\s+/, '').trim();
  return t || null;
}

export function hasActivity(o) {
  return !!(o.step1At || o.step2At || o.step3At || o.step4At ||
    o.step5At || o.step6At || o.step7At || o.step11At ||
    o.step21At || o.step22At || o.step23At);
}

// 設定 actualStartDate 為實際開始日期（台灣時間）
// 規則：actualStartDate 一旦有值就永遠不再覆寫；reset-production 才會清空
// 第一次有活動時（含補登），把那筆活動時間的台灣日期寫入
export async function setActualStartDate(fastify, order, eventTime) {
  if (order.actualStartDate) return; // 已有值，鎖死不再變
  await fastify.prisma.order.update({
    where: { orderNo: order.orderNo },
    data: { actualStartDate: toTaiwanDate(eventTime) },
  });
}

// 設備「製造參數」（base 欄）是否已填寫 —— 生產規格完成／生產完成終止的防呆條件
// 製造參數 = base 單值欄位任一有值，或 baseSpecRows（多規格 SPM/刀數/送料）有內容
export async function hasManufacturingParams(prisma, orderId) {
  const ep = await prisma.equipmentParam.findUnique({ where: { orderId } });
  if (!ep) return false;
  const baseFields = [
    ep.baseProductSpecAttr, ep.baseParamFileName, ep.baseParamFileAttr, ep.baseMoldSpec,
    ep.baseMachineSPM, ep.baseBladeCount, ep.baseFeedSetting, ep.baseCutterStroke, ep.baseStrokeUpdateFreq,
  ];
  if (baseFields.some(v => v != null && String(v).trim() !== '')) return true;
  if (ep.baseSpecRows) {
    try {
      const arr = JSON.parse(ep.baseSpecRows);
      if (Array.isArray(arr) && arr.some(r => r && (
        (r.spec && String(r.spec).trim()) || r.spm != null || r.blades != null || (r.feed && String(r.feed).trim())
      ))) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

// 找出同機台上一張已完成工單的結束時間（step11At）
// 用途：強制下一張工單的第一筆生產時態接續在上一張結束的下一分鐘
export async function getPrevMachineEndAt(prisma, order) {
  if (!order || !order.machineNo) return null;
  const prev = await prisma.order.findFirst({
    where: {
      machineNo: order.machineNo,
      step11At: { not: null },
      id: { not: order.id },
    },
    orderBy: { step11At: 'desc' },
    select: { step11At: true },
  });
  return prev?.step11At || null;
}
