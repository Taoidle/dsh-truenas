/**
 * Certificates: the signed certificates the NAS holds, their expiry, and the
 * ACME plumbing that can issue more.
 *
 * TrueNAS 25.10 exposes no renewal endpoint: `certificate.*` has create /
 * update / delete / query only, and the `acme` plugin is just
 * `acme.dns.authenticator`. Renewal therefore stays a web-UI action, and this
 * tool says so instead of pretending otherwise.
 */

import { formatDate, keyValues, table, truncate } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const CERT_SELECT = [
  'id',
  'name',
  'type',
  'from',
  'until',
  'expired',
  'lifetime',
  'san',
  'key_type',
  'cert_type',
  'acme',
  'renew_days',
]

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `until` arrives as "Sun May 16 11:27:09 2027" on some builds and as an ISO
 * string on others; both are parseable, anything else is reported as unknown
 * rather than guessed.
 */
function parseDate(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object' && value.$date !== undefined) {
    const parsed = new Date(Number(value.$date))
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function daysLeft(until) {
  const parsed = parseDate(until)
  if (!parsed) return undefined
  return Math.floor((parsed.getTime() - Date.now()) / DAY_MS)
}

function certRow(cert) {
  const days = daysLeft(cert.until)
  return {
    id: cert.id,
    name: cert.name || `certificate ${cert.id}`,
    type: cert.cert_type || String(cert.type ?? ''),
    issuer: truncate(String(cert.issuer || cert.DN || ''), 40),
    common: cert.common || '',
    until: parseDate(cert.until) ? formatDate(parseDate(cert.until).getTime()) : String(cert.until ?? ''),
    days,
    state: cert.expired ? 'EXPIRED' : days !== undefined && days <= (cert.renew_days ?? 10) ? 'RENEW SOON' : 'valid',
    acme: cert.acme !== null && cert.acme !== undefined ? 'yes' : 'no',
    names: Array.isArray(cert.san) ? cert.san.join(', ') : '',
  }
}

async function findCert(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "id" (or "name") with the certificate.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['name', '=', raw]]
  const found = await client.request('certificate.query', [filters, { select: CERT_SELECT, get: true }])
  if (!found) return { ok: false, error: `No certificate matches "${raw}". Run action "list" to see them.` }
  return { ok: true, certificate: found }
}

export function createCertsTool(ctx) {
  return define(
    'truenas_certificates',
    [
      'Inspect the certificates TrueNAS holds and their expiry, list the ACME servers and DNS authenticators available for issuing them, and delete a certificate.',
      'Renewal is not exposed by the TrueNAS 25.10 API (there is no renew method, and the acme plugin only holds DNS authenticators), so renew an ACME certificate from the NAS web UI; use this tool to find out which certificate is about to expire.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['list', 'get', 'delete', 'acme_servers', 'authenticators'],
          description: 'What to do.',
        },
        id: { type: 'string', description: 'Certificate id or exact name ("get", "delete").' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "delete".' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const certs = await client.request('certificate.query', [[], { select: CERT_SELECT, order_by: ['name'] }])
          const rows = (Array.isArray(certs) ? certs : []).map(certRow)
          if (!rows.length) return ok({ action: 'list', text: 'No certificates on this NAS.', data: { certificates: [] } })
          const expiring = rows.filter((row) => row.state !== 'valid')
          const summary = expiring.length
            ? `${expiring.length} of ${rows.length} certificates need attention.`
            : `All ${rows.length} certificates are valid.`
          return ok({
            action: 'list',
            text: `${summary}\n${table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'type', header: 'Type' },
              { key: 'until', header: 'Expires' },
              { key: 'days', header: 'Days left' },
              { key: 'state', header: 'State' },
              { key: 'acme', header: 'ACME' },
            ])}`,
            data: { certificates: rows, expiring: expiring.length },
          })
        })
      }

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findCert(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          const cert = found.certificate
          const row = certRow(cert)
          return ok({
            action: 'get',
            text: keyValues([
              ['Name', row.name],
              ['ID', cert.id],
              ['Type', row.type],
              ['Subject', cert.DN || row.common || ''],
              ['Names', row.names || '(none)'],
              ['Issued', parseDate(cert.from) ? formatDate(parseDate(cert.from).getTime()) : String(cert.from ?? '')],
              ['Expires', row.until],
              ['Days left', row.days ?? 'unknown'],
              ['State', row.state],
              ['Key', cert.key_type ? `${cert.key_type}${cert.key_length ? ` ${cert.key_length}` : ''}` : ''],
              ['ACME', row.acme],
              ['Renew window', cert.renew_days !== undefined && cert.renew_days !== null ? `${cert.renew_days} days` : ''],
            ]),
            data: row,
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a certificate')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findCert(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          const name = found.certificate.name || String(found.certificate.id)
          const outcome = await client.request('certificate.delete', [found.certificate.id])
          if (typeof outcome === 'number') await client.waitJob(outcome, { timeoutMs: 120000 })
          return ok({
            action: 'delete',
            text: `Deleted certificate ${name} (id ${found.certificate.id}). Services using it lost their certificate.`,
            data: { id: found.certificate.id, name },
          })
        })
      }

      if (args.action === 'acme_servers') {
        return withInstance(ctx, args, async (client) => {
          const servers = await client.request('certificate.acme_server_choices', [])
          const rows = Object.entries(servers || {}).map(([name, url]) => ({ name, url }))
          if (!rows.length) return ok({ action: 'acme_servers', text: 'The NAS reported no ACME servers.', data: { servers: [] } })
          return ok({
            action: 'acme_servers',
            text: table(rows, [
              { key: 'name', header: 'ACME server' },
              { key: 'url', header: 'Directory URL' },
            ]),
            data: { servers: rows },
          })
        })
      }

      if (args.action === 'authenticators') {
        return withInstance(ctx, args, async (client) => {
          const list = await client.request('acme.dns.authenticator.query', [
            [],
            { select: ['id', 'name', 'attributes'], order_by: ['name'] },
          ])
          const rows = (Array.isArray(list) ? list : []).map((item) => ({
            id: item.id,
            name: item.name,
            type: item.attributes?.authenticator || '',
          }))
          if (!rows.length) {
            return ok({
              action: 'authenticators',
              text: 'No ACME DNS authenticators are configured, so only HTTP validation is available for new certificates.',
              data: { authenticators: [] },
            })
          }
          return ok({
            action: 'authenticators',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'type', header: 'Provider' },
            ]),
            data: { authenticators: rows },
          })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, get, delete, acme_servers, authenticators.`)
    },
  )
}
