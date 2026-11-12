import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  HostsError,
  expandHome,
  hostsDir,
  hostsFile,
  legacyHostsFile,
  loadHosts,
  normalizeHost,
  parseHostsDocument,
  parseLegacyDocument,
  saveHosts,
  serializeHosts,
} from '../lib/hosts.js'

const HOME = path.join(os.tmpdir(), 'dsh-ssh-test-home')

function expectHostsError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof HostsError, `expected HostsError, got ${error?.name}: ${error?.message}`)
    assert.match(error.message, pattern)
    return true
  })
}

/** In-memory fs for loadHosts/saveHosts; records every write so tests can prove nothing else was touched. */
function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))
  const state = { files, writes: [], dirs: [] }
  return {
    state,
    fs: {
      async readFile(file) {
        if (!files.has(file)) {
          const error = new Error(`ENOENT: no such file or directory, open '${file}'`)
          error.code = 'ENOENT'
          throw error
        }
        return files.get(file)
      },
      async writeFile(file, data) {
        files.set(file, String(data))
        state.writes.push({ file, data: String(data) })
      },
      async mkdir(dir) {
        state.dirs.push(dir)
      },
    },
  }
}

test('parseHostsDocument: accepts a well-formed list and applies defaults', () => {
  const document = parseHostsDocument(
    JSON.stringify({
      version: 1,
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'deploy' },
        {
          alias: 'db1',
          host: '10.0.0.2',
          port: 2222,
          user: 'root',
          tags: ['db', 'prod'],
          environment: 'prod',
          description: 'primary database',
        },
      ],
    }),
    { source: 'test', home: HOME },
  )

  assert.equal(document.version, 1)
  assert.equal(document.hosts.length, 2)
  assert.deepEqual(document.hosts[0], { alias: 'web1', host: '10.0.0.1', port: 22, user: 'deploy', tags: [] })
  assert.deepEqual(document.hosts[1], {
    alias: 'db1',
    host: '10.0.0.2',
    port: 2222,
    user: 'root',
    tags: ['db', 'prod'],
    environment: 'prod',
    description: 'primary database',
  })
})

test('parseHostsDocument: an empty list is valid', () => {
  const document = parseHostsDocument(JSON.stringify({ version: 1, hosts: [] }), { source: 'test', home: HOME })
  assert.deepEqual(document.hosts, [])
})

test('parseHostsDocument: a host without an alias is rejected with the index', () => {
  expectHostsError(
    () => parseHostsDocument(JSON.stringify({ version: 1, hosts: [{ host: '10.0.0.1', user: 'root' }] }), { source: 'hosts.json' }),
    /hosts\.json: hosts\[0\]: "alias" is required/,
  )
})

test('parseHostsDocument: duplicate aliases are rejected, naming both indexes', () => {
  expectHostsError(
    () =>
      parseHostsDocument(
        JSON.stringify({
          version: 1,
          hosts: [
            { alias: 'same', host: '10.0.0.1', user: 'a' },
            { alias: 'same', host: '10.0.0.2', user: 'b' },
          ],
        }),
        { source: 'hosts.json' },
      ),
    /duplicate host alias "same" \(hosts\[0\] and hosts\[1\]\)/,
  )
})

test('parseHostsDocument: broken JSON is an explicit error, never an empty list', () => {
  expectHostsError(() => parseHostsDocument('{ "version": 1, "hosts": [', { source: 'hosts.json' }), /invalid JSON/)
})

test('parseHostsDocument: wrong document shapes are rejected', () => {
  expectHostsError(() => parseHostsDocument('[]', { source: 'h' }), /expected a JSON object/)
  expectHostsError(() => parseHostsDocument('{"version":1}', { source: 'h' }), /"hosts" must be an array/)
  expectHostsError(() => parseHostsDocument('{"version":2,"hosts":[]}', { source: 'h' }), /unsupported version 2/)
})

test('normalizeHost: validates port and tags instead of coercing nonsense', () => {
  for (const port of [0, 65536, 22.5, 'abc']) {
    expectHostsError(
      () => normalizeHost({ alias: 'a', host: 'h', user: 'u', port }, { home: HOME }),
      /"port" must be an integer between 1 and 65535/,
    )
  }
  expectHostsError(
    () => normalizeHost({ alias: 'a', host: 'h', user: 'u', tags: ['ok', 7] }, { home: HOME }),
    /"tags\[1\]" must be a string/,
  )
  expectHostsError(
    () => normalizeHost({ alias: 'a', host: 'h', user: 'u', tags: 'prod' }, { home: HOME }),
    /"tags" must be an array of strings/,
  )
})

