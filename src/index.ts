/**
 * @argszero/cordis-plugin-preset-tool-filter — Cordis plugin entry.
 *
 * #5786: a preset (notably `minimal`) captures only a small fixed tool set, yet
 * every agent also INHERITS the tool registry's global layer and every ancestor
 * layer on its scope chain. Because preset composition mounts its rows into a
 * standing ancestor scope and never applies a `ToolRestriction`, plugin
 * commands registered at the global layer leak through to the `minimal` agent:
 * the model sees a catalog far larger than the preset intended.
 *
 * This plugin is the community-side fix. On `agent/created`, for any agent whose
 * composed preset is in the configured `allowlists` (defaulting to `minimal`),
 * it applies a `tools.restrict({ allow })` on the agent's OWN scope context so
 * the agent only inherits the listed baseline tools and every other global /
 * ancestor tool is masked. The `restrict` API is public and scoped, so this
 * needs no harness patch.
 *
 * Mechanism notes (verified against packages/core/tools/src/index.ts):
 *  - `restrict` is `ToolRuntime.restrict(filter)` and REQUIRES the calling
 *    context to carry a scope tag, so it must be invoked on `agent.ctx`, not on
 *    the plugin's (root) context.
 *  - A restriction masks what the scope INHERITS (the global layer and every
 *    ancestor layer) and never the scope's own registrations. Preset rows land
 *    on the standing ANCHOR scope the agent is parented to, so they are
 *    inherited by the agent and therefore maskable (see the harness test
 *    "restrict() over an inherited scope layer": "the shape every preset
 *    deployment has: no model-facing row in the global layer, all of them
 *    contributed by an ancestor scope the child joined").
 *  - `restrict({ allow })` NAMES TOOLS and throws for any name not present in
 *    `restrictableNames` (the inherited set). Platform-specific tools (e.g.
 *    `pwsh` on POSIX, where the minimal preset disables it) may be absent, so
 *    the allow-list is filtered down to the names that actually resolve on the
 *    agent before restricting.
 *
 * @module @argszero/cordis-plugin-preset-tool-filter
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'preset-tool-filter'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Emitted by the agent registry when an agent is published. */
    'agent/created'(payload: { agent: Agent }): void
  }
}

// Minimal structural faces so a bare `@deepseek-ai/cordis` context is adequate.
// A full harness workspace supplies the real `agentPresets` + `tools` services;
// `ctx.get()` resolves them from the agent's scope chain at runtime.
interface Agent {
  readonly ctx: Context
}
/** The `agentPresets` service the roster publishes. */
interface AgentPresetsService {
  composedPreset(agentCtx: Context): string | undefined
}
/** Public shape of `@deepseek-ai/dsh-tools`' `ToolRestriction`. */
interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}
/** Public shape of `@deepseek-ai/dsh-tools`' `ToolRuntime` (scoped view). */
interface ToolRuntime {
  restrict(filter: ToolRestriction): () => void
  get(name: string, scope?: unknown): { name: string } | undefined
}

/** Plugin config: per-preset tool allowlists. */
export interface PresetToolFilterConfig {
  /**
   * Map of preset name → allowed tool names. For any agent whose composed
   * preset is a key here, `tools.restrict({ allow })` masks every other
   * global/ancestor tool. Defaults to `{ minimal: ['bash', 'pwsh',
   * 'str_replace_editor'] }`.
   */
  allowlists?: Record<string, readonly string[]>
  /**
   * When true (default), skip an agent that carries no composed preset (a
   * bare/global agent), so the filter never affects a preset-less agent. Set
   * false only if you know you want the default allowlist enforced everywhere.
   */
  skipUncomposed?: boolean
}

const DEFAULT_ALLOWLISTS: Record<string, readonly string[]> = {
  minimal: ['bash', 'pwsh', 'str_replace_editor'],
}

function warn(error: unknown): void {
  // Dependency-free on purpose: the plugin must build and run under plain Node
  // without a host logger. A stderr write is enough for a config-error surface.
  process.stderr.write(`preset-tool-filter: ${(error as Error).message}\n`)
}

export function apply(ctx: Context, config: PresetToolFilterConfig = {}): void {
  const allowlists = config.allowlists ?? DEFAULT_ALLOWLISTS
  const skipUncomposed = config.skipUncomposed ?? true
  const presetKeys = new Set(Object.keys(allowlists))

  ctx.on('agent/created', (payload: { agent?: Agent }) => {
    const agent = payload?.agent
    if (agent === undefined) return
    // `ctx.get(name)` resolves the service through the agent's scope chain; the
    // string overload returns `any`, so narrowing to the structural face below.
    const presets = agent.ctx.get('agentPresets') as AgentPresetsService | undefined
    const tools = agent.ctx.get('tools') as ToolRuntime | undefined
    if (presets === undefined || tools === undefined) return

    let preset: string | undefined
    try {
      preset = presets.composedPreset(agent.ctx)
    } catch {
      return
    }
    if (preset === undefined) {
      if (skipUncomposed) return
    } else if (!presetKeys.has(preset)) {
      return
    }

    const allow = (allowlists[preset ?? ''] ?? [])
      // `restrict` throws for a name absent from the inherited surface, and a
      // platform-disabled preset tool (e.g. `pwsh` on POSIX) will be absent.
      // Probe each candidate on the agent's scope (the Agent handle is the
      // scope key in the tools registry) and keep only those that resolve, so
      // the allow-list is always a subset of what is inheritable.
      .filter(name => tools.get(name, agent) !== undefined)
    if (allow.length === 0) return

    // Applying the restriction on the agent's own scoped context masks what it
    // INHERITS from the global/ancestor layers while keeping its own layer
    // registrations (e.g. delegation reporting tools) and the reserved PTC
    // mode transport intact.
    try {
      tools.restrict({ allow })
    } catch (error) {
      warn(error)
    }
  })
}
