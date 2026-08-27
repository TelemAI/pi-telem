// The public check: the extension bundle builds, imports, and still default-exports the
// registration function pi calls with its ExtensionAPI.
import assert from "node:assert/strict"

const mod = await import("../dist/extensions/telem/index.js")
assert.equal(typeof mod.default, "function", "the extension must default-export a register function")
console.log("ok: @telemai/pi-telem exports an extension register function")
