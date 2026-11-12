/**
 * Pure SSH plumbing: argv construction, `ssh -G` parsing, sftp batch text,
 * alias resolution, host filtering.
 *
 * Nothing in this file spawns a process, reads the clock, or touches the
 * network — that is what makes every command line testable without an SSH
 * server. `lib/index.js` owns process execution and the tunnel registry.
 *
 * ## The one argv boundary that matters
 *
 * `ssh_exec` runs `ssh <options> <destination> <command>`, where `command` is
 * ONE argv element. ssh concatenates the remote arguments with spaces and
 * hands the result to the remote user's shell, so a remote shell does parse
 * it: that is the requested feature ("run this shell line over there"), not a
 * local injection bug. The local shell is never involved, and no local string
 * is ever built by interpolation — every option, host, user and path below is
 * a separate element of the same argv array.
 *
 * Transfers are the second boundary, and it is a *file* boundary rather than a
 * shell one: `sftp -b -` reads one command per line from stdin (see
 * `buildSftpBatch`). sftp's batch grammar has no shell metacharacters, but a
 * newline still starts a NEW command — and sftp can run local ones (`!cmd`) —
 * so a path containing a newline is rejected outright instead of escaped.
 * Quoting is the only transformation it understands: it strips `"` and leaves
 * everything else (backslashes included) verbatim, and it has no escape for a
 * literal `"` at all, so such a path is refused rather than mangled.
 *
 * ## Why `ssh -G`
 *
 * `ssh -G` prints the configuration ssh *would* use, without connecting. That
 * is how `ssh_resolve` answers "what will actually happen for this alias"
 * instead of repeating what our own hosts.json claims.
 */

/** Default TCP connect timeout handed to OpenSSH (milliseconds). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** Default cap for cluster fan-out. */
export const DEFAULT_MAX_WORKERS = 8

/** Bounds for a single remote command. */
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 600_000

/** Where `-L` / `-R` forwards point when the caller names no host. */
export const DEFAULT_REMOTE_HOST = '127.0.0.1'

/** Options every ssh/sftp invocation carries, in this exact order. */
const SAFETY_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']

/** ssh's exit code when it cannot connect/authenticate. */
export const SSH_FAILURE_EXIT_CODE = 255

/** Tunnel directions, and the ssh flag each one maps to. */
export const TUNNEL_DIRECTIONS = Object.freeze(['local', 'remote', 'dynamic'])
const TUNNEL_FLAGS = Object.freeze({ local: '-L', remote: '-R', dynamic: '-D' })

/**
 * The `ssh -G` keywords `ssh_resolve` reports. OpenSSH prints one
 * `keyword value` line per setting; repeated keywords (identityfile and the
 * three forward lists) become arrays, the rest keep their first value.
 */
export const RESOLVE_STRING_FIELDS = Object.freeze([
  'hostname',
  'user',
  'proxyjump',
  'proxycommand',
  'controlmaster',
  'forwardagent',
  'connecttimeout',
])
export const RESOLVE_LIST_FIELDS = Object.freeze([
  'identityfile',
  'localforward',
  'remoteforward',
  'dynamicforward',
])
export const RESOLVE_INTEGER_FIELDS = Object.freeze(['port', 'serveraliveinterval'])

/**
 * `-o` keywords that are refused instead of forwarded.
 *
 * All three run a program on THIS machine as a side effect of opening (or
 * accepting) a connection. These tools are a channel to another host; they are
 * not a licence to execute local commands, so the request is rejected loudly
 * rather than dropped silently — a silently ignored `-o` looks like it worked.
 */
const FORBIDDEN_OPTION_KEYS = new Map([
  [
    'proxycommand',
    {
      name: 'ProxyCommand',
      why: 'it runs an arbitrary program on THIS machine instead of opening an SSH channel',
      hint: 'Use the host record\'s "proxyJump" field for a jump host',
    },
  ],
  [
    'localcommand',
    {
      name: 'LocalCommand',
      why: 'it runs an arbitrary program on THIS machine when the connection comes up',
      hint: 'Use ssh_exec on the far side if that is what you meant',
    },
  ],
  [
    'permitlocalcommand',
    {
      name: 'PermitLocalCommand',
      why: 'it lets the remote side\'s host config turn on LocalCommand, which then runs a program on THIS machine',
      hint: 'It is a local-execution switch, not a transport setting',
    },
  ],
])

