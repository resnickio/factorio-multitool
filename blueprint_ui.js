import { spec } from "./factory.js"
import { encodeBlueprint } from "./blueprint/codec.js"
import { defaultParams, buildSmeltingBlueprint } from "./blueprint/dsl.js"
import { previewLayout } from "./blueprint/build.js"
import { askForLayout } from "./blueprint/llm.js"
import { lookupRecipe } from "./blueprint/entities.js"

// The Blueprint tab: turns the smelting in the current solution into a
// blueprint string for the game.

const DEFAULT_MODEL = "claude-sonnet-5-5"

let selected = null
let useModel = false
// The key is kept only in this page, and never stored or put in the link.
let apiKey = ""
let model = DEFAULT_MODEL
let output = null
let busy = false

function deflate(bytes) {
    return pako.deflate(bytes, {level: 9})
}

// Smelting recipes in the current solution, with what a column must deliver.
function smeltingRequirements() {
    let result = []
    let data = spec.data
    if (!data || !data.blueprint_entities || !spec.lastTotals) {
        return result
    }
    for (let [recipe, rate] of spec.lastTotals.rates) {
        if (!recipe.categories || !recipe.categories.includes("smelting")) {
            continue
        }
        let building = spec.getBuilding(recipe)
        if (building === null) {
            continue
        }
        let info = data.blueprint_entities[building.key]
        let outItem = recipe.products[0].item
        result.push({
            recipe,
            building,
            electric: info !== undefined && info.type === "furnace",
            item: outItem,
            // Items per second the solution needs from this recipe.
            rate: rate.mul(recipe.gives(outItem)).toFloat(),
        })
    }
    return result
}

function copyText(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text)
    }
}

async function generate(req) {
    busy = true
    output = {pending: true}
    renderBlueprint()
    let requirement = {recipe: req.recipe.key, rate: req.rate}
    let furnace = req.building.key
    try {
        if (useModel) {
            if (apiKey === "") {
                throw new Error("Enter an API key, or choose to build without Claude.")
            }
            output = await askForLayout({apiKey, model, requirement, furnace, data: spec.data})
        } else {
            let params = defaultParams(requirement, furnace, spec.data)
            output = {...buildSmeltingBlueprint(params, requirement, spec.data), params, attempts: 0, log: []}
        }
    } catch (e) {
        output = {failed: e.message}
    }
    if (output.ok) {
        output.text = encodeBlueprint(output.blueprint, deflate)
        output.preview = previewLayout(output.entities, spec.data)
    }
    busy = false
    renderBlueprint()
}

function renderResult(root) {
    if (output === null) {
        return
    }
    let box = root.append("div")
        .classed("blueprint-result", true)
    if (output.pending) {
        box.append("div")
            .text(useModel ? "Asking Claude for a layout..." : "Building...")
        return
    }
    if (output.failed) {
        box.append("div")
            .classed("blueprint-error", true)
            .text(output.failed)
        return
    }
    if (output.params) {
        let p = output.params
        let attempts = output.attempts > 0 ? ` (accepted after ${output.attempts} ${output.attempts === 1 ? "attempt" : "attempts"})` : ""
        box.append("div")
            .text(`${p.furnaces} × ${p.furnace}, ${p.columns} ${p.columns === 1 ? "column" : "columns"}; input ${p.inputBelt} with ${p.inputInserter}; output ${p.outputBelt} with ${p.outputInserter}; ${p.pole}${output.ok ? attempts : ""}`)
        if (p.notes) {
            box.append("div")
                .classed("hint", true)
                .text(p.notes)
        }
    }
    if (!output.ok) {
        box.append("div")
            .classed("blueprint-error", true)
            .text("This layout was rejected, so no blueprint was made:")
        let list = box.append("ul")
        for (let e of output.errors) {
            list.append("li")
                .text(e)
        }
        renderLog(box)
        return
    }
    if (output.warnings.length > 0) {
        let list = box.append("ul")
        for (let w of output.warnings) {
            list.append("li")
                .text(w)
        }
    }
    let s = output.stats
    box.append("div")
        .classed("hint", true)
        .text(`Makes ${s.produced.toFixed(2)}/s of the ${s.needed.toFixed(2)}/s needed. Input belt ${s.inputBeltLoad.toFixed(1)}/${s.inputBeltCapacity}/s, output belt ${s.outputBeltLoad.toFixed(1)}/${s.outputBeltCapacity}/s. Modules and fuel are not included.`)
    box.append("pre")
        .classed("blueprint-preview", true)
        .text(output.preview)
    box.append("div")
        .classed("hint", true)
        .text("Belts flow down (v); ) and ( are inserters, F furnaces, P poles.")
    box.append("textarea")
        .classed("blueprint-text", true)
        .attr("readonly", true)
        .attr("rows", 4)
        .property("value", output.text)
        .on("focus", function() {
            this.select()
        })
    box.append("button")
        .text("Copy blueprint string")
        .on("click", () => copyText(output.text))
    box.append("span")
        .classed("hint", true)
        .text(" In the game, click the import-string button in the blueprint library and paste it.")
    renderLog(box)
}

