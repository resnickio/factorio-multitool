// Tests for the blueprint generator. Run with: node tools/test-blueprint.mjs
import fs from "node:fs"
import zlib from "node:zlib"
import assert from "node:assert/strict"
import { encodeBlueprint, decodeBlueprint, gameVersion } from "../blueprint/codec.js"
import { defaultParams, buildColumnBlueprint, parseReply, ineligibleReason } from "../blueprint/dsl.js"
import { placeColumns } from "../blueprint/columns.js"
import { validateParams, validateLayout } from "../blueprint/validate.js"
import { previewLayout } from "../blueprint/build.js"
import { previewModel } from "../blueprint/preview.js"
import { resolveLine, lineIneligibleReason, validateLine, defaultLineParams, buildLineBlueprint } from "../blueprint/line.js"
import { askForLayout, askForChainLayout, askForLineLayout, listOllamaModels } from "../blueprint/llm.js"
import { describeLineTask, LINE_SYSTEM_PROMPT, parseLineReply } from "../blueprint/line_model.js"
import { EAST } from "../blueprint/entities.js"
import {
    stageRequirements, chainIneligibleReason, validateChain, defaultChainParams, buildChainBlueprint,
    describeChainTask, parseChainReply, CHAIN_SYSTEM_PROMPT,
} from "../blueprint/chain.js"

const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))
const deflate = bytes => new Uint8Array(zlib.deflateSync(bytes, {level: 9}))
const inflate = bytes => new Uint8Array(zlib.inflateSync(bytes))

let failures = 0
function test(name, fn) {
    return Promise.resolve().then(fn).then(
        () => console.log("ok   ", name),
        e => {
            failures++
            console.log("FAIL ", name, "\n     ", e.message)
        },
    )
}

const F = "electric-furnace"
const iron = {recipe: "iron-plate", rate: 15}
const circuits = {recipe: "electronic-circuit", rate: 3}
const gears = {recipe: "iron-gear-wheel", rate: 2}
const params = (req, machine = F) => defaultParams(req, machine, data)
const build = (req, machine = F, override = {}) => buildColumnBlueprint({...params(req, machine), ...override}, req, data)

await test("version packs as 2.1.23", () => {
    assert.equal(gameVersion(), (2 * 2 ** 48) + (1 * 2 ** 32) + (23 * 2 ** 16))
})

await test("codec round trip", () => {
    let bp = {item: "blueprint", entities: [{entity_number: 1, name: "iron-chest", position: {x: 0.5, y: 0.5}}], version: gameVersion()}
    let text = encodeBlueprint(bp, deflate)
    assert.equal(text[0], "0")
    assert.deepEqual(decodeBlueprint(text, inflate), {blueprint: bp})
})

await test("default layout for 15 iron plates/s is accepted", () => {
    let p = params(iron)
    // 0.625 plates/s per electric furnace.
    assert.equal(p.machines, 24)
    let r = buildColumnBlueprint(p, iron, data)
    assert.deepEqual(r.errors, [])
    assert.ok(r.ok)
    let counts = {}
    for (let e of r.entities) {
        counts[e.name] = (counts[e.name] || 0) + 1
    }
    assert.equal(counts["electric-furnace"], 24)
    // Furnaces take no recipe in a blueprint.
    assert.ok(!r.blueprint.entities.some(e => e.recipe))
    console.log("\n" + previewLayout(r.entities, data).split("\n").slice(0, 13).join("\n") + "\n")
})

await test("a faster belt is preferred to a second column while one will do", () => {
    let want = {recipe: "iron-plate", rate: 25}
    let p = params(want)
    assert.equal(p.columns, 1)
    // The output sits on one lane, so it needs a belt of twice the rate (50/s).
    assert.equal(p.outputBelt, "turbo-transport-belt")
    assert.deepEqual(buildColumnBlueprint(p, want, data).errors, [])
})

await test("one column puts all output on one lane", () => {
    let p = {...params(iron), columns: 1, outputBelt: "transport-belt"}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.some(e => /one lane/.test(e)), v.errors.join("; "))
    let two = validateParams({...p, columns: 2}, iron, data)
    assert.ok(!two.errors.some(e => /output belt/.test(e)), two.errors.join("; "))
})

await test("a steel demand too big for one input belt uses two columns", () => {
    // Steel takes five iron plates per craft, so the input belt is the limit.
    let want = {recipe: "steel-plate", rate: 15}
    let p = params(want)
    assert.equal(p.columns, 2)
    assert.deepEqual(buildColumnBlueprint(p, want, data).errors, [])
})

await test("more than one output belt can carry is reported, not built", () => {
    let want = {recipe: "iron-plate", rate: 130}
    let r = build(want)
    assert.equal(r.ok, false)
    assert.ok(r.errors.some(e => /output belt/.test(e)), r.errors.join("; "))
})

await test("two columns place and validate, including odd counts", () => {
    for (let n of [1, 2, 3, 7, 24, 25]) {
        let placed = placeColumns({...params(iron), machines: n, columns: 2}, data)
        assert.deepEqual(validateLayout(placed.entities, data).errors, [], `n=${n}`)
    }
})

await test("an assembler column with two ingredients is accepted and carries its recipe", () => {
    let r = build(circuits, "assembling-machine-2")
    assert.deepEqual(r.errors, [])
    let machines = r.blueprint.entities.filter(e => e.name === "assembling-machine-2")
    assert.ok(machines.length > 0)
    assert.ok(machines.every(e => e.recipe === "electronic-circuit"))
    // Circuits eat six items a second at full speed, so inserters double up
    // or the machines idle.
    assert.ok(r.stats.busy <= 1)
    console.log("\n" + previewLayout(r.entities, data).split("\n").slice(0, 9).join("\n") + "\n")
})

await test("extra machines are added when the inserters would be too slow", () => {
    let need = Math.ceil(circuits.rate / (1 / 0.5 * 0.75))
    let p = params(circuits, "assembling-machine-2")
    assert.ok(p.machines >= need)
    assert.ok(validateParams(p, circuits, data).errors.length === 0)
})

await test("a single-ingredient assembler recipe works", () => {
    assert.deepEqual(build(gears, "assembling-machine-2").errors, [])
})

await test("a two-inserter layout leaves room for poles", () => {
    let p = {...params(gears, "assembling-machine-2"), inputInserters: 2, outputInserters: 2, inputInserter: "fast-inserter"}
    let r = buildColumnBlueprint(p, gears, data)
    assert.deepEqual(r.errors, [])
    let inserters = r.entities.filter(e => /inserter/.test(e.name)).length
    assert.equal(inserters, p.machines * 4)
})

