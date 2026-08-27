# pi-telem — Telem web search & fetch for the Pi coding agent

A [Pi package](https://pi.dev/docs/latest) that lets the
[Pi coding agent](https://pi.dev/docs/latest) route web search and web page
fetching through Telem. The Pi counterpart of the Telem OpenCode
plugin (`@telemai/opencode-plugin`) and the Telem OpenClaw plugin
(`@telemai/openclaw-plugin`), speaking the same normalized search envelope.

## What's inside

| Piece | Path | What it does |
|---|---|---|
| Extension | `extensions/telem/index.ts` | Registers the `telem_search` and `telem_fetch` tools with the LLM, sends query lineage with each call, and renders normalized, provider-attributed results. |
| Skill | `skills/telem/` | Agent-Skills-standard skill: tells the model when to search/fetch and ships zero-dependency CLI scripts (`scripts/search.mjs`, `scripts/fetch.mjs`) as a fallback for harnesses without the extension. When the extension tools are present the skill defers to them. |

## Install

The guided installer is the quickest path — it configures the plugin and captures
your API key from [app.telem.ai](https://app.telem.ai) in one pass:

```bash
npm create @telemai
```

Pick **Pi** when it asks, or skip the interview entirely:

```bash
npm create @telemai -- --client pi
```

### By hand

Set the endpoint and your key explicitly — `npm create @telemai` writes both for you:

```bash
pi install npm:@telemai/pi-telem
export TELEM_BASE_URL=https://router.telem.ai
export TELEM_API_KEY=...              # from https://app.telem.ai
```

The `npm:` prefix is required — `pi install @telemai/pi-telem` (bare name) is
rejected as a local path.

`TELEM_BASE_URL` defaults to the hosted Telem service at
`https://router.telem.ai`. Set it only if Telem gave you a different endpoint.

Installing from a local checkout, for development: see [Development](#development).

## Configuration

Telem options live in `.telem/telem.json` — one project file and one user file
that **every** Telem harness reads, not a config per host. Options resolve
**per tool call** (no Pi restart needed) and per key, top wins:

1. project `<project>/.telem/telem.json` — *trusted projects only*
2. project `.pi/telem.json` — *deprecated*, trusted projects only
3. `~/.config/pi/telem.json` — *deprecated*
4. user `~/.telem/telem.json` (relocatable with `TELEM_CONFIG_DIR`)
5. `TELEM_*` env

Both deprecated files still apply and each says so once per edit, naming the
file to move it into. Level 3 sits deliberately above level 4, so migrating
cannot silently change behavior. Credentials are env-only.

The skill's standalone CLI scripts read the same unified files (levels 1, 4 and
5 above) per invocation, taking the project from the directory you run them in;
the deprecated `.pi/` files and the trust gate are extension-only, because a CLI
has no host to ask.

| File key | Env var | Meaning |
|---|---|---|
| `tier` | `TELEM_TIER` | Named result-field tier |
| `fields` | `TELEM_FIELDS` (csv) | Explicit result fields (mutually exclusive with tier; the more specific level wins, fields on a tie) |
| `providersInclude` | `TELEM_PROVIDERS_INCLUDE` (csv; deprecated alias `TELEM_PROVIDERS`) | Replace the deployment's provider set |
| `providersExclude` | `TELEM_PROVIDERS_EXCLUDE` (csv) | Subtract providers |
| `fullContent` | `TELEM_FULL_CONTENT=1` | Ask providers for full content |
| `providerOverrides` | — | Raw per-provider request params. Applies **only alongside `providersInclude`**, and only to providers named there; anything else is dropped with a warning (see below) |
| — | `TELEM_BASE_URL` | Telem deployment base URL |
| — | `TELEM_API_KEY` | Bearer token |

Example `<project>/.telem/telem.json`:

```json
{ "tier": "research", "providersExclude": ["slowprovider"] }
```

**The `providerOverrides` contract.** An override is only meaningful for a
provider the request actually selects, and the resolved `providersInclude` is the
only statement of that set the extension holds — with `providersInclude` unset,
your account's own default provider set is running and the extension cannot enumerate
it, so it forwards nothing it cannot check. Note that naming a provider is also a
replacement: `providersInclude` swaps your account's default provider set for
exactly the list you write, rather than adding to it.

```json
{ "providersInclude": ["exa"], "providerOverrides": { "exa": { "numResults": 2 } } }
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Agent uses `bash curl` instead of the tools | Package not loaded — `pi list` to check, `/reload` after installing, verify the project is trusted for project-local installs. |
| `Telem search failed: HTTP 401/403` | Missing/invalid `TELEM_API_KEY`. |
| `…without the normalized search envelope (normalized_schema_version=…)` | The endpoint predates the normalized search envelope. Check `TELEM_BASE_URL` points at `https://router.telem.ai`. This is a deliberate hard stop — rendering such an answer would silently look like "no results". |
| `HTTP 400 … use search.providers` | Provider names are reaching the backend through a legacy path; check your `TELEM_PROVIDERS*` values are plain provider names. |
| `[provider] failed: …` lines in results | That provider errored server-side; other providers' rows are unaffected. Purely informational. |
| `No results found.` | The query genuinely returned nothing — try rephrasing; check `providersInclude` isn't over-restricting (it REPLACES your account's provider set). |
| Config edits seem ignored | Check precedence, which is per key (a project file shadows the user files + env only for the keys it sets); check the file is valid JSON (a warning is printed once per broken edit); project files need project trust. |
| Both tier and fields warning | You configured both. Keep one, or accept the documented tie-break. |

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
