// A slim notice on every page of the staging site, so it can never be mistaken for production.
/* global __COMMIT__ */
export const IS_STAGING = import.meta.env.VITE_APP_ENV === 'staging'

export default function EnvBanner() {
  if (!IS_STAGING) return null
  return (
    <div role="note" className="bg-gold-100 px-4 py-1.5 text-center text-[13px] font-medium text-gold-700">
      <span className="font-semibold uppercase tracking-wide">Staging</span>
      <span className="mx-2" aria-hidden>·</span>Test data only. Payments use Stripe test mode, and emails only reach approved test addresses.
      <span className="ml-2 text-gold-700/70">Build {__COMMIT__}</span>
    </div>
  )
}