await test("larger machines get their poles spaced to cover them", () => {
    let placed = placeColumns({...params({recipe: "iron-plate", rate: 5}), machine: "foundry", machines: 6, columns: 1, inputInserters: 2, outputInserters: 2}, data)
    assert.deepEqual(validateLayout(placed.entities, data).errors, [])
})

await test("recipes which cannot be built in a column say why", () => {
    assert.match(ineligibleReason(data, "advanced-oil-processing", "oil-refinery"), /fluid/)
    assert.match(ineligibleReason(data, "processing-unit", "assembling-machine-2"), /fluid|ingredients/)
    assert.match(ineligibleReason(data, "iron-plate", "assembling-machine-2"), /cannot craft/)
    assert.match(ineligibleReason(data, "iron-gear-wheel", "stone-furnace"), /not an electric/)
    assert.equal(ineligibleReason(data, "electronic-circuit", "assembling-machine-1"), null)
    assert.equal(ineligibleReason(data, "iron-plate", F), null)
})

const plastic = {recipe: "plastic-bar", rate: 4}
const sulfur = {recipe: "sulfur", rate: 4}
const CP = "chemical-plant"

await test("a fluid recipe gets underground pipes under the belt and a collector pipe", () => {
    let r = build(plastic, CP)
    assert.deepEqual(r.errors, [])
    let counts = {}
    for (let e of r.entities) {
        counts[e.name] = (counts[e.name] || 0) + 1
    }
    let machines = counts[CP]
    assert.equal(counts["pipe-to-ground"], machines * 2)
    // One collector, from a tile above the first machine to the last row.
    assert.equal(counts["pipe"], machines * 3 + 1)
    // Machines face their fluid inputs at the belt: west on the left.
    assert.ok(r.blueprint.entities.filter(e => e.name === CP).every(e => e.direction === 12))
    assert.ok(r.blueprint.entities.filter(e => e.name === CP).every(e => e.recipe === "plastic-bar"))
    console.log("\n" + previewLayout(r.entities, data).split("\n").slice(0, 8).join("\n") + "\n")
})

await test("two fluids use separate collectors, the second tunnelling further", () => {
    let r = build(sulfur, CP, {columns: 1})
    assert.deepEqual(r.errors, [])
    let pipeXs = new Set(r.entities.filter(e => e.name === "pipe").map(e => e.x))
    assert.equal(pipeXs.size, 2)
    let underX = new Set(r.entities.filter(e => e.name === "pipe-to-ground").map(e => e.x))
    assert.deepEqual([...underX].sort((a, b) => a - b), [-3, -1, 1])
})

await test("a recipe of fluids alone has no input belt or input inserters", () => {
    let r = build(sulfur, CP)
    assert.deepEqual(r.errors, [])
    // Only the output belt exists.
    let beltColumns = new Set(r.entities.filter(e => /transport-belt/.test(e.name)).map(e => e.x))
    assert.equal(beltColumns.size, 1)
    let inserters = r.entities.filter(e => /inserter/.test(e.name))
    assert.equal(inserters.length, params(sulfur, CP).machines * params(sulfur, CP).outputInserters)
})

await test("two columns each get their own collectors", () => {
    let r = build({recipe: "battery", rate: 2}, CP, {columns: 2})
    assert.deepEqual(r.errors, [])
    let xs = [...new Set(r.entities.filter(e => e.name === "pipe").map(e => e.x))].sort((a, b) => a - b)
    assert.equal(xs.length, 2)
    assert.ok(xs[0] < 0 && xs[1] > 12)
})

await test("the layout validator catches a missing pipe, a broken tunnel and mixed fluids", () => {
    let p = {...params(sulfur, CP), recipe: "sulfur", columns: 1, machines: 3}
    let placed = placeColumns(p, data)
    assert.deepEqual(validateLayout(placed.entities, data).errors, [])
    // Remove the first fluid's collector.
    let collectorX = Math.max(...placed.entities.filter(e => e.name === "pipe").map(e => e.x))
    let noCollector = placed.entities.filter(e => !(e.name === "pipe" && e.x === collectorX))
    let v = validateLayout(noCollector, data)
    assert.ok(v.errors.some(e => /separate pipe networks|not connected/.test(e)), v.errors.join("; "))
    // Remove one exit of a tunnel.
    let exit = placed.entities.find(e => e.name === "pipe-to-ground" && e.x === -1)
    let broken = placed.entities.filter(e => e !== exit)
    assert.ok(validateLayout(broken, data).errors.some(e => /no partner/.test(e)))
    // Turn a machine so its inputs do not meet the pipes.
    let turned = placed.entities.map(e => e.name === CP ? {...e, direction: 4} : e)
    assert.ok(validateLayout(turned, data).errors.length > 0)
    // Join the two collectors with a pipe.
    let xsPipes = [...new Set(placed.entities.filter(e => e.name === "pipe").map(e => e.x))].sort((a, b) => a - b)
    let bridge = {name: "pipe", x: xsPipes[0] + 1, y: -1, w: 1, h: 1, direction: 0}
    let joined = placed.entities.concat([bridge])
    assert.ok(validateLayout(joined, data).errors.some(e => /share one pipe network/.test(e)), validateLayout(joined, data).errors.join("; "))
})

await test("fluid recipes say what they cannot do", () => {
    assert.equal(ineligibleReason(data, "plastic-bar", CP), null)
    assert.equal(ineligibleReason(data, "sulfur", CP), null)
    assert.match(ineligibleReason(data, "rocket-fuel", "assembling-machine-2"), /fluid/)
    assert.match(ineligibleReason(data, "sulfuric-acid", CP), /makes a fluid/)
    assert.match(ineligibleReason(data, "advanced-oil-processing", "oil-refinery"), /fluid/)
})

await test("a fluid layout leaves room for a second input inserter only when a row is free", () => {
    // One fluid leaves two rows beside the machine for inserters; two fluids leave one.
    assert.deepEqual(validateParams({...params(plastic, CP), inputInserters: 2}, plastic, data).errors.filter(e => /fit beside/.test(e)), [])
    let two = validateParams({...params(sulfur, CP), inputInserters: 2}, sulfur, data)
    assert.ok(two.errors.some(e => /only 1 inserter/.test(e)), two.errors.join("; "))
})

await test("validator rejects too few machines", () => {
    let v = validateParams({...params(iron), machines: 10}, iron, data)
    assert.ok(v.errors.some(e => /at least 24/.test(e)), v.errors.join("; "))
})

