// Writes sample blueprint strings to tools/samples/ for trying in the game.
//   node tools/make-sample.mjs
import fs from "node:fs"
import zlib from "node:zlib"
import { encodeBlueprint } from "../blueprint/codec.js"
import { defaultParams, buildSmeltingBlueprint } from "../blueprint/dsl.js"
import { SAMPLES } from "./samples.mjs"

const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))
const deflate = bytes => new Uint8Array(zlib.deflateSync(bytes, {level: 9}))
fs.mkdirSync(new URL("./samples/", import.meta.url), {recursive: true})

for (let [name, sample] of Object.entries(SAMPLES)) {
    let requirement = {recipe: sample.recipe, rate: sample.rate}
    let params = {...defaultParams(requirement, "electric-furnace", data), ...sample.override}
    let result = buildSmeltingBlueprint(params, requirement, data)
    if (!result.ok) {
        throw new Error(name + ": " + result.errors.join("; "))
    }
    fs.writeFileSync(new URL(`./samples/${name}.txt`, import.meta.url), encodeBlueprint(result.blueprint, deflate) + "\n")
    console.log(name, result.entities.length, "entities")
}
