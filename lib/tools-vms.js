/**
 * Virtual machines.
 *
 * The API has 51 `vm.*` methods, but almost all of them configure hardware:
 * devices, passthrough, CPU models, display. Those stay in `truenas_call`
 * because they are one-off and easy to break a guest with. What people do over
 * and over is look at the list and turn a machine on or off, so that is what
 * this tool curates.
 */

import { formatBytes, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const VM_SELECT = ['id', 'name', 'description', 'vcpus', 'cores', 'memory', 'autostart', 'state', 'bootloader', 'cpu_mode']

function stateOf(vm) {
  return typeof vm.state === 'string' ? vm.state : vm.state?.state || 'UNKNOWN'
}

function rowOf(vm) {
  return {
    id: vm.id,
    name: vm.name || '',
    state: stateOf(vm),
    vcpu: vm.vcpus ?? vm.cores ?? '',
    memory: Number.isFinite(Number(vm.memory)) ? formatBytes(Number(vm.memory)) : '',
    autostart: vm.autostart === true ? 'yes' : 'no',
    boot: vm.bootloader || '',
  }
}

async function findVm(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "id" with a VM id or name.' }
  const numeric = Number(raw)
  const filters = Number.isInteger(numeric) && numeric > 0 ? [['id', '=', numeric]] : [['name', '=', raw]]
  const vm = await client.request('vm.query', [filters, { select: VM_SELECT, get: true }])
  if (!vm) return { ok: false, error: `No VM matching "${raw}". Run action "list" to see them.` }
  return { ok: true, vm }
}

export function createVmsTool(ctx) {
  return define(
    'truenas_vms',
    [
      'List the VMs on a TrueNAS host and control their power state: start, stop, restart, suspend and resume.',
      'Hardware configuration (devices, passthrough, disks, NICs) is not curated here; those methods exist under vm.* and can be called with truenas_call.',
      'Deleting a VM destroys it and its zvols, so it requires confirm: true.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['list', 'get', 'status', 'start', 'stop', 'restart', 'suspend', 'resume', 'clone', 'delete'],
          description: 'What to do.',
        },
        id: { type: 'string', description: 'VM id or exact VM name (for example "3" or "win11").' },
        name: { type: 'string', description: 'Name for "clone".' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "delete".' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const vms = await client.request('vm.query', [[], { select: VM_SELECT, order_by: ['id'] }])
          const rows = (Array.isArray(vms) ? vms : []).map(rowOf)
          if (!rows.length) return ok({ action: 'list', text: 'No virtual machines on this host.', data: { vms: [] } })
          const running = rows.filter((row) => row.state === 'RUNNING').length
          return ok({
            action: 'list',
            text: `${rows.length} VMs, ${running} running.\n${table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'state', header: 'State' },
              { key: 'vcpu', header: 'vCPU' },
              { key: 'memory', header: 'Memory' },
              { key: 'autostart', header: 'Autostart' },
              { key: 'boot', header: 'Boot' },
            ])}`,
            data: { vms: rows, running },
          })
        })
      }

      if (args.action === 'get' || args.action === 'status') {
        return withInstance(ctx, args, async (client) => {
          const found = await findVm(client, args.id)
          if (!found.ok) return fail(found.error)
          if (args.action === 'status') {
            const status = await client.request('vm.status', [found.vm.id])
            return ok({
              action: 'status',
              text: [
                `${found.vm.name} (id ${found.vm.id})`,
                `State: ${status?.state || stateOf(found.vm)}`,
                status?.pid ? `PID: ${status.pid}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              data: { id: found.vm.id, state: status?.state || stateOf(found.vm) },
            })
          }
          return ok({
            action: 'get',
            text: [
              `${found.vm.name} (id ${found.vm.id})`,
              found.vm.description ? `Description: ${found.vm.description}` : '',
              `State: ${stateOf(found.vm)}`,
              `vCPU: ${found.vm.vcpus ?? found.vm.cores ?? '?'}`,
              `Memory: ${Number.isFinite(Number(found.vm.memory)) ? formatBytes(Number(found.vm.memory)) : '?'}`,
              `Boot: ${found.vm.bootloader || '?'} · CPU mode: ${found.vm.cpu_mode || '?'}`,
              `Autostart: ${found.vm.autostart ? 'yes' : 'no'}`,
            ]
              .filter(Boolean)
              .join('\n'),
            data: { ...rowOf(found.vm) },
          })
        })
      }

      if (args.action === 'clone') {
        return withInstance(ctx, args, async (client) => {
          const found = await findVm(client, args.id)
          if (!found.ok) return fail(found.error)
          const name = String(args.name || `${found.vm.name}-clone`)
          const outcome = await client.request('vm.clone', [found.vm.id, { name }])
          if (typeof outcome === 'number') {
            const job = await client.waitJob(outcome, { timeoutMs: Math.min(ctx.config?.jobTimeoutMs || 600000, 300000) })
            return ok({
              action: 'clone',
              text: `Cloned ${found.vm.name} to ${name}: ${job?.state || 'unknown'}.`,
              data: { source: found.vm.id, name, state: job?.state },
            })
          }
          return ok({ action: 'clone', text: `Clone of ${found.vm.name} requested as ${name}.`, data: { source: found.vm.id, name } })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a virtual machine and its disks')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findVm(client, args.id)
          if (!found.ok) return fail(found.error)
          const outcome = await client.request('vm.delete', [found.vm.id, { zvols: true }])
          if (typeof outcome === 'number') await client.waitJob(outcome, { timeoutMs: 120000 })
          return ok({
            action: 'delete',
            text: `Deleted VM ${found.vm.name} (id ${found.vm.id}) and its zvols.`,
            data: { id: found.vm.id, name: found.vm.name },
          })
        })
      }

      return withInstance(ctx, args, async (client) => {
        const found = await findVm(client, args.id)
        if (!found.ok) return fail(found.error)
        const outcome = await client.request(`vm.${args.action}`, [found.vm.id])
        if (typeof outcome === 'number') await client.waitJob(outcome, { timeoutMs: 180000 })
        const after = await client.request('vm.query', [[['id', '=', found.vm.id]], { select: ['state'], get: true }]).catch(() => null)
        return ok({
          action: args.action,
          text: `${found.vm.name}: ${args.action} requested${after?.state ? `, now ${after.state}` : ''}.`,
          data: { id: found.vm.id, name: found.vm.name, state: after?.state },
        })
      })
    },
  )
}
