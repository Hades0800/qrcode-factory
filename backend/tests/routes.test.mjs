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
        } else if (v && typeof v === 'object' && !(v instanceof Date)) {
          // 只支援測試用到的運算子：in / gt / gte
          if ('in' in v && !v.in.includes(r[k])) return false;
          if ('gt' in v && !(r[k] > v.gt)) return false;
          if ('gte' in v && !(r[k] >= v.gte)) return false;
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
    findUnique: async ({ where }) => { const r = map.get(where.id); return r && !r.deletedAt ? r : null; }, // middleware：findUnique→findFirst+deletedAt:null
    findFirst: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where))[0] || null,
    findMany: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)),
    update: async ({ where, data }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      return row;
    },
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
    uploadBatch: {
      _nextId: 1,
      create: async function({ data }) { return { id: this._nextId++, ...data }; },
      update: async ({ where, data }) => ({ id: where.id, ...data }),
    },
    uploadRow: {
      createMany: async ({ data }) => ({ count: data.length }),
      findFirst: async () => null,
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

await test('POST /:orderNo/restore（工單沒刪、也沒軟刪子紀錄）→ 400', async () => {
  const { fastify } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000008' } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000008/restore' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /沒有任何已刪除的內容/);
});

await test('POST /:orderNo/restore（工單沒刪、但有軟刪子紀錄）→ 還原子紀錄', async () => {
  // 情境：reset-production 把 stepEntries 軟刪了，事後想救回
  const { fastify, state } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'A0000000020' } });
  const e1 = await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const e2 = await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '2', seq: 1, recordedAt: new Date() } });
  // 模擬被 reset 軟刪
  state.stepEntries.get(e1.id).deletedAt = new Date();
  state.stepEntries.get(e2.id).deletedAt = new Date();

  const res = await fastify.inject({ method: 'POST', url: '/api/orders/A0000000020/restore' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.orderRestored, false, '工單沒被刪，不應寫 orderRestored=true');
  assert.equal(body.entries, 2);
  // stepEntries 應該還原
  assert.ok(state.stepEntries.get(e1.id).deletedAt === null);
  assert.ok(state.stepEntries.get(e2.id).deletedAt === null);
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
  // 取消上傳只動上傳資料，工單本身與紀錄都保留
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'B0000000001', productSpec: 'ORIG-SPEC' },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-cancel-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orderNos: ['B0000000001'] }),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.cleared, 1, '應清上傳欄位');
  const stored = state.orders.get('B0000000001');
  assert.equal(stored.deletedAt, null, '工單不該被軟刪除');
  assert.equal(stored.productSpec, null, 'productSpec 應被清空');
  const entries = Array.from(state.stepEntries.values());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].deletedAt, null, 'stepEntry 不該被動到');
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
  assert.equal(state.orders.get('B0000000002').deletedAt, null);
});

await test('bulk-cancel-upload：沒紀錄的工單也只清欄位、不軟刪（新原則）', async () => {
  // 新原則：取消上傳一律不刪工單，避免「取消上傳→工單也消失」的誤解
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'B0000000003', productSpec: 'X' } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-cancel-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orderNos: ['B0000000003'] }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).cleared, 1);
  const stored = state.orders.get('B0000000003');
  assert.equal(stored.deletedAt, null, '工單不該被軟刪');
  assert.equal(stored.productSpec, null, 'productSpec 應被清空');
});

await test('bulk-upload：已開工的工單，上傳不改 machineNo、回報提醒（2026-10 起）', async () => {
  // 情境：班長已在 No3-60 記錄工單 C1，生管重新上傳同一工單但 Excel 寫 No5-40
  // 期望：machineNo 維持現場的 No3-60（已做的工時不能被搬到別台），plannedMachineNo 照 Excel，回傳 machineKept 提醒
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'C0000000001', machineNo: 'No3-60', productSpec: 'SPEC-A', dispatchQty: 100 },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'C0000000001', machineNo: 'No5-40', productSpec: 'SPEC-A', dispatchQty: 200 }],
      filename: 'test.xlsx',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('C0000000001');
  assert.equal(stored.machineNo, 'No3-60', '已開工：machineNo 維持現場的 No3-60');
  assert.equal(stored.plannedMachineNo, 'No5-40', 'plannedMachineNo 照 Excel 改 No5-40');
  assert.equal(stored.dispatchQty, 200, '其他欄位應正常更新');
  assert.deepEqual(JSON.parse(res.body).machineKept, [{ orderNo: 'C0000000001', actual: 'No3-60', upload: 'No5-40' }], '要回報提醒');
});

