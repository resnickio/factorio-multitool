// Asks a model for a layout, and feeds the validator's complaints back to it
// until the layout is accepted or the attempts run out.
//
// Two providers are supported: the Anthropic API (with a key), and a local
// Ollama server. Both single columns and chains can be asked for.

import { describeTask, SYSTEM_PROMPT, parseReply, buildColumnBlueprint, defaultParams } from "./dsl.js"
import { describeChainTask, CHAIN_SYSTEM_PROMPT, parseChainReply, buildChainBlueprint, defaultChainParams } from "./chain.js"
import { buildLineBlueprint, defaultLineParams } from "./line.js"
import { lookupRecipe } from "./entities.js"
import { describeLineTask, LINE_SYSTEM_PROMPT, parseLineReply } from "./line_model.js"

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
export const OLLAMA_URL = "http://localhost:11434"

async function failure(response, extract) {
    let detail
    try {
        detail = extract(await response.json())
    } catch (e) {
        detail = response.statusText
    }
    return new Error(`API request failed (${response.status}): ${detail}`)
}

async function callAnthropic({apiKey, model, system, messages, fetchFn}) {
    let response = await fetchFn(ANTHROPIC_URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            // Needed to call the API straight from a web page.
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({model, max_tokens: 1024, system, messages}),
    })
    if (!response.ok) {
        throw await failure(response, body => body.error.message)
    }
    let body = await response.json()
    return body.content.filter(part => part.type === "text").map(part => part.text).join("")
}

async function callOllama({baseUrl, model, system, messages, fetchFn, think}) {
    let response = await fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            model,
            messages: [{role: "system", content: system}, ...messages],
            stream: false,
            // Without thinking, models answer in seconds instead of minutes.
            think,
            // Constrains the reply to a JSON object.
            format: "json",
            options: {temperature: 0.2, num_predict: 2048},
        }),
    })
    if (!response.ok) {
        throw await failure(response, body => body.error)
    }
    let body = await response.json()
    return body.message.content
}

// The names of the models an Ollama server has installed.
export async function listOllamaModels(baseUrl = OLLAMA_URL, fetchFn = fetch) {
    let response = await fetchFn(`${baseUrl}/api/tags`)
    if (!response.ok) {
        throw await failure(response, body => body.error)
    }
    let body = await response.json()
    return body.models.map(m => m.name).sort()
}

// The asking and repairing, for any kind of layout.
//   call(messages): asks the model, returning its reply text
//   task: what to tell it; parse(text): the parameters in the reply;
//   build(params): the result of validating and building them
//   slots: the machine counts in the parameters, for trimming (see below)
//   reference(): the cheapest layout the calculator itself finds, to compare
//   a working layout with (its machine counts, and what it did to need so few)
async function askUntilAccepted({call, task, parse, build, maxAttempts, slots = [], reference = null, rateOf = null}) {
    let messages = [{role: "user", content: JSON.stringify(task)}]
    let log = []
    let last = null
    let fallback = null
    let ref = null
    let refRate = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let text = await call(messages)
        log.push({attempt, reply: text})
        let params
        try {
            params = parse(text)
        } catch (e) {
            last = {ok: false, errors: [e.message], warnings: [], stats: {}}
            messages.push({role: "assistant", content: text})
            messages.push({role: "user", content: `That could not be read: ${e.message}. Reply with only the JSON object.`})
            continue
        }
        let result = build(params)
        last = {...result, params}
        log[log.length - 1].errors = result.errors
        if (result.ok) {
            last = trimmed(params, slots, build, result)
            // A working layout with more machines than the calculator's own
            // is sent back, with how the calculator gets by with fewer.
            ref = ref || (reference ? reference() : null)
            let more = ref ? slots.filter(s => s.get(last.params) > s.get(ref)) : []
            let reasons = more.map(s => `${s.label}: ${s.get(last.params)} machines, but ${s.get(ref)} are enough with ${s.hint(ref)}`)
            // With exact counts the rate matters instead: a layout whose inserters
            // make clearly less than the calculator's own is sent back too.
            if (rateOf && ref) {
                refRate = refRate === null ? rateOf(build(ref)) : refRate
                let rate = rateOf(last)
                if (rate < refRate * 0.98) {
                    reasons.push(`the line makes about ${rate.toFixed(2)}/s, but ${refRate.toFixed(2)}/s with these inserters: ${slots.map(s => `${s.label}: ${s.hint(ref)}`).join("; ")}`)
                }
            }
            if (reasons.length === 0 || attempt === maxAttempts) {
                break
            }
            fallback = last
            log[log.length - 1].errors = reasons
            messages.push({role: "assistant", content: text})
            let header = more.length > 0 ? "That layout works, but it uses more machines than needed, and machines cost far more than inserters:" : "That layout works, but the calculator's own does better:"
            messages.push({role: "user", content: `${header}\n- ${reasons.join("\n- ")}\nReply with a corrected JSON object.`})
            continue
        }
        messages.push({role: "assistant", content: text})
        messages.push({role: "user", content: `That layout was rejected:\n- ${result.errors.join("\n- ")}\nReply with a corrected JSON object.`})
    }
    if (!last.ok && fallback) {
        last = fallback
    }
    return {...last, attempts: log.length, log}
}

