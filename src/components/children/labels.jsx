// Prints children's name labels and the parent's pickup tag on 4 × 2 inch labels (Dymo, Brother and similar).
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

const W = '4in', H = '2in'
const page = { width: W, height: H, boxSizing: 'border-box', padding: '0.12in 0.16in', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontFamily: 'Inter, Arial, sans-serif', color: '#000', pageBreakAfter: 'always', breakAfter: 'page', overflow: 'hidden' }

function ChildLabel({ k, day }) {
  return (
    <div style={page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.05, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.firstName}</div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{k.lastName || ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '0.05em', lineHeight: 1.05 }}>{k.code}</div>
          <div style={{ fontSize: 9 }}>pickup code</div>
        </div>
      </div>
      {k.alert
        ? <div style={{ background: '#000', color: '#fff', fontSize: 13, fontWeight: 700, padding: '3px 7px', alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>⚠ ALLERGY: {String(k.alert).toUpperCase()}</div>
        : k.medical ? <div style={{ border: '2px solid #000', fontSize: 11, fontWeight: 700, padding: '2px 6px', alignSelf: 'flex-start' }}>MEDICAL NOTE: ask a leader</div> : <div style={{ fontSize: 11 }}>{k.firstTime ? 'First visit — welcome!' : ''}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
        <span><b>{k.roomName}</b></span>
        <span>{day}</span>
      </div>
    </div>
  )
}

function ParentTag({ code, names, orgName }) {
  return (
    <div style={{ ...page, borderTop: '0.08in solid #000' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 600 }}><span>PICKUP TAG</span><span>{orgName}</span></div>
      <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '0.1em', textAlign: 'center', lineHeight: 1 }}>{code}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, gap: 8 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{names.join(' · ')}</span><span style={{ whiteSpace: 'nowrap' }}>Show this to collect</span></div>
    </div>
  )
}

/** Opens the print dialog with one label per child plus the parent's tag. */
export function printLabels({ checkins, code, orgName, parentTag = true }) {
  const day = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const host = document.createElement('div')
  host.id = 'kid-labels'
  const style = document.createElement('style')
  style.textContent = `@page { size: ${W} ${H}; margin: 0 } @media screen { #kid-labels { display: none } } @media print { body > *:not(#kid-labels) { display: none !important } html, body { margin: 0; background: #fff !important } }`
  document.head.appendChild(style)
  document.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => root.render(
    <>
      {checkins.map(k => <ChildLabel key={k.id} k={k} day={day} />)}
      {parentTag && <ParentTag code={code} names={checkins.map(k => k.firstName)} orgName={orgName} />}
    </>,
  ))
  const cleanup = () => { root.unmount(); host.remove(); style.remove(); window.removeEventListener('afterprint', cleanup) }
  window.addEventListener('afterprint', cleanup)
  setTimeout(() => window.print(), 50)
}
