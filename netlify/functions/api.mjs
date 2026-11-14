import { handle } from '../../server/app.js'

// The Netlify context carries the visitor's approximate location (country and city) for site statistics.
export default async (req, context) => handle(req, context)

export const config = { path: '/api/*' }
