import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

type ServiceStatus = 'online' | 'offline' | 'degraded'
type UserStatus = 'active' | 'paused' | 'expired'

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
  subToken?: string
  note: string
}

type UserDatabase = {
  users: VpnUser[]
}

const app = express()
const PORT = Number(process.env.PORT ?? 5174)
const HOST = process.env.HOST ?? '0.0.0.0'
const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH ?? '/usr/local/etc/xray/config.json'
const XRAY_API_SERVER = process.env.XRAY_API_SERVER ?? '127.0.0.1:10085'
const LOG_DIR = process.env.NODE_LOG_DIR ?? '/var/log/remaware'
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'users.json')
const SETTINGS_PATH = process.env.SETTINGS_PATH ?? path.join(process.cwd(), 'data', 'settings.json')
function normalizeSubBaseUrl(raw: string | undefined, fallbackPort: number): string {
  const source = (raw ?? '').trim()
  const publicIp = (process.env.PUBLIC_IP ?? '').trim()
  let value = source || 'https://sub.pearvpn.ru'
  if (!source && publicIp && !process.env.FORCE_DOMAIN_SUB_URL) {
    value = `http://${publicIp}:${fallbackPort}`
  }
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    value = `http://${value}`
  }
  value = value.replace(/\/:([0-9]+)/g, ':$1')
  if (publicIp) {
    value = value
      .replace('http://localhost:', `http://${publicIp}:`)
      .replace('https://localhost:', `https://${publicIp}:`)
      .replace('http://127.0.0.1:', `http://${publicIp}:`)
      .replace('https://127.0.0.1:', `https://${publicIp}:`)
  }
  try {
    const url = new URL(value)
    // Force human/public URL without backend dev port, since subscription is proxied via nginx :80/:443.
    if (url.port === '5174') {
      url.port = ''
    }
    if (url.port === '80' || url.port === '443') {
      url.port = ''
    }
    value = url.toString()
  } catch {
    // keep original when URL parser fails
  }
  value = value.replace(/\/+$/, '')
  return value
}
const SUB_BASE_URL = normalizeSubBaseUrl(process.env.SUB_BASE_URL, PORT)

function buildSubscriptionUrl(token: string): string {
  return `${SUB_BASE_URL}/sub/${token}`
}

app.use(cors())
app.use(express.json())

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function safeJson<T>(filePath: string): T | null {
  const raw = safeRead(filePath)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function ensureDb(): void {
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(DB_PATH)) {
    const seed: UserDatabase = { users: [] }
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2))
  }
}

function readDb(): UserDatabase {
  ensureDb()
  return safeJson<UserDatabase>(DB_PATH) ?? { users: [] }
}

function writeDb(db: UserDatabase): void {
  ensureDb()
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2))
}

function ensureSettings(): void {
  const dir = path.dirname(SETTINGS_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(SETTINGS_PATH)) fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ publicKey: null }, null, 2))
}

function readSettings(): { publicKey: string | null } {
  ensureSettings()
  return safeJson<{ publicKey: string | null }>(SETTINGS_PATH) ?? { publicKey: null }
}

function writeSettings(settings: { publicKey: string | null }): void {
  ensureSettings()
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
}

function detectPackageManager(): string {
  const osRelease = safeRead('/etc/os-release')
  if (!osRelease) return 'unknown'
  const id = osRelease
    .split('\n')
    .find((line) => line.startsWith('ID='))?.replace('ID=', '')
    .replace(/"/g, '')
  const map: Record<string, string> = {
    debian: 'apt',
    ubuntu: 'apt',
    pop: 'apt',
    linuxmint: 'apt',
    fedora: 'dnf',
    rhel: 'yum',
    centos: 'yum',
    arch: 'pacman',
    manjaro: 'pacman',
    suse: 'zypper',
    'opensuse-leap': 'zypper',
    'opensuse-tumbleweed': 'zypper',
    alpine: 'apk',
  }
  return map[id ?? ''] ?? (id ?? 'unknown')
}

function tailLog(logPath: string, maxLines = 8): string[] {
  const contents = safeRead(logPath)
  if (!contents) return ['Log is not available']
  return contents.trim().split('\n').slice(-maxLines)
}

function getPrimaryAddress(): string | null {
  const entries = Object.values(os.networkInterfaces()).flatMap((value) => value ?? [])
  const external = entries.find((entry) => entry.family === 'IPv4' && !entry.internal)
  return external?.address ?? null
}

function loadXray(): any | null {
  return safeJson<any>(XRAY_CONFIG_PATH)
}

function saveXray(config: any): boolean {
  try {
    fs.writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2))
    return true
  } catch {
    return false
  }
}

