import { useState } from 'react'

// Validated chart palette (dataviz validator: all checks pass on white).
export const CHART = { primary: '#0F7D5C', accent: '#B8842F', grid: '#ECEEE8', axis: '#69736E' }

// Stacked weekly bars. data: [{ label, title, values: [n1, n2] }], series: [{ name, color }]
export function StackedBars({ data, series, height = 200, formatLabel = (d) => d.label, emptyText = 'No data in this period yet.' }) {
  const [hover, setHover] = useState(null)
  const [table, setTable] = useState(false)
  const totals = data.map(d => d.values.reduce((a, b) => a + b, 0))
  const max = Math.max(1, ...totals)
  const nice = niceMax(max)
  const ticks = [0, nice / 2, nice]
  const W = 640, H = height, padL = 34, padB = 26, padT = 10
  const plotW = W - padL - 8, plotH = H - padB - padT
  const n = Math.max(data.length, 1)
  const slot = plotW / n
  const barW = Math.min(36, slot * 0.62)

  if (!data.length || totals.every(t => t === 0)) {
    return <div className="flex items-center justify-center rounded-lg border border-dashed border-mist-200 text-sm text-mist-400" style={{ height }}>{emptyText}</div>
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-mist-500">
        {series.map(s => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}
        <button type="button" onClick={() => setTable(t => !t)} className="ml-auto text-mist-500 underline-offset-2 hover:text-ink hover:underline">{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-mist-500"><th className="py-1.5 font-medium">Week of</th>{series.map(s => <th key={s.name} className="py-1.5 text-right font-medium">{s.name}</th>)}<th className="py-1.5 text-right font-medium">Total</th></tr></thead>
          <tbody>{data.map((d, i) => <tr key={i} className="border-t border-mist-100"><td className="py-1.5">{d.title || d.label}</td>{d.values.map((v, j) => <td key={j} className="tabular py-1.5 text-right">{v}</td>)}<td className="tabular py-1.5 text-right font-medium">{totals[i]}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Chart: ${series.map(s => s.name).join(' and ')} by week`} onMouseLeave={() => setHover(null)}>
            {ticks.map(t => {
              const y = padT + plotH - (t / nice) * plotH
              return <g key={t}><line x1={padL} x2={W - 8} y1={y} y2={y} stroke={CHART.grid} strokeWidth="1" /><text x={padL - 8} y={y + 4} textAnchor="end" fontSize="11" fill={CHART.axis} className="tabular">{fmtTick(t)}</text></g>
            })}
            {data.map((d, i) => {
              const x = padL + i * slot + (slot - barW) / 2
              let y = padT + plotH
              const segs = d.values.map((v, j) => {
                const h = (v / nice) * plotH
                y -= h
                const top = j === d.values.length - 1 || d.values.slice(j + 1).every(z => z === 0)
                // Rounded top on the last visible segment; 2px surface gap between segments.
                const gap = j > 0 && h > 0 ? 2 : 0
                return h > 0 ? <rect key={j} x={x} y={y} width={barW} height={Math.max(h - gap, 1)} rx={top ? 4 : 0} fill={series[j].color} opacity={hover === null || hover === i ? 1 : 0.45} /> : null
              })
              const showLabel = data.length <= 14 || i % Math.ceil(data.length / 12) === 0
              return (
                <g key={i}>
                  {segs}
                  {showLabel && <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill={CHART.axis}>{formatLabel(d)}</text>}
                  <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${d.title || d.label}: ${d.values.map((v, j) => `${series[j].name} ${v}`).join(', ')}`} />
                </g>
              )
            })}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-0 z-10 rounded-lg border border-mist-200 bg-white px-3 py-2 text-xs shadow-pop"
              style={{ left: `clamp(0px, calc(${((padL + hover * slot + slot / 2) / W) * 100}% - 70px), calc(100% - 150px))` }}>
              <div className="mb-1 font-medium text-ink">{data[hover].title || data[hover].label}</div>
              {series.map((s, j) => <div key={s.name} className="flex items-center gap-2 text-mist-600"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}<span className="tabular ml-auto pl-3 font-medium text-ink">{data[hover].values[j]}</span></div>)}
              <div className="mt-1 flex justify-between border-t border-mist-100 pt-1 text-mist-600">Total<span className="tabular font-medium text-ink">{totals[hover]}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Horizontal comparison bars (e.g. attendance by branch). Single series.
export function HBars({ rows, valueKey, labelKey = 'name', color = CHART.primary, format = (v) => v.toLocaleString() }) {
  const max = Math.max(1, ...rows.map(r => r[valueKey]))
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={i}>
          <div className="mb-1 flex justify-between text-sm"><span className="truncate text-ink">{r[labelKey]}</span><span className="tabular font-medium text-ink">{format(r[valueKey])}</span></div>
          <div className="h-2 rounded-full bg-mist-100"><div className="h-2 rounded-full" style={{ width: `${(r[valueKey] / max) * 100}%`, background: color, minWidth: r[valueKey] ? 4 : 0 }} /></div>
        </li>
      ))}
    </ul>
  )
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}
const fmtTick = (t) => t >= 1000 ? `${(t / 1000).toFixed(t % 1000 ? 1 : 0)}k` : String(t)

// Fill missing weeks so gaps show as zero rather than collapsing.
export function fillWeeks(rows, weeks, endDate = new Date()) {
  const byWeek = new Map(rows.map(r => [r.week, r]))
  const monday = new Date(endDate)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const out = []
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(monday); d.setDate(d.getDate() - i * 7)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ week: key, date: d, ...(byWeek.get(key) || { attendance: 0, first_timers: 0 }) })
  }
  return out
}
