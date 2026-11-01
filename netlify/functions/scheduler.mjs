// Runs every 15 minutes: welcome-journey emails and the Monday Pastor's Brief.
import { runScheduled } from '../../server/jobs.js'

export default async () => {
  const result = await runScheduled()
  console.log('Scheduler', JSON.stringify(result))
  return new Response('ok')
}

export const config = { schedule: '*/15 * * * *' }
