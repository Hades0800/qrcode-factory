// 共用層:帳號 / 稽核 / 維護。不是關聯圖上的四個系統之一,四個系統都靠它登入與留紀錄。
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import maintenanceRoutes from './routes/maintenance.js';

export const meta = { key: 'core', name: '共用層', description: '登入、帳號與角色、稽核紀錄、維護端點' };

export default async function coreModule(fastify) {
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(adminRoutes, { prefix: '/api/admin' });
  await fastify.register(maintenanceRoutes); // /、/health、/diag、/api/fix-dates
}
