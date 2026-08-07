interface AvatarProps {
  name: string
  size?: number
}

export default function Avatar({ name, size = 28 }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?'
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </div>
  )
}
