// Firebase Auth in the browser. Used only to prove identity: after sign-in the ID token is
// exchanged for an HttpOnly session cookie and the client signs out of Firebase again.
import { api } from './api'

// Firebase web settings are public identifiers (not secrets). Production builds fall back to the
// gather-hq-main project so sign-in works even if the VITE_FIREBASE_* variables are not set.
const PROD = import.meta.env.PROD && !import.meta.env.VITE_LOCAL_DEV
const DEFAULTS = PROD ? {
  apiKey: 'AIzaSyAj0TwDMDmahVqrQp0cOHqGlCkiq-DxOj0',
  authDomain: 'gather-hq-main.firebaseapp.com',
  projectId: 'gather-hq-main',
  appId: '1:351585370209:web:9a8feda39c2b39a503aa20',
} : {}
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || DEFAULTS.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || DEFAULTS.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || DEFAULTS.projectId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || DEFAULTS.appId,
}
export const firebaseConfigured = () => !!config.apiKey

let ready = null
async function auth() {
  if (!firebaseConfigured()) throw new Error('Sign-in is not configured yet (missing Firebase web settings).')
  if (!ready) {
    ready = (async () => {
      const [{ initializeApp }, A] = await Promise.all([import('firebase/app'), import('firebase/auth')])
      const app = initializeApp(config)
      const a = A.getAuth(app)
      await A.setPersistence(a, A.inMemoryPersistence)
      return { a, A }
    })()
  }
  return ready
}

const MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes, or reset your password.',
  'auth/network-request-failed': "Can't reach the sign-in service. Check your connection and try again.",
  'auth/user-disabled': 'This account has been disabled.',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
  'auth/requires-recent-login': 'Please sign in again, then retry.',
}
export function authMessage(e) { return MESSAGES[e?.code] || e?.message || 'Sign-in failed. Please try again.' }

export async function signInWithPassword(email, password) {
  // Local demo server only (no Firebase web settings): it converts these into a stand-in token.
  if (!firebaseConfigured() && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    await api.post('/auth/session', { devEmail: email, devPassword: password })
    return
  }
  const { a, A } = await auth()
  try {
    const cred = await A.signInWithEmailAndPassword(a, email.trim(), password)
    const idToken = await cred.user.getIdToken()
    await api.post('/auth/session', { idToken })
    await A.signOut(a)
  } catch (e) {
    if (e.code) throw new Error(authMessage(e))
    throw e
  }
}

export async function sendReset(email) {
  const { a, A } = await auth()
  try { await A.sendPasswordResetEmail(a, email.trim()) }
  catch (e) { if (e.code === 'auth/user-not-found') return; throw new Error(authMessage(e)) }
}

// Changing a password revokes existing sessions, so we sign straight back in with the new one.
export async function changePassword(email, current, next) {
  const { a, A } = await auth()
  try {
    const cred = await A.signInWithEmailAndPassword(a, email, current)
    await A.updatePassword(cred.user, next)
    await A.signOut(a)
  } catch (e) { throw new Error(authMessage(e)) }
  await signInWithPassword(email, next)
}