test('normalizeHost: alias/host/user are required and whitespace-stripped', () => {
  expectHostsError(() => normalizeHost({ alias: '  ', host: 'h', user: 'u' }, { home: HOME }), /"alias" must not be blank/)
  expectHostsError(() => normalizeHost({ alias: 'a', host: '', user: 'u' }, { home: HOME }), /"host" is required/)
  expectHostsError(() => normalizeHost({ alias: 'a', host: 'h' }, { home: HOME }), /"user" is required/)
  expectHostsError(() => normalizeHost({ alias: 'a b', host: 'h', user: 'u' }, { home: HOME }), /must not contain whitespace/)
})

test('identityFile: "~" expands against the home directory', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/.ssh/id_ed25519', HOME), path.join(HOME, '.ssh/id_ed25519'))
  assert.equal(expandHome('~\\keys\\id_rsa', HOME), path.join(HOME, 'keys/id_rsa'))

  const host = normalizeHost(
    { alias: 'a', host: 'h', user: 'u', identityFile: '~/.ssh/id_ed25519' },
    { home: HOME },
  )
  assert.equal(host.identityFile, path.join(HOME, '.ssh/id_ed25519'))

  const absolute = path.join(HOME, 'other-key')
  assert.equal(normalizeHost({ alias: 'a', host: 'h', user: 'u', identityFile: absolute }, { home: HOME }).identityFile, absolute)
})

test('identityFile: "~otheruser" is rejected rather than passed to ssh literally', () => {
  expectHostsError(() => expandHome('~root/.ssh/id_rsa', HOME), /only "~" and "~\/" are supported/)
})

test('parseLegacyDocument: maps auth.keyPath to identityFile and drops the legacy auth block', () => {
  const legacy = parseLegacyDocument(
    JSON.stringify({
      version: 1,
      hosts: [
        {
          alias: 'laptop',
          host: '192.0.2.10',
          user: 'laptop-user',
          port: 22,
          tags: ['laptop'],
          environment: 'home',
          description: 'laptop',
          auth: { kind: 'key', keyPath: 'C:\\Users\\example\\.ssh\\id_ed25519' },
          proxyJump: [],
          createdAt: 1,
        },
        {
          alias: 'legacy-key-with-tilde',
          host: '10.0.0.9',
          user: 'root',
          auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519' },
        },
        {
          alias: 'password-only',
          host: '10.0.0.10',
          user: 'root',
          auth: { kind: 'password', password: 'secret' },
        },
      ],
    }),
    { source: 'legacy', home: HOME },
  )

  assert.equal(legacy.hosts.length, 3)
  assert.equal(legacy.hosts[0].identityFile, 'C:\\Users\\example\\.ssh\\id_ed25519')
  assert.equal(legacy.hosts[1].identityFile, path.join(HOME, '.ssh/id_ed25519'))
  assert.equal(Object.hasOwn(legacy.hosts[0], 'auth'), false)
  assert.deepEqual(legacy.passwordAliases, ['password-only'])
})

test('proxyJump: a string is validated and kept, absent or blank means "no jump host"', () => {
  const record = normalizeHost(
    { alias: 'a', host: 'h', user: 'u', proxyJump: ' ops@bastion:2200 ' },
    { home: HOME },
  )
  assert.equal(record.proxyJump, 'ops@bastion:2200')
  assert.equal(Object.hasOwn(normalizeHost({ alias: 'a', host: 'h', user: 'u' }, { home: HOME }), 'proxyJump'), false)
  assert.equal(
    Object.hasOwn(normalizeHost({ alias: 'a', host: 'h', user: 'u', proxyJump: '   ' }, { home: HOME }), 'proxyJump'),
    false,
  )
})

test('proxyJump: a malformed chain is rejected with the file and the record index', () => {
  expectHostsError(
    () =>
      parseHostsDocument(
        JSON.stringify({
          version: 1,
          hosts: [{ alias: 'a', host: 'h', user: 'u', proxyJump: 'bastion one' }],
        }),
        { source: 'hosts.json', home: HOME },
      ),
    /hosts\.json: hosts\[0\]: "proxyJump": hop "bastion one" must not contain whitespace/,
  )
  expectHostsError(
    () => normalizeHost({ alias: 'a', host: 'h', user: 'u', proxyJump: ['bastion'] }, { home: HOME }),
    /"proxyJump" must be a string \(got array\)/,
  )
  expectHostsError(
    () => normalizeHost({ alias: 'a', host: 'h', user: 'u', proxyJump: 'bastion:0' }, { home: HOME }),
    /port 0 must be between 1 and 65535/,
  )
})

