// 單元測試：驗證 server.js 裡的 Prisma 軟刪除 middleware 邏輯
// 此腳本複製 middleware 邏輯（務必與 server.js 保持同步）並對 mock params 跑 assertion。
// 跑完即可刪除。

import assert from 'node:assert/strict';

const SOFT_DELETE_MODELS = new Set(['Order', 'Leader', 'IdleEvent', 'StepEntry', 'PauseEvent']);

function middleware(params, nextCapture) {
  if (!SOFT_DELETE_MODELS.has(params.model)) return nextCapture(params);

  if (params.action === 'findUnique' || params.action === 'findFirst') {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      if (params.action === 'findUnique') params.action = 'findFirst';
      params.args.where.deletedAt = null;
    }
  } else if (
    params.action === 'findMany' ||
    params.action === 'count' ||
    params.action === 'aggregate' ||
    params.action === 'groupBy'
  ) {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      params.args.where.deletedAt = null;
    }
  } else if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deletedAt: new Date() };
  } else if (params.action === 'deleteMany') {
    params.action = 'updateMany';
    params.args = params.args || {};
    params.args.data = { ...(params.args.data || {}), deletedAt: new Date() };
  }

  return nextCapture(params);
}

function run(params) {
  let captured = null;
  middleware(params, (p) => { captured = p; return null; });
  return captured;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('✓', name); pass++; }
  catch (e) { console.error('✗', name, '\n    ', e.message); fail++; }
}

// ───────────────────────────────────────────
// 1. findUnique → findFirst + 注入 deletedAt: null
test('Order.findUnique → findFirst + deletedAt=null', () => {
  const r = run({ model: 'Order', action: 'findUnique', args: { where: { orderNo: 'A0000000001' } } });
  assert.equal(r.action, 'findFirst');
  assert.equal(r.args.where.deletedAt, null);
  assert.equal(r.args.where.orderNo, 'A0000000001');
});

// 2. findFirst 保持 action 並注入 deletedAt: null
test('Order.findFirst keeps action, adds deletedAt=null', () => {
  const r = run({ model: 'Order', action: 'findFirst', args: { where: { orderNo: 'A' } } });
  assert.equal(r.action, 'findFirst');
  assert.equal(r.args.where.deletedAt, null);
});

// 3. 逃生口：deletedAt 已存在於 where（null）→ 不動
test('escape hatch: explicit deletedAt=null still passes', () => {
  const r = run({ model: 'Order', action: 'findUnique', args: { where: { orderNo: 'A', deletedAt: null } } });
  // 已存在即跳過注入，action 不改（findUnique 保持）
  assert.equal(r.action, 'findUnique');
  assert.equal(r.args.where.deletedAt, null);
});

// 4. 逃生口：deletedAt: undefined → 不改寫，讓 Prisma 當「沒過濾」處理
test('escape hatch: deletedAt=undefined bypasses auto-filter', () => {
  const args = { where: { username: 'admin', deletedAt: undefined } };
  const r = run({ model: 'Leader', action: 'findFirst', args });
  assert.equal(r.action, 'findFirst');
  // 不應被改成 null，應維持 undefined
  assert.equal('deletedAt' in r.args.where, true);
  assert.equal(r.args.where.deletedAt, undefined);
});

// 5. 逃生口：deletedAt: { not: null } → 查 trash
test('escape hatch: deletedAt={not:null} bypasses auto-filter', () => {
  const r = run({ model: 'Order', action: 'findMany', args: { where: { deletedAt: { not: null } } } });
  assert.deepEqual(r.args.where.deletedAt, { not: null });
});

// 6. findMany / count / aggregate / groupBy 各自注入
test('findMany injects deletedAt=null', () => {
  const r = run({ model: 'Order', action: 'findMany', args: {} });
  assert.equal(r.args.where.deletedAt, null);
});
test('count injects deletedAt=null', () => {
  const r = run({ model: 'Leader', action: 'count', args: { where: { isAdmin: true } } });
  assert.equal(r.args.where.deletedAt, null);
  assert.equal(r.args.where.isAdmin, true);
});
test('aggregate injects deletedAt=null', () => {
  const r = run({ model: 'Order', action: 'aggregate', args: { _count: true } });
  assert.equal(r.args.where.deletedAt, null);
});
test('groupBy injects deletedAt=null', () => {
  const r = run({ model: 'Order', action: 'groupBy', args: { by: ['machineNo'] } });
  assert.equal(r.args.where.deletedAt, null);
});

// 7. delete → update + deletedAt=<date>
test('Order.delete → update + deletedAt set', () => {
  const r = run({ model: 'Order', action: 'delete', args: { where: { orderNo: 'A' } } });
  assert.equal(r.action, 'update');
  assert.ok(r.args.data.deletedAt instanceof Date);
  assert.equal(r.args.where.orderNo, 'A');
});

// 8. deleteMany → updateMany + deletedAt=<date>
test('StepEntry.deleteMany → updateMany + deletedAt set', () => {
  const r = run({ model: 'StepEntry', action: 'deleteMany', args: { where: { orderId: 5 } } });
  assert.equal(r.action, 'updateMany');
  assert.equal(r.args.where.orderId, 5);
  assert.ok(r.args.data.deletedAt instanceof Date);
});

// 9. 未在 SOFT_DELETE_MODELS 的模型不受影響（AuditLog / UploadBatch 等）
test('AuditLog.delete is NOT rewritten', () => {
  const r = run({ model: 'AuditLog', action: 'delete', args: { where: { id: 1 } } });
  assert.equal(r.action, 'delete');
  assert.equal(r.args.data, undefined);
});
test('UploadBatch.findMany is NOT filtered', () => {
  const r = run({ model: 'UploadBatch', action: 'findMany', args: {} });
  assert.equal('where' in (r.args || {}), false);
});

// 10. update 不被改寫（用來做 restore）
test('Order.update passthrough (used for restore)', () => {
  const r = run({ model: 'Order', action: 'update', args: { where: { id: 1 }, data: { deletedAt: null } } });
  assert.equal(r.action, 'update');
  assert.equal(r.args.data.deletedAt, null);
});

// 11. updateMany 不被改寫（restore children）
test('StepEntry.updateMany passthrough (used for restore children)', () => {
  const r = run({ model: 'StepEntry', action: 'updateMany', args: { where: { orderId: 5, deletedAt: { not: null } }, data: { deletedAt: null } } });
  assert.equal(r.action, 'updateMany');
  assert.equal(r.args.data.deletedAt, null);
});

// 12. 已有 where 但無 deletedAt → 保留其他條件
test('findMany with existing where keeps other conditions', () => {
  const r = run({ model: 'IdleEvent', action: 'findMany', args: { where: { machineNo: 'No1-350' }, orderBy: { createdAt: 'desc' } } });
  assert.equal(r.args.where.machineNo, 'No1-350');
  assert.equal(r.args.where.deletedAt, null);
  assert.deepEqual(r.args.orderBy, { createdAt: 'desc' });
});

// 13. args 為 undefined 也能處理（findMany 無參數）
test('findMany with no args initializes where', () => {
  const r = run({ model: 'Order', action: 'findMany' });
  assert.equal(r.args.where.deletedAt, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
