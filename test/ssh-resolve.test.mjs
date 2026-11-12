/**
 * `ssh_resolve` — the `ssh -G` layer.
 *
 * Nothing here spawns ssh: `resolveViaSshG` takes an injected runner, which is
 * exactly how the failure path ("ssh -G failed" must be an error, never an
 * empty object) can be tested without a server and without a hard dependency
 * on the local OpenSSH build.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeHost } from '../lib/hosts.js'
import {
  buildResolveArgv,
  extractResolvedConfig,
  parseSshGOutput,
  resolveViaSshG,
} from '../lib/ssh-command.js'

const HOME = path.join(os.tmpdir(), 'dsh-ssh-test-home')
const KEY = path.join(HOME, '.ssh/id_ed25519')

function host(overrides = {}) {
  return normalizeHost(
    { alias: 'node-b', host: '192.0.2.20', user: 'node-b', ...overrides },
    { home: HOME, source: 'test' },
  )
}

/**
 * A real `ssh -G` dump (OpenSSH_for_Windows_9.5p2), shortened to the lines we
 * read. `proxyjump` is in the normalized form ssh prints for a bracketed IPv6
 * jump host with a port.
 */
const SSH_G = [
  'host node-b',
  'hostname 192.0.2.20',
  'user node-b',
  'port 2200',
  'proxyjump bastion@[10.0.0.5]:2200',
  'proxycommand none',
  `identityfile ${KEY}`,
  'identityfile ~/.ssh/id_rsa',
  'controlmaster false',
  'forwardagent no',
  'localforward 8080 127.0.0.1:5432',
  'serveraliveinterval 15',
  'connecttimeout none',
  '',
].join('\r\n')

/** An injected runner that records the argv and returns a canned result. */
function fakeRunner(result) {
  const calls = []
  return {
    calls,
    async run(argv) {
      calls.push(argv)
      return result
    },
  }
}

test('buildResolveArgv: -G, the host-record overlays, then the alias as destination', () => {
  const argv = buildResolveArgv(
    host({ identityFile: '~/.ssh/id_ed25519', proxyJump: 'jump1,jump2:2200' }),
  )
  assert.deepEqual(argv, [
    '-G',
    '-o',
    'HostName=192.0.2.20',
    '-o',
    'User=node-b',
    '-o',
    'Port=22',
    '-o',
    `IdentityFile=${KEY}`,
    '-o',
    'ProxyJump=jump1,jump2:2200',
    'node-b',
  ])
})

test('buildResolveArgv: a bare host record overlays the three required values only', () => {
  const argv = buildResolveArgv(host())
  assert.deepEqual(argv, [
    '-G',
    '-o',
    'HostName=192.0.2.20',
    '-o',
    'User=node-b',
    '-o',
    'Port=22',
    'node-b',
  ])
  // Our safety defaults are NOT part of "how would this connect": they would
  // mask the very values (connecttimeout, serveraliveinterval) we report.
  assert.equal(argv.includes('BatchMode=yes'), false)
  assert.equal(argv.some((part) => part.startsWith('ConnectTimeout=')), false)
})

test('buildResolveArgv: an alias ssh would read as an option is refused', () => {
  const dashed = { alias: '-oProxyCommand=evil', host: 'h', user: 'u', port: 22 }
  assert.throws(() => buildResolveArgv(dashed), /starts with "-", which ssh would read as an option/)
  assert.throws(() => buildResolveArgv({ ...dashed, alias: '  ' }), /has no "alias"/)
})

test('parseSshGOutput: repeated keywords collect instead of overwriting', () => {
  const map = parseSshGOutput(SSH_G)
  assert.deepEqual(map.get('identityfile'), [KEY, '~/.ssh/id_rsa'])
  assert.deepEqual(map.get('hostname'), ['192.0.2.20'])
  assert.equal(map.has('nosuchkeyword'), false)
  // Values keep their internal spaces; blank lines and CRLF do not matter.
  assert.deepEqual(map.get('localforward'), ['8080 127.0.0.1:5432'])
  assert.deepEqual(parseSshGOutput('port  22\r\n\r\n').get('port'), ['22'])
})

