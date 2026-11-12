/**
 * Entry shim for `node --test test/`.
 *
 * Node 26 no longer expands a directory positional argument: it resolves
 * `test/` through the module loader instead, which fails with
 * `Cannot find module .../test` unless a `test/index.js` resolves. This file
 * makes the contracted command (`npm test` → `node --test test/`) work, and it
 * imports the real suites unchanged.
 *
 * Prefer `npm test`. A bare `node --test` discovers both this shim and the
 * suites, so it runs every test twice.
 */
import './hosts.test.mjs'
import './ssh-command.test.mjs'
import './ssh-resolve.test.mjs'
import './contract.test.mjs'
