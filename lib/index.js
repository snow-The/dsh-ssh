/**
 * dsh-ssh — native, agent-facing SSH tools for the DeepSeek Harness.
 *
 * Host-side only: no GUI, no client bundle, no browser code, no npm runtime
 * dependency. Every operation shells out to the OpenSSH client (`ssh`,
 * `sftp`) that ships with Windows 10+ (or any Unix) — we do not re-implement
 * the protocol, we drive the client that already knows it.
 *
 * The host list lives in this plugin's own file, `~/.dsh/ssh/hosts.json`;
 * `lib/hosts.js` imports the old `@linxin666/dsh-ssh` list once.
 *
 * ## Why `spawn` and never `exec`
 *
 * Local command construction is shell-free: each argument is its own argv
 * element. The only string a shell will ever interpret is the `command`
 * argument of `ssh_exec`, and it is interpreted by the *remote* shell because
 * that is exactly what "run this command on that host" means. Quoting it
 * locally would be wrong; passing it as a single argv element is the boundary.
 *
 * Transfers have a different boundary: `sftp -b -` reads one command per line
 * from the child's stdin, so the batch text is data for sftp, not for a shell —
 * and a path containing a newline is refused rather than quoted (see
 * `buildSftpBatch`).
 *
 * ## What is deliberately absent
 *
 * Connection multiplexing (`ControlMaster`/`ControlPersist`) is not
 * implemented and not emulated: the Windows OpenSSH build this plugin targets
 * does not support it — `getsockname failed: Not a socket`, and no socket is
 * ever created. Jump hosts (`-J`) and long-lived tunnels are how you keep the
 * hop count low instead.
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import net from 'node:net'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HostsError, loadHosts } from './hosts.js'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  SSH_FAILURE_EXIT_CODE,
  buildSftpArgv,
  buildSftpBatch,
  buildSshExecArgv,
  buildTunnelArgv,
  filterHosts,
  mapWithConcurrency,
  normalizeExtraOptions,
  normalizeMaxWorkers,
  normalizeTimeout,
  normalizeTunnelDirection,
  resolveHost,
  resolveViaSshG,
  selectClusterHosts,
  tunnelSpec,
} from './ssh-command.js'

/** Plugin name; must match `cordis.patch.yml`'s `id: snow-ssh`. */
export const name = 'snow-ssh'

/** Service dependency: the tool registry. */
export const inject = ['tools']

/** Per-stream capture cap. SSH output can be a whole build log. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** sftp transfers get a fixed, generous budget. */
const SFTP_TIMEOUT_MS = 300_000

/** `ssh -G` only parses configuration; anything slower than this is a hang. */
const RESOLVE_TIMEOUT_MS = 20_000

/** How long a tunnel must stay alive before we call it started. */
const TUNNEL_STARTUP_MS = 1_500

/** How much tunnel stderr to keep for the "it died" note. */
const TUNNEL_STDERR_BYTES = 64 * 1024

/** Exit code reported for a command our own timeout killed (matches timeout(1)). */
const TIMEOUT_EXIT_CODE = 124

// ---------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------

/** Head+cap collector: keeps memory bounded no matter what the remote prints. */
class OutputCollector {
  constructor(limitBytes) {
    this.limitBytes = limitBytes
    this.chunks = []
    this.bytes = 0
    this.truncated = false
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(String(chunk))
    if (this.bytes >= this.limitBytes) {
      this.truncated = true
      return
    }
    const remaining = this.limitBytes - this.bytes
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining))
      this.bytes = this.limitBytes
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString() {
    const text = Buffer.concat(this.chunks).toString('utf8')
    return this.truncated ? `${text}\n[... output truncated at ${this.limitBytes} bytes ...]` : text
  }
}

/**
 * Kill the process AND its children.
 *
 * On Windows `child.kill()` only terminates ssh.exe itself; a forwarded
 * process tree is better handled by `taskkill /T /F`, so we do both. Both
 * calls are best-effort: a process that already exited is not an error.
 */
function killTree(child) {
  if (!child || typeof child.pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      /* fall through to child.kill */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

function describeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    return new Error(
      'OpenSSH client not found: "ssh" is not on PATH. Windows 10+ ships it ' +
        '(Settings → Apps → Optional Features → OpenSSH Client); install it or add it to PATH.',
    )
  }
  return new Error(`failed to start the OpenSSH client: ${error?.message ?? String(error)}`)
}

