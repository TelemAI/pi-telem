#!/usr/bin/env node
// Telem web search from the command line (see ./SKILL.md).
//
// Usage: search.mjs "query" ["another query" ...] [--goal "label"]
//
// One invocation = one Telem interaction; multiple queries run concurrently
// server-side and render as labelled sections. Credentials come from
// TELEM_BASE_URL / TELEM_API_KEY; search options come from the unified Telem
// config — `<cwd>/.telem/telem.json` > `~/.telem/telem.json` > TELEM_* — read
// fresh on every invocation (see SKILL.md).
import { pathToFileURL } from "node:url"
import {
  assertV2Envelope,
  formatSearchResults,
  postInteraction,
  searchBlockFromConfig,
} from "./telem-common.mjs"

export function buildSearchBody(queries, goal, env = process.env, projectRoot = process.cwd()) {
  const cleaned = queries.map((q) => String(q).trim()).filter(Boolean)
  if (!cleaned.length) throw new Error("search requires at least one non-empty query.")
  const body = {
    // Single query keeps the legacy dict shape; a batch is a list — the same
    // wire shapes the pi extension and opencode plugin send.
    user_input: cleaned.length === 1 ? { query: cleaned[0] } : cleaned.map((query) => ({ query })),
    postprocessor_names: [],
    metadata: { kind: "search", source: "pi-skill" },
  }
  if (goal) body.metadata.goal = goal
  // The project layer is the directory this script was run in — the same cwd the
  // agent is working in. Config warnings go to stderr; stdout stays results-only.
  const search = searchBlockFromConfig(env, projectRoot)
  if (search) body.search = search
  return body
}

async function main() {
  const args = process.argv.slice(2)
  let goal
  const goalIndex = args.indexOf("--goal")
  if (goalIndex !== -1) {
    goal = args[goalIndex + 1]
    args.splice(goalIndex, 2)
  }
  if (!args.length) {
    console.log('Usage: search.mjs "query" ["another query" ...] [--goal "label"]')
    console.log("\nCredentials (environment only):")
    console.log("  TELEM_BASE_URL              Telem deployment (default https://router.telem.ai)")
    console.log("  TELEM_API_KEY               Bearer token (omit for open deployments)")
    console.log("\nSearch options — <cwd>/.telem/telem.json > ~/.telem/telem.json > env, per key:")
    console.log("  tier / fields               TELEM_TIER / TELEM_FIELDS (only one is sent)")
    console.log("  providersInclude/Exclude    TELEM_PROVIDERS_INCLUDE / TELEM_PROVIDERS_EXCLUDE")
    console.log("  fullContent                 TELEM_FULL_CONTENT=1")
    console.log("  providerOverrides           (file only; needs providersInclude)")
    process.exit(1)
  }
  const interaction = await postInteraction(buildSearchBody(args, goal))
  assertV2Envelope(interaction)
  if (interaction.session_id) console.log(`Telem search session: ${interaction.session_id}\n`)
  console.log(formatSearchResults(interaction))
}

// Only run as a CLI; importing this module (tests) must not fire a request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error?.message ?? error}`)
    process.exit(1)
  })
}
