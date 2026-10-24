// Checks a layout, independently of how it was produced.

import {
    entityInfo, beltThroughput, inserterThroughput, machineCrafts, lookupRecipe,
    isMachineType, solidItems, allowedInserters, ALLOWED_LONG_INSERTERS, ALLOWED_POLES, NORTH, EAST, SOUTH, WEST, STEP,
    opposite, fluidInputPorts, fluidIngredients, insertRows, FLUID_MACHINES,
} from "./entities.js"

// Fluid flow a collector pipe is assumed to carry, per second. Long pipes carry
// about this much or more.
const PIPE_THROUGHPUT = 1000

// Why a recipe cannot be built in a column by the given machine, or null.
// maxSolids is how many solid ingredients the layout can bring: two on one
// belt, or more where there is a second belt.
export function ineligibleReason(data, recipeKey, machineName, maxSolids = 2) {
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
    if (recipe.results.some(i => !solids.has(i.name))) {
        return `${name} makes a fluid, which a column cannot carry away`
    }
    let fluids = fluidIngredients(data, recipe)
    let solidIngredients = recipe.ingredients.length - fluids.length
    if (fluids.length > 0) {
        if (!FLUID_MACHINES.includes(machineName)) {
            return `${name} uses a fluid, and ${machineName} is not set up for fluid input here (try a chemical plant)`
        }
        if (fluids.length > info.fluid_inputs.length) {
            return `${name} has ${fluids.length} fluid ingredients but ${machineName} has ${info.fluid_inputs.length} fluid inputs`
        }
    }
    if (solidIngredients > maxSolids) {
        return maxSolids === 2
            ? `${name} has ${solidIngredients} solid ingredients; a column can feed two on one belt`
            : `${name} has ${solidIngredients} solid ingredients; at most ${maxSolids} can be brought in`
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
    // Long-handed inserters take from the second belt of a line's final recipe.
    let inputKinds = params.longInput ? ALLOWED_LONG_INSERTERS : allowedInserters(data)
    if (okIi && !inputKinds.includes(params.inputInserter)) {
        errors.push(`inputInserter must be one of ${inputKinds.join(", ")}`)
    }
    if (okOi && !allowedInserters(data).includes(params.outputInserter)) {
        errors.push(`outputInserter must be one of ${allowedInserters(data).join(", ")}`)
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
    let fluids = fluidIngredients(data, recipe)
    let solidIngredients = recipe.ingredients.filter(i => !fluids.includes(i))
    // Fluid connections take up rows beside the machine which inserters could use.
    let ports = fluids.length === 0 ? [] : fluidInputPorts(machine, WEST).slice(0, fluids.length)
    let freeRows = insertRows(machine.width, new Set(ports.map(p => p.ty))).length
    for (let key of ["inputInserters"]) {
        if (params[key] > freeRows) {
            errors.push(`only ${freeRows} inserter(s) per machine fit beside its ${fluids.length} fluid connection(s)`)
        }
    }
    if (errors.length > 0) {
        return {errors, warnings, stats}
    }
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
    let perMachine = solidIngredients.map(i => i.amount * crafts * busy)
    let inPerMachine = perMachine.reduce((a, b) => a + b, 0)
    let outFlow = outPerMachine * busy
    stats.machineInput = inPerMachine
    stats.machineOutputFlow = outFlow

    // Belts. Each input belt serves one column. With two ingredients each
    // keeps to its own lane, so each gets half the belt.
    let perColumn = Math.ceil(params.machines / params.columns)
    let inCap = beltThroughput(data.blueprint_entities[params.inputBelt])
    let laneCap = solidIngredients.length === 2 ? inCap / 2 : inCap
    stats.inputBeltCapacity = inCap
    stats.inputBeltLoad = perColumn * inPerMachine
    solidIngredients.forEach((ing, i) => {
        let load = perColumn * perMachine[i]
        if (load > laneCap + 1e-9) {
            errors.push(`input belt (${params.inputBelt}) carries ${laneCap}/s of ${ing.name} (${solidIngredients.length === 2 ? "one lane" : "both lanes"}) but a column needs ${load.toFixed(2)}/s; more machines do not reduce this, only a faster belt or two columns do`)
        }
    })
    // Each fluid has one collector pipe per column.
    fluids.forEach(fluid => {
        let load = perColumn * fluid.amount * crafts * busy
        stats.fluidLoad = Math.max(stats.fluidLoad || 0, load)
        if (load > PIPE_THROUGHPUT) {
            errors.push(`${fluid.name} needs ${load.toFixed(0)}/s through one pipe per column, more than about ${PIPE_THROUGHPUT}/s a pipe carries; use two columns or fewer machines`)
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
    // A machine's flow scales with how busy it is, so more machines each carry
    // less. Say how many it would take with these inserters.
    let machinesFor = (capacity, fullFlow) => Math.ceil(requirement.rate * fullFlow / (capacity * outPerMachine) - 1e-9)
    let inFull = solidIngredients.reduce((sum, i) => sum + i.amount * crafts, 0)
    if (inIns < inPerMachine) {
        errors.push(`${params.inputInserters} ${params.inputInserter}(s) move about ${inIns.toFixed(2)}/s from a belt, but a machine takes in ${inPerMachine.toFixed(2)}/s; with these inserters at least ${machinesFor(inIns, inFull)} machines would each be busy few enough for them (or use ${params.inputInserters === 1 ? "two inserters, or " : ""}faster inserters)`)
    }
    if (outIns < outFlow) {
        errors.push(`${params.outputInserters} ${params.outputInserter}(s) move about ${outIns.toFixed(2)}/s, but a machine puts out ${outFlow.toFixed(2)}/s; with these inserters at least ${machinesFor(outIns, outPerMachine)} machines would be enough (or use ${params.outputInserters === 1 ? "two inserters, or " : ""}faster inserters)`)
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
        // A long-handed inserter picks up and drops two tiles away.
        let reach = entityInfo(data, e.name).pickup_distance || 1
        let pick = at(e.x + dx * reach, e.y + dy * reach)
        let drop = at(e.x - dx * reach, e.y - dy * reach)
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
    // Only a machine with something to bring on the belt needs an inserter.
    let needsFeeder = e => {
        if (!e.recipe) {
            return true
        }
        let recipe = lookupRecipe(data, e.recipe)
        return fluidIngredients(data, recipe).length < recipe.ingredients.length
    }
    for (let e of entities) {
        if (!isMachine(e)) {
            continue
        }
        if (needsFeeder(e) && !feeders.has(e)) {
            errors.push(`machine at (${e.x},${e.y}) has no inserter feeding it`)
        }
        if (!takers.has(e)) {
            errors.push(`machine at (${e.x},${e.y}) has no inserter emptying it`)
        }
    }

    // Fluids: a pipe connects to the tiles its openings face, an underground
    // pipe also to its partner along the tunnel. Every machine's fluid input
    // must reach a pipe, with one network per fluid in each column.
    let isPipe = e => e !== undefined && (typeOf(e) === "pipe" || typeOf(e) === "pipe-to-ground")
    let openings = e => typeOf(e) === "pipe" ? [NORTH, EAST, SOUTH, WEST] : [e.direction]
    let parent = new Map()
    for (let e of entities) {
        if (isPipe(e)) {
            parent.set(e, e)
        }
    }
    let find = e => {
        while (parent.get(e) !== e) {
            e = parent.get(e)
        }
        return e
    }
    let join = (a, b) => parent.set(find(a), find(b))
    for (let e of parent.keys()) {
        for (let d of openings(e)) {
            let [dx, dy] = STEP[d]
            let n = at(e.x + dx, e.y + dy)
            if (isPipe(n) && openings(n).includes(opposite(d))) {
                join(e, n)
            }
        }
        if (typeOf(e) === "pipe-to-ground") {
            let [dx, dy] = STEP[opposite(e.direction)]
            let reach = entityInfo(data, e.name).max_underground_distance
            let partner
            for (let k = 1; k <= reach && !partner; k++) {
                let n = at(e.x + dx * k, e.y + dy * k)
                if (n && typeOf(n) === "pipe-to-ground" && n.direction === opposite(e.direction)) {
                    partner = n
                }
            }
            if (partner) {
                join(e, partner)
            } else {
                errors.push(`${e.name} at (${e.x},${e.y}) has no partner to tunnel to`)
            }
        }
    }
    let networks = new Map()
    for (let m of entities) {
        if (!isMachine(m) || !m.recipe) {
            continue
        }
        let fluids = fluidIngredients(data, lookupRecipe(data, m.recipe))
        let ports = fluids.length === 0 ? [] : fluidInputPorts(entityInfo(data, m.name), m.direction || NORTH).slice(0, fluids.length)
        ports.forEach((port, k) => {
            let n = at(m.x + port.outX, m.y + port.outY)
            if (!isPipe(n) || !openings(n).includes(opposite(port.facing))) {
                errors.push(`machine at (${m.x},${m.y}): fluid input ${k + 1} (${fluids[k].name}) is not connected to a pipe`)
                return
            }
            if (!networks.has(m.x)) {
                networks.set(m.x, [new Set(), new Set()])
            }
            networks.get(m.x)[k].add(find(n))
        })
    }
    for (let [x, sets] of networks) {
        sets.forEach((set, k) => {
            if (set.size > 1) {
                errors.push(`fluid ${k + 1} of the machines at x=${x} is split across ${set.size} separate pipe networks`)
            }
        })
        if (sets[0].size === 1 && sets[1].size === 1 && [...sets[0]][0] === [...sets[1]][0]) {
            errors.push(`the two fluids of the machines at x=${x} share one pipe network`)
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