function computeUserStatus(user: VpnUser): UserStatus {
  if (user.status === 'paused') return 'paused'
  if (new Date(user.expiresAt).getTime() < Date.now()) return 'expired'
  return 'active'
}

function normalizeUser(user: VpnUser): VpnUser {
  return {
    ...user,
    tgUserId: user.tgUserId ?? null,
    tgUsername: user.tgUsername ?? null,
    tgFullName: user.tgFullName ?? null,
    trafficLimitGb: user.trafficLimitGb ?? null,
    usedTrafficGb: user.usedTrafficGb ?? 0,
    deviceLimit: user.deviceLimit ?? 1,
    subToken: user.subToken ?? randomBytes(16).toString('hex'),
  }
}

function parseExpiresAt(body: any): string {
  if (typeof body?.expiresAt === 'string' && body.expiresAt.trim()) {
    const date = new Date(body.expiresAt)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof body?.durationSeconds === 'number' && body.durationSeconds > 0) {
    return new Date(Date.now() + body.durationSeconds * 1000).toISOString()
  }
  const days = Number(body?.days ?? 30)
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function buildUserLink(user: VpnUser): string | null {
  const xrayConfig = loadXray()
  const inbound = xrayConfig?.inbounds?.find((item: any) => item?.protocol === 'vless')
  const reality = inbound?.streamSettings?.realitySettings
  const publicKey = resolvePublicKey().value
  if (!publicKey) return null
  return makeClientLink({
    uuid: user.uuid,
    ip: process.env.PUBLIC_IP ?? getPrimaryAddress() ?? '0.0.0.0',
    port: Number(inbound?.port ?? 443),
    flow: user.flow,
    sni: reality?.serverNames?.[0] ?? 'www.microsoft.com',
    pbk: publicKey,
    sid: reality?.shortIds?.[0] ?? randomBytes(8).toString('hex'),
    name: `Pear VPN | ${user.username}`,
  })
}

function parseRealityKeys(): { privateKey: string | null; publicKey: string | null } {
  const run = spawnSync('xray', ['x25519'], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const privateKey = output.match(/PrivateKey:\s*([^\s]+)/)?.[1] ?? null
  const publicKey =
    output.match(/PublicKey:\s*([^\s]+)/)?.[1] ?? output.match(/Password:\s*([^\s]+)/)?.[1] ?? null
  return { privateKey, publicKey }
}

function derivePublicKeyFromPrivate(privateKey: string): string | null {
  const run = spawnSync('xray', ['x25519', '-i', privateKey], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  return output.match(/PublicKey:\s*([^\s]+)/)?.[1] ?? output.match(/Password:\s*([^\s]+)/)?.[1] ?? null
}

function resolvePublicKey(): { value: string | null; source: string } {
  const settings = readSettings()
  if (settings.publicKey) return { value: settings.publicKey, source: 'settings.json' }

  const fileCandidates = [
    '/usr/local/etc/xray/public.key',
    '/etc/remaware/xray_public.key',
    path.join(process.cwd(), 'data', 'xray_public.key'),
  ]
  for (const candidate of fileCandidates) {
    const value = safeRead(candidate)?.trim()
    if (value) return { value, source: candidate }
  }

  const xray = loadXray()
  const inbound = xray?.inbounds?.find((item: any) => item?.protocol === 'vless')
  const privateKey = inbound?.streamSettings?.realitySettings?.privateKey as string | undefined
  if (privateKey) {
    const derived = derivePublicKeyFromPrivate(privateKey)
    if (derived) return { value: derived, source: 'xray.privateKey(derived)' }
  }

  return { value: null, source: 'not_set' }
}

function makeClientLink(args: {
  uuid: string
  ip: string
  port: number
  flow: string
  sni: string
  pbk: string
  sid: string
  name: string
}): string {
  const q = new URLSearchParams({
    type: 'tcp',
    security: 'reality',
    encryption: 'none',
    flow: args.flow,
    sni: args.sni,
    fp: 'chrome',
    pbk: args.pbk,
    sid: args.sid,
  })
  return `vless://${args.uuid}@${args.ip}:${args.port}?${q.toString()}#PearVPN`
}

function syncXrayClients(users: VpnUser[]): { synced: boolean; message: string } {
  const config = loadXray()
  if (!config) return { synced: false, message: 'xray config is unavailable' }

  const inbound = config.inbounds?.find((item: any) => item?.protocol === 'vless')
  if (!inbound?.settings) return { synced: false, message: 'vless inbound not found in xray config' }

  inbound.settings.clients = users
    .filter((u) => computeUserStatus(u) === 'active')
    .map((user) => ({ id: user.uuid, flow: user.flow, email: user.username }))

  const ok = saveXray(config)
  if (!ok) return { synced: false, message: 'failed to write xray config' }

  const restarted =
    spawnSync('systemctl', ['restart', 'xray'], { stdio: 'ignore' }).status === 0 ||
    spawnSync('service', ['xray', 'restart'], { stdio: 'ignore' }).status === 0

  if (!restarted) {
    return {
      synced: false,
      message: `synced ${inbound.settings.clients.length} users to config, but failed to restart xray`,
    }
  }

  return { synced: true, message: `synced ${inbound.settings.clients.length} active users and restarted xray` }
}

function queryXrayUserTrafficBytes(username: string): number | null {
  const norm = username.trim()
  if (!norm) return null
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const run = spawnSync(
    'xray',
    ['api', 'statsquery', '--server', XRAY_API_SERVER, '-name', `user>>>${norm}>>>traffic>>>`],
    { encoding: 'utf8' },
  )
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  if (run.status !== 0 || !out) return null

  let total = 0
  const uplink = out.match(new RegExp(`user>>>${escaped}>>>traffic>>>uplink[^\\d]*(\\d+)`))
  const downlink = out.match(new RegExp(`user>>>${escaped}>>>traffic>>>downlink[^\\d]*(\\d+)`))
  if (uplink?.[1]) total += Number(uplink[1])
  if (downlink?.[1]) total += Number(downlink[1])
  if (!Number.isFinite(total) || total <= 0) return 0
  return total
}

function refreshUsersTrafficInDb(db: UserDatabase): UserDatabase {
  const updated: VpnUser[] = []
  let touched = false
  for (const raw of db.users) {
    const user = normalizeUser(raw)
    const bytes = queryXrayUserTrafficBytes(user.username)
    if (bytes === null) {
      updated.push(user)
      continue
    }
    const gb = Number((bytes / 1024 / 1024 / 1024).toFixed(3))
    if ((user.usedTrafficGb ?? 0) !== gb) {
      user.usedTrafficGb = gb
      touched = true
    }
    updated.push(user)
  }
  if (touched) writeDb({ users: updated })
  return { users: updated }
}

function buildDashboard() {
  const db = readDb()
  const xrayConfig = loadXray()
  const inbound = xrayConfig?.inbounds?.find((item: any) => item?.protocol === 'vless')
  const reality = inbound?.streamSettings?.realitySettings
  const ip = process.env.PUBLIC_IP ?? getPrimaryAddress() ?? '0.0.0.0'
  const port = Number(inbound?.port ?? 443)
  const sni = reality?.serverNames?.[0] ?? 'www.microsoft.com'
  const shortId = reality?.shortIds?.[0] ?? randomBytes(8).toString('hex')
  const publicKey = resolvePublicKey()
  const activeUsers = db.users.filter((user) => computeUserStatus(user) === 'active').length

  return {
    brand: {
      name: 'Pear VPN',
      subtitle: 'Control panel with deploy sync, users and key management',
    },
    deployment: {
      packageManager: detectPackageManager(),
      nodeVersion: process.version,
      publicIp: ip,
      apiUrl: `http://localhost:${PORT}`,
      uiUrl: 'http://localhost:4173',
      xrayConfigPath: XRAY_CONFIG_PATH,
      dbPath: DB_PATH,
    },
    vpn: {
      label: 'VLESS Reality',
      address: ip,
      port,
      sni,
      shortId,
      publicKey: publicKey.value,
      publicKeySource: publicKey.source,
      activeUsers,
    },
    services: [
      {
        name: 'Xray Core',
        status: xrayConfig ? ('online' as ServiceStatus) : ('degraded' as ServiceStatus),
        endpoint: `${ip}:${port}`,
        details: xrayConfig ? 'Reality config loaded' : 'config.json not found',
      },
      {
        name: 'Backend API',
        status: 'online' as ServiceStatus,
        endpoint: `localhost:${PORT}`,
        details: 'Express + TS panel API',
      },
      {
        name: 'User database',
        status: 'online' as ServiceStatus,
        endpoint: DB_PATH,
        details: `${db.users.length} users total`,
      },
    ],
    system: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      memoryUsedGb: Number(((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2)),
      memoryTotalGb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
      cpuLoad: Number(os.loadavg()[0].toFixed(2)),
      networkInterfaces: Object.keys(os.networkInterfaces()),
    },
    logs: [
      { name: 'backend.log', path: path.join(LOG_DIR, 'backend.log'), preview: tailLog(path.join(LOG_DIR, 'backend.log')) },
      { name: 'frontend.log', path: path.join(LOG_DIR, 'frontend.log'), preview: tailLog(path.join(LOG_DIR, 'frontend.log')) },
      { name: 'installer.log', path: path.join(LOG_DIR, 'installer.log'), preview: tailLog(path.join(LOG_DIR, 'installer.log')) },
    ],
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pear-vpn-backend' })
})

app.get('/api/diagnostics', (_req, res) => {
  const xrayConfig = loadXray()
  const xrayApi = spawnSync('xray', ['api', 'statsquery', '--server', XRAY_API_SERVER], { encoding: 'utf8' })
  res.json({
    ok: true,
    checks: {
      xrayConfigExists: Boolean(xrayConfig),
      xrayApiServer: XRAY_API_SERVER,
      xrayApiReachable: xrayApi.status === 0,
      xrayApiOutputPreview: `${xrayApi.stdout ?? ''}`.split('\n').slice(0, 3),
      subBaseUrl: SUB_BASE_URL,
    },
  })
})

app.get('/api/dashboard', (_req, res) => {
  res.json(buildDashboard())
})

app.get('/api/users', (_req, res) => {
  const db = refreshUsersTrafficInDb(readDb())
  const users = db.users.map((raw) => {
    const user = normalizeUser(raw)
    return {
      ...user,
      status: computeUserStatus(user),
      link: buildUserLink(user),
      subscriptionUrl: buildSubscriptionUrl(user.subToken ?? ''),
    }
  })
  res.json({ users })
})

app.post('/api/users', (req, res) => {
  const username = String(req.body?.username ?? '').trim()
  const note = String(req.body?.note ?? '').trim()
  if (!username) return res.status(400).json({ error: 'username is required' })

  const db = readDb()
  const createdAt = new Date()
  const expiresAt = parseExpiresAt(req.body)
  const user: VpnUser = {
    id: randomUUID(),
    username,
    tgUserId: typeof req.body?.tgUserId === 'number' ? req.body.tgUserId : null,
    tgUsername: typeof req.body?.tgUsername === 'string' ? req.body.tgUsername.trim() : null,
    tgFullName: typeof req.body?.tgFullName === 'string' ? req.body.tgFullName.trim() : null,
    uuid: randomUUID(),
    flow: 'xtls-rprx-vision',
    status: 'active',
    createdAt: createdAt.toISOString(),
    expiresAt,
    trafficLimitGb: typeof req.body?.trafficLimitGb === 'number' ? req.body.trafficLimitGb : null,
    usedTrafficGb: 0,
    deviceLimit: typeof req.body?.deviceLimit === 'number' ? req.body.deviceLimit : 1,
    subToken: randomBytes(16).toString('hex'),
    note,
  }
  db.users.push(user)
  writeDb(db)
  const sync = syncXrayClients(db.users)
  res.status(201).json({ user: { ...normalizeUser(user), subscriptionUrl: buildSubscriptionUrl(user.subToken ?? '') }, sync })
})

app.patch('/api/users/:id', (req, res) => {
  const db = readDb()
  const user = db.users.find((item) => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'user not found' })

  if (typeof req.body?.status === 'string') {
    const next = req.body.status as UserStatus
    if (next === 'active' || next === 'paused') user.status = next
  }
  if (typeof req.body?.note === 'string') user.note = req.body.note.trim()
  if (typeof req.body?.days === 'number' || typeof req.body?.durationSeconds === 'number' || typeof req.body?.expiresAt === 'string') {
    user.expiresAt = parseExpiresAt(req.body)
  }
  if (typeof req.body?.trafficLimitGb === 'number') user.trafficLimitGb = req.body.trafficLimitGb
  if (typeof req.body?.deviceLimit === 'number') user.deviceLimit = req.body.deviceLimit
  writeDb(db)
  const sync = syncXrayClients(db.users)
  res.json({ user: { ...normalizeUser(user), status: computeUserStatus(user), link: buildUserLink(user) }, sync })
})

app.get('/api/users/:id/subscription', (req, res) => {
  const db = readDb()
  const user = db.users.find((item) => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'user not found' })
  const normalized = normalizeUser(user)
  writeDb({ users: db.users.map((u) => (u.id === user.id ? normalized : u)) })
  res.json({ subscriptionUrl: buildSubscriptionUrl(normalized.subToken ?? '') })
})

function handleSubscription(req: express.Request, res: express.Response) {
  const db = refreshUsersTrafficInDb(readDb())
  const user = db.users.map((u) => normalizeUser(u)).find((u) => u.subToken === req.params.token)
  if (!user) return res.status(404).send('not found')
  if (computeUserStatus(user) !== 'active') return res.status(403).send('subscription inactive')

  const link = buildUserLink(user)
  if (!link) return res.status(400).send('public key is not configured')

  const usedGb = user.usedTrafficGb ?? 0
  const totalGb = user.trafficLimitGb ?? 0
  const usedBytes = Math.floor(usedGb * 1024 * 1024 * 1024)
  const totalBytes = Math.floor(totalGb * 1024 * 1024 * 1024)
  const expire = Math.floor(new Date(user.expiresAt).getTime() / 1000)
  const profileTitle = Buffer.from('Pear VPN').toString('base64')
  const body = `${link}\n`

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('profile-web-page-url', 'https://pear-vpn.local/')
  res.setHeader('support-url', 'https://t.me/pearvpn_support')
  res.setHeader('profile-title', `base64:${profileTitle}`)
  res.setHeader('content-disposition', 'inline; filename="pear-vpn-subscription.txt"')
  res.setHeader('subscription-userinfo', `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expire}`)
  res.send(body)
}

app.get('/api/sub/:token', handleSubscription)
app.get('/sub/:token', handleSubscription)

app.post('/api/users/:id/rotate', (req, res) => {
  const db = readDb()
  const user = db.users.find((item) => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'user not found' })
  user.uuid = randomUUID()
  writeDb(db)
  const sync = syncXrayClients(db.users)
  res.json({ user: { ...user, status: computeUserStatus(user) }, sync })
})