/** Refused `-o` keys, canonical spelling, for tests and documentation. */
export const FORBIDDEN_OPTION_NAMES = Object.freeze(
  [...FORBIDDEN_OPTION_KEYS.values()].map((entry) => entry.name),
)

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Validate and normalize a ProxyJump chain.
 *
 * Accepted per hop: `host`, `host:port`, `user@host`, `user@host:port`,
 * `[ipv6]`, `[ipv6]:port` — joined with commas for multiple hops, exactly the
 * grammar `ssh -J` accepts. The value is returned as written (only the
 * surrounding whitespace is trimmed) so OpenSSH stays the judge of anything we
 * do not model; what we refuse is the shapes ssh would silently misread
 * (an empty hop, a space, a port of 0).
 *
 * @param {unknown} value
 * @param {{ where?: string }} [options] - label used in error messages.
 * @returns {string | undefined} the chain, or undefined when absent/blank.
 */
export function normalizeProxyJump(value, options = {}) {
  const where = options.where ?? '"proxyJump"'
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${where} must be a string (got ${typeName(value)})`)
  }
  const raw = value.trim()
  if (raw === '') return undefined
  const hops = raw.split(',')
  return hops.map((hop) => checkJumpHop(hop.trim(), raw, where)).join(',')
}

function checkJumpHop(hop, whole, where) {
  if (hop === '') {
    throw new Error(
      `${where}: empty hop in ${JSON.stringify(whole)} — expected "host", "user@host", ` +
        '"host:port", "[ipv6]:port" or a comma-separated chain',
    )
  }
  if (/\s/.test(hop)) {
    throw new Error(`${where}: hop ${JSON.stringify(hop)} must not contain whitespace`)
  }
  if (/[\u0000-\u001f\u007f]/.test(hop)) {
    throw new Error(`${where}: hop ${JSON.stringify(hop)} must not contain control characters`)
  }

  let rest = hop
  const at = hop.indexOf('@')
  if (at !== -1) {
    const user = hop.slice(0, at)
    rest = hop.slice(at + 1)
    if (user === '') {
      throw new Error(`${where}: hop ${JSON.stringify(hop)} has an empty user before "@"`)
    }
    if (/[:[\]\s]/.test(user)) {
      throw new Error(`${where}: hop ${JSON.stringify(hop)} must not contain ":" or "[" in the user part`)
    }
  }

  let host = rest
  let port
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) {
      throw new Error(`${where}: hop ${JSON.stringify(hop)} has an unclosed "[" (IPv6 literals need "[...]")`)
    }
    host = rest.slice(1, close)
    const tail = rest.slice(close + 1)
    if (tail !== '') {
      if (!tail.startsWith(':')) {
        throw new Error(
          `${where}: hop ${JSON.stringify(hop)} must separate the IPv6 address and port with ":" ` +
            '(for example "[::1]:2200")',
        )
      }
      port = tail.slice(1)
    }
  } else {
    const colon = rest.indexOf(':')
    if (colon !== -1) {
      host = rest.slice(0, colon)
      port = rest.slice(colon + 1)
    }
  }

  if (host === '') {
    throw new Error(`${where}: hop ${JSON.stringify(hop)} has an empty host`)
  }
  if (port !== undefined) {
    if (!/^\d+$/.test(port)) {
      throw new Error(`${where}: hop ${JSON.stringify(hop)} has a non-numeric port ${JSON.stringify(port)}`)
    }
    const number = Number(port)
    if (number < 1 || number > 65535) {
      throw new Error(`${where}: hop ${JSON.stringify(hop)} port ${number} must be between 1 and 65535`)
    }
  }
  return hop
}

/**
 * Validate pass-through `-o` options.
 *
 * Each item is `Key=Value`. The three local-execution keywords above are
 * refused by name, with the reason; so is anything that is not a single ssh
 * keyword (a newline would start a second configuration line, which is how an
 * `-o` value could smuggle in `ProxyCommand` after a benign-looking key).
 *
 * @param {unknown} value
 * @param {{ field?: string }} [options] - field label used in error messages.
 * @returns {string[]} normalized `Key=Value` strings, in caller order.
 */
export function normalizeExtraOptions(value, options = {}) {
  const field = options.field ?? 'options'
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`"${field}" must be an array of "Key=Value" strings (got ${typeName(value)})`)
  }
  const items = []
  for (let index = 0; index < value.length; index++) {
    const raw = value[index]
    const label = `"${field}[${index}]"`
    if (typeof raw !== 'string') {
      throw new Error(`${label} must be a string (got ${typeName(raw)})`)
    }
    const item = raw.trim()
    if (item === '') throw new Error(`${label} must not be blank`)
    if (/[\u0000-\u001f\u007f]/.test(item)) {
      throw new Error(
        `${label} must not contain control characters or newlines ` +
          `(a newline would start a second ssh configuration line): ${JSON.stringify(raw)}`,
      )
    }
    const equals = item.indexOf('=')
    if (equals === -1) {
      throw new Error(`${label} must look like "ServerAliveInterval=15" (got ${JSON.stringify(raw)})`)
    }
    const key = item.slice(0, equals).trim()
    const rest = item.slice(equals + 1).trim()
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new Error(
        `${label} must name a single ssh option keyword before "=" (got ${JSON.stringify(raw)})`,
      )
    }
    const forbidden = FORBIDDEN_OPTION_KEYS.get(key.toLowerCase())
    if (forbidden !== undefined) {
      throw new Error(
        `${label} sets "${forbidden.name}", which is refused: ${forbidden.why}. ` +
          `${forbidden.hint}. It is refused instead of silently ignored.`,
      )
    }
    items.push(`${key}=${rest}`)
  }
  return items
}

function assertHostRecord(host, fn) {
  if (host === null || typeof host !== 'object' || Array.isArray(host)) {
    throw new Error(`${fn}: a host record is required`)
  }
  if (typeof host.host !== 'string' || host.host.trim() === '') {
    throw new Error(`${fn}: host record has no "host"`)
  }
  if (typeof host.user !== 'string' || host.user.trim() === '') {
    throw new Error(`${fn}: host record has no "user"`)
  }
}

function connectSeconds(connectTimeoutMs) {
  const ms = Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0
    ? connectTimeoutMs
    : DEFAULT_CONNECT_TIMEOUT_MS
  return Math.max(1, Math.ceil(ms / 1000))
}

/** `[::1]` for IPv6 literals, the bare name otherwise. */
function hostToken(host) {
  return host.host.includes(':') ? `[${host.host}]` : host.host
}

/**
 * Connection options shared by ssh, sftp and the `-G` resolver, in a fixed
 * order:
 *
 * 1. caller `-o` options (FIRST, because OpenSSH uses the *first* value it
 *    obtains for a keyword — appending them after ours would make them look
 *    accepted while having no effect),
 * 2. `BatchMode`, `StrictHostKeyChecking`, `ConnectTimeout`,
 * 3. optional `-i`, optional `-J`,
 * 4. the port (`-p` for ssh, `-P` for sftp).
 *
 * BatchMode=yes is what stops a tool call from hanging on a password prompt.
 * It also means a password-only host cannot work — see README.
 *
 * @param {object} host - normalized host record.
 * @param {{ connectTimeoutMs?: number, extraOptions?: unknown, portFlag?: string }} [options]
 * @returns {string[]}
 */
export function sshOptionArgs(host, options = {}) {
  assertHostRecord(host, 'sshOptionArgs')
  const portFlag = options.portFlag ?? '-p'
  const args = []
  for (const item of normalizeExtraOptions(options.extraOptions)) {
    args.push('-o', item)
  }
  args.push(...SAFETY_OPTIONS, '-o', `ConnectTimeout=${connectSeconds(options.connectTimeoutMs)}`)
  if (typeof host.identityFile === 'string' && host.identityFile !== '') {
    args.push('-i', host.identityFile)
  }
  const proxyJump = normalizeProxyJump(host.proxyJump)
  if (proxyJump !== undefined) args.push('-J', proxyJump)
  args.push(portFlag, String(host.port ?? 22))
  return args
}

/** `-l <user> <host>` — destination as separate argv elements. */
export function sshDestinationArgs(host) {
  assertHostRecord(host, 'sshDestinationArgs')
  return ['-l', host.user, hostToken(host)]
}

/**
 * Full `ssh` argv for one remote command.
 *
 * @param {object} host - normalized host record.
 * @param {string} command - the remote shell line (single argv element).
 * @param {{ connectTimeoutMs?: number, extraOptions?: unknown }} [options]
 * @returns {string[]}
 */
export function buildSshExecArgv(host, command, options = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('ssh_exec: "command" must be a non-empty string')
  }
  return [...sshOptionArgs(host, options), ...sshDestinationArgs(host), command]
}

/**
 * Every path handed to sftp is rejected if it carries one of these.
 *
 * These rules are MEASURED against OpenSSH 9.5p2, not assumed. sftp's batch
 * parser strips double quotes and treats a backslash as an ordinary character:
 * `get "/etc/a\"b" ...` answers `Unterminated quoted argument`, and `""`
 * collapses to nothing. So a path containing a double quote cannot be expressed
 * in a batch line at all, and refusing it beats emitting a line that fails with
 * a parse error far from the cause.
 */
const PATH_REJECTION = {
  newline:
    'must not contain a newline or a control character — sftp reads one command per line, ' +
    'so a newline would start a second (possibly local) command',
  dash: 'must not start with "-" (sftp would read it as an option)',
  empty: 'must be a non-empty string',
  quote:
    'must not contain a double quote: sftp\'s batch grammar strips quotes and has no escape ' +
    'for them, so such a path cannot be written as a batch command',
}

function assertBatchPath(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`buildSftpBatch: "${field}" ${PATH_REJECTION.empty}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`buildSftpBatch: "${field}" ${PATH_REJECTION.newline}`)
  }
  if (value.startsWith('-')) {
    throw new Error(`buildSftpBatch: "${field}" ${PATH_REJECTION.dash} (got ${JSON.stringify(value)})`)
  }
  if (value.includes('"')) {
    throw new Error(`buildSftpBatch: "${field}" ${PATH_REJECTION.quote} (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * Wrap one path in the double quotes sftp's batch parser understands.
 *
 * Whitespace is the only thing quoting is needed for: the parser strips the
 * quotes and keeps every other character — backslashes included — verbatim, so
 * nothing is escaped here. A double quote cannot be expressed at all, so it
 * throws instead of producing a line that only looks right.
 *
 * @param {string} value - a quote-free path.
 * @returns {string}
 */
export function quoteSftpPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`quoteSftpPath: a path ${PATH_REJECTION.empty}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`quoteSftpPath: a path ${PATH_REJECTION.newline}`)
  }
  if (value.includes('"')) {
    throw new Error(`quoteSftpPath: a path ${PATH_REJECTION.quote} (got ${JSON.stringify(value)})`)
  }
  return `"${value}"`
}

