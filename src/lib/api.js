// Fetch wrapper for the Gatherwell API. Throws ApiError with server message and field details.
export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details }
}

async function request(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' }
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  let res
  try { res = await fetch('/api' + path, init) }
  catch { throw new ApiError(0, "Can't reach Gatherwell. Check your internet connection and try again.") }
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/public')) window.dispatchEvent(new Event('gw:unauthorized'))
    throw new ApiError(res.status, data?.error || 'Something went wrong. Please try again.', data?.details)
  }
  return data
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
}

export function qs(obj) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

// Triggers a file download from an API GET endpoint that returns CSV.
export async function download(path) {
  const res = await fetch('/api' + path, { credentials: 'same-origin' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data.error || 'Download failed.')
  }
  const blob = await res.blob()
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export.csv'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
