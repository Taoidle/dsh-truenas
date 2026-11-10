/**
 * HTTP surface for the plugin's own settings page.
 *
 * The page runs on the DSH web origin, so it talks to same-origin routes
 * registered here. The routes expose only instance metadata and the
 * verify-then-save operations; the API key travels from the form to the DSH
 * credential store and is never read back out.
 */

import { errorText } from './format.js'
import { readJsonBody, requestRejection, writeJson } from './http.js'

export const CONFIG_PATH = '/dsh-truenas/config'
export const ACTION_PATH = '/dsh-truenas/action'

function methodGuard(req, res, expected) {
  const status = requestRejection(req)
  if (status) {
    writeJson(res, status, { ok: false, error: 'This request was refused by the plugin origin check.' })
    return false
  }
  if (req.method === 'HEAD' && expected === 'GET') return true
  if (req.method !== expected) {
    res.setHeader('Allow', expected)
    writeJson(res, 405, { ok: false, error: `This route accepts ${expected} only.` })
    return false
  }
  return true
}

/**
 * Register the settings routes on the DSH web server. Returns the disposers and
 * whether the web server was available at all, so a headless host can skip the
 * UI surface without failing plugin activation.
 */
export function registerRoutes(ctx, admin) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') {
    return { registered: false, paths: [] }
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: async (req, res) => {
        if (!methodGuard(req, res, 'GET')) return
        try {
          const state = await admin.list()
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          writeJson(res, 200, state)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (!methodGuard(req, res, 'POST')) return
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          writeJson(res, error?.statusCode || 400, { ok: false, error: errorText(error) })
          return
        }
        try {
          const result = await admin.perform(body)
          writeJson(res, result?.ok ? 200 : 400, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    }),
  ]

  return { registered: true, disposers, paths: [CONFIG_PATH, ACTION_PATH] }
}
