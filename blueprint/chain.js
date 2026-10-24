// Chains of two machine columns sharing one belt.
//
// The upstream recipe (for example copper cable) makes an ingredient of the
// downstream recipe (for example electronic circuits). The upstream machines
// stand on the east of a middle belt and put their output on its west lane
// (inserters drop on the far lane); the downstream machines stand below them
// on the west of the same belt, and take what they need from either lane. The
// downstream recipe's other ingredient (iron plate) arrives on a feeder belt
// which side-loads onto the east lane of the middle belt at the top.
//
//        feeder of the other ingredient <-----------------+
//                      |                                  |
//   out belt | ins | down | ins | MID | ins | up | ins | supply belt <- feeder
//      (flowing south)  (below)   ^ both lanes     (above the downstream)
//
// All belts flow south, and all inserters point east (at the tile they pick up
// from), as in the right-hand column of a two-column layout.

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

function availableBelts(data) {
    return BELTS.filter(b => data.blueprint_entities[b])
}

// The two stages' requirements, from the downstream one.
//   requirement: {recipe (downstream), rate (its first product, per second),
//                 upstream (the recipe key which makes one of its ingredients)}
export function stageRequirements(requirement, data) {
    let down = lookupRecipe(data, requirement.recipe)
    let up = lookupRecipe(data, requirement.upstream)
    let linking = down.ingredients.find(i => i.name === up.results[0].name)
    if (!linking) {
        throw new Error(`${down.localized_name.en} does not use ${up.localized_name.en}`)
    }
    let other = down.ingredients.find(i => i !== linking)
    let crafts = requirement.rate / down.results[0].amount
    return {
        downstream: {recipe: down.key, rate: requirement.rate},
        // Items of the linking ingredient per second.
        upstream: {recipe: up.key, rate: crafts * linking.amount},
        other: other ? {item: other.name, rate: crafts * other.amount} : null,
        linking: linking.name,
    }
}

// Why this pair of recipes and machines cannot be built as a chain, or null.
export function chainIneligibleReason(requirement, machines, data) {
    let down, up
    try {
        down = lookupRecipe(data, requirement.recipe)
        up = lookupRecipe(data, requirement.upstream)
    } catch (e) {
        return e.message
    }
    if (!down.ingredients.some(i => i.name === up.results[0].name)) {
        return `${down.localized_name.en} does not use ${up.localized_name.en}`
    }
    for (let [recipe, machine] of [[up, machines.upstream], [down, machines.downstream]]) {
        let reason = ineligibleReason(data, recipe.key, machine)
        if (reason) {
            return reason
        }
        if (fluidIngredients(data, recipe).length > 0) {
            return `${recipe.localized_name.en} uses a fluid, which chains do not handle yet`
        }
    }
    return null
}

// Parameters for one stage, as the single-column code understands them.
function stageParams(params, which, data) {
    let stage = params[which]
    let recipe = which === "upstream" ? params.upstreamRecipe : params.downstreamRecipe
    return {
        pipe: "pipe", pipeToGround: "pipe-to-ground", pole: params.pole,
        columns: 1, recipe,
        machine: stage.machine, machines: stage.machines,
        inputBelt: which === "upstream" ? stage.inputBelt : params.mid,
        outputBelt: which === "upstream" ? params.mid : stage.outputBelt,
        inputInserter: stage.inputInserter, inputInserters: stage.inputInserters,
        outputInserter: stage.outputInserter, outputInserters: stage.outputInserters,
    }
}

// Params:
//   mid, supply (belt for the other ingredient's feeder), pole,
//   upstreamRecipe, downstreamRecipe,
//   upstream:   {machine, machines, inputBelt, inputInserter, inputInserters, outputInserter, outputInserters}
//   downstream: {machine, machines, outputBelt, inputInserter, inputInserters, outputInserter, outputInserters}
export function validateChain(params, requirement, data) {
    let errors = []
    let warnings = []
    let stats = {}
    let reason = chainIneligibleReason(requirement, {upstream: params.upstream.machine, downstream: params.downstream.machine}, data)
    if (reason) {
        return {errors: [reason], warnings, stats}
    }
    let st = stageRequirements(requirement, data)
    for (let which of ["upstream", "downstream"]) {
        let recipe = lookupRecipe(data, which === "upstream" ? st.upstream.recipe : st.downstream.recipe)
        let checked = validateParams(stageParams(params, which, data), st[which], data)
        for (let e of checked.errors) {
            errors.push(`${which} (${recipe.localized_name.en}): ${e}`)
        }
        warnings.push(...checked.warnings)
        stats[which] = checked.stats
    }
    if (st.other) {
        let supplyCap = beltThroughput(entityInfo(data, params.supply))
        stats.otherLoad = st.other.rate
        if (st.other.rate > supplyCap + 1e-9) {
            errors.push(`the feeder belt (${params.supply}) carries ${supplyCap}/s of ${st.other.item}, but ${st.other.rate.toFixed(2)}/s is needed`)
        }
    }
    return {errors, warnings, stats}
}

