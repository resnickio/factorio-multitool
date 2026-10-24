// Production lines: a final recipe (such as electronic circuits, or inserters)
// with up to two chains of producers feeding it, around a shared belt.
//
// The shared belt (MID) runs down the middle. The final recipe's machines stand
// on its west, below the producers. Each of its ingredients can come from a
// branch of up to two stages: the east branch's machines stand east of MID and
// fill its west lane, the west branch's stand west of MID and fill its east
// lane (inserters only drop on the far lane of a belt), so each ingredient
// keeps its own lane. A branch steps outward: each stage's output belt is the
// next stage's input belt, and the outermost stage takes its ingredients from a
// belt the player supplies. An ingredient with no branch arrives on a feeder
// belt which side-loads onto its lane at the top.
//
//   west branch                    east branch
//   ... | W2 | W1 | MID | E1 | E2 | ...     (stages stack downward, the
//                  |                          outermost first)
//                  v
//               | final recipe |  (below both branches, west of MID)
//
// A stage inside a branch may also take one more ingredient from outside: its
// feeder side-loads onto the lane of the stage's input belt which the stage
// beside it does not use.
//
// A final recipe with three or four solid ingredients has a second shared belt
// (MID2) right beside MID, which its long-handed inserters reach over MID to
// take from. The east branch then drops onto MID2 instead.
//
//   MID:  west lane <- feeder from the west   east lane <- west branch
//   MID2: west lane <- east branch            east lane <- feeder from the east
//
// Feeders for ingredients come in above the layout, each on a row of its own;
// a feeder aimed at a belt nearer the middle runs higher, so the belts of
// those further out are not in its way. Belts flow south, and inserters point
// at the tile they pick up from.

import {
    entityInfo, lookupRecipe, insertRows, fluidIngredients, beltThroughput, machineCrafts,
    ALLOWED_INSERTERS, ALLOWED_LONG_INSERTERS, NORTH, SOUTH, EAST, WEST,
} from "./entities.js"
import { validateParams, validateLayout, ineligibleReason } from "./validate.js"
import { defaultParams } from "./dsl.js"
import { makeBlueprint } from "./build.js"

// How much more than the required rate each stage is sized for.
const HEADROOM = 1.05
const BELTS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"]
const MAX_STAGES = 2
// Solid ingredients of the final recipe: two per belt.
const MAX_ROOT_SOLIDS = 4
const SIDES = ["east", "west"]
const LONG_INSERTER = ALLOWED_LONG_INSERTERS[0]

export function availableBelts(data) {
    return BELTS.filter(b => data.blueprint_entities[b])
}

// A copy of the data in which a recipe has only some of its ingredients, so
// the single-belt checks can be run for the ingredients on each belt.
function withIngredients(data, recipeKey, names) {
    return {
        ...data,
        recipes: data.recipes.map(r => r.key === recipeKey ? {...r, ingredients: r.ingredients.filter(i => names.includes(i.name))} : r),
    }
}

function cheapestBelt(data, rate) {
    let belts = availableBelts(data)
    return belts.find(b => beltThroughput(data.blueprint_entities[b]) >= rate) || belts.at(-1)
}

