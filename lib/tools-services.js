/**
 * System services: list them, start/stop/restart/reload, and set the
 * enable-on-boot flag.
 *
 * `service.control(verb, name, options)` is the general entry point and is a
 * job ("START"/"STOP"/"RESTART"/"RELOAD"); `service.update(id, {enable})`
 * changes the boot setting. The two are deliberately separate in TrueNAS, so
 * this tool keeps them separate too: "restart" never flips the boot flag.
 */

import { keyValues, table } from './format.js'
import { INSTANCE_PARAM, define, fail, ok, withInstance } from './tool-kit.js'

const SERVICE_SELECT = ['id', 'service', 'state', 'enable']

/** name used by `service.control` */
function serviceName(entry) {
  return entry?.service || entry?.name || ''
}

function controlOptions(args) {
  const options = { silent: false, timeout: Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : 120 }
  if (args.haPropagate !== undefined) options.ha_propagate = args.haPropagate === true
  return options
}

/**
 * `service.query` filters on the "service" column, not "name"; accept either a
 * numeric id or the exact service name, matching how the UI addresses rows.
 */
async function findService(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" (or "id") with the service, for example "smb".' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['service', '=', raw]]
  const found = await client.request('service.query', [filters, { select: SERVICE_SELECT, get: true }])
  if (!found) {
    return { ok: false, error: `No service matches "${raw}". Run action "list" to see the service names.` }
  }
  return { ok: true, service: found }
}

async function runControl(client, ctx, name, verb, args) {
  const outcome = await client.request('service.control', [verb, name, controlOptions(args)])
  let running = null
  if (typeof outcome === 'number') {
    const job = await client.waitJob(outcome, {
      timeoutMs: Math.min(Number(ctx.config?.jobTimeoutMs) || 600000, 300000),
    })
    running = typeof job?.result === 'boolean' ? job.result : null
  } else if (typeof outcome === 'boolean') {
    running = outcome
  }
  return running
}

export function createServicesTool(ctx) {
  return define(
    'truenas_services',
    [
      'Control TrueNAS system services (SMB, NFS, SSH, iSCSI, rsync, smart, …): list them with their running state and boot flag, start/stop/restart/reload one, and turn enable-on-boot on or off.',
      'Service operations run as jobs and wait by default; passing wait: false returns as soon as the NAS accepts the request.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['list', 'start', 'stop', 'restart', 'reload', 'enable', 'disable'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Service name or numeric id, for example "smb", "ssh", "iscsi".' },
        timeout: { type: 'number', description: 'Seconds to let the NAS spend on the operation (default 120).' },
        haPropagate: { type: 'boolean', description: 'High-availability setups: propagate the operation to the peer (default true).' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const services = await client.request('service.query', [[], { select: SERVICE_SELECT, order_by: ['service'] }])
          const rows = (Array.isArray(services) ? services : []).map((service) => ({
            id: service.id,
            name: serviceName(service),
            state: service.state || 'UNKNOWN',
            enabled: service.enable ? 'yes' : 'no',
          }))
          if (!rows.length) return ok({ action: 'list', text: 'The NAS reported no services.', data: { services: [] } })
          const running = rows.filter((row) => row.state === 'RUNNING').length
          return ok({
            action: 'list',
            text: `${running} of ${rows.length} services running.\n${table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Service' },
              { key: 'state', header: 'State' },
              { key: 'enabled', header: 'Start on boot' },
            ])}`,
            data: { services: rows, running },
          })
        })
      }

      const verbs = { start: 'START', stop: 'STOP', restart: 'RESTART', reload: 'RELOAD' }
      if (verbs[args.action]) {
        return withInstance(ctx, args, async (client) => {
          const found = await findService(client, args.name ?? args.id)
          if (!found.ok) return fail(found.error)
          const name = serviceName(found.service)
          const running = await runControl(client, ctx, name, verbs[args.action], args)
          return ok({
            action: args.action,
            text: keyValues([
              ['Service', name],
              ['Operation', verbs[args.action]],
              ['Running now', running === null ? 'unknown' : running ? 'yes' : 'no'],
            ]),
            data: { service: name, verb: verbs[args.action], running },
          })
        })
      }

      if (args.action === 'enable' || args.action === 'disable') {
        return withInstance(ctx, args, async (client) => {
          const found = await findService(client, args.name ?? args.id)
          if (!found.ok) return fail(found.error)
          const enabled = args.action === 'enable'
          const name = serviceName(found.service)
          const updated = await client.request('service.update', [found.service.id, { enable: enabled }])
          return ok({
            action: args.action,
            text: `${name}: start on boot ${enabled ? 'enabled' : 'disabled'} (currently ${updated?.state || 'unknown'}).`,
            data: { service: name, enable: updated?.enable ?? enabled },
          })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, start, stop, restart, reload, enable, disable.`)
    },
  )
}
