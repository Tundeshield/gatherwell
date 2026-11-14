// Website visitor statistics for gatherhq.org (public pages only), without cookies.
// A visitor is counted once per day: their IP address and browser are mixed with a random salt
// that changes every day and is then deleted, so visits can't be traced back to an IP address
// or linked across days. The IP address itself is never stored.
import { createHash, randomBytes } from 'node:crypto'
import { fb } from './firebase.js'
import { clientIp } from './http.js'

const DAY = 86_400_000
export const KEEP_DAYS = 400 // about 13 months
const MAX_PAGES = 40
const MAX_VIEWS = 300

// Public marketing pages only. Church check-in, event and invite links are never tracked.
export const TRACKED = /^\/(?:|pricing|signup|login|legal\/[a-z-]+)\/?$/
const BOT = /bot|crawl|spider|slurp|preview|scrape|facebookexternalhit|whatsapp\/|telegram|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|go-http|java\/|okhttp|httpclient|phantom|selenium|puppeteer|playwright/i

export const dayOf = (d = new Date()) => d.toISOString().slice(0, 10)

let saltCache = { day: null, salt: null }
async function saltFor(db, day) {
  if (saltCache.day === day) return saltCache.salt
  const ref = db.collection('analyticsSalts').doc(day)
  const salt = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref)
    if (s.exists) return s.data().salt
    const v = randomBytes(24).toString('hex')
    tx.set(ref, { salt: v, created_at: new Date() })
    return v
  })
  saltCache = { day, salt }
  // Once a day: forget yesterday's-but-one salt and drop visits past the retention period.
  cleanup(db, day).catch(e => console.error('analytics cleanup', e.message))
  return salt
}

async function cleanup(db, day) {
  const keepSaltFrom = dayOf(new Date(Date.parse(day) - DAY))
  const salts = await db.collection('analyticsSalts').get()
  for (const s of salts.docs) if (s.id < keepSaltFrom) await s.ref.delete()
  const cutoff = dayOf(new Date(Date.parse(day) - KEEP_DAYS * DAY))
  const old = await db.collection('siteVisits').where('day', '<', cutoff).limit(400).get()
  if (!old.empty) { const b = db.batch(); old.docs.forEach(d => b.delete(d.ref)); await b.commit() }
}

export async function visitorKey(db, req, now = new Date()) {
  const day = dayOf(now)
  const salt = await saltFor(db, day)
  const ua = req.headers.get('user-agent') || ''
  const hash = createHash('sha256').update(`${salt}|${clientIp(req)}|${ua}`).digest('hex').slice(0, 24)
  return { day, id: `${day}_${hash}` }
}

// --- describing a visitor -----------------------------------------------------------
export function parseAgent(ua = '') {
  const m = (re) => ua.match(re)
  let os = 'Other', osVersion = null
  let r
  if ((r = m(/iPhone OS ([\d_]+)|iPad.*OS ([\d_]+)/))) { os = 'iOS'; osVersion = (r[1] || r[2]).replace(/_/g, '.') }
  else if ((r = m(/Android ([\d.]+)/))) { os = 'Android'; osVersion = r[1] }
  else if ((r = m(/Windows NT ([\d.]+)/))) { os = 'Windows'; osVersion = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[r[1]] || r[1] }
  else if ((r = m(/Mac OS X ([\d_]+)/))) { os = 'macOS'; osVersion = r[1].replace(/_/g, '.') }
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux/.test(ua)) os = 'Linux'

  let browser = 'Other', browserVersion = null
  const b = [
    ['Facebook app', /FBAN|FBAV\/([\d.]+)/], ['Instagram app', /Instagram ([\d.]+)/], ['LinkedIn app', /LinkedInApp/],
    ['Opera Mini', /Opera Mini\/([\d.]+)/], ['Opera', /OPR\/([\d.]+)/], ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/], ['UC Browser', /UCBrowser\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/],
  ]
  for (const [name, re] of b) { const x = ua.match(re); if (x) { browser = name; browserVersion = x[1]?.split('.')[0] || null; break } }

  const device = /iPad|Tablet|Tab(?!le)|Nexus (7|9|10)|SM-T|(Android(?!.*Mobile))/i.test(ua) ? 'Tablet'
    : /Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(ua) ? 'Mobile' : 'Desktop'
  return { device, os, os_version: osVersion, browser, browser_version: browserVersion }
}

