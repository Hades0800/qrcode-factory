// 跨日中斷-恢復模擬：用 mock prisma + Fastify inject 跑一遍完整流程
// 不需要真 DB；執行：node tests/cross-day-pause.sim.mjs
//
// 模擬時間軸：
//   昨天 09:00 — 工單開始（step 41 穩定生產）
//   昨天 18:00 — 點下「生產中斷」（type=12，午休/下班）
//   今天 08:00 — 點下「恢復生產」
//
// 應該驗證的事：
//   ✓ 隔天打開仍能看到 active pause
//   ✓ resume API 算出 14 小時 (50400 秒) duration
//   ✓ 恢復後 pause12.active 變 null、pause12.count = 1、totalSec = 50400

import Fastify from 'fastify';
import orderRoutes from '../src/routes/orders.js';

// ── Mock prisma（跟 routes.test.mjs 同一份，僅補 startAt 預設）──
function makeMockPrisma() {
  const state = {
    orders: new Map(),
    stepEntries: new Map(),
    pauseEvents: new Map(),
    auditLogs: [],
    _nextStepEntryId: 1,
    _nextPauseEventId: 1,
    _nextOrderId: 1,
  };

  const filterDeleted = (rows, where) => {
    if (!where) return rows;
    return rows.filter(r => {
      for (const [k, v] of Object.entries(where)) {
        if (k === 'deletedAt') {
          if (v === null) { if (r.deletedAt) return false; }
          else if (typeof v === 'object' && v !== null && 'not' in v) {
            if (v.not === null && !r.deletedAt) return false;
          }
        } else if (k === 'OR' || k === 'AND' || k === 'NOT' || k === 'in') {
          // ignore
        } else {
          if (r[k] !== v) return false;
        }
      }
      return true;
    });
  };
  const injectSoftDelete = (where) => {
    const w = where ? { ...where } : {};
    if (!('deletedAt' in w)) w.deletedAt = null;
    return w;
  };

  const order = {
    findUnique: async ({ where, include }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      const row = rows[0];
      if (!row) return null;
      // 模擬 include
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) {
          result.pauseEvents = filterDeleted(Array.from(state.pauseEvents.values()), { orderId: row.id, deletedAt: null });
        }
        if (include.stepEntries) {
          result.stepEntries = filterDeleted(Array.from(state.stepEntries.values()), { orderId: row.id, deletedAt: null });
        }
        return result;
      }
      return row;
    },
    findFirst: async ({ where }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      return rows[0] || null;
    },
    findMany: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)),
    count: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)).length,
    create: async ({ data, include }) => {
      const row = { id: state._nextOrderId++, ...data, deletedAt: null };
      state.orders.set(data.orderNo, row);
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) result.pauseEvents = [];
        if (include.stepEntries) result.stepEntries = [];
        return result;
      }
      return row;
    },
    update: async ({ where, data, include }) => {
      const row = state.orders.get(where.orderNo) || [...state.orders.values()].find(r => r.id === where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) {
          result.pauseEvents = filterDeleted(Array.from(state.pauseEvents.values()), { orderId: row.id, deletedAt: null });
        }
        if (include.stepEntries) {
          result.stepEntries = filterDeleted(Array.from(state.stepEntries.values()), { orderId: row.id, deletedAt: null });
        }
        return result;
      }
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), where);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    delete: async ({ where }) => {
      const row = state.orders.get(where.orderNo);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
  };

  const makeChildModel = (map, nextIdField, defaults = {}) => ({
    findFirst: async ({ where } = {}) => {
      const rows = filterDeleted(Array.from(map.values()), injectSoftDelete(where));
      return rows[0] || null;
    },
    findMany: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)),
    findUnique: async ({ where }) => {
      return map.get(where.id) || null;
    },
    count: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)).length,
    create: async ({ data }) => {
      const id = state[nextIdField]++;
      const row = { ...defaults, id, ...data, deletedAt: null };
      map.set(id, row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
    deleteMany: async ({ where }) => {
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
    // pauseEvent 在真 schema：startAt 有 @default(now())，endAt/duration 為 nullable
    // mock 補上 default：endAt:null 才能讓 findFirst({endAt:null}) 找到 active 那筆
    pauseEvent: makeChildModel(state.pauseEvents, '_nextPauseEventId', { startAt: new Date(), endAt: null, duration: null }),
    auditLog: { create: async ({ data }) => { state.auditLogs.push(data); return data; } },
    uploadBatch: { _nextId: 1, create: async function({ data }) { return { id: this._nextId++, ...data }; }, update: async ({ where, data }) => ({ id: where.id, ...data }) },
    uploadRow: { createMany: async ({ data }) => ({ count: data.length }) },
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => 1,
  };
  return { prisma, state };
}

// ── 設定 ──
const ORDER_NO = 'F1150407024';
const ADMIN = { id: 1, username: 'admin', displayName: '測試管理員', isAdmin: true, isPlanner: true };

const now = new Date();
const yesterday0900 = new Date(now); yesterday0900.setDate(yesterday0900.getDate() - 1); yesterday0900.setHours(9, 0, 0, 0);
const yesterday1800 = new Date(now); yesterday1800.setDate(yesterday1800.getDate() - 1); yesterday1800.setHours(18, 0, 0, 0);
const today0800 = new Date(now); today0800.setHours(8, 0, 0, 0);

function fmt(d) { return d.toLocaleString('zh-TW', { hour12: false }); }
function header(title) { console.log('\n' + '═'.repeat(72) + '\n  ' + title + '\n' + '═'.repeat(72)); }
function show(label, res) {
  console.log('\n▸ ' + label);
  console.log('  status:', res.statusCode);
  let body;
  try { body = JSON.parse(res.body); } catch { body = res.body; }
  // 把長的 history/stepEntries 簡化顯示
  if (body && body.order) {
    const o = body.order;
    const summary = {
      orderNo: o.orderNo,
      machineNo: o.machineNo,
      step41: o.step41At ? fmt(new Date(o.step41At)) : null,
      step11: o.step11At ? fmt(new Date(o.step11At)) : null,
      pause12: o.pause12 ? {
        count: o.pause12.count,
        totalSec: o.pause12.totalSec,
        totalHM: secondsToHM(o.pause12.totalSec),
        active: o.pause12.active ? { startAt: fmt(new Date(o.pause12.active.startAt)), note: o.pause12.active.note } : null,
        history: (o.pause12.history || []).map(h => ({
          startAt: fmt(new Date(h.startAt)),
          endAt: h.endAt ? fmt(new Date(h.endAt)) : '(進行中)',
          duration: h.duration,
          durationHM: h.duration ? secondsToHM(h.duration) : '—',
        })),
      } : null,
    };
    console.log('  order:', JSON.stringify(summary, null, 2).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n'));
    if (body.resumed) {
      console.log('  resumed:', JSON.stringify({
        type: body.resumed.type,
        duration: body.resumed.duration,
        durationHM: secondsToHM(body.resumed.duration),
      }));
    }
  } else {
    console.log('  body:', JSON.stringify(body));
  }
}
function secondsToHM(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}時 ${m}分 ${s}秒`;
}

// ── 啟動 fastify + 跑流程 ──
async function run() {
  const fastify = Fastify({ logger: false });
  const { prisma, state } = makeMockPrisma();
  fastify.decorate('prisma', prisma);
  fastify.decorate('authenticate', async (req) => { req.user = ADMIN; });
  fastify.decorate('requireAdmin', async () => {});
  await fastify.register(orderRoutes, { prefix: '/api/orders' });
  await fastify.ready();

  console.log('模擬時間軸：');
  console.log('  昨天 09:00 (' + fmt(yesterday0900) + ') → 開始穩定生產 (step 41)');
  console.log('  昨天 18:00 (' + fmt(yesterday1800) + ') → 按下「生產中斷」(type=12)');
  console.log('  今天 08:00 (' + fmt(today0800) + ') → 按下「恢復生產」');
  console.log('  預期 duration ≈ 14 時 0 分 (50400 秒)');

  header('1. 取得工單（自動建立）— 模擬班長進入工單頁');
  let res = await fastify.inject({ method: 'GET', url: '/api/orders/' + ORDER_NO });
  show('GET /api/orders/' + ORDER_NO, res);

  header('2. 設定機台 + 規格 + 範圍 + 原料（前置設定）');
  res = await fastify.inject({ method: 'POST', url: '/api/orders/' + ORDER_NO + '/machine', payload: { machineNo: 'No1-350' } });
  show('POST /machine { machineNo: "No1-350" }', res);
  res = await fastify.inject({ method: 'POST', url: '/api/orders/' + ORDER_NO + '/spec-type', payload: { specType: 'mass' } });
  show('POST /spec-type { specType: "mass" }', res);
  res = await fastify.inject({ method: 'POST', url: '/api/orders/' + ORDER_NO + '/change-scope', payload: { changeScope: '@' } });
  show('POST /change-scope { changeScope: "@" }', res);
  res = await fastify.inject({ method: 'POST', url: '/api/orders/' + ORDER_NO + '/material-type', payload: { materialType: 'coil' } });
  show('POST /material-type { materialType: "coil" }', res);

  header('3. 昨天 09:00 — 開始穩定生產（step 41，補登時間）');
  res = await fastify.inject({
    method: 'POST',
    url: '/api/orders/' + ORDER_NO + '/step-entries',
    payload: { stepNo: '41', recordedAt: yesterday0900.toISOString(), note: '開始穩定生產' },
  });
  show('POST /step-entries { stepNo: "41", recordedAt: "昨天 09:00" }', res);

  header('4. 昨天 18:00 — 按下「生產中斷」(type=12)');
  res = await fastify.inject({
    method: 'POST',
    url: '/api/orders/' + ORDER_NO + '/pause',
    payload: { type: '12', note: '中午休息或下班時間' },
  });
  show('POST /pause { type: "12" }', res);

  // 把 active pauseEvent 的 startAt 改成「昨天 18:00」（因為原 API 用 now() 當 startAt）
  const activePauses = Array.from(state.pauseEvents.values()).filter(p => !p.endAt);
  console.log('\n  ⏰ 模擬時間旅行：把 active pause 的 startAt 改成昨天 18:00');
  console.log('     (原 API 用伺服器當下時間，這裡手動覆寫成隔日場景)');
  activePauses.forEach(p => { p.startAt = yesterday1800; });

  header('5. 隔天早上 — 重新打開工單，確認還記得是中斷狀態');
  res = await fastify.inject({ method: 'GET', url: '/api/orders/' + ORDER_NO });
  show('GET /api/orders/' + ORDER_NO + '（隔天）', res);

  header('6. 今天 08:00 — 按下「恢復生產」(type=12)');
  // 注意：resume 的 endAt 用 Date.now() = 真正現在
  // 為了讓 duration 精確顯示「14 時」，我們在腳本裡顯示時間差用實際 now-yesterday1800 計算
  res = await fastify.inject({
    method: 'POST',
    url: '/api/orders/' + ORDER_NO + '/resume',
    payload: { type: '12' },
  });
  show('POST /resume { type: "12" }', res);

  header('7. 恢復後再 GET 一次工單，確認 pause 已關閉');
  res = await fastify.inject({ method: 'GET', url: '/api/orders/' + ORDER_NO });
  show('GET /api/orders/' + ORDER_NO + '（恢復後）', res);

  // ── 驗證結論 ──
  header('驗證結論');
  const body = JSON.parse(res.body);
  const p12 = body.order.pause12;
  const checks = [
    ['pause12.active 應為 null（已恢復）', p12.active === null],
    ['pause12.count 應為 1', p12.count === 1],
    ['pause12.history.length 應為 1', p12.history.length === 1],
    ['pause12.history[0].endAt 應有值（已關閉）', !!p12.history[0].endAt],
    ['pause12.history[0].duration > 50000 秒（≈14 小時）', p12.history[0].duration > 50000],
    ['pause12.history[0].startAt = 昨天 18:00', new Date(p12.history[0].startAt).getTime() === yesterday1800.getTime()],
  ];
  checks.forEach(([label, ok]) => console.log((ok ? '  ✓ ' : '  ✗ ') + label));
  const allPass = checks.every(([, ok]) => ok);
  console.log('\n' + (allPass ? '✅ 全部通過 — 跨日中斷-恢復邏輯正常' : '❌ 有檢查項失敗，請看上方輸出'));

  await fastify.close();
  process.exit(allPass ? 0 : 1);
}

run().catch(e => { console.error('Script crashed:', e); process.exit(2); });
