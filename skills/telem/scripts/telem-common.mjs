// Shared plumbing for the telem skill scripts (search.mjs / fetch.mjs).
// Zero-dependency Node ESM.
//
// The render functions are a plain-JS port of the `telem-render:begin/end`
// region in ./././extensions/telem/index.ts (itself copied verbatim from
// the opencode plugin) — same budgets, same single-line folding, same
// per-provider tagging. Keep the three copies aligned when the contract moves.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"

export const FETCH_MAX_URLS = 5
export const FETCH_CONTENT_CAP = 20000

const RENDER_EXCERPT_MAX_ENTRIES = 4
const RENDER_EXCERPT_MAX_CHARS = 1000
const RENDER_RELATED_MAX_ITEMS = 6
const RENDER_TOTAL_CAP = 128000

// ===========================================================================
// VENDORED: the unified Telem config reader (project, user and env levels)
// ===========================================================================
// PROVENANCE — this block is a hand-port of the shared config package, plus its
// three composition rules (`composeTierFields`, `composeProviders`,
// `guardProviderOverrides`, applied in that order — each decides what the next
// sees). It is VENDORED, not imported, because these scripts are standalone by
// contract: the pi skill directory is copied out of the package and run as plain
// `node script.mjs`, with no bundler and no dependency on any repository layout.
// The pi EXTENSION imports the package properly; only these CLI scripts carry a
// copy.
//
// WHAT KEEPS THE COPY HONEST: a differential suite runs the shared conformance
// corpus — the same cases the TypeScript package and the Python mirror each run —
// through the functions below, and additionally diffs them against the package's
// own resolver on the same materialized trees. A behaviour change that is not
// ported here fails that suite, so this file cannot drift silently, only loudly.
// A behaviour change belongs in a fixture FIRST, then in every implementation.
//
// One deliberate difference from the pi extension: it gates the project layer
// behind pi's `isProjectTrusted`. A standalone CLI has no such signal, so these
// scripts read `<cwd>/.telem/telem.json` the way every other CLI reads the
// config of the directory you ran it in. Do not run them inside a checkout you
// would not run.

/**
 * The ONE shared blank list (nine characters), not either runtime's `trim`:
 * space, tab, LF, CR, VT, FF, U+00A0, U+FEFF, U+3000. See the long note in
 * the shared config package — using JS's own definition would make the same file
 * resolve differently in Node and in Python.
 */
const BLANK_CHARS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0x00a0, 0xfeff, 0x3000])

function trimBlank(value) {
  let start = 0
  let end = value.length
  while (start < end && BLANK_CHARS.has(value.charCodeAt(start))) start += 1
  while (end > start && BLANK_CHARS.has(value.charCodeAt(end - 1))) end -= 1
  return start === 0 && end === value.length ? value : value.slice(start, end)
}

