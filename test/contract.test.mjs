/**
 * Structural contract tests for the parts `node --test` cannot import directly:
 * the manifest, the bundle patch, and the seven tool definitions in
 * `lib/index.js`.
 *
 * The schemas are extracted from the source and evaluated as plain data —
 * they contain no spreads or references on purpose, so this also proves each
 * one is a lossless JSON value. The `additionalProperties` check is the real
 * one: the harness refuses to load a tool whose object schema leaves it out.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

const PACKAGE = JSON.parse(read('package.json'))
const INDEX_SOURCE = read('lib/index.js')
const PATCH = read('cordis.patch.yml')
const README = read('README.md')

const TOOL_NAMES = [
  'ssh_list',
  'ssh_exec',
  'ssh_upload',
  'ssh_download',
  'ssh_tunnel',
  'ssh_cluster',
  'ssh_resolve',
]

test('package.json: plugin contract fields are present and exact', () => {
  assert.equal(PACKAGE.name, '@snow-the/dsh-ssh')
  assert.equal(PACKAGE.version, '0.1.0')
  assert.equal(PACKAGE.type, 'module')
  assert.equal(PACKAGE.main, './lib/index.js')
  assert.deepEqual(PACKAGE.files, ['lib', 'cordis.patch.yml', 'README.md'])
  assert.deepEqual(PACKAGE.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.deepEqual(PACKAGE.peerDependencies, { '@deepseek-ai/dsh-tools': '>=0.2.1-rc.5' })
  assert.equal(PACKAGE.scripts.test, 'node --test test/')
  assert.ok(existsSync(path.join(ROOT, PACKAGE.main)), 'main entry exists')
  assert.ok(existsSync(path.join(ROOT, 'README.md')), 'README.md exists')
  // Zero npm runtime dependencies is a design requirement, not an accident.
  assert.equal(PACKAGE.dependencies, undefined)
})

test('cordis.patch.yml: top-level array wrapped in - insert:, never a bare - id:', () => {
  const topLevelRows = PATCH.split(/\r?\n/).filter((line) => /^- \S/.test(line))
  assert.deepEqual(topLevelRows, ['- insert:'])
  assert.match(PATCH, /^\s{4}- id: snow-ssh$/m)
  assert.match(PATCH, /^\s{6}name: '@snow-the\/dsh-ssh'$/m)
})

test('lib/index.js: ESM exports and the defineTool import the loader expects', () => {
  assert.match(INDEX_SOURCE, /^export const name = 'snow-ssh'$/m)
  assert.match(INDEX_SOURCE, /^export const inject = \['tools'\]$/m)
  assert.match(INDEX_SOURCE, /^export function apply\(ctx\) \{/m)
  assert.match(INDEX_SOURCE, /^import \{ defineTool \} from '@deepseek-ai\/dsh-tools'$/m)
})

test('lib/index.js: registers exactly the seven contracted tools', () => {
  const declared = [...INDEX_SOURCE.matchAll(/name: '(ssh_[a-z_]+)'/g)].map((match) => match[1])
  assert.deepEqual([...declared].sort(), [...TOOL_NAMES].sort())

  for (const tool of TOOL_NAMES) {
    assert.equal(
      (INDEX_SOURCE.match(new RegExp(`name: '${tool}'`, 'g')) ?? []).length,
      1,
      `${tool} declared once`,
    )
  }
  assert.equal((INDEX_SOURCE.match(/ctx\.tools\.register\(/g) ?? []).length, TOOL_NAMES.length)
})

test('lib/index.js: shell-free local execution (spawn only, never exec)', () => {
  const childProcessImport = INDEX_SOURCE.match(/^import \{([^}]+)\} from 'node:child_process'$/m)
  assert.ok(childProcessImport, 'imports from node:child_process')
  const imported = childProcessImport[1].split(',').map((part) => part.trim())
  assert.deepEqual(imported, ['spawn'])
  for (const forbidden of ['execSync', 'execFileSync', 'child_process.exec(', "'exec'", 'shell: true']) {
    assert.equal(INDEX_SOURCE.includes(forbidden), false, `must not contain ${forbidden}`)
  }
})

/** Read one balanced `{...}` literal, skipping braces inside string literals. */
function readBalanced(source, openIndex) {
  assert.equal(source[openIndex], '{')
  let depth = 0
  let quote = null
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index]
    if (quote !== null) {
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, index + 1)
    }
  }
  throw new Error('unbalanced schema literal')
}

