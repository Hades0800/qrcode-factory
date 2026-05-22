// 共用工具函式 — 所有頁面引用
function $(id) { return document.getElementById(id); }

// ===== 圖示系統（Lucide-style line icons，inline SVG）=====
// fill 屬性的 icon 用 fill: true，其餘用 stroke
const ICON_SVG = {
  check:        { paths: '<polyline points="20 6 9 17 4 12"/>' },
  x:            { paths: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' },
  play:         { paths: '<polygon points="6 4 20 12 6 20 6 4"/>', fill: true },
  pause:        { paths: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', fill: true },
  user:         { paths: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
  box:          { paths: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  sparkles:     { paths: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>' },
  layers:       { paths: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  alert:        { paths: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  clock:        { paths: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
  coffee:       { paths: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>' },
  gear:         { paths: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
  ban:          { paths: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>' },
  edit:         { paths: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' },
  clipboard:    { paths: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' },
  menu:         { paths: '<line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/>' },
  chevronUp:    { paths: '<polyline points="18 15 12 9 6 15"/>' },
  chevronDown:  { paths: '<polyline points="6 9 12 15 18 9"/>' },
  moon:         { paths: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' },
  sun:          { paths: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>' },
  camera:       { paths: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>' },
  octagon:      { paths: '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>' },
  flag:         { paths: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
};

function icon(name, size, color) {
  const def = ICON_SVG[name];
  if (!def) return '';
  size = size || 16;
  const stroke = color || 'currentColor';
  const fill = def.fill ? stroke : 'none';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-3px;flex-shrink:0;">' + def.paths + '</svg>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, type) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = '';
  if (type) t.classList.add(type);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// 日期格式化
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtTimeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '0 秒';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + ' 分' + (s > 0 ? ' ' + s + ' 秒' : '');
  const h = Math.floor(m / 60);
  return h + ' 時 ' + (m % 60) + ' 分';
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + '分' + (s > 0 ? s + '秒' : '');
  return Math.floor(m / 60) + '時' + (m % 60) + '分';
}

function todayYmd() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0');
}

// 各機台每日工時目標（分鐘）— 本日匯總用
// workMinutes = 穩定生產目標、prepMinutes = 生產準備目標、capacityKg = 產能目標
const MACHINE_TARGETS = {
  'No1-350': { workMinutes: 280, prepMinutes: 200, capacityKg: 10000 },
  'No2-250': { workMinutes: 210, prepMinutes: 270, capacityKg: 1800  },
  'No3-60':  { workMinutes: 320, prepMinutes: 160, capacityKg: 1200  },
  'No4-90':  { workMinutes: 320, prepMinutes: 160, capacityKg: 1200  },
  'No5-40':  { workMinutes: 420, prepMinutes:  60, capacityKg: 500   },
  'No6-40':  { workMinutes: 420, prepMinutes:  60, capacityKg: 500   },
};

// 一張工單在「特定一天」內的工時分配（秒）
// 規則（兼顧 1) 同日進出 2) 跨日繼續生產 3) 不要被閒置工單灌水）：
//   prep:
//     - step 41 已在更早日期記過 → 今日 prep = 0（前一日就結束 prep 階段）
//     - 今日有 step 41 → prep = 今日第一筆活動 → 今日 step 41
//     - 還沒記過 step 41 → prep = 今日第一筆活動 → (今日 step 11 / 今日最後活動)
//   prod:
//     - 今日有 step 41 → prod = 今日 step 41 → (今日 step 11 / 今日最後活動)
//     - step 41 在更早日期、step 11 未記 → 今日仍在生產
//         prod 起點 = 今日第一筆 pause endAt（恢復生產時間）／否則用 dayStart
//         prod 終點 = (今日 step 11 / 今日最後活動 / Date.now()，取最後者)
//     - step 41 在更早日期、step 11 在今日 → prod = dayStart → step 11
//     扣掉今日範圍內的暫停秒數
//   abn = pause13 history 與當日重疊
function computeOrderPhasesForDay(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  function clip(start, end) {
    if (start == null || end == null || end <= start) return 0;
    const a = Math.max(start, dayStart);
    const b = Math.min(end, dayEnd);
    return b > a ? Math.max(0, Math.round((b - a) / 1000)) : 0;
  }
  const inToday = (t) => t != null && t >= dayStart && t < dayEnd;

  const entries = o.stepEntries || [];
  const allPauses = [
    ...((o.pause12 && o.pause12.history) || []),
    ...((o.pause13 && o.pause13.history) || []),
  ];

  // 蒐集今日範圍內的事件（用來判斷今日是否有任何活動）
  const todayEventTimes = [];
  entries.forEach(e => { const t = new Date(e.recordedAt).getTime(); if (inToday(t)) todayEventTimes.push(t); });
  allPauses.forEach(p => {
    if (p.startAt && inToday(new Date(p.startAt).getTime())) todayEventTimes.push(new Date(p.startAt).getTime());
    if (p.endAt && inToday(new Date(p.endAt).getTime())) todayEventTimes.push(new Date(p.endAt).getTime());
  });
  const step11Ms = o.step11At ? new Date(o.step11At).getTime() : null;
  if (inToday(step11Ms)) todayEventTimes.push(step11Ms);

  // 今日完全沒有任何實際事件 → 不算進今日匯總（避免閒置工單灌水）
  if (todayEventTimes.length === 0) {
    return { prepSec: 0, prodSec: 0, abnSec: 0 };
  }

  // step 41 全域
  const allStep41Times = entries.filter(e => e.stepNo === '41')
    .map(e => new Date(e.recordedAt).getTime())
    .sort((a, b) => a - b);
  const firstStep41Any = allStep41Times[0] || null;
  const todayStep41 = allStep41Times.find(t => inToday(t)) || null;
  const step41WasBefore = firstStep41Any != null && firstStep41Any < dayStart;
  const todayStep11 = inToday(step11Ms) ? step11Ms : null;

  // 今日 stepEntries
  const todayEntryTimes = entries
    .map(e => new Date(e.recordedAt).getTime())
    .filter(t => inToday(t))
    .sort((a, b) => a - b);
  const todayFirstEntry = todayEntryTimes[0] || null;
  const todayLastEvent = todayEventTimes.length > 0 ? Math.max(...todayEventTimes) : null;

  // ── PREP ──
  // 規則：只要今日有 stepEntry，就算今日的 prep（從今日第一筆 → 今日 step 41/11/最後活動）。
  // 跨日繼續生產但今日又重新走一次 prep + step 41 流程的場景（換規格、補登）也能正確算到。
  // 扣掉與 prep 區間重疊的暫停（午休等），跟 prod 的計算一致。
  let prepSec = 0;
  let prepStart = null;
  let prepEnd = null;
  if (todayFirstEntry != null) {
    prepStart = todayFirstEntry;
    prepEnd = todayStep41 != null
      ? todayStep41
      : (todayStep11 != null ? todayStep11 : todayLastEvent);
  }
  if (prepStart != null && prepEnd != null && prepEnd > prepStart) {
    const grossPrep = Math.round((prepEnd - prepStart) / 1000);
    let pauseInPrep = 0;
    allPauses.forEach(p => {
      if (!p.startAt) return;
      const ps = new Date(p.startAt).getTime();
      const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
      const a = Math.max(ps, prepStart);
      const b = Math.min(pe, prepEnd);
      if (b > a) pauseInPrep += Math.round((b - a) / 1000);
    });
    prepSec = Math.max(0, grossPrep - pauseInPrep);
  }

  // 「進行中」門檻：最後活動 1 小時內才視為現在還在做（延伸 prod 到當下）；
  // 超過 1 小時沒事件 → 視為被換到別張單，prod 凍結在最後事件，不要灌水。
  const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000;
  const isRecentlyActive = todayLastEvent != null && (Date.now() - todayLastEvent) < ACTIVE_THRESHOLD_MS;
  const nowCapped = Math.min(Date.now(), dayEnd);

  // ── PROD ──
  let prodSec = 0;
  let prodStart = null;
  let prodEnd = null;
  if (todayStep41 != null) {
    prodStart = todayStep41;
    if (todayStep11 != null) {
      prodEnd = todayStep11;
    } else {
      // 今日按了 step 41 但還沒按 step 11
      prodEnd = isRecentlyActive
        ? Math.max(todayLastEvent, nowCapped)
        : (todayLastEvent != null ? todayLastEvent : nowCapped);
    }
  } else if (step41WasBefore) {
    // 跨日繼續生產 — 找今日第一筆 pause endAt（恢復生產）；沒有就用今日 08:00（工作日開始）
    const todayResumes = allPauses
      .filter(p => p.endAt && inToday(new Date(p.endAt).getTime()))
      .map(p => new Date(p.endAt).getTime())
      .sort((a, b) => a - b);
    const shiftStart = dayStart + 8 * 3600 * 1000; // 今日 08:00
    prodStart = todayResumes[0] != null ? todayResumes[0] : shiftStart;
    if (todayStep11 != null) {
      prodEnd = todayStep11;
    } else {
      prodEnd = isRecentlyActive
        ? Math.max(todayLastEvent, nowCapped)
        : (todayLastEvent != null ? todayLastEvent : prodStart);
    }
  }
  if (prodStart != null && prodEnd != null && prodEnd > prodStart) {
    const grossProd = Math.round((prodEnd - prodStart) / 1000);
    // 扣暫停：與「prod 區間」重疊的部分，而不是整個今日。
    // 例：跨日休息 17:00→隔日 08:00 落在 prod 區間 (08:20→10:57) 之前，不該被扣。
    let pauseInProd = 0;
    allPauses.forEach(p => {
      if (!p.startAt) return;
      const ps = new Date(p.startAt).getTime();
      const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
      const a = Math.max(ps, prodStart);
      const b = Math.min(pe, prodEnd);
      if (b > a) pauseInProd += Math.round((b - a) / 1000);
    });
    prodSec = Math.max(0, grossProd - pauseInProd);
  }

  // ── ABN（異常停線 pause13 與當日重疊）──
  let abnSec = 0;
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (!p.startAt) return;
    const ps = new Date(p.startAt).getTime();
    const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
    abnSec += clip(ps, pe);
  });

  // ── 狀態：用來標示為什麼合計可能不到 480 分 ──
  let status = 'unknown';
  if (todayStep11 != null) status = 'finished';            // 今日已完成
  else if (step41WasBefore) status = 'cross_day';          // 跨日繼續生產（step 41 在更早）
  else if (todayStep41 != null) status = 'active';         // 今日進行中（step 41 已按）
  else if (todayFirstEntry != null) status = 'prep_only';  // 只記了 step 40，還沒按生產開始

  return { prepSec, prodSec, abnSec, status };
}

// 新製規格差異項目 key → 簡短顯示
// 舊鍵（raw/dim）保留以相容歷史資料；新版單選 UI 使用 mold/mat/swm
const NEW_SPEC_ASPECT_LABELS = {
  raw: '原料',        // 舊鍵：相容過去多選
  dim: '長寬',        // 舊鍵：相容過去多選
  mold: '模具',
  mat:  '材料',
  swm:  'SWM/LWM',
};
function formatNewSpecAspects(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) return '';
  return aspects.map(k => NEW_SPEC_ASPECT_LABELS[k] || k).join('、');
}
// 完整顯示串：「新製規格-X」；無 aspects 就顯示「新製規格」
function formatNewSpecLabel(aspects) {
  const s = formatNewSpecAspects(aspects);
  return s ? '新製規格-' + s : '新製規格';
}

// 每張工單的狀態 → 顯示文字 + 顏色（給匯總表用小徽章）
const ORDER_STATUS_BADGE = {
  finished:  { text: '已完成',     color: '#2ea043', bg: '#e6f7ea' },
  active:    { text: '進行中',     color: '#1f6feb', bg: '#e7f0ff' },
  cross_day: { text: '跨日進行',   color: '#b8860b', bg: '#fff8e8' },
  prep_only: { text: '準備中',     color: '#8e8e93', bg: '#f0f0f3' },
  unknown:   { text: '—',         color: '#8e8e93', bg: '#f0f0f3' },
};
function renderOrderStatusBadge(statusKey) {
  const s = ORDER_STATUS_BADGE[statusKey] || ORDER_STATUS_BADGE.unknown;
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;background:${s.bg};color:${s.color};margin-left:4px;">${s.text}</span>`;
}

// 更換範圍符號 → 顯示文字
function scopeLabel(s) {
  if (s === '@') return '原料更換';
  if (s === '#') return '模刀具更換';
  if (s === '@#') return '原料與模刀具更換';
  if (s === 'same') return '料模刀沿用前工單';
  return s || '';
}

function fmtHHMM(sec) {
  if (!sec || sec < 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// 工單對指定日期而言是否為「隔日生產」 = 最早事件落在指定日期之前
function isCrossDayOrder(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const times = [];
  if (o.actualStartDate) times.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => { if (e.recordedAt) times.push(new Date(e.recordedAt).getTime()); });
  ((o.pause12 && o.pause12.history) || []).forEach(p => { if (p.startAt) times.push(new Date(p.startAt).getTime()); });
  ((o.pause13 && o.pause13.history) || []).forEach(p => { if (p.startAt) times.push(new Date(p.startAt).getTime()); });
  if (times.length === 0) return false;
  return Math.min(...times) < dayStart;
}

// 工單在指定日期當天「有活動」？ = 工單實際事件區間與當日重疊
// 用「最後一筆實際事件」當區間結束點（不用 Date.now()），避免閒置未完成的工單
// 一直被算進每一天的匯總
function orderIsOnDate(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const candidates = [];
  if (o.actualStartDate) candidates.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => { if (e.recordedAt) candidates.push(new Date(e.recordedAt).getTime()); });
  ((o.pause12 && o.pause12.history) || []).forEach(p => {
    if (p.startAt) candidates.push(new Date(p.startAt).getTime());
    if (p.endAt) candidates.push(new Date(p.endAt).getTime());
  });
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (p.startAt) candidates.push(new Date(p.startAt).getTime());
    if (p.endAt) candidates.push(new Date(p.endAt).getTime());
  });
  if (o.step11At) candidates.push(new Date(o.step11At).getTime());
  if (candidates.length === 0) {
    // 無活動，回退到 plannedDate / productionDate 字串比對
    const d = o.plannedDate || o.productionDate;
    return d ? String(d).slice(0, 10) === ymd : false;
  }
  const start = Math.min(...candidates);
  const end = Math.max(...candidates);
  return start < dayEnd && end >= dayStart;
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// API 請求
async function api(path, options = {}) {
  try {
    const token = localStorage.getItem('token') || '';
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const method = (options.method || 'GET').toUpperCase();
    // fastify 對 POST/PUT/PATCH 若 Content-Type 是 application/json 但 body 空會回 FST_ERR_CTP_EMPTY_JSON_BODY
    // 這裡若呼叫端沒帶 body，自動補空物件確保通過解析
    let body;
    if (options.body !== undefined && options.body !== null) {
      body = JSON.stringify(options.body);
    } else if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
      body = '{}';
    }
    const res = await fetch(API_URL + path, {
      method,
      headers,
      body,
    });
    let data;
    try { data = await res.json(); }
    catch (e) { return { ok: false, status: res.status, error: '伺服器回應錯誤' }; }
    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('me');
      if (location.pathname.indexOf('index.html') === -1) {
        alert('登入已逾期');
        location.href = 'index.html';
      }
      return { ok: false, status: 401, error: data.error || '請重新登入' };
    }
    if (res.status === 403) return { ok: false, status: 403, error: data.error || '權限不足', data };
    if (!res.ok) return { ok: false, status: res.status, error: data.error || '操作失敗', data };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: '網路錯誤：' + (err && err.message ? err.message : err) };
  }
}

// 下拉選單通用綁定
function initDropdownMenu() {
  const menuBtn = $('menuBtn');
  const dropMenu = $('dropMenu');
  if (!menuBtn || !dropMenu) return;
  menuBtn.onclick = () => dropMenu.classList.toggle('show');
  document.addEventListener('click', e => {
    if (!dropMenu.contains(e.target) && !menuBtn.contains(e.target)) {
      dropMenu.classList.remove('show');
    }
  });
}

// 登入狀態通用
function getMe() {
  return JSON.parse(localStorage.getItem('me') || 'null');
}

function requireLogin() {
  const token = localStorage.getItem('token');
  const me = getMe();
  if (!token || !me) {
    alert('請先登入');
    location.href = 'index.html';
    return null;
  }
  return me;
}
