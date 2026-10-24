// What a model is told about a production line, and how its reply is read.
// The calculator supplies the numbers; the model picks machine counts, belts,
// inserters and poles, and is told why a layout is rejected until one works.

import {
    entityInfo, lookupRecipe, beltThroughput, machineCrafts, inserterThroughput,
    ALLOWED_INSERTERS, ALLOWED_LONG_INSERTERS, ALLOWED_POLES,
} from "./entities.js"
import { resolveLine, availableBelts } from "./line.js"

const SIDES = ["east", "west"]
const LONG_INSERTER = ALLOWED_LONG_INSERTERS[0]

export function describeLineTask(spec, data) {
    let resolved = resolveLine(spec, data)
    let machineInfo = (recipeKey, machine, rate) => {
        let recipe = lookupRecipe(data, recipeKey)
        let crafts = machineCrafts(entityInfo(data, machine), recipe)
        let outPer = recipe.results[0].amount * crafts
        return {
            recipe: recipeKey,
            machine,
            ingredients: recipe.ingredients.map(i => ({item: i.name, per_second_at_full_speed: Number((i.amount * crafts).toFixed(4))})),
            output_item: recipe.results[0].name,
            required_output_per_second: Number(rate.toFixed(4)),
            output_per_second_at_full_speed: Number(outPer.toFixed(4)),
            fewest_machines: Math.ceil(rate / outPer - 1e-9),
        }
    }
    let rootRecipe = lookupRecipe(data, spec.root.recipe)
    let crafts = spec.root.rate / rootRecipe.results[0].amount
    let load = item => Number((crafts * rootRecipe.ingredients.find(i => i.name === item).amount).toFixed(4))
    let task = {
        task: "line",
        final: machineInfo(spec.root.recipe, spec.root.machine, spec.root.rate),
        shared_belts: resolved.m === 1
            ? {second_belt: false, mid_items: rootRecipe.ingredients.map(i => ({item: i.name, per_second: load(i.name)}))}
            : {
                second_belt: true,
                mid_items: resolved.rootBelts.near.map(item => ({item, per_second: load(item)})),
                mid2_items: resolved.rootBelts.far.map(item => ({item, per_second: load(item)})),
            },
        feeders: {},
        east: [],
        west: [],
        options: {
            belts: availableBelts(data).map(b => ({name: b, items_per_second: beltThroughput(data.blueprint_entities[b])})),
            inserters: ALLOWED_INSERTERS.map(n => ({
                name: n,
                from_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], true).toFixed(2)),
                to_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], false).toFixed(2)),
            })),
            long_handed_inserter: {
                name: LONG_INSERTER,
                from_belt_per_second: Number(inserterThroughput(data.blueprint_entities[LONG_INSERTER], true).toFixed(2)),
            },
            inserters_per_machine: [1, 2],
            poles: ALLOWED_POLES,
        },
    }
    for (let ext of resolved.external) {
        task.feeders[ext.from] = {item: ext.item, per_second: Number(ext.rate.toFixed(4))}
    }
    for (let side of SIDES) {
        resolved.stages[side].forEach((stage, j) => {
            let info = machineInfo(stage.recipe, stage.machine, stage.rate)
            info.extra_ingredient_from_feeder = stage.other ? {item: stage.other.item, per_second: Number(stage.other.rate.toFixed(4))} : null
            info.position = j === 0 ? "beside the shared belt" : "outermost, fed from the supply belt"
            task[side].push(info)
        })
    }
    return task
}

