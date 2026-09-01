// Telem web search + web fetch for the pi coding agent.
//
// The pi counterpart of the sibling plugin (V2 contract) and
// the sibling plugin — the same two tools (`telem_search`, `telem_fetch`)
// against `POST /v1/interactions`, the same V2 `search` block + normalized
// envelope gate, and the same trajectory v5 wire protocol, adapted to pi's
// ExtensionAPI and session model.
//
// Install as a pi package (see ././README.md) or try it with
// `pi -e path/to/the pi surface.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The unified config contract lives in ONE place for every Telem surface —
// option table, `.telem` file layer, six-level resolution. It is
// imported as source with an explicit `.ts` extension, which both consumers of
// this file understand: `node --test` type stripping, and the esbuild bundle
// that becomes `@telemai/pi-telem`. `config-core` is `erasableSyntaxOnly`
// precisely so that stays true.
import {
  createConfigReader,
  createNoticeSink,
  isBehind,
  noticeAlreadyShown,
  readCredentials,
  resolveHarnessOptions,
  resolveTelemDir,
} from "../../config-core/index.ts"
import type { TelemOptions } from "../../config-core/index.ts"
// The injected, package.json-lockstep self-version. The per-surface
// update command is a hand-inlined LITERAL (PI_UPDATE_COMMAND, below) rather than
// an import of the shared corpus JSON: the published package ships `dist/` only,
// not the config-core fixtures, so the JSON cannot be read at runtime — and
// importing it inlined the whole file (its internal `_note`/`_pending` prose
// included) into the bundle. A test pins the literal equal to the corpus row, the
// same anti-drift pattern openclaw and the SDK use.
import { PLUGIN_VERSION } from "./version.ts"

const HISTORY_TEXT_CAP = 128000 // per-message cap; tool results can embed whole files

const TOOL_INPUT_CAP = 128000

// telem_fetch (fetch-interactions spec): client-side mirror of the server's
// web_fetch_max_urls default, and the per-URL inline-content cap (the backend's
// inline cap — 5 × 20000 also keeps a full batch inside 100 KB of output).
const FETCH_MAX_URLS = 5
const FETCH_CONTENT_CAP = 20000

// ---------------------------------------------------------------------------
// Configuration (unified config spec). Resolved PER CALL, inside every
// tool execute — nothing is frozen at extension load, so editing a config file
// or exporting an env var takes effect on the very next tool call without
// restarting pi.
//
// Precedence is per KEY, top wins. pi exposes no host-native options slot, so
// it starts at level 2 of the shared ladder:
//   2. project `<cwd>/.telem/telem.json`     ← the one file every harness reads
//   3. project `.pi/telem.json`              ← DEPRECATED, own level
//   4. `~/.config/pi/telem.json`             ← DEPRECATED, above (5) on purpose
//   5. user `~/.telem/telem.json`            ← honors TELEM_CONFIG_DIR
//   6. `TELEM_*` env
//
// BOTH project layers (2 and 3) are honored only for trusted projects — pi's own
// rule for project-local dynamic config. The user layers are unaffected.
//
// Levels 2-6 and every rule they obey (coercion, empty-means-absent, the
// tier/fields tie-break, the providerOverrides guard) live in `config-core` and
// are shared byte-for-behavior with the opencode plugin and the Python readers.
// Credentials (`TELEM_BASE_URL`/`TELEM_API_KEY`) have no file key — they stay
// env-only — but are read per call all the same.
// ---------------------------------------------------------------------------

// pi's project config directory. Hardcoded rather than importing CONFIG_DIR_NAME
// so the module stays importable outside a pi runtime (tests, skill tooling);
// rebranded pi distributions that rename `.pi` also rename this file's home.
const LEGACY_PROJECT_CONFIG_PATH = [".pi", "telem.json"]
const LEGACY_USER_CONFIG_PATH = [".config", "pi", "telem.json"]

type TelemConfig = TelemOptions & { baseUrl: string; apiKey?: string }

// Module scope: the extension is one long-lived instance per session, so the
// parse cache and the notice sink outlive individual calls. The cache re-reads a
// file when its stat signature moves and the sink repeats a statement only when
// what it describes changes — together, one warning per EDIT, not per search.
const readConfigFile = createConfigReader((message: string) => console.warn(message))
const emitNotices = createNoticeSink((message: string) => console.warn(message))

// ---------------------------------------------------------------------------
// Client update advisory (spec the design notes
// On a 2xx search/fetch whose body parsed, the server MAY name the version
// it recommends for THIS surface. If our injected PLUGIN_VERSION is strictly
// behind it, we emit a ONE-TIME, OFF-MODEL notice on pi's `console.warn` channel
// (the same live channel its config warnings use, extensions/telem/index.ts) —
// never the tool result the model reads. Notify-only: this compares versions and
// prints a message; it NEVER updates anything.
//
// The comparison (`isBehind`) and the cross-run stamp gate (`noticeAlreadyShown`)
// are shared, drift-pinned pieces imported from config-core as SOURCE; the update
// command is a hand-inlined literal (PI_UPDATE_COMMAND). Everything below is the
// thin per-surface SHELL — env opt-out, TTY/CI detection, the stamp file, the
// clock, the notice — the pi mirror of opencode's T3 (T5).
//
// The advisory KEY is a FIXED LITERAL, decoupled from HARNESS_ID:
// this surface always reads `recommended.pi`, never its trajectory id.
const ADVISORY_KEY = "pi"
const UPDATE_STAMP_FILE = "update-notice.json"

// The exact pi update instruction — hand-inlined equal to the shared corpus's
// `"pi"` row (the shared config contract). It is a LITERAL (not an
// import of the JSON) because the published bundle ships `dist/` only and cannot
// read the fixtures at runtime; tests/update-advisory.test.ts pins this `===` that
// row.
const PI_UPDATE_COMMAND = "The Telem pi extension can be updated with: pi install npm:@telemai/pi-telem"

// In-process dedup, keyed by the recommended version string: a
// long-lived pi daemon re-notifies ONCE per server-bumped version, never per
// call, and a same-version re-run stays silent. Module scope so it outlives
// calls, joining the config parse cache and the notice sink above.
const advisoryNotified = new Set<string>()

// The `body.client_advisory?.recommended?.pi` path — silent (undefined) on a
// null/absent/malformed field, never a throw (spec read step, rule 5).
function readAdvisoryVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const advisory = (body as Record<string, unknown>).client_advisory
  if (!advisory || typeof advisory !== "object") return undefined
  const recommended = (advisory as Record<string, unknown>).recommended
  if (!recommended || typeof recommended !== "object") return undefined
  const value = (recommended as Record<string, unknown>)[ADVISORY_KEY]
  return typeof value === "string" ? value : undefined
}

// Env-only opt-out: `TELEM_NO_UPDATE_NOTICE=1` suppresses
// entirely. Matches the shipped env-flag rule (`optionFromEnv`: only "1" turns a
// flag on); trimmed so a stray space does not defeat the lever.
function updateNoticeOptedOut(): boolean {
  return (process.env.TELEM_NO_UPDATE_NOTICE ?? "").trim() === "1"
}

// Non-interactive one-shots (`pi -p`, piped stdin, CI) are a fresh process per
// call with an empty in-memory dedup — they would notify on EVERY run, and the
// notice only makes sense in an interactive session anyway. Suppress there (spec
// re-implemented per surface (create-telemai's copy is not importable).
function updateNoticeSuppressedByContext(): boolean {
  return !process.stdin.isTTY || Boolean(process.env.CI)
}

// Today as a local `YYYY-MM-DD`. The stamp gates "once per day"; a coarse local
// calendar day is the right granularity and needs no tz dependency.
function todayStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

type UpdateStamp = Record<string, { version?: string; lastShownDate?: string }>

// `~/.telem/update-notice.json`, next to credentials.json and honoring
// TELEM_CONFIG_DIR (same directory resolution as the credentials file). No
// projectRoot: "told once per release" is a user-level fact, not a per-repo one.
function updateStampDir(): string {
  return resolveTelemDir(process.env).dir
}

