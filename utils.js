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

// 一張工單在「特定一天」內的工時分配（秒）— 跨日工單會被切片
// ymd = 'YYYY-MM-DD'（瀏覽器本地時區）
// prep = 第一筆活動（含 step 40）→ 第一筆 stepNo='41' 之間，與當日重疊
//        (沒記 41 就用 step11At；都沒就用現在 — 表示還在準備中)
// prod = 第一筆 stepNo='41' → step11At 或現在，與當日重疊，再扣與當日重疊的暫停秒數
// abn  = pause13 history 與當日重疊的總秒數
function computeOrderPhasesForDay(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000; // 24h
  // 把 [start, end] 跟當日交集後換算成秒
  function clip(start, end) {
    if (start == null || end == null || end <= start) return 0;
    const a = Math.max(start, dayStart);
    const b = Math.min(end, dayEnd);
    return b > a ? Math.max(0, Math.round((b - a) / 1000)) : 0;
  }

  const entries = o.stepEntries || [];
  const allTimes = entries.map(e => new Date(e.recordedAt).getTime()).sort((a, b) => a - b);
  const firstActivity = allTimes.length > 0
    ? allTimes[0]
    : (o.actualStartDate ? new Date(o.actualStartDate).getTime() : null);
  const prodFirst = entries.filter(e => e.stepNo === '41')
    .map(e => new Date(e.recordedAt).getTime()).sort((a, b) => a - b)[0];

  // prep 結束點：優先 step 41，其次 step 11（工單在 prep 階段就完成），最後是現在
  const prepEnd = prodFirst != null
    ? prodFirst
    : (o.step11At ? new Date(o.step11At).getTime() : Date.now());
  const prepSec = (firstActivity != null) ? clip(firstActivity, prepEnd) : 0;

  let prodSec = 0;
  if (prodFirst != null) {
    const prodEnd = o.step11At ? new Date(o.step11At).getTime() : Date.now();
    const grossProd = clip(prodFirst, prodEnd);
    // 扣掉與當日重疊的暫停（pause12 + pause13 history）
    let pauseInDay = 0;
    [...((o.pause12 && o.pause12.history) || []), ...((o.pause13 && o.pause13.history) || [])].forEach(p => {
      if (!p.startAt) return;
      const ps = new Date(p.startAt).getTime();
      const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
      pauseInDay += clip(ps, pe);
    });
    prodSec = Math.max(0, grossProd - pauseInDay);
  }

  let abnSec = 0;
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (!p.startAt) return;
    const ps = new Date(p.startAt).getTime();
    const pe = p.endAt ? new Date(p.endAt).getTime() : Date.now();
    abnSec += clip(ps, pe);
  });

  return { prepSec, prodSec, abnSec };
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

// 工單在指定日期當天「有活動」？ = 工單實際時間區間與當日重疊
// 跨日工單（昨天開始今天還在跑）今天 / 昨天的匯總都會包含它
function orderIsOnDate(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  // 找 order 的第一個事件時刻（actualStartDate 或第一筆 stepEntry 或第一筆 pause）
  const candidates = [];
  if (o.actualStartDate) candidates.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => { if (e.recordedAt) candidates.push(new Date(e.recordedAt).getTime()); });
  ((o.pause12 && o.pause12.history) || []).forEach(p => { if (p.startAt) candidates.push(new Date(p.startAt).getTime()); });
  ((o.pause13 && o.pause13.history) || []).forEach(p => { if (p.startAt) candidates.push(new Date(p.startAt).getTime()); });
  if (candidates.length === 0) {
    // 無活動，回退到 plannedDate / productionDate 字串比對
    const d = o.plannedDate || o.productionDate;
    return d ? String(d).slice(0, 10) === ymd : false;
  }
  const start = Math.min(...candidates);
  const end = o.step11At ? new Date(o.step11At).getTime() : Math.max(Date.now(), Math.max(...candidates));
  return start < dayEnd && end > dayStart;
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
