/**
 * Host-list storage for dsh-ssh.
 *
 * The list belongs to this plugin: `~/.dsh/ssh/hosts.json`
 *
 *     { "version": 1, "hosts": [ { alias, host, port, user, proxyJump, ... } ] }
 *
 * A legacy list written by the third-party `@linxin666/dsh-ssh` plugin
 * (`~/.dsh/dsh-ssh.json`) is imported ONCE, when our file does not exist yet.
 * The legacy file is only ever read — never renamed, rewritten or deleted.
 * The legacy `proxyJump` array is carried over as a comma-separated chain,
 * because that is the shape `ssh -J` takes.
 *
 * Every failure here is explicit: a broken JSON file is an error, never an
 * empty host list, because an empty list turns "run this on prod" into
 * "alias not found" only after the user has lost an hour.
 */
import os from 'node:os'
import path from 'node:path'
import {
  readFile as readFileDefault,
  writeFile as writeFileDefault,
  mkdir as mkdirDefault,
} from 'node:fs/promises'
import { normalizeProxyJump } from './ssh-command.js'

/** Version written by this plugin. */
export const HOSTS_VERSION = 1

/** Default SSH port. */
export const DEFAULT_PORT = 22

/** Alias charset: anything but whitespace and `:` (an alias is a key, not a host). */
const ALIAS_PATTERN = /^[^\s:]+$/

/** Error type so callers/tests can tell config problems from I/O problems. */
export class HostsError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'HostsError'
  }
}

/** `<home>/.dsh/ssh` */
export function hostsDir(home = os.homedir()) {
  return path.join(home, '.dsh', 'ssh')
}

/** `<home>/.dsh/ssh/hosts.json` — the file this plugin owns. */
export function hostsFile(home = os.homedir()) {
  return path.join(hostsDir(home), 'hosts.json')
}

/** `<home>/.dsh/dsh-ssh.json` — the legacy file belonging to `@linxin666/dsh-ssh`. */
export function legacyHostsFile(home = os.homedir()) {
  return path.join(home, '.dsh', 'dsh-ssh.json')
}

/**
 * Expand the `~` home prefix. Only the bare `~` and `~/` / `~\` forms are
 * supported: `~otheruser` needs an OS account lookup we do not perform, so it
 * is rejected instead of being passed to ssh as a literal path.
 */
export function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HostsError('cannot expand "~": expected a non-empty path string')
  }
  const raw = value.trim()
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  if (raw.startsWith('~')) {
    throw new HostsError(`cannot expand "${raw}": only "~" and "~/" are supported (use an absolute path)`)
  }
  return raw
}

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function readString(value, field, where, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HostsError(`${where}: "${field}" is required`)
    return undefined
  }
  if (typeof value !== 'string') {
    throw new HostsError(`${where}: "${field}" must be a string (got ${typeName(value)})`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    if (required) throw new HostsError(`${where}: "${field}" must not be blank`)
    return undefined
  }
  return trimmed
}

function readPort(value, where) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORT
  const port = typeof value === 'string' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostsError(`${where}: "port" must be an integer between 1 and 65535 (got ${JSON.stringify(value)})`)
  }
  return port
}

function readTags(value, where) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new HostsError(`${where}: "tags" must be an array of strings (got ${typeName(value)})`)
  }
  const tags = []
  for (let index = 0; index < value.length; index++) {
    const tag = value[index]
    if (typeof tag !== 'string') {
      throw new HostsError(`${where}: "tags[${index}]" must be a string (got ${typeName(tag)})`)
    }
    const trimmed = tag.trim()
    if (trimmed !== '' && !tags.includes(trimmed)) tags.push(trimmed)
  }
  return tags
}