app.delete('/api/users/:id', (req, res) => {
  const db = readDb()
  const start = db.users.length
  db.users = db.users.filter((item) => item.id !== req.params.id)
  if (db.users.length === start) return res.status(404).json({ error: 'user not found' })
  writeDb(db)
  const sync = syncXrayClients(db.users)
  res.json({ ok: true, sync })
})

app.post('/api/users/sync', (_req, res) => {
  const db = readDb()
  const sync = syncXrayClients(db.users)
  res.json(sync)
})

app.post('/api/keys/reality', (_req, res) => {
  const keys = parseRealityKeys()
  if (!keys.privateKey || !keys.publicKey) {
    return res.status(500).json({ error: 'failed to generate reality keys through xray x25519' })
  }
  res.json(keys)
})

app.get('/api/settings/public-key', (_req, res) => {
  const publicKey = resolvePublicKey()
  res.json(publicKey)
})

app.post('/api/settings/public-key', (req, res) => {
  const raw = String(req.body?.publicKey ?? '').trim()
  if (!raw) return res.status(400).json({ error: 'publicKey is required' })
  writeSettings({ publicKey: raw })
  res.json({ ok: true, publicKey: raw })
})

app.post('/api/keys/client', (req, res) => {
  const db = readDb()
  const dashboard = buildDashboard()
  const pbk = String(dashboard.vpn.publicKey ?? '')
  if (!pbk) return res.status(400).json({ error: 'public key is not set. use /api/settings/public-key' })

  const username = String(req.body?.name ?? '').trim() || `client_${db.users.length + 1}`
  const user: VpnUser = {
    id: randomUUID(),
    username,
    tgUserId: typeof req.body?.tgUserId === 'number' ? req.body.tgUserId : undefined,
    tgUsername: typeof req.body?.tgUsername === 'string' ? req.body.tgUsername : undefined,
    tgFullName: typeof req.body?.tgFullName === 'string' ? req.body.tgFullName : undefined,
    uuid: randomUUID(),
    flow: 'xtls-rprx-vision',
    status: 'active',
    createdAt: new Date().toISOString(),
    expiresAt: parseExpiresAt(req.body),
    trafficLimitGb: Number(req.body?.trafficLimitGb ?? 100),
    usedTrafficGb: 0,
    deviceLimit: Number(req.body?.deviceLimit ?? 1),
    subToken: randomBytes(16).toString('hex'),
    note: String(req.body?.note ?? ''),
  }

  db.users.push(user)
  writeDb(db)
  const sync = syncXrayClients(db.users)
  const normalized = normalizeUser(user)
  const link = buildUserLink(normalized)
  if (!link) return res.status(400).json({ error: 'failed to build user link from current xray config' })

  res.status(201).json({
    user: normalized,
    link,
    subscriptionUrl: buildSubscriptionUrl(normalized.subToken ?? ''),
    sync,
  })
})

app.get('/api/users/:id/link', (req, res) => {
  const db = readDb()
  const user = db.users.find((item) => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'user not found' })
  const dashboard = buildDashboard()
  const pbk = String(dashboard.vpn.publicKey ?? '')
  if (!pbk) return res.status(400).json({ error: 'public key is not set. set private/public key first' })
  const link = makeClientLink({
    uuid: user.uuid,
    ip: dashboard.vpn.address,
    port: dashboard.vpn.port,
    flow: user.flow,
    sni: dashboard.vpn.sni,
    pbk,
    sid: dashboard.vpn.shortId,
    name: user.username,
  })
  res.json({ link, uuid: user.uuid, user: user.username })
})

ensureDb()
ensureSettings()
{
  const db = readDb()
  const sync = syncXrayClients(db.users.map((u) => normalizeUser(u)))
  console.log(`[pear-vpn] startup xray sync: ${sync.message}`)
}

app.listen(PORT, HOST, () => {
  console.log(`Pear VPN backend listening on http://${HOST}:${PORT}`)
})
