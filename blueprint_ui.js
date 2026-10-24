import { spec } from "./factory.js"
import { encodeBlueprint } from "./blueprint/codec.js"
import { defaultParams, buildColumnBlueprint, ineligibleReason } from "./blueprint/dsl.js"
import { previewLayout } from "./blueprint/build.js"
import { askForLayout, OLLAMA_URL } from "./blueprint/llm.js"
import { entityInfo, lookupRecipe, machineCrafts } from "./blueprint/entities.js"
import { chainIneligibleReason, defaultChainParams, buildChainBlueprint } from "./blueprint/chain.js"
import { renderPreview } from "./blueprint_preview.js"

// The Blueprint tab: turns the furnace and assembler rows in the current
// solution into blueprint strings for the game, singly or as chains.

const DEFAULT_MODELS = {anthropic: "claude-sonnet-5-5", ollama: "qwen3.8:latest"}

let selected = null
// A chain of two rows, by recipe key: {up, down}.
let selectedChain = null
// "none" (build with the cheapest parts which work), "anthropic" or "ollama".
let provider = "none"
// The key is kept only in this page, and never stored or put in the link.
let apiKey = ""
let models = {...DEFAULT_MODELS}
let ollamaUrl = OLLAMA_URL
let output = null
let busy = false

function deflate(bytes) {
    return pako.deflate(bytes, {level: 9})
}

// Crafting recipes in the current solution, with what a column must deliver
// and, if a column cannot be built for it, why not.
function columnRequirements() {
    let result = []
    let data = spec.data
    if (!data || !data.blueprint_entities || !spec.lastTotals) {
        return result
    }
    let dataRecipes = new Set(data.recipes.map(r => r.key))
    for (let [recipe, rate] of spec.lastTotals.rates) {
        if (!dataRecipes.has(recipe.key)) {
            continue
        }
        let building = spec.getBuilding(recipe)
        if (building === null) {
            continue
        }
        let outItem = recipe.products[0].item
        let reason = ineligibleReason(data, recipe.key, building.key)
        result.push({
            recipe,
            building,
            reason,
            // Items per second the solution needs from this recipe.
            rate: rate.mul(recipe.gives(outItem)).toFloat(),
        })
    }
    return result
}

// Pairs of rows where one makes an ingredient of the other, with whether a
// chain of them can be built.
function chainRequirements(reqs) {
    let chains = []
    for (let down of reqs) {
        for (let up of reqs) {
            if (up === down || !down.recipe.ingredients.some(i => i.item === up.recipe.products[0].item)) {
                continue
            }
            let reason = chainIneligibleReason(
                {recipe: down.recipe.key, rate: down.rate, upstream: up.recipe.key},
                {upstream: up.building.key, downstream: down.building.key},
                spec.data,
            )
            chains.push({up, down, reason})
        }
    }
    return chains
}

function isSelectedChain(chain) {
    return selectedChain !== null && selectedChain.up === chain.up.recipe.key && selectedChain.down === chain.down.recipe.key
}

