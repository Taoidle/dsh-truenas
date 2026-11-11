/**
 * Performance reporting.
 *
 * TrueNAS keeps a time-series store behind `reporting.*`. The graphs are named
 * metrics (cpu, memory, disk, interface, …) plus an optional identifier such as
 * a disk or interface name; `data` returns aggregated buckets, so this tool
 * prints the latest bucket per series instead of dumping thousands of points.
 */

import { keyValues, table } from './format.js'
import { CONFIRM_PARAM, INSTANCE_PARAM, define, fail, ok, requireConfirm, withInstance } from './tool-kit.js'

const UNIT_PARAM = {
  type: 'string',
  enum: ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'],
  description: 'Aggregation unit for "data" (default: the server picks one).',
}

/**
 * TrueNAS returns each series as rows of [timestamp, column0, column1, …].
 * Summarise with the mean of every column over the returned window (the last
 * HOUR bucket can hold thousands of one-second points), and fall back to the
 * older {aggregations:{min,mean,max}} shape when a release returns that.
 */
function summarize(response) {
  const points = Array.isArray(response?.data) ? response.data : []
  const name = response?.name ?? ''
  const identifier = response?.identifier ?? ''
  if (!points.length) return { name, identifier, points: 0, latest: '(no data)', when: '' }

  const last = points[points.length - 1]
  if (Array.isArray(last)) {
    const sums = []
    const ends = []
    for (const row of points) {
      if (!Array.isArray(row) || row.length < 2) continue
      ends.push(Number(row[0]))
      for (let index = 1; index < row.length; index += 1) {
        sums[index - 1] = (sums[index - 1] || 0) + Number(row[index] || 0)
      }
    }
    const counts = ends.length || 1
    const widths = sums.length
    const values = sums.slice(0, 8).map((sum) => round(sum / counts))
    const suffix = widths > 8 ? ` (+${widths - 8} more series)` : ''
    return {
      name,
      identifier,
      points: points.length,
      latest: `mean ${values.join(', ')}${suffix}`,
      when: timestamp(ends[ends.length - 1]),
    }
  }

  const mean = last?.aggregations?.mean || last?.aggregations?.latest || null
  const values = mean && typeof mean === 'object' ? Object.entries(mean).map(([key, value]) => `${key}=${round(Number(value))}`) : []
  return {
    name,
    identifier,
    points: points.length,
    latest: values.length ? values.join(', ') : '(no data)',
    when: timestamp(last?.end ?? last?.start),
  }
}

function round(value) {
  if (!Number.isFinite(value)) return String(value)
  if (Math.abs(value) >= 100) return Math.round(value).toString()
  return (Math.round(value * 100) / 100).toString()
}

function timestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export function createReportingTool(ctx) {
  return define(
    'truenas_reporting',
    [
      'Performance reporting from TrueNAS: list the available graphs, read CPU/memory/disk/interface/ZFS ARC/UPS time series, and inspect the reporting configuration and Prometheus exporters.',
      'Pass action "data" with one graph name and an optional identifier (a disk or interface name) to get the latest aggregated bucket.',
    ].join(' '),
    {
      required: ['action'],
      properties: {
        instance: INSTANCE_PARAM,
        action: {
          type: 'string',
          enum: ['graphs', 'data', 'config', 'exporters', 'exporter_add', 'exporter_update', 'exporter_remove'],
          description: 'What to do.',
        },
        exporter: { type: 'number', description: 'Exporter id for "exporter_update" and "exporter_remove".' },
        data: { type: 'object', additionalProperties: true, description: 'Exporter payload for "exporter_add"/"exporter_update": {enabled, attributes:{exporter_type:"GRAPHITE", destination_ip, destination_port}}.' },
        confirm: { ...CONFIRM_PARAM, description: 'Required for "exporter_remove".' },
        graph: {
          type: 'string',
          description:
            'Metric name for "data": cpu, cputemp, disk, interface, load, processes, memory, uptime, arcactualrate, arcrate, arcsize, arcresult, disktemp, upscharge, upsruntime, upsvoltage, upscurrent, upsfrequency, upsload, upstemperature.',
        },
        identifier: { type: 'string', description: 'Specific instance for the metric (disk or interface name).' },
        unit: UNIT_PARAM,
        start: { type: 'number', description: 'Start timestamp (seconds since epoch) for "data".' },
        end: { type: 'number', description: 'End timestamp (seconds since epoch) for "data".' },
        aggregate: { type: 'boolean', description: 'Return aggregated buckets ("data", default true).' },
      },
    },
    async (args) => {
      if (args.action === 'graphs') {
        return withInstance(ctx, args, async (client) => {
          const graphs = await client.request('reporting.netdata_graphs', [[]])
          const rows = (Array.isArray(graphs) ? graphs : []).map((graph) => ({
            name: graph.name || graph.graph || '',
            identifier: typeof graph.identifier === 'string' ? graph.identifier : '',
            title: String(graph.title || '').replace(/\{identifier\}/g, 'per device'),
          }))
          const needsIdentifier = rows.some((row) => row.identifier)
          if (!rows.length) return ok({ action: 'graphs', text: 'No graphs reported.', data: { graphs: [] } })
          return ok({
            action: 'graphs',
            text: table(rows, [
              { key: 'name', header: 'Graph' },
              ...(needsIdentifier ? [{ key: 'identifier', header: 'Identifier' }] : []),
              { key: 'title', header: 'Title' },
            ]),
            data: { graphs: rows },
          })
        })
      }

      if (args.action === 'data') {
        return withInstance(ctx, args, async (client) => {
          const name = String(args.graph || '').trim()
          if (!name) return fail('Pass "graph" (for example cpu, memory, interface, disktemp).')
          const identifier = { name }
          if (args.identifier) identifier.identifier = args.identifier
          const query = {}
          if (args.unit) query.unit = args.unit
          if (Number.isFinite(args.start)) query.start = args.start
          if (Number.isFinite(args.end)) query.end = args.end
          if (typeof args.aggregate === 'boolean') query.aggregate = args.aggregate
          const responses = await client.request('reporting.get_data', [[identifier], query])
          const series = (Array.isArray(responses) ? responses : []).map(summarize)
          if (!series.length) return ok({ action: 'data', text: `No data returned for graph "${name}".`, data: { series: [] } })
          return ok({
            action: 'data',
            text: table(series, [
              { key: 'name', header: 'Graph' },
              { key: 'identifier', header: 'Identifier' },
              { key: 'points', header: 'Points' },
              { key: 'latest', header: 'Mean over window' },
              { key: 'when', header: 'Last point' },
            ]),
            data: { series },
          })
        })
      }

      if (args.action === 'config') {
        return withInstance(ctx, args, async (client) => {
          const config = await client.request('reporting.config', [])
          const entries = Object.entries(config && typeof config === 'object' ? config : {})
          return ok({
            action: 'config',
            text: keyValues(entries.map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])),
            data: { config },
          })
        })
      }

      if (args.action === 'exporters') {
        return withInstance(ctx, args, async (client) => {
          const exporters = await client.request('reporting.exporters.query', [[], {}])
          const rows = (Array.isArray(exporters) ? exporters : []).map((exporter) => ({
            id: exporter.id,
            name: exporter.name,
            enabled: exporter.enabled ? 'yes' : 'no',
            type: exporter.type || exporter.exporter_type || '',
          }))
          if (!rows.length) return ok({ action: 'exporters', text: 'No reporting exporters configured.', data: { exporters: [] } })
          return ok({
            action: 'exporters',
            text: table(rows, [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'type', header: 'Type' },
              { key: 'enabled', header: 'Enabled' },
            ]),
            data: { exporters: rows },
          })
        })
      }

      if (args.action === 'exporter_add' || args.action === 'exporter_update' || args.action === 'exporter_remove') {
        const payload = args.data && typeof args.data === 'object' ? args.data : null
        if (args.action === 'exporter_add' && !payload) return fail('Pass "data" with {enabled, attributes:{exporter_type:"GRAPHITE", destination_ip:"…", destination_port:2003}}.')
        if (args.action === 'exporter_update' && !payload) return fail('Pass "data" with the fields to change.')
        if (args.action === 'exporter_remove') {
          const refusal = requireConfirm(args, 'delete a reporting exporter')
          if (refusal) return refusal
        }
        const id = Number(args.exporter)
        if (args.action !== 'exporter_add' && (!Number.isInteger(id) || id <= 0)) {
          return fail('Pass "exporter" with the numeric exporter id from action "exporters".')
        }
        return withInstance(ctx, args, async (client) => {
          if (args.action === 'exporter_add') {
            const created = await client.request('reporting.exporters.create', [payload])
            return ok({ action: 'exporter_add', text: `Added ${payload.attributes?.exporter_type || 'reporting'} exporter ${created?.id ?? ''}.`, data: { exporter: created?.id } })
          }
          if (args.action === 'exporter_update') {
            await client.request('reporting.exporters.update', [id, payload])
            return ok({ action: 'exporter_update', text: `Updated reporting exporter ${id}.`, data: { exporter: id } })
          }
          await client.request('reporting.exporters.delete', [id])
          return ok({ action: 'exporter_remove', text: `Deleted reporting exporter ${id}.`, data: { exporter: id } })
        })
      }

      return fail(`Unknown action "${args.action}".`)
    },
  )
}
