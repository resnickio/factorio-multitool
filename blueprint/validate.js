// Checks a layout, independently of how it was produced.

import {
    entityInfo, beltThroughput, inserterThroughput, machineCrafts, lookupRecipe,
    isMachineType, solidItems, ALLOWED_INSERTERS, ALLOWED_POLES, NORTH, EAST, SOUTH, WEST,
} from "./entities.js"

// Which way an inserter's direction points: at the tile it picks up from.
const STEP = {[NORTH]: [0, -1], [EAST]: [1, 0], [SOUTH]: [0, 1], [WEST]: [-1, 0]}

// Why a recipe cannot be built in a column by the given machine, or null.
export function ineligibleReason(data, recipeKey, machineName) {
    let info = data.blueprint_entities[machineName]
    if (!info || !isMachineType(info.type)) {
        return `${machineName} is not an electric crafting machine`
    }
    if (info.width !== info.height) {
        return `${machineName} is not square`
    }
    let recipe = data.recipes.find(r => r.key === recipeKey)
    if (!recipe) {
        return `unknown recipe ${recipeKey}`
    }
    let name = recipe.localized_name.en
    if (!recipe.categories.some(c => info.crafting_categories.includes(c))) {
        return `${machineName} cannot craft ${name}`
    }
    let solids = solidItems(data)
    for (let i of [...recipe.ingredients, ...recipe.results]) {
        if (!solids.has(i.name)) {
            return `${name} uses a fluid, which needs pipes`
        }
    }
    if (recipe.ingredients.length > 2) {
        return `${name} has ${recipe.ingredients.length} ingredients; a column can feed two on one belt`
    }
    if (recipe.ingredients.length === 0) {
        return `${name} has no ingredients`
    }
    return null
}

