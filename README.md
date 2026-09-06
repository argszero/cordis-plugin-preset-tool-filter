# cordis-plugin-preset-tool-filter

Per-preset tool allowlist for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

A **community-side fix** for [#5786](https://github.com/deepseek-ai/deepseek-harness/discussions/5786): the
`minimal` preset (and any preset that wants a fixed tool set) exposes only its shell + `str_replace_editor`
tools, yet every agent also **inherits** the tool registry's global layer and every ancestor layer on its
scope chain. Because preset composition mounts its rows into a standing ancestor scope and never applies a
`ToolRestriction`, plugin commands registered at the **global** layer leak through to the `minimal` agent —
the model sees a catalog far larger than the preset intended.

This plugin applies a `tools.restrict({ allow })` on the agent's own scope context at `agent/created`, so the
agent only inherits the listed baseline tools and every other global / ancestor tool is masked.

## Why

The harness has a public, scoped `ToolRuntime.restrict(filter)` API (`@deepseek-ai/dsh-tools`). But nothing
in the preset composition calls it, so a `minimal` agent inherits `layers.global.tools` — which includes every
plugin-registered tool. The fix is **not** a harness patch: it's a plugin that calls the existing public API
on the agent's scope, exactly where the preset machinery forgot to.

## Install

```sh
npm install @argszero/cordis-plugin-preset-tool-filter
```

Mount the plugin into your `dsh` profile:

```yaml
# cordis.yml
plugins:
  "@argszero/cordis-plugin-preset-tool-filter":
    allowlists:
      minimal: [bash, str_replace_editor]
```

> **Peer dependencies.** The plugin reads `tools` and `agentPresets` at runtime via `ctx.get()`, so only
> `@deepseek-ai/cordis` is a hard peer. `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-preset` are optional
> peers (present in any real harness workspace but not required for the build).

> **Version pin.** The `@deepseek-ai/dsh-*` `latest` dist-tag is frozen at an old `0.1.2-rc.1`; the current
> harness line is published under `next`. If you install by tag, prefer installing the harness packages via
> `@next`.

## Usage

Once mounted, the plugin subscribes to `agent/created`. For any agent whose **composed preset** is a key in
`allowlists` (default `{ minimal: ['bash', 'pwsh', 'str_replace_editor'] }`), it calls
`tools.restrict({ allow })` on that agent's scope, masking every other inherited tool.

On POSIX the `pwsh` row is disabled by the `minimal` preset, so the effective allow-list is
`['bash', 'str_replace_editor']` — the plugin probes each name and drops the ones the platform never mounted,
so `restrict` never throws on a name that isn't present.

### Configuration

| option | type | default | description |
|--------|------|---------|-------------|
| `allowlists` | `Record<string, string[]>` | `{ minimal: ['bash', 'pwsh', 'str_replace_editor'] }` | Map of preset name → allowed tool names. Any agent whose composed preset is a key here gets `tools.restrict({ allow })`. |
| `skipUncomposed` | `boolean` | `true` | Skip agents with no composed preset (a bare/global agent), so the filter never affects a preset-less agent. |

## How it works

- `restrict` is `ToolRuntime.restrict(filter)` and **requires a scoped context**. It's invoked on
  `agent.ctx` (the agent's own scope), never the plugin root.
- A restriction masks what the scope **inherits** (the global layer and every ancestor layer) and never the
  scope's own registrations. Preset rows land on the standing **ancestor** scope the agent is parented to, so
  they are inherited by the agent and therefore maskable.
- `restrict({ allow })` names tools and throws for any name not present in `restrictableNames` (the inherited
  set). The plugin probes each candidate on the agent's scope first, so the allow-list is always a subset of
  what is actually inheritable.

This is the general in-tree mechanism the harness's own tools describe: *"Per-scope filter over global tools.
Restrictions intersect and do not affect scoped registrations or the reserved PTC mode transport."* The plugin
just wires it into the preset lifecycle.

## License

MIT