function place(params, data, poleStep) {
    let up = params.upstream
    let down = params.downstream
    let sizeU = entityInfo(data, up.machine).width
    let sizeD = entityInfo(data, down.machine).width
    let upRecipe = lookupRecipe(data, params.upstreamRecipe)
    let downRecipe = lookupRecipe(data, params.downstreamRecipe)
    let st = stageRequirements({recipe: params.downstreamRecipe, rate: 1, upstream: params.upstreamRecipe}, data)

    // Tile columns: the middle belt at 0, the upstream machines to its east,
    // the downstream to its west.
    let xs = 3 + sizeU
    let x = {
        mid: 0,
        upOut: 1, upMachine: 2, upIn: 2 + sizeU, supply: xs,
        downIn: -1, downMachine: -1 - sizeD, downOut: -2 - sizeD, outBelt: -3 - sizeD,
    }
    let rowsU = up.machines * sizeU
    let rowsD = down.machines * sizeD
    let entities = []
    let add = (name, tx, ty, direction, extra) => {
        let info = entityInfo(data, name)
        entities.push({name, x: tx, y: ty, w: info.width, h: info.height, direction, ...extra})
    }

    // The middle belt starts two tiles early, so that the feeder arrives from
    // the side of a belt which has one behind it.
    for (let y = -2; y < rowsU + rowsD; y++) {
        add(params.mid, x.mid, y, SOUTH)
    }
    // Upstream's own supply belt, with a feeder from the east.
    for (let y = 0; y < rowsU; y++) {
        add(up.inputBelt, x.supply, y, SOUTH)
    }
    for (let tx = xs + 1; tx <= xs + 2; tx++) {
        add(up.inputBelt, tx, 0, WEST)
    }
    // The other ingredient's feeder, above everything, into the middle belt.
    let feederEnd = xs + 2
    if (st.other) {
        for (let tx = 1; tx <= feederEnd; tx++) {
            add(params.supply, tx, -1, WEST)
        }
    }
    // The downstream's output belt.
    for (let y = rowsU; y < rowsU + rowsD; y++) {
        add(down.outputBelt, x.outBelt, y, SOUTH)
    }

    let rowsFor = (size, count) => insertRows(size, new Set()).slice(0, count)
    for (let i = 0; i < up.machines; i++) {
        let y = i * sizeU
        add(up.machine, x.upMachine, y, NORTH, entityInfo(data, up.machine).type === "assembling-machine" ? {recipe: params.upstreamRecipe} : {})
        for (let row of rowsFor(sizeU, up.outputInserters)) {
            add(up.outputInserter, x.upOut, y + row, EAST)
        }
        for (let row of rowsFor(sizeU, up.inputInserters)) {
            add(up.inputInserter, x.upIn, y + row, EAST)
        }
    }
    for (let i = 0; i < down.machines; i++) {
        let y = rowsU + i * sizeD
        add(down.machine, x.downMachine, y, NORTH, entityInfo(data, down.machine).type === "assembling-machine" ? {recipe: params.downstreamRecipe} : {})
        for (let row of rowsFor(sizeD, down.inputInserters)) {
            add(down.inputInserter, x.downIn, y + row, EAST)
        }
        for (let row of rowsFor(sizeD, down.outputInserters)) {
            add(down.outputInserter, x.downOut, y + row, EAST)
        }
    }

    // Poles beside each inserter column, in the machine's free bottom row.
    for (let [tx, size, count, y0] of [
        [x.upOut, sizeU, up.machines, 0], [x.upIn, sizeU, up.machines, 0],
        [x.downIn, sizeD, down.machines, rowsU], [x.downOut, sizeD, down.machines, rowsU],
    ]) {
        for (let i = 0; i < count; i += poleStep) {
            add(params.pole, tx, y0 + i * size + size - 1, NORTH)
        }
    }

    let solid = recipe => recipe.ingredients.map(i => i.name)
    let inputs = [{x: feederEnd, y: 0, items: solid(upRecipe)}]
    if (st.other) {
        inputs.push({x: feederEnd, y: -1, items: [st.other.item]})
    }
    return {
        entities,
        width: feederEnd + 1 - x.outBelt,
        height: rowsU + rowsD + 2,
        connections: {
            inputs,
            output: {x: x.outBelt, y: rowsU + rowsD - 1, item: downRecipe.results[0].name},
            fluids: [],
        },
    }
}

