// Who's behind GatherHQ and how to reach us. Edit here; the home page, pricing and footer use it.

export const FOUNDER = {
  name: 'Tunde David',
  role: 'Founder, GatherHQ',
  photo: null, // e.g. '/media/founder.jpg' once added
  story: [
    'I’m a software engineer and product manager. I’ve built software for a UK university and for a regulated payments company, and I’ve built attendance tools for church teams in Nigeria who were running Sunday on paper registers, spreadsheets and WhatsApp groups.',
    'GatherHQ is the tool I wanted those teams to have: simple enough for an usher on a phone, and careful enough with people’s details that a pastor can trust it. If you have a question, message me directly. I read every message.',
  ],
}

// WhatsApp contact, international format without "+" (for example 2348012345678).
// Set VITE_WHATSAPP_NUMBER in Netlify; nothing shows until it's set.
export const WHATSAPP = String(import.meta.env.VITE_WHATSAPP_NUMBER || '').replace(/\D/g, '')
export const whatsappLink = (text = 'Hello, I’d like to know more about GatherHQ for my church.') => (WHATSAPP ? `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}` : null)

// Real quotes only, from churches that have agreed to be quoted. The section stays hidden while empty.
// { quote: '…', name: 'Pastor …', role: 'Senior Pastor', church: '…', city: 'Lagos' }
export const TESTIMONIALS = []
