import { api } from './api'

// Sends a message in rounds (the server sends a few hundred per call) and reports progress.
export async function runSend(id, onProgress) {
  for (let round = 0; round < 500; round++) {
    const p = await api.post(`/messages/${id}/send`)
    onProgress?.(p)
    if (p.status !== 'sending') return p
    if (p.busy) await new Promise(r => setTimeout(r, 2500))
  }
  throw new Error('Sending is taking longer than expected. It will carry on when you open this message again.')
}