await test("validator rejects a belt which cannot carry the load", () => {
    let p = {...params(iron), columns: 1, inputBelt: "transport-belt", machines: 30}
    let v = validateParams(p, {recipe: "iron-plate", rate: 18.75}, data)
    assert.ok(v.errors.some(e => /input belt/.test(e)), v.errors.join("; "))
})

await test("a two-ingredient input belt gives each ingredient one lane", () => {
    let p = {...params(circuits, "assembling-machine-2"), inputBelt: "transport-belt", machines: 40, columns: 1, inputInserters: 2, outputInserters: 2}
    let v = validateParams(p, {recipe: "electronic-circuit", rate: 30}, data)
    assert.ok(v.errors.some(e => /one lane/.test(e)), v.errors.join("; "))
})

await test("validator rejects an inserter which is too slow", () => {
    let v = validateParams({...params(iron), inputInserter: "inserter"}, iron, data)
    assert.ok(v.errors.some(e => /move about/.test(e)), v.errors.join("; "))
})

await test("validator rejects unknown names, bad counts and disallowed inserters", () => {
    let p = {...params(iron), pole: "wooden-chest", inputInserter: "stack-inserter", outputInserters: 3}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.length >= 3, v.errors.join("; "))
})

await test("layout validator catches missing poles", () => {
    let p = params(iron)
    let placed = placeColumns(p, data)
    assert.ok(validateLayout(placed.entities.filter(e => e.name !== p.pole), data).errors.length > 0)
})

await test("layout validator catches a reversed inserter and an overlap", () => {
    let placed = placeColumns(params(iron), data)
    let flipped = placed.entities.map(e => ({...e}))
    flipped.find(e => e.name === params(iron).inputInserter).direction = EAST
    let v = validateLayout(flipped, data)
    assert.ok(v.errors.some(e => /no inserter feeding/.test(e)), v.errors.join("; "))
    let overlapped = placed.entities.concat([{...placed.entities[0]}])
    assert.ok(validateLayout(overlapped, data).errors.some(e => /overlaps/.test(e)))
})

await test("a sparse pole layout is caught", () => {
    let p = params(iron)
    let placed = placeColumns(p, data)
    let poles = placed.entities.filter(e => e.name === p.pole)
    let kept = placed.entities.filter(e => e.name !== p.pole || poles.indexOf(e) % 3 === 0)
    assert.ok(validateLayout(kept, data).errors.length > 0)
})

await test("exported blueprint decodes to the same entities", () => {
    let r = build(iron)
    let back = decodeBlueprint(encodeBlueprint(r.blueprint, deflate), inflate).blueprint
    assert.equal(back.entities.length, r.entities.length)
    assert.equal(back.entities[0].entity_number, 1)
    let furnace = back.entities.find(e => e.name === F)
    // A 3x3 machine sits on a half-tile centre.
    assert.equal(furnace.position.x % 1, 0.5)
    assert.equal(back.icons[0].signal.name, F)
})

await test("poles are wired into one network", () => {
    for (let want of [iron, {recipe: "steel-plate", rate: 15}, circuits]) {
        let r = build(want, want === circuits ? "assembling-machine-2" : F)
        let poles = r.blueprint.entities.filter(e => /pole/.test(e.name)).length
        let wires = r.blueprint.wires
        assert.equal(wires.length, poles - 1)
        let names = new Map(r.blueprint.entities.map(e => [e.entity_number, e.name]))
        for (let [a, ca, b, cb] of wires) {
            assert.ok(/pole/.test(names.get(a)) && /pole/.test(names.get(b)))
            assert.equal(ca, 5)
            assert.equal(cb, 5)
        }
    }
})

await test("parseReply reads fenced JSON", () => {
    let p = parseReply("Here:\n```json\n{\"machines\": 3, \"columns\": 1, \"input_belt\": \"transport-belt\", \"output_belt\": \"transport-belt\", \"input_inserter\": \"inserter\", \"output_inserter\": \"inserter\", \"input_inserter_count\": 2, \"output_inserter_count\": 1, \"pole\": \"medium-electric-pole\"}\n```")
    assert.equal(p.machines, 3)
    assert.equal(p.inputBelt, "transport-belt")
    assert.equal(p.inputInserters, 2)
    assert.throws(() => parseReply("no json here"))
})

function replyFor(p) {
    return JSON.stringify({
        machines: p.machines, columns: p.columns, input_belt: p.inputBelt, output_belt: p.outputBelt,
        input_inserter: p.inputInserter, output_inserter: p.outputInserter,
        input_inserter_count: p.inputInserters, output_inserter_count: p.outputInserters,
        pole: p.pole, notes: "ok",
    })
}

await test("the model loop repairs a rejected first answer", async () => {
    let good = params(iron)
    let replies = [replyFor({...good, machines: 5}), "```json\n" + replyFor(good) + "\n```"]
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push(JSON.parse(init.body))
        return {ok: true, json: async () => ({content: [{type: "text", text: replies.shift()}]})}
    }
    let r = await askForLayout({apiKey: "k", model: "m", requirement: iron, machine: F, data, fetchFn})
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(r.attempts, 2)
    // The second request contains the complaint about the first.
    assert.ok(seen[1].messages.at(-1).content.includes("rejected"))
    assert.ok(seen[0].system.length > 100)
})

await test("the model loop works for an assembler recipe", async () => {
    let good = params(circuits, "assembling-machine-2")
    let fetchFn = async () => ({ok: true, json: async () => ({content: [{type: "text", text: replyFor(good)}]})})
    let r = await askForLayout({apiKey: "k", model: "m", requirement: circuits, machine: "assembling-machine-2", data, fetchFn})
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(r.attempts, 1)
})

await test("the Ollama provider sends a chat request with the system prompt and JSON format", async () => {
    let good = params(iron)
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push({url, body: JSON.parse(init.body)})
        return {ok: true, json: async () => ({message: {role: "assistant", content: replyFor(good)}})}
    }
    let r = await askForLayout({provider: "ollama", baseUrl: "http://example:1234", model: "qwen3.8:latest", requirement: iron, machine: F, data, fetchFn})
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(seen[0].url, "http://example:1234/api/chat")
    assert.equal(seen[0].body.model, "qwen3.8:latest")
    assert.equal(seen[0].body.stream, false)
    assert.equal(seen[0].body.think, false)
    assert.equal(seen[0].body.format, "json")
    assert.equal(seen[0].body.messages[0].role, "system")
    assert.equal(seen[0].body.messages[1].role, "user")
})