/**
 * Run one child process, capture stdout/stderr separately, and make the
 * timeout real: when it expires the process tree is killed and the promise
 * still resolves with whatever was captured plus `timedOut: true`.
 *
 * `options.stdin` (a string) is written to the child's stdin and closed — that
 * is how `sftp -b -` receives its batch without a temporary file. A child that
 * exits before reading makes the write fail with EPIPE; that is not an error we
 * report, because the exit code and stderr already say what happened.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs: number, signal?: AbortSignal, stdin?: string }} options
 */
function runProcess(file, args, options) {
  return new Promise((resolve) => {
    const useStdin = typeof options.stdin === 'string'
    let child
    try {
      child = spawn(file, args, {
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: error })
      return
    }

    const stdout = new OutputCollector(MAX_CAPTURE_BYTES)
    const stderr = new OutputCollector(MAX_CAPTURE_BYTES)
    let settled = false
    let timedOut = false
    let aborted = false
    let timer

    const finish = (code, signalName, spawnError) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) {
        try {
          options.signal.removeEventListener('abort', onAbort)
        } catch {
          /* noop */
        }
      }
      resolve({
        code,
        signal: signalName ?? null,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        aborted,
        spawnError,
      })
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree(child)
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (code, signalName) => finish(code, signalName, undefined))

    if (useStdin && child.stdin !== null) {
      child.stdin.on('error', () => {
        /* EPIPE: the child exited before reading the batch — the exit code reports it */
      })
      child.stdin.end(options.stdin, 'utf8')
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else {
        try {
          options.signal.addEventListener('abort', onAbort, { once: true })
        } catch {
          /* noop */
        }
      }
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killTree(child)
      }, options.timeoutMs)
    }
  })
}

function appendNote(text, note) {
  const body = typeof text === 'string' ? text.replace(/\n$/, '') : ''
  return body === '' ? note : `${body}\n${note}`
}

// ---------------------------------------------------------------------------
// host list
// ---------------------------------------------------------------------------

async function loadHostList() {
  try {
    return await loadHosts()
  } catch (error) {
    if (error instanceof HostsError) throw new Error(`[snow-ssh] ${error.message}`)
    throw error
  }
}

function publicHost(host) {
  const record = {
    alias: host.alias,
    host: host.host,
    port: host.port,
    user: host.user,
    tags: host.tags,
  }
  if (host.environment !== undefined) record.environment = host.environment
  if (host.description !== undefined) record.description = host.description
  if (host.identityFile !== undefined) record.identityFile = host.identityFile
  if (host.proxyJump !== undefined) record.proxyJump = host.proxyJump
  return record
}

// ---------------------------------------------------------------------------
// ssh_exec core (shared by ssh_exec and ssh_cluster)
// ---------------------------------------------------------------------------

/**
 * @param {object} host - normalized host record.
 * @param {string} command - remote shell line.
 * @param {{ timeoutMs: number, signal?: AbortSignal, extraOptions?: unknown }} options
 * @returns {Promise<{ alias: string, exitCode: number, stdout: string, stderr: string }>}
 */
async function execOnHost(host, command, options) {
  const argv = buildSshExecArgv(host, command, {
    connectTimeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, options.timeoutMs),
    extraOptions: options.extraOptions,
  })
  const result = await runProcess('ssh', argv, options)
  if (result.spawnError !== undefined) throw describeSpawnError(result.spawnError)
  if (result.aborted) throw new Error(`ssh_exec on "${host.alias}" was aborted by the harness`)
  if (result.timedOut) {
    return {
      alias: host.alias,
      exitCode: TIMEOUT_EXIT_CODE,
      stdout: result.stdout,
      stderr: appendNote(
        result.stderr,
        `[snow-ssh] timed out after ${options.timeoutMs}ms; the local ssh process tree was killed`,
      ),
    }
  }
  if (result.code === null) {
    return {
      alias: host.alias,
      exitCode: SSH_FAILURE_EXIT_CODE,
      stdout: result.stdout,
      stderr: appendNote(result.stderr, `[snow-ssh] ssh terminated by signal ${result.signal ?? 'unknown'}`),
    }
  }
  // A non-zero exit code is NOT an error: it is the answer the caller asked for.
  return { alias: host.alias, exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run `ssh -G` for one host record. Throws (never returns an empty object) when
 * ssh is missing, times out, or exits non-zero.
 *
 * @param {string[]} argv
 */
async function runSshG(argv) {
  const result = await runProcess('ssh', argv, { timeoutMs: RESOLVE_TIMEOUT_MS })
  if (result.spawnError !== undefined) throw describeSpawnError(result.spawnError)
  if (result.timedOut) {
    throw new Error(`ssh -G did not finish within ${RESOLVE_TIMEOUT_MS}ms; the local ssh process tree was killed`)
  }
  return result
}

// ---------------------------------------------------------------------------
// tunnel registry (module scope, one per loaded plugin instance)
// ---------------------------------------------------------------------------

/**
 * Live and recently-dead tunnels. A dead record is KEPT with `alive: false` so
 * `action: list` can answer "is it still up" instead of silently forgetting the
 * tunnel; `stop` removes it for good.
 *
 * @type {Map<string, { child: import('node:child_process').ChildProcess, public: object }>}
 */
const tunnels = new Map()
let tunnelCounter = 0
let cleanupRegistered = false

function ensureCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  // Last-resort cleanup so a harness exit does not leave forwards behind.
  process.once('exit', () => {
    for (const record of tunnels.values()) {
      try {
        record.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    tunnels.clear()
  })
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => {
        if (port > 0) resolvePort(port)
        else reject(new Error('could not allocate a free local port'))
      })
    })
  })
}