/** "Empty means absent": `[]`, `{}`, `""`, blank-only and null are absent. */
function normalizeEmpty(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return trimBlank(value) ? value : undefined
  if (Array.isArray(value)) return value.length ? value : undefined
  if (typeof value === "object") return Object.keys(value).length ? value : undefined
  return value
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asName(value) {
  const raw = normalizeEmpty(value)
  if (typeof raw !== "string") return undefined
  return trimBlank(raw) || undefined
}

function asNameList(value) {
  const raw = normalizeEmpty(value)
  if (!Array.isArray(raw)) return undefined
  const names = raw.map((item) => (typeof item === "string" ? trimBlank(item) : "")).filter(Boolean)
  return names.length ? names : undefined
}

function asFlag(value) {
  const raw = normalizeEmpty(value)
  return typeof raw === "boolean" ? raw : undefined
}

// Null prototype on purpose: with a plain `{}`, a provider named `__proto__`
// runs the inherited setter and REPARENTS the map instead of becoming a key.
function asOverridesMap(value) {
  const raw = normalizeEmpty(value)
  if (!isPlainObject(raw)) return undefined
  const out = Object.create(null)
  for (const [name, params] of Object.entries(raw)) {
    const provider = trimBlank(name)
    if (provider && isPlainObject(params)) out[provider] = params
  }
  return Object.keys(out).length ? out : undefined
}

const COERCERS = { name: asName, nameList: asNameList, flag: asFlag, overridesMap: asOverridesMap }

/** The six option keys. `envAliases` are deprecated, read strictly below `env`. */
const TELEM_OPTIONS = [
  { key: "tier", coercion: "name", env: "TELEM_TIER", envAliases: [] },
  { key: "fields", coercion: "nameList", env: "TELEM_FIELDS", envAliases: [] },
  {
    key: "providersInclude",
    coercion: "nameList",
    env: "TELEM_PROVIDERS_INCLUDE",
    envAliases: ["TELEM_PROVIDERS"],
  },
  { key: "providersExclude", coercion: "nameList", env: "TELEM_PROVIDERS_EXCLUDE", envAliases: [] },
  { key: "fullContent", coercion: "flag", env: "TELEM_FULL_CONTENT", envAliases: [] },
  // No env form on purpose: a JSON blob in a shell variable is not a config surface.
  { key: "providerOverrides", coercion: "overridesMap", env: null, envAliases: [] },
]

/** csv: items trimmed, empties dropped; all-empty is unset (env cannot say `[]`). */
function csvValue(raw) {
  return raw === undefined ? undefined : asNameList(raw.split(","))
}

function optionFromEnv(spec, env) {
  const names = spec.env === null ? [] : [spec.env, ...spec.envAliases]
  for (const name of names) {
    const raw = env[name]
    if (raw === undefined) continue
    const value =
      spec.coercion === "nameList"
        ? csvValue(raw)
        : spec.coercion === "flag"
          ? raw === "1" || undefined
          : spec.coercion === "name"
            ? asName(raw)
            : undefined
    if (value !== undefined) return value
  }
  return undefined
}

const TELEM_DIR_NAME = ".telem"
const CONFIG_FILE_NAME = "telem.json"
const CONFIG_DIR_ENV = "TELEM_CONFIG_DIR"

function homeDir(env) {
  return env.HOME || env.USERPROFILE || homedir()
}

// LEXICAL check on resolved paths — no symlink resolution, no case folding. A
// guardrail against a repo redirecting config at itself, not a security boundary.
function isInside(candidate, projectRoot) {
  const root = resolve(projectRoot)
  const target = resolve(candidate)
  return target === root || target.startsWith(root + sep)
}

/** `~/.telem`, or `TELEM_CONFIG_DIR` — unless that points INSIDE the project (refused). */
function resolveTelemDir(env, projectRoot) {
  const fallback = join(homeDir(env), TELEM_DIR_NAME)
  const raw = env[CONFIG_DIR_ENV]
  const requested = raw === undefined ? "" : trimBlank(raw)
  if (!requested) return { dir: fallback }
  if (projectRoot && isInside(requested, projectRoot)) {
    return {
      dir: fallback,
      warning:
        `[telem] ignoring ${CONFIG_DIR_ENV}=${requested}: it points inside the project ` +
        `(${resolve(projectRoot)}); using ${fallback} instead`,
    }
  }
  return { dir: isAbsolute(requested) ? requested : resolve(requested) }
}

// Strict UTF-8. `ignoreBOM: true` means "hand me the BOM as a character" — one
// leading U+FEFF is then stripped by the shared rule below, so a Notepad-written
// file works and a two-BOM file stays malformed in both languages.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function errorText(error) {
  const message = error?.message
  return message ? message : "unreadable"
}

/**
 * Read one config file. NEVER throws: a missing, unreadable, malformed or
 * non-object file is ABSENT and the next level supplies the keys — a stray
 * keystroke in telem.json can never fail a search. A missing file is silent;
 * anything else returns exactly one warning.
 */
function readTelemFile(path) {
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    const code = error?.code
    if (code === "ENOENT" || code === "ENOTDIR") return { data: null }
    return { data: null, warning: `[telem] ignoring ${path}: ${errorText(error)}` }
  }
  let raw
  try {
    raw = UTF8.decode(bytes)
  } catch {
    return { data: null, warning: `[telem] ignoring ${path}: not valid UTF-8` }
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { data: null, warning: `[telem] ignoring ${path}: ${errorText(error)}` }
  }
  if (!isPlainObject(parsed)) {
    return { data: null, warning: `[telem] ignoring ${path}: expected a JSON object` }
  }
  return { data: parsed }
}

/**
 * Resolve every option key over project file > user file > env, per KEY: a
 * project file that sets `tier` does not hide the user file's `fields`.
 *
 * Returns `{ values, sources, warnings, telemDir }` — the same shape as
 * config-core's `resolveOptions`, which is what the conformance test compares.
 * `projectRoot` may be undefined (or ""), meaning "no project layer".
 */
