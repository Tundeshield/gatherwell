// Link previews for a church's check-in and event links. When WhatsApp, Facebook, Google and other
// preview robots fetch /c/… or /e/…, put the church and event name in the page's title and
// preview tags. People's browsers are passed straight through.
const BOTS = /whatsapp|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|skypeuripreview|googlebot|bingbot|applebot|embedly|pinterest|redditbot|iframely/i
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export default async (request, context) => {
  if (!BOTS.test(request.headers.get('user-agent') || '')) return
  const url = new URL(request.url)
  const [, kind, token] = url.pathname.split('/')
  if (!/^[A-Za-z0-9]{6,40}$/.test(token || '')) return
  const res = await context.next()
  try {
    const api = await fetch(`${url.origin}/api/public/${kind === 'c' ? 'g' : 'e'}/${token}`, { headers: { accept: 'application/json' } })
    if (!api.ok) return res
    const d = await api.json()
    let title, description
    if (kind === 'c') {
      title = `${d.gathering?.name || 'Check in'} · ${d.orgName}`
      description = `Check in at ${d.orgName}${d.branchName ? ` (${d.branchName})` : ''}. First time here? You’re welcome. It takes a few seconds.`
    } else {
      const when = d.event?.startsAt ? new Date(d.event.startsAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: d.timezone || 'Africa/Lagos' }) : ''
      title = `${d.event?.name || 'Event'} · ${d.orgName}`
      description = [when, d.event?.location, 'Register online in a few seconds.'].filter(Boolean).join(' · ')
    }
    let html = await res.text()
    const set = (re, v) => { html = html.replace(re, v) }
    set(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    set(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(description)}" />`)
    set(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(title)}" />`)
    set(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(description)}" />`)
    set(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${esc(url.href)}" />`)
    set(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${esc(title)}" />`)
    set(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${esc(description)}" />`)
    set(/<link rel="canonical" href="[^"]*"\s*\/?>/, '')
    html = html.replace('</head>', '<meta name="robots" content="noindex" /></head>')
    const headers = new Headers(res.headers); headers.delete('content-length')
    return new Response(html, { status: res.status, headers })
  } catch { return res }
}

export const config = { path: ['/c/*', '/e/*'] }
