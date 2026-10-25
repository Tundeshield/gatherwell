// Demo data for local development: a two-branch church with 12 weeks of history.
const FIRST = ['Adaeze', 'Bola', 'Chidi', 'Dayo', 'Efe', 'Funke', 'Gbenga', 'Halima', 'Ifeoma', 'Jide', 'Kemi', 'Lanre', 'Musa', 'Ngozi', 'Ope', 'Bisi', 'Tunde', 'Uche', 'Wale', 'Yemi', 'Zainab', 'Tobi', 'Seun', 'Rotimi', 'Amaka', 'Emeka', 'Folake', 'Kunle', 'Nkechi', 'Segun']
const LAST = ['Okafor', 'Adeyemi', 'Bello', 'Okonkwo', 'Balogun', 'Eze', 'Ogunleye', 'Ibrahim', 'Nwosu', 'Afolabi', 'Olawale', 'Obi', 'Danjuma', 'Akande', 'Uzor']

export async function seed(port, fake) {
  let cookie = ''
  const call = async (method, p, body, extraHeaders = {}) => {
    const r = await fetch(`http://localhost:${port}/api${p}`, { method, headers: { 'content-type': 'application/json', cookie, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined })
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${method} ${p}: ${data.error}`)
    return data
  }
  const login = (email) => call('POST', '/auth/session', { idToken: fake.auth.signIn(email, 'password123') })
  await call('POST', '/auth/signup', { orgName: 'Grace Community Church', branchName: 'Ikeja', name: 'Ada Okafor', email: 'ada@grace.local', password: 'password123', timezone: 'Africa/Lagos', defaultCountryCode: '234' })
  await login('ada@grace.local')
  const me = await call('GET', '/me')
  const orgId = me.org.id
  const ikeja = me.branches[0].id
  const lekki = (await call('POST', '/branches', { name: 'Lekki', address: 'Admiralty Way, Lekki' })).id
  for (const n of ['Choir', 'Ushering', 'Media', "Children's church"]) await call('POST', '/units', { name: n })

  const rows = []
  for (let k = 1; rows.length < 90; k++) rows.push({ firstName: FIRST[k % FIRST.length], lastName: LAST[(k * 7) % LAST.length], phone: `0803${String(1000000 + k * 7919).slice(-7)}`, status: 'member' })
  await call('POST', '/people/import/commit', { branchId: ikeja, rows: rows.slice(0, 60) })
  await call('POST', '/people/import/commit', { branchId: lekki, rows: rows.slice(60) })

  // 11 past weeks of Sunday services in both branches, written directly for speed.
  const db = fake.db
  const C = (n) => db.collection(`orgs/${orgId}/${n}`)
  const people = (await C('people').get()).docs.map(d => ({ id: d.id, ...d.data() }))
  const now = new Date()
  const lastSunday = new Date(now); lastSunday.setDate(now.getDate() - now.getDay()); lastSunday.setHours(8, 0, 0, 0)
  const stats = new Map()
  for (let w = 11; w >= 1; w--) {
    for (const [branch, base] of [[ikeja, 0.62], [lekki, 0.55]]) {
      const d = new Date(lastSunday); d.setDate(d.getDate() - w * 7)
      const g = await call('POST', '/gatherings', { name: 'Sunday Service', kind: 'service', branchId: branch, startsAt: d.toISOString(), status: 'closed' })
      let n = 0
      const rate = base + (11 - w) * 0.012 + (w === 6 ? -0.15 : 0)
      for (const p of people.filter(x => x.branch_id === branch)) if (Math.random() < rate) {
        n++
        await C('checkins').doc(`${g.id}_${p.id}`).set({ gathering_id: g.id, person_id: p.id, branch_id: branch, first_time: false, method: 'qr', answers: {}, created_at: d, created_by: null, created_by_name: null,
          first_name: p.first_name, last_name: p.last_name, phone: p.phone, person_status: p.status, gathering_name: 'Sunday Service', starts_at: d })
        const s = stats.get(p.id) || { visits: 0, first: d, last: d }
        s.visits++; if (d < s.first) s.first = d; if (d > s.last) s.last = d
        stats.set(p.id, s)
      }
      await C('gatherings').doc(g.id).update({ attendance: n })
    }
  }
  for (const [id, s] of stats) await C('people').doc(id).update({ visit_count: s.visits, first_visit_at: s.first, last_seen_at: s.last })
  // A few members drifted away.
  for (const p of people.slice(0, 6)) await C('people').doc(p.id).update({ last_seen_at: new Date(Date.now() - 30 * 86400e3) })

  // This week's service through the real public check-in flow.
  const g = await call('POST', '/gatherings', { name: 'Sunday Service', kind: 'service', branchId: ikeja, startsAt: new Date(Date.now() - 50 * 60000).toISOString(), status: 'open' })
  let ip = 0
  const pub = (p, body) => fetch(`http://localhost:${port}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': `10.0.${Math.floor(ip / 200)}.${ip++ % 200}` }, body: JSON.stringify(body) })
  for (const p of people.filter(x => x.branch_id === ikeja).slice(0, 44)) await pub(`/public/g/${g.public_token}/checkin`, { mode: 'returning', phone: p.phone, firstName: p.first_name })
  for (const [f, l, ph] of [['Temi', 'Adebayo', '08120000001'], ['Grace', 'Udoh', '08120000002'], ['Samuel', 'Ojo', '08120000003'], ['Mariam', 'Yusuf', '08120000004']])
    await pub(`/public/g/${g.public_token}/checkin`, { mode: 'new', answers: { first_name: f, last_name: l, phone: ph } })
  await call('POST', '/gatherings', { name: 'Midweek Bible Study', kind: 'midweek', branchId: ikeja, startsAt: new Date(Date.now() + 3 * 86400000).toISOString(), status: 'scheduled' })

  const camp = await call('POST', '/events', { name: 'Youth Camp 2026', description: 'Three days of worship, teaching and friendship for ages 13–19.', location: 'Camp Ground, Ogun State', startsAt: new Date(Date.now() + 18 * 86400000).toISOString(), endsAt: new Date(Date.now() + 20 * 86400000).toISOString(), capacity: 60 })
  for (let i = 0; i < 38; i++) await pub(`/public/e/${camp.public_token}/register`, { answers: { first_name: FIRST[i % FIRST.length], last_name: LAST[i % LAST.length], phone: `0907${String(2000000 + i * 31)}` } })
  await call('POST', '/events', { name: "Women's Breakfast", location: 'Ikeja main hall', startsAt: new Date(Date.now() + 9 * 86400000).toISOString(), branchId: ikeja })

  const inv = await call('POST', '/team/invites', { email: 'usher@grace.local', role: 'usher', branchIds: [ikeja] })
  const inv2 = await call('POST', '/team/invites', { email: 'pastor@grace.local', role: 'lead', branchIds: null })
  const saved = cookie
  cookie = ''; await call('POST', '/auth/accept-invite', { token: inv.token, name: 'Uche Usher', password: 'password123' })
  cookie = ''; await call('POST', '/auth/accept-invite', { token: inv2.token, name: 'Pastor Femi', password: 'password123' })
  cookie = saved
  const fus = (await C('followups').get()).docs
  if (fus[0]) await fus[0].ref.update({ due_at: new Date(Date.now() - 86400e3) })
}
