/**
 * Snapshot replication tasks.
 *
 * The API models a replication task as a large object (source dataset list,
 * transport, SSH credentials, retention policy); this tool exposes the common
 * read and run paths and accepts a raw `data` object for creation instead of
 * duplicating every field with its own parameter.
 */

import { formatDate, formatDuration, keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const REPLICATION_SELECT = [
  'id',
  'name',
  'direction',
  'transport',
  'source_datasets',
  'target_dataset',
  'enabled',
  'state',
  'job',
  'last_run',
  'recursive',
]

function replicationState(entry) {
  const state = entry?.state
  if (!state) return entry?.enabled ? 'enabled' : 'disabled'
  if (typeof state === 'string') return state
  return state.state || (entry?.enabled ? 'enabled' : 'disabled')
}

function lastRun(entry) {
  const run = entry?.last_run
  if (!run) return 'never'
  const time = run.end_time || run.start_time
  const when = time ? formatDate(time) : 'unknown time'
  const seconds = run.duration ? formatDuration(run.duration) : ''
  return seconds ? `${when} (${seconds})` : when
}

async function findReplication(client, spec) {
  const raw = String(spec || '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" (or "id") with the replication task.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['name', '=', raw]]
  const found = await client.request('replication.query', [filters, { select: REPLICATION_SELECT, get: true }])
  if (!found) return { ok: false, error: `No replication task matches "${raw}". Run action "list" to see them.` }
  return { ok: true, task: found }
}

export function createReplicationTool(ctx) {
  return define(
    'truenas_replication',
    [
      'Inspect and run TrueNAS replication tasks (ZFS send/recv between systems or local datasets) and list their last result.',
      'Creating a task accepts a raw "data" object in TrueNAS replication.create form; run, create and delete need the values confirmed because a wrong target can overwrite data.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'run', 'delete'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Replication task name, or its integer id as a string.' },
        id: { type: 'number', description: 'Replication task id (alternative to "name").' },
        data: {
          type: 'object',
          additionalProperties: true,
          description:
            'Raw payload for replication.create: name, direction (PUSH|PULL), transport (SSH|SSH+NETCAT|LOCAL), source_datasets, target_dataset, ssh_credentials, recursive, retention_policy, …',
        },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "run", "create" and "delete".' },
        wait: { type: 'boolean', description: 'Wait for the job to finish ("run", default true).' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const tasks = await client.request('replication.query', [[], { select: REPLICATION_SELECT, order_by: ['name'] }])
          const rows = (Array.isArray(tasks) ? tasks : []).map((task) => ({
            id: task.id,
            name: task.name,
            direction: task.direction,
            source: Array.isArray(task.source_datasets) ? task.source_datasets.join(', ') : task.source_datasets,
            target: task.target_dataset,
            state: replicationState(task),
            lastRun: lastRun(task),
          }))
          if (!rows.length) return ok({ action: 'list', text: 'No replication tasks configured.', data: { tasks: [] } })
          return ok({
            action: 'list',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Task' },
              { key: 'direction', header: 'Direction' },
              { key: 'source', header: 'Source' },
              { key: 'target', header: 'Target' },
              { key: 'state', header: 'State' },
              { key: 'lastRun', header: 'Last run' },
            ]),
            data: { tasks: rows },
          })
        })
      }

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findReplication(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          const task = found.task
          return ok({
            action: 'get',
            text: keyValues([
              ['Task', task.name],
              ['ID', task.id],
              ['Direction', task.direction],
              ['Transport', task.transport],
              ['Source', Array.isArray(task.source_datasets) ? task.source_datasets.join(', ') : task.source_datasets],
              ['Target', task.target_dataset],
              ['Recursive', task.recursive ? 'yes' : 'no'],
              ['Enabled', task.enabled ? 'yes' : 'no'],
              ['State', replicationState(task)],
              ['Last run', lastRun(task)],
            ]),
            data: { task },
          })
        })
      }

      if (args.action === 'create') {
        const refusal = requireConfirm(args, 'create a replication task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const payload = args.data && typeof args.data === 'object' ? { ...args.data } : null
          if (!payload) return fail('Pass "data" with the replication.create payload (name, direction, transport, source_datasets, target_dataset, …).')
          if (!payload.name) return fail('The "data" payload needs a name for the task.')
          const created = await client.request('replication.create', [payload])
          return ok({
            action: 'create',
            text: `Created replication task ${created?.name || payload.name} (id ${created?.id ?? '?'}).`,
            data: { task: { id: created?.id, name: created?.name } },
          })
        })
      }

      if (args.action === 'run') {
        const refusal = requireConfirm(args, 'start a replication run')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findReplication(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          const jobId = await client.request('replication.run', [found.task.id])
          if (typeof jobId !== 'number') {
            return ok({ action: 'run', text: `Started replication ${found.task.name}.`, data: { job: jobId } })
          }
          if (args.wait === false) {
            return ok({ action: 'run', text: `Started replication ${found.task.name} as job ${jobId}.`, data: { job: jobId } })
          }
          const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({
            action: 'run',
            text: `Replication ${found.task.name} finished with state ${job.state}.`,
            data: { job: { id: job.id, state: job.state, result: job.result } },
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a replication task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findReplication(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          await client.request('replication.delete', [found.task.id])
          return ok({ action: 'delete', text: `Deleted replication task ${found.task.name}.`, data: { id: found.task.id } })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, get, create, run, delete.`)
    },
  )
}

