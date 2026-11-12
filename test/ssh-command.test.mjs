import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeHost } from '../lib/hosts.js'
import {
  buildSftpArgv,
  buildSftpBatch,
  buildSshExecArgv,
  buildTunnelArgv,
  filterHosts,
  formatAliases,
  mapWithConcurrency,
  matchesQuery,
  normalizeExtraOptions,
  normalizeMaxWorkers,
  normalizeProxyJump,
  normalizeTimeout,
  normalizeTunnelDirection,
  resolveHost,
  selectClusterHosts,
  sshDestinationArgs,
  sshOptionArgs,
  tunnelSpec,
  quoteSftpPath,
} from '../lib/ssh-command.js'

const HOME = path.join(os.tmpdir(), 'dsh-ssh-test-home')
const KEY = path.join(HOME, '.ssh/id_ed25519')

function host(overrides = {}) {
  return normalizeHost(
    { alias: 'node-b', host: '192.0.2.20', user: 'node-b', ...overrides },
    { home: HOME, source: 'test' },
  )
}

const FLEET = [
  { alias: 'web-a', host: '10.0.0.1', user: 'root', tags: ['web', 'prod'], environment: 'prod', description: 'front door' },
  { alias: 'web-b', host: '10.0.0.2', user: 'root', tags: ['web', 'dev'], environment: 'dev' },
  { alias: 'db-a', host: '10.0.0.3', user: 'root', tags: ['db', 'prod'], environment: 'prod' },
]

test('sshOptionArgs: fixed option order, identityFile and port included', () => {
  const record = host({ port: 2222, identityFile: '~/.ssh/id_ed25519' })
  assert.deepEqual(sshOptionArgs(record, { connectTimeoutMs: 60_000 }), [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=60',
    '-i',
    KEY,
    '-p',
    '2222',
  ])
})

test('sshOptionArgs: no -i without identityFile, default port still explicit', () => {
  assert.deepEqual(sshOptionArgs(host()), [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-p',
    '22',
  ])
})

test('sshOptionArgs: proxyJump becomes -J, including user@host:port and multi-hop chains', () => {
  const single = sshOptionArgs(host({ proxyJump: 'ops@bastion:2200' }))
  assert.deepEqual(single, [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-J',
    'ops@bastion:2200',
    '-p',
    '22',
  ])

  // Whitespace around hops is normalized, the hops themselves are verbatim.
  const multi = host({ proxyJump: ' jump1 , jump2:2200 ' })
  assert.equal(multi.proxyJump, 'jump1,jump2:2200')
  const argv = sshOptionArgs(multi)
  assert.equal(argv[argv.indexOf('-J') + 1], 'jump1,jump2:2200')

  const v6 = sshOptionArgs(host({ proxyJump: '[::1]:2200' }))
  assert.equal(v6[v6.indexOf('-J') + 1], '[::1]:2200')
})

test('proxyJump: malformed chains are rejected by name, with the offending hop', () => {
  const cases = [
    ['a b', /must not contain whitespace/],
    ['a,,b', /empty hop/],
    [',a', /empty hop/],
    ['bastion:0', /port 0 must be between 1 and 65535/],
    ['bastion:70000', /port 70000 must be between 1 and 65535/],
    ['bastion:ssh', /non-numeric port/],
    ['@bastion', /empty user/],
    ['user@', /empty host/],
    ['[::1', /unclosed "\["/],
    ['[::1]2200', /separate the IPv6 address and port/],
    [['bastion'], /must be a string \(got array\)/],
  ]
  for (const [value, pattern] of cases) {
    assert.throws(() => normalizeProxyJump(value), pattern, `proxyJump ${JSON.stringify(value)}`)
  }
  // Absent and blank both mean "no jump host" — never the literal string.
  assert.equal(normalizeProxyJump(undefined), undefined)
  assert.equal(normalizeProxyJump('   '), undefined)
  assert.equal(normalizeProxyJump(' [::1]:2200 '), '[::1]:2200')
})

