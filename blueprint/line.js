// Production lines: a final recipe (such as electronic circuits) with up to two
// chains of producers feeding it, around one shared belt.
//
// The shared belt (MID) runs down the middle. The final recipe's machines stand
// on its west, below the producers. Each of its ingredients can come from a
// branch of up to two stages: the east branch's machines stand east of MID and
// fill its west lane, the west branch's stand west of MID and fill its east
// lane (inserters only drop on the far lane of a belt), so each ingredient
// keeps its own lane. A branch steps outward: each stage's output belt is the
// next stage's input belt, and the outermost stage takes its ingredients from a
// belt the player supplies. An ingredient without a branch arrives on a feeder
// belt which side-loads onto its lane at the top.
//
//   west branch                    east branch
//   ... | W2 | W1 | MID | E1 | E2 | ...     (stages stack downward, the
//                  |                          outermost first)
//                  v
//               | final recipe |  (below both branches, west of MID)
//
// Belts flow south, and inserters point at the tile they pick up from.

import {
    entityInfo, lookupRecipe, insertRows, fluidIngredients, beltThroughput,
    NORTH, SOUTH, EAST, WEST,
} from "./entities.js"
import { validateParams, validateLayout, ineligibleReason } from "./validate.js"
import { defaultParams } from "./dsl.js"
import { makeBlueprint } from "./build.js"

// How much more than the required rate each stage is sized for.
const HEADROOM = 1.05
const BELTS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"]
const MAX_STAGES = 2
// How far a feeder for an ingredient with no branch reaches from MID.
const FEEDER_LENGTH = 6

function availableBelts(data) {
    return BELTS.filter(b => data.blueprint_entities[b])
}

const SIDES = ["east", "west"]

// What a line is made of:
//   spec = {root: {recipe, machine, rate}, east: [{recipe, machine}], west: [...]}
// The branches list their stages from the one beside MID outward. rate is the
// final recipe's output in items per second.
//
// Returns, for each side, the stages with the rate each must deliver, and the
// ingredient (and rate) which has no branch and arrives on a feeder.
export function resolveLine(spec, data) {
    let root = lookupRecipe(data, spec.root.recipe)
    let crafts = spec.root.rate / root.results[0].amount
    let claimed = {east: null, west: null}
    for (let side of SIDES) {
        if (spec[side].length === 0) {
            continue
        }
        let product = lookupRecipe(data, spec[side][0].recipe).results[0].name
        let ingredient = root.ingredients.find(i => i.name === product)
        if (!ingredient) {
            throw new Error(`${root.localized_name.en} does not use ${product}`)
        }
        claimed[side] = ingredient
    }
    if (!claimed.east && !claimed.west) {
        throw new Error("a line needs at least one branch")
    }
    if (claimed.east && claimed.east === claimed.west) {
        throw new Error("both branches make the same ingredient")
    }
    // An ingredient with no branch is brought in; the east branch's lane is
    // the west one, and the other way round.
    let rest = root.ingredients.filter(i => i !== claimed.east && i !== claimed.west)
    let external = {east: null, west: null}
    for (let side of SIDES) {
        if (!claimed[side] && rest.length > 0) {
            let ing = rest.shift()
            external[side] = {item: ing.name, rate: crafts * ing.amount}
        }
    }
    let stages = {east: [], west: []}
    for (let side of SIDES) {
        let item = claimed[side]
        if (!item) {
            continue
        }
        let rate = crafts * item.amount
        spec[side].forEach((stage, j) => {
            let recipe = lookupRecipe(data, stage.recipe)
            stages[side].push({recipe: stage.recipe, machine: stage.machine, rate})
            if (j + 1 < spec[side].length) {
                // Only one ingredient can come from the next stage inward.
                let next = recipe.ingredients[0]
                rate = (rate / recipe.results[0].amount) * next.amount
            }
        })
    }
    return {root: {recipe: spec.root.recipe, machine: spec.root.machine, rate: spec.root.rate}, stages, external}
}

