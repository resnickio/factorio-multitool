// Asks the model for a layout, and feeds the validator's complaints back to it
// until the layout is accepted or the attempts run out.

import { describeTask, SYSTEM_PROMPT, parseReply, buildSmeltingBlueprint } from "./dsl.js"

const API_URL = "https://api.anthropic.com/v1/messages"

async function callModel({apiKey, model, messages, fetchFn}) {
    let response = await fetchFn(API_URL, {
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
        let detail = ""
        try {
            detail = (await response.json()).error.message
        } catch (e) {
            detail = response.statusText
        }
        throw new Error(`API request failed (${response.status}): ${detail}`)
    }
    let body = await response.json()
    return body.content.filter(part => part.type === "text").map(part => part.text).join("")
}

// Returns the result of buildSmeltingBlueprint for the model's last attempt,
// plus {params, attempts, log}. The log lists what was said at each step.
export async function askForLayout({apiKey, model, requirement, furnace, data, maxAttempts = 3, fetchFn = fetch}) {
    let task = describeTask(requirement, furnace, data)
    let messages = [{role: "user", content: JSON.stringify(task)}]
    let log = []
    let last = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let text = await callModel({apiKey, model, messages, fetchFn})
        log.push({attempt, reply: text})
        let params
        try {
            params = {...parseReply(text), furnace}
        } catch (e) {
            last = {ok: false, errors: [e.message], warnings: [], stats: {}}
            messages.push({role: "assistant", content: text})
            messages.push({role: "user", content: `That could not be read: ${e.message}. Reply with only the JSON object.`})
            continue
        }
        let result = buildSmeltingBlueprint(params, requirement, data)
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
