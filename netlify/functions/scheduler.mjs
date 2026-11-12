// Runs every minute: scheduled messages and workflow steps every time; the welcome-journey
// emails, Monday Pastor's Brief and trial reminders every 5 minutes (they are idempotent).
import { runScheduled } from '../../server/jobs.js'

export default async () => {
  const now = new Date()
  const result = await runScheduled({ now, legacy: now.getUTCMinutes() % 5 === 0 })
  console.log('Scheduler', JSON.stringify(result))
  return new Response('ok')
}

export const config = { schedule: '* * * * *' }
