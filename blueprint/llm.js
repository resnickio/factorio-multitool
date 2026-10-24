// Asks a model for a layout, and feeds the validator's complaints back to it
// until the layout is accepted or the attempts run out.
//
// Two providers are supported: the Anthropic API (with a key), and a local
// Ollama server. Both single columns and chains can be asked for.

import { describeTask, SYSTEM_PROMPT, parseReply, buildColumnBlueprint } from "./dsl.js"
import { describeChainTask, CHAIN_SYSTEM_PROMPT, parseChainReply, buildChainBlueprint } from "./chain.js"

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
async function askUntilAccepted({call, task, parse, build, maxAttempts}) {
    let messages = [{role: "user", content: JSON.stringify(task)}]
    let log = []
    let last = null
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
            break
        }
        messages.push({role: "assistant", content: text})
        messages.push({role: "user", content: `That layout was rejected:\n- ${result.errors.join("\n- ")}\nReply with a corrected JSON object.`})
    }
    return {...last, attempts: log.length, log}
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
        maxAttempts,
    })
}
