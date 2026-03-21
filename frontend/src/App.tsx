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

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5174'

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
    const [dash, usr] = await Promise.all([fetch(`${API_BASE}/api/dashboard`), fetch(`${API_BASE}/api/users`)])
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

  async function createUser(e: FormEvent) {
    e.preventDefault()
    if (!newUserName.trim()) return
    const durationSeconds = newUserDays * 86400 + newUserHours * 3600 + newUserMinutes * 60 + newUserSeconds
    await fetch(`${API_BASE}/api/users`, {
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
    await fetch(`${API_BASE}/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    await loadAll()
  }
  async function rotateUser(id: string) { await fetch(`${API_BASE}/api/users/${id}/rotate`, { method: 'POST' }); await loadAll() }
  async function deleteUser(id: string) { await fetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' }); await loadAll() }
  async function syncUsers() { await fetch(`${API_BASE}/api/users/sync`, { method: 'POST' }); await loadAll() }

  async function generateRealityKeys() {
    const r = await fetch(`${API_BASE}/api/keys/reality`, { method: 'POST' })
    if (!r.ok) return
    const payload = (await r.json()) as { privateKey: string; publicKey: string }
    setRealityKeys(payload)
    setPublicKeyInput(payload.publicKey)
  }

  async function savePublicKey() {
    if (!publicKeyInput.trim()) return
    await fetch(`${API_BASE}/api/settings/public-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: publicKeyInput.trim() }) })
    await loadAll()
  }

  async function generateCommonLink() {
    const r = await fetch(`${API_BASE}/api/keys/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `PearVPN-${Date.now()}` }) })
    const payload = (await r.json()) as { link?: string; error?: string }
    setCommonLink(payload.link ?? payload.error ?? '')
  }

  if (loading) return <main className="shell">{t.loading}</main>
  if (error || !dashboard) return <main className="shell">{error ?? t.err}</main>

  return (
    <main className="shell">
      <div className="grid-fade" />
      <header className="topbar">
        <div className="brand"><h1>{dashboard.brand.name}</h1><p>{dashboard.brand.subtitle}</p></div>
        <nav className="tabs">
          <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>{t.tabs.dashboard}</button>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>{t.tabs.users}</button>
          <button className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>{t.tabs.keys}</button>
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>{t.tabs.logs}</button>
          <button onClick={() => setLang((v) => (v === 'ru' ? 'en' : 'ru'))}>{lang === 'ru' ? 'EN' : 'RU'}</button>
        </nav>
      </header>

      {tab === 'dashboard' && (
        <section className="cards">
          <article className="card hero">
            <h2>{dashboard.vpn.address}:{dashboard.vpn.port}</h2>
            <p>{dashboard.vpn.label} | SNI: {dashboard.vpn.sni}</p>
            <div className="stats">
              <div><span>{t.activeUsers}</span><strong>{dashboard.vpn.activeUsers}</strong></div>
              <div><span>{t.cpu}</span><strong>{dashboard.system.cpuLoad}</strong></div>
              <div><span>{t.ram}</span><strong>{dashboard.system.memoryUsedGb}/{dashboard.system.memoryTotalGb} GB</strong></div>
            </div>
          </article>
          <article className="card">
            <h3>{t.quick}</h3>
            <button onClick={syncUsers}>{t.sync}</button>
            <button onClick={generateCommonLink}>{t.genCommonLink}</button>
            {commonLink && <code>{commonLink}</code>}
          </article>
          <article className="card"><h3>System</h3><p>{dashboard.system.hostname}</p><p>{dashboard.system.platform}</p><p>Uptime: {dashboard.system.uptimeHours}h</p></article>
          <article className="card"><h3>Deploy</h3><p>{dashboard.deployment.packageManager}</p><p>{dashboard.deployment.nodeVersion}</p><p>{dashboard.deployment.xrayConfigPath}</p><p>{dashboard.deployment.dbPath}</p></article>
        </section>
      )}

      {tab === 'keys' && (
        <section className="cards single">
          <article className="card">
            <h3>Reality / VLESS</h3>
            <p>Public key source: {dashboard.vpn.publicKeySource ?? 'unknown'}</p>
            <input value={publicKeyInput} onChange={(e) => setPublicKeyInput(e.target.value)} placeholder="public key" />
            <div className="actions-row">
              <button onClick={savePublicKey}>{t.savePk}</button>
              <button onClick={generateRealityKeys}>{t.genReality}</button>
              <button onClick={generateCommonLink}>{t.genCommonLink}</button>
            </div>
            {realityKeys && (<><p>Private:</p><code>{realityKeys.privateKey}</code><p>Public:</p><code>{realityKeys.publicKey}</code></>)}
            {commonLink && <><p>{t.link}:</p><code>{commonLink}</code></>}
          </article>
        </section>
      )}

      {tab === 'users' && (
        <section className="card">
          <h3>{t.usersTitle}</h3>
          <div className="subs-grid">
            {users.map((u) => {
              const used = u.usedTrafficGb ?? 0
              const limit = u.trafficLimitGb ?? 0
              const ratio = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
              return (
                <article key={`sub-${u.id}`} className="sub-card">
                  <div className="sub-head">
                    <strong>{u.tgFullName || u.username}</strong>
                    <span>{u.status}</span>
                  </div>
                  <p className="sub-meta">
                    @{(u.tgUsername || '').replace('@', '') || 'no_username'} • Активен до {dateOut(u.expiresAt)}
                  </p>
                  <div className="traffic-line">
                    <div className="traffic-fill" style={{ width: `${ratio}%` }} />
                  </div>
                  <p className="sub-meta">
                    {used}/{limit || '∞'} GB • устройств: {u.deviceLimit ?? 1}
                  </p>
                  <code>{u.link || 'Ссылка появится после настройки ключа'}</code>
                  {u.subscriptionUrl && <code>{u.subscriptionUrl}</code>}
                </article>
              )
            })}
          </div>
          <form className="create" onSubmit={createUser}>
            <input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder="Логин VPN" />
            <input value={newUserTgId} onChange={(e) => setNewUserTgId(e.target.value)} placeholder="Telegram ID" />
            <input value={newUserTgName} onChange={(e) => setNewUserTgName(e.target.value)} placeholder="@username" />
            <input value={newUserTgFullName} onChange={(e) => setNewUserTgFullName(e.target.value)} placeholder="Имя в Telegram" />
            <input type="number" value={newUserDays} onChange={(e) => setNewUserDays(Number(e.target.value))} min={0} placeholder="Дней" />
            <input type="number" value={newUserHours} onChange={(e) => setNewUserHours(Number(e.target.value))} min={0} placeholder="Часов" />
            <input type="number" value={newUserMinutes} onChange={(e) => setNewUserMinutes(Number(e.target.value))} min={0} placeholder="Минут" />
            <input type="number" value={newUserSeconds} onChange={(e) => setNewUserSeconds(Number(e.target.value))} min={0} placeholder="Секунд" />
            <input type="number" value={newUserTraffic} onChange={(e) => setNewUserTraffic(Number(e.target.value))} min={1} placeholder="Трафик (GB)" />
            <input type="number" value={newUserDevices} onChange={(e) => setNewUserDevices(Number(e.target.value))} min={1} placeholder="Устройств" />
            <input value={newUserNote} onChange={(e) => setNewUserNote(e.target.value)} placeholder={t.note} />
            <button type="submit">{t.create}</button>
          </form>
          <p>
            Подсказка по числам: <b>Telegram ID</b> — числовой ID пользователя в Telegram; <b>Дней/Часов/Минут/Секунд</b> — срок действия доступа; <b>Трафик (GB)</b> — лимит трафика в гигабайтах; <b>Устройств</b> — максимум одновременных устройств.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Telegram</th>
                  <th>{t.username}</th>
                  <th>{t.status}</th>
                  <th>{t.expires}</th>
                  <th>Трафик</th>
                  <th>Устройства</th>
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
                    <td>{u.status}</td>
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
        <section className="cards">
          {dashboard.logs.map((l) => (<article className="card" key={l.name}><h3>{l.name}</h3><p>{l.path}</p><pre>{l.preview.join('\n')}</pre></article>))}
        </section>
      )}
    </main>
  )
}

export default App
