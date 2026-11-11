/**
 * Disks: inventory, temperature and SMART self-tests.
 *
 * TrueNAS 25.10 exposes no SMART attribute reader over the API (the `smart`
 * service methods are gone from `disk.*`, and the legacy `disk.smart_test`
 * endpoint still schedules a test but reports no results). So "health" here is
 * what the API can actually answer — model, bus, size, live temperature and a
 * startable self-test — and the tool does not invent a verdict it cannot see.
 */

import { formatBytes, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const DISK_SELECT = ['name', 'model', 'serial', 'size', 'type', 'bus', 'rotationrate', 'description', 'hddstandby']
const WIPE_MODES = ['QUICK', 'FULL', 'FULL_RANDOM']
const TEST_TYPES = ['SHORT', 'LONG', 'CONVEYANCE', 'OFFLINE']

function temperatureState(celsius) {
  if (celsius === undefined || celsius === null) return 'unknown'
  if (celsius >= 55) return 'hot'
  if (celsius >= 45) return 'warm'
  return 'ok'
}

async function diskNames(client) {
  const disks = await client.request('disk.query', [[], { select: ['name'], order_by: ['name'] }])
  return (Array.isArray(disks) ? disks : []).map((disk) => disk.name).filter(Boolean)
}

async function temperatures(client, names) {
  if (!names.length) return {}
  try {
    const map = await client.request('disk.temperatures', [names, false])
    return map && typeof map === 'object' ? map : {}
  } catch {
    // A NAS without SMART support simply has no temperatures; the inventory is
    // still useful, so this is not an error.
    return {}
  }
}

async function resolveDisk(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" with the disk device, for example "sda".' }
  const name = raw.replace(/^\/dev\//, '')
  const found = await client.request('disk.query', [[['name', '=', name]], { select: DISK_SELECT, get: true }])
  if (!found) return { ok: false, error: `No disk named "${name}". Run action "list" to see the devices.` }
  return { ok: true, disk: found }
}

export function createDisksTool(ctx) {
  return define(
    'truenas_disks',
    [
      'Inspect disks attached to TrueNAS: model, bus, size and live temperature, and start a SMART self-test.',
      'Wiping a disk is destructive and requires confirm: true; it erases the device, so only use it on a disk that is not part of any pool.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['list', 'temps', 'smart_test', 'wipe'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Disk device, for example "sda" (also accepts "/dev/sda").' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several disks at once for "temps"; omit to use every disk.',
        },
        testType: {
          type: 'string',
          enum: TEST_TYPES,
          description: 'SMART test type for "smart_test" (default SHORT).',
        },
        mode: {
          type: 'string',
          enum: WIPE_MODES,
          description: 'Wipe mode for "wipe": QUICK (first/last 32 MB), FULL or FULL_RANDOM (default QUICK).',
        },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "wipe".' },
      },
    },
    async (args) => {
      if (args.action === 'list' || args.action === 'temps') {
        return withInstance(ctx, args, async (client) => {
          const requested = Array.isArray(args.names) && args.names.length
            ? args.names.map((item) => String(item).replace(/^\/dev\//, ''))
            : undefined
          const filters = requested ? [['name', 'in', requested]] : []
          const disks = await client.request('disk.query', [filters, { select: DISK_SELECT, order_by: ['name'] }])
          const rows = Array.isArray(disks) ? disks : []
          const names = rows.map((disk) => disk.name).filter(Boolean)
          const temps = await temperatures(client, names)
          const diskRows = rows.map((disk) => {
            const celsius = typeof temps[disk.name] === 'number' ? temps[disk.name] : undefined
            return {
              name: disk.name,
              model: disk.model || '',
              bus: disk.bus || '',
              size: Number.isFinite(Number(disk.size)) ? formatBytes(Number(disk.size)) : '',
              type: disk.type || '',
              celsius: celsius === undefined ? '—' : `${celsius} °C`,
              state: temperatureState(celsius),
            }
          })
          if (!diskRows.length) return ok({ action: args.action, text: 'No disks matched.', data: { disks: [] } })
          const hot = diskRows.filter((row) => row.state === 'hot' || row.state === 'warm').length
          const summary =
            args.action === 'temps'
              ? `${diskRows.length} disks, ${hot} running warm or hot.`
              : `${diskRows.length} disks attached.`
          return ok({
            action: args.action,
            text: `${summary}\n${table(diskRows, [
              { key: 'name', header: 'Disk' },
              { key: 'model', header: 'Model' },
              { key: 'bus', header: 'Bus' },
              { key: 'size', header: 'Size' },
              { key: 'type', header: 'Type' },
              { key: 'celsius', header: 'Temp' },
              { key: 'state', header: 'Thermal' },
            ])}`,
            data: { disks: diskRows, warm: hot },
          })
        })
      }

      if (args.action === 'smart_test') {
        return withInstance(ctx, args, async (client) => {
          const found = await resolveDisk(client, args.name)
          if (!found.ok) return fail(found.error)
          const type = String(args.testType || 'SHORT').toUpperCase()
          if (!TEST_TYPES.includes(type)) return fail(`"testType" must be one of ${TEST_TYPES.join(', ')}.`)
          const outcome = await client.request('disk.smart_test', [[found.disk.name], type])
          if (typeof outcome === 'number') {
            const job = await client.waitJob(outcome, { timeoutMs: 120000 })
            return ok({
              action: 'smart_test',
              text: `SMART ${type} test on ${found.disk.name} finished: ${job?.state || 'unknown'}.`,
              data: { disk: found.disk.name, type, state: job?.state },
            })
          }
          return ok({
            action: 'smart_test',
            text: `Started a SMART ${type} self-test on ${found.disk.name}. The API exposes no result endpoint on this TrueNAS version, so check the disk's SMART data in the web UI after it finishes.`,
            data: { disk: found.disk.name, type },
          })
        })
      }

      if (args.action === 'wipe') {
        const refusal = requireConfirm(args, 'wipe a disk')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await resolveDisk(client, args.name)
          if (!found.ok) return fail(found.error)
          const mode = String(args.mode || 'QUICK').toUpperCase()
          if (!WIPE_MODES.includes(mode)) return fail(`"mode" must be one of ${WIPE_MODES.join(', ')}.`)
          const outcome = await client.request('disk.wipe', [found.disk.name, mode, true])
          if (typeof outcome === 'number') {
            const job = await client.waitJob(outcome, {
              timeoutMs: Math.min(Number(ctx.config?.jobTimeoutMs) || 600000, 600000),
            })
            return ok({
              action: 'wipe',
              text: `Wiped ${found.disk.name} (${mode}): ${job?.state || 'unknown'}.`,
              data: { disk: found.disk.name, mode, state: job?.state },
            })
          }
          return ok({
            action: 'wipe',
            text: `Started a ${mode} wipe of ${found.disk.name}. Every byte on the device is being destroyed.`,
            data: { disk: found.disk.name, mode },
          })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, temps, smart_test, wipe.`)
    },
  )
}
