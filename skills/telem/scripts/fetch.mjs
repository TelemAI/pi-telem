#!/usr/bin/env node
// Telem web fetch from the command line (see ./SKILL.md).
//
// Usage: fetch.mjs <url> [<url> ...]     (at most 5 URLs per call)
//
// Configure via TELEM_BASE_URL and TELEM_API_KEY.
import { pathToFileURL } from "node:url"
import { formatFetchResults, postInteraction, validateFetchUrls } from "./telem-common.mjs"

export function buildFetchBody(rawUrls) {
  const urls = validateFetchUrls(rawUrls)
  // /v1/fetch: the body carries the top-level `urls`
  // list and the backend assembles the fetch pipeline itself. The endpoint is
  // extra="forbid", so no legacy user_input / processor-name keys. `kind` stays
  // in metadata: the endpoint rejects a kind that CONTRADICTS it, and "fetch"
  // agrees with it.
  return { urls, metadata: { kind: "fetch", source: "pi-skill" } }
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.log("Usage: fetch.mjs <url> [<url> ...]   (at most 5 http(s) URLs per call)")
    console.log("\nEnvironment:")
    console.log("  TELEM_BASE_URL   Telem deployment (default https://router.telem.ai)")
    console.log("  TELEM_API_KEY    Bearer token (omit for open deployments)")
    process.exit(1)
  }
  const interaction = await postInteraction(buildFetchBody(args), "/v1/fetch")
  console.log(formatFetchResults(interaction))
}

// Only run as a CLI; importing this module (tests) must not fire a request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error?.message ?? error}`)
    process.exit(1)
  })
}
