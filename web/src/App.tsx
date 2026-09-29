import { useEffect, useState } from 'react'
import { requireLogin } from './utils/auth'
import { ToastProvider } from './components/Toast'
import InventoryPage from './pages/InventoryPage'
import ProductionPage from './pages/ProductionPage'
import CuttingPage from './pages/CuttingPage'
import ShippingPage from './pages/ShippingPage'
import type { Me } from './api/types'

// 依「簡易關聯圖」的四個系統切頁,用 hash 切換(#/inventory …),不用 router 套件。
// 順序照關聯表的流程:原料 → 製造 → 裁切 → 出貨。
const MODULES = [
  { key: 'inventory', name: '原料管理(入出庫)', page: InventoryPage },
  { key: 'production', name: '生產 MES', page: ProductionPage },
  { key: 'cutting', name: '裁切 MES', page: CuttingPage },
  { key: 'shipping', name: '出貨管理', page: ShippingPage },
] as const

type ModuleKey = typeof MODULES[number]['key']

function currentKey(): ModuleKey {
  const k = location.hash.replace(/^#\/?/, '').split('/')[0]
  return (MODULES.some(m => m.key === k) ? k : 'inventory') as ModuleKey
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [active, setActive] = useState<ModuleKey>(currentKey)

  useEffect(() => {
    // 未登入會在 requireLogin 內導回舊版 index.html 登入頁
    setMe(requireLogin())
    const onHash = () => setActive(currentKey())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!me) return null
  const mod = MODULES.find(m => m.key === active) || MODULES[0]
  const Page = mod.page

  return (
    <ToastProvider>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '16px 16px 48px', fontFamily: 'system-ui, sans-serif', color: '#1c1c1e' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 18 }}>上鎧 QR Code MES</strong>
          <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MODULES.map(m => (
              <a key={m.key} href={'#/' + m.key}
                style={{ padding: '6px 12px', borderRadius: 999, textDecoration: 'none', fontSize: 14,
                         background: m.key === active ? '#1d4ed8' : '#f2f2f7', color: m.key === active ? '#fff' : '#1c1c1e' }}>
                {m.name}
              </a>
            ))}
          </nav>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: '#6e6e73' }}>
            {me.displayName}{me.isAdmin ? '(管理員)' : me.isPlanner ? '(生管)' : ''}
          </span>
        </header>
        <Page />
      </div>
    </ToastProvider>
  )
}