// SILENT by design: a missing / unreadable / malformed stamp is "nothing shown
// yet", so a lost stamp degrades to show-once — it must never throw
// into the turn.
function readUpdateStamp(): UpdateStamp {
  try {
    const parsed = JSON.parse(readFileSync(join(updateStampDir(), UPDATE_STAMP_FILE), "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as UpdateStamp) : {}
  } catch {
    return {}
  }
}

// Record that this surface showed the notice for `version` on `today`. `mkdir -p`
// first — an env-only user who never ran create-telemai has no `~/.telem` yet
// A write failure degrades to "notify again next run", never a throw.
function writeUpdateStamp(version: string, today: string): void {
  try {
    const dir = updateStampDir()
    mkdirSync(dir, { recursive: true })
    const stamp = readUpdateStamp()
    stamp[ADVISORY_KEY] = { version, lastShownDate: today }
    writeFileSync(join(dir, UPDATE_STAMP_FILE), JSON.stringify(stamp))
  } catch {
    /* notify-only: a stamp write must never break a search. */
  }
}

// The per-surface SHELL of the update advisory, called right
// after `recordDelivery` at both post-parse sites. Gates, IN THIS ORDER — each
// reads from where the comment says — then warns once. Everything is wrapped: a
// malformed field, an unreadable stamp, all silently no-op (rule 5). It NEVER
// touches the tool result the model reads — `console.warn` is off-model.
function maybeNotifyClientUpdate(body: unknown): void {
  try {
    // 1. opt-out          ← env (TELEM_NO_UPDATE_NOTICE)
    if (updateNoticeOptedOut()) return
    // 2. non-interactive  ← tty/env (process.stdin.isTTY, process.env.CI)
    if (updateNoticeSuppressedByContext()) return
    // 3. read the advisory ← the parsed response body (fixed literal key)
    const recommended = readAdvisoryVersion(body)
    if (recommended === undefined) return
    // 4. in-process once  ← module-scope Set, keyed by the version string
    if (advisoryNotified.has(recommended)) return
    // 5. behind?          ← shared comparator over the injected PLUGIN_VERSION
    if (!isBehind(PLUGIN_VERSION, recommended)) return
    // 6. cross-run stamp  ← fs (~/.telem/update-notice.json) + the local clock
    const today = todayStamp()
    const stamp = readUpdateStamp()
    if (noticeAlreadyShown(stamp[ADVISORY_KEY], recommended, today)) {
      // Already told on this machine today for this version. Mark the process
      // so a long-lived daemon does not re-stat the file every call.
      advisoryNotified.add(recommended)
      return
    }
    // 7. the command      ← inlined literal, pinned to the shared corpus by a test
    // The OFF-MODEL notice. pi routes its config warnings to `console.warn`, so
    // the version notice rides the same channel — visible to the user running
    // pi, invisible to the model (it is not the tool result). One line.
    console.warn(`A newer Telem pi extension (${recommended}) is available. ${PI_UPDATE_COMMAND}`)
    advisoryNotified.add(recommended)
    writeUpdateStamp(recommended, today)
  } catch {
    /* malformed/missing everything ⇒ silent, never throw into the turn */
  }
}

// `projectRoot` is the session's working directory (ctx.cwd); the cwd is only
// the fallback, and it can THROW if the directory pi was started in is gone, in
// which case the project layers are simply absent rather than fatal. An EMPTY
// STRING is likewise "no project": config-core treats `""` as absent rather than
// joining it into a relative `.telem/telem.json`.
function resolveTelemConfig(projectRoot: string | undefined, projectTrusted: boolean): TelemConfig {
  let root: string | undefined
  try {
    root = projectRoot ?? process.cwd()
  } catch {
    root = undefined
  }
  const resolved = resolveHarnessOptions({
    env: process.env,
    projectRoot: root,
    // FAIL CLOSED: an untrusted checkout steers neither `.telem/telem.json` nor
    // the deprecated `.pi/telem.json`.
    projectLayers: projectTrusted,
    legacyProject: LEGACY_PROJECT_CONFIG_PATH,
    legacyUser: LEGACY_USER_CONFIG_PATH,
    read: readConfigFile,
  })
  emitNotices(resolved.notices)

  // Credentials resolve `env → ~/.telem/credentials.json` (the SDK's arg→env→file
  // chain), so the key `create-telemai` writes reaches pi too — env-only left an
  // installed-but-not-exported key unreachable (401 Missing API key).
  const creds = readCredentials(process.env, root)
  const config: TelemConfig = {
    ...resolved.values,
    baseUrl: (process.env.TELEM_BASE_URL ?? creds.baseUrl ?? "https://router.telem.ai").replace(
      /\/+$/,
      "",
    ),
  }
  const apiKey = process.env.TELEM_API_KEY ?? creds.apiKey
  if (apiKey) config.apiKey = apiKey
  return config
}

// The V2 `search` block, or null when nothing was configured — a body
// without the block means "server defaults", which is the common case.
// The two provider halves are forwarded exactly as configured: include REPLACES
// the deployment set and exclude then subtracts, both server-side, so the
// plugin never subtracts client-side and never resolves an overlap itself.
// `provider_overrides` has already been through the membership guard, so what
// arrives here names only providers this request actually selects.
function buildSearchBlock(options: TelemOptions): Record<string, unknown> | null {
  const block: Record<string, unknown> = {}
  if (options.tier !== undefined) block.tier = options.tier
  if (options.fields !== undefined) block.fields = options.fields
  const providers: Record<string, unknown> = {}
  if (options.providersInclude !== undefined) providers.include = options.providersInclude
  if (options.providersExclude !== undefined) providers.exclude = options.providersExclude
  if (Object.keys(providers).length) block.providers = providers
  if (options.fullContent !== undefined) block.include_full_content = options.fullContent
  if (options.providerOverrides !== undefined) {
    // The map is built on a null prototype (config-core), which JSON.stringify
    // serializes exactly like a plain object — spread it into one anyway so the
    // body carries nothing exotic.
    block.provider_overrides = { ...options.providerOverrides }
  }
  return Object.keys(block).length ? block : null
}

// ---------------------------------------------------------------------------
// Trajectory v5 identity (the design notes
// adapted to pi. The extension computes a wire payload keyed on the
// pi session's own observable state — a hashed session id and its last
// compaction — so every writer of a given node derives the same key without any
// shared client memory.
//
// Pi adaptations vs the opencode plugin:
//   - HARNESS_ID is "pi".
//   - rev comes from the ACTIVE BRANCH, not a revert pointer: pi has no
//     in-place revert, but /tree navigation continues on an alternate branch
//     of the same session (same id, possibly same compaction), which is a new
//     context-window generation all the same. rev is the id of the entry
//     where the active path leaves its nearest fork (see activeBranchRev),
//     "none" for a never-branched session — stable across appends, distinct
//     per branch.
//   - Ancestors come from the session header's `parentSession` chain (written
//     by /fork, /clone, and newSession({parentSession})), read via
//     SessionManager.open — pi's analog of opencode's parentID walk.
const HARNESS_ID = "pi"
// Fixed UUID namespace for every client-side uuid5 (never changes).
const NS_TRAJECTORY = "443866ab-1b45-5ed8-979e-52fdad07b810"
// Sentinel for a missing key component (a session with no compaction yet).
const NONE = "none"

function sha256hex(x: string): string {
  return createHash("sha256").update(x).digest("hex")
}

// Length-prefix a variable component so concatenation is injective even when a
// component itself contains ":" — "12:foo:bar" can never collide with "3:foo" +
// "3:bar". Applied to every component of every uuid5 name and hashed name.
function lp(s: string): string {
  return String(Buffer.byteLength(s, "utf8")) + ":" + s
}

// uuid5 (RFC 4122 v5, sha1-based): sha1(namespace_bytes ++ utf8(name)), first 16
// bytes with the version nibble set to 5 and the variant bits to 0b10.
function uuid5(namespace: string, name: string): string {
  const nsb = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(nsb).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // variant 0b10
  const x = b.toString("hex")
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

// Hashed context-window id: the raw pi session id never leaves the machine
// bare inside a key — only its hash does.
function contextWindowHash(sid: string): string {
  return sha256hex(sid)
}

// session_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(comp) + lp(rev)): the
// deterministic identity of one context-window generation. It moves when the
// session compacts (comp changes) or the active path switches to another
// branch of the entry tree (rev changes) — both are new generations.
function sessionKey(sid: string, comp: string, rev: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(contextWindowHash(sid)) + lp(comp) + lp(rev))
}

// fingerprint = H(lp(harness) + lp(sid)): a stable per-session token. It hashes
// the RAW sid (the hash is what leaves the machine, so no id leaks) and includes
// the harness so ids from different harnesses never collide.
function fingerprint(sid: string): string {
  return sha256hex(lp(HARNESS_ID) + lp(sid))
}

// snapshot_node_key = uuid5(NS, lp(harness) + lp(H(sid)) + lp(entry) + lp("snap")):
// the id of an ancestor's spawn-point snapshot, keyed on the ancestor's session
// and the entry at which it spawned. The lp("snap") tag keeps it in a different
// space from that session's own session_key.
function snapshotNodeKey(sid: string, entryId: string): string {
  return uuid5(NS_TRAJECTORY, lp(HARNESS_ID) + lp(contextWindowHash(sid)) + lp(entryId) + lp("snap"))
}

// ---------------------------------------------------------------------------
// Session flattening. Pi sessions are JSONL entry trees (session-format.md);
// the active context is `sessionManager.buildContextEntries` — message and
// compaction entries in context order.
// ---------------------------------------------------------------------------

// The rev component of session_key: which branch of the entry tree is active.
// pi's /tree navigation moves the leaf to an earlier entry and continues on an
// alternate branch — same session id, often the same compaction — so without
// this component two different histories would share one session_key. The rev
// is the id of the FIRST entry of the active path after its nearest fork
// (walking leaf -> root, the first entry whose parent has 2+ children): it is
// stable across ordinary appends (appending never creates a fork), and each
// alternate branch from a fork starts at a different entry, so each gets its
// own rev. A session that never branched has no fork and stays "none".
// Any failure (fake/partial SessionManager, corrupted parent pointers)
// degrades to "none" — identity derivation must never fail a search.
// `fromId` overrides the walk's starting entry (default: the current leaf) —
// ancestors are anchored at their spawn entry, not at wherever their leaf sits
// today, so a parent navigated elsewhere after the fork keeps a stable rev.
function activeBranchRev(sm: any, fromId?: string): string {
  try {
    const entries: any[] = sm.getEntries?.() ?? []
    if (!entries.length) return NONE
    const childCounts = new Map<string, number>()
    const byId = new Map<string, any>()
    for (const entry of entries) {
      if (typeof entry?.id === "string") byId.set(entry.id, entry)
      if (typeof entry?.parentId === "string") {
        childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1)
      }
    }
    const visited = new Set<string>()
    let cur: unknown = fromId ?? sm.getLeafId?.()
    while (typeof cur === "string" && cur && !visited.has(cur)) {
      visited.add(cur)
      const entry = byId.get(cur)
      if (!entry) break
      const parent = entry.parentId
      if (typeof parent === "string" && (childCounts.get(parent) ?? 0) >= 2) return String(entry.id)
      cur = parent
    }
    return NONE
  } catch {
    return NONE
  }
}

// Entries at or before a cutoff instant (a child session header's timestamp —
// immutable spawn metadata). Anchoring an ancestor's snapshot here keeps a
// parent's POST-spawn work (a session resumed and extended after forking) out
// of the child's snapshot key, context, and spawned_at: the mutable tail of
// the parent file must never move a snapshot that has already been reported.
// An unparseable cutoff or entry timestamp keeps the entry (best effort).
function entriesUpTo(entries: any[], cutoffIso: unknown): any[] {
  const cutoff = typeof cutoffIso === "string" ? Date.parse(cutoffIso) : NaN
  if (!Number.isFinite(cutoff)) return entries
  return (entries ?? []).filter((entry) => {
    const t = Date.parse(typeof entry?.timestamp === "string" ? entry.timestamp : "")
    return !Number.isFinite(t) || t <= cutoff
  })
}

// The id of the LAST compaction entry in the given entry list, or "none".
function lastCompactionId(entries: any[]): string {
  let last = NONE
  for (const entry of entries ?? []) {
    if (entry?.type === "compaction" && typeof entry.id === "string") last = entry.id
  }
  return last
}

// The last ASSISTANT message entry — the ancestor's spawn point. MUST be
// assistant, not last-of-any-role: a queued user message appended after the
// fork must not move the snapshot key.
function lastAssistantEntry(entries: any[]): { id: string; timeMs?: number } | undefined {
  let found: { id: string; timeMs?: number } | undefined
  for (const entry of entries ?? []) {
    if (entry?.type === "message" && entry?.message?.role === "assistant" && typeof entry.id === "string") {
      const t = entry.message.timestamp
      found = { id: entry.id, timeMs: typeof t === "number" ? t : undefined }
    }
  }
  return found
}

type HistoryMessage = { role: string; content: string; reasoning?: string }

// The tool call this history is being built for (telem_search or telem_fetch):
// pi has already appended the assistant message carrying the toolCall before
// execute runs, so the marker is matched by toolCallId and rendered as
// "running" with the live args.
type CurrentCall = { toolCallId: string; args: unknown; tool: string }

function toolMarker(name: string, status: string, input: unknown): string {
  // Compact acting-trace marker; full tool outputs can embed whole files, so
  // only the tool name, status, and a truncated input are forwarded.
  let rendered = ""
  try {
    if (input !== undefined) rendered = " " + JSON.stringify(input).slice(0, TOOL_INPUT_CAP)
  } catch {
    // non-serializable input; omit
  }
  return `[tool ${name}: ${status}${rendered}]`
}

function textOfUserContent(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : []
  const pieces: string[] = []
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text" && typeof part.text === "string") pieces.push(part.text)
  }
  return pieces
}

