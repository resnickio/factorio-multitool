// The layout description which the language model fills in, the fallback
// which picks one without it, and the pipeline that checks and places it.

import { placeSmeltingColumns } from "./smelting.js"
import { validateParams, validateLayout } from "./validate.js"
import { makeBlueprint } from "./build.js"
import {
    entityInfo, beltThroughput, inserterThroughput, furnaceCrafts, lookupRecipe,
    ALLOWED_INSERTERS, ALLOWED_POLES,
} from "./entities.js"

const BELTS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"]

// What the model is told. The calculator supplies the numbers; the model picks
// the parameters from fixed lists.
export function describeTask(requirement, furnace, data) {
    let recipe = lookupRecipe(data, requirement.recipe)
    let info = entityInfo(data, furnace)
    let crafts = furnaceCrafts(info, recipe)
    let inPer = recipe.ingredients[0].amount * crafts
    let outPer = recipe.results[0].amount * crafts
    return {
        task: "smelting_column",
        recipe: requirement.recipe,
        input_item: recipe.ingredients[0].name,
        output_item: recipe.results[0].name,
        required_output_per_second: Number(requirement.rate.toFixed(4)),
        furnace,
        per_furnace: {input_per_second: Number(inPer.toFixed(4)), output_per_second: Number(outPer.toFixed(4))},
        fewest_furnaces: Math.ceil(requirement.rate / outPer - 1e-9),
        options: {
            columns: [1, 2],
            belts: BELTS.filter(b => data.blueprint_entities[b]).map(b => ({name: b, items_per_second: beltThroughput(data.blueprint_entities[b])})),
            inserters: ALLOWED_INSERTERS.map(n => ({
                name: n,
                from_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], true).toFixed(2)),
                to_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], false).toFixed(2)),
            })),
            poles: ALLOWED_POLES,
        },
    }
}

export const SYSTEM_PROMPT = `You design smelting columns for Factorio. You are given a task as JSON. Reply with a single JSON object and nothing else, with exactly these keys:
- "furnaces": integer, how many furnaces (at least fewest_furnaces; a few spare is fine, many is wasteful)
- "columns": 1 or 2. Two columns share the middle output belt and each have their own input belt, which halves the load on an input belt.
- "input_belt", "output_belt": belt names from options.belts. A belt must carry the load on it: one input belt carries (furnaces / columns, rounded up) times per_furnace.input_per_second; the output belt carries the whole production. Prefer the cheapest belt that is sufficient.
- "input_inserter", "output_inserter": inserter names from options.inserters. An inserter must move at least per_furnace.input_per_second from a belt (input) or per_furnace.output_per_second (output). Prefer the cheapest sufficient inserter.
- "pole": a pole name from options.poles.
- "notes": one short sentence on your choices.
Choose only from the listed options. A layout that cannot carry its load will be rejected, and you will be told why.`

// Extracts the JSON object from a model reply.
export function parseReply(text) {
    let start = text.indexOf("{")
    let end = text.lastIndexOf("}")
    if (start === -1 || end === -1) {
        throw new Error("the reply contained no JSON object")
    }
    let reply = JSON.parse(text.slice(start, end + 1))
    return {
        furnaces: reply.furnaces,
        columns: reply.columns,
        inputBelt: reply.input_belt,
        outputBelt: reply.output_belt,
        inputInserter: reply.input_inserter,
        outputInserter: reply.output_inserter,
        pole: reply.pole,
        notes: reply.notes,
    }
}

// Picks the cheapest sufficient parameters without a model: the fewest
// furnaces, the slowest belts and inserters which carry the load, and one
// column unless the input belt would not cope.
export function defaultParams(requirement, furnace, data) {
    let task = describeTask(requirement, furnace, data)
    let furnaces = task.fewest_furnaces
    let columns = 1
    let belts = task.options.belts
    let inNeed = (cols) => Math.ceil(furnaces / cols) * task.per_furnace.input_per_second
    let beltFor = need => belts.find(b => b.items_per_second >= need)
    if (!beltFor(inNeed(1))) {
        columns = 2
    }
    let inputBelt = beltFor(inNeed(columns)) || belts[belts.length - 1]
    let outputBelt = beltFor(furnaces * task.per_furnace.output_per_second) || belts[belts.length - 1]
    let ins = task.options.inserters
    let inputInserter = ins.find(i => i.from_belt_per_second >= task.per_furnace.input_per_second) || ins[ins.length - 1]
    let outputInserter = ins.find(i => i.to_belt_per_second >= task.per_furnace.output_per_second) || ins[ins.length - 1]
    return {
        furnace,
        furnaces,
        columns,
        inputBelt: inputBelt.name,
        outputBelt: outputBelt.name,
        inputInserter: inputInserter.name,
        outputInserter: outputInserter.name,
        pole: "medium-electric-pole",
    }
}

// Validates, places and re-validates. Returns {ok, errors, warnings, stats,
// entities, blueprint}.
export function buildSmeltingBlueprint(params, requirement, data) {
    params = {...params, furnace: params.furnace}
    let checked = validateParams(params, requirement, data)
    if (checked.errors.length > 0) {
        return {ok: false, errors: checked.errors, warnings: checked.warnings, stats: checked.stats}
    }
    let placed = placeSmeltingColumns(params, data)
    let layout = validateLayout(placed.entities, data)
    if (layout.errors.length > 0) {
        return {ok: false, errors: layout.errors, warnings: checked.warnings, stats: checked.stats, entities: placed.entities}
    }
    let recipe = lookupRecipe(data, requirement.recipe)
    let label = `${params.furnaces}x ${params.furnace}: ${recipe.localized_name.en}`
    let blueprint = makeBlueprint(placed.entities, label, [params.furnace, recipe.results[0].name])
    return {ok: true, errors: [], warnings: checked.warnings, stats: checked.stats, entities: placed.entities, blueprint}
}
