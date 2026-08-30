import { SITE } from '../config'

/**
 * Pageview counting, via GoatCounter.
 *
 * The site went its whole life making exactly one request to anywhere else —
 * the aerial tiles — and this is the second. That is worth being deliberate
 * about, so what it does and does not do is spelled out here rather than left
 * to a vendor's marketing page:
 *
 *   - No cookies, no localStorage, no fingerprint, no identifier that survives
 *     the request. GoatCounter derives a per-day hash from IP + User-Agent to
 *     tell one visit from two page loads, and discards the IP. Nothing here
 *     needs a consent banner, which is the whole reason for choosing it.
 *   - One beacon per page load. It does not see what was searched, which place
 *     was opened, or which layers were toggled — the survey tool's own data
 *     never leaves the browser and neither does anything else.
 *   - It never runs in development, on localhost, or under Do Not Track.
 *
 * It is also entirely optional: with no code in site.config.json this module
 * does nothing at all, which is the state the repo ships in.
 */

const SRC = 'https://gc.zgo.at/count.js'

/** Where the app is being run from rather than visited. */
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ''])

export function initAnalytics() {
  const code = SITE.analytics?.goatcounter?.trim()
  if (!code) return

  // A dev server and the browser-verification run both live on localhost, and
  // both would otherwise be counted as visitors. `import.meta.env.DEV` alone
  // does not cover the second: `npm run verify` drives a *production* build,
  // so the hostname is the check that actually holds.
  if (import.meta.env.DEV) return
  if (LOCAL.has(location.hostname)) return

  // Honoured client-side because GoatCounter does not do it for us. A visitor
  // who has asked not to be counted is a visitor who should not be counted,
  // and the cost of agreeing is one number being slightly low.
  const dnt = navigator.doNotTrack ?? (navigator as { msDoNotTrack?: string }).msDoNotTrack
  if (dnt === '1' || dnt === 'yes' ||
      (window as { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return

  const s = document.createElement('script')
  s.src = SRC
  s.async = true
  s.dataset.goatcounter = `https://${code}.goatcounter.com/count`
  // Blocked by an extension, or the network is gone: both are ordinary and
  // neither is the visitor's problem. Swallow it — an uncaught load error
  // would surface in the console, and the browser test fails on those.
  s.onerror = () => { /* counted or not, the map works the same */ }
  document.head.append(s)
}
