// Build-time rendering of the public pages to static HTML, so search engines and link previews
// (WhatsApp, Facebook, LinkedIn) see real content instead of an empty page. The browser app
// replaces this markup as soon as it starts.
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { Routes, Route } from 'react-router-dom'
import { SessionContext } from './lib/session'
import Landing from './pages/public/Landing'
import Pricing from './pages/public/Pricing'
import Legal from './pages/public/Legal'

const session = { me: null, loading: false, refresh: async () => {}, can: () => false, branches: [], activeBranches: [], branchName: () => null, branchesEnabled: false, multiBranch: false, tz: 'Africa/Lagos' }

export function render(url) {
  return renderToString(
    <SessionContext.Provider value={session}>
      <StaticRouter location={url}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/legal/:doc" element={<Legal />} />
        </Routes>
      </StaticRouter>
    </SessionContext.Provider>
  )
}