// Why this line cannot be built, or null.
export function lineIneligibleReason(spec, data) {
    let resolved
    try {
        resolved = resolveLine(spec, data)
    } catch (e) {
        return e.message
    }
    let check = (recipeKey, machine) => {
        let reason = ineligibleReason(data, recipeKey, machine)
        if (reason) {
            return reason
        }
        if (fluidIngredients(data, lookupRecipe(data, recipeKey)).length > 0) {
            return `${lookupRecipe(data, recipeKey).localized_name.en} uses a fluid, which lines do not handle yet`
        }
        return null
    }
    let reason = check(spec.root.recipe, spec.root.machine)
    if (reason) {
        return reason
    }
    for (let side of SIDES) {
        if (spec[side].length > MAX_STAGES) {
            return `a branch can have at most ${MAX_STAGES} stages`
        }
        for (let [j, stage] of spec[side].entries()) {
            reason = check(stage.recipe, stage.machine)
            if (reason) {
                return reason
            }
            let recipe = lookupRecipe(data, stage.recipe)
            // Stages inside a branch take everything from the stage beside them.
            if (j < spec[side].length - 1) {
                if (recipe.ingredients.length !== 1) {
                    return `${recipe.localized_name.en} has ${recipe.ingredients.length} ingredients; a stage between others can only take its product from the next one`
                }
                let next = lookupRecipe(data, spec[side][j + 1].recipe)
                if (next.results[0].name !== recipe.ingredients[0].name) {
                    return `${next.localized_name.en} does not make what ${recipe.localized_name.en} uses`
                }
            }
        }
    }
    return null
}

// Parameters of one stage as the single-column code understands them.
function stageParams(params, side, j, data) {
    let branch = params[side]
    let stage = branch.stages[j]
    let last = branch.stages.length - 1
    return {
        pipe: "pipe", pipeToGround: "pipe-to-ground", pole: params.pole, columns: 1,
        recipe: stage.recipe, machine: stage.machine, machines: stage.machines,
        inputBelt: j === last ? branch.supply : branch.belts[j],
        outputBelt: j === 0 ? params.mid : branch.belts[j - 1],
        inputInserter: stage.inputInserter, inputInserters: stage.inputInserters,
        outputInserter: stage.outputInserter, outputInserters: stage.outputInserters,
    }
}

function rootParams(params) {
    let root = params.root
    return {
        pipe: "pipe", pipeToGround: "pipe-to-ground", pole: params.pole, columns: 1,
        recipe: root.recipe, machine: root.machine, machines: root.machines,
        inputBelt: params.mid, outputBelt: root.outputBelt,
        inputInserter: root.inputInserter, inputInserters: root.inputInserters,
        outputInserter: root.outputInserter, outputInserters: root.outputInserters,
    }
}

// Params:
//   pole, mid,
//   root: {recipe, machine, machines, outputBelt, inputInserter, inputInserters, outputInserter, outputInserters}
//   east, west: {stages: [{recipe, machine, machines, inputInserter, ..., outputInserters}],
//                belts: [the belt each stage takes from, but the outermost's],
//                supply: the outermost stage's input belt, or the feeder belt}
export function validateLine(params, spec, data) {
    let errors = []
    let warnings = []
    let stats = {}
    let reason = lineIneligibleReason(spec, data)
    if (reason) {
        return {errors: [reason], warnings, stats}
    }
    let resolved = resolveLine(spec, data)
    let name = key => lookupRecipe(data, key).localized_name.en
    let run = (label, sp, requirement) => {
        let checked = validateParams(sp, requirement, data)
        for (let e of checked.errors) {
            errors.push(`${label}: ${e}`)
        }
        warnings.push(...checked.warnings)
        return checked.stats
    }
    stats.root = run(`final (${name(spec.root.recipe)})`, rootParams(params), {recipe: spec.root.recipe, rate: spec.root.rate})
    for (let side of SIDES) {
        stats[side] = []
        resolved.stages[side].forEach((stage, j) => {
            stats[side].push(run(`${side} stage ${j + 1} (${name(stage.recipe)})`, stageParams(params, side, j, data), {recipe: stage.recipe, rate: stage.rate}))
        })
        let external = resolved.external[side]
        if (external) {
            let info = data.blueprint_entities[params[side].supply]
            if (!info || info.type !== "transport-belt") {
                errors.push(`${side} feeder belt "${params[side].supply}" is not a known transport-belt`)
            } else if (external.rate > beltThroughput(info) + 1e-9) {
                errors.push(`the ${side} feeder belt (${params[side].supply}) carries ${beltThroughput(info)}/s of ${external.item}, but ${external.rate.toFixed(2)}/s is needed`)
            }
        }
    }
    return {errors, warnings, stats}
}