test('parseHostsDocument: proxyJump survives a serialize/parse round-trip', () => {
  const hosts = [
    normalizeHost(
      { alias: 'a', host: '10.0.0.1', user: 'root', proxyJump: 'jump1,ops@jump2:2200' },
      { home: HOME },
    ),
  ]
  const parsed = parseHostsDocument(serializeHosts(hosts), { source: 's', home: HOME })
  assert.equal(parsed.hosts[0].proxyJump, 'jump1,ops@jump2:2200')
})

test('parseLegacyDocument: the legacy proxyJump array becomes an ssh -J chain', () => {
  const legacy = parseLegacyDocument(
    JSON.stringify({
      version: 1,
      hosts: [
        { alias: 'direct', host: 'h', user: 'u', proxyJump: [] },
        { alias: 'via-one', host: 'h', user: 'u', proxyJump: ['bastion'] },
        { alias: 'via-two', host: 'h', user: 'u', proxyJump: ['jump1', 'ops@jump2:2200'] },
        { alias: 'string-form', host: 'h', user: 'u', proxyJump: 'bastion:2200' },
      ],
    }),
    { source: 'legacy', home: HOME },
  )
  assert.equal(Object.hasOwn(legacy.hosts[0], 'proxyJump'), false)
  assert.equal(legacy.hosts[1].proxyJump, 'bastion')
  assert.equal(legacy.hosts[2].proxyJump, 'jump1,ops@jump2:2200')
  assert.equal(legacy.hosts[3].proxyJump, 'bastion:2200')
  assert.deepEqual(legacy.warnings, [])
})

test('parseLegacyDocument: an unreadable legacy proxyJump is warned about, not silently dropped', () => {
  const legacy = parseLegacyDocument(
    JSON.stringify({
      version: 1,
      hosts: [{ alias: 'odd', host: 'h', user: 'u', proxyJump: [{ host: 'bastion' }] }],
    }),
    { source: 'legacy', home: HOME },
  )
  assert.equal(Object.hasOwn(legacy.hosts[0], 'proxyJump'), false)
  assert.equal(legacy.warnings.length, 1)
  assert.match(legacy.warnings[0], /legacy: hosts\[0\]: ignoring "proxyJump\[0\]"/)
  assert.match(legacy.warnings[0], /expected a string, got object/)
})

test('loadHosts: a legacy proxyJump warning reaches warn(), never the bit bucket', async () => {
  const { fs } = fakeFs({
    [legacyHostsFile(HOME)]: JSON.stringify({
      version: 1,
      hosts: [{ alias: 'a', host: 'h', user: 'u', proxyJump: [{ host: 'b' }] }],
    }),
  })
  const warns = []
  const loaded = await loadHosts({
    home: HOME,
    fs,
    log: () => {},
    warn: (line) => warns.push(line),
  })
  assert.equal(loaded.hosts.length, 1)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /^\[snow-ssh\] .*ignoring "proxyJump\[0\]"/)
})

test('loadHosts: reads our file and imports nothing when it already exists', async () => {
  const target = hostsFile(HOME)
  const { fs, state } = fakeFs({
    [target]: JSON.stringify({ version: 1, hosts: [{ alias: 'a', host: 'h', user: 'u' }] }),
  })
  const logs = []
  const loaded = await loadHosts({ home: HOME, fs, log: (line) => logs.push(line) })

  assert.equal(loaded.hosts.length, 1)
  assert.equal(loaded.source, target)
  assert.equal(loaded.imported, false)
  assert.equal(state.writes.length, 0)
  assert.deepEqual(logs, [])
})

test('loadHosts: a corrupt own file throws and does NOT fall back to the legacy list', async () => {
  const target = hostsFile(HOME)
  const legacy = legacyHostsFile(HOME)
  const { fs, state } = fakeFs({
    [target]: '{"version":1,"hosts":[',
    [legacy]: JSON.stringify({ version: 1, hosts: [{ alias: 'old', host: 'h', user: 'u' }] }),
  })

  await assert.rejects(() => loadHosts({ home: HOME, fs, log: () => {} }), /invalid JSON/)
  assert.equal(state.writes.length, 0)
})

test('loadHosts: no files at all yields an explicit "empty, missing" result', async () => {
  const { fs } = fakeFs()
  const loaded = await loadHosts({ home: HOME, fs, log: () => {} })
  assert.deepEqual(loaded.hosts, [])
  assert.equal(loaded.missing, true)
  assert.equal(loaded.imported, false)
})