test('extractResolvedConfig: the thirteen contracted fields, typed', () => {
  const resolved = extractResolvedConfig(parseSshGOutput(SSH_G), { alias: 'node-b' })
  assert.deepEqual(Object.keys(resolved).sort(), [
    'connecttimeout',
    'controlmaster',
    'dynamicforward',
    'forwardagent',
    'hostname',
    'identityfile',
    'localforward',
    'port',
    'proxycommand',
    'proxyjump',
    'remoteforward',
    'serveraliveinterval',
    'user',
  ])
  assert.equal(resolved.hostname, '192.0.2.20')
  assert.equal(resolved.user, 'node-b')
  assert.equal(resolved.port, 2200)
  assert.equal(resolved.proxyjump, 'bastion@[10.0.0.5]:2200')
  assert.equal(resolved.proxycommand, 'none')
  assert.equal(resolved.identityfile.length, 2)
  assert.equal(resolved.controlmaster, 'false')
  assert.equal(resolved.forwardagent, 'no')
  assert.deepEqual(resolved.localforward, ['8080 127.0.0.1:5432'])
  // Not printed by ssh for this host: an empty list, not undefined.
  assert.deepEqual(resolved.remoteforward, [])
  assert.deepEqual(resolved.dynamicforward, [])
  assert.equal(resolved.serveraliveinterval, 15)
  assert.equal(resolved.connecttimeout, 'none')
})

test('extractResolvedConfig: a dump we cannot stand behind throws instead of returning {}', () => {
  assert.throws(() => extractResolvedConfig(parseSshGOutput('user node-b\nport 22\n')), /no "hostname" line/)
  assert.throws(
    () => extractResolvedConfig(parseSshGOutput('hostname h\nport not-a-port\n')),
    /no usable "port" line/,
  )
  assert.throws(() => extractResolvedConfig(parseSshGOutput('hostname h\nport 70000\n')), /no usable "port"/)
})

test('resolveViaSshG: reports the effective config from the injected runner', async () => {
  const runner = fakeRunner({ code: 0, stdout: SSH_G, stderr: '' })
  const value = await resolveViaSshG(host(), { run: runner.run })

  assert.deepEqual(runner.calls, [buildResolveArgv(host())], 'the runner gets exactly the -G argv')
  assert.equal(value.alias, 'node-b')
  assert.equal(value.hostname, '192.0.2.20')
  assert.equal(value.port, 2200)
  assert.equal(value.serveraliveinterval, 15)
  assert.equal(value.controlmaster, 'false')
  // 14 keys: the 13 contracted ones plus the alias they belong to.
  assert.equal(Object.keys(value).length, 14)
})

test('resolveViaSshG: a failing ssh -G throws with ssh stderr, never an empty object', async () => {
  const runner = fakeRunner({
    code: 255,
    stdout: '',
    stderr: 'ssh: Could not resolve hostname 192.0.2.20: Name or service not known',
  })
  await assert.rejects(
    () => resolveViaSshG(host(), { run: runner.run }),
    (error) => {
      assert.match(error.message, /ssh -G failed for alias "node-b"/)
      assert.match(error.message, /exit 255/)
      assert.match(error.message, /Could not resolve hostname/)
      return true
    },
  )
})

test('resolveViaSshG: a silent failure (no stderr) still names the exit code', async () => {
  const runner = fakeRunner({ code: 1, stdout: '', stderr: '   ' })
  await assert.rejects(() => resolveViaSshG(host(), { run: runner.run }), (error) => {
    assert.match(error.message, /ssh -G failed for alias "node-b" \(exit 1\): no stderr output/)
    return true
  })
})

test('resolveViaSshG: exit 0 with empty or unusable output is an error too', async () => {
  await assert.rejects(
    () => resolveViaSshG(host(), { run: fakeRunner({ code: 0, stdout: '   \n', stderr: '' }).run }),
    /produced no output for alias "node-b"/,
  )
  await assert.rejects(
    () => resolveViaSshG(host(), { run: fakeRunner({ code: 0, stdout: 'user node-b\nport 22\n', stderr: '' }).run }),
    /no "hostname" line/,
  )
})

test('resolveViaSshG: a missing runner is a programming error, not a silent {}', async () => {
  await assert.rejects(() => resolveViaSshG(host(), {}), /a "run" function is required/)
})