/** Keep `alive` honest even if an exit event was missed (e.g. after a hard kill). */
function syncLiveness(record) {
  if (record.public.alive !== true) return
  const child = record.child
  if (child.exitCode !== null || child.signalCode !== null) {
    record.public.alive = false
    if (record.public.endedAt === undefined) record.public.endedAt = new Date().toISOString()
    if (typeof child.exitCode === 'number' && record.public.exitCode === undefined) {
      record.public.exitCode = child.exitCode
    }
  }
}

/**
 * Spawn one `ssh -N <forward>` and resolve once it has survived the startup
 * window. `ExitOnForwardFailure=yes` turns a bind failure into an early exit,
 * which we report with ssh's own stderr instead of pretending the tunnel works.
 */
function startTunnelProcess(argv, info) {
  return new Promise((resolveTunnel, rejectTunnel) => {
    let child
    try {
      child = spawn('ssh', argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false })
    } catch (error) {
      rejectTunnel(describeSpawnError(error))
      return
    }
    const stderr = new OutputCollector(TUNNEL_STDERR_BYTES)
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolveTunnel({ child })
    }, TUNNEL_STARTUP_MS)

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectTunnel(error)
    }

    child.once('error', (error) => fail(describeSpawnError(error)))
    child.once('exit', (code, signalName) => {
      if (!settled) {
        fail(
          new Error(
            `ssh ${info.direction} tunnel exited during startup (code ${code}, signal ${signalName}): ` +
              `${stderr.toString().trim() || 'no stderr output'}`,
          ),
        )
        return
      }
      const record = tunnels.get(info.tunnelId)
      if (record === undefined) return
      record.public.alive = false
      record.public.endedAt = new Date().toISOString()
      if (typeof code === 'number') record.public.exitCode = code
      const detail = stderr.toString().trim()
      if (detail !== '') {
        record.public.note = detail.length > 600 ? `…${detail.slice(-600)}` : detail
      }
    })
  })
}

function stopTunnel(tunnelId) {
  const record = tunnels.get(tunnelId)
  if (record === undefined) {
    const active = tunnels.size > 0 ? [...tunnels.keys()].join(', ') : '(none)'
    throw new Error(`unknown tunnelId "${tunnelId}". Active tunnels: ${active}`)
  }
  killTree(record.child)
  record.public.alive = false
  if (record.public.endedAt === undefined) record.public.endedAt = new Date().toISOString()
  tunnels.delete(tunnelId)
  return record.public
}

function stopTunnelsForAlias(alias) {
  const matches = [...tunnels.entries()].filter(([, record]) => record.public.alias === alias)
  if (matches.length === 0) {
    const active = tunnels.size > 0 ? [...tunnels.keys()].join(', ') : '(none)'
    throw new Error(`no active tunnel for alias "${alias}". Active tunnels: ${active}`)
  }
  return matches.map(([id]) => stopTunnel(id))
}

// ---------------------------------------------------------------------------
// renderers (model-facing text)
// ---------------------------------------------------------------------------

function textOutput(content) {
  return [{ type: 'text', text: content }]
}

