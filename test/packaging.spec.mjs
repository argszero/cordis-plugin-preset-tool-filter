/**
 * Packaging claims, checked against the artifacts rather than asserted in prose.
 *
 * Two classes of defect this file exists to catch, both of which shipped in
 * earlier plugins of this series:
 *  1. a runtime import in the BUILT artifact that the manifest does not declare
 *     (invisible to a local `npm test`, which resolves through the repo's own
 *     `node_modules`);
 *  2. a peer range that silently excludes a line the code actually supports,
 *     so `npm install` fails with ERESOLVE on a version that works.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import semver from 'semver'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const artifact = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/**
 * The dsh lines this plugin is verified against — each one is actually run, by
 * installing that `@deepseek-ai/dsh-tools` and executing this same suite.
 */
const SUPPORTED = ['0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-rc.2', '0.1.6-alpha.2']

/** Every bare package specifier a line of source imports, module-by-module. */
function runtimeImports(code) {
  const found = new Set()
  for (const line of code.split('\n')) {
    // Line-anchored on purpose: prose in a doc comment must never be read as a
    // dependency, and a multiline import is not a shape this project uses.
    const match = /^import\s[^\n]*?from\s+'([^']+)'/.exec(line)
    if (match === null) continue
    const specifier = match[1]
    if (specifier.startsWith('.')) continue
    found.add(specifier)
  }
  return found
}

describe('declared dependencies cover the shipped artifact', () => {
  it('declares every bare specifier the built lib/index.js imports', () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const undeclared = [...runtimeImports(artifact)].filter(specifier => !declared.has(specifier))
    assert.deepEqual(undeclared, [], 'a runtime import the manifest does not declare resolves only by accident')
  })

  it('keeps type-only imports out of the artifact, so a type face is not a runtime claim', () => {
    // `@deepseek-ai/cordis` is imported for types only; the plugin must stay
    // importable in a workspace that resolves the harness types elsewhere.
    const artifactPackages = runtimeImports(artifact)
    assert.deepEqual([...artifactPackages], [], `artifact should have no bare runtime imports, got ${[...artifactPackages]}`)
    assert.match(source, /^import type \{ Context \} from '@deepseek-ai\/cordis'$/m)
  })

  it('imports nothing at runtime beyond the host-provided peer set', () => {
    // Harness-provided packages must be peers: declaring one as a dependency
    // makes npm nest a second copy of the harness beside the host's.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      assert.equal(name.startsWith('@deepseek-ai/dsh-'), false, `${name} is harness-provided and must be a peer`)
    }
  })
})

describe('peer range admits every verified line', () => {
  it('admits each supported dsh-tools line', () => {
    const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
    assert.equal(typeof range, 'string')
    for (const version of SUPPORTED) {
      assert.equal(semver.satisfies(version, range), true, `peer range excludes the verified line ${version}`)
    }
  })

  it('excludes a version outside the verified major line, and an unverified prerelease tuple', () => {
    // The negative half: a range passes this file only if it can also say no.
    // Prereleases are the trap — semver admits a prerelease only when a
    // comparator names the SAME major.minor.patch tuple, which is why each
    // verified line needs its own comparator rather than one open range.
    const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
    assert.equal(semver.satisfies('0.2.0', range), false)
    assert.equal(semver.satisfies('0.1.4-alpha.1', range), false)
    assert.equal(semver.satisfies('0.1.9-alpha.1', range), false)
    // A plain release inside the line stays admitted: the plugin needs no
    // prerelease-only feature.
    assert.equal(semver.satisfies('0.1.3', range), true)
  })

  it('computes the admitted set from the range instead of trusting its text', () => {
    // A range is a claim; the claim is only as good as the versions run against
    // it. Reconstruct the admitted RECOGNIZED lines and compare to SUPPORTED.
    const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
    const candidates = [...SUPPORTED, '0.1.2', '0.1.4-alpha.1', '0.1.9', '0.2.0', '0.1.6-alpha.1', '0.1.5-alpha.1']
    const admitted = candidates.filter(version => semver.satisfies(version, range))
    for (const version of SUPPORTED) assert.equal(admitted.includes(version), true)
    assert.equal(admitted.includes('0.1.4-alpha.1'), false, 'a line never run against must not be admitted')
  })

  it('declares the dsh-tools peer optional so a host without it still installs', () => {
    assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true)
  })
})

describe('publishability', () => {
  it('points exports and files at what the build emits', () => {
    assert.equal(manifest.exports['.'].default, './lib/index.js')
    assert.equal(manifest.exports['.'].types, './lib/types/index.d.ts')
    assert.equal(manifest.main, 'lib/index.js')
    assert.equal(manifest.types, 'lib/types/index.d.ts')
    assert.equal(manifest.files.includes('lib/index.js'), true)
    assert.equal(manifest.files.includes('lib/types/**/*.d.ts'), true)
  })

  it('publishes publicly at a version the artifact matches', () => {
    assert.equal(manifest.publishConfig.access, 'public')
    assert.equal(semver.valid(manifest.version), manifest.version)
    assert.equal(manifest.type, 'module')
  })

  it('ships the test command that produced the verification', () => {
    assert.equal(manifest.scripts.test, 'node --test "test/*.spec.mjs"')
    assert.equal(manifest.scripts.pretest, 'tsc', 'a fresh clone must build before its tests import lib/')
  })
})