/**
 * The batch script for ONE transfer, fed to `sftp -b -` on stdin.
 *
 * `put <local> <remote>` for an upload, `get <remote> <local>` for a download.
 * `-b` makes sftp abort with a non-zero exit as soon as a command fails, which
 * is what turns a failed transfer into `{ok: false, stderr}` instead of a
 * silent half-copy.
 *
 * @param {'upload' | 'download'} direction
 * @param {string} localPath
 * @param {string} remotePath
 * @returns {string} one line, newline-terminated.
 */
export function buildSftpBatch(direction, localPath, remotePath) {
  if (direction !== 'upload' && direction !== 'download') {
    throw new Error(
      `buildSftpBatch: "direction" must be "upload" or "download" (got ${JSON.stringify(direction)})`,
    )
  }
  assertBatchPath(localPath, 'localPath')
  assertBatchPath(remotePath, 'remotePath')
  const [source, target] =
    direction === 'upload' ? [localPath, remotePath] : [remotePath, localPath]
  return `${direction === 'upload' ? 'put' : 'get'} ${quoteSftpPath(source)} ${quoteSftpPath(target)}\n`
}

/**
 * Full `sftp` argv. The port flag is `-P` (capital) — same as scp, unlike
 * ssh's `-p` — and `-b -` makes sftp read the batch from stdin, so no
 * temporary file is ever written for a transfer.
 *
 * @param {object} host
 * @param {{ connectTimeoutMs?: number, extraOptions?: unknown }} [options]
 * @returns {string[]}
 */