export function resolveConfigOptions(env = process.env, projectRoot = undefined) {
  const warnings = []
  const root = projectRoot || undefined

  const project = root ? readTelemFile(join(root, TELEM_DIR_NAME, CONFIG_FILE_NAME)) : { data: null }
  if (project.warning) warnings.push(project.warning)

  const telemDir = resolveTelemDir(env, root)
  if (telemDir.warning) warnings.push(telemDir.warning)
  const user = readTelemFile(join(telemDir.dir, CONFIG_FILE_NAME))
  if (user.warning) warnings.push(user.warning)

  const layers = [
    { level: "project", data: project.data },
    { level: "user", data: user.data },
  ]

  const values = {}
  const sources = {}
  for (const spec of TELEM_OPTIONS) {
    const coerce = COERCERS[spec.coercion]
    let resolved
    let level
    for (const layer of layers) {
      // Own-property only: a key inherited from Object.prototype is not config.
      if (!layer.data || !Object.prototype.hasOwnProperty.call(layer.data, spec.key)) continue
      const candidate = coerce(layer.data[spec.key])
      if (candidate !== undefined) {
        resolved = candidate
        level = layer.level
        break
      }
    }
    if (level === undefined) {
      const fromEnv = optionFromEnv(spec, env)
      if (fromEnv !== undefined) {
        resolved = fromEnv
        level = "env"
      }
    }
    if (level !== undefined) {
      values[spec.key] = resolved
      sources[spec.key] = level
    }
  }

  return { values, sources, warnings, telemDir: telemDir.dir }
}

const SOURCE_RANK = { project: 0, user: 1, env: 2 }

function rankOf(sources, key) {
  const level = sources[key]
  return level in SOURCE_RANK ? SOURCE_RANK[level] : Object.keys(SOURCE_RANK).length
}

/**
 * A request may carry `tier` OR `fields`, never both (V2 answers both with a
 * 400). They resolve independently, so compose them: the MORE SPECIFIC level
 * wins, and on a true same-level tie `fields` wins — the finer instrument.
 *
 * THIS IS THE FIX: these scripts used to apply "fields always beats
 * tier", which is right only when both come from the same level and silently
 * wrong the moment a project file's `tier` meets an exported `TELEM_FIELDS`.
 * Dropping a value the user wrote down is also announced now, as everywhere else.
 */
function composeTierFields(values, sources, warnings) {
  if (typeof values.tier !== "string" || !Array.isArray(values.fields)) return
  const keepTier = rankOf(sources, "tier") < rankOf(sources, "fields")
  const tier = values.tier
  const fields = values.fields
  if (keepTier) delete values.fields
  else delete values.tier
  warnings.push(
    `[telem] both tier (${tier}) and fields (${fields.join(", ")}) are configured, ` +
      "but a request may carry only one — " +
      (keepTier ? "keeping tier, ignoring fields" : "keeping fields, ignoring tier") +
      " (the more specific source wins; on a tie, fields).",
  )
}

/**
 * When BOTH provider halves resolve, `exclude` is subtracted from `include` here
 * and only the subtracted `include` is sent.
 *
 * The server answers `include`/`exclude` naming the same provider with a 400, and
 * an `include` that resolves to nothing with a 400 as well — and both halves
 * resolving is ordinary, because they resolve per KEY (a user file's
 * `providersExclude` meets a project file's `providersInclude`). `include`
 * REPLACES the deployment's default set, so it already names the whole candidate
 * set and "run these, minus those" is exactly `include \ exclude`.
 *
 * An emptied `include` drops BOTH halves: the config states an empty provider
 * set, so the deployment default runs — loudly — instead of every search failing.
 * A disjoint pair is silent (dropping a no-op is not news). `exclude` ALONE keeps
 * riding verbatim: only the server can enumerate the set it subtracts from.
 */
