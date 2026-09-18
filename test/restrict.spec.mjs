/**
 * Behaviour of the `tools.restrict()` seam as this plugin uses it.
 *
 * The decisive property for #7080: a name contributed to the GLOBAL layer by a
 * config-mounted provider is restrictable from an AGENT scope — it leaves the
 * model-facing schema surface AND dispatch — while the provider stays mounted.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BROWSER_GROUP, CU_TOOLS, FULL_SURFACE, RECORDING_PREFIX, captureStderr, mountAgent } from './harness.mjs'

describe('tool-group opt-out (#7080)', () => {
  it('hides exactly the group a selector matches, and only for that agent', async () => {
    const mount = await mountAgent(
      { groups: { browser: { names: BROWSER_GROUP } }, disableGroups: ['browser'], report: false },
      { preset: 'default' },
    )
    // Before publishing, nothing is restricted: the plugin acts on the event.
    assert.equal(mount.names().length, FULL_SURFACE)
    mount.publish()
    const after = mount.names()
    for (const hidden of BROWSER_GROUP) {
      assert.equal(after.includes(hidden), false, `${hidden} must leave the schema surface`)
      assert.equal(mount.has(hidden), false, `${hidden} must read as absent`)
    }
    // Everything not in the group survives, including the other CU tools.
    for (const kept of CU_TOOLS.filter(name => !BROWSER_GROUP.includes(name))) {
      assert.equal(after.includes(kept), true, `${kept} must survive`)
    }
    assert.equal(after.includes('deploy_scoped_tool'), true, 'an ancestor tool outside the group survives')
    assert.equal(after.includes('own_reporting_tool'), true, 'the agent own layer is outside its own filter')
    // A restriction is per-scope, and the global view is never touched.
    assert.equal(mount.names(mount.ancestorKey).length, CU_TOOLS.length + 1, 'the anchor scope keeps its surface')
    assert.equal(mount.ctx.tools.schemas().length, CU_TOOLS.length, 'the global view is unrestricted')
  })

  it('masks dispatch, not just presentation', async () => {
    const mount = await mountAgent(
      { groups: { browser: { names: BROWSER_GROUP } }, disableGroups: ['browser'], report: false },
      { preset: 'default' },
    )
    mount.publish()
    assert.match(await mount.run(BROWSER_GROUP[0]), /unknown tool/)
    assert.equal(await mount.run('cua_driver_native__click'), '{"ok":true}', 'the kept CU tools still execute')
  })

  it('matches a group by namespace prefix as well as by exact names', async () => {
    const mount = await mountAgent({
      groups: {
        browser: { names: BROWSER_GROUP },
        recording: { prefix: RECORDING_PREFIX },
      },
      disableGroups: ['browser', 'recording'],
      report: false,
    }, { preset: 'default' })
    mount.publish()
    assert.deepEqual(
      mount.names(),
      ['cua_driver_native__click', 'cua_driver_native__get_window_state', 'cua_driver_native__page',
        'deploy_scoped_tool', 'own_reporting_tool'],
    )
  })

  it('unions exact names with a prefix inside one group', async () => {
    const mount = await mountAgent({
      groups: { mixed: { names: ['cua_driver_native__page'], prefix: RECORDING_PREFIX } },
      disableGroups: ['mixed'],
      report: false,
    }, { preset: 'default' })
    mount.publish()
    assert.equal(mount.has('cua_driver_native__page'), false)
    assert.equal(mount.has('cua_driver_native__recording_start'), false)
    assert.equal(mount.has('cua_driver_native__recording_stop'), false)
    assert.equal(mount.names().length, FULL_SURFACE - 3)
  })

  it('skips a configured name the agent cannot see instead of throwing', async () => {
    // `restrict()` throws for a name outside `restrictableNames`; a platform- or
    // profile-dependent tool (a disabled driver entry, `pwsh` on POSIX) is
    // exactly the shape that would otherwise blow up the agent's creation.
    const stderr = await captureStderr(async () => {
      const mount = await mountAgent({
        deny: ['cua_driver_native__not_in_this_catalog', 'cua_driver_native__click'],
        report: false,
      }, { preset: 'default' })
      mount.publish()
      assert.equal(mount.has('cua_driver_native__click'), false)
      assert.equal(mount.names().length, FULL_SURFACE - 1)
    })
    assert.equal(stderr.trim(), '', 'an absent configured name is not an error')
  })

  it('drops the reserved PTC transport from a configured deny instead of throwing', async () => {
    // The registry rejects `run_code` in a restriction outright; a config that
    // names it must not take the agent's creation down.
    const stderr = await captureStderr(async () => {
      const mount = await mountAgent({ deny: ['run_code', 'cua_driver_native__click'], report: false }, { preset: 'default' })
      mount.publish()
      assert.equal(mount.has('cua_driver_native__click'), false, 'the rest of the config still applies')
      assert.equal(mount.names().length, FULL_SURFACE - 1)
    })
    assert.equal(stderr.trim(), '', 'a config naming run_code is dropped silently, not thrown')
  })

  it('selects by an ad-hoc prefix without declaring a group', async () => {
    const mount = await mountAgent({ denyPrefixes: [RECORDING_PREFIX], report: false }, { preset: 'default' })
    mount.publish()
    assert.equal(mount.names().length, FULL_SURFACE - 2)
  })
})

describe('per-preset allowlist (#5786, unchanged contract)', () => {
  it('keeps an own-layer tool while masking inherited ones', async () => {
    const mount = await mountAgent(
      { allowlists: { minimal: ['cua_driver_native__click'] }, report: false },
      { preset: 'minimal' },
    )
    mount.publish()
    assert.deepEqual(mount.names(), ['cua_driver_native__click', 'own_reporting_tool'])
  })

  it('leaves agents of other presets, and preset-less agents, untouched', async () => {
    const other = await mountAgent({ allowlists: { minimal: ['cua_driver_native__click'] }, report: false }, { preset: 'default' })
    other.publish()
    assert.equal(other.names().length, FULL_SURFACE)
    const bare = await mountAgent({ allowlists: { minimal: ['cua_driver_native__click'] }, report: false }, {})
    bare.publish()
    assert.equal(bare.names().length, FULL_SURFACE, 'skipUncomposed (default) leaves a bare agent alone')
  })

  it('intersects the allowlist with a group deny in the same config', async () => {
    const mount = await mountAgent({
      allowlists: { minimal: ['cua_driver_native__browser_prepare', 'cua_driver_native__click'] },
      groups: { browser: { names: BROWSER_GROUP } },
      disableGroups: ['browser'],
      report: false,
    }, { preset: 'minimal' })
    mount.publish()
    assert.deepEqual(mount.names(), ['cua_driver_native__click', 'own_reporting_tool'])
  })
})

describe('degenerate payloads', () => {
  it('ignores an event without an agent, and an agent without a tools service', async () => {
    const mount = await mountAgent({ deny: ['cua_driver_native__click'], report: false }, { preset: 'default' })
    mount.ctx.emit('agent/created', {})
    mount.ctx.emit('agent/created', { agent: { id: 'no-tools', ctx: mount.ctx } })
    assert.equal(mount.names().length, FULL_SURFACE, 'neither shape is a crash or a mutation')
  })

  it('survives an agent whose context is not scoped, reporting why', async () => {
    // `restrict()` demands a scoped context; a payload that is not an agent
    // scope must produce one diagnostic, not an unhandled throw.
    const mount = await mountAgent({ deny: ['cua_driver_native__click'], report: false }, { preset: 'default' })
    const stderr = await captureStderr(() => {
      mount.ctx.emit('agent/created', { agent: { id: 'unscoped', ctx: mount.ctx } })
    })
    assert.match(stderr, /preset-tool-filter: tools\.restrict\(\) requires a scoped context/)
  })
})