export function placeChain(params, data) {
    // Poles go as far apart as still covers every inserter and machine.
    let best = null
    for (let step of [4, 3, 2, 1]) {
        let placed = place(params, data, step)
        best = placed
        if (validateLayout(placed.entities, data).errors.length === 0) {
            break
        }
    }
    return best
}

// Picks the cheapest valid parameters: for each middle belt tier from the
// slowest, the cheapest layout of each stage around it.
//   machines: {upstream, downstream} machine names
export function defaultChainParams(requirement, machines, data) {
    let st = stageRequirements(requirement, data)
    let belts = availableBelts(data)
    let build = (mid, up, down) => ({
        mid,
        supply: belts.find(b => !st.other || beltThroughput(entityInfo(data, b)) >= st.other.rate) || belts[belts.length - 1],
        pole: "medium-electric-pole",
        upstreamRecipe: st.upstream.recipe,
        downstreamRecipe: st.downstream.recipe,
        upstream: {
            machine: machines.upstream, machines: up.machines, inputBelt: up.inputBelt,
            inputInserter: up.inputInserter, inputInserters: up.inputInserters,
            outputInserter: up.outputInserter, outputInserters: up.outputInserters,
        },
        downstream: {
            machine: machines.downstream, machines: down.machines, outputBelt: down.outputBelt,
            inputInserter: down.inputInserter, inputInserters: down.inputInserters,
            outputInserter: down.outputInserter, outputInserters: down.outputInserters,
        },
    })
    // A stage running flat out leaves nothing to absorb the ramp-up and the
    // swings of the inserters, so each is sized for a little more than needed.
    // Where that is too much for the belts, the exact rate is tried.
    let scaled = (rate, factor) => ({...rate, rate: rate.rate * factor})
    let last = null
    for (let factor of [HEADROOM, 1]) {
        for (let mid of belts) {
            let up = defaultParams(scaled(st.upstream, factor), machines.upstream, data, {columns: 1, outputBelt: mid})
            let down = defaultParams(scaled(st.downstream, factor), machines.downstream, data, {columns: 1, inputBelt: mid})
            last = build(mid, up, down)
            if (validateChain(last, requirement, data).errors.length === 0) {
                return last
            }
        }
    }
    return last
}

// Validates, places and re-validates. Returns {ok, errors, warnings, stats,
// entities, connections, blueprint}.
export function buildChainBlueprint(params, requirement, data) {
    let checked = validateChain(params, requirement, data)
    if (checked.errors.length > 0) {
        return {ok: false, errors: checked.errors, warnings: checked.warnings, stats: checked.stats}
    }
    let placed = placeChain(params, data)
    let layout = validateLayout(placed.entities, data)
    if (layout.errors.length > 0) {
        return {ok: false, errors: layout.errors, warnings: checked.warnings, stats: checked.stats, entities: placed.entities}
    }
    let down = lookupRecipe(data, params.downstreamRecipe)
    let up = lookupRecipe(data, params.upstreamRecipe)
    let label = `${params.upstream.machines}x ${up.localized_name.en} -> ${params.downstream.machines}x ${down.localized_name.en}`
    let blueprint = makeBlueprint(placed.entities, label, [params.downstream.machine, down.results[0].name, up.results[0].name], data)
    return {
        ok: true, errors: [], warnings: checked.warnings, stats: checked.stats,
        entities: placed.entities, connections: placed.connections, blueprint,
    }
}