function flattenEntries(entries: any[], currentCall?: CurrentCall): HistoryMessage[] {
  // toolCallId -> terminal status, from the branch's toolResult messages. A
  // toolCall with no result yet is "pending" (parallel siblings of the current
  // call), the current call itself renders "running".
  const statusById = new Map<string, string>()
  for (const entry of entries ?? []) {
    const message = entry?.type === "message" ? entry.message : undefined
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      statusById.set(message.toolCallId, message.isError ? "error" : "completed")
    }
  }

  const history: HistoryMessage[] = []
  for (const entry of entries ?? []) {
    // A compaction entry replaces everything it summarized — the model still
    // sees that summary, so the recorded history must carry it too, or every
    // post-compaction search loses the conversation's goal and early context.
    if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary) {
      history.push({
        role: "system",
        content: ("[compaction summary] " + entry.summary).slice(0, HISTORY_TEXT_CAP),
      })
      continue
    }
    if (entry?.type !== "message") continue
    const message = entry.message
    const role = message?.role
    if (role !== "user" && role !== "assistant") continue
    const contentPieces: string[] = []
    const reasoningPieces: string[] = []
    if (role === "user") {
      contentPieces.push(...textOfUserContent(message.content))
    } else {
      for (const part of Array.isArray(message?.content) ? message.content : []) {
        if (part?.type === "text" && typeof part.text === "string") contentPieces.push(part.text)
        else if (part?.type === "thinking" && typeof part.thinking === "string") {
          if (part.thinking) reasoningPieces.push(part.thinking)
        } else if (part?.type === "toolCall") {
          if (currentCall && part.id === currentCall.toolCallId) {
            contentPieces.push(toolMarker(currentCall.tool, "running", currentCall.args))
          } else {
            const status = statusById.get(part.id) ?? "pending"
            contentPieces.push(toolMarker(part.name ?? "?", status, part.arguments))
          }
        }
      }
    }
    const content = contentPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    const reasoning = reasoningPieces.join("\n").slice(0, HISTORY_TEXT_CAP)
    if (!content && !reasoning) continue
    const historyEntry: HistoryMessage = { role, content }
    if (reasoning) historyEntry.reasoning = reasoning
    history.push(historyEntry)
  }
  return history
}

