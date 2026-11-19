// Shown on the home page and sign-up page when a visitor arrives through a church's
// "Get this for your church" link.
import { useEffect, useState } from 'react'
import { Gift } from 'lucide-react'
import { api } from '../lib/api'
import { currentRef } from '../lib/referral'

export function useInvite() {
  const [invite, setInvite] = useState(null)
  useEffect(() => {
    const code = currentRef()
    if (code) api.get(`/public/ref/${code}`).then(d => setInvite({ code, ...d })).catch(() => {})
  }, [])
  return invite
}

export default function InviteBanner({ invite, className = '' }) {
  if (!invite) return null
  return (
    <div className={`flex items-center justify-center gap-2 bg-cyan-50 px-4 py-2.5 text-center text-sm text-cyan-900 ${className}`}>
      <Gift size={16} className="shrink-0" />
      <span><b>{invite.orgName}</b> uses GatherHQ and invited you. Sign up now and your church gets an extra month free.</span>
    </div>
  )
}