// Checks the parameters of a layout request against the requirements, before
// anything is placed.
//
// requirement: {recipe, rate}, where rate is the output items/second needed
// of the recipe's first product.
export function validateParams(params, requirement, data) {
    let errors = []
    let warnings = []
    let stats = {}
    if (!Number.isInteger(params.machines) || params.machines < 1) {
        errors.push("machines must be a positive integer")
    }
    if (params.columns !== 1 && params.columns !== 2) {
        errors.push("columns must be 1 or 2")
    }
    for (let key of ["inputInserters", "outputInserters"]) {
        if (params[key] !== 1 && params[key] !== 2) {
            errors.push(`${key} must be 1 or 2`)
        }
    }
    let known = (key, kinds) => {
        let info = data.blueprint_entities[params[key]]
        if (!info || !kinds.includes(info.type)) {
            errors.push(`${key} "${params[key]}" is not a known ${kinds[0]}`)
            return false
        }
        return true
    }
    known("machine", ["furnace", "assembling-machine"])
    known("inputBelt", ["transport-belt"])
    known("outputBelt", ["transport-belt"])
    let okIi = known("inputInserter", ["inserter"])
    let okOi = known("outputInserter", ["inserter"])
    let okPole = known("pole", ["electric-pole"])
    if (okIi && !ALLOWED_INSERTERS.includes(params.inputInserter)) {
        errors.push(`inputInserter must be one of ${ALLOWED_INSERTERS.join(", ")}`)
    }
    if (okOi && !ALLOWED_INSERTERS.includes(params.outputInserter)) {
        errors.push(`outputInserter must be one of ${ALLOWED_INSERTERS.join(", ")}`)
    }
    if (okPole && !ALLOWED_POLES.includes(params.pole)) {
        errors.push(`pole must be one of ${ALLOWED_POLES.join(", ")}`)
    }
    if (errors.length > 0) {
        return {errors, warnings, stats}
    }
    let reason = ineligibleReason(data, requirement.recipe, params.machine)
    if (reason) {
        return {errors: [reason], warnings, stats}
    }

    let recipe = lookupRecipe(data, requirement.recipe)
    let machine = data.blueprint_entities[params.machine]
    let crafts = machineCrafts(machine, recipe)
    let outPerMachine = recipe.results[0].amount * crafts
    let produced = outPerMachine * params.machines
    let fewest = Math.ceil(requirement.rate / outPerMachine - 1e-9)
    stats.machineOutput = outPerMachine
    stats.produced = produced
    stats.needed = requirement.rate
    stats.fewestMachines = fewest
    if (produced < requirement.rate - 1e-9) {
        errors.push(`${params.machines} machines produce ${produced.toFixed(3)}/s, but ${requirement.rate.toFixed(3)}/s is needed; at least ${fewest} are required`)
        return {errors, warnings, stats}
    }
    if (params.machines > fewest * 2 + 2) {
        warnings.push(`${params.machines} machines is much more than needed (${fewest})`)
    }

    // Machines only work as much as is needed, so flows scale with how busy
    // they are.
    let busy = requirement.rate / produced
    stats.busy = busy
    let perMachine = recipe.ingredients.map(i => i.amount * crafts * busy)
    let inPerMachine = perMachine.reduce((a, b) => a + b, 0)
    let outFlow = outPerMachine * busy
    stats.machineInput = inPerMachine
    stats.machineOutputFlow = outFlow

    // Belts. Each input belt serves one column. With two ingredients each
    // keeps to its own lane, so each gets half the belt.
    let perColumn = Math.ceil(params.machines / params.columns)
    let inCap = beltThroughput(data.blueprint_entities[params.inputBelt])
    let laneCap = recipe.ingredients.length === 2 ? inCap / 2 : inCap
    stats.inputBeltCapacity = inCap
    stats.inputBeltLoad = perColumn * inPerMachine
    recipe.ingredients.forEach((ing, i) => {
        let load = perColumn * perMachine[i]
        if (load > laneCap + 1e-9) {
            errors.push(`input belt (${params.inputBelt}) carries ${laneCap}/s of ${ing.name} (${recipe.ingredients.length === 2 ? "one lane" : "both lanes"}) but a column needs ${load.toFixed(2)}/s`)
        }
    })
    // Inserters drop onto the far lane of a belt only. With one column, all of
    // them are on the same side, so the output belt carries half its rate.
    let outCap = beltThroughput(data.blueprint_entities[params.outputBelt]) * (params.columns === 1 ? 0.5 : 1)
    stats.outputBeltLoad = requirement.rate
    stats.outputBeltCapacity = outCap
    if (requirement.rate > outCap + 1e-9) {
        errors.push(`output belt (${params.outputBelt}) carries ${outCap}/s here (${params.columns === 1 ? "one lane, since all the output inserters are on one side" : "both lanes"}) but ${requirement.rate.toFixed(2)}/s is produced`)
    }

    // Inserters.
    let inIns = inserterThroughput(data.blueprint_entities[params.inputInserter], true) * params.inputInserters
    let outIns = inserterThroughput(data.blueprint_entities[params.outputInserter], false) * params.outputInserters
    stats.inputInserterRate = inIns
    stats.outputInserterRate = outIns
    if (inIns < inPerMachine) {
        errors.push(`${params.inputInserters} ${params.inputInserter}(s) move about ${inIns.toFixed(2)}/s from a belt, but a machine takes in ${inPerMachine.toFixed(2)}/s`)
    }
    if (outIns < outFlow) {
        errors.push(`${params.outputInserters} ${params.outputInserter}(s) move about ${outIns.toFixed(2)}/s, but a machine puts out ${outFlow.toFixed(2)}/s`)
    }
    return {errors, warnings, stats}
}