function composeProviders(values, warnings) {
  const include = values.providersInclude
  const exclude = values.providersExclude
  if (include === undefined || exclude === undefined) return

  const excluded = new Set(exclude)
  const kept = include.filter((name) => !excluded.has(name))
  const dropped = include.filter((name) => excluded.has(name))
  delete values.providersExclude

  if (kept.length) {
    values.providersInclude = kept
    if (!dropped.length) return
    warnings.push(
      `[telem] providersExclude removes ${dropped.join(", ")} from providersInclude: ` +
        `this search runs ${kept.join(", ")}. A request may not name the same provider in ` +
        "both halves, so the exclusion is applied to the config and only providersInclude " +
        "is sent.",
    )
    return
  }
  delete values.providersInclude
  warnings.push(
    `[telem] providersExclude (${exclude.join(", ")}) removes every provider in ` +
      `providersInclude (${include.join(", ")}): this config resolves to an EMPTY provider ` +
      "set, which no search can run, so BOTH halves are dropped and the deployment's default " +
      "provider set is running instead.",
  )
}

/**
 * `providerOverrides` applies only alongside `providersInclude`, and only to
 * providers named there; anything else is DROPPED rather than forwarded. The
 * resolved include list is the only statement of the selected set a client
 * holds, and an override that cannot be checked against it is not sent.
 *
 * It runs LAST, after the subtraction above, so "the resolved providersInclude"
 * means the one the request will actually carry.
 */
function guardProviderOverrides(values, warnings) {
  const overrides = values.providerOverrides
  if (overrides === undefined) return
  const include = values.providersInclude
  const selected = new Set(include ?? [])
  const kept = Object.create(null)
  const dropped = []
  for (const name of Object.keys(overrides)) {
    if (selected.has(name)) kept[name] = overrides[name]
    else dropped.push(name)
  }
  if (!dropped.length) return
  if (Object.keys(kept).length) values.providerOverrides = kept
  else delete values.providerOverrides

  const because =
    include === undefined
      ? "providerOverrides applies only alongside providersInclude, and providersInclude is not " +
        "set, so the deployment's own default provider set is running"
      : "providerOverrides applies only to providers named in the resolved providersInclude " +
        `(${include.join(", ")})`
  warnings.push(
    `[telem] ignoring providerOverrides for ${dropped.join(", ")}: ${because}. ` +
      `Add ${dropped.map((name) => JSON.stringify(name)).join(", ")} to providersInclude in the ` +
      `same config to use ${dropped.length > 1 ? "them" : "it"} — noting that providersInclude ` +
      "REPLACES the deployment's default provider set with exactly the providers you list, " +
      "rather than adding to it.",
  )
}

/**
 * The resolved options plus the two composition rules, ready to render.
 * `{ values, sources, warnings }` — warnings are for STDERR, never for stdout,
 * which is what an agent reads as the search result.
 */
export function resolveSkillOptions(env = process.env, projectRoot = undefined) {
  const resolved = resolveConfigOptions(env, projectRoot)
  composeTierFields(resolved.values, resolved.sources, resolved.warnings)
  composeProviders(resolved.values, resolved.warnings)
  guardProviderOverrides(resolved.values, resolved.warnings)
  return resolved
}

/**
 * The V2 `search` block for the unified config, or null when nothing is
 * configured (an absent block means "server defaults", the common case).
 * Warnings go to stderr here — the caller gets a clean block.
 */
export function searchBlockFromConfig(env = process.env, projectRoot = undefined, warn = console.error) {
  const { values, warnings } = resolveSkillOptions(env, projectRoot)
  for (const warning of warnings) warn(warning)
  const block = {}
  if (values.tier !== undefined) block.tier = values.tier
  if (values.fields !== undefined) block.fields = values.fields
  const providers = {}
  if (values.providersInclude !== undefined) providers.include = values.providersInclude
  if (values.providersExclude !== undefined) providers.exclude = values.providersExclude
  if (Object.keys(providers).length) block.providers = providers
  if (values.fullContent !== undefined) block.include_full_content = values.fullContent
  // Built on a null prototype by the coercer; spread so the body carries nothing exotic.
  if (values.providerOverrides !== undefined) {
    block.provider_overrides = { ...values.providerOverrides }
  }
  return Object.keys(block).length ? block : null
}

