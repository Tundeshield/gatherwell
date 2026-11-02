// Loads Paddle.js once and opens Paddle's checkout over the page.
let loading = null
let handler = null

function load() {
  if (window.Paddle) return Promise.resolve(window.Paddle)
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
      s.async = true
      s.onload = () => resolve(window.Paddle)
      s.onerror = () => { loading = null; reject(new Error('Couldn’t load the payment page. Check your connection and try again.')) }
      document.head.appendChild(s)
    })
  }
  return loading
}

let initialised = null
/**
 * Opens checkout for a price. `onComplete(transactionId)` runs when payment succeeds,
 * `onClose()` when the person closes the checkout without paying.
 */
export async function openCheckout({ environment, token, priceId, customer, customData, onComplete, onClose }) {
  const Paddle = await load()
  handler = { onComplete, onClose }
  if (initialised !== token) {
    if (environment === 'sandbox') Paddle.Environment.set('sandbox')
    Paddle.Initialize({
      token,
      eventCallback: (e) => {
        if (e.name === 'checkout.completed') { const id = e.data?.transaction_id; setTimeout(() => Paddle.Checkout.close(), 1500); handler?.onComplete?.(id) }
        if (e.name === 'checkout.closed') handler?.onClose?.()
      },
    })
    initialised = token
  }
  Paddle.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    customer,
    customData,
    settings: { displayMode: 'overlay', theme: 'light', allowLogout: false, showAddDiscounts: true },
  })
}