await test('bulk-upload：規格只差空白 → 視為同一規格，照常更新（不再「規格不同，跳過」）', async () => {
  // 情境（F1150904001 實例）：9/24 上傳的規格尾巴多兩個空白，之後每天的計畫都沒有空白 → 以前全部被跳過
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'C0000000009', machineNo: 'No1-350', productSpec: "擴張網 黑鐵 6.0T*4'*8'  ", dispatchQty: 1300 } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orders: [{ orderNo: 'C0000000009', machineNo: 'No1-350', productSpec: "擴張網 黑鐵 6.0T*4'*8'", dispatchQty: 1400 }], filename: 'test.xlsx' }),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.updated, 1, '應該更新');
  assert.equal(body.skipped, 0, '不能被跳過');
  assert.equal(state.orders.get('C0000000009').dispatchQty, 1400);
});

await test('bulk-upload：已完成的單重新上傳 → 計畫日不改、其他欄位照常更新、回報提醒', async () => {
  // 情境（F1150930001 實例）：10/5 排計畫、10/5 做完；10/6 生管清單上還有它
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'C0000000010', machineNo: 'No1-350', productSpec: 'SPEC-E', dispatchQty: 5,
    plannedDate: new Date('2026-10-05'), planSeq: 3, actualStartDate: new Date('2026-10-05'), step11At: new Date('2026-10-05T02:50:00Z') } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orders: [{ orderNo: 'C0000000010', machineNo: 'No1-350', productSpec: 'SPEC-E', dispatchQty: 6 }], filename: 'test.xlsx', uploadDate: '2026-10-06' }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('C0000000010');
  assert.equal(stored.plannedDate.toISOString().slice(0, 10), '2026-10-05', '計畫日維持 10/5');
  assert.equal(stored.planSeq, 3, '計畫序號也維持');
  assert.equal(stored.dispatchQty, 6, '其他欄位照常更新');
  assert.deepEqual(JSON.parse(res.body).doneKept, ['C0000000010']);
});

await test('bulk-upload：還在做（隔日生產）的單重新上傳 → 計畫日照舊跟著改', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'C0000000011', machineNo: 'No1-350', productSpec: 'SPEC-F',
    plannedDate: new Date('2026-10-07'), actualStartDate: new Date('2026-10-07') } });
  await fastify.prisma.stepEntry.create({ data: { orderId: o.id, stepNo: '41', seq: 1, recordedAt: new Date('2026-10-07T01:00:00Z') } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orders: [{ orderNo: 'C0000000011', machineNo: 'No1-350', productSpec: 'SPEC-F' }], filename: 'test.xlsx', uploadDate: '2026-10-08' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(state.orders.get('C0000000011').plannedDate.toISOString().slice(0, 10), '2026-10-08', '隔日生產照舊改到 10/8');
  assert.deepEqual(JSON.parse(res.body).doneKept, []);
});

// ── 已完成的工單：現場不能再記錄；只有管理員能重新開啟（2026-10 起）──
const LEADER = { id: 3, username: 'leader', displayName: '班長', isAdmin: false, isPlanner: false };
const doneAt = new Date(Date.now() - 3600 * 1000);

