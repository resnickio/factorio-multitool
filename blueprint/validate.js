// Checks a layout, independently of how it was produced.

import {
    entityInfo, beltThroughput, inserterThroughput, furnaceCrafts, lookupRecipe,
    ALLOWED_INSERTERS, ALLOWED_POLES, NORTH, EAST, SOUTH, WEST,
} from "./entities.js"

const STEP = {[NORTH]: [0, -1], [EAST]: [1, 0], [SOUTH]: [0, 1], [WEST]: [-1, 0]}

// Checks the parameters of a layout request against the requirements, before
// anything is placed.
//
// requirement: {recipe, rate}, where rate is the output items/second needed.
export function validateParams(params, requirement, data) {
    let errors = []
    let warnings = []
    let stats = {}
    if (!Number.isInteger(params.furnaces) || params.furnaces < 1) {
        errors.push("furnaces must be a positive integer")
    }
    if (params.columns !== 1 && params.columns !== 2) {
        errors.push("columns must be 1 or 2")
    }
    let known = (key, kind) => {
        let info = data.blueprint_entities[params[key]]
        if (!info || info.type !== kind) {
            errors.push(`${key} "${params[key]}" is not a known ${kind}`)
            return false
        }
        return true
    }
    known("furnace", "furnace")
    known("inputBelt", "transport-belt")
    known("outputBelt", "transport-belt")
    let okIi = known("inputInserter", "inserter")
    let okOi = known("outputInserter", "inserter")
    let okPole = known("pole", "electric-pole")
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

    let recipe = lookupRecipe(data, requirement.recipe)
    let furnace = data.blueprint_entities[params.furnace]
    let crafts = furnaceCrafts(furnace, recipe)
    let inPerFurnace = recipe.ingredients[0].amount * crafts
    let outPerFurnace = recipe.results[0].amount * crafts
    let produced = outPerFurnace * params.furnaces
    let fewest = Math.ceil(requirement.rate / outPerFurnace - 1e-9)
    stats.furnaceOutput = outPerFurnace
    stats.furnaceInput = inPerFurnace
    stats.produced = produced
    stats.needed = requirement.rate
    stats.fewestFurnaces = fewest
    if (produced < requirement.rate - 1e-9) {
        errors.push(`${params.furnaces} furnaces produce ${produced.toFixed(3)}/s, but ${requirement.rate.toFixed(3)}/s is needed; at least ${fewest} are required`)
    }
    if (params.furnaces > fewest + 2) {
        warnings.push(`${params.furnaces} furnaces is more than needed (${fewest})`)
    }

    // Belts. Each input belt serves one column; the output belt takes it all.
    let perColumn = Math.ceil(params.furnaces / params.columns)
    let inRate = perColumn * inPerFurnace
    let inCap = beltThroughput(data.blueprint_entities[params.inputBelt])
    let outCap = beltThroughput(data.blueprint_entities[params.outputBelt])
    stats.inputBeltLoad = inRate
    stats.inputBeltCapacity = inCap
    stats.outputBeltLoad = produced
    stats.outputBeltCapacity = outCap
    if (inRate > inCap + 1e-9) {
        errors.push(`input belt (${params.inputBelt}) carries ${inCap}/s but a column needs ${inRate.toFixed(2)}/s`)
    }
    if (produced > outCap + 1e-9) {
        errors.push(`output belt (${params.outputBelt}) carries ${outCap}/s but ${produced.toFixed(2)}/s is produced`)
    }

    // Inserters.
    let inIns = inserterThroughput(data.blueprint_entities[params.inputInserter], true)
    let outIns = inserterThroughput(data.blueprint_entities[params.outputInserter], false)
    stats.inputInserterRate = inIns
    stats.outputInserterRate = outIns
    if (inIns < inPerFurnace) {
        errors.push(`${params.inputInserter} moves about ${inIns.toFixed(2)}/s from a belt, but a furnace consumes ${inPerFurnace.toFixed(2)}/s`)
    }
    if (outIns < outPerFurnace) {
        errors.push(`${params.outputInserter} moves about ${outIns.toFixed(2)}/s, but a furnace produces ${outPerFurnace.toFixed(2)}/s`)
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

    // Inserters pick up from, and drop onto, the tiles on either side. Every
    // furnace needs one feeding it and one emptying it.
    let feeders = new Map()
    let takers = new Map()
    let at = (tx, ty) => tiles.get(`${tx},${ty}`)
    let connectable = e => e !== undefined && (typeOf(e) === "furnace" || typeOf(e) === "transport-belt")
    for (let e of entities) {
        if (typeOf(e) !== "inserter") {
            continue
        }
        let [dx, dy] = STEP[e.direction]
        let pick = at(e.x - dx, e.y - dy)
        let drop = at(e.x + dx, e.y + dy)
        if (!connectable(pick)) {
            errors.push(`${e.name} at (${e.x},${e.y}) has nothing to pick up from`)
        }
        if (!connectable(drop)) {
            errors.push(`${e.name} at (${e.x},${e.y}) has nothing to drop onto`)
        }
        if (connectable(pick) && connectable(drop) && typeOf(pick) === typeOf(drop)) {
            errors.push(`${e.name} at (${e.x},${e.y}) moves between two ${typeOf(pick)}s`)
        }
        if (drop && typeOf(drop) === "furnace") {
            feeders.set(drop, (feeders.get(drop) || 0) + 1)
        }
        if (pick && typeOf(pick) === "furnace") {
            takers.set(pick, (takers.get(pick) || 0) + 1)
        }
    }
    for (let e of entities) {
        if (typeOf(e) !== "furnace") {
            continue
        }
        if (!feeders.has(e)) {
            errors.push(`furnace at (${e.x},${e.y}) has no inserter feeding it`)
        }
        if (!takers.has(e)) {
            errors.push(`furnace at (${e.x},${e.y}) has no inserter emptying it`)
        }
    }

    // Power: every furnace and inserter must overlap a pole's supply area, and
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
        if ((typeOf(e) === "furnace" || typeOf(e) === "inserter") && !areas.some(a => covered(a, e))) {
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
