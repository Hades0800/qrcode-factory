import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'info'
interface ToastState { msg: string; type: ToastType }

const ToastContext = createContext<(msg: string, type?: ToastType) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)

  const show = useCallback((msg: string, type: ToastType = 'info') => {
    setToast({ msg, type })
    window.setTimeout(() => setToast(null), 2400)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 30, left: '50%', transform: 'translateX(-50%)',
            background: toast.type === 'error' ? '#d93b3b' : toast.type === 'success' ? '#2e9e5b' : 'rgba(28,28,30,.95)',
            color: '#fff', padding: '14px 22px', borderRadius: 12, fontSize: 14, fontWeight: 600,
            zIndex: 200, boxShadow: '0 8px 24px rgba(0,0,0,.2)',
          }}
        >
          {toast.msg}
        </div>
      )}
    </ToastContext.Provider>
  )
}
