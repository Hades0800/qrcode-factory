import type { CSSProperties, ReactNode } from 'react'

// 四個模組頁共用的小元件:卡片、欄位、按鈕、QR 圖。樣式跟舊頁一樣走系統字型與淺灰框。

export const KIND_NAMES: Record<string, string> = { material: '原料', semi: '半成品', finished: '成品', outsourced: '委外加工' }
export const STAGE_NAMES: Record<string, string> = {
  material: '原料', semi: '生產-半成品', finished: '生產/庫存-成品', outsourced: '委外/加工/包裝/整修',
}

export function Card({ title, children, style }: { title?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ marginTop: 16, padding: 16, border: '1px solid #e5e5ea', borderRadius: 12, background: '#fff', ...style }}>
      {title && <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>{title}</h2>}
      {children}
    </section>
  )
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#3a3a3c', gridColumn: wide ? '1 / -1' : undefined }}>
      <span>{label}</span>
      {children}
    </label>
  )
}

export const input: CSSProperties = { padding: '8px 10px', border: '1px solid #c7c7cc', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' }
export const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }

export function Btn({ children, onClick, kind = 'primary', disabled, type = 'button' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'
}) {
  const bg = kind === 'primary' ? '#1d4ed8' : kind === 'danger' ? '#b91c1c' : '#f2f2f7'
  const fg = kind === 'plain' ? '#1c1c1e' : '#fff'
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      style={{ padding: '8px 14px', border: 'none', borderRadius: 8, background: bg, color: fg, fontSize: 14, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  )
}

// QR 圖:沿用舊頁 qrcodes.html 的做法,由 qrText 產生;範例的「QR碼尺寸 160px」
export function QrImage({ text, size = 160 }: { text: string; size?: number }) {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=6&data=${encodeURIComponent(text)}`
  return <img src={src} width={size} height={size} alt="QR" style={{ border: '1px solid #e5e5ea', borderRadius: 8 }} />
}

export function fmt(d?: string | null): string {
  if (!d) return ''
  const t = new Date(d)
  if (Number.isNaN(t.getTime())) return String(d)
  return t.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
}

export function fmtDay(d?: string | null): string {
  if (!d) return ''
  const t = new Date(d)
  if (Number.isNaN(t.getTime())) return String(d)
  return t.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\//g, '.')
}

export const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
export const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e5ea', color: '#6e6e73', fontWeight: 600 }
export const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f2f2f7', verticalAlign: 'top' }
