interface EmptyStateProps {
  glyph?: string
  label?: string
  hint?: string
}

export default function EmptyState({ glyph = '·', label, hint }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="glyph">{glyph}</div>
      {label && <div className="lbl">{label}</div>}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}
