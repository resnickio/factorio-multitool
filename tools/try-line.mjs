// Builds a sample line without the game and prints the result.
//   node tools/try-line.mjs <sample> [--preview]
import fs from "node:fs"
import { SAMPLES } from "./samples.mjs"
import { defaultLineParams, buildLineBlueprint, lineIneligibleReason } from "../blueprint/line.js"
import { previewLayout } from "../blueprint/build.js"
const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))
const sample = SAMPLES[process.argv[2]]
const spec = {root: {...sample.line.root, rate: sample.rate}, east: sample.line.east, west: sample.line.west}
console.log("ineligible:", lineIneligibleReason(spec, data))
const params = defaultLineParams(spec, data)
console.log(JSON.stringify(params))
const result = buildLineBlueprint(params, spec, data)
console.log("ok:", result.ok, result.errors)
if (result.ok) {
    console.log("fluids:", JSON.stringify(result.connections.fluids), "inputs:", JSON.stringify(result.connections.inputs))
    if (process.argv[3] === "--preview") {
        console.log(previewLayout(result.entities, data))
    }
}
