// 健康檢查 / 診斷 / 維護端點（註冊於根路徑，無 prefix）
export default async function maintenanceRoutes(fastify) {
  // 健康檢查
  fastify.get('/', async () => ({ ok: true, msg: '工單記錄系統 API 運作中' }));
  fastify.get('/health', async () => ({ ok: true }));

  // 診斷端點（僅管理員）
  fastify.get('/diag', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL ? '已設定 (' + process.env.DATABASE_URL.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:***@') + ')' : '❌ 未設定',
      JWT_SECRET: process.env.JWT_SECRET ? '已設定' : '❌ 未設定',
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || '❌ 未設定',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? '已設定' : '❌ 未設定',
      ADMIN_NAME: process.env.ADMIN_NAME || '❌ 未設定',
    };
    let dbStatus = 'unknown';
    let dbError = null;
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      dbStatus = '✓ 連線成功';
    } catch (err) {
      dbStatus = '❌ 連線失敗';
      dbError = String(err.message || err);
    }
    let leaderCount = null;
    try { leaderCount = await fastify.prisma.leader.count(); } catch (e) { leaderCount = 'error: ' + e.message; }
    return { env, dbStatus, dbError, leaderCount };
  });
}
