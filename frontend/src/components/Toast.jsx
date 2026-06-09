import { createContext, useContext, useCallback, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);   // { text, type }

  const toast = useCallback((text, type = '') => {
    setMsg({ text, type, id: Date.now() });
    setTimeout(() => setMsg(null), 2400);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {msg && (
        <div className={`toast ${msg.type}`} key={msg.id}>
          {msg.text}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必須在 ToastProvider 內');
  return ctx;
}
