// 共用工具函式 — 所有頁面引用
function $(id) { return document.getElementById(id); }

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