export function buildSftpArgv(host, options = {}) {
  assertHostRecord(host, 'buildSftpArgv')
  return [
    ...sshOptionArgs(host, { ...options, portFlag: '-P' }),
    '-b',
    '-',
    `${host.user}@${hostToken(host)}`,
  ]
}

/**
 * Validate a tunnel direction. Absent means `local` — the behaviour before
 * `-R` and `-D` existed, so an old caller keeps working.
 *
 * @param {unknown} value
 * @returns {'local' | 'remote' | 'dynamic'}
 */
export function normalizeTunnelDirection(value) {
  if (value === undefined || value === null || value === '') return 'local'
  if (typeof value !== 'string') {
    throw new Error(`"direction" must be a string (got ${typeName(value)})`)
  }
  const trimmed = value.trim().toLowerCase()
  if (!TUNNEL_DIRECTIONS.includes(trimmed)) {
    throw new Error(
      `"direction" must be one of "local" (-L), "remote" (-R) or "dynamic" (-D, SOCKS) ` +
        `(got ${JSON.stringify(value)})`,
    )
  }
  return trimmed
}

function assertPort(value, field, extra) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `"${field}" must be an integer between 1 and 65535 (got ${JSON.stringify(value)})` +
        (extra === undefined ? '' : `; ${extra}`),
    )
  }
  return value
}

