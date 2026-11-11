/**
 * Settings page for dsh-truenas.
 *
 * The bundle is host-only for its behaviour, but the DSH Web UI renders this
 * module in two seats: `settings.section` (Settings → TrueNAS) and
 * `plugins.row.config` keyed by `<package name>#<row id>` (the plugin row's
 * configure control). Both render the same page and talk to the plugin's own
 * `/dsh-truenas/config` and `/dsh-truenas/action` routes, so the API key only
 * ever travels from this form to the DSH credential store.
 */

window.__ModuleLoader__.load({
  id: 'dsh-truenas',
  factory: (require) => {
    const React = require('react')

    const NS = 'dsh-truenas'
    const PKG = 'dsh-truenas'
    const ROW_ID = 'dsh-truenas'
    const ROW_CONFIG_KEY = PKG + '#' + ROW_ID
    const CONFIG_PATH = '/dsh-truenas/config'
    const ACTION_PATH = '/dsh-truenas/action'
    const REQUEST_TIMEOUT_MS = 20000

    const en = {
      title: 'TrueNAS systems',
      intro: 'Add each TrueNAS system once, then let DSH manage it. The API key is verified before it is stored in the DSH credential store.',
      add: 'Add system',
      addTitle: 'Add a TrueNAS system',
      editTitle: 'Edit {name}',
      name: 'Name',
      nameHint: 'How tools refer to this system. Defaults to the host name.',
      address: 'Address',
      addressHint: 'Web UI address, for example https://nas.lab.local or 192.168.1.10. API keys only work over TLS: enable HTTPS on the NAS or front it with a TLS proxy, and point this at the TLS port.',
      username: 'Username',
      usernameHint: 'The TrueNAS user that owns the API key.',
      apiKey: 'API key',
      apiKeyHint: 'Create one in TrueNAS under Credentials → API Keys.',
      apiKeyKeep: 'Leave blank to keep the stored key.',
      insecureTls: 'Skip TLS certificate verification',
      insecureTlsHint: 'For a self-signed certificate. This only skips certificate checks; the connection still has to be TLS.',
      advanced: 'Advanced',
      apiPath: 'API path',
      apiPathHint: 'WebSocket API path. Defaults to /api/current.',
      note: 'Note',
      noteHint: 'Optional description shown in this list.',
      cancel: 'Cancel',
      save: 'Verify and save',
      saving: 'Verifying…',
      test: 'Test',
      testing: 'Testing…',
      makeDefault: 'Make default',
      edit: 'Edit',
      remove: 'Remove',
      confirmRemove: 'Click again to remove',
      defaultBadge: 'default',
      keyStored: 'key stored',
      keyMissing: 'no key',
      tlsVerified: 'TLS verified',
      tlsInsecure: 'TLS unverified',
      nav: 'TrueNAS',
      empty: 'No TrueNAS system configured yet. Add one with its address and the API key from TrueNAS.',
      loading: 'Loading…',
      unreachable: 'The settings service did not answer. Reload the page or restart DSH.',
      summary_one: '1 system configured',
      summary_many: '{count} systems configured',
      summary_empty: 'No system configured',
      summary_default: 'default: {name}',
      noticeSaved: 'Saved {name}. TrueNAS {version}',
      noticeUpdated: 'Updated {name}. TrueNAS {version}',
      noticeRemoved: 'Removed {name}.',
      noticeDefault: '{name} is now the default system.',
      noticeTested: '{name} is reachable. TrueNAS {version}',
      toolNote: 'The agent manages the same list with the truenas_instances tool.',
      fieldsRequired: 'Address and API key are required.',
      hostname: 'Hostname',
      version: 'Version',
      panelTitle: 'TrueNAS overview',
      panelDesc: 'Live CPU, memory, pools, apps, jobs and alerts for one TrueNAS system.',
      panelSystem: 'System',
      panelRefresh: 'Refresh',
      panelOpen: 'Open web UI',
      panelCpu: 'CPU',
      panelMemory: 'Memory',
      panelPool: 'Pool',
      panelTemp: 'Temperature',
      panelApps: 'Applications',
      panelJobs: 'Jobs',
      panelAlerts: 'Alerts',
      panelPools: 'Pools',
      panelNoPools: 'No pools on this system.',
      panelServices: 'Services',
      panelCertificates: 'Certificates',
      panelDisks: 'Disks',
      panelNoServices: 'No services reported.',
      panelNoCerts: 'No certificates on this NAS.',
      panelNoDisks: 'No disks attached.',
      panelBootOn: 'Boot on',
      panelBootOff: 'Boot off',
      panelSelfTest: 'Self-test',
      panelExpired: 'Expired',
      panelRenewSoon: 'Renew soon',
      panelNoTemp: 'no sensor',
      panelCertNote: 'Renew from the NAS web UI.',
      panelSnapshot: 'Snapshot',
      panelSnapshotBusy: 'Snapshotting…',
      panelNoApps: 'No applications installed.',
      panelNoJobs: 'No job is running.',
      panelNoAlerts: 'No open alert.',
      panelStart: 'Start',
      panelStop: 'Stop',
      panelRestart: 'Restart',
      panelUpdate: 'Update',
      panelDelete: 'Delete',
      panelConfirmDelete: 'Click again to delete',
      panelAbort: 'Abort',
      panelDismiss: 'Dismiss',
      panelWorking: 'Working…',
      panelNoSystem: 'No TrueNAS system is configured yet. Add one in Settings → TrueNAS.',
      panelOffline: 'This system did not answer.',
    panelStale: 'Refresh failed',
      panelUptime: 'up {value}',
      panelLoad: 'load {value}',
      panelUsedOf: '{used} of {total}',
      panelRuns: '{count} running',
      panelNotReady: 'Open Settings → TrueNAS to finish configuring this system.',
    }

    const zh = {
      title: 'TrueNAS 系统',
      intro: '把每台 TrueNAS 添加一次，之后交给 DSH 管理。API 密钥会先验证，再存入 DSH 凭据库。',
      add: '添加系统',
      addTitle: '添加 TrueNAS 系统',
      editTitle: '编辑 {name}',
      name: '名称',
      nameHint: '工具引用这台系统时使用的名字，默认取主机名。',
      address: '地址',
      addressHint: 'Web 界面地址，例如 https://nas.lab.local 或 192.168.1.10。API 密钥只在加密连接上可用：请在 NAS 上启用 HTTPS，或前置一个 TLS 反代，然后填它的 TLS 端口。',
      username: '用户名',
      usernameHint: '拥有该 API 密钥的 TrueNAS 用户。',
      apiKey: 'API 密钥',
      apiKeyHint: '在 TrueNAS 的「凭据 → API 密钥」中创建。',
      apiKeyKeep: '留空则沿用已保存的密钥。',
      insecureTls: '跳过 TLS 证书校验',
      insecureTlsHint: '用于自签名证书。它只跳过证书校验，连接本身仍必须是 TLS。',
      advanced: '高级选项',
      apiPath: 'API 路径',
      apiPathHint: 'WebSocket API 路径，默认 /api/current。',
      note: '备注',
      noteHint: '可选描述，显示在此列表中。',
      cancel: '取消',
      save: '验证并保存',
      saving: '正在验证…',
      test: '测试',
      testing: '测试中…',
      makeDefault: '设为默认',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '再点一次确认删除',
      defaultBadge: '默认',
      keyStored: '已存密钥',
      keyMissing: '缺少密钥',
      tlsVerified: 'TLS 已验证',
      tlsInsecure: 'TLS 未校验',
      nav: 'TrueNAS',
      empty: '还没有配置 TrueNAS 系统。填入地址和 TrueNAS 中生成的 API 密钥即可添加。',
      loading: '加载中…',
      unreachable: '设置服务没有响应。请刷新页面或重启 DSH。',
      summary_one: '已配置 1 台系统',
      summary_many: '已配置 {count} 台系统',
      summary_empty: '尚未配置系统',
      summary_default: '默认：{name}',
      noticeSaved: '已保存 {name}。TrueNAS {version}',
      noticeUpdated: '已更新 {name}。TrueNAS {version}',
      noticeRemoved: '已删除 {name}。',
      noticeDefault: '已将 {name} 设为默认系统。',
      noticeTested: '{name} 连接正常。TrueNAS {version}',
      toolNote: '智能体通过 truenas_instances 工具管理同一份列表。',
      fieldsRequired: '地址和 API 密钥不能为空。',
      hostname: '主机名',
      version: '版本',
      panelTitle: 'TrueNAS 概览',
      panelDesc: '一台 TrueNAS 的实时 CPU、内存、存储池、应用、作业与告警。',
      panelSystem: '系统',
      panelRefresh: '刷新',
      panelOpen: '打开 Web UI',
      panelCpu: 'CPU',
      panelMemory: '内存',
      panelPool: '存储池',
      panelTemp: '温度',
      panelApps: '应用',
      panelJobs: '作业',
      panelAlerts: '告警',
      panelPools: '存储池',
      panelNoPools: '这台系统上没有存储池。',
      panelServices: '服务',
      panelCertificates: '证书',
      panelDisks: '磁盘',
      panelNoServices: '没有可显示的服务。',
      panelNoCerts: '这台 NAS 上没有证书。',
      panelNoDisks: '没有连接磁盘。',
      panelBootOn: '自启开',
      panelBootOff: '自启关',
      panelSelfTest: '自检',
      panelExpired: '已过期',
      panelRenewSoon: '即将到期',
      panelNoTemp: '无传感器',
      panelCertNote: '续期请在 NAS Web UI 中完成。',
      panelSnapshot: '快照',
      panelSnapshotBusy: '正在创建快照…',
      panelNoApps: '尚未安装应用。',
      panelNoJobs: '没有正在运行的作业。',
      panelNoAlerts: '没有未处理的告警。',
      panelStart: '启动',
      panelStop: '停止',
      panelRestart: '重启',
      panelUpdate: '更新',
      panelDelete: '删除',
      panelConfirmDelete: '再次点击确认删除',
      panelAbort: '中止',
      panelDismiss: '忽略',
      panelWorking: '处理中…',
      panelNoSystem: '还没有配置 TrueNAS 系统。请在「设置 → TrueNAS」中添加。',
      panelOffline: '这台系统没有响应。',
      panelStale: '刷新失败',
      panelUptime: '已运行 {value}',
      panelLoad: '负载 {value}',
      panelUsedOf: '{used} / {total}',
      panelRuns: '{count} 个运行中',
      panelNotReady: '请在「设置 → TrueNAS」中完成这台系统的配置。',
    }

    const css = `
.dtn-card{display:flex;flex-direction:column;gap:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:16px}
.dtn-head{display:flex;align-items:flex-start;gap:12px}
.dtn-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dtn-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.dtn-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:0}
.dtn-list{display:flex;flex-direction:column;gap:8px;list-style:none;margin:0;padding:0}
.dtn-row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2)}
.dtn-rowMain{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dtn-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dtn-url{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-all}
.dtn-badge{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dtn-badgeOn{color:var(--dsw-alias-state-success-primary)}
.dtn-badgeWarn{color:var(--dsw-alias-state-warning-primary)}
.dtn-note{color:var(--dsw-alias-label-dimmed);font-size:12px;line-height:1.5}
.dtn-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.dtn-actions{display:flex;gap:8px;flex-wrap:wrap;padding-top:2px}
.dtn-btn{appearance:none;font:inherit;font-size:12px;line-height:1;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;background:transparent;color:var(--dsw-alias-label-primary)}
.dtn-btn:hover{border-color:var(--dsw-alias-label-dimmed)}
.dtn-btn:disabled{opacity:.45;cursor:default}
.dtn-primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3);font-size:13px;padding:7px 14px}
.dtn-danger{color:var(--dsw-alias-label-error)}
.dtn-form{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:14px;display:flex;flex-direction:column;gap:12px}
.dtn-formHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dtn-formTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dtn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.dtn-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dtn-label{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}
.dtn-input{height:32px;box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}
.dtn-input:focus{outline:2px solid var(--dsw-alias-label-dimmed);outline-offset:-1px}
.dtn-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin:0}
.dtn-check{display:flex;align-items:flex-start;gap:8px;padding-top:2px}
.dtn-check input{margin:2px 0 0}
.dtn-foot{display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap}
.dtn-msg{margin:0;font-size:12px;line-height:1.55;border-radius:8px;padding:8px 10px}
.dtn-err{color:var(--dsw-alias-label-error);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-label-error)}
.dtn-ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-success-primary)}
.dtn-muted{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin:0}
.dtn-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;text-align:center;margin:0}
.dtn-summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin:0}
.dtn-panel{display:flex;flex-direction:column;gap:12px;padding:12px;height:100%;box-sizing:border-box;overflow:auto;color:var(--dsw-alias-label-primary);font-size:12px}
.dtn-panelHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dtn-panelSelect{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;max-width:100%}
.dtn-panelSpacer{flex:1}
.dtn-panelStatus{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.dtn-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.dtn-dotOff{background:var(--dsw-alias-label-error)}
.dtn-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dtn-panelCard{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:9px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}
.dtn-cardLabel{color:var(--dsw-alias-label-secondary);font-size:11px}
.dtn-cardValue{font-size:18px;font-weight:600;line-height:1.25}
.dtn-cardSub{color:var(--dsw-alias-label-dimmed);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtn-bar{height:3px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);overflow:hidden;margin-top:4px}
.dtn-barFill{height:100%;background:var(--dsw-alias-state-success-primary);border-radius:999px}
.dtn-barWarn{background:var(--dsw-alias-state-warning-primary)}
.dtn-barBad{background:var(--dsw-alias-label-error)}
.dtn-section{display:flex;flex-direction:column;gap:6px}
.dtn-sectionHead{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.dtn-appList{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;padding-right:2px}
.dtn-serviceList,.dtn-diskList{max-height:220px}
.dtn-certList{max-height:180px}
.dtn-poolList{display:flex;flex-direction:column;gap:6px}
.dtn-poolRow{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 8px;background:var(--dsw-alias-bg-layer-2)}
.dtn-appRow{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 8px;background:var(--dsw-alias-bg-layer-2)}
.dtn-appMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dtn-appName{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtn-appMeta{color:var(--dsw-alias-label-dimmed);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtn-appActions{display:flex;gap:4px;flex-shrink:0}
.dtn-chip{font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.dtn-chipOn{color:var(--dsw-alias-state-success-primary)}
.dtn-chipWarn{color:var(--dsw-alias-state-warning-primary)}
.dtn-chipBad{color:var(--dsw-alias-label-error)}
.dtn-miniBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;font:inherit;font-size:10px;line-height:1;padding:4px 6px;cursor:pointer;white-space:nowrap}
.dtn-miniBtn:hover{border-color:var(--dsw-alias-label-dimmed)}
.dtn-miniBtn:disabled{opacity:.4;cursor:default}
.dtn-miniBtnDanger{color:var(--dsw-alias-label-error)}
.dtn-miniBtnArmed{color:var(--dsw-alias-bg-layer-3);background:var(--dsw-alias-label-error);border-color:transparent}
.dtn-panelEmpty{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin:0;padding:6px 0}
.dtn-alertRow{display:flex;align-items:flex-start;gap:6px;border-left:2px solid var(--dsw-alias-state-warning-primary);padding:4px 0 4px 8px}
.dtn-alertText{flex:1;min-width:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary);word-break:break-word}
.dtn-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

    let styleInjected = false
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return
      const existing = document.querySelector('style[data-dsh-plugin="dsh-truenas"]')
      if (existing) {
        styleInjected = true
        return
      }
      const style = document.createElement('style')
      style.setAttribute('data-dsh-plugin', 'dsh-truenas')
      style.textContent = css
      document.head.appendChild(style)
      styleInjected = true
    }

    function getService(ctx, name) {
      if (!ctx) return undefined
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    }

    function activeLocale(localeSvc) {
      const snap = localeSvc && typeof localeSvc.getSnapshot === 'function' ? localeSvc.getSnapshot() : undefined
      const active = snap && snap.active
      if (typeof active === 'string' && active) return active
      return typeof navigator !== 'undefined' ? String(navigator.language || '').slice(0, 2) : 'en'
    }

    function useActiveLocale(ctx) {
      const localeSvc = getService(ctx, 'locale')
      return React.useSyncExternalStore(
        React.useCallback((cb) => (localeSvc && typeof localeSvc.subscribe === 'function' ? localeSvc.subscribe(cb) : () => {}), [localeSvc]),
        React.useCallback(() => activeLocale(localeSvc), [localeSvc]),
      )
    }

    // One translator per locale, kept for the life of the page. Components use
    // `t` inside callbacks and effects, so a fresh function on every render
    // would make those effects re-run forever (and hammer the host routes).
    const translators = new Map()

    function makeT(locale) {
      const cacheKey = String(locale || '')
      const cached = translators.get(cacheKey)
      if (cached) return cached
      const dict = cacheKey.startsWith('zh') ? zh : en
      const translate = (key, vars) => {
        let text = dict[key] || en[key] || key
        if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value ?? ''))
        return text
      }
      translators.set(cacheKey, translate)
      return translate
    }

    async function requestJson(path, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined
      try {
        const response = await fetch(path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          signal: controller?.signal,
        })
        const text = await response.text()
        let payload
        try {
          payload = text ? JSON.parse(text) : {}
        } catch {
          throw new Error(`Unexpected response from ${path} (HTTP ${response.status})`)
        }
        if (!response.ok && payload?.ok !== false) throw new Error(payload?.error || `HTTP ${response.status}`)
        return payload
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    function Field(props) {
      return React.createElement(
        'label',
        { className: 'dtn-field' },
        React.createElement('span', { className: 'dtn-label' }, props.label),
        props.children,
        props.hint ? React.createElement('span', { className: 'dtn-hint' }, props.hint) : null,
      )
    }

    function input(props) {
      return React.createElement('input', {
        className: 'dtn-input',
        type: props.type || 'text',
        value: props.value || '',
        placeholder: props.placeholder || '',
        autoComplete: props.autoComplete || 'off',
        spellCheck: false,
        disabled: props.disabled || false,
        onChange: (event) => props.onChange(event.target.value),
      })
    }

    function emptyDraft() {
      return { name: '', url: '', username: 'root', apiKey: '', insecureTls: false, apiPath: '/api/current', description: '' }
    }

    function draftFrom(entry) {
      return {
        name: entry.name,
        url: entry.url,
        username: entry.username || 'root',
        apiKey: '',
        insecureTls: Boolean(entry.insecureTls),
        apiPath: entry.apiPath || '/api/current',
        description: entry.description || '',
      }
    }

    function TrueNasCard(props) {
      const { ctx, view } = props
      const locale = useActiveLocale(ctx)
      const t = makeT(locale)

      const [status, setStatus] = React.useState({ phase: 'loading', data: null, error: '' })
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState(null)
      const [confirming, setConfirming] = React.useState('')
      const [showAdvanced, setShowAdvanced] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const payload = await requestJson(CONFIG_PATH)
          if (payload && payload.ok === false) throw new Error(payload.error || 'unknown error')
          setStatus({ phase: 'ready', data: payload, error: '' })
        } catch (error) {
          setStatus({ phase: 'error', data: null, error: String((error && error.message) || error) })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const instances = (status.data && status.data.instances) || []
      const defaultName = (status.data && status.data.defaultName) || null

      const runAction = async (key, payload, describe) => {
        setBusy(key)
        setNotice('')
        setConfirming('')
        try {
          const result = await requestJson(ACTION_PATH, payload)
          if (!result || result.ok !== true) throw new Error((result && result.error) || 'The action failed.')
          await load()
          if (describe) setNotice(describe(result))
          return result
        } catch (error) {
          setStatus((current) => ({ ...current, error: String((error && error.message) || error) }))
          return null
        } finally {
          setBusy('')
        }
      }

      const submitForm = async () => {
        if (!form) return
        const fields = form.fields
        if (!fields.url.trim() || (form.mode === 'add' && !fields.apiKey.trim())) {
          setForm({ ...form, error: t('fieldsRequired') })
          return
        }
        setForm({ ...form, error: '' })
        setBusy('form')
        try {
          const payload = {
            action: form.mode === 'add' ? 'add' : 'update',
            name: fields.name.trim() || undefined,
            url: fields.url.trim(),
            username: fields.username.trim() || 'root',
            apiPath: fields.apiPath.trim() || '/api/current',
            insecureTls: Boolean(fields.insecureTls),
            description: fields.description.trim(),
          }
          if (fields.apiKey.trim()) payload.apiKey = fields.apiKey.trim()
          const result = await requestJson(ACTION_PATH, payload)
          if (!result || result.ok !== true) throw new Error((result && result.error) || 'The system could not be verified.')
          setForm(null)
          await load()
          const base =
            form.mode === 'add'
              ? t('noticeSaved', { name: result.instance, version: result.version })
              : t('noticeUpdated', { name: result.instance, version: result.version })
          setNotice(base)
        } catch (error) {
          setForm((current) => (current ? { ...current, error: String((error && error.message) || error) } : current))
        } finally {
          setBusy('')
        }
      }

      if (view === 'summary') {
        if (status.phase === 'error') return React.createElement('p', { className: 'dtn-summary' }, t('unreachable'))
        if (status.phase !== 'ready') return React.createElement('p', { className: 'dtn-summary' }, t('loading'))
        if (!instances.length) return React.createElement('p', { className: 'dtn-summary' }, t('summary_empty'))
        const label = instances.length === 1 ? t('summary_one') : t('summary_many', { count: instances.length })
        const def = defaultName ? ` · ${t('summary_default', { name: defaultName })}` : ''
        return React.createElement('p', { className: 'dtn-summary' }, `${label}${def}`)
      }

      const openAdd = () => {
        setConfirming('')
        setNotice('')
        setShowAdvanced(false)
        setForm({ mode: 'add', fields: emptyDraft(), error: '' })
      }

      const openEdit = (entry) => {
        setConfirming('')
        setNotice('')
        setShowAdvanced(false)
        setForm({ mode: 'edit', original: entry.name, fields: draftFrom(entry), error: '' })
      }

      const header = React.createElement(
        'div',
        { className: 'dtn-head' },
        React.createElement(
          'div',
          { className: 'dtn-headText' },
          React.createElement('h3', { className: 'dtn-title' }, t('title')),
          React.createElement('p', { className: 'dtn-intro' }, t('intro')),
        ),
        form
          ? null
          : React.createElement(
              'button',
              { type: 'button', className: 'dtn-btn dtn-primary', onClick: openAdd, disabled: busy === 'form' },
              t('add'),
            ),
      )

      const errorBanner =
        status.error && status.phase !== 'error'
          ? React.createElement('p', { className: 'dtn-msg dtn-err', role: 'alert' }, status.error)
          : null
      const errorState =
        status.phase === 'error'
          ? React.createElement('p', { className: 'dtn-msg dtn-err', role: 'alert' }, `${status.error}. ${t('unreachable')}`)
          : null
      const noticeBanner = notice ? React.createElement('p', { className: 'dtn-msg dtn-ok' }, notice) : null

      const rows = instances.map((entry) => {
        const isDefault = entry.name === defaultName
        const removing = confirming === entry.name
        const testing = busy === `test:${entry.name}`
        return React.createElement(
          'li',
          { key: entry.name, className: 'dtn-row' },
          React.createElement(
            'div',
            { className: 'dtn-rowMain' },
            React.createElement('span', { className: 'dtn-name' }, entry.name),
            isDefault ? React.createElement('span', { className: 'dtn-badge dtn-badgeOn' }, t('defaultBadge')) : null,
            React.createElement(
              'span',
              { className: entry.hasApiKey ? 'dtn-badge dtn-badgeOn' : 'dtn-badge dtn-badgeWarn' },
              entry.hasApiKey ? t('keyStored') : t('keyMissing'),
            ),
            React.createElement(
              'span',
              { className: entry.insecureTls ? 'dtn-badge dtn-badgeWarn' : 'dtn-badge' },
              entry.insecureTls ? t('tlsInsecure') : t('tlsVerified'),
            ),
          ),
          React.createElement('span', { className: 'dtn-url' }, entry.url || '—'),
          React.createElement(
            'div',
            { className: 'dtn-meta' },
            React.createElement('span', null, `${entry.username || 'root'}${entry.apiPath && entry.apiPath !== '/api/current' ? ` · ${entry.apiPath}` : ''}`),
          ),
          entry.description ? React.createElement('span', { className: 'dtn-note' }, entry.description) : null,
          React.createElement(
            'div',
            { className: 'dtn-actions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dtn-btn',
                disabled: Boolean(busy) || !entry.hasApiKey,
                onClick: () =>
                  runAction(`test:${entry.name}`, { action: 'test', name: entry.name }, (result) =>
                    t('noticeTested', { name: result.instance, version: result.version }),
                  ),
              },
              testing ? t('testing') : t('test'),
            ),
            isDefault
              ? null
              : React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dtn-btn',
                    disabled: Boolean(busy),
                    onClick: () =>
                      runAction(`default:${entry.name}`, { action: 'default', name: entry.name }, (result) =>
                        t('noticeDefault', { name: result.instance }),
                      ),
                  },
                  t('makeDefault'),
                ),
            React.createElement(
              'button',
              { type: 'button', className: 'dtn-btn', disabled: Boolean(busy), onClick: () => openEdit(entry) },
              t('edit'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: removing ? 'dtn-btn dtn-danger' : 'dtn-btn dtn-danger',
                disabled: Boolean(busy) && busy !== `remove:${entry.name}`,
                onClick: () => {
                  if (!removing) {
                    setConfirming(entry.name)
                    setNotice('')
                    return
                  }
                  runAction(`remove:${entry.name}`, { action: 'remove', name: entry.name, confirm: true, forgetApiKey: true }, () =>
                    t('noticeRemoved', { name: entry.name }),
                  )
                },
              },
              removing ? t('confirmRemove') : t('remove'),
            ),
          ),
        )
      })

      const formView = form
        ? React.createElement(
            'div',
            { className: 'dtn-form' },
            React.createElement(
              'div',
              { className: 'dtn-formHead' },
              React.createElement(
                'span',
                { className: 'dtn-formTitle' },
                form.mode === 'add' ? t('addTitle') : t('editTitle', { name: form.original }),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dtn-grid' },
              React.createElement(
                Field,
                { label: t('address'), hint: t('addressHint') },
                input({
                  value: form.fields.url,
                  placeholder: 'https://nas.lab.local',
                  autoComplete: 'off',
                  onChange: (value) => setForm({ ...form, fields: { ...form.fields, url: value } }),
                }),
              ),
              React.createElement(
                Field,
                { label: t('username'), hint: t('usernameHint') },
                input({
                  value: form.fields.username,
                  placeholder: 'root',
                  onChange: (value) => setForm({ ...form, fields: { ...form.fields, username: value } }),
                }),
              ),
              React.createElement(
                Field,
                { label: t('apiKey'), hint: form.mode === 'edit' ? t('apiKeyKeep') : t('apiKeyHint') },
                input({
                  type: 'password',
                  value: form.fields.apiKey,
                  placeholder: '1-xxxxxxxxxxxxxxxx',
                  autoComplete: 'new-password',
                  onChange: (value) => setForm({ ...form, fields: { ...form.fields, apiKey: value } }),
                }),
              ),
              React.createElement(
                Field,
                { label: t('name'), hint: t('nameHint') },
                input({
                  value: form.fields.name,
                  placeholder: 'lab-nas',
                  onChange: (value) => setForm({ ...form, fields: { ...form.fields, name: value } }),
                }),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dtn-check' },
              React.createElement('input', {
                id: 'dtn-insecure',
                type: 'checkbox',
                checked: Boolean(form.fields.insecureTls),
                onChange: (event) => setForm({ ...form, fields: { ...form.fields, insecureTls: event.target.checked } }),
              }),
              React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                React.createElement(
                  'label',
                  { htmlFor: 'dtn-insecure', className: 'dtn-label' },
                  t('insecureTls'),
                ),
                React.createElement('span', { className: 'dtn-hint' }, t('insecureTlsHint')),
              ),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dtn-btn',
                onClick: () => setShowAdvanced(!showAdvanced),
                'aria-expanded': showAdvanced,
              },
              t('advanced'),
            ),
            showAdvanced
              ? React.createElement(
                  'div',
                  { className: 'dtn-grid' },
                  React.createElement(
                    Field,
                    { label: t('apiPath'), hint: t('apiPathHint') },
                    input({
                      value: form.fields.apiPath,
                      placeholder: '/api/current',
                      onChange: (value) => setForm({ ...form, fields: { ...form.fields, apiPath: value } }),
                    }),
                  ),
                  React.createElement(
                    Field,
                    { label: t('note'), hint: t('noteHint') },
                    input({
                      value: form.fields.description,
                      onChange: (value) => setForm({ ...form, fields: { ...form.fields, description: value } }),
                    }),
                  ),
                )
              : null,
            form.error ? React.createElement('p', { className: 'dtn-msg dtn-err', role: 'alert' }, form.error) : null,
            React.createElement(
              'div',
              { className: 'dtn-foot' },
              React.createElement(
                'button',
                { type: 'button', className: 'dtn-btn', disabled: busy === 'form', onClick: () => setForm(null) },
                t('cancel'),
              ),
              React.createElement(
                'button',
                { type: 'button', className: 'dtn-btn dtn-primary', disabled: busy === 'form', onClick: submitForm },
                busy === 'form' ? t('saving') : t('save'),
              ),
            ),
          )
        : null

      return React.createElement(
        'div',
        { className: 'dtn-card' },
        header,
        errorBanner,
        errorState,
        noticeBanner,
        status.phase === 'loading' ? React.createElement('p', { className: 'dtn-muted' }, t('loading')) : null,
        status.phase === 'ready' && !instances.length
          ? React.createElement('p', { className: 'dtn-empty' }, t('empty'))
          : null,
        rows.length ? React.createElement('ul', { className: 'dtn-list' }, rows) : null,
        formView,
        React.createElement('p', { className: 'dtn-muted' }, t('toolNote')),
      )
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // Keep the failure visible in the console for the DSH host logs.
        console.error('[dsh-truenas] settings page failed:', error)
      }

      render() {
        if (this.state.error) {
          return React.createElement(
            'p',
            { className: 'dtn-msg dtn-err' },
            `The TrueNAS settings page failed to render: ${String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}`,
          )
        }
        return this.props.children
      }
    }


    const PANEL_PATH = '/dsh-truenas/panel'
    const PANEL_STREAM_PATH = '/dsh-truenas/panel/stream'
    const PANEL_ACTION_PATH = '/dsh-truenas/panel/action'
    const PANEL_TAB_ID = 'dsh-truenas:panel'
    const PANEL_REFRESH_MS = 6000
    const PANEL_ARM_MS = 5000

    function PanelIcon(size) {
      const px = Number(size) || 16
      return React.createElement(
        'svg',
        { width: px, height: px, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        React.createElement('rect', { x: 3, y: 13, width: 18, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        React.createElement('circle', { cx: 7, cy: 7.5, r: 1.1, fill: 'currentColor' }),
        React.createElement('circle', { cx: 7, cy: 16.5, r: 1.1, fill: 'currentColor' }),
      )
    }

    function percentText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—'
    }

    function barClass(percent) {
      if (typeof percent !== 'number') return 'dtn-barFill'
      if (percent >= 90) return 'dtn-barFill dtn-barBad'
      if (percent >= 75) return 'dtn-barFill dtn-barWarn'
      return 'dtn-barFill'
    }

    function humanBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
      let index = 0
      let size = Math.abs(value)
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2
      return `${size.toFixed(digits)} ${units[index]}`
    }

    function PanelCard(props) {
      return React.createElement(
        'div',
        { className: 'dtn-panelCard' },
        React.createElement('span', { className: 'dtn-cardLabel' }, props.label),
        React.createElement('span', { className: 'dtn-cardValue' }, props.value),
        props.sub ? React.createElement('span', { className: 'dtn-cardSub' }, props.sub) : null,
        typeof props.percent === 'number'
          ? React.createElement(
              'div',
              { className: 'dtn-bar' },
              React.createElement('div', { className: barClass(props.percent), style: { width: `${Math.max(2, Math.min(100, props.percent))}%` } }),
            )
          : null,
      )
    }

    function PanelTab(props) {
      const ctx = props.ctx
      const h = React.createElement
      const t = makeT(useActiveLocale(ctx))
      const visible = props.visible !== false
      const [selected, setSelected] = React.useState('')
      const [view, setView] = React.useState({ phase: 'loading', data: null, error: null })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [armed, setArmed] = React.useState('')
      const armTimer = React.useRef(null)
      const inflight = React.useRef(false)

      const applyPayload = React.useCallback(
        (payload) => {
          setView({
            phase: 'ready',
            data: payload,
            error: payload && payload.ok === false ? payload.error || t('panelOffline') : null,
            stale: false,
          })
        },
        [t],
      )

      const load = React.useCallback(
        async (instance, first) => {
          // A slow NAS plus a 6 s interval must not stack requests.
          if (inflight.current && !first) return
          inflight.current = true
          if (first) setView((prev) => ({ ...prev, phase: prev.data ? 'ready' : 'loading' }))
          const query = instance ? `?instance=${encodeURIComponent(instance)}` : ''
          const attempt = () => requestJson(PANEL_PATH + query)
          try {
            let payload
            try {
              payload = await attempt()
            } catch (error) {
              // A busy browser drops requests with "Failed to fetch" /
              // ERR_INSUFFICIENT_RESOURCES; one short retry rides that out.
              await new Promise((resolve) => setTimeout(resolve, 400))
              payload = await attempt()
            }
            applyPayload(payload)
          } catch (error) {
            const reason = String((error && error.message) || error)
            const text = /fetch|network|load failed|abort/i.test(reason) ? t('panelOffline') : reason
            // Once a snapshot is on screen a failed refresh must not blank it:
            // mark it stale and let the next poll repair the view.
            setView((prev) => (prev.data ? { ...prev, phase: 'ready', stale: true } : { phase: 'error', data: null, error: text }))
          } finally {
            inflight.current = false
          }
        },
        [applyPayload, t],
      )

      React.useEffect(() => {
        if (!visible) return undefined
        const query = selected ? `?instance=${encodeURIComponent(selected)}` : ''
        let polling = null
        let stream = null

        const startPolling = () => {
          if (polling) return
          polling = setInterval(() => load(selected, false), PANEL_REFRESH_MS)
        }

        // First paint comes from the plain route; the stream then keeps it fresh
        // (job progress moves without a browser poll). If EventSource is missing
        // or the stream drops, fall back to the interval for this view.
        load(selected, true)
        if (typeof EventSource === 'function') {
          try {
            stream = new EventSource(PANEL_STREAM_PATH + query)
            stream.onopen = () => console.info('[dsh-truenas] panel stream connected')
            stream.onmessage = (event) => {
              try {
                applyPayload(JSON.parse(String(event.data)))
              } catch {
                // A malformed frame is dropped; the next one will do.
              }
            }
            stream.onerror = () => {
              console.info('[dsh-truenas] panel stream closed, falling back to polling')
              if (stream) {
                stream.close()
                stream = null
              }
              load(selected, true)
              startPolling()
            }
          } catch {
            stream = null
          }
        }
        if (!stream) startPolling()

        return () => {
          if (stream) stream.close()
          if (polling) clearInterval(polling)
        }
      }, [visible, selected, load, applyPayload])

      React.useEffect(
        () => () => {
          if (armTimer.current) clearTimeout(armTimer.current)
        },
        [],
      )

      const data = view.data
      const instances = data && Array.isArray(data.instances) ? data.instances : []
      const current = (data && data.selected) || selected || (instances[0] && instances[0].name) || ''
      const entry = instances.find((item) => item.name === current)
      const cards = (data && data.cards) || {}
      const apps = (data && Array.isArray(data.apps) ? data.apps : []).slice(0, 40)
      const pools = (data && Array.isArray(data.pools) ? data.pools : []).slice(0, 8)
      const jobs = (data && Array.isArray(data.jobs) ? data.jobs : []).slice(0, 5)
      const alerts = (data && Array.isArray(data.alerts) ? data.alerts : []).slice(0, 4)
      const services = (data && Array.isArray(data.services) ? data.services : []).slice(0, 40)
      const certificates = data && Array.isArray(data.certificates) ? data.certificates : []
      const disks = data && Array.isArray(data.disks) ? data.disks : []
      const running = apps.filter((app) => app.state === 'RUNNING').length

      async function act(action, extra) {
        const key = `${action}:${(extra && (extra.name || extra.id || extra.uuid)) || ''}`
        if (action === 'app.delete' && armed !== key) {
          setArmed(key)
          if (armTimer.current) clearTimeout(armTimer.current)
          armTimer.current = setTimeout(() => setArmed(''), PANEL_ARM_MS)
          return
        }
        setArmed('')
        setBusy(key)
        setNotice('')
        try {
          const body = { action, instance: current, ...(extra || {}) }
          const result = await requestJson(PANEL_ACTION_PATH, body)
          setNotice(result && result.ok === false ? result.error || 'Failed' : (result && result.message) || '')
          await load(selected, false)
        } catch (error) {
          setNotice(String((error && error.message) || error))
        } finally {
          setBusy('')
        }
      }

      const head = h(
        'div',
        { className: 'dtn-panelHead' },
        instances.length > 1
          ? h(
              'select',
              {
                className: 'dtn-panelSelect',
                value: current,
                'aria-label': t('panelSystem'),
                onChange: (event) => {
                  setSelected(event.target.value)
                  setNotice('')
                },
              },
              instances.map((item) => h('option', { key: item.name, value: item.name }, item.default ? `${item.name} · ${t('defaultBadge')}` : item.name)),
            )
          : h('span', { className: 'dtn-appName' }, current || t('panelSystem')),
        h('span', { className: 'dtn-panelSpacer' }),
        entry && entry.url
          ? h('a', { className: 'dtn-miniBtn', href: entry.url, target: '_blank', rel: 'noreferrer' }, t('panelOpen'))
          : null,
        h(
          'button',
          { type: 'button', className: 'dtn-miniBtn', disabled: view.phase === 'loading', onClick: () => load(selected, false) },
          t('panelRefresh'),
        ),
      )

      const status =
        data && data.ok && data.system
          ? h(
              'div',
              { className: 'dtn-panelStatus' },
              h('span', { className: `dtn-dot${alerts.length ? '' : ''}` }),
              h('span', null, data.system.hostname || ''),
              h('span', null, `TrueNAS ${data.system.version || ''}`),
              data.system.uptime ? h('span', null, t('panelUptime', { value: data.system.uptime })) : null,
              typeof data.system.load === 'number' ? h('span', null, t('panelLoad', { value: data.system.load.toFixed(2) })) : null,
              alerts.length ? h('span', { className: 'dtn-chip dtn-chipWarn' }, `${t('panelAlerts')} ${alerts.length}`) : null,
              view.stale ? h('span', { className: 'dtn-chip' }, t('panelStale')) : null,
            )
          : null

      const cardNodes =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-cards' },
              h(PanelCard, { label: t('panelCpu'), value: percentText(cards.cpu && cards.cpu.percent), percent: cards.cpu && cards.cpu.percent }),
              h(PanelCard, {
                label: t('panelMemory'),
                value: percentText(cards.memory && cards.memory.percent),
                sub:
                  cards.memory && cards.memory.used && cards.memory.total
                    ? t('panelUsedOf', { used: humanBytes(cards.memory.used), total: humanBytes(cards.memory.total) })
                    : '',
                percent: cards.memory && cards.memory.percent,
              }),
              h(PanelCard, {
                label: t('panelPool'),
                value: cards.pool ? percentText(cards.pool.percent) : '—',
                sub: cards.pool ? `${cards.pool.name} · ${cards.pool.status || ''}` : '',
                percent: cards.pool && cards.pool.percent,
              }),
              h(PanelCard, {
                label: t('panelTemp'),
                value: cards.temperature && typeof cards.temperature.celsius === 'number' ? `${Math.round(cards.temperature.celsius)}°C` : '—',
              }),
            )
          : null

      const poolSection =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-section' },
              h(
                'div',
                { className: 'dtn-sectionHead' },
                t('panelPools'),
                pools.length ? h('span', { className: 'dtn-chip' }, String(pools.length)) : null,
              ),
              pools.length === 0
                ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoPools'))
                : h(
                    'div',
                    { className: 'dtn-poolList' },
                    pools.map((pool) =>
                      h(
                        'div',
                        { className: 'dtn-poolRow', key: pool.name },
                        h(
                          'div',
                          { className: 'dtn-appMain' },
                          h('span', { className: 'dtn-appName' }, pool.name),
                          h('span', { className: 'dtn-appMeta' }, `${pool.status || ''}${pool.text ? ` · ${pool.text}` : ''}`),
                          typeof pool.percent === 'number'
                            ? h(
                                'div',
                                { className: 'dtn-bar' },
                                h('div', { className: barClass(pool.percent), style: { width: `${Math.max(2, Math.min(100, pool.percent))}%` } }),
                              )
                            : null,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dtn-miniBtn',
                            // Snapshots are cheap and reversible, so one click is
                            // enough; the dataset is the pool root.
                            disabled: busy !== '',
                            onClick: () => act('snapshot.create', { dataset: pool.name }),
                          },
                          busy.startsWith('snapshot.create') ? t('panelSnapshotBusy') : t('panelSnapshot'),
                        ),
                      ),
                    ),
                  ),
            )
          : null

      const appSection =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-section' },
              h('div', { className: 'dtn-sectionHead' }, t('panelApps'), running ? h('span', { className: 'dtn-chip dtn-chipOn' }, t('panelRuns', { count: running })) : null),
              apps.length === 0
                ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoApps'))
                : h(
                    'div',
                    { className: 'dtn-appList' },
                    apps.map((app) => {
                    const stopped = app.state === 'STOPPED' || app.state === 'CRASHED'
                    const key = app.name
                    return h(
                      'div',
                      { className: 'dtn-appRow', key },
                      h(
                        'div',
                        { className: 'dtn-appMain' },
                        h('span', { className: 'dtn-appName' }, app.name),
                        h(
                          'span',
                          { className: 'dtn-appMeta' },
                          `${app.state}${app.version ? ` · ${app.version}` : ''}${app.upgradeAvailable ? ` · ${t('panelUpdate')} ${app.latestVersion || ''}` : ''}`,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dtn-appActions' },
                        stopped
                          ? h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('app.start', { name: app.name }) }, t('panelStart'))
                          : h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('app.stop', { name: app.name }) }, t('panelStop')),
                        h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('app.restart', { name: app.name }) }, t('panelRestart')),
                        app.upgradeAvailable
                          ? h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('app.upgrade', { name: app.name }) }, t('panelUpdate'))
                          : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: `dtn-miniBtn dtn-miniBtnDanger${armed === `app.delete:${key}` ? ' dtn-miniBtnArmed' : ''}`,
                            disabled: busy === `app.delete:${key}`,
                            onClick: () => act('app.delete', { name: app.name }),
                          },
                          armed === `app.delete:${key}` ? t('panelConfirmDelete') : t('panelDelete'),
                        ),
                      ),
                    )
                  }),
                  ),
            )
          : null

      const serviceSection =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-section' },
              h(
                'div',
                { className: 'dtn-sectionHead' },
                t('panelServices'),
                services.length
                  ? h('span', { className: 'dtn-chip' }, `${services.filter((svc) => svc.running).length}/${services.length}`)
                  : null,
              ),
              services.length === 0
                ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoServices'))
                : h(
                    'div',
                    { className: 'dtn-appList dtn-serviceList' },
                    services.map((svc) =>
                      h(
                        'div',
                        { className: 'dtn-appRow', key: `${svc.id}:${svc.name}` },
                        h(
                          'div',
                          { className: 'dtn-appMain' },
                          h('span', { className: 'dtn-appName' }, svc.name),
                          h('span', { className: 'dtn-appMeta' }, `${svc.state}${svc.enabled ? ` · ${t('panelBootOn')}` : ` · ${t('panelBootOff')}`}`),
                        ),
                        h(
                          'div',
                          { className: 'dtn-appActions' },
                          svc.running
                            ? h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('service.control', { name: svc.name, verb: 'STOP' }) }, t('panelStop'))
                            : h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('service.control', { name: svc.name, verb: 'START' }) }, t('panelStart')),
                          h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('service.control', { name: svc.name, verb: 'RESTART' }) }, t('panelRestart')),
                          h(
                            'button',
                            { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('service.enable', { name: svc.name, enabled: !svc.enabled }) },
                            svc.enabled ? t('panelBootOn') : t('panelBootOff'),
                          ),
                        ),
                      ),
                    ),
                  ),
            )
          : null

      const diskSection =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-section' },
              h('div', { className: 'dtn-sectionHead' }, t('panelDisks'), disks.length ? h('span', { className: 'dtn-chip' }, String(disks.length)) : null),
              disks.length === 0
                ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoDisks'))
                : h(
                    'div',
                    { className: 'dtn-appList dtn-diskList' },
                    disks.map((disk) =>
                      h(
                        'div',
                        { className: 'dtn-appRow', key: disk.name },
                        h(
                          'div',
                          { className: 'dtn-appMain' },
                          h('span', { className: 'dtn-appName' }, disk.name),
                          h(
                            'span',
                            { className: 'dtn-appMeta' },
                            `${disk.model || ''}${disk.bus ? ` · ${disk.bus}` : ''} · ${
                              typeof disk.celsius === 'number' ? `${disk.celsius} °C` : t('panelNoTemp')
                            }`,
                          ),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('smart.test', { disk: disk.name, testType: 'SHORT' }) },
                          t('panelSelfTest'),
                        ),
                      ),
                    ),
                  ),
            )
          : null

      const certSection =
        data && data.ok
          ? h(
              'div',
              { className: 'dtn-section' },
              h(
                'div',
                { className: 'dtn-sectionHead' },
                t('panelCertificates'),
                certificates.length
                  ? h(
                      'span',
                      { className: `dtn-chip${data.expiring ? ' dtn-chipWarn' : ''}` },
                      data.expiring ? `${data.expiring}/${certificates.length}` : String(certificates.length),
                    )
                  : null,
              ),
              certificates.length === 0
                ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoCerts'))
                : h(
                    'div',
                    { className: 'dtn-appList dtn-certList' },
                    certificates.map((cert) =>
                      h(
                        'div',
                        { className: 'dtn-appRow', key: cert.id },
                        h(
                          'div',
                          { className: 'dtn-appMain' },
                          h('span', { className: 'dtn-appName' }, cert.name),
                          h(
                            'span',
                            { className: 'dtn-appMeta' },
                            `${cert.state === 'EXPIRED' ? t('panelExpired') : cert.days !== undefined ? `${cert.days}d` : ''}${cert.common ? ` · ${cert.common}` : ''}`,
                          ),
                        ),
                        cert.state !== 'valid'
                          ? h('span', { className: 'dtn-chip dtn-chipWarn' }, cert.state === 'EXPIRED' ? t('panelExpired') : t('panelRenewSoon'))
                          : null,
                      ),
                    ),
                    h('p', { className: 'dtn-panelEmpty' }, t('panelCertNote')),
                  ),
            )
          : null

      const jobSection =
        data && data.ok && jobs.length
          ? h(
              'div',
              { className: 'dtn-section' },
              h('div', { className: 'dtn-sectionHead' }, t('panelJobs')),
              jobs.map((job) =>
                h(
                  'div',
                  { className: 'dtn-appRow', key: job.id },
                  h(
                    'div',
                    { className: 'dtn-appMain' },
                    h('span', { className: 'dtn-appName' }, job.method),
                    h('span', { className: 'dtn-appMeta' }, `${job.state}${typeof job.percent === 'number' ? ` · ${Math.round(job.percent)}%` : ''}${job.description ? ` · ${job.description}` : ''}`),
                    typeof job.percent === 'number'
                      ? h('div', { className: 'dtn-bar' }, h('div', { className: barClass(job.percent), style: { width: `${Math.max(2, Math.min(100, job.percent))}%` } }))
                      : null,
                  ),
                  h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('job.abort', { id: job.id }) }, t('panelAbort')),
                ),
              ),
            )
          : null

      const alertSection =
        data && data.ok && alerts.length
          ? h(
              'div',
              { className: 'dtn-section' },
              h('div', { className: 'dtn-sectionHead' }, t('panelAlerts'), h('span', { className: 'dtn-chip dtn-chipWarn' }, String(alerts.length))),
              alerts.map((alert) =>
                h(
                  'div',
                  { className: 'dtn-alertRow', key: alert.uuid },
                  h('span', { className: 'dtn-alertText' }, `${alert.level}: ${alert.text}`),
                  h('button', { type: 'button', className: 'dtn-miniBtn', disabled: busy !== '', onClick: () => act('alert.dismiss', { uuid: alert.uuid }) }, t('panelDismiss')),
                ),
              ),
            )
          : null

      const empty =
        data && data.configured === 0
          ? h('p', { className: 'dtn-panelEmpty' }, t('panelNoSystem'))
          : data && data.ok && !data.selected
            ? h('p', { className: 'dtn-panelEmpty' }, t('panelNotReady'))
            : null

      return h(
        'div',
        { className: 'dtn-panel' },
        head,
        view.error ? h('p', { className: 'dtn-msg dtn-err', role: 'alert' }, view.error) : null,
        notice ? h('p', { className: 'dtn-msg' }, notice) : null,
        empty,
        status,
        cardNodes,
        poolSection,
        serviceSection,
        appSection,
        diskSection,
        certSection,
        jobSection,
        alertSection,
      )
    }

    function apply(ctx) {
      ensureStyle()
      const localeSvc = getService(ctx, 'locale')
      const slotsSvc = getService(ctx, 'slots')

      try {
        if (localeSvc && typeof localeSvc.register === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            try {
              localeSvc.register(NS, { en, zh })
            } catch (error) {
              console.warn('[dsh-truenas] locale already registered:', (error && error.message) || error)
            }
          }, 'dsh-truenas: locale dictionary')
        }
      } catch (error) {
        console.warn('[dsh-truenas] locale registration failed:', (error && error.message) || error)
      }

      if (slotsSvc && typeof slotsSvc.inject === 'function' && typeof slotsSvc.register === 'function') {
        // Seat 1 — Settings → TrueNAS: one settings page whose label the shell
        // renders in the settings navigation. This is the seat a person looks in
        // first, so it is the primary entry point.
        try {
          slotsSvc.inject('settings.section', () =>
            slotsSvc.register(
              {
                name: 'settings.section',
                id: ROW_ID,
                order: 40,
                label: () => makeT(activeLocale(localeSvc))('nav'),
                locale: NS,
                inject: () => ({ ctx }),
              },
              (props) => React.createElement(ErrorBoundary, null, React.createElement(TrueNasCard, { ...props, ctx, view: 'page' })),
            ),
          )
        } catch (error) {
          console.warn('[dsh-truenas] settings section unavailable:', (error && error.message) || error)
        }

        // Seat 2 — Plugins → TrueNAS manager → its row: the same page reachable
        // from the plugin that owns the configuration.
        try {
          slotsSvc.inject('plugins.row.config', () =>
            slotsSvc.register(
              {
                name: 'plugins.row.config',
                key: ROW_CONFIG_KEY,
                locale: NS,
                inject: () => ({ ctx }),
              },
              (props) => React.createElement(ErrorBoundary, null, React.createElement(TrueNasCard, { ...props, ctx })),
            ),
          )
        } catch (error) {
          console.warn('[dsh-truenas] settings seat unavailable:', (error && error.message) || error)
        }
      }

      // Right-sidebar panel. Better Sidebar is an optional companion plugin whose
      // client service may be registered after ours loads, so wait for it briefly
      // instead of giving up on the first lookup; the settings page keeps working
      // either way.
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          let stopped = false
          let registered = false
          let timer = null
          let dispose = null
          const startedAt = Date.now()

          const attempt = () => {
            if (stopped || registered) return
            const service = getService(ctx, 'betterSidebar')
            if (service && typeof service.registerTab === 'function') {
              try {
                dispose = service.registerTab({
                  id: PANEL_TAB_ID,
                  order: 45,
                  single: true,
                  title: () => makeT(activeLocale(localeSvc))('panelTitle'),
                  description: () => makeT(activeLocale(localeSvc))('panelDesc'),
                  icon: (size) => PanelIcon(size),
                  component: (tabProps) => React.createElement(ErrorBoundary, null, React.createElement(PanelTab, { ...tabProps, ctx })),
                })
                registered = true
                return
              } catch (error) {
                console.warn('[dsh-truenas] sidebar panel unavailable:', (error && error.message) || error)
              }
            }
            if (Date.now() - startedAt > 20000) {
              console.warn('[dsh-truenas] sidebar panel unavailable: betterSidebar service did not appear')
              return
            }
            timer = setTimeout(attempt, 300)
          }

          attempt()

          return () => {
            stopped = true
            if (timer) clearTimeout(timer)
            if (typeof dispose === 'function') dispose()
            else if (dispose && typeof dispose.dispose === 'function') dispose.dispose()
          }
        }, 'dsh-truenas: sidebar panel')
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