test('buildSshExecArgv: destination then the command as ONE argv element', () => {
  const argv = buildSshExecArgv(host({ identityFile: '~/.ssh/id_ed25519' }), 'uptime', { connectTimeoutMs: 5_000 })
  assert.deepEqual(argv, [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=5',
    '-i',
    KEY,
    '-p',
    '22',
    '-l',
    'node-b',
    '192.0.2.20',
    'uptime',
  ])
})

test('buildSshExecArgv: proxyJump and options reach the same argv', () => {
  const argv = buildSshExecArgv(host({ proxyJump: 'bastion' }), 'uptime', {
    extraOptions: ['ServerAliveInterval=15'],
  })
  assert.deepEqual(argv.slice(0, 2), ['-o', 'ServerAliveInterval=15'])
  assert.equal(argv[argv.indexOf('-J') + 1], 'bastion')
  assert.equal(argv.at(-1), 'uptime')
})

test('buildSshExecArgv: shell metacharacters stay inside the remote command element', () => {
  const command = 'echo hello; rm -rf /tmp/x | tee out && $(whoami)'
  const argv = buildSshExecArgv(host(), command)
  assert.equal(argv.at(-1), command)
  assert.equal(argv.filter((part) => part === command).length, 1)
  // The local side adds no shell: no element is a fragment of the command.
  assert.equal(argv.includes(';'), false)
  assert.equal(argv.includes('&&'), false)
})

test('buildSshExecArgv: empty or blank commands are rejected', () => {
  assert.throws(() => buildSshExecArgv(host(), ''), /"command" must be a non-empty string/)
  assert.throws(() => buildSshExecArgv(host(), '   '), /"command" must be a non-empty string/)
  assert.throws(() => buildSshExecArgv(host(), undefined), /"command" must be a non-empty string/)
})

test('buildSshExecArgv: a host record without user/host is rejected', () => {
  assert.throws(() => buildSshExecArgv({ alias: 'x', host: 'h' }, 'uptime'), /has no "user"/)
  assert.throws(() => buildSshExecArgv({ alias: 'x', user: 'u' }, 'uptime'), /has no "host"/)
  assert.throws(() => buildSshExecArgv(null, 'uptime'), /host record is required/)
})

test('sshDestinationArgs: IPv6 literals are bracketed for ssh/sftp', () => {
  const record = normalizeHost({ alias: 'v6', host: '::1', user: 'root' }, { home: HOME })
  assert.deepEqual(sshDestinationArgs(record), ['-l', 'root', '[::1]'])
})

// ---------------------------------------------------------------------------
// sftp transfers (scp's legacy protocol is deprecated since OpenSSH 9.0, so
// the transfer path is sftp with the batch on stdin)
// ---------------------------------------------------------------------------

test('buildSftpArgv: -P for the port, -b - for stdin, user@host destination', () => {
  const argv = buildSftpArgv(host({ port: 2222, identityFile: '~/.ssh/id_ed25519' }), {
    connectTimeoutMs: 15_000,
  })
  assert.deepEqual(argv, [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-i',
    KEY,
    '-P',
    '2222',
    '-b',
    '-',
    'node-b@192.0.2.20',
  ])
})

test('buildSftpArgv: a jump host becomes -J and no batch file is ever named', () => {
  const argv = buildSftpArgv(host({ proxyJump: 'ops@bastion:2200' }))
  assert.equal(argv[argv.indexOf('-J') + 1], 'ops@bastion:2200')
  assert.equal(argv[argv.indexOf('-b') + 1], '-')
  assert.equal(argv.at(-1), 'node-b@192.0.2.20')
  assert.equal(argv.some((part) => /\.tmp$|batchfile/i.test(part)), false)
})

test('buildSftpBatch: put for upload, get for download, one quoted line each', () => {
  const local = path.join(os.tmpdir(), 'artifact.txt')
  assert.equal(buildSftpBatch('upload', local, '/srv/artifact.txt'), `put "${local}" "/srv/artifact.txt"\n`)
  assert.equal(buildSftpBatch('download', local, '/srv/artifact.txt'), `get "/srv/artifact.txt" "${local}"\n`)
})