// What a line is made of:
//   spec = {root: {recipe, machine, rate}, east: [{recipe, machine}], west: [...]}
// The branches list their stages from the one beside the shared belt outward.
// rate is the final recipe's output in items per second.
//
// Returns the number of shared belts (m), for each side the stages with the
// rate each must deliver (and any ingredient it takes from a feeder), the
// ingredients of the final recipe which come on feeders (and from which side),
// and which ingredients are on the near belt and which on the far one.
export function resolveLine(spec, data) {
    let root = lookupRecipe(data, spec.root.recipe)
    let crafts = spec.root.rate / root.results[0].amount
    let m = root.ingredients.length > 2 ? 2 : 1
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
    let rest = root.ingredients.filter(i => i !== claimed.east && i !== claimed.west)
    let external = []
    if (m === 1) {
        // The east branch's lane is the west one, and the other way round.
        for (let side of SIDES) {
            if (!claimed[side] && rest.length > 0) {
                let ing = rest.shift()
                external.push({item: ing.name, rate: crafts * ing.amount, from: side === "east" ? "west" : "east"})
            }
        }
    } else {
        if (rest.length > 2) {
            throw new Error(`${root.localized_name.en} needs ${rest.length} ingredients from outside; at most 2 can be brought in`)
        }
        rest.forEach((ing, k) => external.push({item: ing.name, rate: crafts * ing.amount, from: k === 0 ? "west" : "east"}))
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
            let entry = {recipe: stage.recipe, machine: stage.machine, rate, other: null}
            if (j + 1 < spec[side].length) {
                // One ingredient comes from the stage beside this one; any other
                // arrives on a feeder.
                let nextProduct = lookupRecipe(data, spec[side][j + 1].recipe).results[0].name
                let linking = recipe.ingredients.find(i => i.name === nextProduct)
                if (!linking) {
                    throw new Error(`${recipe.localized_name.en} does not use ${nextProduct}`)
                }
                let stageCrafts = rate / recipe.results[0].amount
                let other = recipe.ingredients.find(i => i !== linking)
                if (other) {
                    entry.other = {item: other.name, rate: stageCrafts * other.amount}
                }
                rate = stageCrafts * linking.amount
            }
            stages[side].push(entry)
        })
    }

    // Which belt each of the final recipe's ingredients is on.
    let rootBelts = {near: [], far: []}
    if (m === 2) {
        if (claimed.west) {
            rootBelts.near.push(claimed.west.name)
        }
        if (claimed.east) {
            rootBelts.far.push(claimed.east.name)
        }
        for (let e of external) {
            (e.from === "west" ? rootBelts.near : rootBelts.far).push(e.item)
        }
    }
    return {
        m,
        root: {recipe: spec.root.recipe, machine: spec.root.machine, rate: spec.root.rate},
        stages, external, rootBelts,
    }
}

// Why this line cannot be built, or null.
export function lineIneligibleReason(spec, data) {
    for (let side of SIDES) {
        if (spec[side].length > MAX_STAGES) {
            return `a branch can have at most ${MAX_STAGES} stages`
        }
    }
    let resolved
    try {
        resolved = resolveLine(spec, data)
    } catch (e) {
        return e.message
    }
    let check = (recipeKey, machine, maxSolids) => {
        let reason = ineligibleReason(data, recipeKey, machine, maxSolids)
        if (reason) {
            return reason
        }
        if (fluidIngredients(data, lookupRecipe(data, recipeKey)).length > 0) {
            return `${lookupRecipe(data, recipeKey).localized_name.en} uses a fluid, which lines do not handle yet`
        }
        return null
    }
    let reason = check(spec.root.recipe, spec.root.machine, MAX_ROOT_SOLIDS)
    if (reason) {
        return reason
    }
    if (resolved.m === 2 && entityInfo(data, spec.root.machine).width < 3) {
        return `${spec.root.machine} is too small to have inserters for two belts`
    }
    for (let side of SIDES) {
        if (spec[side].length > MAX_STAGES) {
            return `a branch can have at most ${MAX_STAGES} stages`
        }
        for (let [j, stage] of spec[side].entries()) {
            reason = check(stage.recipe, stage.machine, 2)
            if (reason) {
                return reason
            }
        }
    }
    return null
}

// Parameters of one stage as the single-column code understands them.
function stageParams(params, side, j) {
    let branch = params[side]
    let stage = branch.stages[j]
    let last = branch.stages.length - 1
    // The stage beside the shared belt puts its output on it; for the east
    // branch of a line with a second belt, that is the second.
    let shared = side === "east" && params.mid2 ? params.mid2 : params.mid
    return {
        pipe: "pipe", pipeToGround: "pipe-to-ground", pole: params.pole, columns: 1,
        recipe: stage.recipe, machine: stage.machine, machines: stage.machines,
        inputBelt: j === last ? branch.supply : branch.belts[j],
        outputBelt: j === 0 ? shared : branch.belts[j - 1],
        inputInserter: stage.inputInserter, inputInserters: stage.inputInserters,
        outputInserter: stage.outputInserter, outputInserters: stage.outputInserters,
    }
}

