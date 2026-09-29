// ERP 匯出的加工單 .QRP 解析。
//
// 格式：QuickReport 的「已排版列印檔」，外層是它自己的小標頭，內容是每頁一份 EMF
// （Windows 增強型中繼檔）。單子上每段文字是一筆 EMR_EXTTEXTOUTW（UTF-16 + 座標 +
// 邊界框），表格格線是 MOVETOEX/LINETO 線段。
//
// 取值原則——都不綁絕對座標，ERP 調版面也不會壞：
//   表頭欄位：找「標籤」那一格，取它右邊那一格（findRight）
//   明細表格：用該表的垂直格線切出真正的欄位邊界，再依文字邊界框的中心點歸欄，
//             欄名由表頭列用同一套規則得出。中間欄位空白也不會錯位。
// 抓不到就回 null 並記進 warnings，不猜值；路由端一定要讓人先核對再建單。

const EMR_MOVETOEX = 27;
const EMR_LINETO = 54;
const EMR_EXTTEXTOUTA = 83;
const EMR_EXTTEXTOUTW = 84;
const ROW_TOLERANCE = 12; // 同一列的 y 容差（EMF 邏輯單位）

const norm = s => String(s || '').replace(/\s+/g, '');
const stripColon = s => norm(s).replace(/[:：]$/, '');

// ── 1. 掃 EMF：文字區塊與格線 ───────────────────────────────────────────────
export function scan(buf) {
  const texts = [];
  const lines = [];
  const starts = [];
  for (let i = buf.indexOf(' EMF', 0, 'latin1'); i >= 0; i = buf.indexOf(' EMF', i + 4, 'latin1')) {
    if (i >= 40) starts.push(i - 40); // " EMF" 簽章位於 EMR_HEADER 起點 +40
  }
  starts.forEach((start, idx) => {
    const page = idx + 1;
    const end = idx + 1 < starts.length ? starts[idx + 1] : buf.length;
    let off = start;
    let cur = null; // MOVETOEX 的目前點
    while (off + 8 <= end) {
      const type = buf.readUInt32LE(off);
      const size = buf.readUInt32LE(off + 4);
      if (size < 8 || off + size > end) break;

      if (type === EMR_MOVETOEX) {
        cur = { x: buf.readInt32LE(off + 8), y: buf.readInt32LE(off + 12) };
      } else if (type === EMR_LINETO) {
        const p = { x: buf.readInt32LE(off + 8), y: buf.readInt32LE(off + 12) };
        if (cur) lines.push({ page, x1: cur.x, y1: cur.y, x2: p.x, y2: p.y });
        cur = p;
      } else if (type === EMR_EXTTEXTOUTW || type === EMR_EXTTEXTOUTA) {
        // iType(4) nSize(4) rclBounds(16) iGraphicsMode(4) exScale(4) eyScale(4)
        //   → EMRTEXT: ptlReference(8) nChars(4) offString(4) …
        const left = buf.readInt32LE(off + 8);
        const top = buf.readInt32LE(off + 12);
        const right = buf.readInt32LE(off + 16);
        const bottom = buf.readInt32LE(off + 20);
        const nChars = buf.readUInt32LE(off + 44);
        const offString = buf.readUInt32LE(off + 48);
        const begin = off + offString;
        const bytes = type === EMR_EXTTEXTOUTW ? nChars * 2 : nChars;
        if (offString >= 8 && begin + bytes <= off + size) {
          const s = (type === EMR_EXTTEXTOUTW
            ? buf.toString('utf16le', begin, begin + bytes)
            : buf.toString('latin1', begin, begin + bytes)).replace(/\u0000/g, '').trim();
          // 文字位置一律用邊界框，不用 ptlReference——後者會隨對齊方式（右對齊的數字）改變意義
          if (s) texts.push({ page, text: s, left, right, top, bottom, x: left, y: top });
        }
      }
      off += size;
    }
  });
  return { texts, lines };
}