// `path` defaults to `/v1/interactions` because that is where this client still
// sends search. `POST /v1/search` landed 2026-08-21 as an alias — same handler,
// same response — and is the name the docs teach, but moving the client is a
// deliberate release, not a drive-by. fetch.mjs passes "/v1/fetch"; search.mjs
// is unchanged and keeps the default.
// Read ~/.telem/credentials.json — the file create-telemai writes — reusing this
// module's own telem-dir + file readers. Never throws, silent, apiKey/baseUrl only.
// It is the LAST credential source (below env), so the installer's key reaches the
// skill scripts too instead of only a manually-exported env var.
export function readCredentials(env, projectRoot) {
  try {
    const dir = resolveTelemDir(env, projectRoot).dir
    const data = readTelemFile(join(dir, "credentials.json")).data
    if (!isPlainObject(data)) return {}
    const out = {}
    if (typeof data.apiKey === "string" && data.apiKey) out.apiKey = data.apiKey
    if (typeof data.baseUrl === "string" && data.baseUrl) out.baseUrl = data.baseUrl
    return out
  } catch {
    return {}
  }
}

export async function postInteraction(body, path = "/v1/interactions") {
  const creds = readCredentials(process.env, process.cwd())
  const baseUrl = (
    process.env.TELEM_BASE_URL ??
    creds.baseUrl ??
    "https://router.telem.ai"
  ).replace(/\/+$/, "")
  const headers = { "Content-Type": "application/json" }
  const apiKey = process.env.TELEM_API_KEY ?? creds.apiKey
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Telem request failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
  }
  return response.json()
}

// The V2 capability gate: the renderer reads one shape and has no alias ladder,
// so a pre-V2 server must fail loudly rather than render "the web had nothing".
export function assertV2Envelope(interaction) {
  const version = interaction?.normalized_schema_version
  if (!Number.isInteger(version) || version < 2) {
    throw new Error(
      `Telem server answered without the normalized search envelope (normalized_schema_version=${version}); ` +
        "upgrade the backend or point TELEM_BASE_URL at a current deployment",
    )
  }
}

// --- search rendering (port of the telem-render region) ---------------------

function line(value) {
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ") : ""
}

function renderRow(provider, row) {
  const lines = [`[${provider}] URL: ${line(row?.url)}`]
  const title = line(row?.title)
  if (title) lines.push(`Title: ${title}`)
  const summary = line(row?.summary)
  if (summary) lines.push(`Summary: ${summary}`)

  const entries = (Array.isArray(row?.excerpt) ? row.excerpt : []).map((entry) => line(entry)).filter(Boolean)
  if (entries.length) {
    lines.push("Excerpt:")
    for (const entry of entries.slice(0, RENDER_EXCERPT_MAX_ENTRIES)) {
      const cut = entry.length > RENDER_EXCERPT_MAX_CHARS
      lines.push(`- ${cut ? entry.slice(0, RENDER_EXCERPT_MAX_CHARS) + "…" : entry}`)
    }
    const dropped = entries.length - RENDER_EXCERPT_MAX_ENTRIES
    if (dropped > 0) lines.push(`…(${dropped} more excerpt entries)`)
  }

  const published = line(row?.publish_date)
  if (published) lines.push(`Published: ${published}`)
  const source = row?.source
  if (source && typeof source === "object") {
    const name = line(source.name) || line(source.domain)
    const author = line(source.author)
    if (author) lines.push(`Source: ${name ? `${name} by ${author}` : `by ${author}`}`)
    else if (line(source.name)) lines.push(`Source: ${name}`)
  }
  return lines.join("\n")
}

function renderQueryBlock(runs) {
  const lines = []
  let answer = ""
  const questions = []
  const searches = []
  for (const run of runs) {
    const payload = run?.output_payload
    if (!payload || typeof payload !== "object") continue
    if (!answer) answer = line(payload.answer)
    const related = payload.related
    if (!related || typeof related !== "object") continue
    for (const item of Array.isArray(related.questions) ? related.questions : []) {
      const text = line(item)
      if (text) questions.push(text)
    }
    for (const item of Array.isArray(related.searches) ? related.searches : []) {
      const text = line(item)
      if (text) searches.push(text)
    }
  }
  if (answer) lines.push(`Answer: ${answer}`)
  const related = [...new Set([...questions, ...searches])].slice(0, RENDER_RELATED_MAX_ITEMS)
  if (related.length) lines.push(`Related: ${related.join(", ")}`)
  return lines
}

