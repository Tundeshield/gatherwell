// After `vite build`: writes a real HTML page for each public URL, with its own title, description
// and link-preview tags, and the page's content already in it. Also writes robots.txt and sitemap.xml.
// Netlify serves dist/pricing.html for /pricing, dist/legal/privacy.html for /legal/privacy, and so on.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIST = 'dist'
const SITE = 'https://gatherhq.org'
const staging = process.env.VITE_APP_ENV === 'staging'

const PAGES = [
  { url: '/', file: 'index.html', render: true, title: 'GatherHQ: church attendance, first-timer follow-up and children’s check-in', description: 'QR check-in, first-timer follow-up, children’s check-in with pickup codes, events and reports for churches and church networks. Start free.' },
  { url: '/pricing', file: 'pricing.html', render: true, title: 'Pricing · GatherHQ', description: 'Simple pricing for churches of every size, with everything included. Start free, no card needed.' },
  { url: '/legal/privacy', file: 'legal/privacy.html', render: true, title: 'Privacy Policy · GatherHQ', description: 'How GatherHQ handles personal information, under Nigeria’s Data Protection Act 2023, the UK GDPR and the EU GDPR.' },
  { url: '/legal/terms', file: 'legal/terms.html', render: true, title: 'Terms of Service · GatherHQ', description: 'The terms for using GatherHQ.' },
  { url: '/legal/refunds', file: 'legal/refunds.html', render: true, title: 'Refund Policy · GatherHQ', description: 'Full refunds within 30 days of any payment.' },
  { url: '/legal/dpa', file: 'legal/dpa.html', render: true, title: 'Data Processing Agreement · GatherHQ', description: 'The Data Processing Agreement GatherHQ signs with every church.' },
  { url: '/signup', file: 'signup.html', render: false, title: 'Create your church account · GatherHQ', description: 'Set up GatherHQ for your church in minutes. Start free, no card needed.' },
  { url: '/login', file: 'login.html', render: false, title: 'Sign in · GatherHQ', description: 'Sign in to GatherHQ.' },
]

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const ORG_LD = {
  '@context': 'https://schema.org', '@type': 'Organization', name: 'GatherHQ', url: SITE, logo: `${SITE}/favicon.svg`,
  parentOrganization: { '@type': 'Organization', name: 'Avelon Technologies Ltd' },
  address: { '@type': 'PostalAddress', streetAddress: 'Alma 2 Unit 2, Richmond Gate Estate, Lekki Peninsula II', addressLocality: 'Lagos', postalCode: '101245', addressCountry: 'NG' },
  email: 'hello@gatherhq.org',
}
const APP_LD = {
  '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'GatherHQ', applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
  description: 'Church attendance, first-timer follow-up, children’s check-in and events.', url: SITE,
}

function page(template, p, body) {
  let html = template
  const set = (re, val) => { html = html.replace(re, val) }
  set(/<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`)
  set(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(p.description)}" />`)
  set(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${SITE}${p.url}" />`)
  set(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${SITE}${p.url}" />`)
  set(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(p.title)}" />`)
  set(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(p.description)}" />`)
  set(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${esc(p.title)}" />`)
  set(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${esc(p.description)}" />`)
  const extra = [
    staging ? '<meta name="robots" content="noindex, nofollow" />' : '',
    p.url === '/' ? `<script type="application/ld+json">${JSON.stringify(ORG_LD)}</script><script type="application/ld+json">${JSON.stringify(APP_LD)}</script>` : '',
  ].join('')
  html = html.replace('</head>', `${extra}</head>`)
  const content = body ?? `<main style="font-family:Inter,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem"><h1>${esc(p.title.replace(' · GatherHQ', ''))}</h1><p>${esc(p.description)}</p><p><a href="/">GatherHQ home</a></p></main>`
  return html.replace('<div id="root"></div>', `<div id="root">${content}</div>`)
}

execSync('npx vite build --ssr src/prerender.jsx --outDir dist-ssr --emptyOutDir --logLevel warn', { stdio: 'inherit' })
const { render } = await import(pathToFileURL(join(process.cwd(), 'dist-ssr/prerender.js')).href)
const template = readFileSync(join(DIST, 'index.html'), 'utf8')
if (!template.includes('<div id="root"></div>')) throw new Error('prerender: dist/index.html has no empty root')

for (const p of PAGES) {
  const out = join(DIST, p.file)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page(template, p, p.render ? render(p.url) : null))
}
// Every other URL (the app, check-in links) falls back to this: the plain shell with the default tags.
writeFileSync(join(DIST, 'app-shell.html'), staging ? template.replace('</head>', '<meta name="robots" content="noindex, nofollow" /></head>') : template)

writeFileSync(join(DIST, 'robots.txt'), staging
  ? 'User-agent: *\nDisallow: /\n'
  : `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /c/\nDisallow: /e/\nDisallow: /invite\n\nSitemap: ${SITE}/sitemap.xml\n`)
const today = new Date().toISOString().slice(0, 10)
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.filter(p => p.url !== '/login').map(p => `  <url><loc>${SITE}${p.url}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`)
rmSync('dist-ssr', { recursive: true, force: true })
console.log(`prerender: wrote ${PAGES.length} pages, robots.txt and sitemap.xml${staging ? ' (staging: not indexed)' : ''}`)
