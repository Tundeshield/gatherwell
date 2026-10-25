// Platform operators only (users.is_platform_admin or PLATFORM_ADMIN_EMAILS). Being a church owner never grants this.
// Aggregates only — no member records or pastoral notes are exposed here.
import { fb, col, plain } from '../firebase.js'
import { notFound, oneOf, bad } from '../http.js'
import { audit } from '../util.js'

export default function (r) {
  r.get('/platform/summary', { auth: 'platform' }, async () => {
    const { db } = await fb()
    const since = new Date(Date.now() - 7 * 86400e3)
    const orgSnaps = await db.collection('orgs').orderBy('created_at', 'desc').limit(500).get()
    const orgs = await Promise.all(orgSnaps.docs.map(async (o) => {
      const d = o.data()
      const C = (n) => col(db, o.id, n)
      const [branches, people, sessions, team, owner, last, recent] = await Promise.all([
        C('branches').count().get(), C('people').count().get(), C('gatherings').count().get(),
        db.collection('memberships').where('org_id', '==', o.id).where('status', '==', 'active').count().get(),
        db.collection('memberships').where('org_id', '==', o.id).where('role', '==', 'owner').limit(1).get(),
        C('checkins').orderBy('created_at', 'desc').limit(1).get(),
        C('checkins').where('created_at', '>=', since).count().get(),
      ])
      return {
        id: o.id, name: d.name, slug: d.slug, status: d.status, plan: d.plan, trial_ends_at: plain(d.trial_ends_at), created_at: plain(d.created_at), country: d.country || null,
        branches: branches.data().count, people: people.data().count, sessions: sessions.data().count, team: team.data().count,
        owner_email: owner.docs[0]?.data().user_email || null, last_checkin_at: last.empty ? null : plain(last.docs[0].data().created_at), _recent: recent.data().count,
      }
    }))
    const users = await db.collection('users').count().get()
    const totals = {
      orgs: orgs.length, active_orgs: orgs.filter(o => o.status === 'active').length, branches: orgs.reduce((a, o) => a + o.branches, 0),
      people: orgs.reduce((a, o) => a + o.people, 0), checkins_7d: orgs.reduce((a, o) => a + o._recent, 0), users: users.data().count,
    }
    return { totals, orgs: orgs.map(({ _recent, ...o }) => o) }
  })

  r.patch('/platform/orgs/:id', { auth: 'platform' }, async ({ ctx, params, body }) => {
    const { db } = await fb()
    const status = oneOf(body.status, ['active', 'suspended', 'closed'], { name: 'Status' })
    if (!status) throw bad('Choose a status.')
    if (status === 'closed' && body.confirm !== 'close') throw bad('Type-confirm required to close an organisation.')
    const ref = db.collection('orgs').doc(String(params.id).slice(0, 64))
    const o = await ref.get()
    if (!o.exists) throw notFound()
    await ref.update({ status, updated_at: new Date() })
    await audit({ org: { id: o.id }, user: ctx.user }, `platform.org_${status}`, 'organisation', o.id, { by: ctx.user.email })
    return { id: o.id, name: o.data().name, status }
  })
}
