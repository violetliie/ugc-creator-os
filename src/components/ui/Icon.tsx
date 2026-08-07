import Image from 'next/image'

interface IconProps {
  name: string
  size?: number
  style?: React.CSSProperties
  className?: string
}

export default function Icon({ name, size = 16, style, className }: IconProps) {
  return (
    <Image
      src={`/assets/icons/${name}.svg`}
      width={size}
      height={size}
      className={`ic${className ? ' ' + className : ''}`}
      alt=""
      style={style}
      draggable={false}
    />
  )
}