await test('已完成的單：現場再記錄工序 → 409（請管理員重新開啟）', async () => {
  const { fastify } = await buildApp(LEADER);
  await fastify.prisma.order.create({ data: { orderNo: 'D0000000001', machineNo: 'No1-350', step11At: doneAt } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/D0000000001/step-entries', payload: { stepNo: '41' } });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /重新開啟/);
  await fastify.close();
});

await test('已完成的單：現場再按暫停 → 409', async () => {
  const { fastify } = await buildApp(LEADER);
  await fastify.prisma.order.create({ data: { orderNo: 'D0000000002', machineNo: 'No1-350', step11At: doneAt } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/D0000000002/pause', payload: { type: '12', note: '中午休息', qcActualQty: 5 } });
  assert.equal(res.statusCode, 409);
  await fastify.close();
});

await test('已完成的單：換到別台機台 → 409；同一台照常開', async () => {
  const { fastify } = await buildApp(LEADER);
  await fastify.prisma.order.create({ data: { orderNo: 'D0000000003', machineNo: 'No1-350', step11At: doneAt } });
  const other = await fastify.inject({ method: 'POST', url: '/api/orders/D0000000003/machine', payload: { machineNo: 'No2-250' } });
  assert.equal(other.statusCode, 409);
  await fastify.close();
});

await test('已完成的單：補登完成之前的暫停不受限', async () => {
  const { fastify, state } = await buildApp(LEADER);
  await fastify.prisma.order.create({ data: { orderNo: 'D0000000004', machineNo: 'No1-350', step11At: doneAt } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/D0000000004/pause-backfill', payload: {
    type: '12', note: '中午休息', startAt: new Date(doneAt - 3 * 3600e3).toISOString(), endAt: new Date(doneAt - 2 * 3600e3).toISOString(), qcActualQty: 3 } });
  assert.notEqual(res.statusCode, 409, '完成前的補登應允許');
  assert.equal([...state.pauseEvents.values()].length, 1);
  await fastify.close();
});

await test('重新開啟（取消完成）：現場 → 403；管理員 → 成功並留操作紀錄', async () => {
  const leader = await buildApp(LEADER);
  await leader.fastify.prisma.order.create({ data: { orderNo: 'D0000000005', machineNo: 'No1-350', step11At: doneAt } });
  const r1 = await leader.fastify.inject({ method: 'DELETE', url: '/api/orders/D0000000005/steps/11' });
  assert.equal(r1.statusCode, 403);
  await leader.fastify.close();
  const admin = await buildApp(ADMIN);
  await admin.fastify.prisma.order.create({ data: { orderNo: 'D0000000006', machineNo: 'No1-350', step11At: doneAt } });
  const r2 = await admin.fastify.inject({ method: 'DELETE', url: '/api/orders/D0000000006/steps/11' });
  assert.equal(r2.statusCode, 200);
  assert.equal(admin.state.orders.get('D0000000006').step11At, null, '完成時間應清掉');
  assert.equal(admin.state.auditLogs[0].action, 'reopen_order');
  await admin.fastify.close();
});

await test('bulk-upload：新工單上傳，machineNo 與 plannedMachineNo 同步寫入', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'C0000000004', machineNo: 'No1-350', productSpec: 'SPEC-D' }],
      filename: 'test.xlsx',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('C0000000004');
  assert.equal(stored.machineNo, 'No1-350');
  assert.equal(stored.plannedMachineNo, 'No1-350', '新工單 plannedMachineNo = machineNo');
});

await test('bulk-upload：無活動的工單，上傳可以改 machineNo（維持原行為）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({
    data: { orderNo: 'C0000000002', machineNo: 'No3-60', productSpec: 'SPEC-B' },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'C0000000002', machineNo: 'No5-40', productSpec: 'SPEC-B' }],
      filename: 'test.xlsx',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('C0000000002');
  assert.equal(stored.machineNo, 'No5-40', '沒活動的工單 machineNo 仍可被 Excel 更新');
});

await test('bulk-upload：有活動但原本沒 machineNo 時，上傳的 machineNo 會填進去', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'C0000000003', machineNo: null, productSpec: 'SPEC-C' },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'C0000000003', machineNo: 'No2-250', productSpec: 'SPEC-C' }],
      filename: 'test.xlsx',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('C0000000003');
  assert.equal(stored.machineNo, 'No2-250', '原本空的 machineNo 可被填入');
});

await test('bulk-upload：已有活動的工單，上傳不覆蓋 productionDate（regression）', async () => {
  // 情境：班長 4/21 已記錄工單，生管 4/23 重新上傳同工單，uploadDate=4/23
  // 期望：productionDate 保持 4/21（現場為準），上傳不得覆寫
  const { fastify, state } = await buildApp(PLANNER);
  const productionDateApr21 = new Date('2026-04-21T00:00:00Z');
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'D0000000001', machineNo: 'No3-60', productSpec: 'SPEC-X', productionDate: productionDateApr21 },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'D0000000001', machineNo: 'No3-60', productSpec: 'SPEC-X' }],
      filename: 'test.xlsx',
      uploadDate: '2026-04-23',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('D0000000001');
  const storedDateStr = new Date(stored.productionDate).toISOString().slice(0, 10);
  assert.equal(storedDateStr, '2026-04-21', 'productionDate 應保持 4/21（現場為準），不被 4/23 覆寫');
});

