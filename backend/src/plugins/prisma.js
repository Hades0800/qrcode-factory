import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// ─── 軟刪除中間件 ─────────────────────────────────
// 對指定 model 自動套用：
//   1. find*/count/aggregate/groupBy 預設加上 deletedAt: null 過濾
//   2. delete / deleteMany 改寫為 update / updateMany，設定 deletedAt = 當下時間
// 逃生口：caller 在 where 內明確指定 deletedAt（即使是 undefined）即可跳過自動過濾，
//        用於「查含已刪除」或「restore 前 lookup」等場景。
// 注意：nested include 不會進 middleware，必須在 include 內手動加 where: { deletedAt: null }
const SOFT_DELETE_MODELS = new Set(['Order', 'Leader', 'IdleEvent', 'StepEntry', 'PauseEvent']);
prisma.$use(async (params, next) => {
  if (!SOFT_DELETE_MODELS.has(params.model)) return next(params);

  if (params.action === 'findUnique' || params.action === 'findFirst') {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      if (params.action === 'findUnique') params.action = 'findFirst';
      params.args.where.deletedAt = null;
    }
  } else if (
    params.action === 'findMany' ||
    params.action === 'count' ||
    params.action === 'aggregate' ||
    params.action === 'groupBy'
  ) {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      params.args.where.deletedAt = null;
    }
  } else if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deletedAt: new Date() };
  } else if (params.action === 'deleteMany') {
    params.action = 'updateMany';
    params.args = params.args || {};
    params.args.data = { ...(params.args.data || {}), deletedAt: new Date() };
  }

  return next(params);
});