function renderLog(box) {
    if (!output.log || output.log.length === 0) {
        return
    }
    let details = box.append("details")
    details.append("summary")
        .text("What Claude said")
    for (let entry of output.log) {
        details.append("pre")
            .classed("blueprint-log", true)
            .text(`Attempt ${entry.attempt}:\n${entry.reply}` + (entry.errors && entry.errors.length > 0 ? `\nRejected: ${entry.errors.join("; ")}` : ""))
    }
}

export function renderBlueprint() {
    let root = d3.select("#blueprint_content")
    root.selectAll("*").remove()
    if (!spec.data || !spec.data.blueprint_entities) {
        root.append("p")
            .text("Blueprints are not available for this data set. Choose Space Age 2.1.23.")
        return
    }
    let reqs = smeltingRequirements()
    if (reqs.length === 0) {
        root.append("p")
            .text("There is no smelting in the current factory. Add a target such as iron plate on the Factory tab.")
        return
    }
    root.append("p")
        .text("Smelting columns for the current factory. Pick one to turn into a blueprint.")

    let table = root.append("table")
        .classed("blueprint-list", true)
    for (let req of reqs) {
        let row = table.append("tr")
            .classed("selected", selected === req.recipe)
        row.append("td")
            .append(() => req.recipe.icon.make(32))
        row.append("td")
            .text(req.recipe.name)
        let furnaces = null
        let note = ""
        if (!req.electric) {
            note = `${req.building.name} burns fuel; choose electric furnaces under Settings to make a blueprint.`
        } else {
            let recipe = lookupRecipe(spec.data, req.recipe.key)
            let per = spec.data.blueprint_entities[req.building.key].crafting_speed / recipe.energy_required * recipe.results[0].amount
            furnaces = Math.ceil(req.rate / per - 1e-9)
            note = `${req.rate.toFixed(2)}/s needs ${furnaces} × ${req.building.name}`
        }
        row.append("td")
            .text(note)
        let cell = row.append("td")
        if (req.electric) {
            cell.append("button")
                .text("Choose")
                .on("click", () => {
                    selected = req.recipe
                    output = null
                    renderBlueprint()
                })
        }
    }

    let req = reqs.find(r => r.recipe === selected && r.electric)
    if (!req) {
        return
    }
    let panel = root.append("div")
        .classed("blueprint-panel", true)
    panel.append("h3")
        .text(`Blueprint for ${req.recipe.name}`)
    let modes = panel.append("div")
    for (let [value, text] of [[false, "Build without Claude (cheapest parts that carry the load)"], [true, "Ask Claude to choose the parts"]]) {
        let label = modes.append("label")
            .style("display", "block")
        label.append("input")
            .attr("type", "radio")
            .attr("name", "blueprint_mode")
            .property("checked", useModel === value)
            .on("change", () => {
                useModel = value
                renderBlueprint()
            })
        label.append("span")
            .text(" " + text)
    }
    if (useModel) {
        let box = panel.append("div")
            .classed("blueprint-api", true)
        box.append("div")
            .classed("hint", true)
            .text("Your key stays in this page. The request goes directly from your browser to api.anthropic.com and contains the factory's numbers; nothing is saved.")
        box.append("input")
            .attr("type", "password")
            .attr("placeholder", "Anthropic API key")
            .attr("autocomplete", "off")
            .property("value", apiKey)
            .on("input", function() {
                apiKey = this.value
            })
        box.append("input")
            .attr("type", "text")
            .attr("placeholder", "Model")
            .property("value", model)
            .on("input", function() {
                model = this.value
            })
    }
    panel.append("button")
        .property("disabled", busy)
        .text("Generate")
        .on("click", () => generate(req))
    renderResult(panel)
}
