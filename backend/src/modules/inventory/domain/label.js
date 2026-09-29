// QR 標籤的內容規則。來源:「QR Code MES 關聯表.xlsx」範例一(單一規格)、範例二(多規格)、範例三(原料)。
//
// QR 文字固定六項、每項一行,多規格就多行:
//   1 客戶/廠商            光輝  (北)
//   2 訂單編號             PO-12345
//   3 製造單號 , 加工單號   F1150810001 , G1150810006
//   4 倉庫儲位 , 機台編號   D-C-F123 , No.3
//   5 製造/納期 , 備註      2026.08.12 , 需委外鍍鋅與整平
//   6.. 規格 , 數量 , 重量  鋁 SKA20-8*4'*1200mm , 100 , 860
// 沒有的項目填「-」(範例三的原料標籤:訂單與製造單都是「-」)。
// 掃描端拿到的就是這段文字,不是 ID:parseQrText 把它還原成欄位,再對回 Label 表。
// 好處是標籤離線也看得懂、換系統也不作廢;代價是找標籤要靠製造單號/加工單號或整段文字比對。

export const LABEL_KINDS = {
  material: '原料',
  semi: '半成品',
  finished: '成品',
  outsourced: '委外加工',
};

// 入出庫的四個階段(關聯表的四個欄)
export const STAGES = {
  material: '原料',
  semi: '生產-半成品',
  finished: '生產/庫存-成品',
  outsourced: '委外/加工/包裝/整修',
};

const DASH = '-';
const SEP = ' , ';

// 台灣時區的 yyyy.mm.dd(標籤上的寫法)
export function fmtDate(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}.${mm}.${dd}`;
}

// 接受 2026.08.12 / 2026-08-12 / 2026/08/12,回台灣時區當天 00:00;認不出來回 null
export function parseDate(s) {
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  const m = String(s || '').trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());

export function numOrNull(v, integer = false) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.round(n) : n;
}

// 欄位 → 六項文字
export function buildQrText(f) {
  const clean = (x) => (x === null || x === undefined) ? '' : String(x).trim();
  const join = (...xs) => xs.map(clean).filter(Boolean).join(SEP);
  const lines = [
    clean(f.customer) || DASH,
    clean(f.poNo) || DASH,
    join(f.manuOrderNo, f.processOrderNo) || DASH,
    join(f.location, f.machineNo) || DASH,
    join(f.dueDate ? fmtDate(f.dueDate) : '', f.remark) || DASH,
  ];
  for (const s of f.specs || []) {
    const parts = [clean(s.spec)];
    if (s.qty !== null && s.qty !== undefined && s.qty !== '') parts.push(String(s.qty));
    if (s.weight !== null && s.weight !== undefined && s.weight !== '') parts.push(String(s.weight));
    if (parts[0]) lines.push(parts.join(SEP));
  }
  return lines.join('\n');
}

// 六項文字 → 欄位;不像標籤(少於五行)回 null
export function parseQrText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length < 5) return null;
  const split = (s) => s === DASH ? [] : s.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
  const [c, p, m, l, d] = lines;
  const mm = split(m), ll = split(l), dd = split(d);
  const f = {
    customer: c === DASH ? null : c,
    poNo: p === DASH ? null : p,
    manuOrderNo: mm[0] || null,
    processOrderNo: mm[1] || null,
    location: ll[0] || null,
    machineNo: ll[1] || null,
    dueDate: null,
    remark: null,
    specs: [],
  };
  if (dd.length) {
    const dt = parseDate(dd[0]);
    if (dt) {
      f.dueDate = dt;
      f.remark = dd.slice(1).join(SEP) || null;
    } else {
      f.remark = dd.join(SEP);
    }
  }
  for (const line of lines.slice(5)) {
    // 「規格 , 數量 , 重量」:數字從尾端抓,規格本身可以含任何符號(範例的 8*4'*1200mm)
    const parts = line.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
    let qty = null, weight = null;
    if (parts.length >= 3 && isNum(parts.at(-1)) && isNum(parts.at(-2))) {
      weight = Number(parts.pop());
      qty = Math.round(Number(parts.pop()));
    } else if (parts.length >= 2 && isNum(parts.at(-1))) {
      qty = Math.round(Number(parts.pop()));
    }
    if (parts.length) f.specs.push({ spec: parts.join(SEP), qty, weight });
  }
  return f;
}

// 標籤碼:LB-日期-6 碼亂數,印在標籤角落當備援(QR 壞掉時用它查)。撞號由 DB 的 unique 擋、呼叫端重試。
export function makeLabelCode(now = new Date()) {
  const day = fmtDate(now).replace(/\./g, '');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `LB-${day}-${rand}`;
}

// 掃描端共用:給標籤碼或 QR 文字,找回 Label。回 { label, fields }。
// 先比整段 qrText(最準),再用製造單號/加工單號找最新的一張。
export async function findLabelByScan(prisma, { code, text }) {
  const include = { specs: { orderBy: { seq: 'asc' } } };
  if (code) {
    const label = await prisma.label.findFirst({ where: { code: String(code).trim() }, include });
    return { label, fields: null };
  }
  const fields = parseQrText(text);
  if (!fields) return { label: null, fields: null };
  const norm = String(text).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean).join('\n');
  let label = await prisma.label.findFirst({ where: { qrText: norm }, include, orderBy: { createdAt: 'desc' } });
  if (!label && (fields.manuOrderNo || fields.processOrderNo)) {
    label = await prisma.label.findFirst({
      where: {
        ...(fields.manuOrderNo ? { manuOrderNo: fields.manuOrderNo } : {}),
        ...(fields.processOrderNo ? { processOrderNo: fields.processOrderNo } : {}),
      },
      include, orderBy: { createdAt: 'desc' },
    });
  }
  return { label, fields };
}