// Checks the placed entities: nothing overlaps, inserters connect things, and
// everything that needs power has it.
export function validateLayout(entities, data) {
    let errors = []
    let typeOf = e => entityInfo(data, e.name).type

    let tiles = new Map()
    for (let e of entities) {
        for (let dx = 0; dx < e.w; dx++) {
            for (let dy = 0; dy < e.h; dy++) {
                let key = `${e.x + dx},${e.y + dy}`
                let other = tiles.get(key)
                if (other) {
                    errors.push(`${e.name} at (${e.x},${e.y}) overlaps ${other.name} at (${other.x},${other.y})`)
                } else {
                    tiles.set(key, e)
                }
            }
        }
    }

    // Inserters pick up from the tile their direction points at, and drop onto
    // the opposite one. Every machine needs one feeding it and one emptying it.
    let feeders = new Map()
    let takers = new Map()
    let at = (tx, ty) => tiles.get(`${tx},${ty}`)
    let isMachine = e => e !== undefined && isMachineType(typeOf(e))
    let connectable = e => e !== undefined && (isMachine(e) || typeOf(e) === "transport-belt")
    let kind = e => isMachine(e) ? "machine" : typeOf(e)
    for (let e of entities) {
        if (typeOf(e) !== "inserter") {
            continue
        }
        let [dx, dy] = STEP[e.direction]
        let pick = at(e.x + dx, e.y + dy)
        let drop = at(e.x - dx, e.y - dy)
        if (!connectable(pick)) {
            errors.push(`${e.name} at (${e.x},${e.y}) has nothing to pick up from`)
        }
        if (!connectable(drop)) {
            errors.push(`${e.name} at (${e.x},${e.y}) has nothing to drop onto`)
        }
        if (connectable(pick) && connectable(drop) && kind(pick) === kind(drop)) {
            errors.push(`${e.name} at (${e.x},${e.y}) moves between two ${kind(pick)}s`)
        }
        if (isMachine(drop)) {
            feeders.set(drop, (feeders.get(drop) || 0) + 1)
        }
        if (isMachine(pick)) {
            takers.set(pick, (takers.get(pick) || 0) + 1)
        }
    }
    for (let e of entities) {
        if (!isMachine(e)) {
            continue
        }
        if (!feeders.has(e)) {
            errors.push(`machine at (${e.x},${e.y}) has no inserter feeding it`)
        }
        if (!takers.has(e)) {
            errors.push(`machine at (${e.x},${e.y}) has no inserter emptying it`)
        }
    }

    // Power: every machine and inserter must overlap a pole's supply area, and
    // the poles must be connected by wire.
    let poles = entities.filter(e => typeOf(e) === "electric-pole")
    let supply = p => {
        let d = entityInfo(data, p.name).supply_area_distance
        let cx = p.x + p.w / 2
        let cy = p.y + p.h / 2
        return {x1: cx - d, y1: cy - d, x2: cx + d, y2: cy + d}
    }
    // The collision box of a one-tile entity is a little smaller than the tile.
    let covered = (area, e) => {
        let shrink = e.w === 1 && e.h === 1 ? 0.35 : 0.1
        return e.x + shrink < area.x2 && e.x + e.w - shrink > area.x1 &&
            e.y + shrink < area.y2 && e.y + e.h - shrink > area.y1
    }
    let areas = poles.map(supply)
    for (let e of entities) {
        if ((isMachine(e) || typeOf(e) === "inserter") && !areas.some(a => covered(a, e))) {
            errors.push(`${e.name} at (${e.x},${e.y}) is not covered by any pole`)
        }
    }
    if (poles.length === 0) {
        errors.push("there are no poles")
    } else {
        let reach = (a, b) => {
            let d = Math.min(entityInfo(data, a.name).maximum_wire_distance, entityInfo(data, b.name).maximum_wire_distance)
            return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) <= d
        }
        let seen = new Set([0])
        let queue = [0]
        while (queue.length > 0) {
            let i = queue.pop()
            for (let j = 0; j < poles.length; j++) {
                if (!seen.has(j) && reach(poles[i], poles[j])) {
                    seen.add(j)
                    queue.push(j)
                }
            }
        }
        if (seen.size !== poles.length) {
            errors.push(`${poles.length - seen.size} poles are not connected to the rest by wire`)
        }
    }
    return {errors}
}
