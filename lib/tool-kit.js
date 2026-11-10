/**
 * Shared tool plumbing: the tool shape the harness expects, the common result
 * envelopes, and instance resolution. Kept apart from the tool definitions so
 * each capability family can live in its own module.
 */

import { findInstance, instanceReadiness, listInstances, maskKey } from './instances.js'
import {
  errorText,
  formatBytes,
  formatDate,
  formatDuration,
  formatLoadAverage,
  jobLine,
  jsonBlock,
  keyValues,
  table,
  truncate,
} from './format.js'

/**
 * The harness ships a `defineTool` helper, but importing it would tie this
 * plugin to one harness build. The shape `tools.register` needs is small and
 * stable, so it is assembled here; each handler validates its own arguments.
 */
export function defineTool(definition) {
  return definition
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    instance: { type: 'string' },
    action: { type: 'string' },
    text: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    requiresConfirm: { type: 'boolean' },
  },
}

export const INSTANCE_PARAM = {
  type: 'string',
  description:
    'TrueNAS instance name as configured (for example "lab-nas"). Omit to use the first configured instance.',
}

export const CONFIRM_PARAM = {
  type: 'boolean',
  description: 'Destructive operations require this to be true. The tool refuses to run without it.',
}

export function ok(value) {
  return { ok: true, ...value }
}

export function fail(error, extra = {}) {
  return { ok: false, error: errorText(error), ...extra }
}

export function requireConfirm(args, what) {
  if (args.confirm === true) return null
  return {
    ok: false,
    error: `Refusing to ${what} without confirmation. Call again with confirm: true once you are sure.`,
    requiresConfirm: true,
  }
}

/**
 * Resolve the target instance, load its API key, and hand a ready client to
 * `run`. Every connection-level failure becomes a normal tool failure instead
 * of an exception.
 */
export async function withInstance(ctx, args, run) {
  const store = ctx.store
  const found = findInstance(store.config(), args.instance)
  if (!found.ok) return { ok: false, error: found.error, hint: 'Run truenas_instances action "list" to see configured instances.' }
  const entry = found.instance
  const apiKey = await store.getApiKey(entry.credential)
  const missing = instanceReadiness(entry, Boolean(apiKey))
  if (missing) {
    return {
      ok: false,
      instance: entry.name,
      error: `Instance "${entry.name}" is not ready: ${missing}`,
      hint: 'Set the API key with truenas_instances action "add" (or "update") and the apiKey parameter.',
    }
  }
  const client = ctx.pool.get(entry, apiKey)
  try {
    const result = await run(client, entry)
    return { ...result, instance: result.instance ?? entry.name }
  } catch (error) {
    return { ok: false, instance: entry.name, error: errorText(error) }
  }
}

export function render(toolName, value) {
  if (!value || value.ok !== true) {
    const prefix = value?.instance ? `${value.instance}: ` : ''
    let text = `✗ ${prefix}${value?.error || 'Unknown error'}`
    if (value?.hint) text += `\n${value.hint}`
    return [{ type: 'text', text }]
  }
  const header = value.instance ? `${toolName} · ${value.instance}` : toolName
  return [{ type: 'text', text: `${header}\n${value.text || ''}`.trimEnd() }]
}

export function define(toolName, description, parameters, execute) {
  return defineTool({
    name: toolName,
    description,
    parameters: { type: 'object', additionalProperties: false, ...parameters },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(toolName, value) },
    execute: async (args, exec) => {
      try {
        return await execute(args || {}, exec)
      } catch (error) {
        return fail(error)
      }
    },
  })
}