const SOURCES = [
  ['Google', 'Search', /(^|\.)google\./], ['Bing', 'Search', /(^|\.)bing\.com$/], ['DuckDuckGo', 'Search', /duckduckgo\.com$/], ['Yahoo', 'Search', /(^|\.)search\.yahoo\.|^yahoo\./],
  ['ChatGPT', 'AI assistant', /chatgpt\.com$|chat\.openai\.com$/], ['Claude', 'AI assistant', /claude\.ai$/], ['Perplexity', 'AI assistant', /perplexity\.ai$/], ['Gemini', 'AI assistant', /gemini\.google\.com$/],
  ['Facebook', 'Social', /(^|\.)facebook\.com$|(^|\.)fb\.(com|me)$/], ['Instagram', 'Social', /instagram\.com$/], ['X (Twitter)', 'Social', /^t\.co$|(^|\.)(twitter|x)\.com$/],
  ['LinkedIn', 'Social', /linkedin\.com$|^lnkd\.in$/], ['WhatsApp', 'Messaging', /whatsapp\.com$|^wa\.me$/], ['YouTube', 'Social', /youtube\.com$|^youtu\.be$/], ['TikTok', 'Social', /tiktok\.com$/],
  ['Telegram', 'Messaging', /^t\.me$|telegram\.org$/],
  ['Email', 'Email', /^mail\.google\.com$|outlook\.(live|office)\.com$|^mail\.yahoo\.com$|mail\.zoho\./],
]
export function sourceOf({ refHost, utmSource, utmMedium, ua = '' }) {
  if (utmSource) {
    const s = String(utmSource).toLowerCase()
    const known = SOURCES.find(([n]) => n.toLowerCase().startsWith(s))
    const medium = utmMedium ? String(utmMedium).toLowerCase() : null
    return { source: known ? known[0] : s.replace(/(^|[\s_-])\w/g, x => x.toUpperCase()).replace(/[_-]/g, ' '), channel: medium === 'email' ? 'Email' : known ? known[1] : medium === 'cpc' || medium === 'paid' ? 'Paid' : 'Campaign' }
  }
  if (refHost) {
    const h = refHost.replace(/^www\.|^m\.|^l\.|^lm\./, '')
    const hit = SOURCES.find(([, , re]) => re.test(h))
    if (hit) return { source: hit[0], channel: hit[1] }
    return { source: h, channel: 'Referral' }
  }
  // In-app browsers often send no referrer.
  if (/FBAN|FBAV/.test(ua)) return { source: 'Facebook', channel: 'Social' }
  if (/Instagram/.test(ua)) return { source: 'Instagram', channel: 'Social' }
  if (/LinkedInApp/.test(ua)) return { source: 'LinkedIn', channel: 'Social' }
  return { source: 'Direct', channel: 'Direct' }
}

function geoOf(req, nf) {
  let g = nf?.geo
  if (!g) { try { const raw = req.headers.get('x-nf-geo'); if (raw) g = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) } catch {} }
  if (!g) return { country: null, country_code: req.headers.get('x-country') || null, region: null, city: null, geo_timezone: null }
  return { country: g.country?.name || null, country_code: g.country?.code || null, region: g.subdivision?.name || null, city: g.city || null, geo_timezone: g.timezone || null }
}