// Errors for the final recipe's machines. With two belts the ingredients on
// each are checked on their own, the far ones with long-handed inserters.
function rootErrors(params, spec, resolved, data) {
    let root = params.root
    let requirement = {recipe: root.recipe, rate: spec.root.rate}
    let base = {
        pipe: "pipe", pipeToGround: "pipe-to-ground", pole: params.pole, columns: 1,
        recipe: root.recipe, machine: root.machine, machines: root.machines,
        outputBelt: root.outputBelt, outputInserter: root.outputInserter, outputInserters: root.outputInserters,
    }
    let errors = []
    let stats = null
    let run = (sp, d) => {
        let checked = validateParams(sp, requirement, d)
        errors.push(...checked.errors)
        stats = stats || checked.stats
    }
    if (resolved.m === 1) {
        run({...base, inputBelt: params.mid, inputInserter: root.inputInserter, inputInserters: root.inputInserters}, data)
    } else {
        let size = entityInfo(data, root.machine).width
        // One row beside each machine is kept for a pole.
        if (root.inputInserters + root.farInserters > size - 1) {
            errors.push(`${root.inputInserters + root.farInserters} input inserters do not fit beside a ${size}-tile machine with room for a pole`)
        }
        run({...base, inputBelt: params.mid, inputInserter: root.inputInserter, inputInserters: root.inputInserters},
            withIngredients(data, root.recipe, resolved.rootBelts.near))
        run({...base, inputBelt: params.mid2, inputInserter: root.farInserter, inputInserters: root.farInserters, longInput: true},
            withIngredients(data, root.recipe, resolved.rootBelts.far))
    }
    return {errors: [...new Set(errors)], stats}
}

// Params:
//   pole, mid, mid2 (only with a second belt)
//   root: {recipe, machine, machines, outputBelt, inputInserter, inputInserters,
//          farInserter, farInserters (with a second belt), outputInserter, outputInserters}
//   east, west: {stages: [{recipe, machine, machines, inputInserter, ..., outputInserters,
//                         feeder (belt for the stage's extra ingredient, if any)}],
//                belts: [the belt each stage takes from, but the outermost's],
//                supply: the outermost stage's input belt}
//   feeders: {west, east}: the belts bringing the final recipe's other ingredients
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
    let feeder = (label, tier, need) => {
        let info = data.blueprint_entities[tier]
        if (!info || info.type !== "transport-belt") {
            errors.push(`${label} feeder belt "${tier}" is not a known transport-belt`)
        } else if (need.rate > beltThroughput(info) + 1e-9) {
            errors.push(`the ${label} feeder belt (${tier}) carries ${beltThroughput(info)}/s of ${need.item}, but ${need.rate.toFixed(2)}/s is needed`)
        }
    }

    let root = rootErrors(params, spec, resolved, data)
    for (let e of root.errors) {
        errors.push(`final (${name(spec.root.recipe)}): ${e}`)
    }
    stats.root = root.stats
    if (resolved.m === 2 && !params.mid2) {
        errors.push("the final recipe needs a second shared belt")
    }
    for (let ext of resolved.external) {
        feeder(`${ext.from} (${ext.item})`, (params.feeders || {})[ext.from], ext)
    }
    for (let side of SIDES) {
        stats[side] = []
        resolved.stages[side].forEach((stage, j) => {
            let checked = validateParams(stageParams(params, side, j), {recipe: stage.recipe, rate: stage.rate}, data)
            for (let e of checked.errors) {
                errors.push(`${side} stage ${j + 1} (${name(stage.recipe)}): ${e}`)
            }
            warnings.push(...checked.warnings)
            stats[side].push(checked.stats)
            if (stage.other) {
                feeder(`${side} stage ${j + 1} (${stage.other.item})`, params[side].stages[j].feeder, stage.other)
            }
        })
    }
    return {errors, warnings, stats}
}

// Places one branch. sign is +1 for the east branch, -1 for the west;
// outBelt0 is the column of the belt its first stage puts output on. Feeder
// requests (for a stage's extra ingredient) are added to `requests`.
function placeBranch(add, requests, params, resolved, side, data, poleStep, outBelt0) {
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
    let outBelt = outBelt0
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
        // An extra ingredient arrives on the lane the next stage in does not use.
        let other = resolved.stages[side][j].other
        if (other) {
            requests.push({from: side, targetX: inBelt, topY: from, tier: stage.feeder, items: [other.item], belt: beltTier})
        }
        outBelt = inBelt
        supplyX = inBelt
    }
    // The outermost stage's supply arrives on a feeder at its first row.
    for (let k = 1; k <= 2; k++) {
        add(branch.supply, supplyX + sign * k, 0, sign > 0 ? WEST : EAST)
    }
    return {rows: y, feederEnd: supplyX + sign * 2, stage0Top: y0[0]}
}