await test("an Ollama error is reported", async () => {
    let fetchFn = async () => ({ok: false, status: 404, statusText: "Not Found", json: async () => ({error: "model 'nope' not found"})})
    await assert.rejects(askForLayout({provider: "ollama", model: "nope", requirement: iron, machine: F, data, fetchFn}), /404.*not found/)
})

await test("the model loop gives up and reports errors", async () => {
    let fetchFn = async () => ({ok: true, json: async () => ({content: [{type: "text", text: "I cannot"}]})})
    let r = await askForLayout({apiKey: "k", model: "m", requirement: iron, machine: F, data, fetchFn, maxAttempts: 2})
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
})

await test("an API error is reported", async () => {
    let fetchFn = async () => ({ok: false, status: 401, statusText: "Unauthorized", json: async () => ({error: {message: "invalid x-api-key"}})})
    await assert.rejects(askForLayout({apiKey: "bad", model: "m", requirement: iron, machine: F, data, fetchFn}), /401.*invalid x-api-key/)
})

const chainReq = {recipe: "electronic-circuit", rate: 3, upstream: "copper-cable"}
const chainMachines = {upstream: "assembling-machine-2", downstream: "assembling-machine-2"}
const chain = (req = chainReq, machines = chainMachines) => {
    let params = defaultChainParams(req, machines, data)
    return {params, result: buildChainBlueprint(params, req, data)}
}

await test("a chain's stages are sized from the downstream rate", () => {
    let st = stageRequirements(chainReq, data)
    // Three plates' worth... a circuit takes three cables and an iron plate.
    assert.equal(st.upstream.recipe, "copper-cable")
    assert.equal(st.upstream.rate, 9)
    assert.deepEqual(st.other, {item: "iron-plate", rate: 3})
    assert.equal(st.linking, "copper-cable")
    assert.throws(() => stageRequirements({recipe: "iron-gear-wheel", rate: 1, upstream: "copper-cable"}, data), /does not use/)
})

await test("a cable-to-circuits chain is accepted and carries both recipes", () => {
    let {params, result} = chain()
    assert.deepEqual(result.errors, [])
    assert.ok(result.ok)
    let machines = result.blueprint.entities.filter(e => e.name === "assembling-machine-2")
    assert.equal(machines.filter(e => e.recipe === "copper-cable").length, params.upstream.machines)
    assert.equal(machines.filter(e => e.recipe === "electronic-circuit").length, params.downstream.machines)
    console.log("\n" + previewLayout(result.entities, data).split("\n").slice(0, 12).join("\n") + "\n")
})

await test("the chain shares one middle belt and its feeders reach the supply points", () => {
    let {params, result} = chain()
    let belts = result.entities.filter(e => /transport-belt/.test(e.name))
    let mid = belts.filter(e => e.x === 0)
    let rows = (params.upstream.machines + params.downstream.machines) * 3
    // From two tiles above the first machine to the last row.
    assert.equal(mid.length, rows + 2)
    assert.ok(mid.every(e => e.direction === 8))
    // The other ingredient joins the belt from the east, one tile above the machines.
    let feeder = belts.filter(e => e.y === -1 && e.x > 0)
    assert.ok(feeder.length > 3 && feeder.every(e => e.direction === 12))
    assert.equal(Math.min(...feeder.map(e => e.x)), 1)
    let c = result.connections
    assert.equal(c.inputs.length, 2)
    assert.deepEqual(c.inputs[0].items, ["copper-plate"])
    assert.deepEqual(c.inputs[1].items, ["iron-plate"])
    assert.equal(c.output.item, "electronic-circuit")
    assert.ok(c.output.x < 0)
})

await test("the middle belt must carry each ingredient on its own lane", () => {
    // 8 circuits a second need 24 cables a second on their lane.
    let big = {recipe: "electronic-circuit", rate: 8, upstream: "copper-cable"}
    let params = defaultChainParams(big, chainMachines, data)
    assert.deepEqual(validateChain(params, big, data).errors, [])
    assert.equal(params.mid, "turbo-transport-belt")
    let tooSlow = validateChain({...params, mid: "express-transport-belt"}, big, data)
    assert.ok(tooSlow.errors.some(e => /carries/.test(e)), tooSlow.errors.join("; "))
    // Ten need 30, which only just fits a turbo belt's lane; the search still finds it.
    let edge = {recipe: "electronic-circuit", rate: 10, upstream: "copper-cable"}
    let found = defaultChainParams(edge, chainMachines, data)
    assert.equal(found.mid, "turbo-transport-belt")
})

await test("a chain can have furnaces upstream", () => {
    let req = {recipe: "electronic-circuit", rate: 3, upstream: "iron-plate"}
    let {result} = chain(req, {upstream: "electric-furnace", downstream: "assembling-machine-2"})
    assert.deepEqual(result.errors, [])
    // Furnaces take no recipe, and the other ingredient is the cable.
    assert.ok(!result.blueprint.entities.some(e => e.name === "electric-furnace" && e.recipe))
    assert.deepEqual(result.connections.inputs[1].items, ["copper-cable"])
})

await test("chains say why a pair cannot be built", () => {
    assert.equal(chainIneligibleReason(chainReq, chainMachines, data), null)
    assert.match(chainIneligibleReason({recipe: "iron-gear-wheel", rate: 1, upstream: "copper-cable"}, chainMachines, data), /does not use/)
    assert.match(chainIneligibleReason(chainReq, {upstream: "assembling-machine-2", downstream: "stone-furnace"}, data), /not an electric/)
    assert.match(chainIneligibleReason({recipe: "plastic-bar", rate: 1, upstream: "coal"}, {upstream: "assembling-machine-2", downstream: "chemical-plant"}, data) || "unknown", /unknown|fluid|does not use/)
})

await test("a chain layout survives the layout validator and has wired poles", () => {
    let {result} = chain()
    assert.deepEqual(validateLayout(result.entities, data).errors, [])
    let poles = result.blueprint.entities.filter(e => /pole/.test(e.name)).length
    assert.equal(result.blueprint.wires.length, poles - 1)
})

await test("every inserter in a chain points east, as in a right-hand column", () => {
    let {result} = chain()
    assert.ok(result.entities.filter(e => /inserter/.test(e.name)).every(e => e.direction === 4))
})

await test("the chain blueprint round-trips", () => {
    let {result} = chain()
    let back = decodeBlueprint(encodeBlueprint(result.blueprint, deflate), inflate).blueprint
    assert.equal(back.entities.length, result.entities.length)
})

