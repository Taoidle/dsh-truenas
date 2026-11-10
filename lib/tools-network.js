/**
 * Network: interfaces, static routes, and the global network configuration
 * (hostname, domain, gateway, DNS servers, proxy).
 *
 * Writes go through interface.update / network.configuration.update rather than
 * interface.commit: TrueNAS applies and checks in the change itself when the
 * call comes over the API, and an explicit commit after a failed update would
 * only roll back a half-applied state.
 */

import { keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const INTERFACE_SELECT = ['id', 'name', 'type', 'state', 'aliases', 'ipv4_dhcp', 'ipv6_auto', 'mtu', 'description']

/** "192.168.66.60/20" or "fe80::1/64" → TrueNAS alias object. */
function parseAddresses(values) {
  if (!Array.isArray(values)) return { ok: false, error: '"addresses" must be an array of CIDR strings, for example ["192.168.66.60/20"].' }
  const aliases = []
  for (const raw of values) {
    const text = String(raw || '').trim()
    const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(text)
    if (!match) return { ok: false, error: `"${text}" is not a CIDR address; use address/prefix, for example 192.168.66.60/20.` }
    aliases.push({
      type: match[1].includes(':') ? 'INET6' : 'INET',
      address: match[1],
      netmask: Number(match[2]),
    })
  }
  return { ok: true, aliases }
}

function interfaceState(entry) {
  const state = entry?.state || {}
  const up = state.link_state === 'LINK_STATE_UP' || (Array.isArray(state.flags) && state.flags.includes('UP'))
  return up ? 'up' : 'down'
}

function interfaceAddresses(entry) {
  const aliases = Array.isArray(entry?.aliases) ? entry.aliases : []
  if (!aliases.length) return entry?.ipv4_dhcp ? 'DHCP' : '—'
  return aliases.map((alias) => `${alias.address}/${alias.netmask}`).join(', ')
}

export function createNetworkTool(ctx) {
  return define(
    'truenas_network',
    [
      'Inspect and change TrueNAS networking: interfaces with their addresses and link state, static routes, and the global network configuration (hostname, domain, default gateways, DNS servers, HTTP proxy).',
      'Address changes go through interface.update and apply immediately; a wrong address can cut the connection to the box, so confirm the values with the user first.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['interfaces', 'interface', 'interface_update', 'routes', 'route_add', 'route_remove', 'dns', 'dns_update'],
          description: 'What to do.',
        },
        interface: { type: 'string', description: 'Interface name for "interface" and "interface_update", for example "enp6s18" or "br0".' },
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement static addresses as CIDR strings, for example ["192.168.66.60/20"] ("interface_update"). Replaces the whole list.',
        },
        dhcp: { type: 'boolean', description: 'Enable IPv4 DHCP on the interface ("interface_update").' },
        mtu: { type: 'number', description: 'MTU for the interface ("interface_update").' },
        description: { type: 'string', description: 'Interface or route description.' },
        data: {
          type: 'object',
          additionalProperties: true,
          description: 'Raw object merged over the computed payload, for fields this tool does not name.',
        },
        route: { type: 'number', description: 'Static route id ("route_remove").' },
        destination: { type: 'string', description: 'Route destination in CIDR form, for example "10.0.0.0/8" ("route_add").' },
        gateway: { type: 'string', description: 'Route gateway address, for example "192.168.66.1" ("route_add" and "dns_update").' },
        hostname: { type: 'string', description: 'System hostname ("dns_update").' },
        domain: { type: 'string', description: 'DNS domain ("dns_update").' },
        nameservers: {
          type: 'array',
          items: { type: 'string' },
          description: 'DNS servers, at most three, for example ["1.1.1.1", "8.8.8.8"] ("dns_update"). Replaces nameserver1..3.',
        },
        httpproxy: { type: 'string', description: 'HTTP proxy URL; pass an empty string to clear it ("dns_update").' },
        confirm: CONFIRM_PARAM,
      },
    },
    async (args) => {
      if (args.action === 'interfaces') {
        return withInstance(ctx, args, async (client) => {
          const interfaces = await client.request('interface.query', [[], { select: INTERFACE_SELECT, order_by: ['name'] }])
          const rows = (Array.isArray(interfaces) ? interfaces : []).map((entry) => ({
            name: entry.name,
            type: entry.type,
            state: interfaceState(entry),
            addresses: interfaceAddresses(entry),
            mtu: entry.mtu,
          }))
          if (!rows.length) return ok({ action: 'interfaces', text: 'No network interfaces reported.', data: { interfaces: [] } })
          return ok({
            action: 'interfaces',
            text: table(rows, [
              { key: 'name', header: 'Interface' },
              { key: 'type', header: 'Type' },
              { key: 'state', header: 'Link' },
              { key: 'addresses', header: 'Addresses' },
              { key: 'mtu', header: 'MTU' },
            ]),
            data: { interfaces: rows },
          })
        })
      }

      if (args.action === 'interface') {
        return withInstance(ctx, args, async (client) => {
          const name = String(args.interface || '').trim()
          if (!name) return fail('Pass "interface" with the interface name.')
          const entry = await client.request('interface.get_instance', [name])
          return ok({
            action: 'interface',
            text: keyValues([
              ['Interface', entry?.name],
              ['Type', entry?.type],
              ['Link', interfaceState(entry)],
              ['Addresses', interfaceAddresses(entry)],
              ['DHCP', entry?.ipv4_dhcp ? 'yes' : 'no'],
              ['IPv6 auto', entry?.ipv6_auto ? 'yes' : 'no'],
              ['MTU', entry?.mtu],
              ['Description', entry?.description],
            ]),
            data: { interface: entry },
          })
        })
      }

      if (args.action === 'interface_update') {
        return withInstance(ctx, args, async (client) => {
          const name = String(args.interface || '').trim()
          if (!name) return fail('Pass "interface" with the interface name.')
          const payload = {}
          if (args.addresses !== undefined) {
            const parsed = parseAddresses(args.addresses)
            if (!parsed.ok) return fail(parsed.error)
            payload.aliases = parsed.aliases
          }
          if (args.dhcp !== undefined) payload.ipv4_dhcp = Boolean(args.dhcp)
          if (args.mtu !== undefined) payload.mtu = Number(args.mtu)
          if (args.description !== undefined) payload.description = String(args.description)
          if (args.data && typeof args.data === 'object') Object.assign(payload, args.data)
          if (!Object.keys(payload).length) {
            return fail('Pass at least one field to change: addresses, dhcp, mtu, description or data.')
          }
          const updated = await client.request('interface.update', [name, payload])
          return ok({
            action: 'interface_update',
            text: [
              `Updated interface ${name}.`,
              keyValues([
                ['Addresses', interfaceAddresses(updated)],
                ['DHCP', updated?.ipv4_dhcp ? 'yes' : 'no'],
                ['MTU', updated?.mtu],
              ]),
            ].join('\n'),
            data: { interface: updated, sent: payload },
          })
        })
      }

      if (args.action === 'routes') {
        return withInstance(ctx, args, async (client) => {
          const routes = await client.request('staticroute.query', [[], { order_by: ['destination'] }])
          const rows = (Array.isArray(routes) ? routes : []).map((route) => ({
            id: route.id,
            destination: route.destination,
            gateway: route.gateway,
            description: route.description || '',
          }))
          if (!rows.length) return ok({ action: 'routes', text: 'No static routes configured.', data: { routes: [] } })
          return ok({
            action: 'routes',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'destination', header: 'Destination' },
              { key: 'gateway', header: 'Gateway' },
              { key: 'description', header: 'Description' },
            ]),
            data: { routes: rows },
          })
        })
      }

      if (args.action === 'route_add') {
        return withInstance(ctx, args, async (client) => {
          const destination = String(args.destination || '').trim()
          const gateway = String(args.gateway || '').trim()
          if (!destination) return fail('Pass "destination" in CIDR form, for example 10.0.0.0/8.')
          if (!gateway) return fail('Pass "gateway", for example 192.168.66.1.')
          const payload = { destination, gateway }
          if (args.description !== undefined) payload.description = String(args.description)
          if (args.data && typeof args.data === 'object') Object.assign(payload, args.data)
          const created = await client.request('staticroute.create', [payload])
          return ok({
            action: 'route_add',
            text: `Added route ${created?.destination || destination} → ${created?.gateway || gateway}${created?.id ? ` (id ${created.id})` : ''}.`,
            data: { route: created },
          })
        })
      }

      if (args.action === 'route_remove') {
        const refusal = requireConfirm(args, 'remove a static route')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const id = Number(args.route)
          if (!Number.isInteger(id)) return fail('Pass "route" with the route id from action "routes".')
          await client.request('staticroute.delete', [id])
          return ok({ action: 'route_remove', text: `Removed static route ${id}.`, data: { id } })
        })
      }

      if (args.action === 'dns' || args.action === 'dns_update') {
        return withInstance(ctx, args, async (client) => {
          if (args.action === 'dns') {
            const config = await client.request('network.configuration.config', [])
            return ok({
              action: 'dns',
              text: keyValues([
                ['Hostname', config?.hostname],
                ['Domain', config?.domain || '(none)'],
                ['IPv4 gateway', config?.ipv4gateway || '(none)'],
                ['IPv6 gateway', config?.ipv6gateway || '(none)'],
                ['DNS 1', config?.nameserver1 || '(none)'],
                ['DNS 2', config?.nameserver2 || '(none)'],
                ['DNS 3', config?.nameserver3 || '(none)'],
                ['HTTP proxy', config?.httpproxy || '(none)'],
              ]),
              data: {
                hostname: config?.hostname,
                domain: config?.domain,
                ipv4gateway: config?.ipv4gateway,
                nameservers: [config?.nameserver1, config?.nameserver2, config?.nameserver3].filter(Boolean),
                httpproxy: config?.httpproxy,
              },
            })
          }

          const payload = {}
          if (args.hostname !== undefined) payload.hostname = String(args.hostname).trim()
          if (args.domain !== undefined) payload.domain = String(args.domain).trim()
          if (args.gateway !== undefined) payload.ipv4gateway = String(args.gateway).trim()
          if (args.httpproxy !== undefined) payload.httpproxy = String(args.httpproxy).trim()
          if (args.nameservers !== undefined) {
            if (!Array.isArray(args.nameservers)) return fail('"nameservers" must be an array of addresses.')
            if (args.nameservers.length > 3) return fail('TrueNAS accepts at most three DNS servers.')
            const servers = args.nameservers.map((value) => String(value || '').trim())
            payload.nameserver1 = servers[0] || ''
            payload.nameserver2 = servers[1] || ''
            payload.nameserver3 = servers[2] || ''
          }
          if (args.data && typeof args.data === 'object') Object.assign(payload, args.data)
          if (!Object.keys(payload).length) {
            return fail('Pass at least one field to change: hostname, domain, gateway, nameservers, httpproxy or data.')
          }
          const config = await client.request('network.configuration.update', [payload])
          return ok({
            action: 'dns_update',
            text: [
              'Updated the global network configuration.',
              keyValues([
                ['Hostname', config?.hostname],
                ['Domain', config?.domain || '(none)'],
                ['IPv4 gateway', config?.ipv4gateway || '(none)'],
                ['DNS servers', [config?.nameserver1, config?.nameserver2, config?.nameserver3].filter(Boolean).join(', ') || '(none)'],
              ]),
            ].join('\n'),
            data: { sent: payload, config },
          })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: interfaces, interface, interface_update, routes, route_add, route_remove, dns, dns_update.`)
    },
  )
}