/**
 * Normalize one tunnel to the values both the argv and the tool's report need.
 *
 * The direction decides which end listens:
 *
 * - `local`   `-L localPort:remoteHost:remotePort` — listens HERE, connects
 *             from the SSH host to `remoteHost:remotePort`.
 * - `remote`  `-R remotePort:remoteHost:localPort` — listens ON THE SSH HOST
 *             at `remotePort`, connects from HERE to `remoteHost:localPort`.
 *             `localPort` is therefore the local service being exposed, and it
 *             has no default: guessing it would publish the wrong port.
 * - `dynamic` `-D localPort` — a SOCKS5 proxy listening HERE; every connection
 *             carries its own destination, so `remoteHost`/`remotePort` are
 *             refused instead of being ignored.
 *
 * @param {object} host
 * @param {{ direction?: unknown, localPort?: number, remoteHost?: string, remotePort?: number }} options
 * @returns {{ direction: string, localPort: number, remoteHost?: string, remotePort?: number, forward: string, localAddress: string, target: string }}
 */
export function tunnelSpec(host, options = {}) {
  assertHostRecord(host, 'tunnelSpec')
  const direction = normalizeTunnelDirection(options.direction)
  const hasRemoteHost = options.remoteHost !== undefined && options.remoteHost !== null
  const hasRemotePort = options.remotePort !== undefined && options.remotePort !== null

  if (direction === 'dynamic') {
    for (const [field, present] of [['remoteHost', hasRemoteHost], ['remotePort', hasRemotePort]]) {
      if (present) {
        throw new Error(
          `direction="dynamic" (-D) opens a SOCKS5 proxy on THIS machine and forwards every ` +
            `connection it receives, so "${field}" has no meaning there — omit it, or use ` +
            'direction="local" for a fixed target',
        )
      }
    }
    const localPort = assertPort(options.localPort, 'localPort', 'dynamic forwards listen on a local port')
    return {
      direction,
      localPort,
      forward: String(localPort),
      localAddress: `127.0.0.1:${localPort}`,
      target: 'socks5 (destination per connection)',
    }
  }

  if (direction === 'remote' && (options.localPort === undefined || options.localPort === null)) {
    throw new Error(
      'direction="remote" (-R) needs "localPort": it is the port on THIS machine that the ' +
        'listener on the SSH host forwards to',
    )
  }
  const localPort = assertPort(options.localPort, 'localPort')
  let remoteHost = DEFAULT_REMOTE_HOST
  if (hasRemoteHost) {
    if (typeof options.remoteHost !== 'string' || options.remoteHost.trim() === '') {
      throw new Error(`"remoteHost" must be a non-empty string (got ${JSON.stringify(options.remoteHost)})`)
    }
    remoteHost = options.remoteHost.trim()
  }
  const remotePort = assertPort(
    options.remotePort,
    'remotePort',
    `it is required for direction="${direction}"`,
  )

  if (direction === 'local') {
    return {
      direction,
      localPort,
      remoteHost,
      remotePort,
      forward: `${localPort}:${remoteHost}:${remotePort}`,
      localAddress: `127.0.0.1:${localPort}`,
      target: `${remoteHost}:${remotePort}`,
    }
  }
  return {
    direction,
    localPort,
    remoteHost,
    remotePort,
    forward: `${remotePort}:${remoteHost}:${localPort}`,
    localAddress: `${host.alias ?? 'ssh-host'}:${remotePort}`,
    target: `${remoteHost}:${localPort}`,
  }
}

