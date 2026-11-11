/**
 * Method risk classification for `truenas_call`.
 *
 * The curated tools gate their destructive actions behind `confirm: true`. The
 * generic escape hatch used to bypass that entirely: any well-formed arguments
 * were enough to reboot the box or wipe a disk. This table closes that hole
 * without taking the escape hatch away.
 *
 * A reason string is what the refusal shows the caller, so it says what the
 * method would actually do rather than repeating the method name.
 */

const DESTRUCTIVE = new Map([
  ['system.reboot', 'reboot the system'],
  ['system.shutdown', 'shut the system down'],
  ['pool.export', 'export (detach) a storage pool'],
  ['pool.dataset.delete', 'delete a dataset'],
  ['pool.snapshot.delete', 'delete a snapshot'],
  ['pool.snapshot.rollback', 'roll a dataset back to a snapshot, discarding newer data'],
  ['disk.wipe', 'wipe a disk'],
  ['update.update', 'install a system update'],
  ['boot.environment.activate', 'switch the active boot environment'],
  ['boot.environment.destroy', 'destroy a boot environment'],
  ['user.delete', 'delete a user account'],
  ['group.delete', 'delete a group'],
  ['filesystem.setacl', 'replace the ACL of a path'],
  ['filesystem.setperm', 'replace the permissions of a path'],
  ['filesystem.chown', 'change the ownership of a path'],
  ['app.delete', 'delete an application'],
  ['replication.delete', 'delete a replication task'],
  ['cloudsync.delete', 'delete a cloud sync task'],
  ['cloud_backup.delete', 'delete a cloud backup task'],
  ['vm.delete', 'delete a virtual machine and its zvols'],
  ['vm.device.delete', 'remove a device from a virtual machine'],
  ['iscsi.target.delete', 'delete an iSCSI target, disconnecting its initiators'],
  ['iscsi.extent.delete', 'delete an iSCSI extent, disconnecting its initiators'],
  ['nvmet.subsys.delete', 'delete an NVMe-oF subsystem, removing its namespaces from every host'],
  ['keychaincredential.delete', 'delete a keychain credential that other tasks use'],
  ['ups.config.update', 'change UPS monitoring settings'],
  ['reporting.update', 'change the reporting configuration'],
  ['interface.commit', 'commit network changes, which can cut this connection'],
  ['interface.delete', 'delete a network interface'],
  ['cloudsync.credentials.delete', 'delete a cloud credential used by sync tasks'],
  ['certificate.delete', 'delete a certificate, breaking every service that uses it'],
  ['acme.dns.authenticator.delete', 'delete an ACME DNS authenticator'],
  ['pool.create', 'create a storage pool on the given disks, destroying their contents'],
  ['pool.offline', 'take a disk in a pool offline'],
  ['pool.replace', 'replace a disk in a pool'],
  ['pool.detach', 'detach a disk from a pool'],
  ['pool.remove', 'remove a disk from a pool'],
  ['pool.upgrade', 'upgrade a pool, after which older releases cannot import it'],
  ['update.run', 'install a system update and reboot into it'],
  ['directoryservices.leave', 'leave the Active Directory or LDAP domain'],
  ['catalog.delete', 'delete an application catalog'],
  ['catalog.sync', 'resynchronise the application catalog'],
  ['boot.attach', 'replace a boot-pool disk'],
  ['boot.detach', 'remove a disk from the boot pool'],
  ['boot.replace', 'replace a disk in the boot pool'],
  ['config.reset', 'reset the system configuration'],
  ['service.control', 'stop, start or restart a system service, interrupting whatever is using it'],
])

/** Whole namespaces whose every call can take the system down or strand it. */
const DESTRUCTIVE_PREFIXES = [['failover.', 'fail over to (or reboot) the peer controller']]

/**
 * @param {string} method JSON-RPC method name.
 * @returns {{dangerous: boolean, reason: string|null}}
 */
export function classifyMethod(method) {
  const name = String(method || '').trim()
  if (!name) return { dangerous: false, reason: null }
  const exact = DESTRUCTIVE.get(name)
  if (exact) return { dangerous: true, reason: exact }
  for (const [prefix, reason] of DESTRUCTIVE_PREFIXES) {
    if (name.startsWith(prefix)) return { dangerous: true, reason }
  }
  return { dangerous: false, reason: null }
}

/**
 * `core.bulk` hides the real work one level down, in `params[0]`, so a bulk
 * call has to be judged by the method it fans out to.
 *
 * @param {string} method
 * @param {unknown} params
 */
export function classifyCall(method, params) {
  const name = String(method || '').trim()
  if (name !== 'core.bulk') return { dangerous: classifyMethod(name).dangerous, reason: classifyMethod(name).reason, method: name }
  const inner = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : ''
  const verdict = classifyMethod(inner)
  return { dangerous: verdict.dangerous, reason: verdict.reason, method: inner || 'core.bulk' }
}

export function destructiveMethods() {
  return [...DESTRUCTIVE.keys()].sort()
}