test('buildSftpBatch: quotes group a path, backslashes pass through untouched', () => {
  assert.equal(
    buildSftpBatch('upload', '/tmp/a b.txt', '/srv/my file.txt'),
    'put "/tmp/a b.txt" "/srv/my file.txt"\n',
  )
  // Measured on OpenSSH 9.5p2: sftp strips the quotes and keeps every other
  // character, so a Windows path must NOT have its backslashes doubled.
  assert.equal(
    buildSftpBatch('download', 'C:\\tmp\\a b.txt', '/srv/x.txt'),
    'get "/srv/x.txt" "C:\\tmp\\a b.txt"\n',
  )
  assert.equal(buildSftpBatch('upload', '/tmp/$(id);x', '/srv/y'), 'put "/tmp/$(id);x" "/srv/y"\n')
  // The quoting helper is the single rule: every path is wrapped, always.
  assert.equal(quoteSftpPath('/plain'), '"/plain"')
})

test('buildSftpBatch: a double quote in a path is refused — the grammar has no escape for it', () => {
  // `get "/etc/a\"b"` makes sftp answer "Unterminated quoted argument", so
  // emitting it would be a failure far from its cause. Refusing is honest.
  assert.throws(() => buildSftpBatch('upload', '/tmp/a"b.txt', '/srv/c.txt'), /must not contain a double quote/)
  assert.throws(() => buildSftpBatch('download', '/tmp/a.txt', '/srv/c"d.txt'), /must not contain a double quote/)
  assert.throws(() => quoteSftpPath('a"b'), /must not contain a double quote/)
})

test('buildSftpBatch: a newline in a path is refused (it would start a second sftp command)', () => {
  assert.throws(() => buildSftpBatch('upload', '/tmp/a\n!calc.exe', '/srv/x'), /newline or a control character/)
  assert.throws(() => buildSftpBatch('upload', '/tmp/a', '/srv/x\r'), /newline or a control character/)
  assert.throws(() => buildSftpBatch('upload', '-oProxyCommand=x', '/srv/x'), /must not start with "-"/)
  assert.throws(() => buildSftpBatch('upload', '/tmp/a', '-srv/x'), /must not start with "-"/)
})

test('buildSftpBatch: an unknown direction or a blank path is an error, never a guess', () => {
  assert.throws(
    () => buildSftpBatch('sideways', '/tmp/a', '/srv/x'),
    /"direction" must be "upload" or "download"/,
  )
  assert.throws(() => buildSftpBatch('upload', '', '/srv/x'), /"localPath" must be a non-empty string/)
  assert.throws(() => buildSftpBatch('upload', '/tmp/a', '   '), /"remotePath" must be a non-empty string/)
})

// ---------------------------------------------------------------------------
// tunnels: -L, -R and -D
// ---------------------------------------------------------------------------

test('buildTunnelArgv: -N -L <local>:<remoteHost>:<remotePort> before the destination', () => {
  const argv = buildTunnelArgv(host({ identityFile: '~/.ssh/id_ed25519' }), {
    localPort: 18080,
    remotePort: 5432,
    connectTimeoutMs: 15_000,
  })
  assert.deepEqual(argv.slice(0, 8), [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-i',
    KEY,
  ])
  assert.deepEqual(argv.slice(-8), ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '18080:127.0.0.1:5432', '-l', 'node-b', '192.0.2.20'])
  assert.equal(argv.at(-1), '192.0.2.20')
})

test('buildTunnelArgv: custom remoteHost and port validation', () => {
  const argv = buildTunnelArgv(host(), { localPort: 15432, remoteHost: 'db.internal', remotePort: 5432 })
  assert.ok(argv.includes('15432:db.internal:5432'))
  assert.throws(() => buildTunnelArgv(host(), { localPort: 0, remotePort: 5432 }), /"localPort" must be an integer/)
  assert.throws(() => buildTunnelArgv(host(), { localPort: 15432, remotePort: 70000 }), /"remotePort" must be an integer/)
  assert.throws(() => buildTunnelArgv(host(), { localPort: 15432, remotePort: 5432, remoteHost: ' ' }), /"remoteHost"/)
})

test('buildTunnelArgv: direction=remote puts -R in front of the remote listen port', () => {
  const argv = buildTunnelArgv(host(), {
    direction: 'remote',
    localPort: 3000,
    remotePort: 8080,
    remoteHost: 'db.internal',
  })
  assert.deepEqual(argv.slice(-8), ['-N', '-o', 'ExitOnForwardFailure=yes', '-R', '8080:db.internal:3000', '-l', 'node-b', '192.0.2.20'])
})

