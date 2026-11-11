/**
 * NVMe-oF: subsystems, hosts, namespaces, ports and sessions.
 *
 * Same reasoning as iSCSI — this is the read side plus a guarded delete. A
 * fabric that loses its namespace takes the client's filesystem with it.
 */

import { table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

async function state(client) {
  const [subsystems, hosts, namespaces, ports, sessions] = await Promise.all([
    client.request('nvmet.subsys.query', [[], { select: ['id', 'name', 'subnqn', 'allow_any_host'], order_by: ['name'] }]).catch(() => []),
    client.request('nvmet.host.query', [[], { select: ['id', 'hostnqn', 'dhchap_key'], order_by: ['id'] }]).catch(() => []),
    client.request('nvmet.namespace.query', [[], { select: ['id', 'subsys', 'device_path', 'enabled', 'nsid'], order_by: ['id'] }]).catch(() => []),
    client.request('nvmet.port.query', [[], { select: ['id', 'addr_trtype', 'addr_traddr', 'addr_trsvcid', 'addr_adrfam'], order_by: ['id'] }]).catch(() => []),
    client.request('nvmet.global.sessions', []).catch(() => []),
  ])
  const array = (value) => (Array.isArray(value) ? value : [])
  return {
    subsystems: array(subsystems),
    hosts: array(hosts),
    namespaces: array(namespaces),
    ports: array(ports),
    sessions: array(sessions),
  }
}

export function createNvmetTool(ctx) {
  return define(
    'truenas_nvmet',
    [
      'Inspect NVMe over Fabrics on TrueNAS: subsystems, host NQNs, namespaces, transports (ports) and connected sessions.',
      'Deleting a subsystem removes its namespaces from every connected host, so it requires confirm: true.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['overview', 'subsystems', 'hosts', 'namespaces', 'ports', 'sessions', 'subsystem_delete'],
          description: 'What to do.',
        },
        id: { type: 'number', description: 'Subsystem id for "subsystem_delete".' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "subsystem_delete".' },
      },
    },
    async (args) => {
      if (args.action === 'subsystem_delete') {
        const refusal = requireConfirm(args, 'delete an NVMe-oF subsystem')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const id = Number(args.id)
          if (!Number.isInteger(id)) return fail('Pass "id" with the numeric subsystem id.')
          await client.request('nvmet.subsys.delete', [id])
          return ok({
            action: 'subsystem_delete',
            text: `Deleted NVMe-oF subsystem ${id}; connected hosts lose its namespaces.`,
            data: { id },
          })
        })
      }

      return withInstance(ctx, args, async (client) => {
        const current = await state(client)
        const summary = `Subsystems: ${current.subsystems.length} · Hosts: ${current.hosts.length} · Namespaces: ${current.namespaces.length} · Ports: ${current.ports.length} · Sessions: ${current.sessions.length}`

        if (args.action === 'overview') {
          const subsysRows = current.subsystems.map((subsys) => ({
            id: subsys.id,
            name: subsys.name || '',
            subnqn: subsys.subnqn || '',
            namespaces: current.namespaces.filter((ns) => ns.subsys?.id === subsys.id || ns.subsys === subsys.id).length,
            anyHost: subsys.allow_any_host ? 'yes' : 'no',
          }))
          return ok({
            action: 'overview',
            text: subsysRows.length
              ? `${summary}\n${table(subsysRows, [
                  { key: 'id', header: 'ID' },
                  { key: 'name', header: 'Subsystem' },
                  { key: 'subnqn', header: 'NQN' },
                  { key: 'namespaces', header: 'Namespaces' },
                  { key: 'anyHost', header: 'Any host' },
                ])}`
              : `${summary}\nNo NVMe-oF subsystems configured.`,
            data: { ...current, counts: { subsystems: current.subsystems.length, hosts: current.hosts.length, namespaces: current.namespaces.length, ports: current.ports.length, sessions: current.sessions.length } },
          })
        }

        if (args.action === 'subsystems') {
          const rows = current.subsystems.map((subsys) => ({
            id: subsys.id,
            name: subsys.name || '',
            subnqn: subsys.subnqn || '',
            anyHost: subsys.allow_any_host ? 'yes' : 'no',
          }))
          return ok({
            action: 'subsystems',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'name', header: 'Subsystem' },
                  { key: 'subnqn', header: 'NQN' },
                  { key: 'anyHost', header: 'Any host' },
                ])
              : 'No NVMe-oF subsystems configured.',
            data: { subsystems: rows },
          })
        }

        if (args.action === 'hosts') {
          const rows = current.hosts.map((host) => ({
            id: host.id,
            hostnqn: host.hostnqn || '',
            dhchap: host.dhchap_key ? 'yes' : 'no',
          }))
          return ok({
            action: 'hosts',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'hostnqn', header: 'Host NQN' },
                  { key: 'dhchap', header: 'DH-CHAP' },
                ])
              : 'No NVMe-oF hosts configured.',
            data: { hosts: rows },
          })
        }

        if (args.action === 'namespaces') {
          const rows = current.namespaces.map((ns) => ({
            id: ns.id,
            nsid: ns.nsid ?? '',
            subsys: ns.subsys?.name || ns.subsys || '',
            device: ns.device_path || '',
            enabled: ns.enabled === false ? 'no' : 'yes',
          }))
          return ok({
            action: 'namespaces',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'nsid', header: 'NSID' },
                  { key: 'subsys', header: 'Subsystem' },
                  { key: 'device', header: 'Device' },
                  { key: 'enabled', header: 'Enabled' },
                ])
              : 'No NVMe-oF namespaces configured.',
            data: { namespaces: rows },
          })
        }

        if (args.action === 'ports') {
          const rows = current.ports.map((port) => ({
            id: port.id,
            transport: port.addr_trtype || '',
            address: `${port.addr_traddr || '*'}:${port.addr_trsvcid || ''}`,
            family: port.addr_adrfam || '',
          }))
          return ok({
            action: 'ports',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'transport', header: 'Transport' },
                  { key: 'address', header: 'Address' },
                  { key: 'family', header: 'Family' },
                ])
              : 'No NVMe-oF ports configured.',
            data: { ports: rows },
          })
        }

        const rows = current.sessions.map((session) => ({
          host: session.host_nqn || session.hostnqn || '',
          subsys: session.subsys_nqn || session.subsysnqn || '',
          transport: session.trtype || '',
          address: session.traddr || '',
        }))
        return ok({
          action: 'sessions',
          text: rows.length
            ? table(rows, [
                { key: 'host', header: 'Host NQN' },
                { key: 'subsys', header: 'Subsystem NQN' },
                { key: 'transport', header: 'Transport' },
                { key: 'address', header: 'Address' },
              ])
            : 'No NVMe-oF sessions connected.',
          data: { sessions: rows },
        })
      })
    },
  )
}
