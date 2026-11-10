/**
 * The Docker engine behind the Apps system.
 *
 * TrueNAS runs applications on its own Docker daemon; these methods report the
 * daemon state, its configuration and networks, and manage the dataset backups
 * the Apps subsystem can take. Installing applications stays in `truenas_apps`.
 */

import { formatDate, keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

export function createDockerTool(ctx) {
  return define(
    'truenas_docker',
    [
      'The Docker engine behind TrueNAS Apps: daemon status and configuration, networks, NVIDIA presence, and Apps dataset backups (list, back up to a pool, restore).',
      'Restoring a backup replaces the Apps dataset configuration, so it requires confirmation.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['status', 'config', 'networks', 'nvidia', 'backups', 'backup', 'restore'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Backup name for "restore".' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "restore".' },
      },
    },
    async (args) => {
      if (args.action === 'status') {
        return withInstance(ctx, args, async (client) => {
          const status = await client.request('docker.status', [])
          const values = Object.entries(status && typeof status === 'object' ? status : {})
          return ok({
            action: 'status',
            text: values.length
              ? keyValues(values.map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]))
              : String(status),
            data: { status },
          })
        })
      }

      if (args.action === 'config') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('docker.config', [])
          const pools = Array.isArray(config?.address_pools)
            ? config.address_pools.map((pool) => `${pool.base} (/${pool.size})`).join(', ')
            : '—'
          return ok({
            action: 'config',
            text: keyValues([
              ['Dataset', config?.dataset || '—'],
              ['Pool', config?.pool || '—'],
              ['Image updates', config?.enable_image_updates ? 'enabled' : 'disabled'],
              ['NVIDIA runtime', config?.nvidia ? 'enabled' : 'not exposed'],
              ['Address pools', pools],
              ['IPv6 CIDR', config?.cidr_v6 || '—'],
              ['Insecure mirrors', Array.isArray(config?.insecure_registry_mirrors) && config.insecure_registry_mirrors.length ? config.insecure_registry_mirrors.join(', ') : 'none'],
              ['Secure mirrors', Array.isArray(config?.secure_registry_mirrors) && config.secure_registry_mirrors.length ? config.secure_registry_mirrors.join(', ') : 'none'],
            ]),
            data: { config },
          })
        })
      }

      if (args.action === 'networks') {
        return withInstance(ctx, args, async (client) => {
          const networks = await client.request('docker.network.query', [[], {}])
          const rows = (Array.isArray(networks) ? networks : []).map((network) => ({
            id: String(network.id || '').slice(0, 12),
            name: network.name || network.Name || '',
            driver: network.driver || network.Driver || '',
            scope: network.scope || network.Scope || '',
          }))
          if (!rows.length) return ok({ action: 'networks', text: 'No Docker networks reported.', data: { networks: [] } })
          return ok({
            action: 'networks',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'driver', header: 'Driver' },
              { key: 'scope', header: 'Scope' },
            ]),
            data: { networks: rows },
          })
        })
      }

      if (args.action === 'nvidia') {
        return withInstance(ctx, args, async (client) => {
          const present = await client.request('docker.nvidia_present', [])
          return ok({
            action: 'nvidia',
            text: `NVIDIA container toolkit: ${present ? 'present' : 'not detected'}`,
            data: { present: Boolean(present) },
          })
        })
      }

      if (args.action === 'backups') {
        return withInstance(ctx, args, async (client) => {
          const backups = await client.request('docker.list_backups', [])
          const rows = (Array.isArray(backups) ? backups : []).map((backup) => ({
            name: backup.name || '',
            created: backup.created_at || backup.created ? formatDate(backup.created_at || backup.created) : '',
            path: backup.path || '',
          }))
          if (!rows.length) return ok({ action: 'backups', text: 'No Apps dataset backups found.', data: { backups: [] } })
          return ok({
            action: 'backups',
            text: table(rows, [
              { key: 'name', header: 'Backup' },
              { key: 'created', header: 'Created' },
              { key: 'path', header: 'Path' },
            ]),
            data: { backups: rows },
          })
        })
      }

      if (args.action === 'backup') {
        return withInstance(ctx, args, async (client) => {
          const jobId = await client.request('docker.backup_to_pool', [])
          const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({ action: 'backup', text: `Apps dataset backup finished (job ${jobId}, ${job.state}).`, data: { job } })
        })
      }

      if (args.action === 'restore') {
        const refusal = requireConfirm(args, 'restore an Apps dataset backup')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const name = String(args.name || '').trim()
          if (!name) return fail('Pass "name" with the backup to restore (action "backups" lists them).')
          const jobId = await client.request('docker.restore_backup', [name])
          const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({ action: 'restore', text: `Restored Apps backup "${name}" (job ${jobId}, ${job.state}).`, data: { job } })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )
}