// The V2 capability gate. The renderer below reads ONE shape —
// the normalized envelope — and has no alias ladder to fall back on, so a
// pre-V2 server must fail the tool loudly rather than render an empty result
// set that reads like "the web had nothing". `normalized_schema_version` is the
// interaction-level echo; only telem_search is gated (a fetch interaction never
// carries a search envelope).
function assertV2Envelope(interaction: any): void {
  const version = interaction?.normalized_schema_version
  if (!Number.isInteger(version) || (version as number) < 2) {
    throw new Error(
      `Telem server answered without the normalized search envelope (normalized_schema_version=${version}); ` +
        "upgrade the backend or point TELEM_BASE_URL at a current deployment",
    )
  }
}

// telem-render:begin
// ---------------------------------------------------------------------------
// Search rendering — the V2 normalized envelope (search I/O normalization
//-) turned into the text the model reads. PORTABLE BY CONTRACT: this
// whole region is copied verbatim from the opencode plugin, so it may not touch
// anything host-specific (no pi context, no tool context, no env) — it is a
// pure function of one interaction body.
//
// Render budget ( the contract, final):
//   - `summary` renders WHOLE (the server already caps it at 1000 chars);
//   - `excerpt` renders at most 4 entries of at most 1000 chars each, with an
//     elision note when entries were dropped (real entries measure 1-14 KB);
//   - `full_content` is NEVER rendered inline — depth is telem_fetch's job;
//   - per-result `[<provider>]` tag: the schema keeps every provider's list
//     separate ( — no merged list, no global rank), so every row says who
//     found it;
//   - the query-level `answer`/`related` block leads each query section;
//   - a failed or degraded run contributes ONE line instead of rows;
//   - only a BATCH carries a total cap; a single-query render has none.
// A field that a tier did not request, or that a provider could not supply, is
// simply absent from the output — the envelope's own presence rule.
//
// Values are single-line by construction — provider markdown cannot outrank the
// renderer's structure.
// ---------------------------------------------------------------------------

const RENDER_EXCERPT_MAX_ENTRIES = 4
const RENDER_EXCERPT_MAX_CHARS = 1000
const RENDER_RELATED_MAX_ITEMS = 6
const RENDER_TOTAL_CAP = 128000

// EVERY provider value goes through here before it is rendered. Real summaries
// and excerpts are markdown with newlines (a parallel summary opens with `#`
// and `##` headings), and a value allowed to start a line would forge the
// renderer's own structure — a heading outranking `### Query N`, or a bare line
// that reads as content nobody attributed. Folding interior whitespace keeps
// every byte of the value on the line its label owns.
function line(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ") : ""
}

// One result row. URL is the only required field, so it anchors the row;
// everything else is a labelled line that appears only when it carries content.
function renderRow(provider: string, row: any): string {
  const lines = [`[${provider}] URL: ${line(row?.url)}`]
  const title = line(row?.title)
  if (title) lines.push(`Title: ${title}`)
  const summary = line(row?.summary)
  if (summary) lines.push(`Summary: ${summary}`)

  const entries = (Array.isArray(row?.excerpt) ? row.excerpt : [])
    .map((entry: unknown) => line(entry))
    .filter(Boolean)
  if (entries.length) {
    lines.push("Excerpt:")
    for (const entry of entries.slice(0, RENDER_EXCERPT_MAX_ENTRIES)) {
      // The ellipsis marks the cut and sits OUTSIDE the budget, exactly as the
      // server's own the contract does for summaries.
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
    // The domain is already in the URL, so it only earns a line when the
    // provider named a publication or an author to go with it.
    const name = line(source.name) || line(source.domain)
    const author = line(source.author)
    if (author) lines.push(`Source: ${name ? `${name} by ${author}` : `by ${author}`}`)
    else if (line(source.name)) lines.push(`Source: ${name}`)
  }
  // `full_content` is deliberately not rendered here — see the budget above.
  return lines.join("\n")
}

// The query-level block. These keys are per RUN, but they answer the
// QUERY, so the section carries one block: the first answer any provider
// returned, and the related items pooled across providers (questions first,
// then searches), deduped and capped.
function renderQueryBlock(runs: any[]): string[] {
  const lines: string[] = []
  let answer = ""
  const questions: string[] = []
  const searches: string[] = []
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

// Everything one query produced: its block, then each run's contribution in run
// order (rows, or a single line for a run that failed or degraded).
function renderQuerySection(runs: any[]): string {
  const blocks: string[] = []
  const rowBlocks: string[] = []
  for (const run of runs) {
    const provider = line(run?.preprocessor_name) || "unknown"
    const payload = run?.output_payload
    const rows = Array.isArray(payload?.results) ? payload.results : null
    const error = run?.error
    if (run?.status === "failed" || (!rows && error)) {
      // ONE line, like every other value: provider errors are often multi-line
      // (`…\nFor more information check: …`) and an untagged continuation line
      // reads like content.
      const message = line(error?.message) || line(error?.type) || "unknown error"
      rowBlocks.push(`[${provider}] failed: ${message}`)
      continue
    }
    if (!rows?.length) {
      // A SUCCEEDED run whose normalize raised ships the minimal envelope —
      // no rows plus one `normalize_failed` warning. Say so, or the run is
      // invisible next to its healthy siblings and reads as "nothing found".
      // A genuinely empty result set carries no such warning and stays silent.
      const warnings = Array.isArray(payload?.warnings) ? payload.warnings : []
      const degraded = warnings.find((warning: any) => warning?.code === "normalize_failed")
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

function formatSearchResults(interaction: any): string {
  // Group the runs by the query that produced them. A batch request runs N
  // queries as ONE interaction and the backend tags every run with a 0-based
  // batch_index and its query text; a single-query interaction has every run at
  // batch_index 0 and renders as one unlabelled section.
  const groups = new Map<number, { query: string; runs: any[] }>()
  for (const run of interaction?.preprocessor_runs ?? []) {
    const index = typeof run?.batch_index === "number" ? run.batch_index : 0
    let group = groups.get(index)
    if (!group) groups.set(index, (group = { query: "", runs: [] }))
    // The query is a value too — the MODEL supplies it (page text copied into a
    // search is a real path), so it goes through the same fold and can never
    // forge a section header or a provider row from inside its own label.
    if (!group.query) group.query = line(run?.query)
    group.runs.push(run)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group)

  // One query (or a response carrying no runs): field-level caps only.
  if (ordered.length <= 1) return renderQuerySection(ordered[0]?.runs ?? [])

  // A batch: one labelled section per query so the model can attribute every
  // row to the query that produced it, plus the one total cap in the renderer —
  // a 32-query batch is the only realistic way to blow up a tool result.
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
// telem-render:end

// telem_fetch pre-validation (fetch-interactions spec): friendly errors
// BEFORE any network request — the server's 400s stay the authority, this only
// saves the round trip. Returns the trimmed, deduped URL list.
function validateFetchUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("telem_fetch requires at least one URL in `urls`.")
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error("telem_fetch: every item in `urls` must be a URL string.")
    }
  }
  const trimmed = (raw as string[]).map((url) => url.trim())
  for (const url of trimmed) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `telem_fetch only reads http(s) URLs, got ${JSON.stringify(url)}. ` +
          "Pass absolute URLs starting with http:// or https://.",
      )
    }
  }
  const urls = [...new Set(trimmed)]
  if (urls.length > FETCH_MAX_URLS) {
    throw new Error(
      `telem_fetch reads at most ${FETCH_MAX_URLS} URLs per call (got ${urls.length}). ` +
        "Split the read into multiple calls.",
    )
  }
  return urls
}

