// 生管上傳的「加工單-入庫型號日期-明細表」Excel → 加工單 + 明細。
//
// 分工（見 docs/ERP-DOCUMENTS.md）：
//   業務 QRP   → 工令 E、領用材料、公差 / 包裝 / 裁剪方式
//   生管 Excel → 客戶代號、型號、材質、單重總數、類別、回單進度、結案（本檔）
//   生管在 MES 填 → 備料人員、操作機台、操作員
//   現場填        → 零星裁剪、實際狀況調整
//
// 前端用 SheetJS 讀檔，送上來的是「每列一個物件、鍵是表頭文字」，與既有製造單上傳一致。
// 這裡只做純對應與檢查，不碰資料庫。

const norm = s => String(s ?? '').replace(/\s+/g, '').trim();

// Excel 表頭 → 內部欄位。用包含比對，表頭有空白或微調都吃得到
const COLUMNS = {
  date: '日期', area: '區域編號', customerCode: '公司編號', processNo: '加工單號',
  spec: '品名規格', qty: '數量', dueDate: '交貨日期', waiting: '待料中', seq: '項次',
  modelCode: '型號', materialCode: '材質編號', unit: '單位', unitWeight: '單重',
  totalWeight: '總數', category: '類別', pendingQty: '未回數量', pendingTotal: '未回總數',
  returnedQty: '已回數量', returnedTotal: '已回總數', closed: '結案', oddCutting: '零星裁剪',
  workOrderNo: '工令單號', // ERP 目前沒出這欄；之後加了就自動吃得到
};

function makeGetter(row) {
  const keys = Object.keys(row);
  const cache = {};
  return field => {
    if (field in cache) return cache[field];
    const want = norm(COLUMNS[field]);
    const hit = keys.find(k => norm(k).includes(want));
    const v = hit == null ? null : row[hit];
    return (cache[field] = v === '' || v === undefined ? null : v);
  };
}

// 民國年：115年08月03日 / 115/08/03 / 115.08.03 → Date（UTC 當日 00:00）
export function parseRocDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v; // SheetJS cellDates 可能已轉好
  const t = String(v ?? '').trim();
  const m = /^(\d{2,3})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/.exec(t);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// 空值回 null 不回 0
