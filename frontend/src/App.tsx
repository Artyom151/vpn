import { FormEvent, useEffect, useState } from 'react'

type Lang = 'ru' | 'en'
type UserStatus = 'active' | 'paused' | 'expired'
type TabKey = 'dashboard' | 'users' | 'keys' | 'logs'

type DashboardData = {
  brand: { name: string; subtitle: string }
  deployment: { packageManager: string; nodeVersion: string; publicIp: string; xrayConfigPath: string; dbPath: string }
  vpn: { label: string; address: string; port: number; sni: string; shortId: string; publicKey: string | null; publicKeySource?: string; activeUsers: number }
  system: { hostname: string; platform: string; uptimeHours: number; memoryUsedGb: number; memoryTotalGb: number; cpuLoad: number }
  logs: Array<{ name: string; path: string; preview: string[] }>
}

type VpnUser = {
  id: string
  username: string
  tgUserId?: number | null
  tgUsername?: string | null
  tgFullName?: string | null
  uuid: string
  flow: string
  status: UserStatus
  createdAt: string
  expiresAt: string
  trafficLimitGb?: number | null
  usedTrafficGb?: number
  deviceLimit?: number
  note: string
  link?: string | null
  subscriptionUrl?: string | null
}

const API_BASE_RAW = import.meta.env.VITE_API_URL ?? 'http://localhost:5174'
const API_BASE_NORMALIZED = API_BASE_RAW.replace(/\/+$/, '')
const API_BASE = API_BASE_NORMALIZED.endsWith('/api') ? API_BASE_NORMALIZED : `${API_BASE_NORMALIZED}/api`
const api = (path: string) => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`

const text = {
  ru: {
    tabs: { dashboard: 'Панель', users: 'Пользователи', keys: 'Ключи', logs: 'Логи' },
    loading: 'Загрузка...',
    err: 'Ошибка загрузки API',
    quick: 'Быстрые действия',
    sync: 'Синхронизировать с Xray',
    create: 'Создать пользователя',
    genReality: 'Сгенерировать Reality ключи',
    savePk: 'Сохранить public key',
    genCommonLink: 'Сгенерировать общий vless://',
    activeUsers: 'Активные пользователи',
    cpu: 'Нагрузка CPU',
    ram: 'RAM',
    usersTitle: 'Таблица пользователей',
    username: 'Имя',
    status: 'Статус',
    uuid: 'UUID',
    expires: 'Истекает',
    note: 'Заметка',
    actions: 'Действия',
    link: 'Ссылка',
    pause: 'Пауза',
    resume: 'Возобновить',
    rotate: 'Новый UUID',
    extend: '+30 дней',
    delete: 'Удалить',
    getLink: 'vless://',
    uptime: 'Аптайм',
    source: 'Источник public key',
    privateKey: 'Приватный ключ',
    publicKey: 'Публичный ключ',
    activeUntil: 'Активен до',
    noUsername: 'нет_username',
    vpnLogin: 'Логин VPN',
    tgId: 'Telegram ID',
    tgUser: '@username',
    tgName: 'Имя в Telegram',
    days: 'Дней',
    hours: 'Часов',
    minutes: 'Минут',
    seconds: 'Секунд',
    trafficGb: 'Трафик (GB)',
    devices: 'Устройств',
    usersHint: 'Подсказка по числам: Telegram ID — числовой ID пользователя в Telegram; Дней/Часов/Минут/Секунд — срок действия доступа; Трафик (GB) — лимит трафика в гигабайтах; Устройств — максимум одновременных устройств.',
    tgCol: 'Telegram',
    traffic: 'Трафик',
    devicesCol: 'Устройства',
    userNotConfigured: 'Ссылка появится после настройки ключа',
    statusActive: 'активен',
    statusPaused: 'пауза',
    statusExpired: 'истёк',
  },
  en: {
    tabs: { dashboard: 'Dashboard', users: 'Users', keys: 'Keys', logs: 'Logs' },
    loading: 'Loading...',
    err: 'API load failed',
    quick: 'Quick actions',
    sync: 'Sync with Xray',
    create: 'Create user',
    genReality: 'Generate Reality keys',
    savePk: 'Save public key',
    genCommonLink: 'Generate shared vless://',
    activeUsers: 'Active users',
    cpu: 'CPU load',
    ram: 'RAM',
    usersTitle: 'Users table',
    username: 'Username',
    status: 'Status',
    uuid: 'UUID',
    expires: 'Expires',
    note: 'Note',
    actions: 'Actions',
    link: 'Link',
    pause: 'Pause',
    resume: 'Resume',
    rotate: 'Rotate UUID',
    extend: '+30 days',
    delete: 'Delete',
    getLink: 'vless://',
    uptime: 'Uptime',
    source: 'Public key source',
    privateKey: 'Private key',
    publicKey: 'Public key',
    activeUntil: 'Active until',
    noUsername: 'no_username',
    vpnLogin: 'VPN login',
    tgId: 'Telegram ID',
    tgUser: '@username',
    tgName: 'Telegram name',
    days: 'Days',
    hours: 'Hours',
    minutes: 'Minutes',
    seconds: 'Seconds',
    trafficGb: 'Traffic (GB)',
    devices: 'Devices',
    usersHint: 'Field hints: Telegram ID is numeric Telegram user id; Days/Hours/Minutes/Seconds define access duration; Traffic (GB) is traffic quota; Devices is max simultaneous devices.',
    tgCol: 'Telegram',
    traffic: 'Traffic',
    devicesCol: 'Devices',
    userNotConfigured: 'Link will appear after key setup',
    statusActive: 'active',
    statusPaused: 'paused',
    statusExpired: 'expired',
  },
} as const

function App() {
  const [lang, setLang] = useState<Lang>('ru')
  const t = text[lang]
  const [tab, setTab] = useState<TabKey>('dashboard')
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [users, setUsers] = useState<VpnUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [newUserName, setNewUserName] = useState('')
  const [newUserTgId, setNewUserTgId] = useState('')
  const [newUserTgName, setNewUserTgName] = useState('')
  const [newUserTgFullName, setNewUserTgFullName] = useState('')
  const [newUserDays, setNewUserDays] = useState(0)
  const [newUserHours, setNewUserHours] = useState(1)
  const [newUserMinutes, setNewUserMinutes] = useState(0)
  const [newUserSeconds, setNewUserSeconds] = useState(0)
  const [newUserTraffic, setNewUserTraffic] = useState(100)
  const [newUserDevices, setNewUserDevices] = useState(1)
  const [newUserNote, setNewUserNote] = useState('')
  const [publicKeyInput, setPublicKeyInput] = useState('')
  const [realityKeys, setRealityKeys] = useState<{ privateKey: string; publicKey: string } | null>(null)
  const [commonLink, setCommonLink] = useState('')

  async function loadAll() {
    const [dash, usr] = await Promise.all([fetch(api('/dashboard')), fetch(api('/users'))])
    if (!dash.ok || !usr.ok) throw new Error('api')
    const d = (await dash.json()) as DashboardData
    const u = (await usr.json()) as { users: VpnUser[] }
    setDashboard(d)
    setUsers(u.users)
    setPublicKeyInput((prev) => prev || d.vpn.publicKey || '')
  }

  useEffect(() => {
    let active = true
    ;(async () => {
      try { await loadAll() } catch { if (active) setError(t.err) } finally { if (active) setLoading(false) }
    })()
    const timer = setInterval(() => { void loadAll() }, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  function dateOut(value: string) {
    return new Date(value).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')
  }

  function statusOut(status: UserStatus) {
    if (status === 'active') return t.statusActive
    if (status === 'paused') return t.statusPaused
    return t.statusExpired
  }

  async function createUser(e: FormEvent) {
    e.preventDefault()
    if (!newUserName.trim()) return
    const durationSeconds = newUserDays * 86400 + newUserHours * 3600 + newUserMinutes * 60 + newUserSeconds
    await fetch(api('/users'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newUserName,
        tgUserId: newUserTgId ? Number(newUserTgId) : null,
        tgUsername: newUserTgName || null,
        tgFullName: newUserTgFullName || null,
        durationSeconds: Math.max(durationSeconds, 60),
        trafficLimitGb: newUserTraffic,
        deviceLimit: newUserDevices,
        note: newUserNote,
      }),
    })
    setNewUserName('')
    setNewUserTgId('')
    setNewUserTgName('')
    setNewUserTgFullName('')
    setNewUserNote('')
    await loadAll()
  }

  async function patchUser(id: string, payload: Record<string, unknown>) {
    await fetch(api(`/users/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    await loadAll()
  }
  async function rotateUser(id: string) { await fetch(api(`/users/${id}/rotate`), { method: 'POST' }); await loadAll() }
  async function deleteUser(id: string) { await fetch(api(`/users/${id}`), { method: 'DELETE' }); await loadAll() }
  async function syncUsers() { await fetch(api('/users/sync'), { method: 'POST' }); await loadAll() }

  async function generateRealityKeys() {
    const r = await fetch(api('/keys/reality'), { method: 'POST' })
    if (!r.ok) return
    const payload = (await r.json()) as { privateKey: string; publicKey: string }
    setRealityKeys(payload)
    setPublicKeyInput(payload.publicKey)
  }

  async function savePublicKey() {
    if (!publicKeyInput.trim()) return
    await fetch(api('/settings/public-key'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: publicKeyInput.trim() }) })
    await loadAll()
  }

  async function generateCommonLink() {
    const r = await fetch(api('/keys/client'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `PearVPN-${Date.now()}` }) })
    const payload = (await r.json()) as { link?: string; error?: string }
    setCommonLink(payload.link ?? payload.error ?? '')
  }

  if (loading) return <main className="shell">{t.loading}</main>
  if (error || !dashboard) return <main className="shell">{error ?? t.err}</main>

  return (
    <main className="shell">
      <div className="grid-fade" />
      <header className="topbar topbar-copy">
        <div className="brand brand-copy">
          <span className="brand-mark">|||</span>
          <h1>{dashboard.brand.name}</h1>
        </div>
        <nav className="top-links">
          <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>{t.tabs.dashboard}</button>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>{t.tabs.users}</button>
          <button className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>{t.tabs.keys}</button>
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>{t.tabs.logs}</button>
        </nav>
        <button className="try-btn" onClick={() => setLang((v) => (v === 'ru' ? 'en' : 'ru'))}>{lang === 'ru' ? 'EN' : 'RU'}</button>
      </header>

      {tab === 'dashboard' && (
        <section className="dashboard-copy">
          <article className="hero-copy">
            <h2>
              Pear<span>VPN</span>
            </h2>
            <h3>Proxy and user management solution</h3>
            <p>Built on top of Xray Core. Fast user lifecycle, keys and subscriptions in one panel.</p>
            <div className="hero-actions hero-copy-actions">
              <button onClick={syncUsers}>{t.sync}</button>
              <button onClick={generateCommonLink}>{t.genCommonLink}</button>
            </div>
            <div className="stats stats-copy">
              <div><span>{t.activeUsers}</span><strong>{dashboard.vpn.activeUsers}</strong></div>
              <div><span>{t.cpu}</span><strong>{dashboard.system.cpuLoad}</strong></div>
              <div><span>{t.ram}</span><strong>{dashboard.system.memoryUsedGb}/{dashboard.system.memoryTotalGb} GB</strong></div>
            </div>
            {commonLink && <code>{commonLink}</code>}
          </article>

          <article className="preview-copy">
            <div className="preview-top">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-grid">
              <div className="mini-card">Host: {dashboard.system.hostname}</div>
              <div className="mini-card">OS: {dashboard.system.platform}</div>
              <div className="mini-card">{t.uptime}: {dashboard.system.uptimeHours}h</div>
              <div className="mini-card">Node: {dashboard.deployment.nodeVersion}</div>
            </div>
          </article>
        </section>
      )}

      {tab === 'keys' && (
        <section className="cards single keys-section">
          <article className="card keys-card">
            <h3>Reality / VLESS</h3>
            <p>{t.source}: {dashboard.vpn.publicKeySource ?? 'unknown'}</p>
            <input value={publicKeyInput} onChange={(e) => setPublicKeyInput(e.target.value)} placeholder="public key" />
            <div className="actions-row">
              <button onClick={savePublicKey}>{t.savePk}</button>
              <button onClick={generateRealityKeys}>{t.genReality}</button>
              <button onClick={generateCommonLink}>{t.genCommonLink}</button>
            </div>
            {realityKeys && (<><p>{t.privateKey}:</p><code>{realityKeys.privateKey}</code><p>{t.publicKey}:</p><code>{realityKeys.publicKey}</code></>)}
            {commonLink && <><p>{t.link}:</p><code>{commonLink}</code></>}
          </article>
        </section>
      )}

      {tab === 'users' && (
        <section className="card users-section">
          <h3>{t.usersTitle}</h3>
          <div className="subs-grid">
            {users.map((u) => {
              const used = u.usedTrafficGb ?? 0
              const limit = u.trafficLimitGb ?? 0
              const ratio = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
              return (
                <article key={`sub-${u.id}`} className="sub-card user-sub-card">
                  <div className="sub-head">
                    <strong>{u.tgFullName || u.username}</strong>
                    <span className={`status-pill status-${u.status}`}>{statusOut(u.status)}</span>
                  </div>
                  <p className="sub-meta">
                    @{(u.tgUsername || '').replace('@', '') || t.noUsername} • {t.activeUntil} {dateOut(u.expiresAt)}
                  </p>
                  <div className="traffic-line">
                    <div className="traffic-fill" style={{ width: `${ratio}%` }} />
                  </div>
                  <p className="sub-meta">
                    {used}/{limit || '∞'} GB • {t.devices}: {u.deviceLimit ?? 1}
                  </p>
                  <code>{u.link || t.userNotConfigured}</code>
                  {u.subscriptionUrl && <code>{u.subscriptionUrl}</code>}
                </article>
              )
            })}
          </div>
          <form className="create users-create-form" onSubmit={createUser}>
            <input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder={t.vpnLogin} />
            <input value={newUserTgId} onChange={(e) => setNewUserTgId(e.target.value)} placeholder={t.tgId} />
            <input value={newUserTgName} onChange={(e) => setNewUserTgName(e.target.value)} placeholder={t.tgUser} />
            <input value={newUserTgFullName} onChange={(e) => setNewUserTgFullName(e.target.value)} placeholder={t.tgName} />
            <input type="number" value={newUserDays} onChange={(e) => setNewUserDays(Number(e.target.value))} min={0} placeholder={t.days} />
            <input type="number" value={newUserHours} onChange={(e) => setNewUserHours(Number(e.target.value))} min={0} placeholder={t.hours} />
            <input type="number" value={newUserMinutes} onChange={(e) => setNewUserMinutes(Number(e.target.value))} min={0} placeholder={t.minutes} />
            <input type="number" value={newUserSeconds} onChange={(e) => setNewUserSeconds(Number(e.target.value))} min={0} placeholder={t.seconds} />
            <input type="number" value={newUserTraffic} onChange={(e) => setNewUserTraffic(Number(e.target.value))} min={1} placeholder={t.trafficGb} />
            <input type="number" value={newUserDevices} onChange={(e) => setNewUserDevices(Number(e.target.value))} min={1} placeholder={t.devices} />
            <input value={newUserNote} onChange={(e) => setNewUserNote(e.target.value)} placeholder={t.note} />
            <button type="submit">{t.create}</button>
          </form>
          <p className="users-hint">
            {t.usersHint}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t.tgCol}</th>
                  <th>{t.username}</th>
                  <th>{t.status}</th>
                  <th>{t.expires}</th>
                  <th>{t.traffic}</th>
                  <th>{t.devicesCol}</th>
                  <th>{t.uuid}</th>
                  <th>{t.note}</th>
                  <th>{t.actions}</th>
                  <th>{t.link}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div>{u.tgFullName || '-'}</div>
                      <div>{u.tgUsername ? `@${u.tgUsername.replace('@', '')}` : '-'}</div>
                      <div className="mono">{u.tgUserId ?? '-'}</div>
                    </td>
                    <td>{u.username}</td>
                    <td>{statusOut(u.status)}</td>
                    <td>{dateOut(u.expiresAt)}</td>
                    <td>{u.usedTrafficGb ?? 0}/{u.trafficLimitGb ?? '∞'} GB</td>
                    <td>{u.deviceLimit ?? 1}</td>
                    <td className="mono">{u.uuid}</td>
                    <td>{u.note || '-'}</td>
                    <td className="act">
                      <button onClick={() => patchUser(u.id, { status: u.status === 'paused' ? 'active' : 'paused' })}>{u.status === 'paused' ? t.resume : t.pause}</button>
                      <button onClick={() => rotateUser(u.id)}>{t.rotate}</button>
                      <button onClick={() => patchUser(u.id, { days: 30 })}>{t.extend}</button>
                      <button onClick={() => patchUser(u.id, { trafficLimitGb: (u.trafficLimitGb ?? 0) + 50 })}>+50GB</button>
                      <button onClick={() => patchUser(u.id, { deviceLimit: (u.deviceLimit ?? 1) + 1 })}>+1 device</button>
                      <button onClick={() => deleteUser(u.id)}>{t.delete}</button>
                    </td>
                    <td className="mono">{u.subscriptionUrl || u.link || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'logs' && (
        <section className="cards logs-section">
          {dashboard.logs.map((l) => (
            <article className="card log-card" key={l.name}>
              <h3>{l.name}</h3>
              <p>{l.path}</p>
              <pre>{l.preview.join('\n')}</pre>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}

export default App