function place(params, spec, data, poleStep) {
    let resolved = resolveLine(spec, data)
    let m = resolved.m
    let entities = []
    let add = (name, tx, ty, direction, extra) => {
        let info = entityInfo(data, name)
        entities.push({name, x: tx, y: ty, w: info.width, h: info.height, direction, ...extra})
    }
    let rows = {east: 0, west: 0}
    let stage0Top = {east: 0, west: 0}
    let inputs = []
    let requests = []
    for (let side of SIDES) {
        if (spec[side].length === 0) {
            continue
        }
        // With a second belt, the east branch puts its output on that.
        let placed = placeBranch(add, requests, params, resolved, side, data, poleStep, side === "east" ? m - 1 : 0)
        rows[side] = placed.rows
        stage0Top[side] = placed.stage0Top
        let outermost = resolved.stages[side].at(-1)
        inputs.push({x: placed.feederEnd, y: 0, items: lookupRecipe(data, outermost.recipe).ingredients.map(i => i.name)})
    }

    // The final recipe's machines, west of MID and below both branches.
    let root = params.root
    let size = entityInfo(data, root.machine).width
    let startY = Math.max(rows.east, rows.west) + (rows.west > 0 ? 1 : 0)
    let rootRows = root.machines * size
    let x = {inIns: -1, machine: -1 - size, outIns: -2 - size, outBelt: -3 - size}
    let isAssembler = entityInfo(data, root.machine).type === "assembling-machine"
    // With a second belt, one row stays free for a pole; the regular
    // inserters take the rows nearest the middle, the long-handed the next.
    let inRows = insertRows(size, new Set(m === 2 ? [size - 1] : []))
    let regularRows = inRows.slice(0, root.inputInserters)
    let farRows = m === 2 ? inRows.slice(root.inputInserters, root.inputInserters + root.farInserters) : []
    for (let i = 0; i < root.machines; i++) {
        let my = startY + i * size
        add(root.machine, x.machine, my, NORTH, isAssembler ? {recipe: root.recipe} : {})
        for (let row of regularRows) {
            add(root.inputInserter, x.inIns, my + row, EAST)
        }
        for (let row of farRows) {
            add(root.farInserter, x.inIns, my + row, EAST)
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

    // The final recipe's other ingredients come on feeders into the shared belts.
    let midTarget = {west: 0, east: m === 2 ? 1 : 0}
    for (let ext of resolved.external) {
        requests.push({from: ext.from, targetX: midTarget[ext.from], topY: null, tier: params.feeders[ext.from], items: [ext.item], belt: null})
    }

    // Each feeder gets a row above the layout, and a belt reaching up to it.
    // On each side, a feeder aimed nearer the middle runs higher.
    let extent = {
        east: Math.max(...entities.map(e => e.x + e.w - 1)) + 2,
        west: Math.min(...entities.map(e => e.x)) - 2,
    }
    let tops = {}
    for (let from of SIDES) {
        let list = requests.filter(r => r.from === from)
        list.sort((a, b) => from === "east" ? a.targetX - b.targetX : b.targetX - a.targetX)
        list.forEach((r, i) => {
            let row = -1 - 2 * (list.length - 1 - i)
            let dir = from === "east" ? WEST : EAST
            let step = from === "east" ? 1 : -1
            for (let tx = r.targetX + step; from === "east" ? tx <= extent.east : tx >= extent.west; tx += step) {
                add(r.tier, tx, row, dir)
            }
            inputs.push({x: from === "east" ? extent.east : extent.west, y: row, items: r.items})
            // The belt it joins must have one behind it, for the feeder to
            // side-load, and so reaches up to the row above.
            tops[r.targetX] = Math.min(tops[r.targetX] === undefined ? 0 : tops[r.targetX], row - 1)
            if (r.topY !== null) {
                for (let by = row - 1; by < r.topY; by++) {
                    add(r.belt, r.targetX, by, SOUTH)
                }
            }
        })
    }

    // The shared belts. MID starts above the feeders which join it; MID2, with
    // nothing to join it, where the east branch's first stage starts.
    let midTop = Math.min(0, tops[0] === undefined ? 0 : tops[0])
    for (let by = midTop; by < startY + rootRows; by++) {
        add(params.mid, 0, by, SOUTH)
    }
    if (m === 2) {
        let top = tops[1] !== undefined ? tops[1] : (spec.east.length > 0 ? stage0Top.east : startY)
        for (let by = top; by < startY + rootRows; by++) {
            add(params.mid2, 1, by, SOUTH)
        }
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

// The final recipe's machines and inserters, for given shared belt tiers, or
// null. Returns the first valid combination, cheapest first.
function searchRoot(spec, resolved, data, mid, mid2, factor) {
    let belts = availableBelts(data)
    let root = lookupRecipe(data, spec.root.recipe)
    let info = entityInfo(data, spec.root.machine)
    let outPer = root.results[0].amount * machineCrafts(info, root)
    let rate = spec.root.rate * factor
    let fewest = Math.ceil(rate / outPer - 1e-9)
    let outChoices = []
    for (let count of [1, 2]) {
        for (let name of ALLOWED_INSERTERS) {
            outChoices.push({name, count, cost: count * (1 + ALLOWED_INSERTERS.indexOf(name))})
        }
    }
    outChoices.sort((a, b) => a.cost - b.cost)
    let params = {pole: "medium-electric-pole", mid, mid2}
    for (let machines = fewest; machines <= fewest * 3 + 4; machines++) {
        for (let near = 1; near <= 2; near++) {
            for (let far = 0; far <= (resolved.m === 2 ? 2 : 0); far++) {
                if ((resolved.m === 2) !== (far > 0)) {
                    continue
                }
                for (let reg of ALLOWED_INSERTERS) {
                    for (let out of outChoices) {
                        for (let outputBelt of belts) {
                            let candidate = {
                                recipe: spec.root.recipe, machine: spec.root.machine, machines, outputBelt,
                                inputInserter: reg, inputInserters: near,
                                farInserter: LONG_INSERTER, farInserters: far,
                                outputInserter: out.name, outputInserters: out.count,
                            }
                            let errors = rootErrors({...params, root: candidate}, {...spec, root: {...spec.root, rate}}, resolved, data).errors
                            if (errors.length === 0) {
                                return candidate
                            }
                        }
                    }
                }
            }
        }
    }
    return null
}

// Picks the cheapest valid parameters, from the slowest shared belts up. Each
// stage is sized for a little more than needed where the belts allow.
export function defaultLineParams(spec, data) {
    let resolved = resolveLine(spec, data)
    let belts = availableBelts(data)
    let scaled = (req, factor) => ({recipe: req.recipe, rate: req.rate * factor})
    let stageOf = (p, feeder) => ({
        recipe: p.recipe, machine: p.machine, machines: p.machines,
        inputInserter: p.inputInserter, inputInserters: p.inputInserters,
        outputInserter: p.outputInserter, outputInserters: p.outputInserters,
        feeder: feeder || null,
    })
    // A branch's stages and the belts between them, for the belt its first
    // stage puts output on.
    let branchFor = (side, shared, factor) => {
        let stages = resolved.stages[side]
        if (stages.length === 0) {
            return {stages: [], belts: [], supply: belts[0]}
        }
        let feederOf = stage => stage.other ? cheapestBelt(data, stage.other.rate) : null
        let find = (stage, fixed) => defaultParams(scaled(stage, factor), stage.machine, data, {columns: 1, ...fixed})
        if (stages.length === 1) {
            let p = find(stages[0], {outputBelt: shared})
            return {stages: [stageOf(p, feederOf(stages[0]))], belts: [], supply: p.inputBelt}
        }
        // Two stages: they share one belt.
        let last = null
        for (let between of belts) {
            let inner = find(stages[0], {outputBelt: shared, inputBelt: between})
            let outer = find(stages[1], {outputBelt: between})
            last = {stages: [stageOf(inner, feederOf(stages[0])), stageOf(outer, feederOf(stages[1]))], belts: [between], supply: outer.inputBelt}
            let ok = [inner, outer].every((p, j) => validateParams({...p, recipe: stages[j].recipe, pole: "medium-electric-pole", pipe: "pipe", pipeToGround: "pipe-to-ground"}, stages[j], data).errors.length === 0)
            if (ok) {
                return last
            }
        }
        return last
    }
    let feeders = {west: null, east: null}
    for (let ext of resolved.external) {
        feeders[ext.from] = cheapestBelt(data, ext.rate)
    }
    let last = null
    for (let factor of [HEADROOM, 1]) {
        for (let mid of belts) {
            for (let mid2 of resolved.m === 2 ? belts : [null]) {
                let root = searchRoot(spec, resolved, data, mid, mid2, factor)
                if (!root) {
                    continue
                }
                last = {
                    pole: "medium-electric-pole", mid, mid2, root, feeders,
                    east: branchFor("east", mid2 || mid, factor),
                    west: branchFor("west", mid, factor),
                }
                if (validateLine(last, spec, data).errors.length === 0) {
                    return last
                }
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
