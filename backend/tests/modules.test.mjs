// 模組化的煙霧測試:五個模組要能一起掛上、路徑不衝突、requireRole 在註冊期就存在;
// 建標籤走一遍(mock prisma),確認六項文字與對回製造單。執行:node tests/modules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerModules, MODULES } from '../src/modules/index.js';

function mockPrisma(calls) {
  const rec = (model, action) => async (args) => {
    calls.push([model, action, args]);
    if (model === 'label' && action === 'create') {
      return { id: 7, ...args.data, specs: args.data.specs.create.map((s, i) => ({ id: i + 1, ...s })) };
    }
    if (action === 'findMany') return [];
    if (action === 'findFirst' || action === 'findUnique') return null;
    if (action === 'updateMany') return { count: 1 };
    return {};
  };
  return new Proxy({}, {
    get: (_, model) => new Proxy({}, { get: (_, action) => rec(String(model), String(action)) }),
  });
}

async function build(calls) {
  const fastify = Fastify({ logger: false });
  fastify.decorate('prisma', mockPrisma(calls));
  fastify.decorate('authenticate', async (request) => { request.user = { id: 1, displayName: '測試', isAdmin: false, roles: 'sales' }; });
  fastify.decorate('requireAdmin', async () => {});
  fastify.decorate('requireRole', (...roles) => async (request, reply) => {
    const mine = String(request.user?.roles || '').split(',');
    if (!roles.some(r => mine.includes(r))) reply.code(403).send({ error: 'role' });
  });
  fastify.decorate('jwt', { sign: () => 'x' });
  await registerModules(fastify);
  await fastify.ready();
  return fastify;
}

test('五個模組一起掛上,路徑齊全', async () => {
  const f = await build([]);
  const res = await f.inject({ method: 'GET', url: '/api/modules' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().modules.map(m => m.key), ['inventory', 'production', 'cutting', 'shipping']);
  const routes = f.printRoutes({ commonPrefix: false });
  for (const p of ['/api/orders', '/api/labels', '/api/inventory/moves', '/api/cutting/process-orders', '/api/shipping/shipments', '/api/auth/login', '/api/admin/leaders']) {
    assert.ok(routes.includes(p.split('/').pop()), `缺 ${p}`);
  }
  assert.equal(MODULES.length, 5);
  await f.close();
});

test('建標籤:六項文字正確、掛回製造單', async () => {
  const calls = [];
  const f = await build(calls);
  const res = await f.inject({
    method: 'POST', url: '/api/labels',
    payload: { kind: 'finished', customer: '光輝  (北)', poNo: 'PO-12345', manuOrderNo: 'F1150810001', processOrderNo: 'G1150810006',
               location: 'D-C-F123', machineNo: 'No.3', dueDate: '2026.08.12', remark: '需委外鍍鋅與整平',
               specs: [{ spec: "鋁 SKA20-8*4'*1200mm", qty: '100', weight: '860' }] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { label } = res.json();
  assert.match(label.code, /^LB-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(label.qrText, ['光輝  (北)', 'PO-12345', 'F1150810001 , G1150810006', 'D-C-F123 , No.3',
    '2026.08.12 , 需委外鍍鋅與整平', "鋁 SKA20-8*4'*1200mm , 100 , 860"].join('\n'));
  const upd = calls.find(c => c[0] === 'order' && c[1] === 'updateMany');
  assert.ok(upd, '沒有對回製造單');
  assert.equal(upd[2].where.orderNo, 'F1150810001');
  assert.equal(upd[2].data.labelId, 7);
  assert.equal(upd[2].data.poNo, 'PO-12345');
  await f.close();
});

test('角色不符會被擋(倉管專用的出庫 QR 檢核)', async () => {
  const f = await build([]);
  const res = await f.inject({ method: 'POST', url: '/api/shipping/shipments/S1/check', payload: { code: 'LB-1' } });
  assert.equal(res.statusCode, 403);
  await f.close();
});