export const LINE_SYSTEM_PROMPT = `You design a production line for Factorio. You are given a task as JSON: a "final" recipe whose machines stand beside shared belts, and up to two branches, "east" and "west", each a list of one or two stages of machines that make an ingredient of the final recipe. A branch's stages are listed from the one beside the shared belt outward; the first stage puts its output on the shared belt, and each further stage puts its output on the belt the stage before it takes from. The outermost stage takes its ingredients from a supply belt. A stage with an extra_ingredient_from_feeder gets that ingredient from a feeder belt of its own. Ingredients of the final recipe which no branch makes arrive on the feeders listed in "feeders". Every belt has two lanes and inserters only drop onto the far lane of a belt, so a column's output uses one lane: its output belt carries only half its listed rate. An ingredient which is a fluid (such as petroleum gas) arrives by pipe, not on a belt, so leave it out when sizing belts and input inserters. Reply with a single JSON object and nothing else, with exactly these keys:
- "mid_belt": the first shared belt, from options.belts. Each lane carries at most half its rate; the ingredients listed in shared_belts.mid_items each keep to a lane.
- "mid2_belt": only when shared_belts.second_belt is true, the second shared belt, likewise for mid2_items.
- "pole": a pole name from options.poles.
- "feeder_belts": an object with a belt name from options.belts for each key of "feeders", sized for that feeder's per_second on both lanes.
- "final": an object with "machines" (integer, at least fewest_machines), "output_belt" (a belt), "input_inserter" and "output_inserter" (names from options.inserters), "input_inserter_count" (1 or 2 per machine, for the first shared belt), "output_inserter_count" (1 or 2) and, only when there is a second shared belt, "far_input_inserter_count" (1 or 2; long-handed inserters reaching the second belt over the first).
- "east" and "west": for each branch that has stages, an object with "stages" (a list in the same order, each with "machines" (at least fewest_machines), "input_inserter", "output_inserter" (names from options.inserters), "input_inserter_count", "output_inserter_count" (1 or 2) and, for a stage with an extra_ingredient_from_feeder, "feeder_belt" (a belt)), "supply_belt" (the belt the outermost stage takes its ingredients from) and, for a branch of two stages, "belt_between" (the belt between them).
- "notes": one short sentence on your choices.
Machines only work as much as is needed, so extra machines each work less, which lowers the load on every inserter and belt; a machine costs far more than an inserter, so first fix a shortfall in inserter speed with a second inserter on that side or a fast-inserter, and add machines beyond the fewest only if that is still not enough. If you are told how many machines would be enough, use at least that many. A stage's flow is scaled by how busy its machines are: required_output_per_second / (machines x output_per_second_at_full_speed). An input inserter must move the sum of the machine's ingredient rates (scaled by how busy it is) taken from the belt; an output inserter must move the output rate; their rates are in options.inserters. Prefer the cheapest belts and inserters that are sufficient. Choose only from the listed options. A layout that cannot carry its load will be rejected, and you will be told why.`

// Reads a model's reply into line parameters. The recipes and machines are
// fixed by the task, so the model cannot change them.
export function parseLineReply(text, spec, data) {
    let start = text.indexOf("{")
    let end = text.lastIndexOf("}")
    if (start === -1 || end === -1) {
        throw new Error("the reply contained no JSON object")
    }
    let reply = JSON.parse(text.slice(start, end + 1))
    let resolved = resolveLine(spec, data)
    let stageOf = (fixed, given) => ({
        recipe: fixed.recipe, machine: fixed.machine, machines: given.machines,
        inputInserter: given.input_inserter, inputInserters: given.input_inserter_count,
        outputInserter: given.output_inserter, outputInserters: given.output_inserter_count,
        feeder: given.feeder_belt || null,
    })
    let branch = side => {
        let given = reply[side] || {}
        let stages = resolved.stages[side].map((fixed, j) => stageOf(fixed, (given.stages || [])[j] || {}))
        return {stages, belts: given.belt_between ? [given.belt_between] : [], supply: given.supply_belt}
    }
    let root = reply.final || {}
    return {
        pole: reply.pole,
        mid: reply.mid_belt,
        mid2: resolved.m === 2 ? reply.mid2_belt : null,
        feeders: {west: (reply.feeder_belts || {}).west || null, east: (reply.feeder_belts || {}).east || null},
        notes: reply.notes,
        root: {
            recipe: spec.root.recipe, machine: spec.root.machine, machines: root.machines, outputBelt: root.output_belt,
            inputInserter: root.input_inserter, inputInserters: root.input_inserter_count,
            farInserter: LONG_INSERTER, farInserters: resolved.m === 2 ? root.far_input_inserter_count : 0,
            outputInserter: root.output_inserter, outputInserters: root.output_inserter_count,
        },
        east: branch("east"),
        west: branch("west"),
    }
}