const clip = (v, n = 120) => (v == null || v === '' ? null : String(v).slice(0, n))
const cleanPath = (p) => { const s = String(p || '/').split(/[?#]/)[0].slice(0, 120); return s.length > 1 ? s.replace(/\/$/, '') : '/' }

// --- recording ---------------------------------------------------------------------------
export async function recordHit({ req, nf, body, now = new Date() }) {
  const ua = req.headers.get('user-agent') || ''
  if (!ua || BOT.test(ua)) return { ok: true, skipped: 'bot' }
  const path = cleanPath(body.path)
  if (!TRACKED.test(path)) return { ok: true, skipped: 'path' }
  const kind = ['pv', 'eng', 'ev'].includes(body.k) ? body.k : 'pv'
  const { db } = await fb()
  const { day, id } = await visitorKey(db, req, now)
  const cookies = req.headers.get('cookie') || ''
  const ref = db.collection('siteVisits').doc(id)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const v = snap.exists ? snap.data() : null
    if (kind !== 'pv' && !v) return // engagement without a page view: ignore
    if (v && v.pageviews >= MAX_VIEWS) return
    const pages = v?.pages ? [...v.pages] : []
    const patch = { last_at: now }
    if (/(^|;\s*)gw_session=/.test(cookies)) patch.signed_in = true
    if (/(^|;\s*)ghq_admin=/.test(cookies)) patch.internal = true

    if (kind === 'pv') {
      if (pages.length < MAX_PAGES) pages.push({ p: path, t: now, s: 0 })
      patch.pages = pages
      patch.pageviews = (v?.pageviews || 0) + 1
      patch.exit = path
      if (path === '/signup' && !(v?.events || []).includes('signup_page')) patch.events = [...(v?.events || []), 'signup_page']
      if (path === '/pricing' && !(v?.events || []).includes('pricing_page')) patch.events = [...(patch.events || v?.events || []), 'pricing_page']
    } else if (kind === 'eng') {
      const secs = Math.max(0, Math.min(1800, Math.round(Number(body.s) || 0)))
      patch.engaged_s = (v.engaged_s || 0) + secs
      for (let i = pages.length - 1; i >= 0; i--) if (pages[i].p === path) { pages[i] = { ...pages[i], s: (pages[i].s || 0) + secs }; break }
      patch.pages = pages
    } else {
      const name = String(body.name || '').replace(/[^a-z_]/g, '').slice(0, 32)
      if (name && !(v.events || []).includes(name) && (v.events || []).length < 20) patch.events = [...(v.events || []), name]
    }

    if (!v) {
      let refUrl = null, refHost = null
      try { if (body.ref) { const u = new URL(body.ref); const own = (req.headers.get('host') || '').replace(/^www\./, ''); if (u.host.replace(/^www\./, '') !== own) { refHost = u.host.toLowerCase(); refUrl = `${u.host}${u.pathname}`.slice(0, 200) } } } catch {}
      const utm = Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map(k => [k, clip(body.utm?.[k], 80)]))
      Object.assign(patch, {
        day, first_at: now, landing: path, engaged_s: 0, events: patch.events || [],
        referrer: refUrl, ref_host: refHost, utm, ...sourceOf({ refHost, utmSource: utm.source, utmMedium: utm.medium, ua }),
        ...geoOf(req, nf), ...parseAgent(ua),
        browser_timezone: clip(body.tz, 64), language: clip(body.lang, 20), languages: Array.isArray(body.langs) ? body.langs.slice(0, 5).map(l => clip(l, 20)) : [],
        screen: clip(body.screen, 20), viewport: clip(body.viewport, 20), dpr: Number(body.dpr) > 0 ? Math.min(5, Number(body.dpr)) : null, touch: !!body.touch,
        signed_in: !!patch.signed_in, internal: !!patch.internal,
      })
      tx.set(ref, patch)
    } else tx.update(ref, patch)
  })
  return { ok: true }
}

// Called when a church account is created, so a visit that ended in a signup is marked.
export async function markSignup(req, org) {
  try {
    const { db } = await fb()
    const { id } = await visitorKey(db, req)
    const ref = db.collection('siteVisits').doc(id)
    const s = await ref.get()
    if (!s.exists) return
    await ref.update({ converted_org_id: org.id, converted_org_name: org.name || null, converted_at: new Date(), events: [...new Set([...(s.data().events || []), 'signed_up'])] })
  } catch (e) { console.error('analytics signup', e.message) }
}