test('buildTunnelArgv: direction=dynamic is -D with only the local port', () => {
  const argv = buildTunnelArgv(host(), { direction: 'dynamic', localPort: 1080 })
  assert.deepEqual(argv.slice(-8), ['-N', '-o', 'ExitOnForwardFailure=yes', '-D', '1080', '-l', 'node-b', '192.0.2.20'])
  assert.equal(argv.includes('-L'), false)
  assert.equal(argv.includes('-R'), false)
})

test('buildTunnelArgv: dynamic refuses remoteHost/remotePort instead of ignoring them', () => {
  assert.throws(
    () => buildTunnelArgv(host(), { direction: 'dynamic', localPort: 1080, remoteHost: 'localhost' }),
    /"remoteHost" has no meaning/,
  )
  assert.throws(
    () => buildTunnelArgv(host(), { direction: 'dynamic', localPort: 1080, remotePort: 5432 }),
    /"remotePort" has no meaning/,
  )
})

test('buildTunnelArgv: direction=remote needs remotePort AND localPort', () => {
  assert.throws(
    () => buildTunnelArgv(host(), { direction: 'remote', localPort: 3000 }),
    /"remotePort" must be an integer .*it is required for direction="remote"/,
  )
  assert.throws(
    () => buildTunnelArgv(host(), { direction: 'remote', remotePort: 8080 }),
    /direction="remote" \(-R\) needs "localPort"/,
  )
})

test('normalizeTunnelDirection: defaults to local and rejects anything else', () => {
  assert.equal(normalizeTunnelDirection(undefined), 'local')
  assert.equal(normalizeTunnelDirection(' LOCAL '), 'local')
  assert.equal(normalizeTunnelDirection('remote'), 'remote')
  assert.equal(normalizeTunnelDirection('dynamic'), 'dynamic')
  assert.throws(() => normalizeTunnelDirection('socks'), /must be one of "local" \(-L\)/)
  assert.throws(() => normalizeTunnelDirection(42), /must be a string/)
})

test('tunnelSpec: each direction reports where it listens and what it forwards to', () => {
  const local = tunnelSpec(host(), { localPort: 18080, remotePort: 5432 })
  assert.equal(local.direction, 'local')
  assert.equal(local.localAddress, '127.0.0.1:18080')
  assert.equal(local.target, '127.0.0.1:5432')
  assert.equal(local.forward, '18080:127.0.0.1:5432')

  const remote = tunnelSpec(host(), { direction: 'remote', localPort: 3000, remotePort: 8080 })
  assert.equal(remote.forward, '8080:127.0.0.1:3000')
  assert.equal(remote.localAddress, 'node-b:8080')
  assert.equal(remote.target, '127.0.0.1:3000')

  const dynamic = tunnelSpec(host(), { direction: 'dynamic', localPort: 1080 })
  assert.equal(dynamic.forward, '1080')
  assert.match(dynamic.target, /socks5/)
})

test('buildTunnelArgv: caller options ride in front of the fixed options', () => {
  const argv = buildTunnelArgv(host(), {
    localPort: 18080,
    remotePort: 5432,
    extraOptions: ['ServerAliveInterval=30'],
  })
  assert.deepEqual(argv.slice(0, 2), ['-o', 'ServerAliveInterval=30'])
  assert.ok(argv.indexOf('ServerAliveInterval=30') < argv.indexOf('BatchMode=yes'))
})

// ---------------------------------------------------------------------------
// extra -o options
// ---------------------------------------------------------------------------

test('options: caller options come FIRST, so OpenSSH actually uses them', () => {
  const argv = sshOptionArgs(host(), { extraOptions: ['ServerAliveInterval=15', 'Compression=yes'] })
  assert.deepEqual(argv.slice(0, 4), ['-o', 'ServerAliveInterval=15', '-o', 'Compression=yes'])
  // The safety defaults still follow: a caller adds options, it does not replace them.
  assert.ok(argv.includes('BatchMode=yes'))
  assert.ok(argv.indexOf('ServerAliveInterval=15') < argv.indexOf('BatchMode=yes'))
})

