// Asks a model for a layout, and feeds the validator's complaints back to it
// until the layout is accepted or the attempts run out.
//
// Two providers are supported: the Anthropic API (with a key), and a local
// Ollama server.

import { describeTask, SYSTEM_PROMPT, parseReply, buildColumnBlueprint } from "./dsl.js"

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

async function callAnthropic({apiKey, model, messages, fetchFn}) {
    let response = await fetchFn(ANTHROPIC_URL, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            // Needed to call the API straight from a web page.
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({model, max_tokens: 1024, system: SYSTEM_PROMPT, messages}),
    })
    if (!response.ok) {
        throw await failure(response, body => body.error.message)
    }
    let body = await response.json()
    return body.content.filter(part => part.type === "text").map(part => part.text).join("")
}

async function callOllama({baseUrl, model, messages, fetchFn, think}) {
    let response = await fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            model,
            messages: [{role: "system", content: SYSTEM_PROMPT}, ...messages],
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

// provider: "anthropic" (needs apiKey) or "ollama" (optional baseUrl, think).
// Returns the result of buildColumnBlueprint for the model's last attempt,
// plus {params, attempts, log}. The log lists what was said at each step.
export async function askForLayout({
    provider = "anthropic", apiKey, baseUrl = OLLAMA_URL, think = false,
    model, requirement, machine, data, maxAttempts = 3, fetchFn = fetch,
}) {
    let call = provider === "ollama"
        ? messages => callOllama({baseUrl, model, messages, fetchFn, think})
        : messages => callAnthropic({apiKey, model, messages, fetchFn})
    let task = describeTask(requirement, machine, data)
    let messages = [{role: "user", content: JSON.stringify(task)}]
    let log = []
    let last = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let text = await call(messages)
        log.push({attempt, reply: text})
        let params
        try {
            params = {...parseReply(text), machine}
        } catch (e) {
            last = {ok: false, errors: [e.message], warnings: [], stats: {}}
            messages.push({role: "assistant", content: text})
            messages.push({role: "user", content: `That could not be read: ${e.message}. Reply with only the JSON object.`})
            continue
        }
        let result = buildColumnBlueprint(params, requirement, data)
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
