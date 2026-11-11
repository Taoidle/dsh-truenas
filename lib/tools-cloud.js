/**
 * Cloud sync tasks (rclone) and cloud backup tasks (restic).
 *
 * Both are job-backed: sync/restore return a job id, so the tool waits for it
 * unless the caller passes wait:false. Create takes a raw data object because
 * the payload differs per provider (S3, B2, Google Drive, …).
 */

import { formatDate, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const SYNC_SELECT = [
  'id',
  'description',
  'path',
  'direction',
  'transfer_mode',
  'enabled',
  'job',
  'last_run',
  'credentials',
]

const BACKUP_SELECT = ['id', 'description', 'path', 'credentials', 'enabled', 'job', 'last_run']

function runState(entry) {
  const run = entry?.last_run
  if (!run) return 'never run'
  const state = run.state ? String(run.state).toLowerCase() : 'run'
  const when = run.end_time || run.start_time
  return when ? `${state} ${formatDate(when)}` : state
}

async function findSync(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" (or "id") with the task description.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['description', '=', raw]]
  const found = await client.request('cloudsync.query', [filters, { select: SYNC_SELECT, get: true }])
  if (!found) return { ok: false, error: `No cloud sync task matches "${raw}". Run action "list" to see them.` }
  return { ok: true, sync: found }
}

async function findBackup(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" (or "id") with the backup task description.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['description', '=', raw]]
  const found = await client.request('cloud_backup.query', [filters, { select: BACKUP_SELECT, get: true }])
  if (!found) return { ok: false, error: `No cloud backup task matches "${raw}". Run action "backups" to see them.` }
  return { ok: true, backup: found }
}

async function runJob(ctx, client, action, label, method, params, wait) {
  const jobId = await client.request(method, params)
  if (typeof jobId !== 'number') {
    return ok({ action, text: `Started ${label}.`, data: { job: jobId } })
  }
  if (wait === false) {
    return ok({ action, text: `Started ${label} as job ${jobId}.`, data: { job: jobId } })
  }
  const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
  return ok({ action, text: `${label} finished with state ${job.state}.`, data: { job: { id: job.id, state: job.state } } })
}

export function createCloudTool(ctx) {
  return define(
    'truenas_cloud',
    [
      'Manage TrueNAS cloud sync tasks (rclone: S3, Backblaze, Google Drive, WebDAV, …) and cloud backup tasks (restic to a remote repository): list them, start a run or a one-off transfer, restore, and delete.',
      'A sync in the wrong direction can overwrite the remote or the local side; start, restore and delete need the direction confirmed with the user first.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: [
            'list',
            'backups',
            'get',
            'create',
            'sync',
            'sync_onetime',
            'restore',
            'abort',
            'delete',
            'credentials',
            'credential_add',
            'credential_update',
            'credential_remove',
          ],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Task description, or its integer id as a string.' },
        id: { type: 'number', description: 'Task id (alternative to "name").' },
        data: {
          type: 'object',
          additionalProperties: true,
          description:
            'Raw payload for cloudsync.create or cloudsync.sync_onetime: description, path, credentials, direction (PUSH|PULL), transfer_mode, encryption, …',
        },
        credential: { type: 'number', description: 'Credential id for "credential_update" and "credential_remove".' },
        credentialName: { type: 'string', description: 'Credential name for "credential_add".' },
        wait: { type: 'boolean', description: 'Wait for the job to finish (default true).' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for create, sync, sync_onetime, restore and delete.' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const tasks = await client.request('cloudsync.query', [[], { select: SYNC_SELECT, order_by: ['description'] }])
          if (!Array.isArray(tasks) || !tasks.length) return ok({ action: 'list', text: 'No cloud sync tasks configured.', data: { tasks: [] } })
          const lines = tasks.map((task, index) => {
            const target = String(task.credentials?.provider?.type || 'credentials')
            return [
              `${index + 1}. ${task.description} (id ${task.id})`,
              `   ${task.path} → ${target} · ${task.direction} · ${task.transfer_mode || ''} · ${task.enabled ? 'enabled' : 'disabled'} · ${runState(task)}`,
            ].join('\n')
          })
          return ok({
            action: 'list',
            text: lines.join('\n'),
            data: {
              tasks: tasks.map((task) => ({
                id: task.id,
                description: task.description,
                path: task.path,
                direction: task.direction,
                transferMode: task.transfer_mode,
                enabled: task.enabled,
                lastRun: runState(task),
              })),
            },
          })
        })
      }

      if (args.action === 'backups') {
        return withInstance(ctx, args, async (client) => {
          const tasks = await client.request('cloud_backup.query', [[], { select: BACKUP_SELECT, order_by: ['description'] }])
          if (!Array.isArray(tasks) || !tasks.length) return ok({ action: 'backups', text: 'No cloud backup tasks configured.', data: { tasks: [] } })
          const lines = tasks.map((task, index) => {
            const provider = String(task.credentials?.provider?.type || 'credentials')
            return `${index + 1}. ${task.description} (id ${task.id})\n   ${task.path} → ${provider} · ${task.enabled ? 'enabled' : 'disabled'} · ${runState(task)}`
          })
          return ok({
            action: 'backups',
            text: lines.join('\n'),
            data: { tasks: tasks.map((task) => ({ id: task.id, description: task.description, path: task.path, enabled: task.enabled })) },
          })
        })
      }

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findSync(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          return ok({ action: 'get', text: `${found.sync.description} (id ${found.sync.id})`, data: { task: found.sync } })
        })
      }

      if (args.action === 'create') {
        const refusal = requireConfirm(args, 'create a cloud sync task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const payload = args.data && typeof args.data === 'object' ? { ...args.data } : null
          if (!payload) return fail('Pass "data" with the cloudsync.create payload (description, path, credentials, direction, …).')
          if (!payload.description) return fail('The "data" payload needs a description for the task.')
          const created = await client.request('cloudsync.create', [payload])
          return ok({
            action: 'create',
            text: `Created cloud sync task ${created?.description || payload.description} (id ${created?.id ?? '?'}).`,
            data: { task: { id: created?.id, description: created?.description } },
          })
        })
      }

      if (args.action === 'sync') {
        const refusal = requireConfirm(args, 'start a cloud sync run')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findSync(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          return runJob(ctx, client, 'sync', `cloud sync ${found.sync.description}`, 'cloudsync.sync', [found.sync.id], args.wait)
        })
      }

      if (args.action === 'sync_onetime') {
        const refusal = requireConfirm(args, 'start a one-off cloud transfer')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const payload = args.data && typeof args.data === 'object' ? { ...args.data } : null
          if (!payload) return fail('Pass "data" with the cloudsync.sync_onetime payload (path, credentials, direction, …).')
          return runJob(ctx, client, 'sync_onetime', 'one-off cloud transfer', 'cloudsync.sync_onetime', [payload], args.wait)
        })
      }

      if (args.action === 'restore') {
        const refusal = requireConfirm(args, 'restore from a cloud backup')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          if (!args.data || typeof args.data !== 'object') {
            return fail('Pass "data" with the cloud_backup.restore payload (description, path, snapshot, …).')
          }
          return runJob(ctx, client, 'restore', 'cloud backup restore', 'cloud_backup.restore', [{ ...args.data }], args.wait)
        })
      }

      if (args.action === 'abort') {
        const refusal = requireConfirm(args, 'abort a running cloud task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const id = Number(args.id)
          if (!Number.isInteger(id)) return fail('Pass "id" with the job or task id to abort.')
          await client.request('cloud_backup.abort', [id])
          return ok({ action: 'abort', text: `Aborted cloud task ${id}.`, data: { id } })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a cloud sync task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findSync(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          await client.request('cloudsync.delete', [found.sync.id])
          return ok({ action: 'delete', text: `Deleted cloud sync task ${found.sync.description}.`, data: { id: found.sync.id } })
        })
      }

      if (args.action === 'credentials') {
        return withInstance(ctx, args, async (client) => {
          const credentials = await client.request('cloudsync.credentials.query', [[], { order_by: ['name'] }])
          const rows = (Array.isArray(credentials) ? credentials : []).map((credential) => ({
            id: credential.id,
            name: credential.name || '',
            provider: String(credential.provider?.type || ''),
          }))
          return ok({
            action: 'credentials',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'name', header: 'Credential' },
                  { key: 'provider', header: 'Provider' },
                ])
              : 'No cloud credentials configured.',
            data: { credentials: rows },
          })
        })
      }

      if (args.action === 'credential_add') {
        const payload = args.data && typeof args.data === 'object' ? args.data : null
        if (!payload || !payload.provider) return fail('Pass "data" with at least {"name":"…","provider":{"type":"S3",…}} — the provider object is provider-specific.')
        if (args.credentialName) payload.name = String(args.credentialName)
        return withInstance(ctx, args, async (client) => {
          const created = await client.request('cloudsync.credentials.create', [payload])
          return ok({
            action: 'credential_add',
            text: `Created cloud credential ${created?.name || payload.name || created?.id} (${payload.provider?.type || '?'}).`,
            data: { credential: { id: created?.id, name: created?.name } },
          })
        })
      }

      if (args.action === 'credential_update' || args.action === 'credential_remove') {
        const id = Number(args.credential)
        if (!Number.isInteger(id) || id <= 0) return fail('Pass "credential" with the numeric credential id from action "credentials".')
        if (args.action === 'credential_remove') {
          const refusal = requireConfirm(args, 'delete a cloud credential')
          if (refusal) return refusal
          return withInstance(ctx, args, async (client) => {
            await client.request('cloudsync.credentials.delete', [id])
            return ok({ action: 'credential_remove', text: `Deleted cloud credential ${id}.`, data: { credential: id } })
          })
        }
        const patch = args.data && typeof args.data === 'object' ? args.data : null
        if (!patch || !Object.keys(patch).length) return fail('Pass "data" with the fields to change.')
        return withInstance(ctx, args, async (client) => {
          const updated = await client.request('cloudsync.credentials.update', [id, patch])
          return ok({ action: 'credential_update', text: `Updated cloud credential ${updated?.name || id}.`, data: { credential: { id } } })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, backups, get, create, sync, sync_onetime, restore, abort, delete.`)
    },
  )
}
