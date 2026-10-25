import { BRAND, COLORS } from '../brand'

// GatherHQ mark: one stroke sweeps into a G and wraps around a person (amber head) —
// the church gathered around each individual. 40×40 grid; legible from 16px up.
const PATH = 'M28.78 11.53 A12.2 12.2 0 1 0 29.54 27.6 L26.8 27.6 A6.8 4.2 0 0 0 13.2 27.6'

export function LogoMark({ size = 32, tile = true, onDark = false, title = BRAND.name }) {
  const bg = onDark ? COLORS.ivory : COLORS.forest
  const stroke = tile ? (onDark ? COLORS.forest : COLORS.ivory) : (onDark ? COLORS.ivory : COLORS.forest)
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      {tile && <rect width="40" height="40" rx="10" fill={bg} />}
      <path d={PATH} fill="none" stroke={stroke} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="20" cy="18.2" r="3.3" fill={COLORS.amber} />
    </svg>
  )
}

// Horizontal lockup used in the sidebar, auth screens and reports.
export default function Logo({ size = 28, onDark = false, showName = true, subtitle, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`}>
      <LogoMark size={size} onDark={onDark} />
      {showName && (
        <div className="min-w-0 leading-tight">
          <div className={`font-semibold tracking-tight ${onDark ? 'text-white' : 'text-ink'}`} style={{ fontSize: size * 0.6 }}>
            {BRAND.name}
          </div>
          {subtitle && <div className={`text-xs truncate ${onDark ? 'text-white/70' : 'text-mist-400'}`}>{subtitle}</div>}
        </div>
      )}
    </div>
  )
}