// A model tends to ask for more machines than its own inserters and belts
// need. Each machine count is cut back while the layout still builds, so the
// layout has no more machines than it takes (the calculator's own count where
// the inserters can keep up). Returns the result to use, with what was cut.
//   slots: [{label, get(params), set(params, count)}]
function trimmed(params, slots, build, result) {
    let current = params
    let notes = []
    for (let slot of slots) {
        let from = slot.get(current)
        while (slot.get(current) > 1) {
            let next = structuredClone(current)
            slot.set(next, slot.get(current) - 1)
            if (!build(next).ok) {
                break
            }
            current = next
        }
        if (slot.get(current) < from) {
            notes.push(`${slot.label}: ${from} → ${slot.get(current)} machines`)
        }
    }
    if (notes.length === 0) {
        return {...result, params}
    }
    return {...build(current), params: current, trimmed: notes}
}

// What a part's inserters are, in words.
function inserterText(p) {
    return `${p.inputInserters} ${p.inputInserter} on the input side and ${p.outputInserters} ${p.outputInserter} on the output side`
}

function caller({provider, apiKey, baseUrl, think, model, fetchFn, system}) {
    return provider === "ollama"
        ? messages => callOllama({baseUrl, model, system, messages, fetchFn, think})
        : messages => callAnthropic({apiKey, model, system, messages, fetchFn})
}

// provider: "anthropic" (needs apiKey) or "ollama" (optional baseUrl, think).
// Returns the result of buildColumnBlueprint for the model's last attempt,
// plus {params, attempts, log}. The log lists what was said at each step.
export async function askForLayout({
    provider = "anthropic", apiKey, baseUrl = OLLAMA_URL, think = false,
    model, requirement, machine, data, maxAttempts = 3, fetchFn = fetch,
}) {
    return askUntilAccepted({
        call: caller({provider, apiKey, baseUrl, think, model, fetchFn, system: SYSTEM_PROMPT}),
        task: describeTask(requirement, machine, data),
        parse: text => ({...parseReply(text), machine}),
        build: params => buildColumnBlueprint(params, requirement, data),
        slots: [{label: "machines", get: p => p.machines, set: (p, n) => { p.machines = n }, hint: p => inserterText(p)}],
        reference: () => defaultParams(requirement, machine, data),
        maxAttempts,
    })
}

// As askForLayout, for a chain: requirement is {recipe, rate, upstream} and
// machines is {upstream, downstream}. The result's params are the chain's.
export async function askForChainLayout({
    provider = "anthropic", apiKey, baseUrl = OLLAMA_URL, think = false,
    model, requirement, machines, data, maxAttempts = 3, fetchFn = fetch,
}) {
    return askUntilAccepted({
        call: caller({provider, apiKey, baseUrl, think, model, fetchFn, system: CHAIN_SYSTEM_PROMPT}),
        task: describeChainTask(requirement, machines, data),
        parse: text => parseChainReply(text, requirement, machines),
        build: params => buildChainBlueprint(params, requirement, data),
        slots: ["upstream", "downstream"].map(which => ({
            label: lookupRecipe(data, which === "upstream" ? requirement.upstream : requirement.recipe).localized_name.en,
            get: p => p[which].machines,
            set: (p, n) => { p[which].machines = n },
            hint: p => inserterText(p[which]),
        })),
        reference: () => defaultChainParams(requirement, machines, data),
        maxAttempts,
    })
}

// As askForLayout, for a production line: spec is {root, east, west} as for
// buildLineBlueprint. The result's params are the line's.
export async function askForLineLayout({
    provider = "anthropic", apiKey, baseUrl = OLLAMA_URL, think = false,
    model, spec, data, maxAttempts = 3, fetchFn = fetch, exact = false,
}) {
    return askUntilAccepted({
        call: caller({provider, apiKey, baseUrl, think, model, fetchFn, system: LINE_SYSTEM_PROMPT}),
        task: describeLineTask(spec, data, {exact}),
        parse: text => parseLineReply(text, spec, data, {exact}),
        build: params => buildLineBlueprint(params, spec, data),
        slots: [
            {label: lookupRecipe(data, spec.root.recipe).localized_name.en, get: p => p.root.machines, set: (p, n) => { p.root.machines = n }, hint: p => inserterText(p.root)},
            ...["east", "west"].flatMap(side => spec[side].map((stage, j) => ({
                label: lookupRecipe(data, stage.recipe).localized_name.en,
                get: p => p[side].stages[j].machines,
                set: (p, n) => { p[side].stages[j].machines = n },
                hint: p => inserterText(p[side].stages[j]),
            }))),
        ],
        reference: () => defaultLineParams(spec, data, {exact}),
        rateOf: exact ? result => (result.stats && result.stats.estimatedRate !== undefined ? result.stats.estimatedRate : Infinity) : null,
        maxAttempts,
    })
}