await test("the preview model has a shape for each entity, and fits them", () => {
    let r = build(iron)
    let m = previewModel(r.entities, data, {wires: r.blueprint.wires, connections: r.connections})
    assert.equal(m.shapes.length, r.entities.length)
    let kinds = {}
    for (let s of m.shapes) {
        kinds[s.kind] = (kinds[s.kind] || 0) + 1
    }
    assert.equal(kinds.machine, 24)
    assert.equal(kinds.belt, 24 * 3 * 2)
    assert.equal(kinds.inserter, 48)
    assert.ok(kinds.pole > 0)
    assert.equal(m.wires.length, kinds.pole - 1)
    for (let s of m.shapes) {
        assert.ok(s.x >= m.bounds.x && s.y >= m.bounds.y && s.x + s.w <= m.bounds.x + m.bounds.w && s.y + s.h <= m.bounds.y + m.bounds.h, `${s.name} outside the bounds`)
    }
})

await test("inserters in the preview point the way items move, belts the way they flow", () => {
    let r = build(iron)
    let m = previewModel(r.entities, data)
    // The input inserters on the left of the machines move items east.
    let leftOfMachines = m.shapes.filter(s => s.kind === "inserter" && s.x === 1)
    assert.ok(leftOfMachines.length > 0 && leftOfMachines.every(s => s.direction === 4))
    assert.ok(m.shapes.filter(s => s.kind === "belt").every(s => s.direction === 8))
    // Belt tiers are coloured as in the game.
    let fast = previewModel(build({recipe: "iron-plate", rate: 25}).entities, data).shapes.filter(s => s.kind === "belt").map(s => s.tier)
    assert.ok(fast.includes("blue") || fast.includes("green") || fast.includes("red"))
})

await test("the preview labels the supply, output and fluids, and leaves room for them", () => {
    let r = build(sulfur, CP, {columns: 1})
    let m = previewModel(r.entities, data, {connections: r.connections})
    let types = m.labels.map(l => l.type).sort()
    assert.deepEqual(types, ["fluid", "fluid", "output"])
    // The two fluid labels sit on different rows so they do not overlap.
    let fluids = m.labels.filter(l => l.type === "fluid")
    assert.notEqual(fluids[0].row, fluids[1].row)
    for (let l of m.labels) {
        assert.ok(l.x >= m.bounds.x && l.x <= m.bounds.x + m.bounds.w, `${l.text} outside horizontally`)
        assert.ok(l.y >= m.bounds.y - 1 && l.y <= m.bounds.y + m.bounds.h, `${l.text} outside vertically`)
    }
    let c = chain()
    let cm = previewModel(c.result.entities, data, {connections: c.result.connections})
    assert.deepEqual(cm.labels.map(l => l.type).sort(), ["input", "input", "output"])
    assert.ok(cm.labels.filter(l => l.type === "input").every(l => l.side === "right"))
})

await test("pipes in the preview link to the pipes and tunnel ends they touch", () => {
    let r = build(plastic, CP)
    let m = previewModel(r.entities, data)
    let pipes = m.shapes.filter(s => s.kind === "pipe")
    // The collector is a vertical run; its middle pieces link up and down.
    let middle = pipes.filter(s => s.links.includes(0) && s.links.includes(8))
    assert.ok(middle.length > 0)
    // Pieces beside a tunnel end also link sideways.
    assert.ok(pipes.some(s => s.links.includes(4)))
    assert.equal(m.shapes.filter(s => s.kind === "underground").length, build(plastic, CP).entities.filter(e => e.name === "pipe-to-ground").length)
})

function chainReply(p) {
    let stage = s => ({machines: s.machines, input_inserter: s.inputInserter, output_inserter: s.outputInserter, input_inserter_count: s.inputInserters, output_inserter_count: s.outputInserters})
    return JSON.stringify({
        mid_belt: p.mid, supply_belt: p.supply, pole: p.pole, notes: "ok",
        upstream: {...stage(p.upstream), input_belt: p.upstream.inputBelt},
        downstream: {...stage(p.downstream), output_belt: p.downstream.outputBelt},
    })
}

await test("a chain task tells the model both stages and the loads on the shared belt", () => {
    let task = describeChainTask(chainReq, chainMachines, data)
    assert.equal(task.task, "chain")
    assert.equal(task.upstream.recipe, "copper-cable")
    assert.equal(task.downstream.recipe, "electronic-circuit")
    assert.equal(task.shared_belt.linking_item, "copper-cable")
    assert.equal(task.shared_belt.linking_per_second, 9)
    assert.equal(task.shared_belt.other_item, "iron-plate")
    assert.equal(task.shared_belt.other_per_second, 3)
    assert.ok(task.upstream.fewest_machines >= 1 && task.downstream.fewest_machines >= 1)
    assert.ok(CHAIN_SYSTEM_PROMPT.length > 500)
})

await test("a chain reply is read into chain parameters, with the machines fixed by the task", () => {
    let good = defaultChainParams(chainReq, chainMachines, data)
    let parsed = parseChainReply("Sure:\n```json\n" + chainReply(good) + "\n```", chainReq, chainMachines)
    assert.equal(parsed.mid, good.mid)
    assert.equal(parsed.upstream.machines, good.upstream.machines)
    assert.equal(parsed.upstream.machine, "assembling-machine-2")
    assert.equal(parsed.downstreamRecipe, "electronic-circuit")
    assert.equal(parsed.upstreamRecipe, "copper-cable")
    assert.equal(buildChainBlueprint(parsed, chainReq, data).ok, true)
    assert.throws(() => parseChainReply("nothing", chainReq, chainMachines))
    // Missing pieces become validation errors, not crashes.
    let bare = parseChainReply("{}", chainReq, chainMachines)
    let r = buildChainBlueprint(bare, chainReq, data)
    assert.equal(r.ok, false)
    assert.ok(r.errors.length > 0)
})

await test("the chain loop repairs a rejected first answer, and asks with the chain prompt", async () => {
    let good = defaultChainParams(chainReq, chainMachines, data)
    let bad = {...good, upstream: {...good.upstream, machines: 1}}
    let replies = [chainReply(bad), chainReply(good)]
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push({url, body: JSON.parse(init.body)})
        return {ok: true, json: async () => ({message: {role: "assistant", content: replies.shift()}})}
    }
    let r = await askForChainLayout({provider: "ollama", model: "m", requirement: chainReq, machines: chainMachines, data, fetchFn})
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(r.attempts, 2)
    assert.equal(seen[0].body.messages[0].content, CHAIN_SYSTEM_PROMPT)
    assert.equal(JSON.parse(seen[0].body.messages[1].content).task, "chain")
    assert.ok(seen[1].body.messages.at(-1).content.includes("rejected"))
    assert.ok(r.params.upstream.machines >= 1)
})

