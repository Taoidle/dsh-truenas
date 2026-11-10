/**
 * Scheduled work: cron jobs and rsync tasks.
 *
 * Cron jobs are a shell command plus a five-field schedule; rsync tasks move a
 * local path to (or from) another host. Both are read with a compact table and
 * created from an explicit field set, because a wrong command or path is hard
 * to notice from the API result alone.
 */

import { truncate, table, keyValues } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const CRON_SELECT = ['id', 'user', 'command', 'description', 'enabled', 'stdout', 'stderr', 'schedule']
const RSYNC_SELECT = ['id', 'path', 'user', 'mode', 'remotehost', 'remotemodule', 'remotepath', 'direction', 'desc', 'enabled', 'job']

function scheduleText(job) {
  const s = job?.schedule || {}
  const parts = [s.minute, s.hour, s.dom, s.month, s.dow]
  if (parts.every((part) => part === undefined || part === null || part === '')) return ''
  return parts.map((part) => (part === undefined || part === null || part === '' ? '*' : part)).join(' ')
}

async function findCron(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "id" (or the job description) with the cron job.' }
  const asId = Number(raw)
  if (Number.isInteger(asId) && String(asId) === raw) {
    const found = await client.request('cronjob.query', [[['id', '=', asId]], { select: CRON_SELECT, get: true }])
    return found ? { ok: true, job: found } : { ok: false, error: `No cron job has id ${asId}.` }
  }
  const found = await client.request('cronjob.query', [[['description', '=', raw]], { select: CRON_SELECT, get: true }])
  if (found) return { ok: true, job: found }
  return { ok: false, error: `No cron job has description "${raw}". Run action "cron_list" to see them.` }
}

async function findRsync(client, spec) {
  const raw = String(spec ?? '').trim()
  const asId = Number(raw)
  if (!Number.isInteger(asId) || String(asId) !== raw) {
    return { ok: false, error: 'Pass "id" with the rsync task (rsynctask has no unique name).' }
  }
  const found = await client.request('rsynctask.query', [[['id', '=', asId]], { select: RSYNC_SELECT, get: true }])
  return found ? { ok: true, task: found } : { ok: false, error: `No rsync task has id ${asId}.` }
}

function cronRow(job) {
  return {
    id: job.id,
    description: job.description || '(no description)',
    schedule: scheduleText(job),
    command: truncate(job.command, 60),
    user: job.user,
    enabled: job.enabled ? 'yes' : 'no',
  }
}