// ── 2. 依 y 併成列 ──────────────────────────────────────────────────────────
export function toRows(texts) {
  const rows = [];
  for (const t of texts) {
    const row = rows.find(r => r.page === t.page && Math.abs(r.y - t.y) <= ROW_TOLERANCE);
    if (row) row.cells.push(t);
    else rows.push({ page: t.page, y: t.y, top: t.top, bottom: t.bottom, cells: [t] });
  }
  rows.sort((a, b) => (a.page - b.page) || (a.y - b.y));
  for (const r of rows) {
    r.cells.sort((a, b) => a.left - b.left);
    r.texts = r.cells.map(c => c.text);
    r.top = Math.min(...r.cells.map(c => c.top));
    r.bottom = Math.max(...r.cells.map(c => c.bottom));
  }
  return rows;
}

// ── 3. 用格線切欄 ───────────────────────────────────────────────────────────
// 取與 [yTop, yBottom] 有重疊的垂直線 x（就是這張表真正的欄位邊界）
function columnBoundaries(lines, page, yTop, yBottom) {
  const xs = new Set();
  for (const l of lines) {
    if (l.page !== page || l.x1 !== l.x2) continue;
    const [a, b] = l.y1 <= l.y2 ? [l.y1, l.y2] : [l.y2, l.y1];
    if (b > yTop + 2 && a < yBottom - 2) xs.add(l.x1);
  }
  // 相距 3 單位內視為同一條（ERP 有時會畫兩條重疊的線）
  return [...xs].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 3);
}

// 文字中心落在第幾欄
const colIndex = (cell, bounds) => bounds.filter(b => b <= (cell.left + cell.right) / 2).length;

// ── 4. 取值工具 ─────────────────────────────────────────────────────────────
// 找標籤那一格，回傳右邊第一格（右邊那格若也是標籤則視為空白）
function findRight(rows, label) {
  const want = stripColon(label);
  for (const r of rows) {
    for (let i = 0; i < r.cells.length; i++) {
      if (stripColon(r.cells[i].text) !== want) continue;
      const next = r.cells[i + 1];
      if (!next || /[:：]$/.test(norm(next.text))) return null;
      return next.text.trim();
    }
  }
  return null;
}