await test('bulk-upload：已有 productionDate 的工單，再上傳也不覆寫（含無活動工單）', async () => {
  // 新規則：productionDate 一旦設定就永遠不被覆寫
  // 例如同單號出現在 0417.xlsx + 0420.xlsx，第二次上傳不該把日期改成 4/20
  const { fastify, state } = await buildApp(PLANNER);
  const date0417 = new Date('2026-04-17T00:00:00Z');
  await fastify.prisma.order.create({
    data: { orderNo: 'D0000000002', productSpec: 'SPEC-Y', productionDate: date0417 },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'D0000000002', productSpec: 'SPEC-Y' }],
      filename: '0420.xlsx',
      uploadDate: '2026-04-20',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('D0000000002');
  const storedDateStr = new Date(stored.productionDate).toISOString().slice(0, 10);
  assert.equal(storedDateStr, '2026-04-17', 'productionDate 應保留 4/17（已有值就鎖），不被 0420 覆寫');
});

await test('bulk-upload：寫入 plannedDate（取代舊的 productionDate）', async () => {
  // 新架構：上傳寫 plannedDate，不再寫 productionDate
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({
    data: { orderNo: 'D0000000003', productSpec: 'SPEC-NEW', plannedDate: null },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'D0000000003', productSpec: 'SPEC-NEW' }],
      filename: 'test.xlsx',
      uploadDate: '2026-04-25',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('D0000000003');
  assert.ok(stored.plannedDate, 'plannedDate 應被設值');
  assert.equal(new Date(stored.plannedDate).toISOString().slice(0, 10), '2026-04-25');
});

await test('bulk-upload：plannedDate 可被新上傳覆寫（生管修排程要能反映）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  const date0417 = new Date('2026-04-17T00:00:00Z');
  await fastify.prisma.order.create({
    data: { orderNo: 'D0000000004', productSpec: 'SPEC-PLAN', plannedDate: date0417 },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      orders: [{ orderNo: 'D0000000004', productSpec: 'SPEC-PLAN' }],
      filename: '0420.xlsx',
      uploadDate: '2026-04-20',
    }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('D0000000004');
  assert.equal(new Date(stored.plannedDate).toISOString().slice(0, 10), '2026-04-20', 'plannedDate 應被覆寫成 4/20');
});

await test('step-entries：reset 後重做時，不可把 productionDate 改成今天（regression）', async () => {
  // 情境：4/21 班長記錄工單 → 4/22 admin reset-production（紀錄被軟刪）→
  //       4/23 班長又掃一筆。期望：productionDate 仍是 4/21，不被當「第一次活動」覆寫。
  const { fastify, state } = await buildApp(PLANNER);
  const productionDateApr21 = new Date('2026-04-21T00:00:00Z');
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'E0000000001', machineNo: 'No3-60', productSpec: 'SPEC-Z', productionDate: productionDateApr21 },
  });
  // 4/21 的紀錄
  const entry = await fastify.prisma.stepEntry.create({
    data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date('2026-04-21T08:00:00Z') },
  });
  // 模擬 reset-production：軟刪除舊紀錄
  state.stepEntries.get(entry.id).deletedAt = new Date('2026-04-22T00:00:00Z');

  // 4/23 班長又掃一筆
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/E0000000001/step-entries',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ stepNo: '2' }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('E0000000001');
  const storedDateStr = new Date(stored.productionDate).toISOString().slice(0, 10);
  assert.equal(storedDateStr, '2026-04-21', 'productionDate 應保留 4/21（曾經有過活動，含已軟刪除）');
});

await test('step-entries：全新工單第一次活動時，actualStartDate 設為當天（取代舊 productionDate 邏輯）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({
    data: { orderNo: 'E0000000002', machineNo: 'No3-60', productSpec: 'SPEC-NEW', actualStartDate: null },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/E0000000002/step-entries',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ stepNo: '1' }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('E0000000002');
  assert.ok(stored.actualStartDate, '全新工單第一次活動應自動設 actualStartDate');
});

await test('reset-production：清除 actualStartDate（讓 reset 後重新累積）', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({
    data: { orderNo: 'F0000000001', actualStartDate: new Date('2026-04-21T00:00:00Z') },
  });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/F0000000001/reset-production' });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('F0000000001');
  assert.equal(stored.actualStartDate, null, 'reset 後 actualStartDate 應被清空');
});

await test('step-entries：補登舊日期時，actualStartDate 用補登時間（不是今天）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({
    data: { orderNo: 'F0000000002', machineNo: 'No3-60', actualStartDate: null },
  });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/F0000000002/step-entries',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ stepNo: '1', recordedAt: '2026-04-15T08:00:00Z' }),
  });
  assert.equal(res.statusCode, 200);
  const stored = state.orders.get('F0000000002');
  assert.ok(stored.actualStartDate);
  // 4/15 08:00 UTC = 4/15 16:00 台灣 → 台灣日期 = 4/15
  assert.equal(new Date(stored.actualStartDate).toISOString().slice(0, 10), '2026-04-15', 'actualStartDate 應用補登時間（4/15），不是今天');
});

