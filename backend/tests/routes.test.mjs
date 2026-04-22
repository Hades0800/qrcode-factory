// 整合測試：用 Fastify inject + mock prisma 驗證 3 條主要路徑
//   1. DELETE /:orderNo（無紀錄）→ 軟刪除成功
//   2. DELETE /:orderNo（有紀錄）→ 回 409 + reset 指引
//   3. POST /:orderNo/reset-production → 清空 stepEntries/pauseEvents（軟刪除）
//   4. POST /:orderNo/restore → 還原工單與子紀錄
// Mock prisma 同時模擬 middleware 行為（findUnique→findFirst+過濾、delete→update、deleteMany→updateMany）

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import orderRoutes from '../src/routes/orders.js';

// ────────────────────────────────────────────────────
// Mock prisma（狀態 + middleware 模擬）
// ────────────────────────────────────────────────────
function makeMockPrisma() {
  const state = {
    orders: new Map(),        // orderNo → row
    stepEntries: new Map(),   // id → row
    pauseEvents: new Map(),   // id → row
    auditLogs: [],
    _nextStepEntryId: 1,
    _nextPauseEventId: 1,
    _nextOrderId: 1,
  };

  // 工具：where 是否過濾軟刪除（即 deletedAt: null）
  const filterDeleted = (rows, where) => {
    if (!where) return rows;
    return rows.filter(r => {
      for (const [k, v] of Object.entries(where)) {
        if (k === 'deletedAt') {
          // middleware 可能注入 deletedAt: null；逃生口傳 undefined；查 trash 傳 { not: null }
          if (v === null) {
            if (r.deletedAt) return false;
          } else if (v === undefined) {
            // 不過濾
          } else if (typeof v === 'object' && v !== null && 'not' in v) {
            if (v.not === null && !r.deletedAt) return false;
          }
        } else if (k === 'OR' || k === 'AND' || k === 'NOT' || k === 'in') {
          // 不需支援複雜條件
        } else {
          if (r[k] !== v) return false;
        }
      }
      return true;
    });
  };

  // 模擬 middleware 的 auto-inject：若 where 沒有 deletedAt key，注入 deletedAt: null
  const injectSoftDelete = (where) => {
    const w = where ? { ...where } : {};
    if (!('deletedAt' in w)) w.deletedAt = null;
    return w;
  };

  const order = {
    findUnique: async ({ where }) => {
      // middleware 會改成 findFirst + 自動加 deletedAt:null（除非 caller 顯式指定）
      const rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      return rows[0] || null;
    },
    findFirst: async ({ where }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      return rows[0] || null;
    },
    findMany: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)),
    count: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)).length,
    create: async ({ data }) => {
      const row = { id: state._nextOrderId++, ...data, deletedAt: null };
      state.orders.set(data.orderNo, row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = state.orders.get(where.orderNo) || [...state.orders.values()].find(r => r.id === where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      return row;
    },
    // delete 會被 middleware 改成 update + data.deletedAt
    // 但在 mock 測試中，route handler 呼叫 prisma.order.delete()，
    // 這裡直接模擬 middleware 的改寫效果：把 deletedAt 設為現在
    delete: async ({ where }) => {
      const row = state.orders.get(where.orderNo) || [...state.orders.values()].find(r => r.id === where.id);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), where);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };

  const makeChildModel = (map, nextIdField) => ({
    findMany: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)),
    count: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)).length,
    create: async ({ data }) => {
      const id = state[nextIdField]++;
      const row = { id, ...data, deletedAt: null };
      map.set(id, row);
      return row;
    },
    delete: async ({ where }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
    deleteMany: async ({ where }) => {
      // 模擬 middleware: deleteMany → updateMany + deletedAt=now
      const rows = filterDeleted(Array.from(map.values()), { ...where, deletedAt: null });
      const now = new Date();
      for (const r of rows) r.deletedAt = now;
      return { count: rows.length };
    },
    updateMany: async ({ where, data }) => {
      const rows = filterDeleted(Array.from(map.values()), where);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  });

  const prisma = {
    order,
    stepEntry: makeChildModel(state.stepEntries, '_nextStepEntryId'),
    pauseEvent: makeChildModel(state.pauseEvents, '_nextPauseEventId'),
    auditLog: {
      create: async ({ data }) => { state.auditLogs.push(data); return data; },
    },
  };

  return { prisma, state };
}

