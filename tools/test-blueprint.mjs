// Tests for the blueprint generator. Run with: node tools/test-blueprint.mjs
import fs from "node:fs"
import zlib from "node:zlib"
import assert from "node:assert/strict"
import { encodeBlueprint, decodeBlueprint, gameVersion } from "../blueprint/codec.js"
import { defaultParams, buildSmeltingBlueprint, parseReply } from "../blueprint/dsl.js"
import { placeSmeltingColumns } from "../blueprint/smelting.js"
import { validateParams, validateLayout } from "../blueprint/validate.js"
import { previewLayout } from "../blueprint/build.js"
import { askForLayout } from "../blueprint/llm.js"
import { SOUTH, WEST, EAST } from "../blueprint/entities.js"

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

const iron = {recipe: "iron-plate", rate: 15}

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
    let params = defaultParams(iron, "electric-furnace", data)
    // 0.625 plates/s per electric furnace.
    assert.equal(params.furnaces, 24)
    let r = buildSmeltingBlueprint(params, iron, data)
    assert.deepEqual(r.errors, [])
    assert.ok(r.ok)
    let counts = {}
    for (let e of r.entities) {
        counts[e.name] = (counts[e.name] || 0) + 1
    }
    assert.equal(counts["electric-furnace"], 24)
    assert.equal(counts[params.inputInserter] + (params.inputInserter === params.outputInserter ? 0 : 0) >= 24, true)
    console.log("\n" + previewLayout(r.entities, data).split("\n").slice(0, 13).join("\n") + "\n")
})

await test("a faster belt is preferred to a second column while one will do", () => {
    let want = {recipe: "iron-plate", rate: 25}
    let params = defaultParams(want, "electric-furnace", data)
    assert.equal(params.columns, 1)
    // The output sits on one lane, so it needs a belt of twice the rate (50/s).
    assert.equal(params.outputBelt, "turbo-transport-belt")
    assert.deepEqual(buildSmeltingBlueprint(params, want, data).errors, [])
})

await test("one column puts all output on one lane", () => {
    let p = {...defaultParams(iron, "electric-furnace", data), columns: 1, outputBelt: "transport-belt"}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.some(e => /one lane/.test(e)), v.errors.join("; "))
    let two = validateParams({...p, columns: 2}, iron, data)
    assert.ok(!two.errors.some(e => /output belt/.test(e)), two.errors.join("; "))
})

await test("a steel demand too big for one input belt uses two columns", () => {
    // Steel takes five iron plates per craft, so the input belt is the limit.
    let want = {recipe: "steel-plate", rate: 15}
    let params = defaultParams(want, "electric-furnace", data)
    assert.equal(params.columns, 2)
    assert.deepEqual(buildSmeltingBlueprint(params, want, data).errors, [])
})

await test("more than one output belt can carry is reported, not built", () => {
    let want = {recipe: "iron-plate", rate: 130}
    let r = buildSmeltingBlueprint(defaultParams(want, "electric-furnace", data), want, data)
    assert.equal(r.ok, false)
    assert.ok(r.errors.some(e => /output belt/.test(e)), r.errors.join("; "))
})

await test("two columns place and validate, including odd counts", () => {
    for (let n of [1, 2, 3, 7, 24, 25]) {
        let params = {...defaultParams(iron, "electric-furnace", data), furnaces: n, columns: 2}
        let placed = placeSmeltingColumns(params, data)
        let v = validateLayout(placed.entities, data)
        assert.deepEqual(v.errors, [], `n=${n}`)
    }
})

await test("steel needs more input than iron plate per output", () => {
    let steel = {recipe: "steel-plate", rate: 1.25}
    let params = defaultParams(steel, "electric-furnace", data)
    let r = buildSmeltingBlueprint(params, steel, data)
    assert.deepEqual(r.errors, [])
})

await test("validator rejects too few furnaces", () => {
    let p = {...defaultParams(iron, "electric-furnace", data), furnaces: 10}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.some(e => /at least 24/.test(e)), v.errors.join("; "))
})

await test("validator rejects a belt which cannot carry the load", () => {
    let p = {...defaultParams(iron, "electric-furnace", data), columns: 1, inputBelt: "transport-belt", furnaces: 30}
    let v = validateParams(p, {recipe: "iron-plate", rate: 15}, data)
    assert.ok(v.errors.some(e => /input belt/.test(e)), v.errors.join("; "))
})

await test("validator rejects an inserter which is too slow", () => {
    let p = {...defaultParams(iron, "electric-furnace", data), inputInserter: "inserter"}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.some(e => /moves about/.test(e)), v.errors.join("; "))
})