/**
 * Full `ssh -N -L|-R|-D ...` argv for one forward.
 *
 * `ExitOnForwardFailure=yes` makes ssh exit instead of silently running
 * without the forward when the listener cannot be bound (a taken local port, or
 * a remote port the server refuses to open). Note there is no `ControlMaster`
 * here: connection multiplexing is not supported by the Windows OpenSSH build
 * this plugin targets — `getsockname failed: Not a socket` and no socket is
 * ever created — so a tunnel really is its own connection.
 *
 * @param {object} host
 * @param {{ direction?: unknown, localPort?: number, remoteHost?: string, remotePort?: number, connectTimeoutMs?: number, extraOptions?: unknown }} [options]
 * @returns {string[]}
 */
export function buildTunnelArgv(host, options = {}) {
  const spec = tunnelSpec(host, options)
  return [
    ...sshOptionArgs(host, options),
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    TUNNEL_FLAGS[spec.direction],
    spec.forward,
    ...sshDestinationArgs(host),
  ]
}

/**
 * Full `ssh -G` argv for `ssh_resolve`.
 *
 * Every value we own is overlaid as an `-o` so an alias that is NOT in
 * `~/.ssh/config` still resolves: `ssh -G <alias>` alone would just echo the
 * alias back as the hostname. The alias also stays the destination argument,
 * because that is what selects the `Host <alias>` block — the point of the
 * tool is to report what OpenSSH would really do, including a `ProxyCommand`,
 * `LocalForward` or `ForwardAgent` that our hosts.json knows nothing about.
 *
 * No BatchMode/ConnectTimeout here on purpose: they are not part of "how would
 * this connect", and they would mask the values we are asked to report.
 *
 * @param {object} host
 * @returns {string[]}
 */
export function buildResolveArgv(host) {
  assertHostRecord(host, 'buildResolveArgv')
  const alias = typeof host.alias === 'string' ? host.alias.trim() : ''
  if (alias === '') {
    throw new Error('ssh_resolve: the host record has no "alias"')
  }
  if (alias.startsWith('-')) {
    throw new Error(
      `ssh_resolve: alias ${JSON.stringify(alias)} starts with "-", which ssh would read as an ` +
        'option instead of a destination — rename the alias',
    )
  }
  if (/\s/.test(host.host)) {
    throw new Error(`ssh_resolve: host ${JSON.stringify(host.host)} must not contain whitespace`)
  }
  const args = [
    '-G',
    '-o',
    `HostName=${host.host}`,
    '-o',
    `User=${host.user}`,
    '-o',
    `Port=${host.port ?? 22}`,
  ]
  if (typeof host.identityFile === 'string' && host.identityFile !== '') {
    args.push('-o', `IdentityFile=${host.identityFile}`)
  }
  const proxyJump = normalizeProxyJump(host.proxyJump)
  if (proxyJump !== undefined) args.push('-o', `ProxyJump=${proxyJump}`)
  args.push(alias)
  return args
}

/**
 * Parse `ssh -G` output into `keyword -> [values]` (lower-cased keys, values
 * in the order OpenSSH printed them). Repeated keywords collect instead of
 * overwriting: `identityfile` is printed once per candidate key.
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function parseSshGOutput(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const space = trimmed.search(/\s/)
    const key = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    if (key === '') continue
    const value = space === -1 ? '' : trimmed.slice(space + 1).trim()
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [value])
    else bucket.push(value)
  }
  return map
}

/**
 * Pull the contracted keywords out of a parsed `ssh -G` dump.
 *
 * A dump without a `hostname` or a numeric `port` is not a resolution we can
 * stand behind, so it throws — an empty object would be indistinguishable from
 * "there is no configuration", which is the one answer this tool must never
 * give.
 *
 * @param {Map<string, string[]>} map
 * @param {{ alias?: string }} [options] - only used in error messages.
 * @returns {object}
 */
