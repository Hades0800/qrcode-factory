import { useEffect, useState } from 'react'
import { requireLogin } from './utils/auth'
import { ToastProvider } from './components/Toast'
import NewFeaturePage from './pages/NewFeaturePage'
import type { Me } from './api/types'

export default function App() {
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    // 未登入會在 requireLogin 內導回舊版 index.html 登入頁
    setMe(requireLogin())
  }, [])

  if (!me) return null

  return (
    <ToastProvider>
      <NewFeaturePage me={me} />
    </ToastProvider>
  )
}
