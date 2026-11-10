import assert from 'node:assert/strict'
import test from 'node:test'

import { createTools } from '../lib/tools.js'

const ENTRY = {
  name: 'mock',
  url: 'http://127.0.0.1:8734',
  username: 'root',
  apiPath: '/api/current',
  insecureTls: false,
  description: '',
  credential: 'TRUENAS_APIKEY_MOCK',
}

const REGISTRIES = [
  { id: 1, name: 'dockerhub', uri: 'https://index.docker.io/v1/', username: 'hub-user', password: '********', description: '' },
  { id: 4, name: 'ghcr', uri: 'https://ghcr.io', username: 'taoidle', password: '********', description: 'images' },
]

const INSTALLED = [{ name: 'my-web', state: 'RUNNING', version: '1.0.0', human_version: 'my-web 1.0.0', custom_app: true, upgrade_available: false }]

function build() {
  const calls = []
  const client = {
    displayUrl: 'http://127.0.0.1:8734',
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'app.registry.query') return REGISTRIES
      if (method === 'app.registry.create') return { id: 7, ...params[0], password: '********' }
      if (method === 'app.registry.update') return { id: params[0], ...params[1], password: '********' }
      if (method === 'app.registry.delete') return true
      if (method === 'app.create') return 42
      if (method === 'app.delete') return 43
      if (method === 'app.query') return params?.[1]?.get ? INSTALLED[0] : INSTALLED
      return null
    },
    async waitJob(id) {
      calls.push({ method: 'waitJob', params: [id] })
      return { id, state: 'SUCCESS', progress: { percent: 100 } }
    },
  }
  const store = {
    config: () => ({ instances: [ENTRY], timeoutMs: 60000, jobTimeoutMs: 600000 }),
    instances: () => [ENTRY],
    getApiKey: async () => '1-testkey',
  }
  const ctx = { config: { jobTimeoutMs: 600000 }, store, pool: { get: () => client } }
  const tools = createTools(ctx)
  const apps = tools.find((tool) => tool.name === 'truenas_apps')
  assert.ok(apps, 'truenas_apps is registered')
  return { apps, calls }
}

test('registry_add forwards the credentials and never echoes the password', async () => {
  const { apps, calls } = build()
  const result = await apps.execute({
    action: 'registry_add',
    registryName: 'ghcr',
    registryUri: 'https://ghcr.io',
    registryUsername: 'taoidle',
    registryPassword: 'ghp_secret',
  })

  assert.equal(result.ok, true)
  const created = calls.find((call) => call.method === 'app.registry.create')
  assert.deepEqual(created.params[0], {
    name: 'ghcr',
    uri: 'https://ghcr.io',
    username: 'taoidle',
    password: 'ghp_secret',
  })
  assert.ok(!result.text.includes('ghp_secret'), 'the password is not echoed')
  assert.ok(!JSON.stringify(result.data || {}).includes('ghp_secret'), 'the password is not in data')
  assert.match(result.text, /never shown again/)
})

test('registry_add refuses a blank password instead of sending it', async () => {
  const { apps, calls } = build()
  const result = await apps.execute({ action: 'registry_add', registryName: 'ghcr', registryUsername: 'taoidle', registryPassword: '   ' })

  assert.equal(result.ok, false)
  assert.match(result.error, /password is empty/i)
  assert.equal(calls.filter((call) => call.method === 'app.registry.create').length, 0)
})

test('registry_add names the missing fields', async () => {
  const { apps } = build()
  const result = await apps.execute({ action: 'registry_add', registryName: 'ghcr' })

  assert.equal(result.ok, false)
  assert.match(result.error, /"username", "password"/)
})

test('registry_list renders the configured registries without passwords', async () => {
  const { apps } = build()
  const result = await apps.execute({ action: 'registry_list' })

  assert.equal(result.ok, true)
  assert.match(result.text, /ghcr/)
  assert.match(result.text, /https:\/\/ghcr\.io/)
  assert.ok(!result.text.includes('********'), 'masked passwords are not shown either')
  assert.deepEqual(
    result.data.registries.map((registry) => registry.name),
    ['dockerhub', 'ghcr'],
  )
})