// Places one branch. sign is +1 for the east branch, -1 for the west.
// Returns the rows it uses and where its supply connects.
function placeBranch(add, params, side, data, poleStep) {
    let branch = params[side]
    let sign = side === "east" ? 1 : -1
    let n = branch.stages.length
    let sizes = branch.stages.map(s => entityInfo(data, s.machine).width)
    let rows = branch.stages.map((s, j) => s.machines * sizes[j])
    // The outermost stage is at the top; each one in sits below the last.
    let y0 = new Array(n)
    let y = 0
    for (let j = n - 1; j >= 0; j--) {
        y0[j] = y
        y += rows[j]
    }
    let direction = sign > 0 ? EAST : WEST
    let outBelt = 0
    let supplyX = null
    for (let j = 0; j < n; j++) {
        let stage = branch.stages[j]
        let size = sizes[j]
        let outIns = outBelt + sign
        let machineX = sign > 0 ? outBelt + 2 : outBelt - 1 - size
        let inIns = sign > 0 ? outBelt + 2 + size : outBelt - 2 - size
        let inBelt = outBelt + sign * (3 + size)
        let isAssembler = entityInfo(data, stage.machine).type === "assembling-machine"
        for (let i = 0; i < stage.machines; i++) {
            let my = y0[j] + i * size
            add(stage.machine, machineX, my, NORTH, isAssembler ? {recipe: stage.recipe} : {})
            for (let row of insertRows(size, new Set()).slice(0, stage.outputInserters)) {
                add(stage.outputInserter, outIns, my + row, direction)
            }
            for (let row of insertRows(size, new Set()).slice(0, stage.inputInserters)) {
                add(stage.inputInserter, inIns, my + row, direction)
            }
        }
        for (let i = 0; i < stage.machines; i += poleStep) {
            add(params.pole, outIns, y0[j] + i * size + size - 1, NORTH)
            add(params.pole, inIns, y0[j] + i * size + size - 1, NORTH)
        }
        // This stage's input belt: the next stage in puts its output on it, so
        // it starts at that stage's first row; the outermost starts at its own.
        let beltTier = j === n - 1 ? branch.supply : branch.belts[j]
        let from = j === n - 1 ? 0 : y0[j + 1]
        for (let by = from; by < y0[j] + rows[j]; by++) {
            add(beltTier, inBelt, by, SOUTH)
        }
        outBelt = inBelt
        supplyX = inBelt
    }
    // The outermost stage's supply arrives on a feeder at its first row.
    for (let k = 1; k <= 2; k++) {
        add(branch.supply, supplyX + sign * k, 0, sign > 0 ? WEST : EAST)
    }
    return {rows: y, feederEnd: supplyX + sign * 2}
}

function place(params, spec, data, poleStep) {
    let resolved = resolveLine(spec, data)
    let entities = []
    let add = (name, tx, ty, direction, extra) => {
        let info = entityInfo(data, name)
        entities.push({name, x: tx, y: ty, w: info.width, h: info.height, direction, ...extra})
    }
    let rows = {east: 0, west: 0}
    let inputs = []
    for (let side of SIDES) {
        let sign = side === "east" ? 1 : -1
        if (spec[side].length > 0) {
            let placed = placeBranch(add, params, side, data, poleStep)
            rows[side] = placed.rows
            let outermost = resolved.stages[side].at(-1)
            inputs.push({x: placed.feederEnd, y: 0, items: lookupRecipe(data, outermost.recipe).ingredients.map(i => i.name)})
        } else if (resolved.external[side]) {
            // An ingredient with no branch: a feeder above everything, joining
            // MID from the side which puts it on the lane for that side.
            // The east branch's lane is the west one, so its feeder comes from the west.
            let from = -sign
            for (let k = 1; k <= FEEDER_LENGTH; k++) {
                add(params[side].supply, from * k, -1, from > 0 ? WEST : EAST)
            }
            inputs.push({x: from * FEEDER_LENGTH, y: -1, items: [resolved.external[side].item]})
        }
    }

    // The final recipe's machines, west of MID and below both branches.
    let root = params.root
    let size = entityInfo(data, root.machine).width
    let startY = Math.max(rows.east, rows.west) + (rows.west > 0 ? 1 : 0)
    let rootRows = root.machines * size
    let x = {inIns: -1, machine: -1 - size, outIns: -2 - size, outBelt: -3 - size}
    let isAssembler = entityInfo(data, root.machine).type === "assembling-machine"
    for (let i = 0; i < root.machines; i++) {
        let my = startY + i * size
        add(root.machine, x.machine, my, NORTH, isAssembler ? {recipe: root.recipe} : {})
        for (let row of insertRows(size, new Set()).slice(0, root.inputInserters)) {
            add(root.inputInserter, x.inIns, my + row, EAST)
        }
        for (let row of insertRows(size, new Set()).slice(0, root.outputInserters)) {
            add(root.outputInserter, x.outIns, my + row, EAST)
        }
    }
    for (let i = 0; i < root.machines; i += poleStep) {
        add(params.pole, x.inIns, startY + i * size + size - 1, NORTH)
        add(params.pole, x.outIns, startY + i * size + size - 1, NORTH)
    }
    for (let by = startY; by < startY + rootRows; by++) {
        add(root.outputBelt, x.outBelt, by, SOUTH)
    }
    // MID starts two tiles early, so a feeder arrives at the side of a belt
    // which has one behind it.
    for (let by = -2; by < startY + rootRows; by++) {
        add(params.mid, 0, by, SOUTH)
    }
    let rootRecipe = lookupRecipe(data, root.recipe)
    return {
        entities,
        connections: {
            inputs,
            output: {x: x.outBelt, y: startY + rootRows - 1, item: rootRecipe.results[0].name},
            fluids: [],
        },
    }
}