await test("the chain loop gives up with the validator's reasons", async () => {
    let fetchFn = async () => ({ok: true, json: async () => ({message: {content: "{\"mid_belt\": \"transport-belt\"}"}})})
    let r = await askForChainLayout({provider: "ollama", model: "m", requirement: chainReq, machines: chainMachines, data, fetchFn, maxAttempts: 2})
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
    assert.ok(r.errors.length > 0)
})

await test("installed Ollama models are listed, sorted, and errors reported", async () => {
    let urls = []
    let fetchFn = async url => {
        urls.push(url)
        return {ok: true, json: async () => ({models: [{name: "qwen3.8:latest"}, {name: "llama3:8b"}]})}
    }
    assert.deepEqual(await listOllamaModels("http://example:1234", fetchFn), ["llama3:8b", "qwen3.8:latest"])
    assert.equal(urls[0], "http://example:1234/api/tags")
    let failing = async () => ({ok: false, status: 500, statusText: "oops", json: async () => ({error: "boom"})})
    await assert.rejects(listOllamaModels("http://example:1234", failing), /500.*boom/)
})

await test("the validator reports an unknown feeder belt instead of crashing", () => {
    let good = defaultChainParams(chainReq, chainMachines, data)
    let v = validateChain({...good, supply: "wooden-chest"}, chainReq, data)
    assert.ok(v.errors.some(e => /supply belt/.test(e)), v.errors.join("; "))
})

const ASM2 = "assembling-machine-2"
const orePlan = {
    root: {recipe: "electronic-circuit", machine: ASM2, rate: 3},
    east: [{recipe: "copper-cable", machine: ASM2}, {recipe: "copper-plate", machine: F}],
    west: [{recipe: "iron-plate", machine: F}],
}
const line = (spec = orePlan) => {
    let params = defaultLineParams(spec, data)
    return {params, result: buildLineBlueprint(params, spec, data)}
}

await test("a line's stages are sized back from the final recipe", () => {
    let r = resolveLine(orePlan, data)
    // 3 circuits a second need 9 cables and 3 iron plates; 9 cables need 4.5 copper plates.
    assert.deepEqual(r.stages.east.map(s => [s.recipe, s.rate]), [["copper-cable", 9], ["copper-plate", 4.5]])
    assert.deepEqual(r.stages.west.map(s => [s.recipe, s.rate]), [["iron-plate", 3]])
    assert.deepEqual(r.external, [])
})

await test("an ingredient with no branch arrives on a feeder", () => {
    let r = resolveLine({...orePlan, west: []}, data)
    assert.equal(r.external[0].item, "iron-plate")
    assert.equal(r.external[0].from, "east")
    assert.equal(r.external[0].rate, 3)
    let other = resolveLine({...orePlan, east: [], west: [orePlan.east[0]]}, data)
    assert.equal(other.external[0].item, "iron-plate")
    assert.equal(other.external[0].from, "west")
})

await test("a line from ore to circuits is accepted", () => {
    let {params, result} = line()
    assert.deepEqual(result.errors, [])
    assert.ok(result.ok)
    assert.equal(result.blueprint.entities.filter(e => e.recipe === "electronic-circuit").length, params.root.machines)
    assert.equal(result.blueprint.entities.filter(e => e.recipe === "copper-cable").length, params.east.stages[0].machines)
    assert.equal(result.blueprint.entities.filter(e => e.name === F).length, params.east.stages[1].machines + params.west.stages[0].machines)
    console.log("\n" + previewLayout(result.entities, data).split("\n").slice(0, 10).join("\n") + "\n")
})

await test("only the raw inputs and the product are connection points of a line", () => {
    let {result} = line()
    let c = result.connections
    assert.equal(c.inputs.length, 2)
    assert.deepEqual(c.inputs.map(i => i.items).sort(), [["copper-ore"], ["iron-ore"]])
    // One feeder is on each side of the layout.
    assert.ok(c.inputs.some(i => i.x > 0) && c.inputs.some(i => i.x < 0))
    assert.equal(c.output.item, "electronic-circuit")
})

await test("stages in a branch step outward and share their belt", () => {
    let {params, result} = line()
    let cable = result.entities.filter(e => e.recipe === "copper-cable")
    let furnaces = result.entities.filter(e => e.name === F && e.x > 0)
    // Copper furnaces are further east than the cable machines, and above them.
    assert.ok(Math.min(...furnaces.map(e => e.x)) > Math.max(...cable.map(e => e.x)))
    assert.ok(Math.max(...furnaces.map(e => e.y)) < Math.min(...cable.map(e => e.y)))
    // The belt between them spans both stages' rows.
    let between = result.entities.filter(e => /transport-belt/.test(e.name) && e.x === Math.max(...cable.map(m => m.x)) + 4)
    assert.ok(between.length >= params.east.stages[0].machines * 3 + params.east.stages[1].machines * 3)
    // The final recipe sits west of MID and below both branches.
    let circuits = result.entities.filter(e => e.recipe === "electronic-circuit")
    assert.ok(circuits.every(e => e.x < 0))
    let westRows = Math.max(...result.entities.filter(e => e.name === F && e.x < 0).map(e => e.y + e.h))
    assert.ok(Math.min(...circuits.map(e => e.y)) > westRows)
})

await test("each side's inserters point as its machines face, and the layout validates", () => {
    let {result} = line()
    assert.deepEqual(validateLayout(result.entities, data).errors, [])
    let east = result.entities.filter(e => e.name === F && e.x > 0)
    let eastInserters = result.entities.filter(e => /inserter/.test(e.name) && e.x > 0)
    assert.ok(eastInserters.every(e => e.direction === 4))
    let westStage = result.entities.filter(e => /inserter/.test(e.name) && e.x < 0 && e.y < Math.min(...result.entities.filter(m => m.recipe === "electronic-circuit").map(m => m.y)))
    assert.ok(westStage.length > 0 && westStage.every(e => e.direction === 12))
    assert.ok(east.length > 0)
})

await test("a line with a feeder and one branch is a three-stage chain", () => {
    let spec = {...orePlan, west: []}
    let {result} = line(spec)
    assert.deepEqual(result.errors, [])
    let feeder = result.entities.filter(e => /transport-belt/.test(e.name) && e.y === -1 && e.x > 0)
    assert.ok(feeder.length > 3 && feeder.every(e => e.direction === 12))
    assert.deepEqual(result.connections.inputs.map(i => i.items).sort(), [["copper-ore"], ["iron-plate"]])
})