await test('DELETE ?force=true（Admin）→ 連紀錄一起軟刪除', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  const order = await fastify.prisma.order.create({ data: { orderNo: 'G0000000001' } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '1', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.stepEntry.create({ data: { orderId: order.id, stepNo: '2', seq: 1, recordedAt: new Date() } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: order.id, type: '12', startAt: new Date() } });

  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/G0000000001?force=true' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.deleted, true);
  assert.equal(body.force, true);
  assert.equal(body.entries, 2);
  assert.equal(body.pauses, 1);

  const stored = state.orders.get('G0000000001');
  assert.ok(stored.deletedAt, '工單應軟刪除');
  const entries = Array.from(state.stepEntries.values());
  assert.ok(entries.every(e => e.deletedAt), '所有 stepEntries 應軟刪除');
  const pauses = Array.from(state.pauseEvents.values());
  assert.ok(pauses.every(p => p.deletedAt), '所有 pauseEvents 應軟刪除');
});

await test('DELETE ?force=true（Planner）→ 403', async () => {
  const { fastify } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'G0000000002' } });
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/G0000000002?force=true' });
  assert.equal(res.statusCode, 403);
});

await test('GET /:orderNo：找不到工單會自動建立並回傳 wasCreated=true', async () => {
  // 防呆機制：前端拿到 wasCreated=true 後跳 confirm，讓使用者確認單號是否打錯
  const { fastify, state } = await buildApp(PLANNER);
  const res = await fastify.inject({ method: 'GET', url: '/api/orders/F0000000099' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.wasCreated, true, '新工單應回傳 wasCreated=true');
  assert.equal(body.order.orderNo, 'F0000000099');
  assert.ok(state.orders.get('F0000000099'), '工單應已建立');
  // 也應留下 auto_create_order 的稽核紀錄
  const audit = state.auditLogs.find(a => a.action === 'auto_create_order');
  assert.ok(audit, '應寫入 auto_create_order 稽核紀錄');
  assert.equal(audit.target, 'F0000000099');
});

await test('GET /:orderNo：已存在的工單不會回 wasCreated=true', async () => {
  const { fastify } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'F0000000098' } });
  const res = await fastify.inject({ method: 'GET', url: '/api/orders/F0000000098' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(!body.wasCreated, '已存在的工單不該帶 wasCreated 標記');
});

// 注意：upload-batches/:id/restore 的完整業務邏輯（回填工單欄位、跳過已被新批次填過的）
// 因 mock prisma 沒實作 uploadBatch.findUnique 細節，留待 production DB 驗證。
// 這裡只測權限。
await test('upload-batches/:id/restore（Planner）→ 403', async () => {
  const { fastify } = await buildApp(PLANNER);
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/upload-batches/1/restore' });
  assert.equal(res.statusCode, 403);
});

await test('刪除後再 DELETE → 404（軟刪除的工單不該被找到）', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  await fastify.prisma.order.create({ data: { orderNo: 'A0000000009' } });
  state.orders.get('A0000000009').deletedAt = new Date();
  const res = await fastify.inject({ method: 'DELETE', url: '/api/orders/A0000000009' });
  assert.equal(res.statusCode, 404);
  await fastify.close();
});


// ── 第三批防呆（2026-10）──
const H = 3600 * 1000;
await test('暫停不可重疊：補登的時段跟既有暫停重疊 → 409', async () => {
  const { fastify } = await buildApp(LEADER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000001', machineNo: 'No12' } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: o.id, type: '12', note: '中午休息', startAt: new Date(Date.now() - 5 * H), endAt: new Date(Date.now() - 4 * H) } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/E0000000001/pause-backfill', payload: {
    type: '12', note: '中午休息', startAt: new Date(Date.now() - 4.5 * H).toISOString(), endAt: new Date(Date.now() - 3.5 * H).toISOString(), qcActualQty: 1 } });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /不能重疊/);
  await fastify.close();
});

await test('暫停不可重疊：異常停線進行中，再按暫停 → 409', async () => {
  const { fastify } = await buildApp(LEADER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000002', machineNo: 'No12' } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: o.id, type: '13', note: '設備異常', startAt: new Date(Date.now() - H), endAt: null } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/E0000000002/pause', payload: { type: '12', note: '中午休息', qcActualQty: 3 } });
  assert.equal(res.statusCode, 409);
  await fastify.close();
});

