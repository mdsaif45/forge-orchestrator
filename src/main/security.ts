import { app, shell, session, type BrowserWindow } from 'electron'

/**
 * Process-level security policy.
 *
 * Forge will hold source code, filesystem access, terminals, and agent sessions,
 * so the renderer is treated as untrusted from the start (axiom A7). These are
 * app-wide guards; they are not the same as the agent permission model in #37.
 */

/**
 * The renderer loads only local content and talks only to main.
 *
 * `'self'` covers the packaged file:// origin; the dev server needs its own
 * origin plus inline styles, because Vite injects styles during HMR. `connect`
 * allows the dev websocket, and nothing else.
 */
export function contentSecurityPolicy(devServerUrl: string | undefined): string {
  const isDev = devServerUrl !== undefined
  const devOrigin = isDev ? ` ${devServerUrl}` : ''
  const devSocket = isDev ? ` ${devServerUrl.replace(/^http/, 'ws')}` : ''

  return [
    `default-src 'self'${devOrigin}`,
    // Dev needs 'unsafe-inline' for HMR-injected styles; production does not.
    `style-src 'self'${devOrigin}${isDev ? " 'unsafe-inline'" : ''}`,
    // And for scripts, for the same reason: `@vitejs/plugin-react` injects an inline
    // module preamble that installs the Fast Refresh hooks. Blocking it does not degrade
    // HMR — it stops the app booting at all, with `can't detect preamble` thrown from
    // whichever component happens to load first and an empty `#root` behind it.
    //
    // Production is unaffected and stays strict: a built bundle has no inline script, so
    // this is invisible to `npm run check` and to CI, which is exactly how a dev-only
    // blank window survived both.
    `script-src 'self'${devOrigin}${isDev ? " 'unsafe-inline'" : ''}`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    `connect-src 'self'${devOrigin}${devSocket}`,
    // No plugins, no embedding, no base-tag hijacking, no form posts anywhere.
    `object-src 'none'`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `worker-src 'self'`,
  ].join('; ')
}

/** Applies the CSP to every response, so it cannot be forgotten per-window. */
export function applyContentSecurityPolicy(devServerUrl: string | undefined): void {
  const policy = contentSecurityPolicy(devServerUrl)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

/**
 * Denies every permission request (camera, geolocation, notifications, and so
 * on). Forge needs none of them; anything that becomes necessary later must be
 * allowlisted deliberately rather than inherited by default.
 */
export function denyAllPermissionRequests(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

/**
 * Locks a window's navigation.
 *
 * Two distinct escapes are closed: in-page navigation away from the app origin,
 * and `window.open` / target=_blank. External links are handed to the OS browser,
 * which keeps untrusted pages out of a privileged renderer.
 */
export function lockWindowNavigation(
  window: BrowserWindow,
  allowedOrigin: string | undefined,
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttp(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin !== undefined && url.startsWith(allowedOrigin)) return
    event.preventDefault()
    if (isExternalHttp(url)) void shell.openExternal(url)
  })

  // A renderer should never be able to attach a webview.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

function isExternalHttp(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}

/**
 * Refuses to run a second instance against the same user data, which would
 * otherwise mean two orchestrators writing one SQLite file and one working tree.
 *
 * Returns false when this process should quit immediately.
 */
export function claimSingleInstance(): boolean {
  return app.requestSingleInstanceLock()
}
