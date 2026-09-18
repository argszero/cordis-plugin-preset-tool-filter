/**
 * Shared mount helper: a real published `@deepseek-ai/dsh-tools` registry, the
 * layer shape every deployment has, and the plugin under test.
 *
 * The CU stand-ins are named after the computer-use driver's public tool names
 * (`cua_driver_native__<catalog name>`), the case discussion #7080 measures:
 * a provider plugin mounted from config contributes to the GLOBAL layer, the
 * agent inherits it, and only a restriction can take it back out of the
 * request prefix.
 *
 * Scope identity matters: an agent handle IS its scope key (`scopeTarget(agent,
 * agent)` in packages/core/agent/src/index.ts), which is why every consumer —
 * including this plugin — passes the Agent itself to `tools.schemas()/get()`.
 * The harness mints the scope with the same object it hands to the event.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'

import { apply as applyPresetToolFilter } from '../lib/index.js'

/** Stand-ins for the reporter's 55-tool driver catalog, with 7 named tools. */
export const CU_TOOLS = [
  'cua_driver_native__get_window_state',
  'cua_driver_native__click',
  'cua_driver_native__browser_prepare',
  'cua_driver_native__get_browser_state',
  'cua_driver_native__page',
  'cua_driver_native__recording_start',
  'cua_driver_native__recording_stop',
]

/**
 * The group #7080 wants off. A driver catalog groups by CAPABILITY, not by name
 * string, so membership is declared as exact names — `get_browser_state` does
 * not share the `browser_` prefix of `browser_prepare`.
 */
export const BROWSER_GROUP = ['cua_driver_native__browser_prepare', 'cua_driver_native__get_browser_state']

/** A group that genuinely shares a namespace prefix (recording start/stop). */
export const RECORDING_PREFIX = 'cua_driver_native__recording'

/** Visible tools on the agent when nothing is configured: 7 CU + anchor + own. */
export const FULL_SURFACE = 9

function definition(name) {
  return {
    name,
    description: `${name} — stands in for one driver-catalog entry with a description long enough to matter in the request prefix.`,
    parameters: { type: 'object', properties: { pid: { type: 'integer' }, window_id: { type: 'integer' } } },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => Promise.resolve({ ok: true }),
  }
}

/** Capture everything the plugin writes to stderr while `body` runs. */
export async function captureStderr(body) {
  const original = process.stderr.write
  const lines = []
  process.stderr.write = (chunk) => {
    lines.push(String(chunk))
    return true
  }
  try {
    await body()
  } finally {
    process.stderr.write = original
  }
  return lines.join('')
}

/** Mint a scope, parented to `parent` when one is given. */
async function mintScope(ctx, key, parent) {
  if (parent !== undefined) bindScopeParent(key, parent)
  let scope
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return scope
}

/**
 * Mount the registry, the plugin, and one agent whose scope chain has the
 * deployment shape: global layer (the config-mounted provider), an ancestor
 * scope layer (preset composition's standing anchor), and the agent's own layer.
 */
export async function mountAgent(config, options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)

  for (const toolName of CU_TOOLS) ctx.tools.register(definition(toolName))

  const ancestorKey = { id: options.ancestorId ?? 'anchor-scope' }
  const ancestorScope = await mintScope(ctx, ancestorKey)
  ancestorScope.ctx.tools.register(definition('deploy_scoped_tool'))

  ctx.provide('agentPresets', { composedPreset: () => options.preset })

  // Mount the plugin exactly as a cordis.yml entry does: apply() on a child ctx.
  await ctx.plugin(Object.assign((inner) => { applyPresetToolFilter(inner, config) }, { inject: [] }))

  const agent = { id: options.agentId ?? 'agent-under-test' }
  const agentScope = await mintScope(ctx, agent, ancestorKey)
  agent.ctx = agentScope.ctx
  agentScope.ctx.tools.register(definition('own_reporting_tool'))

  return {
    ctx,
    agent,
    agentScope,
    ancestorKey,
    /** `agent/created` is emitted by the agent registry; replay that here. */
    publish: () => ctx.emit('agent/created', { agent }),
    names: (scope = agent) => ctx.tools.schemas(scope).map(schema => schema.name).sort(),
    has: (toolName, scope = agent) => ctx.tools.get(toolName, scope) !== undefined,
    /** Dispatch through the real executor: is the mask real, or presentational? */
    run: async (toolName, scope = agent) => {
      try {
        const result = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: 'c1',
          name: toolName,
          arguments: {},
          agent: scope,
        })
        return result.content[0]?.type === 'text' ? result.content[0].text : JSON.stringify(result.content)
      } catch (error) {
        return `threw: ${error.message}`
      }
    },
    schemaBytes: (scope = agent) => JSON.stringify(ctx.tools.schemas(scope)).length,
  }
}
