/**
 * Block sharing over iSCSI: targets, extents, portals, initiators and the live
 * session count.
 *
 * Creating a working target means wiring four objects together (extent, target,
 * target↔extent link, portal), which is exactly the kind of multi-parameter
 * change a person should drive in the web UI. This tool is for looking and for
 * removing an object that is in the way, behind a confirmation.
 */

import { table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const TARGET_SELECT = ['id', 'name', 'alias', 'mode', 'groups']
const EXTENT_SELECT = ['id', 'name', 'type', 'disk', 'path', 'filesize', 'enabled', 'naa']
const PORTAL_SELECT = ['id', 'comment', 'listen']
const INITIATOR_SELECT = ['id', 'comment', 'initiators']

async function overview(client) {
  const [targets, extents, portals, initiators, sessions] = await Promise.all([
    client.request('iscsi.target.query', [[], { select: TARGET_SELECT, order_by: ['name'] }]).catch(() => []),
    client.request('iscsi.extent.query', [[], { select: EXTENT_SELECT, order_by: ['name'] }]).catch(() => []),
    client.request('iscsi.portal.query', [[], { select: PORTAL_SELECT }]).catch(() => []),
    client.request('iscsi.initiator.query', [[], { select: INITIATOR_SELECT }]).catch(() => []),
    client.request('iscsi.global.sessions', []).catch(() => []),
  ])
  return {
    targets: Array.isArray(targets) ? targets : [],
    extents: Array.isArray(extents) ? extents : [],
    portals: Array.isArray(portals) ? portals : [],
    initiators: Array.isArray(initiators) ? initiators : [],
    sessions: Array.isArray(sessions) ? sessions : [],
  }
}

export function createIscsiTool(ctx) {
  return define(
    'truenas_iscsi',
    [
      'Inspect the iSCSI block-sharing setup on TrueNAS: targets, extents, portals, initiator groups and the currently connected sessions.',
      'Deleting a target or an extent disconnects whoever is using it, so both require confirm: true. Creating the four linked objects is left to the web UI or to truenas_call.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['overview', 'targets', 'extents', 'portals', 'initiators', 'sessions', 'target_delete', 'extent_delete'],
          description: 'What to do.',
        },
        id: { type: 'number', description: 'Target or extent id for the delete actions.' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "target_delete" and "extent_delete".' },
      },
    },
    async (args) => {
      if (args.action === 'target_delete' || args.action === 'extent_delete') {
        const refusal = requireConfirm(args, `delete an iSCSI ${args.action === 'target_delete' ? 'target' : 'extent'}`)
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const id = Number(args.id)
          if (!Number.isInteger(id)) return fail('Pass "id" with the numeric target or extent id.')
          const method = args.action === 'target_delete' ? 'iscsi.target.delete' : 'iscsi.extent.delete'
          await client.request(method, [id])
          return ok({
            action: args.action,
            text: `Deleted iSCSI ${args.action === 'target_delete' ? 'target' : 'extent'} ${id}; any initiator using it is now disconnected.`,
            data: { id },
          })
        })
      }

      return withInstance(ctx, args, async (client) => {
        const state = await overview(client)
        if (args.action === 'sessions') {
          const rows = state.sessions.map((session) => ({
            initiator: session.initiator || '',
            target: session.target || '',
            cid: session.cid ?? '',
            tsih: session.tsih ?? '',
            user: session.user || '',
          }))
          return ok({
            action: 'sessions',
            text: rows.length ? table(rows, [
              { key: 'initiator', header: 'Initiator' },
              { key: 'target', header: 'Target' },
              { key: 'cid', header: 'CID' },
              { key: 'tsih', header: 'TSIH' },
              { key: 'user', header: 'User' },
            ]) : 'No iSCSI sessions are connected.',
            data: { sessions: rows },
          })
        }

        if (args.action === 'targets' || args.action === 'overview') {
          const targets = state.targets.map((target) => ({
            id: target.id,
            name: target.name || '',
            alias: target.alias || '',
            mode: target.mode || '',
            groups: Array.isArray(target.groups) ? target.groups.length : 0,
          }))
          if (args.action === 'targets') {
            return ok({
              action: 'targets',
              text: targets.length
                ? table(targets, [
                    { key: 'id', header: 'ID' },
                    { key: 'name', header: 'Target' },
                    { key: 'alias', header: 'Alias' },
                    { key: 'mode', header: 'Mode' },
                    { key: 'groups', header: 'Groups' },
                  ])
                : 'No iSCSI targets configured.',
              data: { targets },
            })
          }
          const summary = [
            `Targets: ${state.targets.length} · Extents: ${state.extents.length} · Portals: ${state.portals.length} · Initiators: ${state.initiators.length} · Sessions: ${state.sessions.length}`,
          ]
          if (targets.length) {
            summary.push(
              table(targets, [
                { key: 'id', header: 'ID' },
                { key: 'name', header: 'Target' },
                { key: 'alias', header: 'Alias' },
                { key: 'groups', header: 'Groups' },
              ]),
            )
          }
          return ok({ action: 'overview', text: summary.join('\n'), data: { targets, counts: counts(state) } })
        }

        if (args.action === 'extents') {
          const rows = state.extents.map((extent) => ({
            id: extent.id,
            name: extent.name || '',
            type: extent.type || '',
            backing: extent.disk || extent.path || (extent.filesize ? `${Math.round(extent.filesize / (1024 * 1024 * 1024))} GiB file` : ''),
            enabled: extent.enabled === false ? 'no' : 'yes',
          }))
          return ok({
            action: 'extents',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'name', header: 'Extent' },
                  { key: 'type', header: 'Type' },
                  { key: 'backing', header: 'Backing' },
                  { key: 'enabled', header: 'Enabled' },
                ])
              : 'No iSCSI extents configured.',
            data: { extents: rows },
          })
        }

        if (args.action === 'portals') {
          const rows = state.portals.map((portal) => ({
            id: portal.id,
            comment: portal.comment || '',
            listen: (Array.isArray(portal.listen) ? portal.listen : [])
              .map((entry) => `${entry.ip || '*'}:${entry.port ?? 3260}`)
              .join(', '),
          }))
          return ok({
            action: 'portals',
            text: rows.length
              ? table(rows, [
                  { key: 'id', header: 'ID' },
                  { key: 'comment', header: 'Comment' },
                  { key: 'listen', header: 'Listen' },
                ])
              : 'No iSCSI portals configured.',
            data: { portals: rows },
          })
        }

        const rows = state.initiators.map((group) => ({
          id: group.id,
          comment: group.comment || '',
          initiators: (Array.isArray(group.initiators) ? group.initiators : []).join(', '),
        }))
        return ok({
          action: 'initiators',
          text: rows.length
            ? table(rows, [
                { key: 'id', header: 'ID' },
                { key: 'comment', header: 'Comment' },
                { key: 'initiators', header: 'Allowed initiators' },
              ])
            : 'No initiator groups configured (every initiator is allowed).',
          data: { initiators: rows },
        })
      })
    },
  )
}

function counts(state) {
  return {
    targets: state.targets.length,
    extents: state.extents.length,
    portals: state.portals.length,
    initiators: state.initiators.length,
    sessions: state.sessions.length,
  }
}
