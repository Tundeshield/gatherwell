import { Component } from 'react'
import { RefreshCw } from 'lucide-react'
import { reloadForNewVersion } from '../lib/lazyPage'

// Catches anything that goes wrong while showing a page, so the screen is never left blank.
// It resets itself when you navigate to another page.
export default class PageErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) {
    const chunk = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk/i
    if (chunk.test(String(error?.message || error))) reloadForNewVersion()
    console.error('Page error', error)
  }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-ink">This page didn’t load</h1>
          <p className="mt-2 text-sm text-mist-500">GatherHQ may have just been updated. Reloading will fix it.</p>
          <button type="button" onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800">
            <RefreshCw size={16} /> Reload
          </button>
        </div>
      </div>
    )
  }
}
