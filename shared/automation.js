// Default automations, shared by the server and the settings screens. Churches can edit all of
// these; the journey emails are off until a church turns them on.

export const JOURNEY_STEPS = [
  { key: 'welcome', visit: 1, label: 'After a first visit', hint: 'A warm welcome, sent the same day.' },
  { key: 'second', visit: 2, label: 'After a second visit', hint: 'They came back — invite them to a next step.' },
  { key: 'third', visit: 3, label: 'After a third visit', hint: 'Help them belong: serving, membership, a group.' },
]

export const DELAY_OPTIONS = [[1, '1 hour later'], [3, '3 hours later'], [6, '6 hours later'], [24, 'The next day'], [48, 'Two days later']]

export const DEFAULT_JOURNEY = {
  welcome: {
    enabled: false, delayHours: 3,
    subject: 'Welcome to {church_name}, {first_name}!',
    preheader: 'It was a joy to have you with us.',
    blocks: [
      { type: 'heading', text: 'It was a joy to have you, {first_name}' },
      { type: 'text', text: 'Thank you for worshipping with us at {church_name}. We hope you felt at home.\n\nIf you have any questions, would like prayer, or want to know more about church life, simply reply to this email. A real person will get back to you.' },
      { type: 'text', text: 'We’d love to see you again this Sunday.' },
    ],
  },
  second: {
    enabled: false, delayHours: 6,
    subject: 'So good to see you again, {first_name}',
    preheader: 'You came back, and we noticed.',
    blocks: [
      { type: 'heading', text: 'You came back, {first_name}!' },
      { type: 'text', text: 'It was wonderful to see you again at {church_name}.\n\nThe best way to feel at home is to get connected. We have a short newcomers’ class where you can meet the pastors and find out how church life works. Reply to this email and we’ll save you a seat.' },
    ],
  },
  third: {
    enabled: false, delayHours: 6,
    subject: '{first_name}, there’s a place for you here',
    preheader: 'Ways to belong and serve at church.',
    blocks: [
      { type: 'heading', text: 'There’s a place for you, {first_name}' },
      { type: 'text', text: 'You’ve been with us three times now, and we’re so glad.\n\nIf you’re ready, we’d love to help you take the next step: joining a service unit, a small group, or becoming a member of {church_name}. Just reply and tell us what interests you.' },
    ],
  },
}

export const WHATSAPP_KINDS = [
  ['first_visit', 'First-time visitor'],
  ['second_visit', 'Second visit'],
  ['absence', 'Haven’t seen them for a while'],
  ['general', 'Anything else'],
]

export const DEFAULT_WHATSAPP = {
  first_visit: 'Hi {first_name}, it’s {my_name} from {church_name}. It was lovely having you with us! How did you find the service? Is there anything we can pray with you about?',
  second_visit: 'Hi {first_name}, {my_name} from {church_name} here. So good to see you again! We’d love to help you get connected. Would you like to join our newcomers’ class?',
  absence: 'Hi {first_name}, it’s {my_name} from {church_name}. We’ve missed you these past few Sundays and just wanted to check in. How are you doing? Is there anything we can pray with you about?',
  general: 'Hi {first_name}, it’s {my_name} from {church_name}. ',
}

export function journeyFor(org) {
  const saved = org?.journey || {}
  return Object.fromEntries(JOURNEY_STEPS.map(({ key }) => [key, { ...DEFAULT_JOURNEY[key], ...(saved[key] || {}) }]))
}
export function whatsappFor(org) {
  return { ...DEFAULT_WHATSAPP, ...(org?.whatsapp_templates || {}) }
}

// Fills a WhatsApp template and returns a wa.me link (or null without a usable number).
export function whatsappLink({ template, phoneNorm, person = {}, churchName = '', myName = '' }) {
  if (!phoneNorm) return null
  const text = String(template || '')
    .replace(/\{first_name\}/g, person.first_name || '')
    .replace(/\{last_name\}/g, person.last_name || '')
    .replace(/\{church_name\}/g, churchName)
    .replace(/\{my_name\}/g, (myName || '').split(' ')[0] || myName)
  return `https://wa.me/${phoneNorm}${text.trim() ? `?text=${encodeURIComponent(text)}` : ''}`
}
