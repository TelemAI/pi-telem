---
name: telem
description: Web search and web page fetching routed through the Telem backend. Use for searching documentation, facts, or any current web content, and for reading the full text of web pages. Lightweight, no browser required.
---

# Telem Web Search & Fetch

Web search and page fetching through a Telem deployment: the Search and Fetch
operations. Use the bundled scripts rather than building requests by hand.
The backend routes each search across its configured providers and returns a
normalized result envelope; fetches return readable page text.

## Preferred path: the extension tools

If the `telem_search` and `telem_fetch` tools are available in this session (the
Telem Pi extension is installed), **use those tools directly** instead of the
scripts below — they additionally send query lineage with each call.

## Setup

Give the scripts your credentials (add to your shell profile):

```bash
export TELEM_API_KEY="your-api-key"        # from https://app.telem.ai
# TELEM_BASE_URL defaults to https://router.telem.ai; set it only if Telem gave you another endpoint
```

The scripts are zero-dependency Node; no install step is required.

## Search options: one config, every harness

Search options come from the same `.telem/telem.json` pair every Telem surface
reads, resolved fresh on every invocation, **per key**, top wins:

| Level | Where |
|---|---|
| project | `<cwd>/.telem/telem.json` — the directory you run the script in |
| user | `~/.telem/telem.json` (`TELEM_CONFIG_DIR` relocates the directory) |
| env | `TELEM_*` (below) |

```json
{
  "$schema": "https://telem.ai/schemas/config-v1.json",
  "tier": "extended",
  "providersExclude": ["slowprovider"]
}
```

File keys and their env fallbacks: `tier`/`TELEM_TIER`, `fields`/`TELEM_FIELDS`,
`providersInclude`/`TELEM_PROVIDERS_INCLUDE`,
`providersExclude`/`TELEM_PROVIDERS_EXCLUDE`, `fullContent`/`TELEM_FULL_CONTENT=1`,
and `providerOverrides` (file only). An empty value reads like an omitted key, an
unknown key is ignored, and a malformed file is ignored with a note on stderr
rather than failing the search.

`TELEM_PROVIDERS` is still honored as a **deprecated alias** of
`TELEM_PROVIDERS_INCLUDE`, read strictly below it (and below both files). Export
`TELEM_PROVIDERS_INCLUDE` instead.

Three rules are applied on top, in this order:

1. A request may carry `tier` **or** `fields`, never both: the more specific
   level wins, and on a tie `fields` wins.
2. When **both** `providersInclude` and `providersExclude` resolve, the exclusion
   is subtracted from the include and only `providersInclude` is sent — the
   server rejects a request naming the same provider in both halves. If that
   leaves nothing, both halves are dropped and the deployment's default providers
   run instead, so a config can never resolve to an empty provider set.
   `providersExclude` alone is forwarded untouched.
3. `providerOverrides` applies only alongside the resolved `providersInclude`,
   and only to providers named there.

Anything a rule drops is said once, on stderr.

Note the difference from the Pi **extension**: these are standalone CLI scripts,
so they have no host trust signal and read the config of the directory you run
them in, and the deprecated `.pi/telem.json` files are extension-only.

## Search

```bash
{baseDir}/scripts/search.mjs "query"                          # single query
{baseDir}/scripts/search.mjs "query one" "query two"          # batch: one interaction, labelled sections
{baseDir}/scripts/search.mjs "query" --goal "release research" # label this search in monitoring
```

Batch related queries for the same step into ONE invocation — the backend runs
them concurrently as a single interaction.

Options come from the config above; the environment is its lowest level. See
"Search options" for the full table.

## Fetch pages

```bash
{baseDir}/scripts/fetch.mjs https://example.com/article               # one page
{baseDir}/scripts/fetch.mjs https://a.com https://b.com https://c.com # up to 5 per call
```

Search returns snippets, never full pages; use `fetch.mjs` to read a page in
depth. At most 5 URLs per call — for more pages, make several calls.

## Output format

Search prints one section per query. Each result row is tagged with the
provider that found it:

```
Answer: ...                     (when a provider answered the query directly)
Related: ...                    (related questions/searches)

[provider] URL: https://example.com/page
Title: Page Title
Summary: ...
Excerpt:
- ...
Published: 2026-01-01
```

Fetch prints one `### <url>` section per page with its status and readable
text (truncated at 20 000 characters per page).

## When to use

- Searching for documentation, API references, facts, or current information
- Reading the full text of specific web pages
- Any task requiring web search without interactive browsing
