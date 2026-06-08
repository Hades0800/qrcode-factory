// 日期 / 時間格式化 — 後端存 UTC，前端用 Asia/Taipei 顯示
const TZ = 'Asia/Taipei';

function twParts(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of f.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const p = twParts(iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function fmtTimeShort(iso) {
  if (!iso) return '';
  const p = twParts(iso);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const p = twParts(iso);
  return `${p.year}/${p.month}/${p.day}`;
}

// 「Asia/Taipei 視角下的 YYYY-MM-DD」，給分組/篩選用
export function twDateKey(iso) {
  if (!iso) return '';
  const p = twParts(iso);
  return `${p.year}-${p.month}-${p.day}`;
}

export function fmtDuration(sec) {
  if (!sec || sec < 0) return '0 秒';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + ' 分' + (s > 0 ? ' ' + s + ' 秒' : '');
  const h = Math.floor(m / 60);
  return h + ' 時 ' + (m % 60) + ' 分';
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
