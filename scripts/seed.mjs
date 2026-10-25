// Demo data for local development: a two-branch church with 12 weeks of history.
const FIRST = ['Adaeze', 'Bola', 'Chidi', 'Dayo', 'Efe', 'Funke', 'Gbenga', 'Halima', 'Ifeoma', 'Jide', 'Kemi', 'Lanre', 'Musa', 'Ngozi', 'Ope', 'Bisi', 'Tunde', 'Uche', 'Wale', 'Yemi', 'Zainab', 'Tobi', 'Seun', 'Rotimi', 'Amaka', 'Emeka', 'Folake', 'Kunle', 'Nkechi', 'Segun']
const LAST = ['Okafor', 'Adeyemi', 'Bello', 'Okonkwo', 'Balogun', 'Eze', 'Ogunleye', 'Ibrahim', 'Nwosu', 'Afolabi', 'Olawale', 'Obi', 'Danjuma', 'Akande', 'Uzor']

export async function seed(port, pool) {
  let cookie = ''
  const call = async (method, p, body) => {
    const r = await fetch(`http://localhost:${port}/api${p}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined })
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${method} ${p}: ${data.error}`)
    return data
  }
  await call('POST', '/auth/signup', { orgName: 'Grace Community Church', branchName: 'Ikeja', name: 'Ada Okafor', email: 'ada@grace.local', password: 'password123', timezone: 'Africa/Lagos', defaultCountryCode: '234' })
  const me = await call('GET', '/me')
  const ikeja = me.branches[0].id
  const lekki = (await call('POST', '/branches', { name: 'Lekki', address: 'Admiralty Way, Lekki' })).id
  for (const n of ['Choir', 'Ushering', 'Media', "Children's church"]) await call('POST', '/units', { name: n })

  // ~90 members across branches
  const rows = []
  let k = 0
  for (const f of FIRST) for (const l of LAST.slice(0, 3)) { rows.push({ firstName: f, lastName: LAST[(k++ * 7) % LAST.length], phone: `0803${String(1000000 + k * 7919).slice(-7)}`, status: 'member' }); if (rows.length >= 90) break }
  await call('POST', '/people/import/commit', { branchId: ikeja, rows: rows.slice(0, 60) })
  await call('POST', '/people/import/commit', { branchId: lekki, rows: rows.slice(60) })

  // 12 weeks of Sunday services in both branches, with history written directly for speed.
  const people = (await pool.query(`SELECT id, branch_id FROM people`)).rows
  const org = (await pool.query(`SELECT id FROM organisations LIMIT 1`)).rows[0].id
  const now = new Date()
  const lastSunday = new Date(now); lastSunday.setDate(now.getDate() - now.getDay()); lastSunday.setHours(8, 0, 0, 0)
  for (let w = 11; w >= 1; w--) {
    for (const [branch, base] of [[ikeja, 0.62], [lekki, 0.55]]) {
      const d = new Date(lastSunday); d.setDate(d.getDate() - w * 7)
      const g = await call('POST', '/gatherings', { name: 'Sunday Service', kind: 'service', branchId: branch, startsAt: d.toISOString(), status: 'closed' })
      const pool_ = people.filter(p => p.branch_id === branch)
      const rate = base + (11 - w) * 0.012 + (w === 6 ? -0.15 : 0)
      for (const p of pool_) if (Math.random() < rate) {
        await pool.query(`INSERT INTO checkins (org_id, branch_id, gathering_id, person_id, method, created_at) VALUES ($1,$2,$3,$4,'qr',$5) ON CONFLICT DO NOTHING`, [org, branch, g.id, p.id, d])
        await pool.query(`UPDATE people SET visit_count = visit_count + 1, first_visit_at = LEAST(COALESCE(first_visit_at, $2), $2), last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2) WHERE id = $1`, [p.id, d])
      }
    }
  }
  // A few members drifted away
  await pool.query(`UPDATE people SET last_seen_at = NOW() - INTERVAL '30 days' WHERE id IN (SELECT id FROM people ORDER BY id LIMIT 6)`)

  // This week's service (open) using the real public check-in flow for visitors.
  const g = await call('POST', '/gatherings', { name: 'Sunday Service', kind: 'service', branchId: ikeja, startsAt: new Date(Date.now() - 50 * 60000).toISOString(), status: 'open' })
  const ikejaPeople = (await pool.query(`SELECT first_name, phone FROM people WHERE branch_id = $1 LIMIT 44`, [ikeja])).rows
  for (const p of ikejaPeople) await fetch(`http://localhost:${port}/api/public/g/${g.public_token}/checkin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': `10.0.0.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify({ mode: 'returning', phone: p.phone, firstName: p.first_name }) })
  for (const [f, l, ph] of [['Temi', 'Adebayo', '08120000001'], ['Grace', 'Udoh', '08120000002'], ['Samuel', 'Ojo', '08120000003'], ['Mariam', 'Yusuf', '08120000004']]) {
    await fetch(`http://localhost:${port}/api/public/g/${g.public_token}/checkin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '10.1.1.1' }, body: JSON.stringify({ mode: 'new', answers: { first_name: f, last_name: l, phone: ph } }) })
  }
  await call('POST', '/gatherings', { name: 'Midweek Bible Study', kind: 'midweek', branchId: ikeja, startsAt: new Date(Date.now() + 3 * 86400000).toISOString(), status: 'scheduled' })

  // Events
  const camp = await call('POST', '/events', { name: 'Youth Camp 2026', description: 'Three days of worship, teaching and friendship for ages 13–19.', location: 'Camp Ground, Ogun State', startsAt: new Date(Date.now() + 18 * 86400000).toISOString(), endsAt: new Date(Date.now() + 20 * 86400000).toISOString(), capacity: 60 })
  for (let i = 0; i < 38; i++) await fetch(`http://localhost:${port}/api/public/e/${camp.public_token}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': `10.2.${i}.1` }, body: JSON.stringify({ answers: { first_name: FIRST[i % FIRST.length], last_name: LAST[i % LAST.length], phone: `0907${String(2000000 + i * 31)}` } }) })
  await call('POST', '/events', { name: "Women's Breakfast", location: 'Ikeja main hall', startsAt: new Date(Date.now() + 9 * 86400000).toISOString(), branchId: ikeja })

  // Team
  const inv = await call('POST', '/team/invites', { email: 'usher@grace.local', role: 'usher', branchIds: [ikeja] })
  const inv2 = await call('POST', '/team/invites', { email: 'pastor@grace.local', role: 'lead', branchIds: null })
  const saved = cookie
  cookie = ''; await call('POST', '/auth/accept-invite', { token: inv.token, name: 'Uche Usher', password: 'password123' })
  cookie = ''; await call('POST', '/auth/accept-invite', { token: inv2.token, name: 'Pastor Femi', password: 'password123' })
  cookie = saved
  const pastor = (await pool.query(`SELECT id FROM users WHERE email = 'pastor@grace.local'`)).rows[0].id
  await pool.query(`UPDATE followups SET assignee_user_id = $1 WHERE id IN (SELECT id FROM followups LIMIT 2)`, [pastor])
  await pool.query(`UPDATE followups SET due_at = NOW() - INTERVAL '1 day' WHERE id IN (SELECT id FROM followups ORDER BY id DESC LIMIT 1)`)
}
