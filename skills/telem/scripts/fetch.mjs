#!/usr/bin/env node
// Telem web fetch from the command line (see ./SKILL.md).
//
// Usage: fetch.mjs <url> [<url> ...]     (at most 5 URLs per call)
//
// Configure via TELEM_BASE_URL and TELEM_API_KEY. Fetch options come from the unified
// Telem config — `<cwd>/.telem/telem.json` > `~/.telem/telem.json` > TELEM_FETCH_* —
// read fresh on every invocation (see SKILL.md).
import { pathToFileURL } from "node:url"
import {
  fetchBlockFromConfig,
  formatFetchResults,
  postInteraction,
  validateFetchUrls,
} from "./telem-common.mjs"

export function buildFetchBody(rawUrls, env = process.env, projectRoot = process.cwd()) {
  const urls = validateFetchUrls(rawUrls)
  // /v1/fetch: the body carries the top-level `urls`
  // list and the backend assembles the fetch pipeline itself. The endpoint is
  // extra="forbid", so no legacy user_input / processor-name keys. `kind` stays
  // in metadata: the endpoint rejects a kind that CONTRADICTS it, and "fetch"
  // agrees with it.
  const body = { urls, metadata: { kind: "fetch", source: "pi-skill" } }
  // fetchProviders / fetchTier / fetchNoCache as the typed `options` block. The
  // project layer is the directory this script was run in; warnings go to stderr.
  const options = fetchBlockFromConfig(env, projectRoot)
  if (options) body.options = options
  return body
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.log("Usage: fetch.mjs <url> [<url> ...]   (at most 5 http(s) URLs per call)")
    console.log("\nEnvironment:")
    console.log("  TELEM_BASE_URL   Telem deployment (default https://router.telem.ai)")
    console.log("  TELEM_API_KEY    Bearer token (omit for open deployments)")
    console.log("\nFetch options — <cwd>/.telem/telem.json > ~/.telem/telem.json > env, per key:")
    console.log("  fetchProviders   TELEM_FETCH_PROVIDERS   pin the fetch providers, in order")
    console.log("  fetchTier        TELEM_FETCH_TIER        minimalist | default | extended | max")
    console.log("  fetchNoCache     TELEM_FETCH_NO_CACHE=1  skip the shared fetch cache")
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
