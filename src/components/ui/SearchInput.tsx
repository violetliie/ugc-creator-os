import Image from 'next/image'

interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  style?: React.CSSProperties
}

export default function SearchInput({ value, onChange, placeholder = 'Search', style }: SearchInputProps) {
  return (
    <div className="search-wrap" style={style}>
      <Image src="/assets/icons/search.svg" className="ic" alt="" width={14} height={14} />
      <input
        className="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}
