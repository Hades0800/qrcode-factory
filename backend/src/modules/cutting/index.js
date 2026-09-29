// 加工裁切 MES 系統(關聯圖右下):加工單 G 號綁定製造單 F 號,裁切完成即「QR Code 結案」,
// 成品回到入出庫系統。對照關聯表:製造加工單上傳(業務助理)、每周生產計畫(生管)、裁切工單完成(加工人員)。
import processOrderRoutes from './routes/processOrders.js';

export const meta = { key: 'cutting', name: '裁切 MES 系統', description: '加工單(G 號)、綁定製造單、裁切工序、結案入庫' };

export default async function cuttingModule(fastify) {
  await fastify.register(processOrderRoutes, { prefix: '/api/cutting' });
}