export function createTasksTool(ctx) {
  return define(
    'truenas_tasks',
    [
      'Cron jobs and rsync tasks on a TrueNAS system: list, inspect, create, update, run now and delete.',
      'A cron job is a shell command plus a five-field schedule; an rsync task copies a local path to or from a remote host. Deleting either, and running a task, need the values confirmed first.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: [
            'cron_list',
            'cron_get',
            'cron_add',
            'cron_update',
            'cron_delete',
            'cron_run',
            'rsync_list',
            'rsync_get',
            'rsync_add',
            'rsync_delete',
            'rsync_run',
          ],
          description: 'What to do.',
        },
        id: { type: 'number', description: 'Cron job or rsync task id.' },
        description: { type: 'string', description: 'Cron job description (also accepted to identify a job).' },
        command: { type: 'string', description: 'Shell command the cron job runs.' },
        user: { type: 'string', description: 'System user to run as (default root).' },
        schedule: {
          type: 'object',
          additionalProperties: true,
          description: 'Cron schedule: {minute, hour, dom, month, dow} as strings, e.g. {"minute":"30","hour":"3"}.',
        },
        enabled: { type: 'boolean', description: 'Enable the new or updated job.' },
        path: { type: 'string', description: 'Rsync: local filesystem path.' },
        remoteHost: { type: 'string', description: 'Rsync: remote host, optionally "user@host".' },
        remoteModule: { type: 'string', description: 'Rsync: module name in MODULE mode.' },
        remotePath: { type: 'string', description: 'Rsync: path on the remote system.' },
        mode: { type: 'string', enum: ['MODULE', 'SSH'], description: 'Rsync: transport mode (default MODULE).' },
        direction: { type: 'string', enum: ['PUSH', 'PULL'], description: 'Rsync: direction (default PUSH).' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "cron_run", "cron_delete" and "rsync_delete".' },
        wait: { type: 'boolean', description: 'Wait for the job to finish ("cron_run", default true).' },
      },
    },
    async (args) => {
      if (args.action === 'cron_list') {
        return withInstance(ctx, args, async (client) => {
          const jobs = await client.request('cronjob.query', [[], { select: CRON_SELECT, order_by: ['id'] }])
          const rows = (Array.isArray(jobs) ? jobs : []).map(cronRow)
          if (!rows.length) return ok({ action: 'cron_list', text: 'No cron jobs configured.', data: { jobs: [] } })
          return ok({
            action: 'cron_list',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'description', header: 'Description' },
              { key: 'schedule', header: 'Schedule' },
              { key: 'command', header: 'Command' },
              { key: 'user', header: 'User' },
              { key: 'enabled', header: 'Enabled' },
            ]),
            data: { jobs: rows },
          })
        })
      }

      if (args.action === 'cron_get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findCron(client, args.id ?? args.description)
          if (!found.ok) return fail(found.error)
          const job = found.job
          return ok({
            action: 'cron_get',
            text: keyValues([
              ['ID', job.id],
              ['Description', job.description || '(none)'],
              ['Schedule', scheduleText(job)],
              ['Command', job.command],
              ['User', job.user],
              ['Enabled', job.enabled ? 'yes' : 'no'],
              ['Email stdout', job.stdout ? 'yes' : 'no'],
              ['Email stderr', job.stderr ? 'yes' : 'no'],
            ]),
            data: { job },
          })
        })
      }

      if (args.action === 'cron_add' || args.action === 'cron_update') {
        return withInstance(ctx, args, async (client) => {
          const payload = {}
          if (typeof args.command === 'string') payload.command = args.command
          if (typeof args.user === 'string') payload.user = args.user
          if (typeof args.description === 'string') payload.description = args.description
          if (typeof args.enabled === 'boolean') payload.enabled = args.enabled
          if (args.schedule && typeof args.schedule === 'object') {
            const allowed = ['minute', 'hour', 'dom', 'month', 'dow']
            payload.schedule = {}
            for (const key of allowed) {
              if (args.schedule[key] !== undefined) payload.schedule[key] = String(args.schedule[key])
            }
            if (!Object.keys(payload.schedule).length) delete payload.schedule
          }
          if (args.action === 'cron_add') {
            if (!payload.command) return fail('Pass "command" with the shell command to run.')
            if (!payload.schedule) {
              return fail('Pass "schedule" with at least one of minute/hour/dom/month/dow, for example {"minute":"30","hour":"3"}.')
            }
            const created = await client.request('cronjob.create', [payload])
            return ok({
              action: 'cron_add',
              text: `Created cron job ${created.id}${created.description ? ` (${created.description})` : ''}.\nSchedule: ${scheduleText(created)}\nCommand: ${created.command}`,
              data: { job: created },
            })
          }
          if (!Object.keys(payload).length) return fail('Pass at least one field to change (command, user, description, schedule, enabled).')
          const found = await findCron(client, args.id ?? args.description)
          if (!found.ok) return fail(found.error)
          const updated = await client.request('cronjob.update', [found.job.id, payload])
          return ok({
            action: 'cron_update',
            text: `Updated cron job ${found.job.id}.\nSchedule: ${scheduleText(updated)}\nCommand: ${updated.command}`,
            data: { job: updated },
          })
        })
      }

      if (args.action === 'cron_delete') {
        const refusal = requireConfirm(args, 'delete a cron job')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findCron(client, args.id ?? args.description)
          if (!found.ok) return fail(found.error)
          await client.request('cronjob.delete', [found.job.id])
          return ok({ action: 'cron_delete', text: `Deleted cron job ${found.job.id}.`, data: { id: found.job.id } })
        })
      }

      if (args.action === 'cron_run') {
        const refusal = requireConfirm(args, 'run a cron job now')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findCron(client, args.id ?? args.description)
          if (!found.ok) return fail(found.error)
          const jobId = await client.request('cronjob.run', [found.job.id])
          if (args.wait === false) {
            return ok({ action: 'cron_run', text: `Started cron job ${found.job.id} as job ${jobId}.`, data: { id: jobId } })
          }
          const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({ action: 'cron_run', text: `Cron job ${found.job.id} finished (job ${jobId}, ${job.state}).`, data: { job } })
        })
      }

      if (args.action === 'rsync_list') {
        return withInstance(ctx, args, async (client) => {
          const tasks = await client.request('rsynctask.query', [[], { select: RSYNC_SELECT, order_by: ['id'] }])
          const rows = (Array.isArray(tasks) ? tasks : []).map((task) => ({
            id: task.id,
            description: task.desc || '(no description)',
            direction: task.direction,
            path: truncate(task.path, 40),
            remote: task.remotehost ? `${task.remotehost}${task.remotepath ? `:${task.remotepath}` : ''}` : task.remotemodule || '',
            mode: task.mode,
            enabled: task.enabled ? 'yes' : 'no',
          }))
          if (!rows.length) return ok({ action: 'rsync_list', text: 'No rsync tasks configured.', data: { tasks: [] } })
          return ok({
            action: 'rsync_list',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'description', header: 'Description' },
              { key: 'direction', header: 'Direction' },
              { key: 'path', header: 'Local path' },
              { key: 'remote', header: 'Remote' },
              { key: 'mode', header: 'Mode' },
              { key: 'enabled', header: 'Enabled' },
            ]),
            data: { tasks: rows },
          })
        })
      }

      if (args.action === 'rsync_get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findRsync(client, args.id)
          if (!found.ok) return fail(found.error)
          const task = found.task
          return ok({
            action: 'rsync_get',
            text: keyValues([
              ['ID', task.id],
              ['Description', task.desc || '(none)'],
              ['Local path', task.path],
              ['User', task.user],
              ['Mode', task.mode],
              ['Direction', task.direction],
              ['Remote host', task.remotehost || ''],
              ['Remote module', task.remotemodule || ''],
              ['Remote path', task.remotepath || ''],
              ['Enabled', task.enabled ? 'yes' : 'no'],
            ]),
            data: { task },
          })
        })
      }

      if (args.action === 'rsync_add') {
        return withInstance(ctx, args, async (client) => {
          if (!args.path) return fail('Pass "path" with the local filesystem path.')
          const payload = {
            path: args.path,
            user: args.user || 'root',
            direction: args.direction || 'PUSH',
            mode: args.mode || 'MODULE',
          }
          if (args.remoteHost) payload.remotehost = args.remoteHost
          if (args.remoteModule) payload.remotemodule = args.remoteModule
          if (args.remotePath) payload.remotepath = args.remotePath
          if (typeof args.description === 'string') payload.desc = args.description
          if (typeof args.enabled === 'boolean') payload.enabled = args.enabled
          if (payload.mode === 'SSH' && !payload.remotehost) return fail('SSH mode needs "remoteHost".')
          if (payload.mode === 'MODULE' && !payload.remotemodule) return fail('MODULE mode needs "remoteModule".')
          const created = await client.request('rsynctask.create', [payload])
          return ok({
            action: 'rsync_add',
            text: `Created rsync task ${created.id} (${created.direction} ${created.path} → ${created.remotehost || created.remotemodule || ''}).`,
            data: { task: created },
          })
        })
      }

      if (args.action === 'rsync_delete') {
        const refusal = requireConfirm(args, 'delete an rsync task')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findRsync(client, args.id)
          if (!found.ok) return fail(found.error)
          await client.request('rsynctask.delete', [found.task.id])
          return ok({ action: 'rsync_delete', text: `Deleted rsync task ${found.task.id}.`, data: { id: found.task.id } })
        })
      }

      if (args.action === 'rsync_run') {
        const refusal = requireConfirm(args, 'run an rsync task now')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findRsync(client, args.id)
          if (!found.ok) return fail(found.error)
          const jobId = await client.request('rsynctask.run', [found.task.id])
          if (args.wait === false) {
            return ok({ action: 'rsync_run', text: `Started rsync task ${found.task.id} as job ${jobId}.`, data: { id: jobId } })
          }
          const job = await client.waitJob(jobId, { timeoutMs: ctx.config.jobTimeoutMs })
          return ok({ action: 'rsync_run', text: `Rsync task ${found.task.id} finished (job ${jobId}, ${job.state}).`, data: { job } })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )
}