test('options: the three local-execution keys are refused by name, with the reason', () => {
  for (const key of ['ProxyCommand', 'LocalCommand', 'PermitLocalCommand']) {
    assert.throws(
      () => normalizeExtraOptions([`${key}=/bin/sh -c whoami`]),
      (error) => {
        assert.match(error.message, new RegExp(key), 'the message names the key')
        assert.match(error.message, /THIS machine/, 'the message says why')
        assert.match(error.message, /refused instead of silently ignored/)
        assert.match(error.message, /"options\[0\]"/)
        return true
      },
      key,
    )
  }
  // ssh option keywords are case-insensitive, so the refusal is too.
  for (const key of ['proxycommand', 'PROXYCOMMAND', 'permitlocalcommand']) {
    assert.throws(() => normalizeExtraOptions([`${key}=x`]), /refused/)
  }
  assert.match(normalizeExtraOptions([`X=${'a'}`])[0], /^X=a$/)
})

test('options: shape validation refuses anything that is not one Key=Value keyword', () => {
  assert.deepEqual(normalizeExtraOptions(undefined), [])
  assert.deepEqual(normalizeExtraOptions([' ServerAliveInterval = 15 ']), ['ServerAliveInterval=15'])
  assert.throws(() => normalizeExtraOptions('ServerAliveInterval=15'), /must be an array/)
  assert.throws(() => normalizeExtraOptions([15]), /must be a string \(got number\)/)
  assert.throws(() => normalizeExtraOptions(['  ']), /must not be blank/)
  assert.throws(() => normalizeExtraOptions(['ServerAliveInterval']), /must look like "ServerAliveInterval=15"/)
  assert.throws(() => normalizeExtraOptions(['=15']), /single ssh option keyword/)
  assert.throws(() => normalizeExtraOptions(['Foo Bar=1']), /single ssh option keyword/)
  // A newline would start a second configuration line: it is not forwarded.
  assert.throws(
    () => normalizeExtraOptions(['ProxyJump=bastion\nProxyCommand=evil']),
    /control characters or newlines/,
  )
})

// ---------------------------------------------------------------------------
// aliases and host selection
// ---------------------------------------------------------------------------

test('resolveHost: returns the record for a known alias', () => {
  const record = host()
  assert.equal(resolveHost([record], 'node-b'), record)
  assert.equal(resolveHost([record], '  node-b  '), record)
})

test('resolveHost: an unknown alias throws and lists every available alias', () => {
  assert.throws(
    () => resolveHost([host(), host({ alias: 'node-c' })], 'nope'),
    (error) => {
      assert.match(error.message, /unknown SSH host alias "nope"/)
      assert.match(error.message, /Available aliases: node-b, node-c/)
      return true
    },
  )
})

test('resolveHost: an empty list says so instead of failing silently', () => {
  assert.throws(() => resolveHost([], 'node-b'), /no hosts are configured yet/)
  assert.throws(() => resolveHost([], ''), /"alias" must be a non-empty string/)
})

test('filterHosts: tags are AND-ed (every requested tag must be present)', () => {
  assert.deepEqual(filterHosts(FLEET, { tags: ['web'] }).map((h) => h.alias), ['web-a', 'web-b'])
  assert.deepEqual(filterHosts(FLEET, { tags: ['web', 'prod'] }).map((h) => h.alias), ['web-a'])
  assert.deepEqual(filterHosts(FLEET, { tags: ['db'] }).map((h) => h.alias), ['db-a'])
})

test('filterHosts: environment, aliases and their combination narrow the set', () => {
  assert.deepEqual(filterHosts(FLEET, { environment: 'prod' }).map((h) => h.alias), ['web-a', 'db-a'])
  assert.deepEqual(filterHosts(FLEET, { aliases: ['db-a', 'web-b'] }).map((h) => h.alias), ['web-a', 'web-b', 'db-a'].filter((a) => ['db-a', 'web-b'].includes(a)))
  assert.deepEqual(filterHosts(FLEET, { environment: 'prod', tags: ['db'] }).map((h) => h.alias), ['db-a'])
  assert.deepEqual(filterHosts(FLEET, { environment: 'nope' }), [])
})

