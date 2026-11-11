/**
 * Alert channels: read and dismiss current alerts, manage alert services
 * (email, Slack, PagerDuty, SNMP traps, webhooks), and configure outgoing mail.
 *
 * Alert service attributes are per-type objects (`{type:'Mail', email:'…'}`),
 * so this tool passes a raw `attributes` object instead of naming every
 * provider's fields.
 */

import { formatDate, keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const ALERT_LIMIT = 25

/** TrueNAS serialises datetimes as {$date: epochMs} over the API. */
function alertTime(alert) {
  const value = alert?.datetime ?? alert?.last_occurrence
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return value.$date ?? ''
  return value
}

/** `text` is the unformatted template; `formatted` is what the UI shows. */
function alertText(alert) {
  const raw = alert?.formatted || alert?.text || alert?.klass || ''
  return String(raw).split('\n')[0]
}

async function findService(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "name" (or "id") with the alert service.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['name', '=', raw]]
  const found = await client.request('alertservice.query', [filters, { get: true }])
  if (!found) return { ok: false, error: `No alert service matches "${raw}". Run action "services" to see them.` }
  return { ok: true, service: found }
}

export function createAlertsTool(ctx) {
  return define(
    'truenas_alerts',
    [
      'Work with TrueNAS alerting: list the current alerts and dismiss or restore them, manage alert services by name (email, Slack, PagerDuty, SNMP trap, webhook, …) and send test notifications, and read or change the outgoing mail settings.',
      'Alert service attributes are provider-specific, so pass them as a raw "attributes" object such as {"type":"Mail","email":"ops@example.com"}.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: [
            'list',
            'dismiss',
            'restore',
            'services',
            'service_add',
            'service_update',
            'service_remove',
            'service_test',
            'mail',
            'mail_update',
            'classes',
            'classes_update',
          ],
          description: 'What to do.',
        },
        id: { type: 'string', description: 'Alert uuid ("dismiss", "restore") or service id ("service_update", "service_remove", "service_test").' },
        name: { type: 'string', description: 'Alert service name ("service_add", "service_update", "service_remove", "service_test").' },
        level: { type: 'string', description: 'Minimum level for the service: INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT, EMERGENCY.' },
        enabled: { type: 'boolean', description: 'Enable or disable the alert service.' },
        attributes: {
          type: 'object',
          additionalProperties: true,
          description: 'Provider-specific attributes; "type" is required, for example {"type":"Slack","url":"https://hooks.slack.com/…"}.',
        },
        dismissAll: { type: 'boolean', description: 'Dismiss every current alert instead of one ("dismiss").' },
        fromEmail: { type: 'string', description: 'From address for "mail_update".' },
        fromName: { type: 'string', description: 'From name for "mail_update".' },
        smtpServer: { type: 'string', description: 'Outgoing SMTP server host for "mail_update".' },
        smtpPort: { type: 'number', description: 'Outgoing SMTP port for "mail_update".' },
        smtpSecurity: { type: 'string', description: 'SMTP security: PLAIN, SSL or TLS ("mail_update").' },
        smtpUser: { type: 'string', description: 'SMTP username ("mail_update").' },
        smtpPassword: {
          type: 'string',
          description: 'SMTP password ("mail_update"). It is sent to the NAS and never echoed back; ask the user for it if needed.',
        },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "service_remove" and "service_add" is not destructive but removal is.' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const alerts = await client.request('alert.list', [])
          const open = (Array.isArray(alerts) ? alerts : []).filter((alert) => !alert.dismissed)
          if (!open.length) return ok({ action: 'list', text: 'No open alerts.', data: { alerts: [] } })
          const rows = open.slice(0, ALERT_LIMIT).map((alert) => ({
            level: alert.level,
            source: alert.source,
            text: alertText(alert).slice(0, 90),
            when: alertTime(alert) ? formatDate(alertTime(alert)) : '',
            uuid: alert.uuid,
          }))
          return ok({
            action: 'list',
            text: table(rows, [
              { key: 'level', header: 'Level' },
              { key: 'source', header: 'Source' },
              { key: 'text', header: 'Alert' },
              { key: 'when', header: 'Since' },
              { key: 'uuid', header: 'UUID' },
            ]),
            data: { alerts: rows, total: open.length },
          })
        })
      }

      if (args.action === 'dismiss') {
        return withInstance(ctx, args, async (client) => {
          if (args.dismissAll === true) {
            await client.request('alert.dismiss', [])
            return ok({ action: 'dismiss', text: 'Dismissed every open alert.', data: { all: true } })
          }
          const uuid = String(args.id || '').trim()
          if (!uuid) return fail('Pass "id" with the alert uuid, or dismissAll: true.')
          await client.request('alert.dismiss', [uuid])
          return ok({ action: 'dismiss', text: `Dismissed alert ${uuid}.`, data: { uuid } })
        })
      }

      if (args.action === 'restore') {
        return withInstance(ctx, args, async (client) => {
          const uuid = String(args.id || '').trim()
          if (!uuid) return fail('Pass "id" with the dismissed alert uuid.')
          await client.request('alert.restore', [uuid])
          return ok({ action: 'restore', text: `Restored alert ${uuid}.`, data: { uuid } })
        })
      }

      if (args.action === 'services') {
        return withInstance(ctx, args, async (client) => {
          const services = await client.request('alertservice.query', [[], { order_by: ['name'] }])
          const rows = (Array.isArray(services) ? services : []).map((service) => ({
            id: service.id,
            name: service.name,
            type: service.attributes?.type || service.type__title || '',
            level: service.level,
            enabled: service.enabled ? 'yes' : 'no',
          }))
          if (!rows.length) return ok({ action: 'services', text: 'No alert services configured.', data: { services: [] } })
          return ok({
            action: 'services',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'type', header: 'Type' },
              { key: 'level', header: 'Level' },
              { key: 'enabled', header: 'Enabled' },
            ]),
            data: { services: rows },
          })
        })
      }

      if (args.action === 'service_add') {
        return withInstance(ctx, args, async (client) => {
          const name = String(args.name || '').trim()
          if (!name) return fail('Pass "name" for the new alert service.')
          const attributes = args.attributes && typeof args.attributes === 'object' ? { ...args.attributes } : null
          if (!attributes?.type) return fail('Pass "attributes" with a "type", for example {"type":"Mail","email":"ops@example.com"}.')
          const payload = { name, attributes }
          if (args.level !== undefined) payload.level = String(args.level)
          if (args.enabled !== undefined) payload.enabled = Boolean(args.enabled)
          const created = await client.request('alertservice.create', [payload])
          return ok({
            action: 'service_add',
            text: `Created alert service ${created?.name || name} (id ${created?.id ?? '?'}).`,
            data: { service: { id: created?.id, name: created?.name } },
          })
        })
      }

      if (args.action === 'service_update') {
        return withInstance(ctx, args, async (client) => {
          const found = await findService(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          const payload = {}
          if (args.name !== undefined) payload.name = String(args.name)
          if (args.level !== undefined) payload.level = String(args.level)
          if (args.enabled !== undefined) payload.enabled = Boolean(args.enabled)
          if (args.attributes !== undefined) {
            if (!args.attributes || typeof args.attributes !== 'object') return fail('"attributes" must be an object.')
            payload.attributes = { ...args.attributes }
          }
          if (!Object.keys(payload).length) return fail('Pass at least one field to change: name, level, enabled or attributes.')
          const updated = await client.request('alertservice.update', [found.service.id, payload])
          return ok({ action: 'service_update', text: `Updated alert service ${updated?.name || found.service.name}.`, data: { service: updated } })
        })
      }

      if (args.action === 'service_remove') {
        const refusal = requireConfirm(args, 'delete an alert service')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findService(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          await client.request('alertservice.delete', [found.service.id])
          return ok({ action: 'service_remove', text: `Deleted alert service ${found.service.name}.`, data: { id: found.service.id } })
        })
      }

      if (args.action === 'service_test') {
        return withInstance(ctx, args, async (client) => {
          const found = await findService(client, args.id ?? args.name)
          if (!found.ok) return fail(found.error)
          await client.request('alertservice.test', [found.service.id])
          return ok({ action: 'service_test', text: `Asked ${found.service.name} to send a test notification.`, data: { id: found.service.id } })
        })
      }

      if (args.action === 'mail') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('mail.config', [])
          return ok({
            action: 'mail',
            text: keyValues([
              ['From address', config?.fromemail || '(unset)'],
              ['From name', config?.fromname || '(unset)'],
              ['SMTP server', config?.outgoingserver || '(unset)'],
              ['Port', config?.port],
              ['Security', config?.security],
              ['Username', config?.user || '(unset)'],
              ['Password set', config?.pass ? 'yes' : 'no'],
            ]),
            data: {
              fromemail: config?.fromemail,
              fromname: config?.fromname,
              outgoingserver: config?.outgoingserver,
              port: config?.port,
              security: config?.security,
              user: config?.user,
            },
          })
        })
      }

      if (args.action === 'mail_update') {
        return withInstance(ctx, args, async (client) => {
          const payload = {}
          if (args.fromEmail !== undefined) payload.fromemail = String(args.fromEmail).trim()
          if (args.fromName !== undefined) payload.fromname = String(args.fromName).trim()
          if (args.smtpServer !== undefined) payload.outgoingserver = String(args.smtpServer).trim()
          if (args.smtpPort !== undefined) payload.port = Number(args.smtpPort)
          if (args.smtpSecurity !== undefined) payload.security = String(args.smtpSecurity).toUpperCase()
          if (args.smtpUser !== undefined) payload.user = String(args.smtpUser).trim()
          if (args.smtpPassword !== undefined) {
            const password = String(args.smtpPassword)
            if (!password) return fail('The SMTP password is empty; omit the parameter to leave it unchanged.')
            payload.pass = password
          }
          if (!Object.keys(payload).length) {
            return fail('Pass at least one field to change: fromEmail, fromName, smtpServer, smtpPort, smtpSecurity, smtpUser or smtpPassword.')
          }
          const config = await client.request('mail.update', [payload])
          return ok({
            action: 'mail_update',
            text: `Updated mail settings. From ${config?.fromemail || '(unset)'} via ${config?.outgoingserver || '(unset)'}:${config?.port ?? ''}. The password is not echoed back.`,
            data: { sent: Object.keys(payload) },
          })
        })
      }

      if (args.action === 'classes') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('alertclasses.config', [])
          const classes = config && typeof config === 'object' ? config.classes || config : {}
          const rows = Object.entries(classes).map(([name, value]) => ({
            name,
            level: typeof value === 'string' ? value : value?.level || '',
            policy: typeof value === 'object' ? String(value?.policy || '') : '',
          }))
          return ok({
            action: 'classes',
            text: rows.length
              ? table(rows.sort((a, b) => a.name.localeCompare(b.name)), [
                  { key: 'name', header: 'Class' },
                  { key: 'level', header: 'Level' },
                  { key: 'policy', header: 'Policy' },
                ])
              : 'No per-class overrides: every alert class uses the default level and policy.',
            data: { classes },
          })
        })
      }

      if (args.action === 'classes_update') {
        const classes = args.classes && typeof args.classes === 'object' ? args.classes : null
        if (!classes || !Object.keys(classes).length) return fail('Pass "classes" with the mapping to change, for example {"ZFS":"WARNING"}.')
        return withInstance(ctx, args, async (client) => {
          await client.request('alertclasses.update', [{ classes }])
          return ok({ action: 'classes_update', text: `Updated alert classes: ${Object.keys(classes).join(', ')}.`, data: { classes } })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, dismiss, restore, services, service_add, service_update, service_remove, service_test, mail, mail_update.`)
    },
  )
}