export function extractResolvedConfig(map, options = {}) {
  const alias = options.alias ?? '(unknown)'
  const first = (key) => {
    const values = map.get(key)
    return values === undefined || values.length === 0 ? '' : values[0]
  }
  const list = (key) => (map.get(key) ?? []).filter((value) => value !== '')

  const hostname = first('hostname')
  if (hostname === '') {
    throw new Error(
      `ssh -G output for alias "${alias}" has no "hostname" line — refusing to return an ` +
        'empty resolution',
    )
  }
  const portRaw = first('port')
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `ssh -G output for alias "${alias}" has no usable "port" line ` +
        `(got ${JSON.stringify(portRaw)})`,
    )
  }
  const aliveRaw = Number.parseInt(first('serveraliveinterval'), 10)

  return {
    hostname,
    user: first('user'),
    port,
    proxyjump: first('proxyjump'),
    proxycommand: first('proxycommand'),
    identityfile: list('identityfile'),
    controlmaster: first('controlmaster'),
    forwardagent: first('forwardagent'),
    localforward: list('localforward'),
    remoteforward: list('remoteforward'),
    dynamicforward: list('dynamicforward'),
    serveraliveinterval: Number.isInteger(aliveRaw) ? aliveRaw : 0,
    connecttimeout: first('connecttimeout'),
  }
}

/**
 * Resolve one host record through the system `ssh -G` and report the effective
 * configuration.
 *
 * `run` is injected so this is testable without an SSH binary and without a
 * server: it receives the argv array and resolves to `{ code, stdout, stderr }`
 * (it may throw for spawn/timeout failures). A non-zero exit, empty output or
 * unparseable output all throw — see extractResolvedConfig.
 *
 * @param {object} host
 * @param {{ run: (argv: string[]) => Promise<{ code: number | null, stdout?: string, stderr?: string }> }} options
 * @returns {Promise<object>}
 */
export async function resolveViaSshG(host, options = {}) {
  if (typeof options.run !== 'function') {
    throw new Error('resolveViaSshG: a "run" function is required (it executes the ssh -G argv)')
  }
  const alias = host?.alias ?? '(unknown)'
  const argv = buildResolveArgv(host)
  const result = await options.run(argv)
  if (result === null || typeof result !== 'object') {
    throw new Error(`ssh_resolve: the ssh -G runner returned ${typeName(result)} instead of a result object`)
  }
  if (result.code !== 0) {
    const detail =
      String(result.stderr ?? '').trim() ||
      String(result.stdout ?? '').trim() ||
      'no stderr output'
    throw new Error(
      `ssh -G failed for alias "${alias}" (exit ${result.code === null ? 'none (killed)' : result.code}): ${detail}`,
    )
  }
  const text = String(result.stdout ?? '')
  if (text.trim() === '') {
    throw new Error(`ssh -G produced no output for alias "${alias}" — refusing to return an empty resolution`)
  }
  const resolved = extractResolvedConfig(parseSshGOutput(text), { alias })
  return { alias, ...resolved }
}

/** Human list of aliases for an error message. */
export function formatAliases(hosts) {
  const aliases = (Array.isArray(hosts) ? hosts : []).map((host) => host.alias)
  return aliases.length > 0 ? aliases.join(', ') : '(none configured)'
}

/**
 * Resolve one alias. A miss is an error that names every alias we do have —
 * never an empty success.
 *
 * @param {object[]} hosts
 * @param {string} alias
 * @returns {object}
 */
export function resolveHost(hosts, alias) {
  const list = Array.isArray(hosts) ? hosts : []
  if (typeof alias !== 'string' || alias.trim() === '') {
    throw new Error(`ssh: "alias" must be a non-empty string. Available aliases: ${formatAliases(list)}`)
  }
  const wanted = alias.trim()
  const found = list.find((host) => host.alias === wanted)
  if (found !== undefined) return found
  if (list.length === 0) {
    throw new Error(
      `unknown SSH host alias "${wanted}": no hosts are configured yet. ` +
        'Add hosts to ~/.dsh/ssh/hosts.json (see the plugin README for the format).',
    )
  }
  throw new Error(`unknown SSH host alias "${wanted}". Available aliases: ${formatAliases(list)}`)
}

function haystack(host) {
  return [host.alias, host.description, host.host, ...(host.tags ?? [])]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
}

