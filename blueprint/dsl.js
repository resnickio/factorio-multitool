// The layout description which the language model fills in, the fallback
// which picks one without it, and the pipeline that checks and places it.

import { placeColumns } from "./columns.js"
import { validateParams, validateLayout, ineligibleReason } from "./validate.js"
import { makeBlueprint } from "./build.js"
import {
    entityInfo, beltThroughput, inserterThroughput, machineCrafts, lookupRecipe,
    fluidIngredients, fluidInputPorts, insertRows, WEST, ALLOWED_INSERTERS, ALLOWED_POLES,
} from "./entities.js"

export { ineligibleReason }

const BELTS = ["transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"]

function availableBelts(data) {
    return BELTS.filter(b => data.blueprint_entities[b])
}

// What the model is told. The calculator supplies the numbers; the model picks
// the parameters from fixed lists.
export function describeTask(requirement, machine, data) {
    let recipe = lookupRecipe(data, requirement.recipe)
    let info = entityInfo(data, machine)
    let crafts = machineCrafts(info, recipe)
    let outPer = recipe.results[0].amount * crafts
    let fluids = fluidIngredients(data, recipe)
    let ports = fluids.length === 0 ? [] : fluidInputPorts(info, WEST).slice(0, fluids.length)
    return {
        task: "machine_column",
        recipe: requirement.recipe,
        ingredients: recipe.ingredients.map(i => ({
            item: i.name,
            ...(fluids.includes(i) ? {fluid: true} : {}),
            per_second_at_full_speed: Number((i.amount * crafts).toFixed(4)),
        })),
        max_input_inserters_per_machine: Math.min(2, insertRows(info.width, new Set(ports.map(p => p.ty))).length),
        output_item: recipe.results[0].name,
        required_output_per_second: Number(requirement.rate.toFixed(4)),
        machine,
        output_per_second_at_full_speed: Number(outPer.toFixed(4)),
        fewest_machines: Math.ceil(requirement.rate / outPer - 1e-9),
        options: {
            columns: [1, 2],
            belts: availableBelts(data).map(b => ({name: b, items_per_second: beltThroughput(data.blueprint_entities[b])})),
            inserters: ALLOWED_INSERTERS.map(n => ({
                name: n,
                from_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], true).toFixed(2)),
                to_belt_per_second: Number(inserterThroughput(data.blueprint_entities[n], false).toFixed(2)),
            })),
            inserters_per_machine: [1, 2],
            poles: ALLOWED_POLES,
        },
    }
}

