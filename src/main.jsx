import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { reloadForNewVersion } from './lib/lazyPage'

// Vite reports when a page file from an older version can't be loaded: reload to get the new one.
// Staging: tell search engines to stay away, and make the tab obvious.
if (import.meta.env.VITE_APP_ENV === 'staging') {
  const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m)
}

window.addEventListener('vite:preloadError', (event) => { if (reloadForNewVersion()) event.preventDefault() })

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
