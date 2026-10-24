import { spec } from "./factory.js"
import { encodeBlueprint } from "./blueprint/codec.js"
import { defaultParams, buildColumnBlueprint, ineligibleReason } from "./blueprint/dsl.js"
import { previewLayout } from "./blueprint/build.js"
import { askForLayout, askForChainLayout, askForLineLayout, listOllamaModels, OLLAMA_URL } from "./blueprint/llm.js"
import { entityInfo, lookupRecipe, machineCrafts } from "./blueprint/entities.js"
import { chainIneligibleReason, defaultChainParams, buildChainBlueprint } from "./blueprint/chain.js"
import { renderPreview } from "./blueprint_preview.js"
import { lineIneligibleReason, defaultLineParams, buildLineBlueprint } from "./blueprint/line.js"

// The Blueprint tab: turns the furnace and assembler rows in the current
// solution into blueprint strings for the game, singly or as chains.

const DEFAULT_MODELS = {anthropic: "claude-sonnet-5-5", ollama: "qwen3.8:latest"}

let selected = null
// A chain of two rows, by recipe key: {up, down}.
let selectedChain = null
// A line, by key (see lineKey).
let selectedLine = null
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
        if (provider === "anthropic") {
            if (apiKey === "") {
                throw new Error("Enter an API key, or choose another way to build.")
            }
            let asked = await askForChainLayout({provider, apiKey, model: models.anthropic, requirement, machines, data: spec.data})
            output = {...asked, chain: asked.params}
        } else if (provider === "ollama") {
            let asked = await askForChainLayout({provider, baseUrl: ollamaUrl, model: models.ollama, maxAttempts: 6, requirement, machines, data: spec.data})
            output = {...asked, chain: asked.params}
        } else {
            let params = defaultChainParams(requirement, machines, spec.data)
            output = {...buildChainBlueprint(params, requirement, spec.data), chain: params, attempts: 0, log: []}
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
    if (output.line) {
        renderLineResult(box)
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

// Lines: a recipe in the factory together with the rows which make its
// ingredients, and what makes those. Returns the ones with at least two
// producers (one producer is a chain), with whether each can be built.
function lineRequirements(reqs) {
    let lines = []
    let producerOf = item => reqs.filter(r => r.recipe.products[0].item === item)
    let MAX_STAGES = 2
    for (let root of reqs) {
        let branches = []
        for (let ing of root.recipe.ingredients) {
            // Follow producers inward, up to two stages. A stage which is not
            // the outermost can take one more ingredient from outside.
            let stages = []
            let item = ing.item
            while (stages.length < MAX_STAGES) {
                let producer = producerOf(item).find(p => p !== root && !stages.includes(p))
                if (!producer) {
                    break
                }
                stages.push(producer)
                // The deepest chain is the one worth following.
                let depth = (it, seen) => {
                    let p = producerOf(it).find(q => q !== root && !seen.includes(q))
                    return p ? 1 + Math.max(0, ...p.recipe.ingredients.map(i => depth(i.item, [...seen, p]))) : 0
                }
                let next = null
                if (producer.recipe.ingredients.length <= 2) {
                    let best = 0
                    for (let i of producer.recipe.ingredients) {
                        let d = depth(i.item, [...stages, producer])
                        if (d > best) {
                            best = d
                            next = i
                        }
                    }
                }
                if (!next) {
                    break
                }
                item = next.item
            }
            if (stages.length > 0) {
                branches.push(stages)
            }
        }
        // Only two branches fit; the longer ones are worth more.
        branches = branches
            .map((stages, i) => ({stages, i}))
            .sort((x, y) => y.stages.length - x.stages.length || x.i - y.i)
            .slice(0, 2)
            .sort((x, y) => x.i - y.i)
            .map(x => x.stages)
        let total = branches.reduce((n, b) => n + b.length, 0)
        if (branches.length === 0 || total < 2) {
            continue
        }
        let lineSpec = {
            root: {recipe: root.recipe.key, machine: root.building.key, rate: root.rate},
            east: (branches[0] || []).map(s => ({recipe: s.recipe.key, machine: s.building.key})),
            west: (branches[1] || []).map(s => ({recipe: s.recipe.key, machine: s.building.key})),
        }
        lines.push({root, east: branches[0] || [], west: branches[1] || [], spec: lineSpec, reason: lineIneligibleReason(lineSpec, spec.data)})
    }
    return lines
}

function lineKey(line) {
    return [line.spec.root.recipe, line.spec.east.map(s => s.recipe).join("+"), line.spec.west.map(s => s.recipe).join("+")].join("|")
}

function isSelectedLine(line) {
    return selectedLine !== null && selectedLine === lineKey(line)
}

async function generateLine(line) {
    busy = true
    output = {pending: true}
    renderBlueprint()
    try {
        if (provider === "anthropic") {
            if (apiKey === "") {
                throw new Error("Enter an API key, or choose another way to build.")
            }
            let asked = await askForLineLayout({provider, apiKey, model: models.anthropic, spec: line.spec, data: spec.data})
            output = {...asked, line: {spec: line.spec, params: asked.params}}
        } else if (provider === "ollama") {
            let asked = await askForLineLayout({provider, baseUrl: ollamaUrl, model: models.ollama, maxAttempts: 6, spec: line.spec, data: spec.data})
            output = {...asked, line: {spec: line.spec, params: asked.params}}
        } else {
            let params = defaultLineParams(line.spec, spec.data)
            output = {...buildLineBlueprint(params, line.spec, spec.data), line: {spec: line.spec, params}, attempts: 0, log: []}
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

function renderLineResult(box) {
    let {spec: lineSpec, params} = output.line
    let name = key => lookupRecipe(spec.data, key).localized_name.en
    if (!params) {
        box.append("div")
            .classed("blueprint-error", true)
            .text("The model's reply could not be used, so no blueprint was made:")
        let list = box.append("ul")
        for (let e of output.errors) {
            list.append("li")
                .text(e)
        }
        renderLog(box)
        return
    }
    let parts = []
    for (let side of ["west", "east"]) {
        for (let stage of [...params[side].stages].reverse()) {
            parts.push(`${stage.machines} × ${stage.machine} (${name(stage.recipe)})`)
        }
    }
    parts.push(`${params.root.machines} × ${params.root.machine} (${name(lineSpec.root.recipe)})`)
    let attempts = output.ok && output.attempts > 0 ? ` (accepted after ${output.attempts} ${output.attempts === 1 ? "attempt" : "attempts"})` : ""
    box.append("div")
        .text(`${parts.join("; ")}; shared belt ${params.mid}${attempts}.`)
    if (params.notes) {
        box.append("div")
            .classed("hint", true)
            .text(params.notes)
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
    let supplies = output.connections.inputs.map(input => {
        let item = input.items.map(i => (spec.items.get(i) ? spec.items.get(i).name : i)).join(" and ")
        return `${item} at the ${input.x > 0 ? "right" : "left"} end of the belt marked in the picture`
    })
    box.append("div")
        .classed("hint", true)
        .text(`Supply ${supplies.join("; ")}. Take ${output.connections.output.item} from the bottom of the belt on the far left. Modules are not included.`)
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

function renderChainResult(box) {
    let p = output.chain
    let part = (stage, name) => `${stage.machines} × ${stage.machine} (${name})`
    let up = lookupRecipe(spec.data, p.upstreamRecipe)
    let down = lookupRecipe(spec.data, p.downstreamRecipe)
    let attempts = output.ok && output.attempts > 0 ? ` (accepted after ${output.attempts} ${output.attempts === 1 ? "attempt" : "attempts"})` : ""
    box.append("div")
        .text(`${part(p.upstream, up.localized_name.en)} feeding ${part(p.downstream, down.localized_name.en)} along a ${p.mid}${attempts}.`)
    if (p.notes) {
        box.append("div")
            .classed("hint", true)
            .text(p.notes)
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
    renderLog(box)
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

// The models installed on the Ollama server, as last asked. Fetched when the
// local model is chosen, and again when the address changes or Refresh is used.
let installed = {models: null, error: null, loading: false, for: null}

async function refreshInstalled() {
    installed = {models: null, error: null, loading: true, for: ollamaUrl}
    renderBlueprint()
    let asked = ollamaUrl
    try {
        let names = await listOllamaModels(asked)
        if (asked !== ollamaUrl) {
            return
        }
        installed = {models: names, error: null, loading: false, for: asked}
        // The default may not be installed; pick something that is.
        if (names.length > 0 && !names.includes(models.ollama)) {
            models.ollama = names[0]
        }
    } catch (e) {
        if (asked !== ollamaUrl) {
            return
        }
        installed = {models: null, error: e.message, loading: false, for: asked}
    }
    renderBlueprint()
}

// Choosing how the parts are picked: without a model, with a local model, or
// with Claude; and the settings for the model chosen.
function renderProviderControls(panel) {
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
                if (value === "ollama" && installed.for !== ollamaUrl) {
                    refreshInstalled()
                } else {
                    renderBlueprint()
                }
            })
        label.append("span")
            .text(" " + text)
    }
    if (provider === "none") {
        return
    }
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
        box.append("input")
            .attr("type", "text")
            .attr("placeholder", "Model")
            .property("value", models.anthropic)
            .on("input", function() {
                models.anthropic = this.value
            })
        return
    }

    box.append("div")
        .classed("hint", true)
        .text("The request goes to your own Ollama server and contains the factory's numbers; nothing leaves your machine. If the browser is blocked from reaching it, start Ollama with OLLAMA_ORIGINS set to include this page's address.")
    let address = box.append("div")
    address.append("input")
        .attr("type", "text")
        .attr("placeholder", "Ollama address")
        .property("value", ollamaUrl)
        .on("input", function() {
            ollamaUrl = this.value
        })
        // Ask again once the address is settled, not on every keystroke.
        .on("change", () => refreshInstalled())
    address.append("button")
        .text("Refresh models")
        .on("click", () => refreshInstalled())
    if (installed.loading) {
        box.append("div")
            .classed("hint", true)
            .text("Asking Ollama which models are installed...")
    } else if (installed.models !== null && installed.models.length > 0) {
        let select = box.append("select")
            .classed("model-select", true)
            .on("change", function() {
                models.ollama = this.value
            })
        for (let name of installed.models) {
            select.append("option")
                .attr("value", name)
                .property("selected", name === models.ollama)
                .text(name)
        }
    } else {
        // No list to choose from, so the name is typed.
        let reason = installed.models !== null
            ? "Ollama has no models installed."
            : installed.error ? `Could not list the models (${installed.error}).` : ""
        if (reason) {
            box.append("div")
                .classed("hint", true)
                .text(reason + " Type a model name instead.")
        }
        box.append("input")
            .attr("type", "text")
            .attr("placeholder", "Model")
            .property("value", models.ollama)
            .on("input", function() {
                models.ollama = this.value
            })
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
                    selectedLine = null
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
                        selectedLine = null
                        selected = null
                        output = null
                        renderBlueprint()
                    })
            }
        }
    }

    let lines = lineRequirements(reqs)
    if (lines.length > 0) {
        root.append("p")
            .text("Lines: a recipe with the rows that make its ingredients, and what makes those, on either side of one shared belt, so only the raw inputs have to be brought in.")
        let lineTable = root.append("table")
            .classed("blueprint-list", true)
        for (let line of lines) {
            let row = lineTable.append("tr")
                .classed("selected", isSelectedLine(line))
            let icons = row.append("td")
            let order = [...line.west].reverse().concat([...line.east].reverse(), [line.root])
            order.forEach((r, i) => {
                if (i > 0) {
                    icons.append("span")
                        .text(" → ")
                }
                icons.append(() => r.recipe.icon.make(32))
            })
            row.append("td")
                .text(order.map(r => r.recipe.name).join(" → "))
            row.append("td")
                .classed("hint", !!line.reason)
                .text(line.reason || `${line.root.rate.toFixed(2)}/s of ${line.root.recipe.products[0].item.name}`)
            let cell = row.append("td")
            if (!line.reason) {
                cell.append("button")
                    .text("Choose")
                    .on("click", () => {
                        selectedLine = lineKey(line)
                        selectedChain = null
                        selected = null
                        output = null
                        renderBlueprint()
                    })
            }
        }
    }

    if (selectedLine !== null) {
        let line = lines.find(isSelectedLine)
        if (line && !line.reason) {
            let panel = root.append("div")
                .classed("blueprint-panel", true)
            panel.append("h3")
                .text(`Blueprint for ${line.root.recipe.name} and what feeds it`)
            renderProviderControls(panel)
            panel.append("button")
                .property("disabled", busy)
                .text("Generate")
                .on("click", () => generateLine(line))
            renderResult(panel)
            return
        }
    }

    if (selectedChain !== null) {
        let chain = chains.find(isSelectedChain)
        if (chain && !chain.reason) {
            let panel = root.append("div")
                .classed("blueprint-panel", true)
            panel.append("h3")
                .text(`Blueprint for ${chain.up.recipe.name} → ${chain.down.recipe.name}`)
            renderProviderControls(panel)
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
    renderProviderControls(panel)
    panel.append("button")
        .property("disabled", busy)
        .text("Generate")
        .on("click", () => generate(req))
    renderResult(panel)
}
