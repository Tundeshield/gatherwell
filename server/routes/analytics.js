// Website visitors: the cookieless page-view beacon (public) and the admin console's statistics.
import { fb, plain } from '../firebase.js'
import { notFound } from '../http.js'
import { recordHit, dayOf } from '../analytics.js'
import { rangeOf } from './business.js'

const DAY = 86_400_000
const toD = (v) => (v ? (v.toDate ? v.toDate() : new Date(v)) : null)
const BOUNCE_S = 10

function top(rows, keyOf, n = 12) {
  const m = new Map()
  for (const r of rows) for (const k of [].concat(keyOf(r) ?? [])) if (k != null && k !== '') m.set(k, (m.get(k) || 0) + 1)
  const total = rows.length || 1
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 1000) / 10 }))
}

const isBounce = (v) => (v.pageviews || 0) <= 1 && (v.engaged_s || 0) < BOUNCE_S
const screenBucket = (s) => { const w = Number(String(s || '').split('x')[0]); return !w ? null : w < 480 ? 'Phone (under 480px)' : w < 1024 ? 'Tablet (480–1023px)' : w < 1440 ? 'Laptop (1024–1439px)' : 'Large (1440px+)' }

function visitOut(id, v) {
  return {
    id, day: v.day, first_at: plain(v.first_at), last_at: plain(v.last_at), pageviews: v.pageviews || 0, engaged_s: v.engaged_s || 0,
    landing: v.landing, exit: v.exit, pages: (v.pages || []).map(p => ({ path: p.p, at: plain(p.t), seconds: p.s || 0 })),
    source: v.source, channel: v.channel, referrer: v.referrer, ref_host: v.ref_host, utm: v.utm || {},
    country: v.country, country_code: v.country_code, region: v.region, city: v.city, geo_timezone: v.geo_timezone,
    device: v.device, os: v.os, os_version: v.os_version, browser: v.browser, browser_version: v.browser_version,
    screen: v.screen, viewport: v.viewport, dpr: v.dpr, touch: !!v.touch, language: v.language, languages: v.languages || [], browser_timezone: v.browser_timezone,
    events: v.events || [], signed_in: !!v.signed_in, internal: !!v.internal, bounce: isBounce(v),
    converted: v.converted_org_id ? { org_id: v.converted_org_id, name: v.converted_org_name, at: plain(v.converted_at) } : null,
  }
}

const FILTERS = {
  source: (v, x) => v.source === x, channel: (v, x) => v.channel === x, country: (v, x) => (v.country || 'Unknown') === x, city: (v, x) => v.city === x,
  device: (v, x) => v.device === x, browser: (v, x) => v.browser === x, os: (v, x) => v.os === x, page: (v, x) => (v.pages || []).some(p => p.p === x),
  landing: (v, x) => v.landing === x, campaign: (v, x) => v.utm?.campaign === x, language: (v, x) => (v.language || '').split('-')[0] === x,
  outcome: (v, x) => (x === 'signed_up' ? !!v.converted_org_id : x === 'started' ? (v.events || []).includes('signup_page') : x === 'customers' ? !!v.signed_in : true),
}