// 民國年 115/09/29、115.09.29 → Date（UTC 當日 00:00，與其他模組一致）
export function parseRocDate(s) {
  const m = /^(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// 空字串 / 無值一律 null，不要變成 0——「沒填」和「填 0」意義不同
function toNum(s) {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── 5. 讀明細表：表頭列 → 欄名，往下讀到區段結束 ──────────────────────────────
function readTable(rows, lines, headerMatch, stopMatch) {
  const hi = rows.findIndex(r => headerMatch(r.texts));
  if (hi < 0) return { columns: [], records: [] };
  const header = rows[hi];

  // 先用表頭列自己的 y 範圍拿欄位邊界，再把資料列一起納入（同一張表的格線是連續的）
  let last = hi;
  for (let i = hi + 1; i < rows.length; i++) {
    if (stopMatch && stopMatch(rows[i].texts)) break;
    if (!/^\d{3,4}$/.test(norm(rows[i].texts[0] || ''))) { if (last > hi) break; else continue; }
    last = i;
  }
  const bounds = columnBoundaries(lines, header.page, header.top, rows[last].bottom);
  if (!bounds.length) return { columns: header.texts.map(t => t.trim()), records: [], noGrid: true };

  const columns = [];
  for (const c of header.cells) columns[colIndex(c, bounds)] = c.text.trim();

  const records = [];
  for (let i = hi + 1; i <= last; i++) {
    const r = rows[i];
    if (!/^\d{3,4}$/.test(norm(r.texts[0] || ''))) continue;
    const rec = {};
    for (const c of r.cells) {
      const name = columns[colIndex(c, bounds)] ?? `col${colIndex(c, bounds)}`;
      rec[name] = rec[name] ? `${rec[name]} ${c.text.trim()}` : c.text.trim();
    }
    records.push(rec);
  }
  return { columns, records };
}

// 依欄名關鍵字取值（欄名有空白、換行、全形都容忍）
const pick = (rec, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(rec).find(name => norm(name).includes(norm(k)));
    if (hit && rec[hit] !== '') return rec[hit];
  }
  return null;
};

// ── 6. 主函式：QRP → 結構化加工單 ───────────────────────────────────────────
export function parseQrp(buf) {
  const { texts, lines } = scan(buf);
  if (!texts.length) {
    return { ok: false, error: '檔案裡找不到文字（可能不是 QuickReport 匯出的 QRP）', warnings: [], raw: [] };
  }
  const rows = toRows(texts);
  const isProcessSheet = rows.some(r => norm(r.texts.join('')).includes('加工單'));

  const materialTable = readTable(
    rows, lines,
    ts => ts.some(t => norm(t) === '領用材料'),
    ts => ts.some(t => norm(t).includes('品名規格')),
  );
  const cutTable = readTable(
    rows, lines,
    ts => ts.some(t => norm(t).includes('品名規格')),
    ts => ts.some(t => norm(t).includes('零星裁剪') || norm(t).includes('品管')),
  );

  const materials = materialTable.records.map(rec => ({
    seq: pick(rec, '序號'),
    spec: pick(rec, '領用材料'),
    qty: toNum(pick(rec, '領用數量')),
    total: toNum(pick(rec, '總數')),
    actualQty: toNum(pick(rec, '實際使用數量')),
    stock: toNum(pick(rec, '餘庫存')),
  }));
  const cuts = cutTable.records.map(rec => ({
    seq: pick(rec, '序號'),
    spec: pick(rec, '品名規格'),
    qty: toNum(pick(rec, '數量')),
    actualSpecQty: pick(rec, '實際領用規格'),
    oddSizeQty: pick(rec, '使用零星尺寸'),
  }));

  const fields = {
    processNo: findRight(rows, '加工單號'),
    manuOrderNo: findRight(rows, '工令單號'),
    poNo: findRight(rows, '訂單號碼'),
    customer: findRight(rows, '客戶名稱'),
    area: findRight(rows, '區域'),
    productModel: findRight(rows, '產品型號'),
    plannedDate: parseRocDate(findRight(rows, '派工日期')),
    dueDate: parseRocDate(findRight(rows, '交貨日期')),
    cutMethod: findRight(rows, '裁剪方式'),
    packMethod: findRight(rows, '包裝方式'),
    machineNo: findRight(rows, '操作機台'),
    operator: findRight(rows, '操作員'),
    preparer: findRight(rows, '備料人員'),
    filledBy: findRight(rows, '填表員'),
    remark: findRight(rows, '備註'),
  };

  const warnings = [];
  if (!isProcessSheet) warnings.push('單別不是「加工單」，請確認檔案是否正確');
  if (!fields.processNo) warnings.push('抓不到加工單號');
  if (!fields.manuOrderNo) warnings.push('抓不到工令單號');
  if (!materials.length) warnings.push('抓不到領用材料');
  if (!cuts.length) warnings.push('抓不到裁剪 / 加工明細');
  if (materialTable.noGrid || cutTable.noGrid) warnings.push('找不到表格格線，明細欄位可能對不準，請逐項核對');
  for (const c of cuts) if (c.qty == null) warnings.push(`裁剪明細 ${c.seq ?? '?'} 沒有數量`);
  for (const c of cuts) if (!c.spec) warnings.push(`裁剪明細 ${c.seq ?? '?'} 沒有品名規格`);

  return {
    ok: warnings.length === 0,
    fields,
    materials,
    cuts,
    warnings,
    pages: Math.max(...texts.map(t => t.page)),
    raw: rows.map(r => ({ page: r.page, y: r.y, texts: r.texts })), // 供確認畫面顯示原文
  };
}

// ── 7. 轉成建立 ProcessOrder 用的草稿（人工核對後才送出）─────────────────────
export function toProcessOrderDraft(parsed) {
  const { fields, cuts, materials } = parsed;
  return {
    processNo: fields.processNo,
    manuOrderNo: fields.manuOrderNo,
    customer: fields.customer,
    spec: cuts.map(c => (c.qty == null ? c.spec : `${c.spec} , ${c.qty}`)).join('\n') || null,
    qty: cuts.reduce((s, c) => s + (c.qty || 0), 0) || null,
    machineNo: fields.machineNo,
    plannedDate: fields.plannedDate,
    dueDate: fields.dueDate,
    remark: [fields.cutMethod, fields.packMethod].filter(Boolean).join('；') || null,
    sourceMaterials: materials.map(m => ({ spec: m.spec, qty: m.qty, total: m.total, stock: m.stock })),
  };
}
