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
      addressHint: 'Web UI address, for example https://nas.lab.local or 192.168.1.10.',
      username: 'Username',
      usernameHint: 'The TrueNAS user that owns the API key.',
      apiKey: 'API key',
      apiKeyHint: 'Create one in TrueNAS under Credentials → API Keys.',
      apiKeyKeep: 'Leave blank to keep the stored key.',
      insecureTls: 'Skip TLS certificate verification',
      insecureTlsHint: 'Only for a self-signed NAS certificate on your own network.',
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
      addressHint: 'Web 界面地址，例如 https://nas.lab.local 或 192.168.1.10。',
      username: '用户名',
      usernameHint: '拥有该 API 密钥的 TrueNAS 用户。',
      apiKey: 'API 密钥',
      apiKeyHint: '在 TrueNAS 的「凭据 → API 密钥」中创建。',
      apiKeyKeep: '留空则沿用已保存的密钥。',
      insecureTls: '跳过 TLS 证书校验',
      insecureTlsHint: '仅用于自己网络中使用自签名证书的 NAS。',
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

    function makeT(locale) {
      const dict = String(locale || '').startsWith('zh') ? zh : en
      return (key, vars) => {
        let text = dict[key] || en[key] || key
        if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value ?? ''))
        return text
      }
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
          setNotice(
            form.mode === 'add'
              ? t('noticeSaved', { name: result.instance, version: result.version })
              : t('noticeUpdated', { name: result.instance, version: result.version }),
          )
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
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