function renderExec(_args, value) {
  const lines = [`${value.alias} → exit ${value.exitCode}`]
  if (value.stdout !== '') lines.push('--- stdout ---', value.stdout.replace(/\n$/, ''))
  if (value.stderr !== '') lines.push('--- stderr ---', value.stderr.replace(/\n$/, ''))
  if (value.stdout === '' && value.stderr === '') lines.push('(no output)')
  return textOutput(lines.join('\n'))
}

function renderList(_args, value) {
  const header = `${value.count}/${value.total} host(s) — ${value.source}`
  const rows = value.hosts.map((host) => {
    const meta = []
    if (host.environment !== undefined) meta.push(`env=${host.environment}`)
    if (host.tags.length > 0) meta.push(`tags=${host.tags.join(',')}`)
    if (host.proxyJump !== undefined) meta.push(`via ${host.proxyJump}`)
    const suffix = host.description !== undefined ? ` — ${host.description}` : ''
    return `${host.alias}\t${host.user}@${host.host}:${host.port}${meta.length > 0 ? `  [${meta.join(' ')}]` : ''}${suffix}`
  })
  if (rows.length === 0) rows.push('(no hosts matched)')
  return textOutput([header, ...rows].join('\n'))
}

function renderCluster(_args, value) {
  const lines = [`${value.matched} host(s) — exit 0: ${value.succeeded}, failed: ${value.failed}`]
  for (const result of value.results) {
    lines.push('', `## ${result.alias} (${result.host}) → exit ${result.exitCode}`)
    if (result.error !== undefined) lines.push(`error: ${result.error}`)
    if (result.stdout !== '') lines.push('--- stdout ---', result.stdout.replace(/\n$/, ''))
    if (result.stderr !== '') lines.push('--- stderr ---', result.stderr.replace(/\n$/, ''))
  }
  return textOutput(lines.join('\n'))
}

function renderTransfer(_args, value) {
  const arrow = value.direction === 'upload' ? '→' : '←'
  const size = value.bytes === undefined ? '' : ` (${value.bytes} bytes)`
  const lines = [
    `${value.ok ? 'ok' : 'FAILED'} — ${value.direction} ${value.localPath} ${arrow} ` +
      `${value.alias}:${value.remotePath}${size}`,
  ]
  if (value.exitCode !== undefined) lines.push(`sftp exit ${value.exitCode}`)
  if (value.stderr !== '') lines.push(`stderr: ${value.stderr.replace(/\n$/, '')}`)
  if (value.stdout !== '') lines.push(`stdout: ${value.stdout.replace(/\n$/, '')}`)
  return textOutput(lines.join('\n'))
}

function renderTunnel(_args, value) {
  const lines = []
  if (value.action === 'start' && value.tunnelId !== undefined) {
    lines.push(
      `started ${value.tunnelId} (${value.direction}) ${value.localAddress} → ${value.target} — pid ${value.pid}`,
    )
  } else if (value.action === 'stop' || value.action === 'stop-all') {
    const ids = value.tunnelIds === undefined || value.tunnelIds.length === 0 ? '' : `: ${value.tunnelIds.join(', ')}`
    lines.push(`stopped ${value.stopped} tunnel(s)${ids}`)
  } else if (value.action === 'list') {
    lines.push(`${value.count} tunnel(s)`)
  }
  for (const tunnel of value.tunnels ?? []) {
    lines.push(
      `${tunnel.tunnelId}\t${tunnel.direction}\t${tunnel.alive ? 'alive' : 'dead'}\t` +
        `${tunnel.localAddress} → ${tunnel.target}\t${tunnel.alias}\tsince ${tunnel.startedAt}`,
    )
    if (tunnel.note !== undefined) lines.push(`  last output: ${tunnel.note}`)
  }
  if (Array.isArray(value.tunnels) && value.tunnels.length === 0) lines.push('(none)')
  return textOutput(lines.join('\n'))
}

