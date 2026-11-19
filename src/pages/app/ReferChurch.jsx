// Settings › Refer a church: the church's "Get this for your church" link and who joined through it.
import { Copy, MessageCircle, Gift } from 'lucide-react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useLoad, Button, Badge, Skeleton, ErrorState, useToast } from '../../components/ui'
import { fmtDate } from '../../lib/format'

const STATUS = { signed_up: ['Trying GatherHQ', 'neutral'], qualified: ['Subscribed: your free month is being arranged', 'warning'], rewarded: ['Subscribed: you got a free month', 'success'] }

export default function ReferChurch() {
  const { me } = useSession()
  const toast = useToast()
  const { data, error, reload } = useLoad(() => api.get('/org/referrals'), [])
  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data) return <Skeleton className="h-60" />
  const message = `We use GatherHQ at ${me.org.name} for attendance, first-timer follow-up and children’s check-in. Sign up with our link and your church gets an extra month free: ${data.link}`
  const copy = async (text, label) => { try { await navigator.clipboard.writeText(text); toast(label) } catch { toast('Copy failed. Select the text and copy it instead.', 'error') } }
  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Gift size={22} /></div>
          <div>
            <h2 className="text-lg font-semibold text-ink">Give a month, get a month</h2>
            <p className="mt-1 text-sm leading-relaxed text-mist-600">Share your link with another church. They get an extra month free when they sign up, and you get a free month when they start paying. Your link is also on your check-in and event pages, under “Get this for your church”.</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <input readOnly value={data.link} onFocus={e => e.target.select()} className="field flex-1 font-mono text-sm" aria-label="Your referral link" />
          <Button variant="secondary" icon={Copy} onClick={() => copy(data.link, 'Link copied')}>Copy link</Button>
          <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-brand-700 bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"><MessageCircle size={16} />Share on WhatsApp</a>
        </div>
        <p className="mt-3 text-xs text-mist-500">Free months: {data.earned} earned so far.</p>
      </section>
      <section className="panel p-6">
        <h2 className="mb-3 text-base font-semibold text-ink">Churches you’ve referred</h2>
        {data.referrals.length ? (
          <ul className="divide-y divide-mist-100">
            {data.referrals.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span><span className="font-medium text-ink">{r.church}</span><span className="text-mist-500"> · joined {fmtDate(r.joined_at)}</span></span>
                <Badge tone={STATUS[r.status]?.[1]}>{STATUS[r.status]?.[0] || r.status}</Badge>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-mist-500">No churches yet. Share your link with a pastor friend or another church in your network.</p>}
      </section>
    </div>
  )
}