test('registry_update resolves a registry by name', async () => {
  const { apps, calls } = build()
  const result = await apps.execute({ action: 'registry_update', registry: 'GHCR', registryDescription: 'pinned' })

  assert.equal(result.ok, true)
  const update = calls.find((call) => call.method === 'app.registry.update')
  assert.deepEqual(update.params, [4, { description: 'pinned' }])
  assert.match(result.text, /Updated registry "ghcr"/)
})

test('registry_update refuses an unknown registry', async () => {
  const { apps } = build()
  const result = await apps.execute({ action: 'registry_update', registry: 'nope', registryName: 'x' })

  assert.equal(result.ok, false)
  assert.match(result.error, /No Docker registry matches "nope"/)
})

test('registry_remove needs confirm and then deletes by id', async () => {
  const { apps, calls } = build()

  const refused = await apps.execute({ action: 'registry_remove', registry: 'ghcr' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  assert.equal(calls.filter((call) => call.method === 'app.registry.delete').length, 0)

  const removed = await apps.execute({ action: 'registry_remove', registry: 'ghcr', confirm: true })
  assert.equal(removed.ok, true)
  const deletion = calls.find((call) => call.method === 'app.registry.delete')
  assert.deepEqual(deletion.params, [4])
  assert.match(removed.text, /Removed registry "ghcr"/)
})

test('create_custom sends a Compose document and waits for the job', async () => {
  const { apps, calls } = build()
  const compose = 'services:\n  web:\n    image: ghcr.io/taoidle/my-web:latest\n'
  const result = await apps.execute({ action: 'create_custom', app: 'my-web', compose })

  assert.equal(result.ok, true)
  const created = calls.find((call) => call.method === 'app.create')
  assert.deepEqual(created.params[0], {
    custom_app: true,
    app_name: 'my-web',
    custom_compose_config_string: compose.trimEnd(),
  })
  assert.ok(calls.some((call) => call.method === 'waitJob' && call.params[0] === 42))
  assert.match(result.text, /Created custom app my-web/)
  assert.match(result.text, /RUNNING/)
  assert.equal(result.data.job.id, 42)
})

test('create_custom accepts a parsed compose object', async () => {
  const { apps, calls } = build()
  const composeObject = { services: { web: { image: 'nginx:latest' } } }
  const result = await apps.execute({ action: 'create_custom', app: 'my-web', composeObject })

  assert.equal(result.ok, true)
  const created = calls.find((call) => call.method === 'app.create')
  assert.deepEqual(created.params[0].custom_compose_config, composeObject)
  assert.equal(created.params[0].custom_compose_config_string, undefined)
})

test('create_custom rejects an invalid app name before calling the NAS', async () => {
  const { apps, calls } = build()
  const result = await apps.execute({ action: 'create_custom', app: 'My_Web', compose: 'services:\n  web:\n    image: nginx\n' })

  assert.equal(result.ok, false)
  assert.match(result.error, /not a valid app name/)
  assert.equal(calls.filter((call) => call.method === 'app.create').length, 0)
})

test('create_custom rejects a compose document with no services section', async () => {
  const { apps, calls } = build()
  const result = await apps.execute({ action: 'create_custom', app: 'my-web', compose: 'version: "3"\n' })

  assert.equal(result.ok, false)
  assert.match(result.error, /services:/)
  assert.equal(calls.filter((call) => call.method === 'app.create').length, 0)
})

test('delete needs confirm and removes images by default', async () => {
  const { apps, calls } = build()

  const refused = await apps.execute({ action: 'delete', app: 'my-web' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirm, true)
  assert.equal(calls.filter((call) => call.method === 'app.delete').length, 0)

  const deleted = await apps.execute({ action: 'delete', app: 'my-web', confirm: true })
  assert.equal(deleted.ok, true)
  const call = calls.find((entry) => entry.method === 'app.delete')
  assert.deepEqual(call.params, ['my-web', { remove_images: true, remove_ix_volumes: false }])
  assert.match(deleted.text, /Deleted app my-web and its images/)
})

test('delete honours removeImages: false', async () => {
  const { apps, calls } = build()
  await apps.execute({ action: 'delete', app: 'my-web', confirm: true, removeImages: false })

  const call = calls.find((entry) => entry.method === 'app.delete')
  assert.deepEqual(call.params[1], { remove_images: false, remove_ix_volumes: false })
})