async function generateChain(chain) {
    busy = true
    output = {pending: true}
    renderBlueprint()
    let requirement = {recipe: chain.down.recipe.key, rate: chain.down.rate, upstream: chain.up.recipe.key}
    let machines = {upstream: chain.up.building.key, downstream: chain.down.building.key}
    try {
        let params = defaultChainParams(requirement, machines, spec.data)
        output = {...buildChainBlueprint(params, requirement, spec.data), chain: params}
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

// How many machines the solution calls for, without modules.
function machinesNeeded(req) {
    let recipe = lookupRecipe(spec.data, req.recipe.key)
    let per = machineCrafts(entityInfo(spec.data, req.building.key), recipe) * recipe.results[0].amount
    return Math.ceil(req.rate / per - 1e-9)
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
    let machine = req.building.key
    try {
        if (provider === "anthropic") {
            if (apiKey === "") {
                throw new Error("Enter an API key, or choose another way to build.")
            }
            output = await askForLayout({provider, apiKey, model: models.anthropic, requirement, machine, data: spec.data})
        } else if (provider === "ollama") {
            // A local model costs nothing to ask again, so give it more tries.
            output = await askForLayout({provider, baseUrl: ollamaUrl, model: models.ollama, maxAttempts: 6, requirement, machine, data: spec.data})
        } else {
            let params = defaultParams(requirement, machine, spec.data)
            output = {...buildColumnBlueprint(params, requirement, spec.data), params, attempts: 0, log: []}
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
            .text(provider === "anthropic" ? "Asking Claude for a layout..." : provider === "ollama" ? "Asking the local model for a layout..." : "Building...")
        return
    }
    if (output.failed) {
        box.append("div")
            .classed("blueprint-error", true)
            .text(output.failed)
        return
    }
    if (output.chain) {
        renderChainResult(box)
        return
    }
    if (output.params) {
        let p = output.params
        let attempts = output.attempts > 0 ? ` (accepted after ${output.attempts} ${output.attempts === 1 ? "attempt" : "attempts"})` : ""
        box.append("div")
            .text(`${p.machines} × ${p.machine}, ${p.columns} ${p.columns === 1 ? "column" : "columns"}; input ${p.inputBelt} with ${p.inputInserters} ${p.inputInserter}; output ${p.outputBelt} with ${p.outputInserters} ${p.outputInserter}; ${p.pole}${output.ok ? attempts : ""}`)
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
        .text(`Makes ${s.produced.toFixed(2)}/s of the ${s.needed.toFixed(2)}/s needed. Input belt ${s.inputBeltLoad.toFixed(1)}/${s.inputBeltCapacity}/s, output belt ${s.outputBeltLoad.toFixed(1)}/${s.outputBeltCapacity}/s. Modules are not included.`)
    if (selected) {
        let solids = selected.ingredients.filter(i => i.item.phase !== "fluid")
        let fluids = selected.ingredients.filter(i => i.item.phase === "fluid")
        if (solids.length === 2) {
            box.append("div")
                .classed("hint", true)
                .text(`Feed ${solids[0].item.name} on one lane of the input belt and ${solids[1].item.name} on the other.`)
        }
        if (fluids.length > 0) {
            let names = fluids.map(f => f.item.name)
            let where = names.length === 1
                ? `Connect ${names[0]} to the top of the vertical pipe beside the input belt.`
                : `Connect ${names[0]} to the top of the vertical pipe nearest the input belt, and ${names[1]} to the next one out.`
            box.append("div")
                .classed("hint", true)
                .text(`${where} With two columns, each side has its own pipes.`)
        }
    }
    showPreview(box)
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

// The picture of the layout, and the same in plain text.
function showPreview(box) {
    renderPreview(box, output.entities, {wires: output.blueprint.wires, connections: output.connections})
    let details = box.append("details")
        .classed("blueprint-text-preview", true)
    details.append("summary")
        .text("Text version")
    details.append("pre")
        .classed("blueprint-preview", true)
        .text(output.preview)
    details.append("div")
        .classed("hint", true)
        .text("Belts flow down (v) or west (<); ) and ( are inserters, F furnaces, A assemblers, P poles, = pipes, O underground pipes.")
}

function renderChainResult(box) {
    let p = output.chain
    let part = (stage, name) => `${stage.machines} × ${stage.machine} (${name})`
    let up = lookupRecipe(spec.data, p.upstreamRecipe)
    let down = lookupRecipe(spec.data, p.downstreamRecipe)
    box.append("div")
        .text(`${part(p.upstream, up.localized_name.en)} feeding ${part(p.downstream, down.localized_name.en)} along a ${p.mid}.`)
    if (!output.ok) {
        box.append("div")
            .classed("blueprint-error", true)
            .text("This layout was rejected, so no blueprint was made:")
        let list = box.append("ul")
        for (let e of output.errors) {
            list.append("li")
                .text(e)
        }
        return
    }
    if (output.warnings.length > 0) {
        let list = box.append("ul")
        for (let w of output.warnings) {
            list.append("li")
                .text(w)
        }
    }
    let [feedUp, feedOther] = output.connections.inputs
    let supplies = `Bring ${feedUp.items.join(" and ")} to the end of the belt on the right (the lower of the two feeders)`
    if (feedOther) {
        supplies += `, and ${feedOther.items.join(" and ")} to the end of the feeder above it`
    }
    box.append("div")
        .classed("hint", true)
        .text(`${supplies}; both flow west into the layout. Take ${output.connections.output.item} from the bottom of the belt on the far left. Modules are not included.`)
    showPreview(box)
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
}

function renderLog(box) {
    if (!output.log || output.log.length === 0) {
        return
    }
    let details = box.append("details")
    details.append("summary")
        .text("What the model said")
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
    let reqs = columnRequirements()
    if (reqs.length === 0) {
        root.append("p")
            .text("There are no furnaces or assemblers in the current factory. Add a target such as iron plate on the Factory tab.")
        return
    }
    root.append("p")
        .text("Machine columns for the current factory. Pick one to turn into a blueprint: a row of machines between an input belt and an output belt.")

    let table = root.append("table")
        .classed("blueprint-list", true)
    for (let req of reqs) {
        let row = table.append("tr")
            .classed("selected", selected === req.recipe)
        row.append("td")
            .append(() => req.recipe.icon.make(32))
        row.append("td")
            .text(req.recipe.name)
        let note
        if (req.reason) {
            note = req.reason
        } else {
            note = `${req.rate.toFixed(2)}/s needs ${machinesNeeded(req)} × ${req.building.name}`
        }
        row.append("td")
            .classed("hint", !!req.reason)
            .text(note)
        let cell = row.append("td")
        if (!req.reason) {
            cell.append("button")
                .text("Choose")
                .on("click", () => {
                    selected = req.recipe
                    selectedChain = null
                    output = null
                    renderBlueprint()
                })
        }
    }

    let chains = chainRequirements(reqs)
    if (chains.length > 0) {
        root.append("p")
            .text("Chains: one row feeds another through a shared belt, so the ingredient never leaves the blueprint.")
        let chainTable = root.append("table")
            .classed("blueprint-list", true)
        for (let chain of chains) {
            let row = chainTable.append("tr")
                .classed("selected", isSelectedChain(chain))
            let icons = row.append("td")
            icons.append(() => chain.up.recipe.icon.make(32))
            icons.append("span")
                .text(" → ")
            icons.append(() => chain.down.recipe.icon.make(32))
            row.append("td")
                .text(`${chain.up.recipe.name} → ${chain.down.recipe.name}`)
            row.append("td")
                .classed("hint", !!chain.reason)
                .text(chain.reason || `${chain.down.rate.toFixed(2)}/s of ${chain.down.recipe.products[0].item.name}`)
            let cell = row.append("td")
            if (!chain.reason) {
                cell.append("button")
                    .text("Choose")
                    .on("click", () => {
                        selectedChain = {up: chain.up.recipe.key, down: chain.down.recipe.key}
                        selected = null
                        output = null
                        renderBlueprint()
                    })
            }
        }
    }

    if (selectedChain !== null) {
        let chain = chains.find(isSelectedChain)
        if (chain && !chain.reason) {
            let panel = root.append("div")
                .classed("blueprint-panel", true)
            panel.append("h3")
                .text(`Blueprint for ${chain.up.recipe.name} → ${chain.down.recipe.name}`)
            panel.append("div")
                .classed("hint", true)
                .text("Chains are built from the cheapest parts which carry the load.")
            panel.append("button")
                .property("disabled", busy)
                .text("Generate")
                .on("click", () => generateChain(chain))
            renderResult(panel)
            return
        }
    }

    let req = reqs.find(r => r.recipe === selected && !r.reason)
    if (!req) {
        return
    }
    let panel = root.append("div")
        .classed("blueprint-panel", true)
    panel.append("h3")
        .text(`Blueprint for ${req.recipe.name}`)
    let modes = panel.append("div")
    let choices = [
        ["none", "Build without a model (cheapest parts that carry the load)"],
        ["ollama", "Ask a local model (Ollama) to choose the parts"],
        ["anthropic", "Ask Claude to choose the parts (needs an API key)"],
    ]
    for (let [value, text] of choices) {
        let label = modes.append("label")
            .style("display", "block")
        label.append("input")
            .attr("type", "radio")
            .attr("name", "blueprint_mode")
            .property("checked", provider === value)
            .on("change", () => {
                provider = value
                renderBlueprint()
            })
        label.append("span")
            .text(" " + text)
    }
    if (provider !== "none") {
        let box = panel.append("div")
            .classed("blueprint-api", true)
        if (provider === "anthropic") {
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
        } else {
            box.append("div")
                .classed("hint", true)
                .text("The request goes to your own Ollama server and contains the factory's numbers; nothing leaves your machine. If the browser is blocked from reaching it, start Ollama with OLLAMA_ORIGINS set to include this page's address.")
            box.append("input")
                .attr("type", "text")
                .attr("placeholder", "Ollama address")
                .property("value", ollamaUrl)
                .on("input", function() {
                    ollamaUrl = this.value
                })
        }
        box.append("input")
            .attr("type", "text")
            .attr("placeholder", "Model")
            .property("value", models[provider])
            .on("input", function() {
                models[provider] = this.value
            })
    }
    panel.append("button")
        .property("disabled", busy)
        .text("Generate")
        .on("click", () => generate(req))
    renderResult(panel)
}
