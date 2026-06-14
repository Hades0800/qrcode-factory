// 健康檢查 / 診斷 / 維護端點（註冊於根路徑，無 prefix）
export default async function maintenanceRoutes(fastify) {
  // 健康檢查
  fastify.get('/', async () => ({ ok: true, msg: '工單記錄系統 API 運作中' }));
  fastify.get('/health', async () => ({ ok: true }));

  // 診斷端點（僅管理員）
  fastify.get('/diag', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL ? '已設定 (' + process.env.DATABASE_URL.slice(0, 25) + '...)' : '❌ 未設定',
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

  // ── 修正工單日期 ──
  fastify.post('/api/fix-dates', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
  }, async () => {
    const orders = await fastify.prisma.order.findMany({
      include: {
        stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' }, take: 1 },
        pauseEvents: { where: { deletedAt: null }, orderBy: { startAt: 'asc' }, take: 1 },
      },
    });
    let fixed = 0;
    for (const o of orders) {
      const times = [];
      ['step1At','step2At','step3At','step4At','step5At','step6At','step7At','step11At','step21At','step22At','step23At'].forEach(k => {
        if (o[k]) times.push(new Date(o[k]));
      });
      if (o.stepEntries && o.stepEntries.length > 0) times.push(new Date(o.stepEntries[0].recordedAt));
      if (o.pauseEvents && o.pauseEvents.length > 0) times.push(new Date(o.pauseEvents[0].startAt));
      if (times.length === 0) {
        if (o.productionDate) {
          await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: null } });
          fixed++;
        }
        continue;
      }
      const earliest = new Date(Math.min(...times.map(t => t.getTime())));
      const twTime = new Date(earliest.getTime() + 8 * 60 * 60 * 1000);
      const y = twTime.getUTCFullYear(), m = twTime.getUTCMonth(), d = twTime.getUTCDate();
      const correctDate = new Date(Date.UTC(y, m, d));
      const current = o.productionDate ? new Date(o.productionDate).getTime() : null;
      if (current !== correctDate.getTime()) {
        await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: correctDate } });
        fixed++;
      }
    }
    return { ok: true, total: orders.length, fixed };
  });
}
