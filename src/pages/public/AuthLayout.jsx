import { Link } from 'react-router-dom'
import Logo from '../../components/Logo'

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen flex-col bg-ivory">
      <header className="px-6 py-5"><Link to="/" aria-label="GatherHQ home"><Logo size={30} /></Link></header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0">
        <div className="w-full max-w-[420px]">
          <div className="panel px-6 py-7 sm:px-8 sm:py-9">
            <h1 className="text-[22px] font-semibold text-ink">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-mist-500">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          {footer && <div className="mt-5 text-center text-sm text-mist-500">{footer}</div>}
        </div>
      </main>
    </div>
  )
}
