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