export function placeLine(params, spec, data) {
    // Poles go as far apart as still covers every inserter and machine.
    let best = null
    for (let step of [4, 3, 2, 1]) {
        let placed = place(params, spec, data, step)
        best = placed
        if (validateLayout(placed.entities, data).errors.length === 0) {
            break
        }
    }
    return best
}

// Picks the cheapest valid parameters, from the slowest shared belt up. Each
// stage is sized for a little more than needed where the belts allow.
export function defaultLineParams(spec, data) {
    let resolved = resolveLine(spec, data)
    let belts = availableBelts(data)
    let scaled = (req, factor) => ({recipe: req.recipe, rate: req.rate * factor})
    let stageOf = p => ({
        recipe: p.recipe, machine: p.machine, machines: p.machines,
        inputInserter: p.inputInserter, inputInserters: p.inputInserters,
        outputInserter: p.outputInserter, outputInserters: p.outputInserters,
    })
    // A branch's stages and the belts between them, for one shared belt tier.
    let branchFor = (side, mid, factor) => {
        let stages = resolved.stages[side]
        let external = resolved.external[side]
        let supplyFor = rate => belts.find(b => beltThroughput(data.blueprint_entities[b]) >= rate) || belts.at(-1)
        if (stages.length === 0) {
            return {stages: [], belts: [], supply: external ? supplyFor(external.rate) : belts[0]}
        }
        let find = (stage, fixed) => defaultParams(scaled(stage, factor), stage.machine, data, {columns: 1, ...fixed})
        if (stages.length === 1) {
            let p = find(stages[0], {outputBelt: mid})
            return {stages: [stageOf(p)], belts: [], supply: p.inputBelt}
        }
        // Two stages: they share one belt.
        let last = null
        for (let between of belts) {
            let inner = find(stages[0], {outputBelt: mid, inputBelt: between})
            let outer = find(stages[1], {outputBelt: between})
            last = {stages: [stageOf(inner), stageOf(outer)], belts: [between], supply: outer.inputBelt}
            let sp = [stageParams({mid, pole: "medium-electric-pole", east: last, west: last}, "east", 0, data), stageParams({mid, pole: "medium-electric-pole", east: last, west: last}, "east", 1, data)]
            if (validateParams(sp[0], stages[0], data).errors.length === 0 && validateParams(sp[1], stages[1], data).errors.length === 0) {
                return last
            }
        }
        return last
    }
    let last = null
    for (let factor of [HEADROOM, 1]) {
        for (let mid of belts) {
            let root = defaultParams(scaled(resolved.root, factor), spec.root.machine, data, {columns: 1, inputBelt: mid})
            last = {
                pole: "medium-electric-pole",
                mid,
                root: {
                    recipe: spec.root.recipe, machine: spec.root.machine, machines: root.machines, outputBelt: root.outputBelt,
                    inputInserter: root.inputInserter, inputInserters: root.inputInserters,
                    outputInserter: root.outputInserter, outputInserters: root.outputInserters,
                },
                east: branchFor("east", mid, factor),
                west: branchFor("west", mid, factor),
            }
            if (validateLine(last, spec, data).errors.length === 0) {
                return last
            }
        }
    }
    return last
}

// Validates, places and re-validates. Returns {ok, errors, warnings, stats,
// entities, connections, blueprint}.
export function buildLineBlueprint(params, spec, data) {
    let checked = validateLine(params, spec, data)
    if (checked.errors.length > 0) {
        return {ok: false, errors: checked.errors, warnings: checked.warnings, stats: checked.stats}
    }
    let placed = placeLine(params, spec, data)
    let layout = validateLayout(placed.entities, data)
    if (layout.errors.length > 0) {
        return {ok: false, errors: layout.errors, warnings: checked.warnings, stats: checked.stats, entities: placed.entities}
    }
    let root = lookupRecipe(data, spec.root.recipe)
    let parts = []
    for (let side of ["west", "east"]) {
        for (let stage of [...params[side].stages].reverse()) {
            parts.push(`${stage.machines}x ${lookupRecipe(data, stage.recipe).localized_name.en}`)
        }
    }
    let label = `${parts.join(", ")} -> ${params.root.machines}x ${root.localized_name.en}`
    let icons = [spec.root.machine, root.results[0].name]
    let blueprint = makeBlueprint(placed.entities, label, icons, data)
    return {
        ok: true, errors: [], warnings: checked.warnings, stats: checked.stats,
        entities: placed.entities, connections: placed.connections, blueprint,
    }
}