/**
 * Validate and normalize one host record.
 *
 * Unknown keys (the legacy `auth`, `createdAt`, ...) are dropped on purpose:
 * the on-disk shape is this plugin's contract, and a password cannot be used by
 * a BatchMode CLI anyway. `proxyJump` is NOT dropped any more — it is carried
 * to `ssh -J` (see `lib/ssh-command.js`), which is the alternative to
 * connection multiplexing that this platform actually supports.
 *
 * @param {unknown} raw - candidate record.
 * @param {{ index?: number, source?: string, home?: string }} [options] - context for error messages and `~` expansion.
 * @returns {{ alias: string, host: string, port: number, user: string, identityFile?: string, proxyJump?: string, tags: string[], environment?: string, description?: string }}
 */
export function normalizeHost(raw, options = {}) {
  const { index = 0, source = 'hosts.json', home = os.homedir() } = options
  const where = `${source}: hosts[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HostsError(`${where} must be an object (got ${typeName(raw)})`)
  }

  const alias = readString(raw.alias, 'alias', where, { required: true })
  if (!ALIAS_PATTERN.test(alias)) {
    throw new HostsError(`${where}: alias "${alias}" must not contain whitespace or ":"`)
  }
  const host = readString(raw.host, 'host', where, { required: true })
  if (/\s/.test(host)) {
    throw new HostsError(`${where}: host "${host}" must not contain whitespace`)
  }
  const user = readString(raw.user, 'user', where, { required: true })
  if (/\s/.test(user)) {
    throw new HostsError(`${where}: user "${user}" must not contain whitespace`)
  }
  const port = readPort(raw.port, where)
  const tags = readTags(raw.tags, where)
  const environment = readString(raw.environment, 'environment', where)
  const description = readString(raw.description, 'description', where)

  let identityFile
  if (raw.identityFile !== undefined && raw.identityFile !== null && raw.identityFile !== '') {
    const rawKey = readString(raw.identityFile, 'identityFile', where, { required: true })
    identityFile = expandHome(rawKey, home)
  }

  let proxyJump
  try {
    proxyJump = normalizeProxyJump(raw.proxyJump, { where: `${where}: "proxyJump"` })
  } catch (error) {
    throw new HostsError(error.message, { cause: error })
  }

  const record = { alias, host, port, user }
  if (identityFile !== undefined) record.identityFile = identityFile
  if (proxyJump !== undefined) record.proxyJump = proxyJump
  record.tags = tags
  if (environment !== undefined) record.environment = environment
  if (description !== undefined) record.description = description
  return record
}

function assertUniqueAliases(hosts, source) {
  const seen = new Map()
  for (let index = 0; index < hosts.length; index++) {
    const alias = hosts[index].alias
    if (seen.has(alias)) {
      throw new HostsError(
        `${source}: duplicate host alias "${alias}" (hosts[${seen.get(alias)}] and hosts[${index}])`,
      )
    }
    seen.set(alias, index)
  }
}

/**
 * Parse our own document. A wrong shape is an error, not an empty list.
 *
 * @param {string} text - file contents.
 * @param {{ source?: string, home?: string }} [options]
 * @returns {{ version: number, hosts: ReturnType<typeof normalizeHost>[] }}
 */
export function parseHostsDocument(text, options = {}) {
  const { source = 'hosts.json', home = os.homedir() } = options
  let document
  try {
    document = JSON.parse(String(text))
  } catch (error) {
    throw new HostsError(`${source}: invalid JSON — ${error.message}`, { cause: error })
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new HostsError(`${source}: expected a JSON object with "version" and "hosts"`)
  }
  if (document.version !== undefined && document.version !== HOSTS_VERSION) {
    throw new HostsError(
      `${source}: unsupported version ${JSON.stringify(document.version)} (this plugin reads version ${HOSTS_VERSION})`,
    )
  }
  if (!Array.isArray(document.hosts)) {
    throw new HostsError(`${source}: "hosts" must be an array (got ${typeName(document.hosts)})`)
  }
  const hosts = document.hosts.map((raw, index) => normalizeHost(raw, { index, source, home }))
  assertUniqueAliases(hosts, source)
  return { version: HOSTS_VERSION, hosts }
}

/**
 * Read an identity file out of a legacy record: a direct `identityFile`, or
 * the `auth.keyPath` the old GUI plugin wrote for key auth.
 */
function legacyIdentityFile(raw) {
  if (raw.identityFile !== undefined && raw.identityFile !== null && raw.identityFile !== '') {
    return raw.identityFile
  }
  const auth = raw.auth
  if (auth !== null && typeof auth === 'object' && auth.kind === 'key') {
    if (typeof auth.keyPath === 'string' && auth.keyPath.trim() !== '') return auth.keyPath
  }
  return undefined
}

function legacyUsesPasswordOnly(raw) {
  const auth = raw.auth
  return (
    auth !== null &&
    typeof auth === 'object' &&
    auth.kind === 'password' &&
    (raw.identityFile === undefined || raw.identityFile === null || raw.identityFile === '')
  )
}

/**
 * Map the legacy `proxyJump` field onto our comma-separated chain.
 *
 * The old GUI plugin stored an array of hops; `ssh -J` wants them joined with
 * commas. An empty array is "no jump host" (that is what every record of the
 * real legacy file on this machine carries), and a value we cannot read — a
 * non-string hop, an object — is reported as a warning instead of aborting an
 * import the user cannot fix from inside DSH. Anything the array DOES contain
 * is still validated by normalizeHost, so a broken hop is an explicit error.
 *
 * @param {unknown} raw - one legacy record.
 * @param {{ index: number, source: string }} where
 * @returns {{ proxyJump?: string, warning?: string }}
 */
function readLegacyProxyJump(raw, { index, source }) {
  const value = raw?.proxyJump
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    return value.trim() === '' ? {} : { proxyJump: value }
  }
  if (!Array.isArray(value)) {
    return {
      warning:
        `${source}: hosts[${index}]: ignoring "proxyJump" — expected a string or an array of ` +
        `strings, got ${typeName(value)}`,
    }
  }
  const hops = []
  for (let hopIndex = 0; hopIndex < value.length; hopIndex++) {
    const hop = value[hopIndex]
    if (typeof hop !== 'string') {
      return {
        warning:
          `${source}: hosts[${index}]: ignoring "proxyJump[${hopIndex}]" — expected a string, ` +
          `got ${typeName(hop)}`,
      }
    }
    const trimmed = hop.trim()
    if (trimmed !== '') hops.push(trimmed)
  }
  return hops.length === 0 ? {} : { proxyJump: hops.join(',') }
}

/**
 * Parse the legacy `@linxin666/dsh-ssh` document.
 *
 * @param {string} text - legacy file contents.
 * @param {{ source?: string, home?: string }} [options]
 * @returns {{
 *   hosts: ReturnType<typeof normalizeHost>[],
 *   passwordAliases: string[],
 *   warnings: string[],
 * }}
 */
export function parseLegacyDocument(text, options = {}) {
  const { source = 'dsh-ssh.json', home = os.homedir() } = options
  let document
  try {
    document = JSON.parse(String(text))
  } catch (error) {
    throw new HostsError(`${source}: invalid JSON — ${error.message}`, { cause: error })
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new HostsError(`${source}: expected a JSON object with a "hosts" array`)
  }
  if (!Array.isArray(document.hosts)) {
    throw new HostsError(`${source}: "hosts" must be an array (got ${typeName(document.hosts)})`)
  }

  const warnings = []
  const hosts = document.hosts.map((raw, index) => {
    const legacyJump = readLegacyProxyJump(raw, { index, source })
    if (legacyJump.warning !== undefined) warnings.push(legacyJump.warning)
    return normalizeHost(
      {
        alias: raw?.alias,
        host: raw?.host,
        port: raw?.port,
        user: raw?.user,
        identityFile: raw !== null && typeof raw === 'object' ? legacyIdentityFile(raw) : undefined,
        proxyJump: legacyJump.proxyJump,
        tags: raw?.tags,
        environment: raw?.environment,
        description: raw?.description,
      },
      { index, source, home },
    )
  })
  assertUniqueAliases(hosts, source)
  const passwordAliases = document.hosts
    .filter((raw) => raw !== null && typeof raw === 'object' && legacyUsesPasswordOnly(raw))
    .map((raw) => raw.alias)
    .filter((alias) => typeof alias === 'string')
  return { hosts, passwordAliases, warnings }
}

/** Serialize our document with a stable shape (2-space JSON, trailing newline). */
export function serializeHosts(hosts) {
  return `${JSON.stringify({ version: HOSTS_VERSION, hosts }, null, 2)}\n`
}

/**
 * Load the host list, importing the legacy list once when needed.
 *
 * @param {{
 *   home?: string,
 *   fs?: { readFile: Function, writeFile: Function, mkdir: Function },
 *   log?: (line: string) => void,
 *   warn?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{
 *   hosts: ReturnType<typeof normalizeHost>[],
 *   source: string,
 *   imported: boolean,
 *   importedCount?: number,
 *   legacyPath?: string,
 *   missing?: boolean,
 *   passwordAliases?: string[],
 * }>}
 */
export async function loadHosts(options = {}) {
  const home = options.home ?? os.homedir()
  const fs = {
    readFile: options.fs?.readFile ?? readFileDefault,
    writeFile: options.fs?.writeFile ?? writeFileDefault,
    mkdir: options.fs?.mkdir ?? mkdirDefault,
  }
  const log = options.log ?? ((line) => console.log(line))
  const warn = options.warn ?? ((line) => console.warn(line))

  const target = hostsFile(home)
  let text
  try {
    text = String(await fs.readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new HostsError(`${target}: cannot read hosts file — ${error.message}`, { cause: error })
    }
    text = undefined
  }
  if (text !== undefined) {
    const document = parseHostsDocument(text, { source: target, home })
    return { hosts: document.hosts, source: target, imported: false }
  }

  const legacy = legacyHostsFile(home)
  let legacyText
  try {
    legacyText = String(await fs.readFile(legacy, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new HostsError(`${legacy}: cannot read legacy hosts file — ${error.message}`, { cause: error })
    }
    return { hosts: [], source: target, imported: false, missing: true }
  }

  const { hosts, passwordAliases, warnings } = parseLegacyDocument(legacyText, { source: legacy, home })
  const document = { version: HOSTS_VERSION, hosts }
  await fs.mkdir(hostsDir(home), { recursive: true })
  await fs.writeFile(target, serializeHosts(hosts), 'utf8')
  log(
    `[snow-ssh] 從舊清單匯入了 ${hosts.length} 筆主機：${legacy} -> ${target}（舊檔保留未動）`,
  )
  for (const line of warnings) warn(`[snow-ssh] ${line}`)
  if (passwordAliases.length > 0) {
    warn(
      `[snow-ssh] 注意：${passwordAliases.length} 筆主機在舊清單只有密碼認證（${passwordAliases.join(', ')}）；` +
        '本外掛以 BatchMode=yes 執行 ssh，無法互動輸入密碼，請改用 identityFile 或 ssh-agent。',
    )
  }
  return { hosts, source: target, imported: true, importedCount: hosts.length, legacyPath: legacy, passwordAliases }
}

/**
 * Write the host list (used by future add/remove-host tooling and by tests).
 * @param {ReturnType<typeof normalizeHost>[]} hosts
 * @param {{ home?: string, fs?: { writeFile: Function, mkdir: Function } }} [options]
 * @returns {Promise<string>} the file written.
 */
export async function saveHosts(hosts, options = {}) {
  const home = options.home ?? os.homedir()
  const fs = {
    writeFile: options.fs?.writeFile ?? writeFileDefault,
    mkdir: options.fs?.mkdir ?? mkdirDefault,
  }
  const file = hostsFile(home)
  await fs.mkdir(hostsDir(home), { recursive: true })
  await fs.writeFile(file, serializeHosts(hosts), 'utf8')
  return file
}