export function toNum(v, integer = false) {
  const t = String(v ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.round(n) : n;
}

// ERP 的是非欄位：'0.否' / 'N.否' / '1.是' / 'Y.是'
const toBool = v => {
  const t = norm(v);
  if (!t) return false;
  if (/^(1|Y|是)/i.test(t) || t.includes('是')) return true;
  return false;
};

// 公司編號「26-33610003 台鎰」→ { code: '26-33610003', name: '台鎰' }
export function splitCustomer(v) {
  const t = String(v ?? '').trim();
  if (!t) return { code: null, name: null };
  const m = /^(\S+)\s+(.+)$/.exec(t);
  return m ? { code: m[1], name: m[2].trim() } : { code: null, name: t };
}

const ORDER_NO_RE = /^[A-Z]\d{10}$/;

/**
 * @param {Array<Object>} rows SheetJS 的 sheet_to_json 結果（含表頭那列以下的明細）
 * @returns {{orders: Array, warnings: Array<string>, skipped: number}}
 */
export function mapScheduleRows(rows) {
  const warnings = [];
  const byOrder = new Map();
  let skipped = 0;

  rows.forEach((row, i) => {
    const g = makeGetter(row);
    const processNo = String(g('processNo') ?? '').trim();
    if (!processNo) { skipped++; return; }            // 報表的標題／條件／空白列
    const lineNo = i + 1;

    if (!ORDER_NO_RE.test(processNo)) {
      warnings.push(`第 ${lineNo} 列：加工單號格式不對「${processNo}」，已略過`);
      skipped++;
      return;
    }

    const { code, name } = splitCustomer(g('customerCode'));
    const header = {
      processNo,
      manuOrderNo: g('workOrderNo') ? String(g('workOrderNo')).trim() : null, // 目前 ERP 不出這欄
      customer: name,
      customerCode: code,
      area: g('area') ? String(g('area')).trim() : null,
      category: g('category') ? String(g('category')).trim() : null,
      plannedDate: parseRocDate(g('date')),
      dueDate: parseRocDate(g('dueDate')),
      erpClosed: toBool(g('closed')),
      oddCutting: toBool(g('oddCutting')),
      waiting: toBool(g('waiting')),
      source: 'excel',
    };

    let order = byOrder.get(processNo);
    if (!order) {
      byOrder.set(processNo, (order = { ...header, items: [], _lines: [] }));
    } else {
      // 同一張單的各列表頭欄位應該一致，不一致代表報表有問題，要讓生管知道
      for (const k of ['customer', 'area', 'category']) {
        if (header[k] && order[k] && header[k] !== order[k]) {
          warnings.push(`${processNo}：第 ${lineNo} 列的「${k}」與前面不同（${order[k]} / ${header[k]}）`);
        }
      }
      for (const k of ['plannedDate', 'dueDate']) {
        const a = order[k]?.getTime?.(), b = header[k]?.getTime?.();
        if (a && b && a !== b) warnings.push(`${processNo}：第 ${lineNo} 列的「${k}」與前面不同`);
      }
      if (header.erpClosed) order.erpClosed = true;
      if (header.oddCutting) order.oddCutting = true;
    }

    const spec = String(g('spec') ?? '').trim();
    if (!spec) warnings.push(`${processNo} 第 ${lineNo} 列沒有品名規格`);
    const qty = toNum(g('qty'), true);
    if (qty == null) warnings.push(`${processNo} 第 ${lineNo} 列沒有數量`);

    order.items.push({
      seq: String(g('seq') ?? '').trim() || String(order.items.length + 1).padStart(4, '0'),
      spec,
      qty,
      unit: g('unit') ? String(g('unit')).trim() : null,
      unitWeight: toNum(g('unitWeight')),
      totalWeight: toNum(g('totalWeight')),
      modelCode: g('modelCode') ? String(g('modelCode')).trim() : null,
      materialCode: g('materialCode') ? String(g('materialCode')).trim() : null,
      returnedQty: toNum(g('returnedQty'), true),
      pendingQty: toNum(g('pendingQty'), true),
      kind: 'item',
      source: 'excel',
    });
    order._lines.push(lineNo);
  });

  const orders = [...byOrder.values()].map(o => {
    const { _lines, ...rest } = o;
    const seqs = rest.items.map(i => i.seq);
    const dup = seqs.filter((s, i) => seqs.indexOf(s) !== i);
    if (dup.length) warnings.push(`${rest.processNo}：項次重複 ${[...new Set(dup)].join('、')}`);
    return {
      ...rest,
      qty: rest.items.reduce((s, i) => s + (i.qty || 0), 0) || null,
      totalWeight: rest.items.reduce((s, i) => s + (i.totalWeight || 0), 0) || null,
      returnedQty: rest.items.some(i => i.returnedQty != null)
        ? rest.items.reduce((s, i) => s + (i.returnedQty || 0), 0) : null,
      pendingQty: rest.items.some(i => i.pendingQty != null)
        ? rest.items.reduce((s, i) => s + (i.pendingQty || 0), 0) : null,
      spec: rest.items.map(i => (i.qty == null ? i.spec : `${i.spec} , ${i.qty}`)).join('\n') || null,
    };
  });

  if (!orders.length) warnings.push('這份檔案裡找不到任何加工單（請確認是「加工單-入庫型號日期-明細表」）');
  if (orders.every(o => !o.manuOrderNo)) {
    warnings.push('這份報表沒有「工令單號」欄——製造單與加工單的關聯要另外由 QRP 補，或請 ERP 在報表加這一欄');
  }
  return { orders, warnings, skipped };
}
