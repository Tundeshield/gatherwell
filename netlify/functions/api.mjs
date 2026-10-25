import { handle } from '../../server/app.js'

export default async (req) => handle(req)

export const config = { path: '/api/*' }
