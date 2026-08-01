import { prisma } from '../plugins/prisma.js';

// 一次性遷移：把舊的 isAdmin / isPlanner 布林欄轉成 Leader.roles 逗號字串
//   isAdmin + isPlanner → 'admin,pm' ／ isAdmin → 'admin' ／ isPlanner → 'pm' ／ 都沒有 → 'qc'
// 冪等：已經有 roles 的不動；轉完把兩個舊布林欄 drop 掉。
// 失敗只警告不中斷，避免 server 起不來。
export async function ensureRolesColumn() {
  if (!process.env.DATABASE_URL) return;
  try {
    // 1. 加上 roles 欄位（若還沒有）
    await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" ADD COLUMN IF NOT EXISTS "roles" TEXT`);

    // 2. 看 isAdmin / isPlanner 還在不在
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Leader'
    `);
    const colSet = new Set((cols || []).map(c => c.column_name));
    const hasIsAdmin = colSet.has('isAdmin');
    const hasIsPlanner = colSet.has('isPlanner');

    // 3. 把 boolean 欄轉成 roles 字串（只填空值，已遷移過的不動）
    if (hasIsAdmin || hasIsPlanner) {
      const adminExpr = hasIsAdmin ? '"isAdmin"' : 'FALSE';
      const plannerExpr = hasIsPlanner ? '"isPlanner"' : 'FALSE';
      await prisma.$executeRawUnsafe(`
        UPDATE "Leader" SET "roles" = (
          CASE
            WHEN ${adminExpr} = true AND ${plannerExpr} = true THEN 'admin,pm'
            WHEN ${adminExpr} = true THEN 'admin'
            WHEN ${plannerExpr} = true THEN 'pm'
            ELSE 'qc'
          END
        ) WHERE "roles" IS NULL OR "roles" = ''
      `);
      if (hasIsAdmin) await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" DROP COLUMN IF EXISTS "isAdmin"`);
      if (hasIsPlanner) await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" DROP COLUMN IF EXISTS "isPlanner"`);
      console.log('✓ Leader.roles 遷移完成（舊 isAdmin/isPlanner 已 drop）');
    }

    // 4. 兜底：任何還是 NULL 的設成預設 'qc'
    await prisma.$executeRawUnsafe(`UPDATE "Leader" SET "roles" = 'qc' WHERE "roles" IS NULL OR "roles" = ''`);
  } catch (err) {
    console.error('⚠️ ensureRolesColumn 失敗，但 server 仍會啟動：', err.message);
  }
}