export default function (r) {
  r.post('/t', { auth: 'public' }, async ({ req, nf, body }) => recordHit({ req, nf, body }))

  r.get('/platform/visitors', { auth: 'platform' }, async ({ query }) => {
    const { db } = await fb()
    const now = new Date()
    const range = rangeOf({ range: 'today', ...query }, now)
    let q = db.collection('siteVisits')
    if (range.from) q = q.where('day', '>=', dayOf(range.from))
    if (range.to) q = q.where('day', '<', dayOf(range.to))
    const snap = await q.orderBy('day', 'desc').limit(8000).get()
    const includeInternal = query.internal === '1'
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(v => includeInternal || !v.internal)
    const internalCount = snap.size - rows.length
    const filters = Object.entries(query).filter(([k, v]) => k.startsWith('f_') && FILTERS[k.slice(2)] && v)
    for (const [k, x] of filters) rows = rows.filter(v => FILTERS[k.slice(2)](v, x))

    const n = rows.length
    const sum = (f) => rows.reduce((a, v) => a + (f(v) || 0), 0)
    const pageviews = sum(v => v.pageviews)
    const engaged = rows.map(v => v.engaged_s || 0).sort((a, b) => a - b)
    const signups = rows.filter(v => v.converted_org_id).length

    // Visitors per day (or per month for long ranges).
    const from = range.from || (rows.length ? new Date(`${rows[rows.length - 1].day}T00:00:00Z`) : new Date(now - 29 * DAY))
    const to = range.to || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY)
    const days = Math.round((to - from) / DAY)
    const monthly = days > 92
    const series = new Map()
    for (let t = from.getTime(); t < to.getTime(); t += DAY) { const k = monthly ? dayOf(new Date(t)).slice(0, 7) : dayOf(new Date(t)); if (!series.has(k)) series.set(k, { key: k, visitors: 0, pageviews: 0, signups: 0 }) }
    for (const v of rows) { const k = monthly ? v.day.slice(0, 7) : v.day; const s = series.get(k); if (s) { s.visitors++; s.pageviews += v.pageviews || 0; if (v.converted_org_id) s.signups++ } }

    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, visitors: 0 }))
    for (const v of rows) { const d = toD(v.first_at); if (d) hours[(d.getUTCHours() + 1) % 24].visitors++ } // Lagos time (UTC+1)

    const pageViews = new Map()
    for (const v of rows) for (const p of v.pages || []) { const e = pageViews.get(p.p) || { key: p.p, views: 0, visitors: new Set(), seconds: 0 }; e.views++; e.visitors.add(v.id); e.seconds += p.s || 0; pageViews.set(p.p, e) }

    const fiveMin = new Date(now - 5 * 60_000), thirtyMin = new Date(now - 30 * 60_000)
    const today = dayOf(now)
    const todayRows = range.to && range.from && dayOf(range.from) <= today && today < dayOf(range.to) ? rows.filter(v => v.day === today) : null

    return {
      range: { label: range.label, from: range.from?.toISOString() || null, to: range.to?.toISOString() || null, monthly },
      filters: Object.fromEntries(filters.map(([k, v]) => [k.slice(2), v])), internal_excluded: includeInternal ? 0 : internalCount, capped: snap.size >= 8000,
      kpis: {
        visitors: n, pageviews, pages_per_visitor: n ? Math.round((pageviews / n) * 10) / 10 : 0,
        avg_engaged_s: n ? Math.round(sum(v => v.engaged_s) / n) : 0, median_engaged_s: engaged.length ? engaged[Math.floor(engaged.length / 2)] : 0,
        bounce_rate: n ? Math.round((rows.filter(isBounce).length / n) * 1000) / 10 : 0,
        signup_page: rows.filter(v => (v.events || []).includes('signup_page')).length, signups, conversion: n ? Math.round((signups / n) * 1000) / 10 : 0,
        customers: rows.filter(v => v.signed_in).length,
        live_5m: rows.filter(v => toD(v.last_at) >= fiveMin).length, live_30m: rows.filter(v => toD(v.last_at) >= thirtyMin).length,
        today: todayRows ? todayRows.length : null,
      },
      series: [...series.values()],
      hours,
      breakdowns: {
        channel: top(rows, v => v.channel), source: top(rows, v => v.source), referrer: top(rows, v => v.referrer, 15),
        campaign: top(rows, v => v.utm?.campaign), landing: top(rows, v => v.landing),
        page: [...pageViews.values()].sort((a, b) => b.views - a.views).slice(0, 15).map(e => ({ key: e.key, count: e.visitors.size, views: e.views, avg_s: e.views ? Math.round(e.seconds / e.views) : 0, pct: n ? Math.round((e.visitors.size / n) * 1000) / 10 : 0 })),
        country: top(rows, v => v.country || 'Unknown').map(c => ({ ...c, code: rows.find(v => (v.country || 'Unknown') === c.key)?.country_code || null })),
        city: top(rows, v => (v.city ? `${v.city}${v.country_code ? `, ${v.country_code}` : ''}` : null), 15),
        device: top(rows, v => v.device), os: top(rows, v => v.os), browser: top(rows, v => v.browser),
        language: top(rows, v => (v.language || '').split('-')[0] || null), screen: top(rows, v => screenBucket(v.screen)),
        outcome: [
          { key: 'signed_up', label: 'Created a church account', count: signups },
          { key: 'started', label: 'Opened the sign-up page', count: rows.filter(v => (v.events || []).includes('signup_page')).length },
          { key: 'customers', label: 'Existing customers (signed in)', count: rows.filter(v => v.signed_in).length },
        ],
      },
      visitors: rows.sort((a, b) => (toD(b.last_at) || 0) - (toD(a.last_at) || 0)).slice(0, 300).map(v => visitOut(v.id, v)),
    }
  })

  r.get('/platform/visitors/:id', { auth: 'platform' }, async ({ params }) => {
    const { db } = await fb()
    const s = await db.collection('siteVisits').doc(String(params.id).slice(0, 60)).get()
    if (!s.exists) throw notFound()
    return visitOut(s.id, s.data())
  })
}