function renderResolve(_args, value) {
  const lines = [`${value.alias} → ${value.user}@${value.hostname}:${value.port}`]
  const rows = [
    ['proxyjump', value.proxyjump],
    ['proxycommand', value.proxycommand],
    ['identityfile', value.identityfile.join(' ')],
    ['controlmaster', value.controlmaster],
    ['forwardagent', value.forwardagent],
    ['localforward', value.localforward.join(' | ')],
    ['remoteforward', value.remoteforward.join(' | ')],
    ['dynamicforward', value.dynamicforward.join(' | ')],
    ['serveraliveinterval', String(value.serveraliveinterval)],
    ['connecttimeout', value.connecttimeout],
  ]
  for (const [key, text] of rows) lines.push(`${key}: ${text === '' ? '(none)' : text}`)
  return textOutput(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// shared parameter descriptions
// ---------------------------------------------------------------------------

const OPTIONS_PARAMETER_DESCRIPTION =
  'Extra `-o Key=Value` ssh options, e.g. ["ServerAliveInterval=15","Compression=yes"]. ' +
  'They are placed BEFORE the built-in safety options (OpenSSH uses the first value it sees). ' +
  'Refused with an explicit error: ProxyCommand, LocalCommand, PermitLocalCommand — they run ' +
  'an arbitrary program on THIS machine, which is outside what an SSH channel tool does.'

/** A fresh parameter object per tool: defineTool compiles these, so never share one. */
function optionsParameter() {
  return { type: 'array', items: { type: 'string' }, description: OPTIONS_PARAMETER_DESCRIPTION }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const sshList = defineTool({
    name: 'ssh_list',
    description:
      'List the SSH hosts this machine can reach (from ~/.dsh/ssh/hosts.json). ' +
      'Returns alias/host/user/port/tags/environment/description/proxyJump. ' +
      'Optional `query` is a fuzzy match over alias, description, host and tags; ' +
      '`tags` (all must match) and `environment` narrow the list further.',
    parameters: {
      query: { type: 'string', description: 'Fuzzy match over alias / description / host / tags (case-insensitive).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only hosts carrying EVERY one of these tags.' },
      environment: { type: 'string', description: 'Only hosts whose environment matches exactly.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          total: { type: 'integer' },
          source: { type: 'string' },
          imported: { type: 'boolean' },
          importedCount: { type: 'integer' },
          hosts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                user: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                environment: { type: 'string' },
                description: { type: 'string' },
                identityFile: { type: 'string' },
                proxyJump: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderList,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const loaded = await loadHostList()
      const selected = filterHosts(loaded.hosts, {
        query: args.query,
        tags: args.tags,
        environment: args.environment,
      })
      const value = {
        count: selected.length,
        total: loaded.hosts.length,
        source: loaded.source,
        imported: loaded.imported === true,
        hosts: selected.map(publicHost),
      }
      if (loaded.importedCount !== undefined) value.importedCount = loaded.importedCount
      return value
    },
  })

  const sshExec = defineTool({
    name: 'ssh_exec',
    description:
      'Run one command on a configured SSH host and return {alias, exitCode, stdout, stderr}. ' +
      'A non-zero exitCode is returned as data, not as a tool error, so failures stay visible. ' +
      'The command runs in the remote user\'s shell; stdin is closed and BatchMode is on, so it ' +
      'must not expect a password prompt. Timeout (default 60000 ms) kills the local ssh process tree. ' +
      'Use `options` for extra -o settings; the host record\'s proxyJump becomes `-J`.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ~/.dsh/ssh/hosts.json.' },
      command: { type: 'string', required: true, description: 'The shell line to run on the remote host.' },
      timeoutMs: {
        type: 'number',
        description: 'Command timeout in milliseconds (1000-600000, default 60000). On expiry the local ssh tree is killed and exitCode is 124.',
      },
      options: optionsParameter(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: renderExec,
    },
    timeoutMs: 660_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const loaded = await loadHostList()
      const host = resolveHost(loaded.hosts, args.alias)
      const timeoutMs = normalizeTimeout(args.timeoutMs, 60_000)
      return execOnHost(host, args.command, {
        timeoutMs,
        signal: exec?.signal,
        extraOptions: args.options,
      })
    },
  })

  async function transfer(args, direction, exec) {
    const loaded = await loadHostList()
    const host = resolveHost(loaded.hosts, args.alias)
    const extraOptions = normalizeExtraOptions(args.options)
    // Validates both paths (newlines would start a second sftp command) and
    // builds the one-line batch that goes to the child's stdin.
    const batch = buildSftpBatch(direction, args.localPath, args.remotePath)
    const argv = buildSftpArgv(host, {
      extraOptions,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    })
    const result = await runProcess('sftp', argv, {
      timeoutMs: SFTP_TIMEOUT_MS,
      signal: exec?.signal,
      stdin: batch,
    })
    if (result.spawnError !== undefined) throw describeSpawnError(result.spawnError)
    if (result.aborted) throw new Error(`ssh_${direction} was aborted by the harness`)
    if (result.timedOut) {
      throw new Error(`ssh_${direction} timed out after ${SFTP_TIMEOUT_MS}ms; the local sftp process tree was killed`)
    }

    const value = {
      alias: host.alias,
      direction,
      localPath: args.localPath,
      remotePath: args.remotePath,
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    }
    if (!value.ok) {
      value.exitCode = typeof result.code === 'number' ? result.code : SSH_FAILURE_EXIT_CODE
      if (value.stderr.trim() === '') {
        value.stderr =
          `sftp exited with code ${value.exitCode} and printed nothing ` +
          '(a missing source file or an unwritable destination looks like this)'
      }
      return value
    }
    const size = await stat(args.localPath).then(
      (info) => (info.isFile() ? info.size : undefined),
      () => undefined,
    )
    if (typeof size === 'number') value.bytes = size
    return value
  }

  const sshUpload = defineTool({
    name: 'ssh_upload',
    description:
      'Copy a LOCAL file to a configured SSH host with `sftp -b -` (the batch goes to stdin, ' +
      'no temporary file). Paths are quoted for sftp\'s batch grammar, so spaces are fine; a ' +
      'path containing a double quote is refused (that grammar has no escape for one). ' +
      'Returns {alias, direction, localPath, remotePath, ok, bytes?, exitCode?, stdout, stderr} — ' +
      'a failed transfer returns ok:false with sftp\'s stderr verbatim instead of throwing it away.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ~/.dsh/ssh/hosts.json.' },
      localPath: { type: 'string', required: true, description: 'Absolute path of the file on THIS machine.' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the remote host (may contain spaces).' },
      options: optionsParameter(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          direction: { type: 'string' },
          localPath: { type: 'string' },
          remotePath: { type: 'string' },
          ok: { type: 'boolean' },
          bytes: { type: 'integer' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: renderTransfer,
    },
    timeoutMs: 330_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return transfer(args, 'upload', exec)
    },
  })

  const sshDownload = defineTool({
    name: 'ssh_download',
    description:
      'Copy a REMOTE file from a configured SSH host to this machine with `sftp -b -` ' +
      '(the batch goes to stdin, no temporary file). Returns {alias, direction, localPath, ' +
      'remotePath, ok, bytes?, exitCode?, stdout, stderr}; a failed transfer returns ok:false ' +
      'with sftp\'s stderr verbatim.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ~/.dsh/ssh/hosts.json.' },
      remotePath: { type: 'string', required: true, description: 'Path of the file on the remote host (may contain spaces).' },
      localPath: { type: 'string', required: true, description: 'Destination path on THIS machine.' },
      options: optionsParameter(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          direction: { type: 'string' },
          localPath: { type: 'string' },
          remotePath: { type: 'string' },
          ok: { type: 'boolean' },
          bytes: { type: 'integer' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: renderTransfer,
    },
    timeoutMs: 330_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return transfer(args, 'download', exec)
    },
  })

  const sshTunnel = defineTool({
    name: 'ssh_tunnel',
    description:
      'Manage port forwards over ssh. ' +
      'direction="local" (default, -L) listens HERE and connects from the SSH host to remoteHost:remotePort; ' +
      'direction="remote" (-R) listens ON THE SSH HOST at remotePort and forwards to remoteHost:localPort HERE; ' +
      'direction="dynamic" (-D) opens a SOCKS5 proxy HERE on localPort (no remoteHost/remotePort). ' +
      'action=start needs alias + remotePort (or just localPort for dynamic); localPort defaults to a free ' +
      'port for local/dynamic. action=list reports every tunnel with its direction, address, target, ' +
      'start time and whether it is still alive; action=stop takes tunnelId (or alias); action=stop-all ' +
      'kills everything. Tunnels live in this plugin process and die with it.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'list', 'stop', 'stop-all'],
        description: 'start | list | stop | stop-all',
      },
      direction: {
        type: 'string',
        enum: ['local', 'remote', 'dynamic'],
        description: 'local = -L (default), remote = -R, dynamic = -D (SOCKS5).',
      },
      alias: { type: 'string', description: 'Host alias (required by start; optional for stop).' },
      remotePort: {
        type: 'integer',
        description: 'local: the port on the far side; remote: the port to listen on ON THE SSH HOST.',
      },
      remoteHost: {
        type: 'string',
        description: 'local: target host as seen from the SSH host (default 127.0.0.1); remote: target host as seen from HERE.',
      },
      localPort: {
        type: 'integer',
        description: 'local/dynamic: listening port on THIS machine (default: an unused port). remote: the local port being exposed (required).',
      },
      tunnelId: { type: 'string', description: 'Tunnel id returned by start (required by stop unless alias is given).' },
      options: optionsParameter(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          tunnelId: { type: 'string' },
          alias: { type: 'string' },
          direction: { type: 'string' },
          localAddress: { type: 'string' },
          target: { type: 'string' },
          localPort: { type: 'integer' },
          remoteHost: { type: 'string' },
          remotePort: { type: 'integer' },
          pid: { type: 'integer' },
          startedAt: { type: 'string' },
          alive: { type: 'boolean' },
          endedAt: { type: 'string' },
          exitCode: { type: 'integer' },
          note: { type: 'string' },
          count: { type: 'integer' },
          stopped: { type: 'integer' },
          tunnelIds: { type: 'array', items: { type: 'string' } },
          tunnels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tunnelId: { type: 'string' },
                alias: { type: 'string' },
                direction: { type: 'string' },
                localAddress: { type: 'string' },
                target: { type: 'string' },
                localPort: { type: 'integer' },
                remoteHost: { type: 'string' },
                remotePort: { type: 'integer' },
                pid: { type: 'integer' },
                startedAt: { type: 'string' },
                alive: { type: 'boolean' },
                endedAt: { type: 'string' },
                exitCode: { type: 'integer' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderTunnel,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args.action
      if (action === 'list') {
        const list = [...tunnels.values()].map((record) => {
          syncLiveness(record)
          return record.public
        })
        return { action: 'list', count: list.length, tunnels: list }
      }
      if (action === 'stop-all') {
        const ids = [...tunnels.keys()]
        for (const id of ids) stopTunnel(id)
        return { action: 'stop-all', stopped: ids.length, tunnelIds: ids }
      }
      if (action === 'stop') {
        if (typeof args.tunnelId === 'string' && args.tunnelId.trim() !== '') {
          const stopped = stopTunnel(args.tunnelId.trim())
          return { action: 'stop', stopped: 1, tunnelIds: [stopped.tunnelId], tunnels: [stopped] }
        }
        if (typeof args.alias === 'string' && args.alias.trim() !== '') {
          const stopped = stopTunnelsForAlias(args.alias.trim())
          return {
            action: 'stop',
            stopped: stopped.length,
            tunnelIds: stopped.map((tunnel) => tunnel.tunnelId),
            tunnels: stopped,
          }
        }
        throw new Error('ssh_tunnel action=stop needs "tunnelId" (or "alias" to stop every tunnel of that host)')
      }

      // action === 'start'
      if (typeof args.alias !== 'string' || args.alias.trim() === '') {
        throw new Error('ssh_tunnel action=start needs "alias"')
      }
      const direction = normalizeTunnelDirection(args.direction)
      const loaded = await loadHostList()
      const host = resolveHost(loaded.hosts, args.alias)
      let localPort = args.localPort
      if ((localPort === undefined || localPort === null) && direction !== 'remote') {
        localPort = await findFreePort()
      }
      // tunnelSpec validates the whole combination and is the single source of
      // truth for the forward string, the displayed address and the target.
      const request = {
        direction,
        localPort,
        remoteHost: args.remoteHost,
        remotePort: args.remotePort,
      }
      const spec = tunnelSpec(host, request)
      const argv = buildTunnelArgv(host, {
        ...request,
        connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
        extraOptions: args.options,
      })

      ensureCleanup()
      tunnelCounter += 1
      const tunnelId = `tun-${Date.now().toString(36)}-${tunnelCounter}`
      const info = {
        tunnelId,
        alias: host.alias,
        direction: spec.direction,
        localAddress: spec.localAddress,
        target: spec.target,
        localPort: spec.localPort,
        startedAt: new Date().toISOString(),
      }
      if (spec.remoteHost !== undefined) info.remoteHost = spec.remoteHost
      if (spec.remotePort !== undefined) info.remotePort = spec.remotePort
      const { child } = await startTunnelProcess(argv, info)
      const publicInfo = { ...info, pid: child.pid ?? 0, alive: true }
      tunnels.set(tunnelId, { child, public: publicInfo })
      return { action: 'start', ...publicInfo }
    },
  })

  const sshCluster = defineTool({
    name: 'ssh_cluster',
    description:
      'Run the SAME command on several configured hosts in parallel and return every host\'s result. ' +
      'Pick hosts with `aliases`, `environment`, or `tags` — at least one selector is required, ' +
      'and all provided selectors must match (AND). Non-zero exit codes are per-host data, not tool errors.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell line to run on every selected host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Exact host aliases to target.' },
      environment: { type: 'string', description: 'Select hosts whose environment matches exactly.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Select hosts carrying EVERY tag listed.' },
      maxWorkers: { type: 'integer', description: 'Parallel hosts (1-64, default 8).' },
      timeoutMs: {
        type: 'number',
        description: 'Per-host command timeout in milliseconds (1000-600000, default 60000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          matched: { type: 'integer' },
          maxWorkers: { type: 'integer' },
          timeoutMs: { type: 'integer' },
          succeeded: { type: 'integer' },
          failed: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string' },
                host: { type: 'string' },
                exitCode: { type: 'integer' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderCluster,
    },
    timeoutMs: 660_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const timeoutMs = normalizeTimeout(args.timeoutMs, 60_000)
      const maxWorkers = normalizeMaxWorkers(args.maxWorkers)
      const loaded = await loadHostList()
      // Throws when no selector is given, when an alias is unknown, or when
      // the selectors match nothing: an empty fan-out is never silent.
      const selected = selectClusterHosts(loaded.hosts, {
        aliases: args.aliases,
        environment: args.environment,
        tags: args.tags,
      })
      const results = await mapWithConcurrency(selected, maxWorkers, async (host) => {
        try {
          const result = await execOnHost(host, args.command, { timeoutMs, signal: exec?.signal })
          return { ...result, host: host.host }
        } catch (error) {
          return {
            alias: host.alias,
            host: host.host,
            exitCode: SSH_FAILURE_EXIT_CODE,
            stdout: '',
            stderr: '',
            error: error?.message ?? String(error),
          }
        }
      })
      const succeeded = results.filter((result) => result.exitCode === 0 && result.error === undefined).length
      return {
        command: args.command,
        matched: results.length,
        maxWorkers,
        timeoutMs,
        succeeded,
        failed: results.length - succeeded,
        results,
      }
    },
  })

  const sshResolve = defineTool({
    name: 'ssh_resolve',
    description:
      'Ask the SYSTEM OpenSSH client how it would really connect to a configured alias: runs ' +
      '`ssh -G` with this host record overlaid (-o HostName/-o User/-o Port/-o IdentityFile/-o ProxyJump, ' +
      'so aliases that are not in ~/.ssh/config still resolve) and returns the effective configuration: ' +
      'hostname, user, port, proxyjump, proxycommand, identityfile, controlmaster, forwardagent, ' +
      'localforward, remoteforward, dynamicforward, serveraliveinterval, connecttimeout. ' +
      'Use it instead of trusting hosts.json — it reports what ssh will actually do. ' +
      'A failed `ssh -G` is an explicit error, never an empty result.',
    parameters: {
      alias: {
        type: 'string',
        required: true,
        description: 'Host alias from ~/.dsh/ssh/hosts.json (also the ssh destination used to select a ~/.ssh/config Host block).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string' },
          hostname: { type: 'string' },
          user: { type: 'string' },
          port: { type: 'integer' },
          proxyjump: { type: 'string' },
          proxycommand: { type: 'string' },
          identityfile: { type: 'array', items: { type: 'string' } },
          controlmaster: { type: 'string' },
          forwardagent: { type: 'string' },
          localforward: { type: 'array', items: { type: 'string' } },
          remoteforward: { type: 'array', items: { type: 'string' } },
          dynamicforward: { type: 'array', items: { type: 'string' } },
          serveraliveinterval: { type: 'integer' },
          connecttimeout: { type: 'string' },
        },
      },
      render: renderResolve,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const loaded = await loadHostList()
      const host = resolveHost(loaded.hosts, args.alias)
      return resolveViaSshG(host, { run: runSshG })
    },
  })

  ctx.tools.register(sshList)
  ctx.tools.register(sshExec)
  ctx.tools.register(sshUpload)
  ctx.tools.register(sshDownload)
  ctx.tools.register(sshTunnel)
  ctx.tools.register(sshCluster)
  ctx.tools.register(sshResolve)

  // Best-effort: kill tunnels when this plugin instance is unloaded.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const id of [...tunnels.keys()]) {
        try {
          stopTunnel(id)
        } catch {
          /* already gone */
        }
      }
    })
  }
}