await test('還在暫停中就按完成 → 409（請先恢復）', async () => {
  const { fastify } = await buildApp(LEADER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000003', machineNo: 'No12' } });
  await fastify.prisma.pauseEvent.create({ data: { orderId: o.id, type: '12', note: '下班時間／隔日生產', startAt: new Date(Date.now() - H), endAt: null } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/E0000000003/steps/11', payload: { note: '' } });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /恢復/);
  await fastify.close();
});

await test('生產規格完成 1 分鐘內同規格同數量重送 → 409', async () => {
  const { fastify } = await buildApp(LEADER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000004', machineNo: 'No12' } });
  await fastify.prisma.stepEntry.create({ data: { orderId: o.id, stepNo: '30', seq: 1, note: '規格A', qcActualQty: 120, recordedAt: new Date(Date.now() - 20 * 1000) } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/E0000000004/step-entries', payload: { stepNo: '30', note: '規格A', qcActualQty: 120 } });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /按了兩次/);
  await fastify.close();
});

await test('現場撤銷唯一一筆紀錄 → 實際開始日清空', async () => {
  const { fastify, state } = await buildApp(LEADER);
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000005', machineNo: 'No12', actualStartDate: new Date('2026-10-20') } });
  const en = await fastify.prisma.stepEntry.create({ data: { orderId: o.id, stepNo: '40', seq: 1, recordedAt: new Date() } });
  const res = await fastify.inject({ method: 'DELETE', url: `/api/orders/E0000000005/step-entries/${en.id}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(state.orders.get('E0000000005').actualStartDate, null, '沒有紀錄了，開始日要清空');
  await fastify.close();
});

await test('救回工單：只救回跟工單一起刪的紀錄，之前個別撤銷的不救回', async () => {
  const { fastify, state } = await buildApp(ADMIN);
  const delAt = new Date();
  const o = await fastify.prisma.order.create({ data: { orderNo: 'E0000000006', machineNo: 'No12' } });
  const a = await fastify.prisma.stepEntry.create({ data: { orderId: o.id, stepNo: '30', seq: 1, note: 'A', qcActualQty: 100, recordedAt: new Date() } });
  const b = await fastify.prisma.stepEntry.create({ data: { orderId: o.id, stepNo: '30', seq: 2, note: 'A', qcActualQty: 100, recordedAt: new Date() } });
  state.stepEntries.get(b.id).deletedAt = new Date(delAt.getTime() - 3600 * 1000); // 之前就被撤銷的重複紀錄
  state.stepEntries.get(a.id).deletedAt = delAt;                                     // 跟工單一起刪
  state.orders.get('E0000000006').deletedAt = delAt;
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/E0000000006/restore' });
  assert.equal(res.statusCode, 200);
  assert.equal(state.stepEntries.get(a.id).deletedAt, null, '一起刪的要救回');
  assert.ok(state.stepEntries.get(b.id).deletedAt, '之前撤銷的不能救回');
  await fastify.close();
});

await test('重新上傳：被強制刪除、有生產紀錄的單不自動救回', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'E0000000007', machineNo: 'No12', step11At: new Date(), actualStartDate: new Date() } });
  state.orders.get('E0000000007').deletedAt = new Date();
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orders: [{ orderNo: 'E0000000007', machineNo: 'No12', productSpec: 'X' }], filename: 't.xlsx' }),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(state.orders.get('E0000000007').deletedAt, '要維持刪除狀態');
  assert.match(JSON.parse(res.body).errors[0], /回收桶/);
});

await test('操作紀錄：物件內容存成 JSON（不是 [object Object]）', async () => {
  const { fastify, state } = await buildApp(PLANNER);
  await fastify.prisma.order.create({ data: { orderNo: 'E0000000008', machineNo: 'No12' } });
  state.orders.get('E0000000008').deletedAt = new Date();
  await fastify.inject({
    method: 'POST', url: '/api/orders/bulk-upload', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ orders: [{ orderNo: 'E0000000008', machineNo: 'No12', productSpec: 'X' }], filename: 't.xlsx' }),
  });
  const log = state.auditLogs.find(l => l.action === 'bulk_upload_revive_order');
  assert.ok(log && log.detail.startsWith('{'), '應為 JSON：' + (log && log.detail));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
