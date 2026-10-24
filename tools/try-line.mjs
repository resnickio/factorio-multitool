// Builds a sample line without the game and prints the machine counts.
//   node tools/try-line.mjs <sample> [--stack true]
import fs from "node:fs"
import { SAMPLES } from "./samples.mjs"
import { defaultLineParams, buildLineBlueprint, lineMinimums } from "../blueprint/line.js"
import { STACK_INSERTERS } from "../blueprint/entities.js"
const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))
if (process.argv[3] === "--stack" && process.argv[4] === "true") {
    data.allowedInserters = STACK_INSERTERS
}
const sample = SAMPLES[process.argv[2]]
const spec = {root: {...sample.line.root, rate: sample.rate}, east: sample.line.east, west: sample.line.west}
const p = defaultLineParams(spec, data)
const r = buildLineBlueprint(p, spec, data)
const m = lineMinimums(spec, data)
const show = s => `${s.machines} (${s.inputInserters}x${s.inputInserter} in, ${s.outputInserters}x${s.outputInserter} out)`
console.log("ok", r.ok, r.errors)
console.log(`final ${p.root.machines} of ${m.root} (${p.root.inputInserters}x${p.root.inputInserter}, ${p.root.farInserters}x${p.root.farInserter})`)
for (const side of ["east", "west"]) {
    console.log(side, p[side].stages.map((s, j) => `${show(s)} of ${m[side][j]}`).join(" | "))
}
