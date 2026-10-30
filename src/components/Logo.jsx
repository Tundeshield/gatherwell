import { BRAND, COLORS } from '../brand'

// GatherHQ mark: six people gathered in a circle around one amber centre — the church
// gathered around each person. 40×40 grid; legible from 16px up.
const PEOPLE = [0, 1, 2, 3, 4, 5].map(i => {
  const a = (i * Math.PI) / 3 - Math.PI / 2
  return [+(20 + 10.5 * Math.cos(a)).toFixed(2), +(20 + 10.5 * Math.sin(a)).toFixed(2)]
})

export function LogoMark({ size = 32, tile = true, onDark = false, title = BRAND.name }) {
  const bg = onDark ? COLORS.ivory : COLORS.forest
  const dot = tile ? (onDark ? COLORS.forest : COLORS.ivory) : (onDark ? COLORS.ivory : COLORS.forest)
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      {tile && <rect width="40" height="40" rx="10" fill={bg} />}
      {PEOPLE.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.4" fill={dot} />)}
      <circle cx="20" cy="20" r="4.6" fill={COLORS.amber} />
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