test('loadHosts: imports the legacy list once, writes our file, logs one line, leaves the legacy file alone', async () => {
  const target = hostsFile(HOME)
  const legacy = legacyHostsFile(HOME)
  const legacyText = JSON.stringify({
    version: 1,
    hosts: [
      { alias: 'node-b', host: '192.0.2.20', user: 'node-b', auth: { kind: 'password', password: 'x' } },
      { alias: 'node-a', host: '203.0.113.10', user: 'root', tags: ['cluster'], auth: { kind: 'key', keyPath: 'C:/Users/example/.ssh/id_ed25519' } },
    ],
  })
  const { fs, state } = fakeFs({ [legacy]: legacyText })
  const logs = []
  const warns = []

  const loaded = await loadHosts({
    home: HOME,
    fs,
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
  })

  assert.equal(loaded.imported, true)
  assert.equal(loaded.importedCount, 2)
  assert.equal(loaded.source, target)
  assert.equal(loaded.hosts.length, 2)
  assert.equal(loaded.hosts[1].identityFile, 'C:/Users/example/.ssh/id_ed25519')

  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].file, target)
  const written = JSON.parse(state.writes[0].data)
  assert.equal(written.version, 1)
  assert.equal(written.hosts.length, 2)
  assert.equal(Object.hasOwn(written.hosts[0], 'auth'), false)

  // The legacy document is untouched: same object, never rewritten.
  assert.equal(state.files.get(legacy), legacyText)

  assert.equal(logs.length, 1)
  assert.match(logs[0], /從舊清單匯入了 2 筆主機/)
  assert.match(logs[0], /舊檔保留未動/)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /node-b/)
})

test('loadHosts: an invalid legacy entry is an error naming the legacy file', async () => {
  const legacy = legacyHostsFile(HOME)
  const { fs, state } = fakeFs({
    [legacy]: JSON.stringify({ version: 1, hosts: [{ alias: 'a', host: 'h' }] }),
  })
  await assert.rejects(() => loadHosts({ home: HOME, fs, log: () => {} }), /legacy|dsh-ssh\.json/)
  assert.equal(state.writes.length, 0)
})

test('serializeHosts / saveHosts: round-trips through the same parser', async () => {
  const hosts = [normalizeHost({ alias: 'a', host: '10.0.0.1', user: 'root', tags: ['prod'] }, { home: HOME })]
  const serialized = serializeHosts(hosts)
  assert.ok(serialized.endsWith('\n'))
  assert.deepEqual(parseHostsDocument(serialized, { source: 's', home: HOME }).hosts, hosts)

  const { fs, state } = fakeFs()
  const file = await saveHosts(hosts, { home: HOME, fs })
  assert.equal(file, hostsFile(HOME))
  assert.equal(state.dirs[0], hostsDir(HOME))
  assert.deepEqual(JSON.parse(state.writes[0].data).hosts, hostListJson(hosts))
})

function hostListJson(hosts) {
  return JSON.parse(JSON.stringify(hosts))
}

test('loadHosts (real filesystem): imports into a temp home and leaves the legacy file byte-identical', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-real-'))
  try {
    await mkdir(path.join(home, '.dsh'), { recursive: true })
    const legacy = legacyHostsFile(home)
    const legacyText = `${JSON.stringify(
      {
        version: 1,
        hosts: [
          {
            alias: 'real',
            host: '10.0.0.1',
            user: 'root',
            auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519' },
          },
        ],
      },
      null,
      2,
    )}\n`
    await writeFile(legacy, legacyText, 'utf8')

    const logs = []
    const loaded = await loadHosts({ home, log: (line) => logs.push(line), warn: () => {} })
    assert.equal(loaded.imported, true)
    assert.equal(loaded.importedCount, 1)
    assert.equal(loaded.hosts[0].identityFile, path.join(home, '.ssh/id_ed25519'))

    const written = JSON.parse(await readFile(hostsFile(home), 'utf8'))
    assert.equal(written.version, 1)
    assert.equal(written.hosts.length, 1)
    assert.equal(logs.length, 1)

    // The legacy file is read-only for us: byte-identical afterwards.
    assert.equal(await readFile(legacy, 'utf8'), legacyText)

    // The second load reads OUR file; it must not import again.
    const second = await loadHosts({ home, log: () => {} })
    assert.equal(second.imported, false)
    assert.equal(second.hosts.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