await test("a line whose west branch is the only one feeds the other ingredient from the west", () => {
    let spec = {root: orePlan.root, east: [], west: [orePlan.east[0], {recipe: "copper-plate", machine: F}]}
    let {result} = line(spec)
    assert.deepEqual(result.errors, [])
    let feeder = result.entities.filter(e => /transport-belt/.test(e.name) && e.y === -1 && e.x < 0)
    assert.ok(feeder.length > 3 && feeder.every(e => e.direction === 4))
})

await test("lines say why they cannot be built", () => {
    assert.equal(lineIneligibleReason(orePlan, data), null)
    assert.match(lineIneligibleReason({...orePlan, east: [], west: []}, data), /at least one branch/)
    assert.match(lineIneligibleReason({...orePlan, west: [{recipe: "iron-gear-wheel", machine: ASM2}]}, data), /does not use/)
    assert.match(lineIneligibleReason({...orePlan, east: [orePlan.east[0], orePlan.east[1], {recipe: "iron-plate", machine: F}]}, data), /at most 2/)
    // A stage between others can only take its product from the next one.
    let gearBetween = {root: {recipe: "electronic-circuit", machine: ASM2, rate: 3}, east: [{recipe: "electronic-circuit", machine: ASM2}, orePlan.east[0]], west: []}
    assert.ok(lineIneligibleReason(gearBetween, data))
})

await test("the shared belt is checked for each ingredient's lane in a line", () => {
    let {params} = line()
    let v = validateLine({...params, mid: "transport-belt"}, {...orePlan, root: {...orePlan.root, rate: 6}}, data)
    assert.ok(v.errors.length > 0)
    let small = validateLine(params, orePlan, data)
    assert.deepEqual(small.errors, [])
})

await test("a line's blueprint wires its poles and round-trips", () => {
    let {result} = line()
    let poles = result.blueprint.entities.filter(e => /pole/.test(e.name)).length
    assert.equal(result.blueprint.wires.length, poles - 1)
    let back = decodeBlueprint(encodeBlueprint(result.blueprint, deflate), inflate).blueprint
    assert.equal(back.entities.length, result.entities.length)
})

const inserterPlan = {
    root: {recipe: "inserter", machine: ASM2, rate: 2},
    east: [{recipe: "electronic-circuit", machine: ASM2}, {recipe: "copper-cable", machine: ASM2}],
    west: [{recipe: "iron-gear-wheel", machine: ASM2}],
}

await test("a three-ingredient final recipe has a second shared belt", () => {
    let r = resolveLine(inserterPlan, data)
    assert.equal(r.m, 2)
    assert.deepEqual(r.external.map(e => [e.item, e.from]), [["iron-plate", "west"]])
    // Circuits need an iron plate beside the cable.
    assert.deepEqual(r.stages.east.map(s => [s.recipe, s.other && s.other.item]), [["electronic-circuit", "iron-plate"], ["copper-cable", null]])
    assert.deepEqual(r.rootBelts, {near: ["iron-gear-wheel", "iron-plate"], far: ["electronic-circuit"]})
})

await test("inserters from plates are laid out, with long-handed inserters over the first belt", () => {
    let {params, result} = line(inserterPlan)
    assert.deepEqual(result.errors, [])
    assert.ok(result.ok)
    assert.ok(params.mid2)
    assert.ok(result.entities.some(e => e.name === "long-handed-inserter"))
    assert.deepEqual(validateLayout(result.entities, data).errors, [])
    // Plates reach the circuit stage and the final recipe on feeders.
    assert.deepEqual(result.connections.inputs.map(i => i.items.join()).sort(), ["copper-plate", "iron-plate", "iron-plate", "iron-plate"])
})

await test("a three-ingredient final recipe needs a wide enough machine", () => {
    let spec = {root: {recipe: "inserter", machine: "assembling-machine-2", rate: 2}, east: [{recipe: "electronic-circuit", machine: ASM2}], west: []}
    assert.equal(lineIneligibleReason(spec, data), null)
})

const plasticPlan = {
    root: {recipe: "advanced-circuit", machine: ASM2, rate: 1},
    east: [{recipe: "plastic-bar", machine: "chemical-plant"}],
    west: [{recipe: "electronic-circuit", machine: ASM2}],
}

await test("the outermost stage of a branch may take a fluid, an inner one may not", () => {
    assert.equal(lineIneligibleReason(plasticPlan, data), null)
    // Batteries (with sulfuric acid) as the inner stage would put pipes among the belts.
    let inner = {root: {recipe: "accumulator", machine: ASM2, rate: 1}, east: [{recipe: "battery", machine: "chemical-plant"}, {recipe: "copper-plate", machine: F}], west: []}
    assert.match(lineIneligibleReason(inner, data), /uses a fluid/)
    // A fluid in the final recipe is still refused.
    let root = {root: {recipe: "battery", machine: "chemical-plant", rate: 1}, east: [{recipe: "copper-plate", machine: F}], west: [{recipe: "iron-plate", machine: F}]}
    assert.match(lineIneligibleReason(root, data), /uses a fluid/)
})

await test("a fluid stage's pipes run beside its supply belt, which comes in above them", () => {
    let {result} = line(plasticPlan)
    assert.deepEqual(result.errors, [])
    assert.ok(result.ok)
    let c = result.connections
    assert.deepEqual(c.fluids.map(f => f.fluid), ["petroleum-gas"])
    // The collector pipe is further out than the supply belt, and the coal feeder
    // passes above where the fluid connects.
    let plants = result.entities.filter(e => e.name === "chemical-plant")
    let belt = Math.max(...plants.map(e => e.x)) + 4
    assert.ok(c.fluids[0].x > belt)
    let coal = c.inputs.find(i => i.items.join() === "coal")
    assert.ok(coal.y < c.fluids[0].y - 1)
    assert.ok(plants.every(e => e.direction === 4))
    assert.ok(result.entities.some(e => e.name === "pipe-to-ground"))
    assert.deepEqual(validateLayout(result.entities, data).errors, [])
})

await test("a fluid line's solid inputs exclude the fluid", () => {
    let {result} = line(plasticPlan)
    for (let input of result.connections.inputs) {
        assert.ok(!input.items.includes("petroleum-gas"))
    }
})