function schemaLiterals() {
  const literals = []
  const marker = /schema:\s*\{/g
  let match
  while ((match = marker.exec(INDEX_SOURCE)) !== null) {
    const openIndex = INDEX_SOURCE.indexOf('{', match.index)
    const literal = readBalanced(INDEX_SOURCE, openIndex)
    literals.push(literal)
    marker.lastIndex = openIndex + literal.length
  }
  return literals
}

test('output schemas: every object node declares additionalProperties explicitly', () => {
  const literals = schemaLiterals()
  assert.equal(literals.length, TOOL_NAMES.length, 'one output schema per tool')

  const problems = []
  const visit = (node, trail) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${trail}[${index}]`))
      return
    }
    if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
      problems.push(`${trail} (type=object) is missing additionalProperties`)
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${trail}.${key}`)
  }

  for (const [index, literal] of literals.entries()) {
    const schema = new Function(`"use strict"; return (${literal});`)()
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, 'schema is lossless JSON')
    visit(schema, `${TOOL_NAMES[index]}.schema`)
  }
  assert.deepEqual(problems, [])
})

test('output schemas: declarations match what the seven tools really return', () => {
  const byTool = {}
  for (const [index, literal] of schemaLiterals().entries()) {
    byTool[TOOL_NAMES[index]] = new Function(`"use strict"; return (${literal});`)()
  }

  const propertiesOf = (tool) => Object.keys(byTool[tool].properties)
  assert.deepEqual(propertiesOf('ssh_exec').sort(), ['alias', 'exitCode', 'stderr', 'stdout'])
  const TRANSFER = ['alias', 'bytes', 'direction', 'exitCode', 'localPath', 'ok', 'remotePath', 'stderr', 'stdout']
  assert.deepEqual(propertiesOf('ssh_upload').sort(), TRANSFER)
  assert.deepEqual(propertiesOf('ssh_download').sort(), TRANSFER)
  assert.ok(propertiesOf('ssh_list').includes('hosts'))
  const listHost = byTool.ssh_list.properties.hosts.items.properties
  assert.ok(Object.hasOwn(listHost, 'proxyJump'), 'ssh_list reports each host\'s proxyJump')
  assert.ok(propertiesOf('ssh_tunnel').includes('tunnels'))
  assert.ok(propertiesOf('ssh_cluster').includes('results'))
  assert.deepEqual(propertiesOf('ssh_resolve').sort(), [
    'alias',
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
})

test('tool parameters: `options` is an array of strings on every tool that forwards -o', () => {
  for (const tool of ['ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel']) {
    const start = INDEX_SOURCE.indexOf(`name: '${tool}'`)
    assert.notEqual(start, -1, `${tool} is declared`)
    const next = INDEX_SOURCE.indexOf('defineTool({', start)
    const block = INDEX_SOURCE.slice(start, next === -1 ? INDEX_SOURCE.length : next)
    assert.match(block, /options: optionsParameter\(\)/, `${tool} accepts extra -o options`)
  }
})

test('README.md: documents all seven tools and the decisions behind them', () => {
  for (const tool of TOOL_NAMES) {
    assert.ok(README.includes(`\`${tool}\``), `${tool} is documented in README.md`)
  }
  assert.match(README, /proxyJump/)
  assert.match(README, /sftp -b -/)
  // The ControlMaster limitation is quoted with the real error string.
  assert.match(README, /ControlMaster/)
  assert.match(README, /getsockname failed: Not a socket/)
  for (const key of ['ProxyCommand', 'LocalCommand', 'PermitLocalCommand']) {
    assert.ok(README.includes(key), `${key} is documented as refused`)
  }
})
