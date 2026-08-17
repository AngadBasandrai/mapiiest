/**
 * The bits that make this an installable, offline-capable app rather than a
 * page: registering the service worker, taking its updates without a reload
 * loop, and telling the user when the map has lost the network.
 *
 * The worker itself is generated at build time by vite.config.ts, which is the
 * only place that knows the hashed asset filenames.
 */

const base = import.meta.env.BASE_URL

/* ── a small status line, bottom centre ─────────────────────────────────── */

let toast: HTMLElement | null = null

function say(html: string, kind: 'info' | 'warn', persist = false) {
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    document.body.append(toast)
    toast.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.dismiss !== undefined) hide()
    })
  }
  toast.className = kind
  toast.innerHTML = `${html}<button class="x" data-dismiss aria-label="Dismiss">&times;</button>`
  toast.hidden = false
  if (!persist) {
    clearTimeout(timer)
    timer = setTimeout(hide, 6000)
  }
}
let timer: ReturnType<typeof setTimeout> | undefined
function hide() {
  clearTimeout(timer)
  if (toast) toast.hidden = true
}

/* ── service worker ─────────────────────────────────────────────────────── */

export function registerServiceWorker() {
  // Dev has no generated worker, and a stale one would serve yesterday's
  // bundle over the dev server — so only ever register in a build.
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return

  navigator.serviceWorker.register(`${base}sw.js`).then((reg) => {
    // A worker that arrives while the page is open has fresher data than what
    // is on screen. Say so rather than swapping it out underneath the user:
    // reloading a map without warning loses wherever they had panned to.
    reg.addEventListener('updatefound', () => {
      const fresh = reg.installing
      if (!fresh) return
      fresh.addEventListener('statechange', () => {
        if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
          say('A new version of the map is ready. <button data-reload>Reload</button>', 'info', true)
          toast?.querySelector('[data-reload]')?.addEventListener('click', () => location.reload())
        }
      })
    })
  }).catch((err) => {
    // Not fatal — the app works, it just will not work offline.
    console.warn('[sw] registration failed:', err?.message ?? err)
  })
}

/* ── offline ────────────────────────────────────────────────────────────── */

/**
 * Aerial imagery is the default ground and it needs the network, so going
 * offline is the one state where the map can look broken through no fault of
 * its own: dimmed fills and no photograph under them. Hand back the drawn map
 * instead and say why.
 *
 * `onOffline` is expected to turn imagery off; `onOnline` is told whether it was
 * this that turned it off, so it only restores what it took.
 */
export function watchNetwork(hooks: { imageryOn: () => boolean; setImagery: (on: boolean) => void }) {
  let weTurnedItOff = false

  const OFFLINE_NOTE = 'Offline — showing the drawn map. Aerial imagery needs a connection.'

  const dropImagery = (note: string) => {
    if (hooks.imageryOn()) {
      weTurnedItOff = true
      hooks.setImagery(false)
      say(note, 'warn')
    }
  }

  const goneOffline = () => {
    if (hooks.imageryOn()) {
      weTurnedItOff = true
      hooks.setImagery(false)
      say('Offline — showing the drawn map. Aerial imagery needs a connection.', 'warn')
    } else {
      say('Offline. The map itself is cached and works; imagery does not.', 'warn')
    }
  }

  const backOnline = () => {
    if (weTurnedItOff) {
      weTurnedItOff = false
      hooks.setImagery(true)
      say('Back online — imagery restored.', 'info')
    } else {
      hide()
    }
  }

  window.addEventListener('offline', goneOffline)
  window.addEventListener('online', backOnline)

  // Starting up offline is the same situation, minus the transition.
  if (!navigator.onLine) dropImagery(OFFLINE_NOTE)

  /**
   * `navigator.onLine` is the cheap signal, not a reliable one — it is true on a
   * captive portal, true when only that one host is unreachable, and some
   * environments never flip it at all. So the tiles themselves get a vote: if
   * enough of them fail while imagery is on, fall back regardless of what the
   * flag says.
   */
  // The service worker is the only thing that sees a tile request fail:
  // MapLibre drops a failed raster tile silently, with no error event and
  // nothing in the console, so the page cannot tell on its own.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if ((e.data as { type?: string })?.type !== 'imagery-unreachable') return
    dropImagery('Aerial imagery is not loading — showing the drawn map instead.')
  })
}