await test("validator rejects unknown names and disallowed inserters", () => {
    let p = {...defaultParams(iron, "electric-furnace", data), pole: "wooden-chest", inputInserter: "stack-inserter"}
    let v = validateParams(p, iron, data)
    assert.ok(v.errors.length >= 2, v.errors.join("; "))
})

await test("layout validator catches missing poles", () => {
    let params = defaultParams(iron, "electric-furnace", data)
    let placed = placeSmeltingColumns(params, data)
    let noPoles = placed.entities.filter(e => e.name !== params.pole)
    assert.ok(validateLayout(noPoles, data).errors.length > 0)
})

await test("layout validator catches a reversed inserter and an overlap", () => {
    let params = defaultParams(iron, "electric-furnace", data)
    let placed = placeSmeltingColumns(params, data)
    let flipped = placed.entities.map(e => ({...e}))
    let ins = flipped.find(e => e.name === params.inputInserter)
    ins.direction = EAST
    let v = validateLayout(flipped, data)
    assert.ok(v.errors.some(e => /no inserter feeding/.test(e)), v.errors.join("; "))
    let overlapped = placed.entities.concat([{...placed.entities[0]}])
    assert.ok(validateLayout(overlapped, data).errors.some(e => /overlaps/.test(e)))
})

await test("a sparse pole layout is caught", () => {
    let params = defaultParams(iron, "electric-furnace", data)
    let placed = placeSmeltingColumns(params, data)
    let poles = placed.entities.filter(e => e.name === params.pole)
    let kept = placed.entities.filter(e => e.name !== params.pole || poles.indexOf(e) % 3 === 0)
    assert.ok(validateLayout(kept, data).errors.length > 0)
})

await test("exported blueprint decodes to the same entities", () => {
    let params = defaultParams(iron, "electric-furnace", data)
    let r = buildSmeltingBlueprint(params, iron, data)
    let text = encodeBlueprint(r.blueprint, deflate)
    let back = decodeBlueprint(text, inflate).blueprint
    assert.equal(back.entities.length, r.entities.length)
    assert.equal(back.entities[0].entity_number, 1)
    let furnace = back.entities.find(e => e.name === "electric-furnace")
    // A 3x3 furnace sits on a half-tile centre.
    assert.equal(furnace.position.x % 1, 0.5)
    assert.equal(back.icons[0].signal.name, "electric-furnace")
})

await test("poles are wired into one network", () => {
    for (let want of [{recipe: "iron-plate", rate: 15}, {recipe: "steel-plate", rate: 15}]) {
        let r = buildSmeltingBlueprint(defaultParams(want, "electric-furnace", data), want, data)
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
    let p = parseReply("Here:\n```json\n{\"furnaces\": 3, \"columns\": 1, \"input_belt\": \"transport-belt\", \"output_belt\": \"transport-belt\", \"input_inserter\": \"inserter\", \"output_inserter\": \"inserter\", \"pole\": \"medium-electric-pole\"}\n```")
    assert.equal(p.furnaces, 3)
    assert.equal(p.inputBelt, "transport-belt")
    assert.throws(() => parseReply("no json here"))
})

await test("the model loop repairs a rejected first answer", async () => {
    let good = defaultParams(iron, "electric-furnace", data)
    let reply = p => JSON.stringify({furnaces: p.furnaces, columns: p.columns, input_belt: p.inputBelt, output_belt: p.outputBelt, input_inserter: p.inputInserter, output_inserter: p.outputInserter, pole: p.pole, notes: "ok"})
    let replies = [reply({...good, furnaces: 5}), "```json\n" + reply(good) + "\n```"]
    let seen = []
    let fetchFn = async (url, init) => {
        seen.push(JSON.parse(init.body))
        let text = replies.shift()
        return {ok: true, json: async () => ({content: [{type: "text", text}]})}
    }
    let r = await askForLayout({apiKey: "k", model: "m", requirement: iron, furnace: "electric-furnace", data, fetchFn})
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(r.attempts, 2)
    // The second request contains the complaint about the first.
    assert.ok(seen[1].messages.at(-1).content.includes("rejected"))
    assert.ok(seen[0].system.length > 100)
})

await test("the model loop gives up and reports errors", async () => {
    let fetchFn = async () => ({ok: true, json: async () => ({content: [{type: "text", text: "I cannot"}]})})
    let r = await askForLayout({apiKey: "k", model: "m", requirement: iron, furnace: "electric-furnace", data, fetchFn, maxAttempts: 2})
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 2)
})

await test("an API error is reported", async () => {
    let fetchFn = async () => ({ok: false, status: 401, statusText: "Unauthorized", json: async () => ({error: {message: "invalid x-api-key"}})})
    await assert.rejects(askForLayout({apiKey: "bad", model: "m", requirement: iron, furnace: "electric-furnace", data, fetchFn}), /401.*invalid x-api-key/)
})

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