test('filterHosts: an unknown alias in the selector throws, listing what exists', () => {
  assert.throws(() => filterHosts(FLEET, { aliases: ['ghost'] }), /unknown SSH host alias: ghost. Available aliases: web-a, web-b, db-a/)
})

test('matchesQuery: fuzzy over alias/description/host/tags, tokens AND-ed', () => {
  assert.equal(matchesQuery(FLEET[0], 'front'), true) // description
  assert.equal(matchesQuery(FLEET[0], 'WEB'), true) // tag, case-insensitive
  assert.equal(matchesQuery(FLEET[0], '10.0.0.1'), true) // host
  assert.equal(matchesQuery(FLEET[0], 'web prod'), true) // two tokens, both hit
  assert.equal(matchesQuery(FLEET[0], 'web dev'), false) // second token misses
  assert.equal(matchesQuery(FLEET[0], '   '), true) // no query = keep
  assert.deepEqual(filterHosts(FLEET, { query: 'prod' }).map((h) => h.alias), ['web-a', 'db-a'])
  assert.deepEqual(filterHosts(FLEET, { query: 'no-such-thing' }), [])
})

test('selectClusterHosts: no selector at all is a hard error', () => {
  assert.throws(() => selectClusterHosts(FLEET, {}), /requires at least one selector/)
  assert.throws(() => selectClusterHosts(FLEET, { aliases: [], tags: [], environment: '  ' }), /requires at least one selector/)
})

test('selectClusterHosts: selectors that match nothing are a hard error, not an empty fan-out', () => {
  assert.throws(() => selectClusterHosts(FLEET, { tags: ['nope'] }), /no hosts matched/)
  assert.throws(() => selectClusterHosts(FLEET, { environment: 'qa' }), /no hosts matched/)
})

test('selectClusterHosts: matching selectors return the right subset', () => {
  assert.deepEqual(selectClusterHosts(FLEET, { environment: 'prod' }).map((h) => h.alias), ['web-a', 'db-a'])
  assert.deepEqual(selectClusterHosts(FLEET, { aliases: ['web-b'] }).map((h) => h.alias), ['web-b'])
  assert.deepEqual(selectClusterHosts(FLEET, { tags: ['prod'], environment: 'prod' }).map((h) => h.alias), ['web-a', 'db-a'])
})

test('normalizeTimeout / normalizeMaxWorkers: bounds are enforced', () => {
  assert.equal(normalizeTimeout(undefined, 60_000), 60_000)
  assert.equal(normalizeTimeout(1_000, 60_000), 1_000)
  assert.equal(normalizeTimeout(600_000, 60_000), 600_000)
  assert.throws(() => normalizeTimeout(999, 60_000), /between 1000 and 600000/)
  assert.throws(() => normalizeTimeout(600_001, 60_000), /between 1000 and 600000/)
  assert.throws(() => normalizeTimeout('1000', 60_000), /between 1000 and 600000/)

  assert.equal(normalizeMaxWorkers(undefined), 8)
  assert.equal(normalizeMaxWorkers(1), 1)
  assert.throws(() => normalizeMaxWorkers(0), /between 1 and 64/)
  assert.throws(() => normalizeMaxWorkers(65), /between 1 and 64/)
  assert.throws(() => normalizeMaxWorkers(2.5), /between 1 and 64/)
})

test('mapWithConcurrency: caps in-flight work and preserves input order', async () => {
  const items = Array.from({ length: 11 }, (_, index) => index)
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency(items, 3, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return item * 2
  })

  assert.equal(peak, 3)
  assert.deepEqual(results, items.map((item) => item * 2))
})

test('mapWithConcurrency: handles empty input and a limit larger than the list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), [])
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency([1, 2], 10, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return item
  })
  assert.deepEqual(results, [1, 2])
  assert.equal(peak, 2)
})

test('formatAliases: names every alias, or says none are configured', () => {
  assert.equal(formatAliases(FLEET), 'web-a, web-b, db-a')
  assert.equal(formatAliases([]), '(none configured)')
  assert.equal(formatAliases(undefined), '(none configured)')
})
