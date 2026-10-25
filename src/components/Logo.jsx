import { BRAND, COLORS } from '../brand'

// Gatherwell mark: a central node (the church / HQ) with spokes to three
// connected people/branches, held together by an arc — a gathering "well".
// Geometry is on a 40×40 grid so it stays crisp from 16px favicons up to print.
export function LogoMark({ size = 32, tile = true, onDark = false, title = BRAND.name }) {
  const bg = onDark ? COLORS.ivory : COLORS.forest
  const node = onDark ? COLORS.forest : COLORS.ivory
  const line = onDark ? COLORS.sage : COLORS.sageLight
  const hub = COLORS.amber
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg">
      {tile && <rect width="40" height="40" rx="10" fill={bg} />}
      <g fill="none" stroke={tile ? line : COLORS.sage} strokeWidth="2.2" strokeLinecap="round">
        <path d="M9 21.5 A 12 12 0 0 0 31 21.5" />
        <path d="M20 15.5 L9 21.5 M20 15.5 L20 31 M20 15.5 L31 21.5" />
      </g>
      <circle cx="20" cy="14.5" r="4.2" fill={hub} />
      <circle cx="9" cy="21.5" r="3.6" fill={tile ? node : COLORS.forest} />
      <circle cx="20" cy="31" r="3.6" fill={tile ? node : COLORS.forest} />
      <circle cx="31" cy="21.5" r="3.6" fill={tile ? node : COLORS.forest} />
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
