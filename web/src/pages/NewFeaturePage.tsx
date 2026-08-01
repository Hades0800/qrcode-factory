import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import type { Me, Order } from '../api/types'

// 新功能頁占位：目前先當作整個 React 技術棧的煙霧測試
// （驗證登入狀態共用 + API 串接皆正常）。
// 等你提供新功能規格後，這頁的內容會換成實際功能。
export default function NewFeaturePage({ me }: { me: Me }) {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const r = await api<{ orders: Order[] }>('/api/orders?limit=1')
      setLoading(false)
      if (!r.ok) {
        toast(r.error, 'error')
        return
      }
      setCount(r.data.orders?.length ?? 0)
      toast('React 頁已連上 API', 'success')
    })()
  }, [toast])

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22 }}>新功能（React 試點）</h1>
      <p style={{ color: '#6e6e73' }}>
        登入身分：<strong>{me.displayName}</strong>
        {me.isAdmin ? '（管理員）' : me.isPlanner ? '（生管）' : ''}
      </p>
      <div style={{ marginTop: 16, padding: 16, border: '1px solid #e5e5ea', borderRadius: 12 }}>
        {loading
          ? 'API 連線測試中…'
          : count === null
            ? 'API 連線失敗（見右下提示）'
            : `✓ 技術棧就緒：已連上後端 API（測試查詢回傳 ${count} 筆）。`}
      </div>
      <p style={{ marginTop: 24, fontSize: 13, color: '#6e6e73' }}>
        這是漸進式遷移的第一個 React 頁，與現有 8 個 HTML 頁共存。
        告知新功能規格後即可在此開發。
      </p>
    </div>
  )
}