export const SYSTEM_PROMPT = `You design columns of crafting machines for Factorio. You are given a task as JSON. Reply with a single JSON object and nothing else, with exactly these keys:
- "machines": integer, how many machines (at least fewest_machines). Machines only work as much as is needed, so extra machines each work less, which lowers the load on every inserter and belt; use more when the inserters would otherwise be too slow, but not wastefully many.
- "columns": 1 or 2. Two columns share the middle output belt and each have their own input belt, which halves the load on an input belt.
Fluid ingredients (marked "fluid": true) arrive by pipe: they use no belt lane and no inserter, and their flow is not limited by anything you choose here. If every ingredient is a fluid, the input belt and input inserters are not built, so their choices do not matter (give any valid ones). Fluid connections take up rows beside each machine, so max_input_inserters_per_machine may be 1.
- "input_belt", "output_belt": belt names from options.belts, whose rates are for both lanes. With two ingredients, each is kept to its own lane of the input belt, so each can use only half the belt's rate; with one ingredient it can use both lanes. One input belt serves one column: it carries (machines / columns, rounded up) times each ingredient's rate per machine, scaled by how busy the machines are (required_output / (machines x output_per_second_at_full_speed)). The output belt carries the whole required output, but inserters only drop onto the far lane of a belt: with one column all output goes onto one lane, so the output belt carries only half its listed rate; with two columns it carries the full rate. Prefer the cheapest belt that is sufficient.
- "input_inserter", "output_inserter": inserter names from options.inserters.
- "input_inserter_count", "output_inserter_count": 1 or 2 inserters per machine on each side (the input count at most max_input_inserters_per_machine). All of a machine's ingredients arrive through its input inserters together, so they must move the sum of the ingredient rates (scaled by how busy the machine is); the output inserters must move the output rate. Prefer fewer and cheaper inserters that are sufficient.
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
        machines: reply.machines,
        columns: reply.columns,
        inputBelt: reply.input_belt,
        outputBelt: reply.output_belt,
        inputInserter: reply.input_inserter,
        outputInserter: reply.output_inserter,
        inputInserters: reply.input_inserter_count,
        outputInserters: reply.output_inserter_count,
        pole: reply.pole,
        notes: reply.notes,
    }
}

// Picks parameters without a model: the fewest machines which a cheap set of
// belts and inserters can serve, one column unless two are needed. Extra
// machines run less busy, which eases the inserters, so when nothing works at
// the fewest, more are tried. Returns the cheapest valid parameters found, or
// the most capable ones if none are valid. `fixed` pins some choices (columns,
// inputBelt, outputBelt), for layouts which share belts.
export function defaultParams(requirement, machine, data, fixed = {}) {
    let recipe = lookupRecipe(data, requirement.recipe)
    let outPer = recipe.results[0].amount * machineCrafts(entityInfo(data, machine), recipe)
    let fewest = Math.ceil(requirement.rate / outPer - 1e-9)
    let belts = availableBelts(data)
    let inserterChoices = []
    for (let count of [1, 2]) {
        for (let name of ALLOWED_INSERTERS) {
            inserterChoices.push({name, count, cost: count * (1 + ALLOWED_INSERTERS.indexOf(name))})
        }
    }
    inserterChoices.sort((a, b) => a.cost - b.cost)
    let base = {machine, recipe: requirement.recipe, pole: "medium-electric-pole", pipe: "pipe", pipeToGround: "pipe-to-ground"}
    for (let machines = fewest; machines <= fewest * 3 + 4; machines++) {
        for (let columns of fixed.columns ? [fixed.columns] : [1, 2]) {
            for (let input of inserterChoices) {
                for (let output of inserterChoices) {
                    for (let inputBelt of fixed.inputBelt ? [fixed.inputBelt] : belts) {
                        for (let outputBelt of fixed.outputBelt ? [fixed.outputBelt] : belts) {
                            let params = {
                                ...base, machines, columns, inputBelt, outputBelt,
                                inputInserter: input.name, inputInserters: input.count,
                                outputInserter: output.name, outputInserters: output.count,
                            }
                            if (validateParams(params, requirement, data).errors.length === 0) {
                                return params
                            }
                        }
                    }
                }
            }
        }
    }
    return {
        ...base, machines: fewest, columns: 2,
        inputBelt: belts[belts.length - 1], outputBelt: belts[belts.length - 1],
        inputInserter: ALLOWED_INSERTERS[ALLOWED_INSERTERS.length - 1], inputInserters: 2,
        outputInserter: ALLOWED_INSERTERS[ALLOWED_INSERTERS.length - 1], outputInserters: 2,
    }
}

// Validates, places and re-validates. Returns {ok, errors, warnings, stats,
// entities, blueprint}.
export function buildColumnBlueprint(params, requirement, data) {
    params = {pipe: "pipe", pipeToGround: "pipe-to-ground", ...params, recipe: requirement.recipe}
    let checked = validateParams(params, requirement, data)
    if (checked.errors.length > 0) {
        return {ok: false, errors: checked.errors, warnings: checked.warnings, stats: checked.stats}
    }
    let placed = placeColumns(params, data)
    let layout = validateLayout(placed.entities, data)
    if (layout.errors.length > 0) {
        return {ok: false, errors: layout.errors, warnings: checked.warnings, stats: checked.stats, entities: placed.entities}
    }
    let recipe = lookupRecipe(data, requirement.recipe)
    let label = `${params.machines}x ${params.machine}: ${recipe.localized_name.en}`
    let blueprint = makeBlueprint(placed.entities, label, [params.machine, recipe.results[0].name], data)
    return {ok: true, errors: [], warnings: checked.warnings, stats: checked.stats, entities: placed.entities, connections: placed.connections, blueprint}
}