// ────────────────────────────────────────────────────
// Build test fastify（mock auth + mock prisma）
// ────────────────────────────────────────────────────
async function buildApp(user) {
  const fastify = Fastify({ logger: false });
  const { prisma, state } = makeMockPrisma();
  fastify.decorate('prisma', prisma);
  fastify.decorate('authenticate', async (request) => {
    request.user = user;
  });
  fastify.decorate('requireAdmin', async (request, reply) => {
    if (!request.user?.isAdmin) reply.code(403).send({ error: '需要管理員權限' });
  });
  await fastify.register(orderRoutes, { prefix: '/api/orders' });
  await fastify.ready();
  return { fastify, state };
}

const ADMIN = { id: 1, username: 'admin', displayName: '管理員', isAdmin: true, isPlanner: false };
const PLANNER = { id: 2, username: 'planner', displayName: '生管', isAdmin: false, isPlanner: true };

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('✓', name); pass++; }
  catch (e) { console.error('✗', name, '\n    ', e.message); fail++; }
}

// ────────────────────────────────────────────────────
// 測試案例
// ────────────────────────────────────────────────────

await test('DELETE /:orderNo（無紀錄）→ 200 + 軟刪除成功', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000001' } });
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/A0000000001' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.deleted, true);
  const order = state.orders.get('A0000000001');
  assert.ok(order.deletedAt, '工單應已被軟刪除');
  assert.equal(state.auditLogs[0].action, 'delete_order');
  await fastify.close();
});

await test('DELETE /:orderNo（有 stepEntries）→ 409 + HAS_PRODUCTION_DATA', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'A0000000002' } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/A0000000002' });
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.code, 'HAS_PRODUCTION_DATA');
  assert.equal(body.entryCount, 1);
  assert.equal(body.pauseCount, 0);
  assert.equal(body.canReset, false, 'Planner 不能 reset');
  const stored = state.orders.get('A0000000002');
  assert.equal(stored.deletedAt, null, '工單不應被動到');
  await fastify.close();
});

await test('DELETE /:orderNo（Admin, 有紀錄）→ 409 + canReset=true', async () => {
  const { fastify } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'A0000000003' } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: order.id, type: '12', startAt: new Date() } });
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/A0000000003' });
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.canReset, true);
  assert.equal(body.entryCount, 1);
  assert.equal(body.pauseCount, 1);
  await fastify.close();
});

await test('POST /:orderNo/reset-production（Admin）→ 軟刪除子紀錄，保留工單', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'A0000000004', step1At: new Date(), productSpec: 'SPEC-X', machineNo: 'No1-350' },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '2', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: order.id, type: '12', startAt: new Date() } });

  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000004/reset-production' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.reset, true);
  assert.equal(body.entryCount, 2);
  assert.equal(body.pauseCount, 1);

  const stored = state.orders.get('A0000000004');
  assert.equal(stored.deletedAt, null, '工單本身保留（不該被軟刪）');
  assert.equal(stored.step1At, null, 'step1At 應被清空');
  assert.equal(stored.machineNo, null, 'machineNo 應被清空');
  assert.equal(stored.productSpec, 'SPEC-X', '上傳欄位應保留');

  const entries = Array.from(state.stepEntries.values());
  assert.equal(entries.length, 2, 'DB 內仍有紀錄（只是被軟刪）');
  assert.ok(entries.every(e => e.deletedAt), '所有 stepEntries 應被軟刪除');
  const pauses = Array.from(state.pauseEvents.values());
  assert.ok(pauses.every(p => p.deletedAt), '所有 pauseEvents 應被軟刪除');

  assert.equal(state.auditLogs[0].action, 'reset_production');
  await fastify.close();
});

await test('POST /:orderNo/reset-production（Planner）→ 403', async () => {
  const { fastify } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000005' } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000005/reset-production' });
  assert.equal(res.statusCode, 403);
  await fastify.close();
});

