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

// 設備「製造參數」是否填寫完整 —— 生產規格完成／生產完成終止的防呆條件
//
// ── 嚴格規則（2026-08 收嚴）必填四項 ──
//   ① 設備參數檔名（製造參數區的那一欄）
//   ② 至少要有一列規格，且【每一列】的 製造規格 / SPM / 刀數 都要有值
//   送料、參數檔案屬性、模具規格、大刀座位置、位置更新頻度 不強制。
//
// 為什麼要收嚴：原本是「九個 base 欄任一有值就放行」，
//   現場只要填了「設備參數檔名」一欄就能結單，SPM／刀數／送料全空照樣過關
//   （實例：F1150810002 只填檔名 46*101.6 就完成了）。等於擋不住真正要擋的事。
//
// ── 不溯及既往 ──
//   生效日之前就開始生產的工單，維持舊的寬鬆規則（任一欄有值即可），
//   免得現有在製工單因為新規則突然結不了單。
//   生效日可用環境變數 MFG_PARAMS_STRICT_FROM 設定（ISO 格式），未設定時用下面的預設值。
//
// 舊資料相容：早期沒有規格表，SPM/刀數存在單值欄位（baseMachineSPM/baseBladeCount）。
//   規格表為空時，比照前端 rtParseSpecRows() 的做法，用單值欄位組成一列來判斷。
const MFG_STRICT_FROM = new Date(
  process.env.MFG_PARAMS_STRICT_FROM || '2026-08-07T00:00:00+08:00'
);

// 這張工單是否適用「嚴格規則」：以實際開始生產日判斷，
// 還沒開工的（actualStartDate 為空）用建立時間；兩者皆無視為新單 → 嚴格。
export function usesStrictMfgParams(order) {
  if (!order) return true;
  const started = order.actualStartDate || order.createdAt;
  if (!started) return true;
  return new Date(started).getTime() >= MFG_STRICT_FROM.getTime();
}

// 舊規則（生效日之前的工單）：九個 base 欄任一有值即可
function hasAnyBaseValue(ep) {
  if (!ep) return false;
  const baseFields = [
    ep.baseProductSpecAttr, ep.baseParamFileName, ep.baseParamFileAttr, ep.baseMoldSpec,
    ep.baseMachineSPM, ep.baseBladeCount, ep.baseFeedSetting, ep.baseCutterStroke, ep.baseStrokeUpdateFreq,
  ];
  if (baseFields.some(v => v != null && String(v).trim() !== '')) return true;
  return parseBaseSpecRows(ep).some(r => r && (
    (r.spec && String(r.spec).trim()) || r.spm != null || r.blades != null || (r.feed && String(r.feed).trim())
  ));
}
export function parseBaseSpecRows(ep) {
  let arr = [];
  if (ep?.baseSpecRows) {
    try { arr = JSON.parse(ep.baseSpecRows) || []; } catch (e) { arr = []; }
  }
  if (!Array.isArray(arr)) arr = [];
  // 舊資料 fallback：規格表空的話，用單值欄位組成一列
  if (arr.length === 0 && ep) {
    const spec = ep.baseProductSpecAttr, spm = ep.baseMachineSPM, blades = ep.baseBladeCount;
    if ((spec != null && String(spec).trim() !== '') || spm != null || blades != null) {
      arr = [{ spec: spec || '', spm, blades }];
    }
  }
  return arr;
}

// 單列是否完整：製造規格、SPM、刀數 三項都要有
export function isSpecRowComplete(r) {
  if (!r) return false;
  const hasSpec = r.spec != null && String(r.spec).trim() !== '';
  const hasSpm = r.spm != null && String(r.spm).trim() !== '';
  const hasBlades = r.blades != null && String(r.blades).trim() !== '';
  return hasSpec && hasSpm && hasBlades;
}

// 回傳缺少的項目（陣列）；全部齊全時回空陣列。供錯誤訊息指出到底缺什麼。
// strict=false 時走舊的寬鬆規則（生效日之前的工單）
export function missingManufacturingParams(ep, strict = true) {
  if (!strict) return hasAnyBaseValue(ep) ? [] : ['設備參數（製造參數完全空白）'];
  const missing = [];
  if (!ep) return ['設備參數（尚未建立）'];
  const fileName = ep.baseParamFileName;
  if (fileName == null || String(fileName).trim() === '') missing.push('設備參數檔名');
  const rows = parseBaseSpecRows(ep);
  if (rows.length === 0) {
    missing.push('製造規格、SPM、刀數（尚未新增任何規格列）');
  } else {
    const bad = [];
    rows.forEach((r, i) => {
      const lack = [];
      if (!(r.spec != null && String(r.spec).trim() !== '')) lack.push('製造規格');
      if (!(r.spm != null && String(r.spm).trim() !== '')) lack.push('SPM');
      if (!(r.blades != null && String(r.blades).trim() !== '')) lack.push('刀數');
      if (lack.length) bad.push(`第${i + 1}列缺 ${lack.join('、')}`);
    });
    if (bad.length) missing.push(bad.join('；'));
  }
  return missing;
}

// 回傳缺項清單（給 API 產生具體錯誤訊息用）
// 傳整個 order 進來，才能依「開始生產日」判斷要套嚴格還是舊規則（不溯及既往）
export async function getMissingManufacturingParams(prisma, order) {
  const ep = await prisma.equipmentParam.findUnique({ where: { orderId: order.id } });
  return missingManufacturingParams(ep, usesStrictMfgParams(order));
}

export async function hasManufacturingParams(prisma, order) {
  return (await getMissingManufacturingParams(prisma, order)).length === 0;
}

// 設備參數「檔名」是否已填 —— 生產完成終止的防呆條件（所有機台）
// 設備參數檔名 = paramFileName（原始）或 baseParamFileName（製造），任一有填即可
export async function hasEquipmentParamFile(prisma, orderId) {
  const ep = await prisma.equipmentParam.findUnique({ where: { orderId } });
  if (!ep) return false;
  return [ep.paramFileName, ep.baseParamFileName].some(v => v != null && String(v).trim() !== '');
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
