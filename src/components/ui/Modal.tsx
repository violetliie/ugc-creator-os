'use client'

import { useEffect } from 'react'

interface ModalProps {
  size?: 'sm' | 'md' | 'lg'
  onClose?: () => void
  title?: string
  sub?: string
  children: React.ReactNode
  footer?: React.ReactNode
  headerRight?: React.ReactNode
}

export default function Modal({ size = 'md', onClose, title, sub, children, footer, headerRight }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && onClose) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="scrim"
      onClick={(e) => { if ((e.target as HTMLElement).classList.contains('scrim') && onClose) onClose() }}
    >
      <div className={`modal ${size}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="right">
            {headerRight}
            {onClose && (
              <button className="close-btn" onClick={onClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
