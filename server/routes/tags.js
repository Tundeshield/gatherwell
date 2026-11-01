// Tags: free-form labels a church puts on people ("Choir", "Youth", "Newsletter") to group them
// for emails and lists. A person can have any number of tags.
import { fb, col, plain, getMany, F } from '../firebase.js'
import { bad, notFound, str, isUuid, uuid } from '../http.js'
import { requireCap } from '../access.js'
import { audit } from '../util.js'

export const TAG_COLORS = ['forest', 'sage', 'amber', 'navy', 'plum', 'rose', 'sky', 'slate']
const MAX_TAGS = 200

export default function (r) {
  r.get('/tags', async ({ ctx }) => {
    requireCap(ctx, 'people.view')
    const { db } = await fb()
    const tags = (await col(db, ctx.org.id, 'tags').get()).docs.map(d => ({ id: d.id, ...plain(d.data()) }))
    const counts = await Promise.all(tags.map(t => col(db, ctx.org.id, 'people').where('tags', 'array-contains', t.id).count().get()))
    return tags.map((t, i) => ({ id: t.id, name: t.name, color: t.color, count: counts[i].data().count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  r.post('/tags', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const name = str(body.name, { required: true, max: 40, name: 'Tag name' })
    const all = (await col(db, ctx.org.id, 'tags').get()).docs.map(d => ({ id: d.id, ...d.data() }))
    const existing = all.find(t => t.name.toLowerCase() === name.toLowerCase())
    if (existing) return { id: existing.id, name: existing.name, color: existing.color, count: null, existed: true }
    if (all.length >= MAX_TAGS) throw bad(`You can have up to ${MAX_TAGS} tags. Delete some you no longer use.`)
    const color = TAG_COLORS.includes(body.color) ? body.color : TAG_COLORS[all.length % TAG_COLORS.length]
    const ref = await col(db, ctx.org.id, 'tags').add({ name, color, created_at: new Date(), created_by: ctx.user.id })
    await audit(ctx, 'tag.created', 'tag', ref.id, { name })
    return { id: ref.id, name, color, count: 0 }
  })

  r.patch('/tags/:id', async ({ ctx, params, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const ref = col(db, ctx.org.id, 'tags').doc(uuid(params.id, { required: true }))
    const t = await ref.get()
    if (!t.exists) throw notFound()
    const patch = {}
    if (body.name !== undefined) patch.name = str(body.name, { required: true, max: 40, name: 'Tag name' })
    if (body.color !== undefined && TAG_COLORS.includes(body.color)) patch.color = body.color
    await ref.update(patch)
    return { id: t.id, ...t.data(), ...patch }
  })

  r.delete('/tags/:id', async ({ ctx, params }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const id = uuid(params.id, { required: true })
    const ref = col(db, ctx.org.id, 'tags').doc(id)
    const t = await ref.get()
    if (!t.exists) throw notFound()
    const tagged = await col(db, ctx.org.id, 'people').where('tags', 'array-contains', id).get()
    for (let i = 0; i < tagged.docs.length; i += 400) {
      const b = db.batch(); tagged.docs.slice(i, i + 400).forEach(d => b.update(d.ref, { tags: F.remove(id) })); await b.commit()
    }
    await ref.delete()
    await audit(ctx, 'tag.deleted', 'tag', id, { name: t.data().name, people: tagged.size })
    return { ok: true, removedFrom: tagged.size }
  })

  // Add and/or remove tags for one or many people.
  r.post('/people/tags', async ({ ctx, body }) => {
    requireCap(ctx, 'people.edit')
    const { db } = await fb()
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(isUuid))].slice(0, 2000)
    if (!ids.length) throw bad('Select at least one person.')
    const add = (Array.isArray(body.add) ? body.add : []).filter(isUuid).slice(0, 20)
    const remove = (Array.isArray(body.remove) ? body.remove : []).filter(isUuid).slice(0, 20)
    if (!add.length && !remove.length) throw bad('Choose a tag to add or remove.')
    const known = new Set((await getMany(db, [...add, ...remove].map(t => col(db, ctx.org.id, 'tags').doc(t)))).filter(s => s.exists).map(s => s.id))
    const addOk = add.filter(t => known.has(t)), removeOk = remove.filter(t => known.has(t))
    if (!addOk.length && !removeOk.length) throw bad('That tag no longer exists.')
    const snaps = await getMany(db, ids.map(id => col(db, ctx.org.id, 'people').doc(id)))
    const ok = snaps.filter(s => s.exists && (!ctx.branchScope || ctx.branchScope.includes(s.data().branch_id)))
    for (let i = 0; i < ok.length; i += 200) {
      const b = db.batch()
      for (const s of ok.slice(i, i + 200)) {
        const cur = new Set(s.data().tags || [])
        addOk.forEach(t => cur.add(t)); removeOk.forEach(t => cur.delete(t))
        b.update(s.ref, { tags: [...cur], updated_at: new Date() })
      }
      await b.commit()
    }
    await audit(ctx, 'people.tagged', 'people', null, { count: ok.length, add: addOk.length, remove: removeOk.length })
    return { updated: ok.length }
  })
}
