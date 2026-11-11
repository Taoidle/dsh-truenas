/**
 * Users, groups, and filesystem ACLs.
 *
 * Users and groups are identified by their TrueNAS entry id everywhere in the
 * API (`user.update`, `user.delete`, group membership), while people think in
 * names. Every action here resolves the name to the id first and fails with the
 * list of candidates instead of guessing.
 */

import { formatDate, keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const USER_SELECT = ['id', 'username', 'full_name', 'uid', 'group', 'smb', 'locked', 'shell', 'builtin', 'home']

/**
 * POSIX1E ACLs report permissions as {READ, WRITE, EXECUTE} booleans; NFS4
 * ACLs report {basic} or {text}. Flatten either shape into one column.
 */
function permissionText(perms) {
  if (!perms) return ''
  if (typeof perms === 'string') return perms
  if (perms.basic) return String(perms.basic)
  if (perms.text) return String(perms.text)
  const flags = [perms.READ ? 'r' : '', perms.WRITE ? 'w' : '', perms.EXECUTE ? 'x' : ''].join('')
  if (flags) return flags
  const named = Object.keys(perms).filter((key) => perms[key] === true)
  return named.length ? named.join(',') : ''
}

function flagText(flags) {
  if (!flags) return ''
  if (typeof flags === 'string') return flags
  if (flags.basic) return String(flags.basic)
  if (flags.text) return String(flags.text)
  const named = Object.keys(flags).filter((key) => flags[key] === true)
  return named.join(',')
}
const GROUP_SELECT = ['id', 'gid', 'name', 'builtin', 'smb']

async function findUser(client, name) {
  const raw = String(name || '').trim()
  if (!raw) return { ok: false, error: 'Pass "user" with the username.' }
  const found = await client.request('user.query', [[['username', '=', raw]], { select: USER_SELECT, get: true }])
  if (!found) return { ok: false, error: `No user matches "${raw}". Run action "list" to see them.` }
  return { ok: true, user: found }
}

async function findGroup(client, nameOrId) {
  const raw = String(nameOrId ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "group" with the group name or id.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['name', '=', raw]]
  const found = await client.request('group.query', [filters, { select: GROUP_SELECT, get: true }])
  if (!found) return { ok: false, error: `No group matches "${raw}". Run action "groups" to see them.` }
  return { ok: true, group: found }
}

async function findPrivilege(client, spec) {
  const raw = String(spec ?? '').trim()
  if (!raw) return { ok: false, error: 'Pass "privilege" with the privilege name or id.' }
  const asId = Number(raw)
  const filters = Number.isInteger(asId) && String(asId) === raw ? [['id', '=', asId]] : [['name', '=', raw]]
  const found = await client.request('privilege.query', [filters, { get: true }])
  if (!found) return { ok: false, error: `No privilege matches "${raw}". Run action "privileges" to see them.` }
  return { ok: true, ...found }
}

export function createUsersTool(ctx) {
  return define(
    'truenas_users',
    [
      'Manage TrueNAS accounts and filesystem permissions: list or inspect users and groups, create, update and delete them, and read or replace the ACL of a path.',
      'ACL replacement can lock people out of a dataset, so it needs confirm: true; trueNAS identifies users and groups by entry id, while this tool resolves names for you.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: [
            'list',
            'get',
            'create',
            'update',
            'delete',
            'groups',
            'group_add',
            'group_remove',
            'acl',
            'acl_set',
            'privileges',
            'privilege_roles',
            'privilege_add',
            'privilege_update',
            'privilege_remove',
            'api_keys',
            'api_key_add',
            'api_key_remove',
            'set_password',
            'shell_choices',
          ],
          description: 'What to do.',
        },
        user: { type: 'string', description: 'Username for "get", "update" and "delete".' },
        username: { type: 'string', description: 'Login name ("create").' },
        fullName: { type: 'string', description: 'Full name / comment field ("create" and "update").' },
        password: {
          type: 'string',
          description:
            'Password for the account ("create", "update", "set_password"). Ask the user for it if it was not given; it is sent to the NAS and never echoed back.',
        },
        oldPassword: { type: 'string', description: 'Current password, only when changing your own password ("set_password").' },
        group: { type: 'string', description: 'Primary group name or id ("create").' },
        groupName: { type: 'string', description: 'Group name ("group_add").' },
        gid: { type: 'number', description: 'Optional explicit GID ("group_add").' },
        shell: { type: 'string', description: 'Login shell, for example /usr/bin/zsh ("create" and "update").' },
        home: { type: 'string', description: 'Home directory ("create" and "update").' },
        smb: { type: 'boolean', description: 'Allow SMB authentication ("create" and "update").' },
        locked: { type: 'boolean', description: 'Lock the account ("update").' },
        sshpubkey: { type: 'string', description: 'SSH public key ("create" and "update").' },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional groups by name or id ("create" and "update").',
        },
        deleteGroup: { type: 'boolean', description: 'Also delete the primary group when the user goes ("delete", default false).' },
        name: { type: 'string', description: 'Group name for "group_remove".' },
        path: { type: 'string', description: 'Filesystem path for "acl" and "acl_set".' },
        aclType: { type: 'string', description: 'ACL type for "acl_set": POSIX1E, NFS4 or DISABLED.' },
        acl: {
          type: 'object',
          additionalProperties: true,
          description: 'Complete payload for filesystem.setacl ("acl_set"): either the object with path/acltype/acl, or an object merged over path.',
        },
        privilege: { type: 'string', description: 'Privilege name or id for "privilege_update" and "privilege_remove".' },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Role names for "privilege_add" and "privilege_update", for example ["FULL_ADMIN"]. Action "privilege_roles" lists them.',
        },
        webShell: { type: 'boolean', description: 'Grant web shell access ("privilege_add" and "privilege_update").' },
        localGroups: {
          type: 'array',
          items: { type: 'number' },
          description: 'Local group ids granted by the privilege ("privilege_add" and "privilege_update").',
        },
        apiKeyName: { type: 'string', description: 'Human readable name for "api_key_add".' },
        apiKeyUser: { type: 'string', description: 'Username the API key belongs to ("api_key_add", default the instance user).' },
        keyId: { type: 'number', description: 'API key id for "api_key_remove".' },
        confirm: CONFIRM_PARAM,
        limit: { type: 'number', description: 'Maximum rows for "list" (default 40).' },
        all: { type: 'boolean', description: 'Include built-in system accounts in "list" (default false, so the list starts with real people).' },
      },
    },
    async (args) => {
      if (args.action === 'list') {
        return withInstance(ctx, args, async (client) => {
          const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 40
          const filters = args.all === true ? [] : [['builtin', '=', false]]
          const users = await client.request('user.query', [filters, { select: USER_SELECT, order_by: ['uid'], limit }])
          const rows = (Array.isArray(users) ? users : []).map((user) => ({
            username: user.username,
            uid: user.uid,
            group: user.group?.bsdgrp_group ?? '',
            fullName: user.full_name,
            smb: user.smb ? 'yes' : 'no',
            locked: user.locked ? 'yes' : 'no',
            builtin: user.builtin ? 'system' : '',
          }))
          if (!rows.length) {
            return ok({
              action: 'list',
              text: args.all === true ? 'No users reported.' : 'No non-system users. Pass all: true to include the built-in accounts.',
              data: { users: [] },
            })
          }
          const footer = args.all === true ? '' : '\n\nBuilt-in system accounts are hidden; pass all: true to include them.'
          return ok({
            action: 'list',
            text:
              table(rows, [
                { key: 'username', header: 'User' },
                { key: 'uid', header: 'UID' },
                { key: 'group', header: 'Group' },
                { key: 'fullName', header: 'Full name' },
                { key: 'smb', header: 'SMB' },
                { key: 'locked', header: 'Locked' },
                { key: 'builtin', header: 'Kind' },
              ]) + footer,
            data: { users: rows },
          })
        })
      }

      if (args.action === 'get') {
        return withInstance(ctx, args, async (client) => {
          const found = await findUser(client, args.user)
          if (!found.ok) return fail(found.error)
          const user = found.user
          return ok({
            action: 'get',
            text: keyValues([
              ['User', user.username],
              ['Full name', user.full_name],
              ['UID', user.uid],
              ['Primary group', user.group?.bsdgrp_group],
              ['Home', user.home],
              ['Shell', user.shell],
              ['SMB', user.smb ? 'yes' : 'no'],
              ['Locked', user.locked ? 'yes' : 'no'],
              ['System account', user.builtin ? 'yes' : 'no'],
            ]),
            data: { user },
          })
        })
      }

      if (args.action === 'create') {
        return withInstance(ctx, args, async (client) => {
          const username = String(args.username || '').trim()
          if (!username) return fail('Pass "username" for the new account.')
          const payload = { username, full_name: String(args.fullName || username) }
          if (args.group !== undefined) {
            const group = await findGroup(client, args.group)
            if (!group.ok) return fail(group.error)
            payload.group = group.group.id
          }
          if (args.password !== undefined) {
            const password = String(args.password)
            if (!password) return fail('The password is empty. Ask the user for it, or omit the parameter to create a passwordless account.')
            payload.password = password
          }
          if (args.shell !== undefined) payload.shell = String(args.shell)
          if (args.home !== undefined) payload.home = String(args.home)
          if (args.smb !== undefined) payload.smb = Boolean(args.smb)
          if (args.sshpubkey !== undefined) payload.sshpubkey = String(args.sshpubkey)
          if (Array.isArray(args.groups) && args.groups.length) {
            const ids = []
            for (const name of args.groups) {
              const group = await findGroup(client, name)
              if (!group.ok) return fail(group.error)
              ids.push(group.group.id)
            }
            payload.groups = ids
          }
          const created = await client.request('user.create', [payload])
          return ok({
            action: 'create',
            text: `Created user ${created?.username || username} (uid ${created?.uid ?? '?'}, id ${created?.id ?? '?'}). The password is not shown again.`,
            data: { user: { id: created?.id, username: created?.username, uid: created?.uid } },
          })
        })
      }

      if (args.action === 'update') {
        return withInstance(ctx, args, async (client) => {
          const found = await findUser(client, args.user)
          if (!found.ok) return fail(found.error)
          const payload = {}
          if (args.fullName !== undefined) payload.full_name = String(args.fullName)
          if (args.password !== undefined) {
            const password = String(args.password)
            if (!password) return fail('The password is empty; omit the parameter to leave it unchanged.')
            payload.password = password
          }
          if (args.shell !== undefined) payload.shell = String(args.shell)
          if (args.home !== undefined) payload.home = String(args.home)
          if (args.smb !== undefined) payload.smb = Boolean(args.smb)
          if (args.locked !== undefined) payload.locked = Boolean(args.locked)
          if (args.sshpubkey !== undefined) payload.sshpubkey = String(args.sshpubkey)
          if (args.group !== undefined) {
            const group = await findGroup(client, args.group)
            if (!group.ok) return fail(group.error)
            payload.group = group.group.id
          }
          if (Array.isArray(args.groups)) {
            const ids = []
            for (const name of args.groups) {
              const group = await findGroup(client, name)
              if (!group.ok) return fail(group.error)
              ids.push(group.group.id)
            }
            payload.groups = ids
          }
          if (!Object.keys(payload).length) return fail('Pass at least one field to change: fullName, password, shell, home, smb, locked, groups or group.')
          const updated = await client.request('user.update', [found.user.id, payload])
          return ok({
            action: 'update',
            text: `Updated user ${updated?.username || found.user.username}.`,
            data: { user: { id: updated?.id, username: updated?.username } },
          })
        })
      }

      if (args.action === 'delete') {
        const refusal = requireConfirm(args, 'delete a user account')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findUser(client, args.user)
          if (!found.ok) return fail(found.error)
          if (found.user.builtin) return fail(`"${found.user.username}" is a system account; it cannot be deleted.`)
          await client.request('user.delete', [found.user.id, { delete_group: args.deleteGroup === true }])
          return ok({ action: 'delete', text: `Deleted user ${found.user.username}.`, data: { username: found.user.username } })
        })
      }

      if (args.action === 'groups') {
        return withInstance(ctx, args, async (client) => {
          const groups = await client.request('group.query', [[], { select: GROUP_SELECT, order_by: ['gid'] }])
          const rows = (Array.isArray(groups) ? groups : []).map((group) => ({
            id: group.id,
            gid: group.gid,
            name: group.name,
            smb: group.smb ? 'yes' : 'no',
            builtin: group.builtin ? 'system' : '',
          }))
          if (!rows.length) return ok({ action: 'groups', text: 'No groups reported.', data: { groups: [] } })
          return ok({
            action: 'groups',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'gid', header: 'GID' },
              { key: 'name', header: 'Group' },
              { key: 'smb', header: 'SMB' },
              { key: 'builtin', header: 'Kind' },
            ]),
            data: { groups: rows },
          })
        })
      }

      if (args.action === 'group_add') {
        return withInstance(ctx, args, async (client) => {
          const name = String(args.groupName || args.name || '').trim()
          if (!name) return fail('Pass "groupName" for the new group.')
          const payload = { name }
          if (args.gid !== undefined) payload.gid = Number(args.gid)
          if (args.smb !== undefined) payload.smb = Boolean(args.smb)
          const created = await client.request('group.create', [payload])
          return ok({ action: 'group_add', text: `Created group ${created?.name || name} (gid ${created?.gid ?? '?'}).`, data: { group: created } })
        })
      }

      if (args.action === 'group_remove') {
        const refusal = requireConfirm(args, 'delete a group')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const found = await findGroup(client, args.name || args.group)
          if (!found.ok) return fail(found.error)
          if (found.group.builtin) return fail(`"${found.group.name}" is a system group; it cannot be deleted.`)
          await client.request('group.delete', [found.group.id])
          return ok({ action: 'group_remove', text: `Deleted group ${found.group.name}.`, data: { group: found.group.name } })
        })
      }

      if (args.action === 'acl') {
        return withInstance(ctx, args, async (client) => {
          const path = String(args.path || '').trim()
          if (!path) return fail('Pass "path" with an absolute dataset path, for example /mnt/tank/media.')
          const acl = await client.request('filesystem.getacl', [path])
          const entries = Array.isArray(acl?.acl) ? acl.acl : []
          const rows = entries.slice(0, 20).map((entry) => ({
            tag: entry.tag || '',
            id: entry.id ?? '',
            perm: permissionText(entry.perms),
            flags: flagText(entry.flags),
          }))
          const summary = keyValues([
            ['Path', acl?.path || path],
            ['ACL type', acl?.acltype],
            ['Owner', `${acl?.uid ?? '?'}:${acl?.gid ?? '?'}`],
            ['Entries', entries.length],
          ])
          const body = rows.length
            ? table(rows, [
                { key: 'tag', header: 'Tag' },
                { key: 'id', header: 'ID' },
                { key: 'perm', header: 'Permissions' },
                { key: 'flags', header: 'Flags' },
              ])
            : 'The path has no explicit ACL entries.'
          return ok({ action: 'acl', text: `${summary}\n\n${body}`, data: { acl } })
        })
      }

      if (args.action === 'acl_set') {
        const refusal = requireConfirm(args, 'replace the ACL of a path')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const path = String(args.path || '').trim()
          const payload = args.acl && typeof args.acl === 'object' ? { ...args.acl } : {}
          if (!payload.path) {
            if (!path) return fail('Pass "path" (and optionally aclType) or a complete "acl" payload.')
            payload.path = path
          }
          if (!payload.acltype) payload.acltype = String(args.aclType || 'POSIX1E')
          if (!payload.acl) return fail('The "acl" payload needs the acl entries: pass them as the "acl" object, for example {path, acltype, acl: [...]}.')
          await client.request('filesystem.setacl', [payload])
          const after = await client.request('filesystem.getacl', [payload.path])
          return ok({
            action: 'acl_set',
            text: `Replaced the ${payload.acltype} ACL of ${payload.path}. It now has ${Array.isArray(after?.acl) ? after.acl.length : '?'} entries.`,
            data: { path: payload.path, acltype: payload.acltype },
          })
        })
      }

      if (args.action === 'privileges') {
        return withInstance(ctx, args, async (client) => {
          const privileges = await client.request('privilege.query', [[], { order_by: ['id'] }])
          const rows = (Array.isArray(privileges) ? privileges : []).map((privilege) => ({
            id: privilege.id,
            name: privilege.name,
            roles: Array.isArray(privilege.roles) ? privilege.roles.join(', ') : '',
            webShell: privilege.web_shell ? 'yes' : 'no',
            groups: Array.isArray(privilege.local_groups)
              ? privilege.local_groups.map((group) => (group && typeof group === 'object' ? group.group || group.name || group.id : group)).join(', ') || '—'
              : '',
          }))
          if (!rows.length) return ok({ action: 'privileges', text: 'No privileges defined.', data: { privileges: [] } })
          return ok({
            action: 'privileges',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Privilege' },
              { key: 'roles', header: 'Roles' },
              { key: 'webShell', header: 'Web shell' },
              { key: 'groups', header: 'Local groups' },
            ]),
            data: { privileges: rows },
          })
        })
      }

      if (args.action === 'privilege_roles') {
        return withInstance(ctx, args, async (client) => {
          const roles = await client.request('privilege.roles', [[], {}])
          const rows = Array.isArray(roles)
            ? roles.map((role) => (typeof role === 'string' ? { role, description: '' } : { role: role.role || role.name, description: role.description || '' }))
            : Object.entries(roles && typeof roles === 'object' ? roles : {}).map(([role, description]) => ({ role, description: String(description) }))
          if (!rows.length) return ok({ action: 'privilege_roles', text: 'No roles reported.', data: { roles: [] } })
          return ok({
            action: 'privilege_roles',
            text: table(rows, [
              { key: 'role', header: 'Role' },
              { key: 'description', header: 'Description' },
            ]),
            data: { roles: rows },
          })
        })
      }

      if (args.action === 'privilege_add' || args.action === 'privilege_update') {
        return withInstance(ctx, args, async (client) => {
          const payload = {}
          if (typeof args.name === 'string') payload.name = args.name
          if (Array.isArray(args.roles)) payload.roles = args.roles.map(String)
          if (typeof args.webShell === 'boolean') payload.web_shell = args.webShell
          if (Array.isArray(args.localGroups)) payload.local_groups = args.localGroups.map(Number)
          if (!payload.roles && args.action === 'privilege_add') return fail('Pass "roles" with at least one role (action "privilege_roles" lists them).')
          if (!Object.keys(payload).length) return fail('Pass at least one field: name, roles, webShell, localGroups.')
          if (args.action === 'privilege_add') {
            const created = await client.request('privilege.create', [payload])
            return ok({ action: 'privilege_add', text: `Created privilege ${created.id} (${created.name}).`, data: { privilege: created } })
          }
          const target = await findPrivilege(client, args.privilege)
          if (!target.ok) return fail(target.error)
          const updated = await client.request('privilege.update', [target.id, payload])
          return ok({ action: 'privilege_update', text: `Updated privilege ${target.id} (${updated.name}).`, data: { privilege: updated } })
        })
      }

      if (args.action === 'privilege_remove') {
        const refusal = requireConfirm(args, 'delete a privilege')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const target = await findPrivilege(client, args.privilege)
          if (!target.ok) return fail(target.error)
          await client.request('privilege.delete', [target.id])
          return ok({ action: 'privilege_remove', text: `Deleted privilege ${target.id} (${target.name}).`, data: { id: target.id } })
        })
      }

      if (args.action === 'api_keys') {
        return withInstance(ctx, args, async (client) => {
          const keys = await client.request('api_key.query', [[], { order_by: ['id'] }])
          const rows = (Array.isArray(keys) ? keys : []).map((key) => ({
            id: key.id,
            name: key.name,
            username: key.username || key.user?.username || '',
            created: key.created_at ? formatDate(key.created_at) : '',
            expires: key.expires_at ? formatDate(key.expires_at) : 'never',
          }))
          if (!rows.length) return ok({ action: 'api_keys', text: 'No API keys.' , data: { keys: [] } })
          return ok({
            action: 'api_keys',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'username', header: 'User' },
              { key: 'created', header: 'Created' },
              { key: 'expires', header: 'Expires' },
            ]),
            data: { keys: rows },
          })
        })
      }

      if (args.action === 'api_key_add') {
        return withInstance(ctx, args, async (client, entry) => {
          const name = String(args.apiKeyName || '').trim()
          if (!name) return fail('Pass "apiKeyName" with a human readable name for the key.')
          const username = String(args.apiKeyUser || entry.username || 'root').trim()
          const created = await client.request('api_key.create', [{ name, username }])
          const secret = created?.key || created?.api_key || ''
          return ok({
            action: 'api_key_add',
            text: [
              `Created API key "${name}" for user ${username} (id ${created?.id}).`,
              secret ? `Key: ${secret}` : 'The server did not return the key material; read it from the TrueNAS UI.',
              'Store it somewhere safe now — TrueNAS shows it only once.',
            ].join('\n'),
            data: { id: created?.id, name, username, key: secret || undefined },
          })
        })
      }

      if (args.action === 'api_key_remove') {
        const refusal = requireConfirm(args, 'delete an API key')
        if (refusal) return refusal
        return withInstance(ctx, args, async (client) => {
          const id = Number(args.keyId)
          if (!Number.isInteger(id)) return fail('Pass "keyId" with the API key id (action "api_keys" lists them).')
          await client.request('api_key.delete', [id])
          return ok({ action: 'api_key_remove', text: `Deleted API key ${id}.`, data: { id } })
        })
      }

      if (args.action === 'set_password') {
        const username = String(args.user || args.username || '').trim()
        const next = String(args.password || '')
        if (!username) return fail('Pass "user" with the account whose password to change.')
        if (!next) return fail('Pass "password" with the new password (ask the user; it is never echoed back).')
        return withInstance(ctx, args, async (client) => {
          const payload = { username, new_password: next, old_password: args.oldPassword ? String(args.oldPassword) : null }
          await client.request('user.set_password', [payload])
          return ok({
            action: 'set_password',
            text: `Password changed for ${username}.`,
            data: { user: username },
          })
        })
      }

      if (args.action === 'shell_choices') {
        return withInstance(ctx, args, async (client) => {
          const choices = await client.request('user.shell_choices', [])
          const rows = Object.entries(choices && typeof choices === 'object' ? choices : {}).map(([path, label]) => ({ path, label: String(label) }))
          return ok({
            action: 'shell_choices',
            text: rows.length
              ? table(rows, [
                  { key: 'path', header: 'Shell' },
                  { key: 'label', header: 'Name' },
                ])
              : 'No shells reported.',
            data: { shells: rows },
          })
        })
      }

      return fail(`Unknown action "${args.action}". See the action list: list, get, create, update, delete, groups, group_add, group_remove, acl, acl_set, privileges, privilege_roles, privilege_add, privilege_update, privilege_remove, api_keys, api_key_add, api_key_remove, set_password, shell_choices.`)
    },
  )
}

