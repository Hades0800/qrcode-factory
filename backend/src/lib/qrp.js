// ERP 匯出的單據 .QRP 解析（製造單 F / 加工單 G 共用）。
//
// 格式：QuickReport 的「已排版列印檔」，外層是它自己的小標頭，內容是每頁一份 EMF
// （Windows 增強型中繼檔）。單子上每段文字是一筆 EMR_EXTTEXTOUTW（UTF-16 + 邊界框），
// 表格格線是 MOVETOEX/LINETO 線段。
//
// 取值原則——都不綁絕對座標，ERP 調版面也不會壞：
//   表頭欄位：找「標籤」那一格，取右邊那一格；右邊若是另一個已知標籤就視為空白
//   明細表格：用該表的垂直格線切出真正的欄位邊界，依文字邊界框中心點歸欄，
//             欄名由表頭列用同一套規則得出。中間或尾端空白都不會錯位
//   跨行儲存格：同一個序號的連續列合併成一筆，文字接起來、數字取第一個非空值
// 抓不到就回 null 並記進 warnings，不猜值；呼叫端一定要讓人先核對再建單。

const EMR_MOVETOEX = 27;
const EMR_LINETO = 54;
const EMR_EXTTEXTOUTA = 83;
const EMR_EXTTEXTOUTW = 84;
const ROW_TOLERANCE = 12; // 同一列的 y 容差（EMF 邏輯單位）

const norm = s => String(s || '').replace(/\s+/g, '');
const stripColon = s => norm(s).replace(/[:：]$/, '');
const isSeq = s => /^\d{3,4}$/.test(norm(s || ''));

// 表單上所有「標籤」文字：用來判斷某一格是欄位名而不是值（很多格沒有冒號）
const LABELS = new Set([
  '製造單號', '加工單號', '工令單號', '訂單號碼', '派工日期', '客戶名稱', '區域', '產品型號', '交貨日期',
  '油污', '毛邊', '對目', '平坦度', '待料中', '零星裁剪', '備料人員',
  '寬度公差', '長度公差', '對角線公差', '齒輪', '軋平後T', '軋平後W', '模具', '衝擊力', '機器SPM', '送料設定',
  '產品', '品管', '要點', '裁剪方式', '包裝方式', '用料備註', '製造要點', '操作機台', '操作員',
  '備註', '開始時間', '完成時間', '經理', '廠長', '生管', '填表員', '表單編號', '頁次',
].map(stripColon));

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
          // 位置一律用 rclBounds，不用 ptlReference——後者會隨對齊方式（右對齊數字）改變意義
          if (s) texts.push({ page, text: s, left, right, top, bottom, y: top });
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
    else rows.push({ page: t.page, y: t.y, cells: [t] });
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

// ── 3. 格線切欄 ─────────────────────────────────────────────────────────────
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

const colIndex = (cell, bounds) => bounds.filter(b => b <= (cell.left + cell.right) / 2).length;

