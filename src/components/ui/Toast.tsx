'use client'

import { createContext, useCallback, useContext, useState, ReactNode } from 'react'

interface Toast {
  id: string
  msg: string
}

interface ToastCtx {
  push: (msg: string) => void
}

const Ctx = createContext<ToastCtx | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((msg: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((cur) => [...cur, { id, msg }])
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 2400)
  }, [])

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className="toast">{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
