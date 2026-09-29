// 生產 MES 系統(關聯圖左下):現有的工單工序紀錄整個歸在這裡,API 路徑不變。
// 對照關聯表:製造單上傳(業務助理)、每周生產計畫上傳(生管)、生產工單完成→再製 QR(生產人員)。
import orderRoutes from './routes/orders.js';
import equipmentParamRoutes from './routes/equipmentParams.js';
import idleEventRoutes from './routes/idleEvents.js';

export const meta = { key: 'production', name: '生產 MES 系統', description: '製造單、每周生產計畫、工序與暫停紀錄、設備參數、無工令' };

export default async function productionModule(fastify) {
  await fastify.register(orderRoutes, { prefix: '/api/orders' });
  await fastify.register(equipmentParamRoutes, { prefix: '/api/equipment-params' });
  await fastify.register(idleEventRoutes);   // /api/idle-events
}