// The reply a model would give for these line parameters.
const lineReply = p => {
    let stage = s => ({machines: s.machines, input_inserter: s.inputInserter, output_inserter: s.outputInserter,
        input_inserter_count: s.inputInserters, output_inserter_count: s.outputInserters, ...(s.feeder ? {feeder_belt: s.feeder} : {})})
    let branch = b => ({stages: b.stages.map(stage), supply_belt: b.supply, ...(b.belts.length ? {belt_between: b.belts[0]} : {})})
    return JSON.stringify({
        mid_belt: p.mid, ...(p.mid2 ? {mid2_belt: p.mid2} : {}), pole: p.pole,
        feeder_belts: Object.fromEntries(Object.entries(p.feeders).filter(([, v]) => v)),
        final: {machines: p.root.machines, output_belt: p.root.outputBelt, input_inserter: p.root.inputInserter,
            input_inserter_count: p.root.inputInserters, output_inserter: p.root.outputInserter,
            output_inserter_count: p.root.outputInserters, ...(p.mid2 ? {far_input_inserter_count: p.root.farInserters} : {})},
        east: branch(p.east), west: branch(p.west), notes: "ok",
    })
}

const lineFetch = replies => {
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push(JSON.parse(init.body))
        return {ok: true, json: async () => ({message: {role: "assistant", content: replies.shift()}})}
    }
    return {fetchFn, seen}
}

await test("extra machines a model asks for are cut back to what its inserters need", async () => {
    let good = defaultLineParams(inserterPlan, data)
    let padded = {...good, root: {...good.root, machines: good.root.machines + 2}}
    let {fetchFn} = lineFetch([lineReply(padded)])
    let r = await askForLineLayout({provider: "ollama", model: "m", spec: inserterPlan, data, fetchFn})
    assert.ok(r.ok, (r.errors || []).join("; "))
    assert.equal(r.params.root.machines, good.root.machines)
    assert.equal(r.trimmed.length, 1)
    assert.match(r.trimmed[0], /Inserter: \d+ → \d+ machines/)
    assert.equal(r.blueprint.entities.filter(e => e.recipe === "inserter").length, good.root.machines)
})

await test("a working layout with more machines than the calculator needs is sent back once", async () => {
    let good = defaultLineParams(inserterPlan, data)
    // One fast inserter per machine makes the extra machines necessary, so
    // trimming cannot help.
    let weaken = s => ({...s, machines: s.machines + 2, inputInserter: "fast-inserter", inputInserters: 1})
    let weak = {...good, east: {...good.east, stages: [weaken(good.east.stages[0]), good.east.stages[1]]}}
    let {fetchFn, seen} = lineFetch([lineReply(weak), lineReply(good)])
    let r = await askForLineLayout({provider: "ollama", model: "m", spec: inserterPlan, data, fetchFn})
    assert.ok(r.ok, (r.errors || []).join("; "))
    assert.equal(seen.length, 2)
    assert.match(seen[1].messages.at(-1).content, /more machines than needed/)
    assert.match(seen[1].messages.at(-1).content, /are enough with/)
    assert.deepEqual(r.params.east.stages.map(s => s.machines), good.east.stages.map(s => s.machines))
})

await test("a model that keeps too many machines still gets its last working layout back", async () => {
    let good = defaultLineParams(inserterPlan, data)
    let weaken = s => ({...s, machines: s.machines + 2, inputInserter: "fast-inserter", inputInserters: 1})
    let weak = {...good, east: {...good.east, stages: [weaken(good.east.stages[0]), good.east.stages[1]]}}
    let {fetchFn} = lineFetch([lineReply(weak), "{}"])
    let r = await askForLineLayout({provider: "ollama", model: "m", spec: inserterPlan, data, fetchFn, maxAttempts: 2})
    assert.ok(r.ok, (r.errors || []).join("; "))
})

await test("a line task tells the model each stage, the belts and the feeders", () => {
    let task = describeLineTask(inserterPlan, data)
    assert.equal(task.task, "line")
    assert.equal(task.final.recipe, "inserter")
    assert.equal(task.shared_belts.second_belt, true)
    assert.deepEqual(task.shared_belts.mid2_items.map(i => i.item), ["electronic-circuit"])
    assert.deepEqual(task.feeders.west, {item: "iron-plate", per_second: 2})
    assert.equal(task.east.length, 2)
    assert.equal(task.east[0].extra_ingredient_from_feeder.item, "iron-plate")
    assert.equal(task.east[1].extra_ingredient_from_feeder, null)
    assert.ok(task.west[0].fewest_machines >= 1)
    assert.ok(LINE_SYSTEM_PROMPT.length > 500)
})

await test("a line reply is read into line parameters, with recipes and machines fixed by the task", () => {
    for (let spec of [orePlan, inserterPlan]) {
        let good = defaultLineParams(spec, data)
        let parsed = parseLineReply("Sure:\n```json\n" + lineReply(good) + "\n```", spec, data)
        assert.equal(parsed.mid, good.mid)
        assert.equal(parsed.root.machines, good.root.machines)
        assert.equal(parsed.east.stages[0].recipe, spec.east[0].recipe)
        assert.equal(buildLineBlueprint(parsed, spec, data).ok, true)
        assert.throws(() => parseLineReply("nothing", spec, data))
        let bare = buildLineBlueprint(parseLineReply("{}", spec, data), spec, data)
        assert.equal(bare.ok, false)
        assert.ok(bare.errors.length > 0)
    }
})

await test("the line loop repairs a rejected first answer, and asks with the line prompt", async () => {
    let good = defaultLineParams(inserterPlan, data)
    let bad = {...good, root: {...good.root, machines: 1}}
    let replies = [lineReply(bad), lineReply(good)]
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push({url, body: JSON.parse(init.body)})
        return {ok: true, json: async () => ({message: {role: "assistant", content: replies.shift()}})}
    }
    let r = await askForLineLayout({provider: "ollama", model: "m", spec: inserterPlan, data, fetchFn})
    assert.ok(r.ok, (r.errors || []).join("; "))
    assert.equal(r.attempts, 2)
    assert.equal(seen[0].body.messages[0].content, LINE_SYSTEM_PROMPT)
    assert.equal(JSON.parse(seen[0].body.messages[1].content).task, "line")
    assert.ok(seen[1].body.messages.at(-1).content.includes("rejected"))
})

await test("the line loop gives up with the validator's reasons", async () => {
    let fetchFn = async () => ({ok: true, json: async () => ({message: {content: "{\"mid_belt\": \"transport-belt\"}"}})})
    let r = await askForLineLayout({provider: "ollama", model: "m", spec: orePlan, data, fetchFn, maxAttempts: 2})
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
    assert.ok(r.errors.length > 0)
})

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