// One section per fetched URL. Succeeded rows carry the page's inline content,
// capped at FETCH_CONTENT_CAP per URL (the backend's own inline cap — the note
// covers both the client-side cut and a backend-truncated row). Failed rows
// render their status and error briefly.
function formatFetchedRow(row: any): string {
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

// Render a fetch interaction. The current backend runs fetch as a FIRST-stage
// unit: one `web_fetch` preprocessor run per URL (batch_index order), each
// carrying its fetched_results row. Older backends ran it as the
// `web_fetch_cache` postprocessor — kept as a fallback so the tool works
// against either deployment.
// A missing run or an empty batch degrades to a clear message, never a throw.
function formatFetchResults(interaction: any): string {
  const preRuns = (interaction?.preprocessor_runs ?? []).filter(
    (r: any) => r?.preprocessor_name === "web_fetch",
  )
  const rows: any[] = []
  if (preRuns.length > 0) {
    preRuns.sort((a: any, b: any) => (a?.batch_index ?? 0) - (b?.batch_index ?? 0))
    for (const run of preRuns) {
      const fetched = run?.output_payload?.fetched_results
      if (Array.isArray(fetched)) rows.push(...fetched)
    }
  } else {
    // Older backend: fetch ran as the web_fetch_cache postprocessor.
    const run = (interaction?.postprocessor_runs ?? []).find(
      (r: any) => r?.postprocessor_name === "web_fetch_cache",
    )
    const fetched = run?.output_payload?.fetched_results
    if (Array.isArray(fetched)) rows.push(...fetched)
  }
  if (rows.length === 0) {
    return "The fetch produced no results (the backend returned no web fetch output)."
  }
  return rows.map(formatFetchedRow).join("\n\n")
}

// ---------------------------------------------------------------------------
// Incremental history, phase 1: an ancestor's context travels ONCE per snapshot.
// Today the same flattened ancestor history is re-sent byte-identically on every
// single call — 82% of this client's wire — and the backend is first-writer-wins
// on node content, so every re-send after the first is already a no-op.
//
// What makes dropping it safe is PROOF, not byte counting. An ancestor node
// whose FIRST arrival carries no context is stored with a null context frozen
// forever — unrepairable in the Telem backend and in obs, and it empties the conversation
// title of a purely-delegating root. So context is omitted only for a snapshot
// this process has PROVEN delivered and only to a backend that has
// PROVEN it implements the guard. Both proofs are per
// (baseUrl, key) scope, because node ids are derived from the account key
// server-side: flip either and every belief about that world is void.
//
// LIFETIME — mutable module state, joining the config parse cache and the
// notice sink near the top of the file, and it is
// module state on purpose. The extension module is evaluated once per pi
// extension host process; the tools it registers outlive every individual
// session and every individual tool call, and so must the proofs (a belief
// earned by one search is what the next search omits on). It is the same scope
// the config parse cache and the notice sink at the top of this file already
// use. Nothing survives the process: after a restart every proof is re-earned
// from the first response, and until then nothing is omitted — the safe
// direction, which is also the cost of every miss below (one full re-send).
// ---------------------------------------------------------------------------

// Snapshot keys are one-way hashes that can never be mapped back to a session,
// so idle-eviction is impossible and the cache is bounded by count alone
// An eviction costs one redundant full re-send — the safe direction.
const DELIVERED_CAP = 4096
// A process sees one or two scopes in its life. Bounded anyway; forgetting a
// capability just re-learns it from the next response, and until then nothing is
// omitted — again the safe direction.
const CAPABILITY_CAP = 64

// Insertion-ordered LRU set: re-adding refreshes recency, and the oldest key is
// the first one `keys` yields.
function createLruSet(cap: number) {
  const entries = new Map<string, true>()
  return {
    has: (key: string): boolean => entries.has(key),
    add(key: string): void {
      entries.delete(key)
      entries.set(key, true)
      while (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    remove(key: string): void {
      entries.delete(key)
    },
  }
}

// The cache scope. The API key is HASHED here and nowhere held or logged raw —
// this string ends up as a Map key, not on the wire and not in a warning.
function cacheScope(baseUrl: string, apiKey?: string): string {
  return baseUrl + " " + sha256hex(apiKey ?? "")
}

// One flat cache keyed by scope AND snapshot, so the LRU bound is a true total
// and a scope flip simply misses instead of needing its own eviction policy.
// NUL is not producible by either component (a uuid and a hashed url+key).
function deliveredKey(scope: string, snapshotKey: string): string {
  return scope + "\u0000" + snapshotKey
}

// Phase 1 is ON by default (owner decision, 2026-08-26). Read per CALL, like the
// rest of the config: flipping it takes effect on the next tool call.
//
//   ancestors | (unset)  phase 1: an ancestor's context once per snapshot
//   off                  the pre-phase-1 wire — the kill switch
//
// On by default is safe because the mode is only HALF the gate. Omitting an
// ancestor context ALSO requires the server-capability probe: this exact
// (baseUrl, key) scope must already have answered with a `missing_snapshots`
// key, which only a backend carrying the guard emits. Against an old or
// third-party backend the probe never fires, so the extension keeps sending full
// contexts — byte-identical to the pre-wave extension — and the default can
// never strand a node whose context nobody stored. `off` short-circuits the mode
// half and remains the instant, no-deploy rollback lever the Telem backend's one-way-door
// checklist depends on.
//
// Phase 2 (the history delta, spec) is NOT implemented in this extension, so
// `history` is not a mode here — it resolves to the default like any other
// unrecognized value. That fallback is deliberate: the rollback lever is the
// exact word `off` (after trim + lowercase) and nothing else, so an operator
// reaching for it should verify the value that landed, not the intent.
// TELEM_INCREMENTAL_FORCE is not a second mode — it is the differential
// harness's test-only bypass of the capability probe, never production.
function incrementalMode(): string {
  const raw = (process.env.TELEM_INCREMENTAL ?? "").trim().toLowerCase()
  return raw === "off" ? "off" : "ancestors"
}

// One ancestor entry this call chose not to send the context for. The `entry`
// is the very object inside `metadata.ancestors`, so restoring is a swap on the
// body that is about to be re-serialized — same node_key, same everything else.
type OmittedContext = { key: string; entry: Record<string, unknown>; context: HistoryMessage[] }

// Filled in by buildTrajectory: the scope this POST will use, plus — only once
// the ancestor list is final — the snapshot keys the request carries FULL
// context for. That is exactly the set a 2xx proves delivered. Bookkeeping that
// throws leaves the lists empty, so a degraded call can never mark a delivery
// that never went out, and can never take the retry path either.
type DeliveryPlan = {
  scope: string
  sentWithContext: string[]
  // The other half of the same ledger: what this request WITHHELD. Kept whole —
  // key, the entry object as it rides in the body, and the context that was
  // materialized this call and merely not sent — because the guard's 409 asks
  // for exactly this back. Empty is also the gate: a 409 on a request
  // that omitted nothing is a plain error, never a retry.
  omitted: OmittedContext[]
}

// Phase-1 belief, per host process (see LIFETIME above): `delivered` holds
// (scope, snapshot) pairs whose context is proven landed, `capability` the
// scopes whose backend implements the guard.
const delivered = createLruSet(DELIVERED_CAP)
const capability = createLruSet(CAPABILITY_CAP)

// Does THIS call omit context for snapshots already delivered to `scope`?
// Production waits for the server's own capability signal; the differential
// harness (and only it) forces the answer, its cache being correct by
// construction.
function omitsDeliveredContext(scope: string): boolean {
  if (incrementalMode() !== "ancestors") return false
  if (process.env.TELEM_INCREMENTAL_FORCE === "1") return true
  return capability.has(scope)
}

// Called only after a response came back ok AND its body parsed. Never at send
// time: a parallel sibling would otherwise omit on the strength of a request
// that can still fail before the backend's Phase B commits — which is exactly
// how a permanently context-less node is born.
//
// Marking runs even when the mode is off. Passive learning costs nothing, is
// never acted on while off, and means flipping the mode on does not need a
// warm-up call to re-earn what this process already proved.
function recordDelivery(delivery: DeliveryPlan, body: unknown): void {
  const scope = delivery.scope
  for (const key of delivery.sentWithContext) delivered.add(deliveredKey(scope, key))
  if (!body || typeof body !== "object") return
  // KEY PRESENCE, never truthiness — the healthy value is `[]`. A
  // backend without the guard omits the key entirely and so never grants
  // capability, which is what keeps an omitting client off an old server.
  if (!(MISSING_SNAPSHOTS in (body as Record<string, unknown>))) return
  capability.add(scope)
  // Reported keys are nodes the backend REFUSED to create: un-mark them so the
  // next call carries their full context again.
  const missing = (body as Record<string, unknown>)[MISSING_SNAPSHOTS]
  if (Array.isArray(missing)) {
    for (const key of missing) delivered.remove(deliveredKey(scope, String(key)))
  }
}

// Put every withheld context back into the body this call already built.
//
// Un-marking comes FIRST and is not conditional on the retry succeeding: the
// 409 falsified this process's belief that those rows exist, and a sibling
// building its body right now must carry their contexts too. A retry that then
// fails leaves them unmarked, which is the safe direction — one redundant full
// re-send.
//
// The keys move to `sentWithContext`, so the retry's 2xx marks exactly what the
// retry actually carried, through the same recordDelivery as any call.
function restoreOmittedContexts(delivery: DeliveryPlan): void {
  for (const { key, entry, context } of delivery.omitted) {
    delivered.remove(deliveredKey(delivery.scope, key))
    delete entry.context_omitted
    entry.context = context
    delivery.sentWithContext.push(key)
  }
  delivery.omitted = []
}

// ---------------------------------------------------------------------------
// The guard's refusal. When an omitted snapshot's row is
// missing, the backend refuses the whole request with HTTP 409 BEFORE any
// provider runs, before billing, before an interaction row exists — the Phase B
// transaction rolls back whole, so nothing of the request persisted. The client
// answers by restoring the withheld contexts and re-sending once.
// ---------------------------------------------------------------------------

const MISSING_SNAPSHOTS = "missing_snapshots"

// One POST, with the error body read HERE: the 409 discriminator and the text
// the tool error carries are the same bytes, and a Response body can only be
// consumed once.
async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: any,
): Promise<{ response: Response; detail: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  const detail = response.ok ? "" : await response.text().catch(() => "")
  return { response, detail }
}

// The typed code, from either envelope the two doors use: FastAPI's `detail` on
// /v1/interactions, the `{"error": {...}}` envelope on /v1/fetch. The
// bare top-level read is pure defense — a proxy that unwraps, a future door that
// does not wrap. Undefined means "this body names no code we can read", which
// includes a body that is not JSON at all.
function refusalCode(detail: string): string | undefined {
  let body: any
  try {
    body = JSON.parse(detail)
  } catch {
    return undefined
  }
  for (const shape of [body?.detail, body?.error, body]) {
    const code = shape && typeof shape === "object" ? shape.code : undefined
    if (typeof code === "string" && code) return code
  }
  return undefined
}

// Is this 409 the guard asking for the contexts back?
//
// Two judgement calls, both deliberate, because a defensive parse has to decide
// what an ambiguous body means:
//
//   - NO code readable (unparseable body, a proxy's plain-text 409, an envelope
//     shape we do not know) => TREAT IT AS THE REFUSAL. The retry is a standard
//     full request re-sending the same node_keys, so a wrong guess costs one
//     round trip; guessing the other way costs the user a failed tool call on
//     the one condition this whole path exists to heal.
//   - A code that is present and is NOT `missing_snapshots` => NOT the refusal.
//     The server named a different reason; restoring contexts cannot address it,
//     and re-POSTing a request it just refused for a stated reason is a blind
//     retry of a non-idempotent call. Surface it.
//
// And the gate above both: the request must have omitted something. A 409 on a
// request that withheld nothing is somebody else's error.
function isMissingSnapshotsRefusal(status: number, detail: string, plan: DeliveryPlan): boolean {
  if (status !== 409 || !plan.omitted.length) return false
  const code = refusalCode(detail)
  return code === undefined || code === MISSING_SNAPSHOTS
}

// The POST, plus the single in-call retry the guard's 409 asks for.
//
// The retried body is the SAME body object — same node_keys, same
// message_history, same search block — with `context_omitted` swapped back for
// `context`. The search therefore still runs exactly once: the 409 is a
// PRE-execution refusal that persisted nothing and billed nothing.
//
// `signal` is threaded through both attempts: an abort between them aborts the
// retry, exactly as it would have aborted the first send.
async function postWithOmissionRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  delivery: DeliveryPlan,
  signal: any,
): Promise<{ response: Response; detail: string }> {
  const first = await postOnce(url, headers, body, signal)
  if (!isMissingSnapshotsRefusal(first.response.status, first.detail, delivery)) return first
  restoreOmittedContexts(delivery)
  // Exactly once. `omitted` is now empty, so a second 409 cannot re-enter this
  // branch even in principle — it is surfaced as the tool error like any
  // non-ok, which is the behaviour the guard asks for.
  return await postOnce(url, headers, body, signal)
}

// ---------------------------------------------------------------------------
// Trajectory assembly. Same wire contract as the opencode plugin, on
// `body.metadata` alongside `message_history`:
//   session_key       uuid5 identity of self's context-window generation
//   fingerprint       sha256 stable per-session token
//   node_key          random uuid4 for THIS node (minted once per call)
//   kind              "search" | "fetch"
//   goal?             optional per-node label (forwarded whenever supplied)
//   parent_node_key   the DIRECT parent's snapshot key, or null if omitted
//   ancestors[]       root-first { session_key, fingerprint, node_key(snapshot),
//                     parent_node_key, context, spawned_at } for every fully
//                     materialised ancestor session file
// Bookkeeping never throws out of execute — any failure degrades to a
// best-effort self key with no ancestors.
// ---------------------------------------------------------------------------

// `withheld` is set only on an entry that omitted: the context this call DID
// materialize and chose not to send. It is what the guard's 409 asks back for
// so it is kept rather than recomputed — a second walk could read
// a session file that moved underneath us and answer a different question.
type Lineage = {
  materialized: boolean
  key?: string
  entry?: Record<string, unknown>
  withheld?: HistoryMessage[]
}

async function buildTrajectory(
  ctx: ExtensionContext,
  entries: any[],
  nodeKey: string,
  kind: string,
  delivery: DeliveryPlan,
): Promise<Record<string, unknown>> {
  const sm: any = ctx.sessionManager
  // Read ONCE for the whole walk, and against the scope this POST will use
  // — the mode and the capability probe must not be able to flip
  // between two ancestors of the same request.
  const omitDelivered = omitsDeliveredContext(delivery.scope)
  const selfId = String(sm.getSessionId())
  const traj: Record<string, unknown> = {
    session_key: sessionKey(selfId, lastCompactionId(entries), activeBranchRev(sm)),
    fingerprint: fingerprint(selfId),
    node_key: nodeKey,
    kind,
    parent_node_key: null,
    ancestors: [],
  }

  // Ancestor walk over the parentSession chain. The pi package is imported
  // lazily: inside a pi runtime it always resolves; outside one (tests, other
  // tooling) it does not, and the trajectory simply carries no ancestors.
  let SessionManager: any
  try {
    ;({ SessionManager } = (await import("@earendil-works/pi-coding-agent")) as any)
  } catch {
    return traj
  }

  // Child-first as discovered. The store is not trusted: a `visited` set bounds
  // the walk so a corrupted parentSession cycle can never hang execute.
  const lineage: Lineage[] = []
  const visited = new Set<string>()
  try {
    const selfFile = sm.getSessionFile?.()
    if (typeof selfFile === "string") visited.add(selfFile)
  } catch {
    // in-memory session; nothing to seed
  }
  // The spawn boundary for each ancestor is its CHILD's header timestamp —
  // written once at child creation, immutable thereafter (unlike the parent
  // file's tail, which grows if the parent is resumed). Start with self's.
  let childCreatedAt: unknown
  let cur: string | undefined
  try {
    const header = sm.getHeader?.()
    cur = header?.parentSession
    childCreatedAt = header?.timestamp
  } catch {
    cur = undefined
  }
  while (typeof cur === "string" && cur && !visited.has(cur)) {
    visited.add(cur)
    let parent: any
    try {
      parent = await SessionManager.open(cur)
    } catch {
      // Unreadable session file: cannot even learn its parent — stop here.
      lineage.push({ materialized: false })
      break
    }
    let next: string | undefined
    let nextCreatedAt: unknown
    try {
      const parentHeader = parent?.getHeader?.()
      next = parentHeader?.parentSession
      nextCreatedAt = parentHeader?.timestamp
      const id = String(parent.getSessionId())
      // Everything below reads the spawn-anchored view: the snapshot key, the
      // compaction component, the flattened context, and spawned_at may not
      // move when the parent gains entries after the fork.
      const ancestorEntries = entriesUpTo(parent.getEntries?.() ?? [], childCreatedAt)
      const comp = lastCompactionId(ancestorEntries)
      const spawn = lastAssistantEntry(ancestorEntries)
      const snapKey = snapshotNodeKey(id, spawn?.id ?? NONE)
      // The entry is unchanged on every key EXCEPT `context`: the
      // fingerprint still fills the session row per call, and the always-sent
      // edge set is what keeps v5 self-heal independent of client memory.
      // `context_omitted` is functional, not decorative — it is the server's
      // licence to no-op the row rather than freeze a null into it.
      const omitContext = omitDelivered && delivered.has(deliveredKey(delivery.scope, snapKey))
      // Materialized on EVERY call, omitting or not. Withholding is a send-time
      // decision — it materialized them this call and merely withheld them at
      // send time — which is precisely what makes the retry a swap rather
      // than a second walk of a session file that may have moved since.
      const context = flattenEntries(ancestorEntries)
      lineage.push({
        materialized: true,
        key: snapKey,
        withheld: omitContext ? context : undefined,
        entry: {
          // rev anchored at the spawn entry, not the parent's current leaf —
          // a parent navigated elsewhere after the fork keeps this key stable.
          session_key: sessionKey(id, comp, activeBranchRev(parent, spawn?.id)),
          fingerprint: fingerprint(id),
          node_key: snapKey,
          parent_node_key: null,
          ...(omitContext ? { context_omitted: true } : { context }),
          // When the spawn actually happened: the spawn message's own harness
          // timestamp — the true delegation moment, not backend row time.
          spawned_at: spawn?.timeMs != null ? new Date(spawn.timeMs).toISOString() : null,
        },
      })
    } catch {
      // Header readable enough to know the parent, but the snapshot could not
      // be materialised: omit this ancestor and continue past the hole.
      lineage.push({ materialized: false })
    }
    cur = typeof next === "string" ? next : undefined
    childCreatedAt = nextCreatedAt // the parent becomes the next hop's child
  }
  lineage.reverse() // root-first

  const ancestors: Record<string, unknown>[] = []
  const sentWithContext: string[] = []
  const omitted: OmittedContext[] = []
  for (let i = 0; i < lineage.length; i++) {
    const m = lineage[i]
    if (!m.materialized || !m.entry) continue
    const prev = lineage[i - 1] // the shallower (closer to root) member = real parent
    // NULL across a hole; never skip up to a surviving grandparent.
    m.entry.parent_node_key = prev && prev.materialized ? prev.key : null
    ancestors.push(m.entry)
    // The two halves of the ledger, read off the entry that actually shipped:
    // what carried context, and what withheld it (with the context kept).
    if (!m.key) continue
    if ("context" in m.entry) sentWithContext.push(m.key)
    else if (m.withheld) omitted.push({ key: m.key, entry: m.entry, context: m.withheld })
  }
  // This node's parent is the DIRECT parent's snapshot specifically. If the
  // direct parent was omitted, NULL — never float to a grandparent (a
  // single-writer node can never self-heal a wrong non-null edge).
  const direct = lineage[lineage.length - 1]
  traj.parent_node_key = direct && direct.materialized ? direct.key : null
  traj.ancestors = ancestors
  // Published at the very end, deliberately: anything that throws above leaves
  // the plan empty, so the call marks nothing — and, with `omitted` empty too, a
  // degraded call cannot take the retry path either.
  delivery.sentWithContext = sentWithContext
  delivery.omitted = omitted
  return traj
}

// Build the trajectory + history metadata for one tool call, degrading to a
// best-effort self key on ANY failure — bookkeeping never fails the tool.
async function buildMetadata(
  ctx: ExtensionContext,
  currentCall: CurrentCall,
  kind: string,
  delivery: DeliveryPlan,
): Promise<Record<string, unknown>> {
  let entries: any[] = []
  try {
    entries = (ctx.sessionManager as any).buildContextEntries() ?? []
  } catch {
    entries = []
  }
  const metadata: Record<string, unknown> = {
    message_history: flattenEntries(entries, currentCall),
  }
  const nodeKey = randomUUID()
  try {
    Object.assign(metadata, await buildTrajectory(ctx, entries, nodeKey, kind, delivery))
  } catch {
    // The degraded payload carries NO ancestors, so this call sent no context
    // and withheld none: clear both halves of the ledger rather than inherit a
    // partial one. (buildTrajectory publishes only on its way out, so this is
    // belt-and-braces — the belief that matters is "a degraded call proves
    // nothing and retries nothing".
    delivery.sentWithContext = []
    delivery.omitted = []
    let selfId = ""
    try {
      selfId = String((ctx.sessionManager as any).getSessionId())
    } catch {
      selfId = "unknown"
    }
    metadata.session_key = sessionKey(selfId, lastCompactionId(entries), NONE)
    metadata.fingerprint = fingerprint(selfId)
    metadata.node_key = nodeKey
    metadata.kind = kind
    metadata.parent_node_key = null
    metadata.ancestors = []
  }
  return metadata
}

// FAIL CLOSED: the project config layer is honored only on a positive trust
// answer. A context that cannot answer (missing API, a throw) is treated as
// untrusted — an unknown checkout must not be able to steer provider routing
// or spend via its .pi/telem.json. The home file and env still apply.
function projectTrusted(ctx: ExtensionContext): boolean {
  try {
    const fn = (ctx as any).isProjectTrusted
    return typeof fn === "function" && Boolean(fn.call(ctx))
  } catch {
    return false
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "telem_search",
    label: "Telem Search",
    description:
      "Primary tool for public-web search. When multiple web-search tools are available, prefer " +
      "`telem_search` for current information, research, fact-checking, documentation, " +
      "comparisons, and source discovery. A single-index search tool — including a host's " +
      "built-in web search — returns one provider's view of the web; one `telem_search` call " +
      "fans out across up to nine providers and returns their results provider-attributed in " +
      "one normalized envelope, so you do not need to choose a provider-specific search tool or " +
      "run the same query through several tools. Use another search tool only when the user " +
      "explicitly requests it, Telem is unavailable, or a required capability is not exposed " +
      "here. Do not search at all when the answer is already in your weights and is not " +
      "time-sensitive, when the data is private or internal rather than on the public web, or " +
      "when you already have the one URL you need — reading a known URL is `telem_fetch`'s job. " +
      "Put related queries for one research step in `queries`; they run concurrently in one " +
      "interaction. You do not manage or thread any session id. `telem_search` returns " +
      "snippets; use `telem_fetch` for full pages.",
    promptSnippet:
      "Prefer telem_search for public-web search via Telem's multi-provider router",
    promptGuidelines: [
      "Prefer telem_search when web-search tools overlap; it returns normalized, provider-attributed snippets from configured providers.",
      "Batch related queries with telem_search, then use telem_fetch to read full pages.",
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({ description: "A single search query." }), {
        minItems: 1,
        description:
          "One or more queries to search for. Pass several to run them concurrently as a single " +
          "interaction when the current step needs several searches for the current task; each " +
          "result block is labelled with its query. Give each query a different facet of the " +
          "task and make it stand on its own: [\"obligations for general-purpose AI models " +
          "under the EU AI Act in 2026\", \"how the amended EU AI Act timeline changed the " +
          "original dates\"], not [\"EU AI Act GPAI 2026\", \"EU AI Act GPAI deadline\"]. Send " +
          "at most 5 queries in one call; the backend rejects more than 32.",
      }),
      goal: Type.Optional(
        Type.String({
          description:
            "A short label naming what THIS search step is for — the current task it serves, in " +
            "a few words, not the user's whole request and not this query's keywords. The " +
            "plugin owns the session here, so this field only labels the step in the " +
            "trajectory: send it on every search where you know the task.",
        }),
      ),
    }),
    async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
      // Drop blank/whitespace-only queries so an all-empty batch is caught here
      // rather than opening a goal-less interaction the backend can only reject.
      const queries = (params.queries ?? [])
        .map((q: unknown) => (typeof q === "string" ? q.trim() : ""))
        .filter(Boolean)
      if (!queries.length) {
        throw new Error("telem_search requires at least one non-empty query in `queries`.")
      }

      // Resolved HERE, per call: a telem.json edit or a newly exported env var
      // takes effect on the next search, with no pi restart. It resolves BEFORE
      // the trajectory is built because the (baseUrl, key) scope
      // decides which ancestor contexts may be omitted, and that decision has to
      // be taken against the very scope this POST then uses — resolving
      // afterwards could omit against one world what was only ever delivered to
      // another.
      const config = resolveTelemConfig(ctx.cwd, projectTrusted(ctx))
      const delivery: DeliveryPlan = {
        scope: cacheScope(config.baseUrl, config.apiKey),
        sentWithContext: [],
        omitted: [],
      }

      const metadata = await buildMetadata(
        ctx,
        { toolCallId, args: params, tool: "telem_search" },
        "search",
        delivery,
      )
      // goal is an optional best-effort label on this search node (first-wins
      // per node on the backend). Sent whenever the model supplies one.
      if (params.goal) metadata.goal = params.goal

      // A single query keeps the legacy dict user_input so single-query traces stay
      // byte-identical; multiple queries are sent as a batch list, which the backend
      // runs concurrently as ONE interaction, tagging every run with its batch_index.
      const userInput =
        queries.length === 1 ? { query: queries[0] } : queries.map((query: string) => ({ query }))
      const body: Record<string, unknown> = {
        user_input: userInput,
        postprocessor_names: [],
        metadata,
      }
      // V2: provider selection lives in `search.providers`. Naming a
      // definition-backed provider in `preprocessor_names` is a 400 ("use
      // search.providers"), so telem_search never sends that key at all.
      // The block itself rides only on deviation — absent means defaults.
      const search = buildSearchBlock(config)
      if (search) body.search = search

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

      // A single POST — the search is not idempotent (each run bills providers
      // and creates an interaction), so a thrown transient failure is surfaced
      // rather than silently re-run. node_key is nonetheless minted once per
      // call, so any retry added at a safe layer stays a node no-op.
      //
      // The ONE exception is the guard's `missing_snapshots` 409,
      // and it does not weaken that stance: it is a PRE-EXECUTION refusal —
      // nothing ran, nothing billed, nothing persisted — so the retry is this
      // call's only execution, carrying the same node_keys.
      const { response, detail } = await postWithOmissionRetry(
        `${config.baseUrl}/v1/interactions`,
        headers,
        body,
        delivery,
        signal,
      )
      if (!response.ok) {
        throw new Error(`Telem search failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
      const interaction = await response.json()
      // Delivery is proven HERE: ok plus a body that parsed. A json
      // throw skips this line, which is the "parse failure marks nothing" rule,
      // and a non-ok already threw above.
      //
      // Deliberately BEFORE the envelope gate: a pre-V2 answer fails the SEARCH
      // for the model, but it was still a real 2xx interaction whose trajectory
      // write (Phase B, committed before the search runs) landed — those
      // ancestor contexts are in the database either way.
      recordDelivery(delivery, interaction)
      // Client update advisory: off-model (console.warn), never the
      // render below. Runs BEFORE the V2 gate for the same reason recordDelivery
      // does — it is a separate concern from whether this answer renders.
      maybeNotifyClientUpdate(interaction)
      // Refuse a pre-V2 answer before rendering anything (see the gate).
      assertV2Envelope(interaction)
      const sessionId = interaction.session_id ? String(interaction.session_id) : undefined

      // The session line is part of the output so the model itself learns the id
      // and can reference it; details additionally surface it in the TUI.
      const header = sessionId ? `Telem search session: ${sessionId}\n\n` : ""
      return {
        content: [{ type: "text", text: header + formatSearchResults(interaction) }],
        details: sessionId ? { telem_session_id: sessionId } : {},
      }
    },
  })

  pi.registerTool({
    name: "telem_fetch",
    label: "Telem Fetch",
    description:
      "Read the full text of web pages by URL. telem_search returns snippets and " +
      "never reads pages; this tool is how pages are read here. Up to 5 http(s) " +
      "URLs per call, fetched together as one batch; for more pages make several " +
      "calls.",
    promptSnippet: "Read the full text of up to 5 web pages by URL via the Telem router",
    promptGuidelines: [
      "Use telem_fetch (not bash curl) to read web pages; it fetches up to 5 URLs per call as one batch.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({ description: "An absolute http(s) URL to read." }), {
        minItems: 1,
        description:
          "The http(s) URLs of the pages to read, at most 5 per call. Duplicates are " +
          "removed.",
      }),
    }),
    async execute(toolCallId, params: any, signal, _onUpdate, ctx) {
      // Friendly pre-validation, before any I/O.
      const urls = validateFetchUrls(params.urls)

      // Config first, for the same reason as telem_search: the omission scope
      // must be the scope this POST uses. The search block is never
      // attached here, but the base url and key are shared — and they are
      // exactly what the scope is made of.
      const config = resolveTelemConfig(ctx.cwd, projectTrusted(ctx))
      const delivery: DeliveryPlan = {
        scope: cacheScope(config.baseUrl, config.apiKey),
        sentWithContext: [],
        omitted: [],
      }

      // The SAME v5 trajectory payload as telem_search — a fetch is just
      // another event node in the session — with kind "fetch" as the declared
      // intent (the backend derives authoritatively from the request shape and
      // 400s on contradiction). Same degrade stance. A fetch delivers ancestors
      // through the same handler, so a fetch 2xx is delivery proof and a fetch
      // may omit exactly like a search: ONE watermark, both tools.
      const metadata = await buildMetadata(
        ctx,
        { toolCallId, args: params, tool: "telem_fetch" },
        "fetch",
        delivery,
      )

      // The gated contract (fetch spec): user_input carries `urls` and the
      // body names NO pre/postprocessors — the backend assembles url_list +
      // web_fetch_cache itself. The search config is never attached here:
      // those knobs select SEARCH providers, and a `search` block on a fetch
      // is a 400 — only the base url and key are shared.
      const body: Record<string, unknown> = {
        urls,
        metadata,
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

      const { response, detail } = await postWithOmissionRetry(
        `${config.baseUrl}/v1/fetch`,
        headers,
        body,
        delivery,
        signal,
      )
      if (!response.ok) {
        throw new Error(`Telem fetch failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
      const interaction = await response.json()
      // Proven here, same rule as telem_search: ok, and a body that parsed.
      recordDelivery(delivery, interaction)
      // Client update advisory: off-model, never the fetch render.
      maybeNotifyClientUpdate(interaction)
      const sessionId = interaction.session_id ? String(interaction.session_id) : undefined
      return {
        content: [{ type: "text", text: formatFetchResults(interaction) }],
        details: sessionId ? { telem_session_id: sessionId } : {},
      }
    },
  })
}
