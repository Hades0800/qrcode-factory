// 入出庫紀錄與庫存彙總。裁切結案入庫、出貨出庫都走 recordMove,不要各自寫 stockMove。
import { STAGES } from './label.js';

export function validStage(s) { return typeof s === 'string' && s in STAGES; }

export async function recordMove(prisma, { label, type, stage, location, qty, weight, refType, refNo, note, actor }) {
  const move = await prisma.stockMove.create({
    data: {
      labelId: label.id,
      type, stage,
      location: location || label.location || null,
      qty: qty ?? null,
      weight: weight ?? null,
      refType: refType || null,
      refNo: refNo || null,
      note: note ? String(note).slice(0, 300) : null,
      actorId: actor?.id ?? null,
      actorName: actor?.displayName ?? null,
    },
  });
  // 入庫到新儲位:標籤跟著更新,下次出庫就知道從哪拿
  if (type === 'in' && location && location !== label.location) {
    await prisma.label.update({ where: { id: label.id }, data: { location } });
  }
  return move;
}

// 一張標籤目前的庫存:入庫加、出庫減。沒有任何紀錄回 null(分得出「沒入過庫」與「庫存 0」)
export function summarize(moves) {
  if (!moves.length) return null;
  let qty = 0, weight = 0, lastAt = null;
  for (const m of moves) {
    const sign = m.type === 'out' ? -1 : 1;
    qty += sign * (m.qty || 0);
    weight += sign * (m.weight || 0);
    if (!lastAt || m.at > lastAt) lastAt = m.at;
  }
  return { qty, weight: Math.round(weight * 100) / 100, lastAt };
}

export async function stockOf(prisma, labelId) {
  const moves = await prisma.stockMove.findMany({ where: { labelId } });
  return summarize(moves);
}
