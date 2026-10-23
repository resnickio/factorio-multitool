// Tests for the blueprint generator. Run with: node tools/test-blueprint.mjs
import fs from "node:fs"
import zlib from "node:zlib"
import assert from "node:assert/strict"
import { encodeBlueprint, decodeBlueprint, gameVersion } from "../blueprint/codec.js"
import { defaultParams, buildColumnBlueprint, parseReply, ineligibleReason } from "../blueprint/dsl.js"
import { placeColumns } from "../blueprint/columns.js"
import { validateParams, validateLayout } from "../blueprint/validate.js"
import { previewLayout } from "../blueprint/build.js"
import { askForLayout } from "../blueprint/llm.js"
import { EAST } from "../blueprint/entities.js"

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

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