// ── 4. 表頭欄位取值 ─────────────────────────────────────────────────────────
export function findRight(rows, label) {
  const want = stripColon(label);
  for (const r of rows) {
    for (let i = 0; i < r.cells.length; i++) {
      if (stripColon(r.cells[i].text) !== want) continue;
      const next = r.cells[i + 1];
      if (!next || LABELS.has(stripColon(next.text))) return null; // 右邊是另一個標籤 → 這格沒填
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
export function toNum(s) {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── 5. 讀所有明細表：表頭列以「序號」開頭，往下讀到不是序號列為止 ──────────────
function readTables(rows, lines) {
  const tables = [];
  for (let hi = 0; hi < rows.length; hi++) {
    if (stripColon(rows[hi].texts[0] || '') !== '序號') continue;
    const header = rows[hi];
    let last = hi;
    for (let i = hi + 1; i < rows.length; i++) {
      if (!isSeq(rows[i].texts[0])) break;
      last = i;
    }
    if (last === hi) { tables.push({ columns: header.texts.map(t => t.trim()), records: [], empty: true }); continue; }

    const bounds = columnBoundaries(lines, header.page, header.top, rows[last].bottom);
    const columns = [];
    if (bounds.length) for (const c of header.cells) columns[colIndex(c, bounds)] = c.text.trim();
    else header.cells.forEach((c, i) => { columns[i] = c.text.trim(); });

    // 逐列歸欄；同序號的連續列合併成一筆（跨行儲存格）
    const records = [];
    const conflicts = [];
    for (let i = hi + 1; i <= last; i++) {
      const r = rows[i];
      const cellsByCol = {};
      r.cells.forEach((c, idx) => {
        const ci = bounds.length ? colIndex(c, bounds) : idx;
        const name = columns[ci] ?? `col${ci}`;
        cellsByCol[name] = cellsByCol[name] ? `${cellsByCol[name]} ${c.text.trim()}` : c.text.trim();
      });
      const seq = cellsByCol[columns[0]] ?? null;
      const prev = records[records.length - 1];
      if (prev && seq && prev[columns[0]] === seq) {
        for (const [k, v] of Object.entries(cellsByCol)) {
          if (k === columns[0]) continue;
          if (prev[k] == null || prev[k] === '') prev[k] = v;
          else if (prev[k] !== v) {
            // 文字接續換行；數字不一致才是真衝突
            if (toNum(prev[k]) != null && toNum(v) != null) conflicts.push(`序號 ${seq} 的「${k}」出現兩個值：${prev[k]} / ${v}`);
            else prev[k] = `${prev[k]}\n${v}`;
          }
        }
      } else {
        records.push(cellsByCol);
      }
    }
    tables.push({ columns: columns.filter(Boolean), records, conflicts, noGrid: !bounds.length });
  }
  return tables;
}

// 依欄名關鍵字取值
const pick = (rec, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(rec).find(name => norm(name).includes(norm(k)));
    if (hit && rec[hit] !== '') return rec[hit];
  }
  return null;
};
const findTable = (tables, ...keys) =>
  tables.find(t => keys.every(k => t.columns.some(c => norm(c).includes(norm(k)))));

// ── 6. 主函式 ───────────────────────────────────────────────────────────────
export function parseQrp(buf) {
  const { texts, lines } = scan(buf);
  if (!texts.length) {
    return { ok: false, error: '檔案裡找不到文字（可能不是 QuickReport 匯出的 QRP）', warnings: [], raw: [] };
  }
  const rows = toRows(texts);
  const all = rows.map(r => norm(r.texts.join(''))).join('');
  const docType = all.includes('【製造單】') ? 'manufacture' : all.includes('【加工單】') ? 'process' : null;

  const tables = readTables(rows, lines);
  const fields = {
    docNo: findRight(rows, docType === 'process' ? '加工單號' : '製造單號'),
    workOrderNo: findRight(rows, '工令單號'),      // E 號：製造單與加工單靠它對應
    poNo: findRight(rows, '訂單號碼'),
    customer: findRight(rows, '客戶名稱'),
    area: findRight(rows, '區域'),
    productModel: findRight(rows, '產品型號'),
    plannedDate: parseRocDate(findRight(rows, '派工日期')),
    dueDate: parseRocDate(findRight(rows, '交貨日期')),
    machineNo: findRight(rows, '操作機台'),
    operator: findRight(rows, '操作員'),
    cutMethod: findRight(rows, '裁剪方式'),
    packMethod: findRight(rows, '包裝方式'),
    filledBy: findRight(rows, '填表員'),
    remark: findRight(rows, '備註'),
  };

  // 製造參數（製造單的品管要點區；加工單沒有這些欄位就都是 null）
  const params = {
    moldSpec: findRight(rows, '模具'),
    machineSPM: toNum(findRight(rows, '機器SPM')),
    feedSetting: findRight(rows, '送料設定'),
    impact: findRight(rows, '衝擊力'),
    gear: findRight(rows, '齒輪'),
    widthTolerance: findRight(rows, '寬度公差'),
    lengthTolerance: findRight(rows, '長度公差'),
    diagonalTolerance: findRight(rows, '對角線公差'),
    flatnessT: findRight(rows, '軋平後T'),
    flatnessW: findRight(rows, '軋平後W'),
    materialNote: findRight(rows, '用料備註'),
    manufactureNote: findRight(rows, '製造要點'),
  };

  // 領用材料：製造單是「訂單品名規格 / 訂單數 / 領用材料 / 數量 / 重量」，
  //           加工單是「領用材料 / 領用數量 / 總數 / 實際使用數量 / 餘庫存」
  const mt = findTable(tables, '領用材料');
  const materials = (mt?.records ?? []).map(rec => ({
    seq: pick(rec, '序號'),
    orderSpec: pick(rec, '訂單品名規格'),
    orderQty: toNum(pick(rec, '訂單數')),
    spec: pick(rec, '領用材料'),
    qty: toNum(pick(rec, '領用數量', '數量')),
    weight: toNum(pick(rec, '重量')),
    total: toNum(pick(rec, '總數')),
    actualQty: toNum(pick(rec, '實際使用數量')),
    stock: toNum(pick(rec, '餘庫存', '餘')),
  }));

  // 生產 / 裁剪明細：另一張有「品名規格」的表（製造單的領用表也含「訂單品名規格」，要排除）
  const it = tables.find(t => t !== mt && t.columns.some(c => norm(c).includes('品名規格')));
  const items = (it?.records ?? []).map(rec => ({
    seq: pick(rec, '序號'),
    spec: pick(rec, '生產品名規格', '品名規格'),
    qty: toNum(pick(rec, '派工數', '數量')),
    producedQty: toNum(pick(rec, '生產數')),
    productWeight: toNum(pick(rec, '成品重')),
    assignedWeight: toNum(pick(rec, '指定重')),
    theoreticalWeight: toNum(pick(rec, '理論重')),
    blades: toNum(pick(rec, '刀數')),
    manuSpec: pick(rec, '製造規格'),
    productSize: pick(rec, '產品寬長'),
    actualSpecQty: pick(rec, '實際領用規格'),
    oddSizeQty: pick(rec, '使用零星尺寸'),
  }));

  const warnings = [];
  if (!docType) warnings.push('認不出單別（不是【製造單】也不是【加工單】），請確認檔案');
  if (!fields.docNo) warnings.push(`抓不到${docType === 'process' ? '加工' : '製造'}單號`);
  if (!fields.workOrderNo) warnings.push('抓不到工令單號');
  if (!items.length) warnings.push(docType === 'process' ? '抓不到裁剪 / 加工明細' : '抓不到生產明細');
  if (!materials.length) warnings.push('抓不到領用材料');
  for (const t of tables) {
    if (t.noGrid) warnings.push('某張明細表找不到格線，欄位可能對不準，請逐項核對');
    for (const c of t.conflicts ?? []) warnings.push(c);
  }
  for (const i of items) {
    if (!i.spec) warnings.push(`明細 ${i.seq ?? '?'} 沒有品名規格`);
    if (i.qty == null) warnings.push(`明細 ${i.seq ?? '?'} 沒有數量`);
  }

  return {
    ok: warnings.length === 0,
    docType,                // 'manufacture'（F）| 'process'（G）
    fields,
    params,
    materials,
    items,
    tables,
    warnings,
    pages: Math.max(...texts.map(t => t.page)),
    raw: rows.map(r => ({ page: r.page, y: r.y, texts: r.texts })), // 供確認畫面顯示原文
  };
}
