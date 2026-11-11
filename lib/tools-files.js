/**
 * The filesystem itself: look at a directory, stat a path, make a directory.
 *
 * ACL work lives in `truenas_users` (get/set ACL); this tool exists because
 * "what is in /mnt/tank", "how big is this dataset" and "create the folder"
 * are questions that come up constantly and previously had no answer short of
 * shell access.
 */

import { formatBytes, formatDate, table } from './format.js'
import { INSTANCE_PARAM, define, fail, ok, withInstance } from './tool-kit.js'

function entryRow(entry) {
  const size = Number(entry.size)
  return {
    name: entry.name || '',
    type: entry.type || '',
    size: Number.isFinite(size) ? formatBytes(size) : '',
    modified: entry.modified ? formatDate(entry.modified) : '',
    mode: entry.mode ? String(entry.mode) : '',
  }
}

export function createFilesTool(ctx) {
  return define(
    'truenas_files',
    [
      'Inspect paths on the NAS filesystem: list a directory, stat a path, read filesystem usage, and create a directory.',
      'Paths are absolute and inside a pool, for example "/mnt/tank/media". Reading is safe; mkdir creates a directory and fails if the path exists.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['listdir', 'stat', 'statfs', 'mkdir'],
          description: 'What to do.',
        },
        path: { type: 'string', description: 'Absolute path, for example "/mnt/tank/media".' },
        limit: { type: 'number', description: 'Maximum entries for "listdir" (default 100, max 500).' },
        all: { type: 'boolean', description: 'Include hidden entries in "listdir" (default false).' },
        mode: { type: 'string', description: 'Octal mode for "mkdir", for example "0755".' },
      },
    },
    async (args) => {
      const path = String(args.path || '').trim()
      if (!path) return fail('Pass "path" with an absolute path, for example "/mnt/tank/media".')
      if (!path.startsWith('/')) return fail('"path" must be absolute, for example "/mnt/tank/media".')

      if (args.action === 'stat') {
        return withInstance(ctx, args, async (client) => {
          const info = await client.request('filesystem.stat', [path])
          if (!info) return fail(`No such path: ${path}`)
          const size = Number(info.size)
          return ok({
            action: 'stat',
            text: [
              path,
              `Type: ${info.type || '?'}`,
              Number.isFinite(size) ? `Size: ${formatBytes(size)} (${size} bytes)` : '',
              `Owner: ${info.uid ?? '?'}:${info.gid ?? '?'} · Mode: ${info.mode ?? '?'} (${info.acl ? 'ACL' : 'POSIX'})`,
              info.atime ? `Accessed: ${formatDate(info.atime)}` : '',
              info.mtime ? `Modified: ${formatDate(info.mtime)}` : '',
              info.btime ? `Created: ${formatDate(info.btime)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            data: { path, type: info.type, size: Number.isFinite(size) ? size : undefined, mode: info.mode, uid: info.uid, gid: info.gid },
          })
        })
      }

      if (args.action === 'statfs') {
        return withInstance(ctx, args, async (client) => {
          const info = await client.request('filesystem.statfs', [path])
          if (!info) return fail(`Cannot read filesystem stats for ${path}`)
          const total = Number(info.blocks) * Number(info.frsize || info.bsize || 0)
          const free = Number(info.bfree) * Number(info.frsize || info.bsize || 0)
          return ok({
            action: 'statfs',
            text: [
              path,
              `Filesystem: ${info.fstype || '?'}`,
              Number.isFinite(total) && total > 0 ? `Capacity: ${formatBytes(total - free)} / ${formatBytes(total)} used, ${formatBytes(free)} free` : '',
              `Type name: ${info.type_name || ''}`,
            ]
              .filter(Boolean)
              .join('\n'),
            data: { path, fstype: info.fstype, total: Number.isFinite(total) ? total : undefined, free: Number.isFinite(free) ? free : undefined },
          })
        })
      }

      if (args.action === 'mkdir') {
        return withInstance(ctx, args, async (client) => {
          const options = { mode: args.mode ? String(args.mode) : '0755' }
          const created = await client.request('filesystem.mkdir', [{ path, options }])
          return ok({
            action: 'mkdir',
            text: `Created ${created?.path || path} (mode ${options.mode}).`,
            data: { path: created?.path || path },
          })
        })
      }

      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
      const showHidden = args.all === true
      return withInstance(ctx, args, async (client) => {
        const entries = await client.request('filesystem.listdir', [
          path,
          [],
          { limit: showHidden ? limit : limit * 2 },
        ])
        const rows = (Array.isArray(entries) ? entries : [])
          .filter((entry) => showHidden || !String(entry.name || '').startsWith('.'))
          .slice(0, limit)
          .map(entryRow)
        if (!rows.length) return ok({ action: 'listdir', text: `${path} is empty.`, data: { path, entries: [] } })
        return ok({
          action: 'listdir',
          text: `${path} — ${rows.length} entries${rows.length === limit ? ` (limit ${limit})` : ''}\n${table(rows, [
            { key: 'type', header: 'Type' },
            { key: 'name', header: 'Name' },
            { key: 'size', header: 'Size' },
            { key: 'modified', header: 'Modified' },
          ])}`,
          data: { path, entries: rows },
        })
      })
    },
  )
}
