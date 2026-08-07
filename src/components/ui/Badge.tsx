interface BadgeProps {
  kind?: string
  children: React.ReactNode
  title?: string
}

export default function Badge({ kind, children, title }: BadgeProps) {
  return (
    <span className={`badge${kind ? ' ' + kind : ''}`} title={title}>
      {children}
    </span>
  )
}