await test('POST /:orderNo/restore（Admin）→ 還原工單與子紀錄', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'A0000000006' } });
  // 模擬先軟刪除：工單 + 2 個子紀錄
  const t = new Date();
  state.orders.get('A0000000006').deletedAt = t;
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '2', seq: 1, recordedAt: new Date() } });
  Array.from(state.stepEntries.values()).forEach(e => e.deletedAt = t);

  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000006/restore' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.restored, true);
  assert.equal(body.entries, 2);

  const stored = state.orders.get('A0000000006');
  assert.equal(stored.deletedAt, null, '工單應被還原');
  const entries = Array.from(state.stepEntries.values());
  assert.ok(entries.every(e => e.deletedAt === null), '子紀錄應被還原');
  assert.equal(state.auditLogs[0].action, 'restore_order');
  await fastify.close();
});

await test('POST /:orderNo/restore（Planner）→ 403', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000007' } });
  state.orders.get('A0000000007').deletedAt = new Date();
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000007/restore' });
  assert.equal(res.statusCode, 403);
  await fastify.close();
});

await test('POST /:orderNo/restore（未刪除的工單）→ 400', async () => {
  const { fastify } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000008' } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000008/restore' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /並未被刪除/);
  await fastify.close();
});

await test('GET /trash（Admin）→ 只列軟刪除的工單', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000010' } });
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000011' } });
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000012' } });
  // 只刪其中兩張
  state.orders.get('A0000000010').deletedAt = new Date();
  state.orders.get('A0000000012').deletedAt = new Date();
  const res = await fastify.inject({ method: 'GET', url: '/api/orders/trash' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.orders.length, 2, '應只回 2 張已刪除的工單');
  const nos = body.orders.map(o => o.orderNo).sort();
  assert.deepEqual(nos, ['A0000000010', 'A0000000012']);
  await fastify.close();
});

await test('GET /trash（Planner）→ 403', async () => {
  const { fastify } = await buildApp(PLANNER);
  const res = await fastify.inject({ method: 'GET', url: '/api/orders/trash' });
  assert.equal(res.statusCode, 403);
  await fastify.close();
});

await test('GET /trash（沒有已刪除工單）→ 200 + orders=[]', async () => {
  const { fastify } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000013' } });
  const res = await fastify.inject({ method: 'GET', url: '/api/orders/trash' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.orders, []);
  await fastify.close();
});

await test('bulk-cancel-upload：有 stepEntries 的工單不該被誤刪（regression）', async () => {
  // 情境：生管上傳工單後，班長已用新格式（stepEntries）紀錄，接著生管按取消批次
  // 舊 bug：hasActivity 只看 stepXAt，誤判「沒活動」→ 軟刪整張工單
  // 修法：改用 hasAnyActivity 同時查 stepEntries / pauseEvents
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'B0000000001', productSpec: 'ORIG-SPEC' },
  });
  // 班長用新格式記過工序，stepXAt 全是 null
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-cancel-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orderNos: ['B0000000001'] }),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.deleted, 0, '不該被刪除');
  assert.equal(body.cleared, 1, '應只清上傳欄位');
  const stored = state.orders.get('B0000000001');
  assert.equal(stored.deletedAt, null, '工單不該被軟刪除');
  assert.equal(stored.productSpec, null, 'productSpec 應被清空');
  // stepEntry 不受影響
  const entries = Array.from(state.stepEntries.values());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].deletedAt, null, 'stepEntry 不該被動到');
  await fastify.close();
});

await test('bulk-cancel-upload：有 pauseEvents 的工單也不該被誤刪', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'B0000000002' } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: order.id, type: '12', startAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-cancel-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orderNos: ['B0000000002'] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).deleted, 0);
  assert.equal(state.orders.get('B0000000002').deletedAt, null);
  await fastify.close();
});

await test('bulk-cancel-upload：真正沒紀錄的工單會被刪掉（維持原行為）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'B0000000003' } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-cancel-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orderNos: ['B0000000003'] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).deleted, 1);
  assert.ok(state.orders.get('B0000000003').deletedAt, '真空工單應被軟刪');
  await fastify.close();
});

await test('刪除後再 DELETE → 404（軟刪除的工單不該被找到）', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000009' } });
  state.orders.get('A0000000009').deletedAt = new Date();
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/A0000000009' });
  assert.equal(res.statusCode, 404);
  await fastify.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
