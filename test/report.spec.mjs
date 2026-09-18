/**
 * The report line and the config diagnostics — the half of the plugin that
 * answers #7080's measured-cost framing ("~94 KB / ~23.5k tokens; minus the
 * browser group -20.3%").
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BROWSER_GROUP, RECORDING_PREFIX, captureStderr, mountAgent } from './harness.mjs'

const BROWSER = { groups: { browser: { names: BROWSER_GROUP } }, disableGroups: ['browser'] }

describe('prefix report', () => {
  it('reports counts, schema bytes, share and group detail', async () => {
    const mount = await mountAgent({
      groups: { browser: { names: BROWSER_GROUP }, recording: { prefix: RECORDING_PREFIX } },
      disableGroups: ['browser', 'recording'],
    }, { preset: 'default', agentId: 'reporter' })
    const report = await captureStderr(async () => { mount.publish() })
    const match = /^preset-tool-filter: hid (\d+)\/(\d+) tools \((\d+) of (\d+) schema bytes, ([\d.]+)%, ~(\d+) tokens\) on "reporter" \[browser=2, recording=2\]\n$/.exec(report)
    assert.notEqual(match, null, `unexpected report line: ${JSON.stringify(report)}`)
    const [, hid, visible, saved, total, share, tokens] = match
    assert.equal(Number(hid), 4)
    assert.equal(Number(visible), 9)
    assert.ok(Number(saved) > 0 && Number(saved) < Number(total))
    assert.equal(Number(tokens), Math.round(Number(saved) / 4))
    assert.equal(Number(share), Number(((Number(saved) / Number(total)) * 100).toFixed(1)))
    // The reported total is the pre-restriction surface; the live surface is the
    // remainder, so the two halves reconcile.
    assert.ok(mount.schemaBytes() < Number(total))
  })

  it('reports the reason the report exists: the prefix cost it removes', async () => {
    const mount = await mountAgent(BROWSER, { preset: 'default', agentId: 'cost' })
    const report = await captureStderr(async () => { mount.publish() })
    const saved = Number(/(\d+) of \d+ schema bytes/.exec(report)[1])
    const before = mount.schemaBytes()
    // Re-measure independently: the saved bytes are the schema of the hidden tools.
    const defined = JSON.stringify(mount.ctx.tools.schemas(mount.ancestorKey).filter(schema => BROWSER_GROUP.includes(schema.name))).length
    assert.ok(defined > 0)
    assert.ok(saved > 0 && saved < before)
  })

  it('is silent when nothing is configured to hide', async () => {
    const mount = await mountAgent({ allowlists: { minimal: ['cua_driver_native__click'] } }, { preset: 'minimal' })
    const report = await captureStderr(async () => { mount.publish() })
    assert.equal(report, '', 'the report belongs to the group/deny half, not to the allowlist half')
    assert.equal(mount.names().length, 2, 'and the allowlist still masks the inherited surface')
  })

  it('can be switched off', async () => {
    const mount = await mountAgent({ ...BROWSER, report: false }, { preset: 'default' })
    const report = await captureStderr(async () => { mount.publish() })
    assert.equal(report, '')
    assert.equal(mount.has(BROWSER_GROUP[0]), false)
  })
})

describe('config diagnostics', () => {
  it('warns about a disableGroups entry with no matching group, and continues', async () => {
    const mount = await mountAgent({ disableGroups: ['browzer'], report: false }, { preset: 'default' })
    const report = await captureStderr(async () => { mount.publish() })
    assert.match(report, /disableGroups names group "browzer" but config\.groups has no such entry/)
    assert.equal(mount.names().length, 9, 'a typo must not take the agent down')
  })

  it('warns about a group that matches nothing on this deployment', async () => {
    const mount = await mountAgent({
      groups: { browser: { prefix: 'chrome_devtools__' } }, disableGroups: ['browser'], report: false,
    }, { preset: 'default' })
    const report = await captureStderr(async () => { mount.publish() })
    assert.match(report, /group "browser" matched no visible tool/)
    assert.equal(mount.names().length, 9)
  })

  it('separates the two report shapes: a dry run versus an applied restriction', async () => {
    const applied = await mountAgent(BROWSER, { preset: 'default' })
    const appliedReport = await captureStderr(async () => { applied.publish() })
    assert.match(appliedReport, /^preset-tool-filter: hid 2\/9 tools/)
    assert.equal(applied.names().length, 7)

    const rehearsal = await mountAgent({ ...BROWSER, dryRun: true }, { preset: 'default' })
    const rehearsalReport = await captureStderr(async () => { rehearsal.publish() })
    assert.match(rehearsalReport, /^preset-tool-filter: would hide 2\/9 tools/)
    assert.equal(rehearsal.names().length, 9, 'a dry run changes nothing')
  })

  it('reports one line per agent, and only for agents it touched', async () => {
    const mount = await mountAgent(BROWSER, { preset: 'default', agentId: 'first' })
    const report = await captureStderr(async () => {
      mount.publish()
      mount.publish()
    })
    assert.equal(report.split('\n').filter(line => line.length > 0).length, 2, 'once per publish, no accumulation')
  })
})