function renderQuerySection(runs) {
  const blocks = []
  const rowBlocks = []
  for (const run of runs) {
    const provider = line(run?.preprocessor_name) || "unknown"
    const payload = run?.output_payload
    const rows = Array.isArray(payload?.results) ? payload.results : null
    const error = run?.error
    if (run?.status === "failed" || (!rows && error)) {
      const message = line(error?.message) || line(error?.type) || "unknown error"
      rowBlocks.push(`[${provider}] failed: ${message}`)
      continue
    }
    if (!rows?.length) {
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
      const degraded = warnings.find((warning) => warning?.code === "normalize_failed")
      if (degraded) {
        const message = line(degraded.message) || "normalize_failed"
        rowBlocks.push(`[${provider}] no rows (${message})`)
      }
      continue
    }
    for (const row of rows) rowBlocks.push(renderRow(provider, row))
  }
  const head = renderQueryBlock(runs)
  if (head.length) blocks.push(head.join("\n"))
  blocks.push(...(rowBlocks.length ? rowBlocks : ["No results found."]))
  return blocks.join("\n\n")
}

export function formatSearchResults(interaction) {
  const groups = new Map()
  for (const run of interaction?.preprocessor_runs ?? []) {
    const index = typeof run?.batch_index === "number" ? run.batch_index : 0
    let group = groups.get(index)
    if (!group) groups.set(index, (group = { query: "", runs: [] }))
    if (!group.query) group.query = line(run?.query)
    group.runs.push(run)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group)

  if (ordered.length <= 1) return renderQuerySection(ordered[0]?.runs ?? [])

  const text = ordered
    .map((group, i) => {
      const label = group.query ? `Query ${i + 1}: ${group.query}` : `Query ${i + 1}`
      return `### ${label}\n${renderQuerySection(group.runs)}`
    })
    .join("\n\n")
  if (text.length <= RENDER_TOTAL_CAP) return text
  return (
    text.slice(0, RENDER_TOTAL_CAP) +
    `\n\n…(batch output truncated at ${RENDER_TOTAL_CAP} characters — re-run the remaining queries in a smaller batch)`
  )
}

// --- fetch validation + rendering -------------------------------------------

export function validateFetchUrls(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("fetch requires at least one URL.")
  }
  const trimmed = raw.map((url) => String(url).trim())
  for (const url of trimmed) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `fetch only reads http(s) URLs, got ${JSON.stringify(url)}. ` +
          "Pass absolute URLs starting with http:// or https://.",
      )
    }
  }
  const urls = [...new Set(trimmed)]
  if (urls.length > FETCH_MAX_URLS) {
    throw new Error(
      `fetch reads at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length}). ` +
        "Split the read into multiple calls.",
    )
  }
  return urls
}

function formatFetchedRow(row) {
  const url = typeof row?.url === "string" ? row.url : ""
  const title = typeof row?.title === "string" ? row.title : ""
  const status = typeof row?.status === "string" ? row.status : "unknown"
  const header = `### ${url}` + (title ? `\nTitle: ${title}` : "") + `\nStatus: ${status}`
  if (status !== "succeeded") {
    const error = row?.error
    const brief =
      error && (error.type || error.message)
        ? `\nError: ${[error.type, error.message].filter(Boolean).join(": ")}`
        : ""
    return header + brief
  }
  const content = typeof row?.content === "string" ? row.content : ""
  const truncated = content.length > FETCH_CONTENT_CAP || row?.content_truncated === true
  const note = truncated ? `\n\n[Content truncated at ${FETCH_CONTENT_CAP} characters]` : ""
  return `${header}\n\n${content.slice(0, FETCH_CONTENT_CAP)}${note}`
}

export function formatFetchResults(interaction) {
  const preRuns = (interaction?.preprocessor_runs ?? []).filter(
    (r) => r?.preprocessor_name === "web_fetch",
  )
  const rows = []
  if (preRuns.length > 0) {
    preRuns.sort((a, b) => (a?.batch_index ?? 0) - (b?.batch_index ?? 0))
    for (const run of preRuns) {
      const fetched = run?.output_payload?.fetched_results
      if (Array.isArray(fetched)) rows.push(...fetched)
    }
  } else {
    const run = (interaction?.postprocessor_runs ?? []).find(
      (r) => r?.postprocessor_name === "web_fetch_cache",
    )
    const fetched = run?.output_payload?.fetched_results
    if (Array.isArray(fetched)) rows.push(...fetched)
  }
  if (rows.length === 0) {
    return "The fetch produced no results (the backend returned no web fetch output)."
  }
  return rows.map(formatFetchedRow).join("\n\n")
}
