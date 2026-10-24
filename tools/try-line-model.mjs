// Tries a local Ollama model on production-line layout tasks.
//   node tools/try-line-model.mjs [--model qwen3.8:latest] [--attempts 6] [--sample name] [--save file] [--stack true] [--exact true]
// With --save, the first accepted layout's blueprint string is written to file.
import fs from "node:fs"
import zlib from "node:zlib"
import { askForLineLayout } from "../blueprint/llm.js"
import { defaultLineParams } from "../blueprint/line.js"
import { encodeBlueprint } from "../blueprint/codec.js"
import { STACK_INSERTERS } from "../blueprint/entities.js"
import { SAMPLES } from "./samples.mjs"

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1]
}
const model = args.model || "qwen3.8:latest"
const attempts = parseInt(args.attempts || "6", 10)
const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))
if (args.stack === "true") {
    data.allowedInserters = STACK_INSERTERS
}
const deflate = bytes => new Uint8Array(zlib.deflateSync(bytes, {level: 9}))

const names = args.sample ? [args.sample] : ["circuits-from-ore", "inserters-from-parts", "inserters-from-plates"]
console.log(`model ${model}, up to ${attempts} attempts`)
let passed = 0
for (let name of names) {
    let sample = SAMPLES[name]
    let spec = {root: {...sample.line.root, rate: sample.rate}, east: sample.line.east, west: sample.line.west}
    let started = Date.now()
    let result
    try {
        result = await askForLineLayout({provider: "ollama", model, spec, data, maxAttempts: attempts, exact: args.exact === "true"})
    } catch (e) {
        console.log(`\n${name}: ERROR ${e.message}`)
        continue
    }
    let seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\n${name}: ${result.ok ? "ACCEPTED" : "REJECTED"} after ${result.attempts} attempt(s), ${seconds}s`)
    let machines = p => `${p.root.machines} final, ` + ["east", "west"].map(s => `${s} [${p[s].stages.map(x => x.machines).join(",")}]`).join(", ")
    if (result.ok) {
        passed++
        console.log("  model chose: " + machines(result.params))
        console.log("  default:     " + machines(defaultLineParams(spec, data)))
        if (args.save && passed === 1) {
            fs.writeFileSync(args.save, encodeBlueprint(result.blueprint, deflate))
        }
    } else {
        for (let e of result.errors) {
            console.log("  - " + e)
        }
    }
    for (let entry of result.log) {
        if (entry.errors && entry.errors.length) {
            console.log(`  attempt ${entry.attempt} rejected: ${entry.errors.join("; ")}`)
        }
    }
}
console.log(`\n${passed}/${names.length} accepted`)
