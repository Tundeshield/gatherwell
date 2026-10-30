// One email renderer shared by the browser preview and the server's real send, so the preview
// is exactly what members receive. Pure functions only: no Node or browser APIs.

export const BLOCK_TYPES = ['heading', 'text', 'button', 'image', 'divider']
export const MERGE_FIELDS = [['{first_name}', 'First name'], ['{last_name}', 'Last name'], ['{church_name}', 'Church name']]
export const DEFAULT_COLOR = '#244E43'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const isHex = (c) => /^#[0-9a-fA-F]{6}$/.test(c || '')
export const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '')

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// White text on dark brand colours, ink text on light ones.
export const textOn = (hex) => (luminance(hex) > 0.4 ? '#243447' : '#FFFFFF')

export function merge(text, person = {}, org = {}) {
  return String(text ?? '')
    .replace(/\{first_name\}/g, person.first_name || 'friend')
    .replace(/\{last_name\}/g, person.last_name || '')
    .replace(/\{church_name\}/g, org.name || '')
}

// Escaped text with paragraphs, line breaks and clickable links.
function richText(text, color) {
  return String(text || '').trim().split(/\n\s*\n/).filter(Boolean).map((para) => {
    const html = esc(para).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:${color};text-decoration:underline">${u}</a>`).replace(/\n/g, '<br>')
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#3B4A5A">${html}</p>`
  }).join('')
}

// Cleans blocks from the editor or the API. Unknown types and unsafe links are dropped.
export function cleanBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  const cut = (s, n) => String(s ?? '').slice(0, n)
  return blocks.slice(0, 40).map((b) => {
    if (!b || !BLOCK_TYPES.includes(b.type)) return null
    if (b.type === 'heading') return { type: 'heading', text: cut(b.text, 200) }
    if (b.type === 'text') return { type: 'text', text: cut(b.text, 5000) }
    if (b.type === 'button') return { type: 'button', label: cut(b.label, 60), url: safeUrl(b.url) }
    if (b.type === 'image') return { type: 'image', url: safeUrl(b.url), alt: cut(b.alt, 200), link: safeUrl(b.link) }
    return { type: 'divider' }
  }).filter(Boolean)
}

export function cleanBranding(b = {}) {
  return {
    fromName: String(b.fromName || '').slice(0, 80).trim(),
    replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.replyTo || '') ? String(b.replyTo).trim().toLowerCase() : '',
    color: isHex(b.color) ? b.color.toUpperCase() : DEFAULT_COLOR,
    logoUrl: safeUrl(b.logoUrl),
    footer: String(b.footer || '').slice(0, 500),
    website: safeUrl(b.website),
  }
}

/**
 * Renders a complete email.
 * @param {object} o
 * @param {object} o.org        { name }
 * @param {object} o.branding   see cleanBranding
 * @param {string} o.subject
 * @param {string} o.preheader  inbox preview line
 * @param {Array}  o.blocks
 * @param {object} o.person     merge values for this recipient
 * @param {string} o.unsubscribeUrl
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderEmail({ org = {}, branding = {}, subject = '', preheader = '', blocks = [], person = {}, unsubscribeUrl = '#' }) {
  const br = cleanBranding(branding)
  const color = br.color
  const churchName = br.fromName || org.name || ''
  const m = (s) => merge(s, person, org)
  const parts = []
  const text = []

  for (const b of cleanBlocks(blocks)) {
    if (b.type === 'heading' && b.text.trim()) {
      parts.push(`<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:700;color:#243447">${esc(m(b.text))}</h1>`)
      text.push(m(b.text).toUpperCase())
    } else if (b.type === 'text' && b.text.trim()) {
      parts.push(richText(m(b.text), color))
      text.push(m(b.text))
    } else if (b.type === 'button' && b.label.trim() && b.url) {
      parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${color}"><a href="${esc(b.url)}" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:${textOn(color)};text-decoration:none;border-radius:8px">${esc(m(b.label))}</a></td></tr></table>`)
      text.push(`${m(b.label)}: ${b.url}`)
    } else if (b.type === 'image' && b.url) {
      const img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:8px">`
      parts.push(`<div style="margin:0 0 20px">${b.link ? `<a href="${esc(b.link)}">${img}</a>` : img}</div>`)
      if (b.alt) text.push(`[${b.alt}]`)
    } else if (b.type === 'divider') {
      parts.push('<hr style="border:0;border-top:1px solid #E3E7E1;margin:8px 0 24px">')
      text.push('---')
    }
  }

  const header = br.logoUrl
    ? `<img src="${esc(br.logoUrl)}" alt="${esc(churchName)}" height="56" style="display:block;height:56px;width:auto;max-width:240px;border:0">`
    : `<span style="font-size:20px;font-weight:700;color:#243447">${esc(churchName)}</span>`
  const footerLines = [
    br.footer && esc(br.footer).replace(/\n/g, '<br>'),
    br.website && `<a href="${esc(br.website)}" style="color:#5B6B7A">${esc(br.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`,
    `You’re receiving this because you’re part of ${esc(churchName)}. <a href="${esc(unsubscribeUrl)}" style="color:#5B6B7A;text-decoration:underline">Unsubscribe</a>`,
  ].filter(Boolean)

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m(subject))}</title></head>
<body style="margin:0;padding:0;background:#F3F4F0;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(m(preheader))}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="height:6px;background:${color};border-radius:12px 12px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="background:#FFFFFF;padding:28px 32px 8px">${header}</td></tr>
<tr><td style="background:#FFFFFF;padding:20px 32px 16px;border-radius:0 0 12px 12px">${parts.join('\n') || '<p style="margin:0 0 16px;font-size:16px;color:#8A97A3">Your message will appear here.</p>'}</td></tr>
<tr><td style="padding:20px 32px;font-size:12px;line-height:1.6;color:#5B6B7A;text-align:center">${footerLines.join('<br><br>')}</td></tr>
</table></td></tr></table></body></html>`

  const plain = [churchName, '', ...text.flatMap((t) => [t, '']), '--', br.footer, br.website, `Unsubscribe: ${unsubscribeUrl}`].filter((x) => x !== undefined && x !== null && x !== '').join('\n')
  return { subject: m(subject), html, text: plain }
}

// Blocks for an older draft that only had plain text.
export const blocksFromBody = (body) => (body ? [{ type: 'text', text: String(body) }] : [])

export const STARTER_BLOCKS = [
  { type: 'heading', text: 'Hello {first_name},' },
  { type: 'text', text: 'Write your message here.' },
]