/**
 * Fuzzy match: whitespace-separated tokens are AND-ed, each token must appear
 * somewhere in alias / description / host / tags (case-insensitive).
 */
export function matchesQuery(host, query) {
  if (typeof query !== 'string' || query.trim() === '') return true
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const parts = haystack(host)
  return tokens.every((token) => parts.some((part) => part.includes(token)))
}

function normalizedList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '')
}

/**
 * Filter a host list. Every provided selector narrows (AND semantics), so an
 * extra selector can only ever make the result smaller — never silently wider.
 *
 * - `aliases`: exact alias match; an unknown alias throws (listing the rest).
 * - `environment`: exact environment match.
 * - `tags`: the host must carry EVERY requested tag.
 * - `query`: fuzzy match (see matchesQuery).
 *
 * @param {object[]} hosts
 * @param {{ aliases?: string[], environment?: string, tags?: string[], query?: string }} [selectors]
 * @returns {object[]}
 */
export function filterHosts(hosts, selectors = {}) {
  let result = Array.isArray(hosts) ? hosts.slice() : []

  const aliases = normalizedList(selectors.aliases)
  if (aliases.length > 0) {
    const missing = aliases.filter((alias) => !result.some((host) => host.alias === alias))
    if (missing.length > 0) {
      throw new Error(
        `unknown SSH host alias${missing.length > 1 ? 'es' : ''}: ${missing.join(', ')}. ` +
          `Available aliases: ${formatAliases(result)}`,
      )
    }
    result = result.filter((host) => aliases.includes(host.alias))
  }

  if (typeof selectors.environment === 'string' && selectors.environment.trim() !== '') {
    const environment = selectors.environment.trim()
    result = result.filter((host) => (host.environment ?? '') === environment)
  }

  const tags = normalizedList(selectors.tags)
  if (tags.length > 0) {
    result = result.filter((host) => tags.every((tag) => (host.tags ?? []).includes(tag)))
  }

  if (typeof selectors.query === 'string' && selectors.query.trim() !== '') {
    result = result.filter((host) => matchesQuery(host, selectors.query))
  }

  return result
}

function describeSelectors(selectors) {
  const parts = []
  const aliases = normalizedList(selectors.aliases)
  if (aliases.length > 0) parts.push(`aliases=[${aliases.join(', ')}]`)
  if (typeof selectors.environment === 'string' && selectors.environment.trim() !== '') {
    parts.push(`environment=${selectors.environment.trim()}`)
  }
  const tags = normalizedList(selectors.tags)
  if (tags.length > 0) parts.push(`tags=[${tags.join(', ')}]`)
  return parts.join(' ')
}

/**
 * Resolve the target set for `ssh_cluster`.
 *
 * @param {object[]} hosts
 * @param {{ aliases?: string[], environment?: string, tags?: string[] }} selectors
 * @returns {object[]}
 */
export function selectClusterHosts(hosts, selectors = {}) {
  const aliases = normalizedList(selectors.aliases)
  const tags = normalizedList(selectors.tags)
  const environment = typeof selectors.environment === 'string' ? selectors.environment.trim() : ''
  if (aliases.length === 0 && tags.length === 0 && environment === '') {
    throw new Error(
      'ssh_cluster requires at least one selector: "aliases", "environment", or "tags" (none was given). ' +
        `Available aliases: ${formatAliases(hosts)}`,
    )
  }
  const selected = filterHosts(hosts, { aliases, tags, environment })
  if (selected.length === 0) {
    throw new Error(
      `ssh_cluster: no hosts matched ${describeSelectors({ aliases, tags, environment })}. ` +
        `Available aliases: ${formatAliases(hosts)}`,
    )
  }
  return selected
}

/**
 * Validate a caller-supplied timeout.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizeTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(
      `"timeoutMs" must be a number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got ${JSON.stringify(value)})`,
    )
  }
  return Math.floor(value)
}

/**
 * Validate a worker count.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizeMaxWorkers(value, fallback = DEFAULT_MAX_WORKERS) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error(`"maxWorkers" must be an integer between 1 and 64 (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the result. Rejects if a worker throws (callers that want
 * per-item failures catch inside the worker).
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items)
  const results = new Array(list.length)
  if (list.length === 0) return results
  const width = Math.max(1, Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_WORKERS, list.length))
  let cursor = 0
  const run = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, run))
  return results
}
