import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyCall, classifyMethod, destructiveMethods } from '../lib/danger.js'

test('destructive methods are classified with a reason', () => {
  assert.match(classifyMethod('system.reboot').reason, /reboot/)
  assert.match(classifyMethod('pool.export').reason, /pool/)
  assert.match(classifyMethod('user.delete').reason, /user/)
  assert.ok(destructiveMethods().includes('system.shutdown'))
})

test('ordinary methods are not flagged', () => {
  for (const method of ['system.info', 'pool.query', 'app.query', 'alert.list', 'interface.update']) {
    assert.equal(classifyMethod(method).dangerous, false, `${method} should be safe`)
  }
})

test('prefix rules cover the failover namespace', () => {
  assert.match(classifyMethod('failover.call_remote').reason, /peer/)
  assert.match(classifyMethod('failover.reboot.other_node').reason, /peer/)
})

test('core.bulk is unwrapped so a batched reboot is still caught', () => {
  const verdict = classifyCall('core.bulk', ['system.reboot', [{ delay: 0 }]])
  assert.equal(verdict.method, 'system.reboot')
  const nested = classifyCall('core.bulk', ['pool.dataset.delete', [['tank/data', {}]]])
  assert.equal(nested.method, 'pool.dataset.delete')
})

test('core.bulk of harmless methods stays harmless', () => {
  const verdict = classifyCall('core.bulk', ['system.info', [{}]])
  assert.equal(verdict.dangerous, false)
})

test('new namespaces are gated too', () => {
  for (const method of [
    'vm.delete',
    'vm.device.delete',
    'iscsi.target.delete',
    'iscsi.extent.delete',
    'nvmet.subsys.delete',
    'keychaincredential.delete',
    'ups.config.update',
    'reporting.update',
    'interface.commit',
    'interface.delete',
    'cloudsync.credentials.delete',
    'certificate.delete',
  ]) {
    assert.equal(classifyMethod(method).dangerous, true, `${method} should need confirmation`)
  }
})

test('reading the same namespaces stays safe', () => {
  for (const method of [
    'vm.query',
    'vm.status',
    'iscsi.target.query',
    'nvmet.subsys.query',
    'certificate.query',
    'reporting.get_data',
    'interface.query',
    'cloudsync.credentials.query',
    'disk.temperatures',
  ]) {
    assert.equal(classifyMethod(method).dangerous, false, `${method} should be safe`)
  }
})
