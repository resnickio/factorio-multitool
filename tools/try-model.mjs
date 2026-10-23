// Tries a local Ollama model on a few layout tasks and reports how it did.
//   node tools/try-model.mjs [--model qwen3.8:latest] [--think true]
import fs from "node:fs"
import { askForLayout } from "../blueprint/llm.js"
import { defaultParams } from "../blueprint/dsl.js"

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1]
}
const model = args.model || "qwen3.8:latest"
const think = args.think === "true"
const attempts = parseInt(args.attempts || "3", 10)
const data = JSON.parse(fs.readFileSync(new URL("../data/space-age-2.1.23.json", import.meta.url), "utf8"))

const TASKS = [
    {name: "iron plate 15/s, electric furnaces", requirement: {recipe: "iron-plate", rate: 15}, machine: "electric-furnace"},
    {name: "steel 15/s, electric furnaces", requirement: {recipe: "steel-plate", rate: 15}, machine: "electric-furnace"},
    {name: "circuits 3/s, assembling machine 2", requirement: {recipe: "electronic-circuit", rate: 3}, machine: "assembling-machine-2"},
    {name: "gears 2/s, assembling machine 2", requirement: {recipe: "iron-gear-wheel", rate: 2}, machine: "assembling-machine-2"},
    {name: "plastic 4/s, chemical plant", requirement: {recipe: "plastic-bar", rate: 4}, machine: "chemical-plant"},
    {name: "sulfur 4/s, chemical plant", requirement: {recipe: "sulfur", rate: 4}, machine: "chemical-plant"},
    {name: "battery 6/s, chemical plant", requirement: {recipe: "battery", rate: 6}, machine: "chemical-plant"},
    {name: "circuits 20/s, assembling machine 3", requirement: {recipe: "electronic-circuit", rate: 20}, machine: "assembling-machine-3"},
]

console.log(`model ${model}, thinking ${think ? "on" : "off"}, up to ${attempts} attempts`)
let passed = 0
for (let task of TASKS) {
    let started = Date.now()
    let result
    try {
        result = await askForLayout({provider: "ollama", model, think, requirement: task.requirement, machine: task.machine, data, maxAttempts: attempts})
    } catch (e) {
        console.log(`\n${task.name}: ERROR ${e.message}`)
        continue
    }
    let seconds = ((Date.now() - started) / 1000).toFixed(1)
    let baseline = defaultParams(task.requirement, task.machine, data)
    console.log(`\n${task.name}: ${result.ok ? "ACCEPTED" : "REJECTED"} after ${result.attempts} attempt(s), ${seconds}s`)
    if (result.ok) {
        passed++
    }
    if (result.params) {
        let p = result.params
        console.log(`  model chose: ${p.machines} machines, ${p.columns} col, in ${p.inputBelt} ${p.inputInserters}x${p.inputInserter}, out ${p.outputBelt} ${p.outputInserters}x${p.outputInserter}, ${p.pole}`)
        console.log(`  default:     ${baseline.machines} machines, ${baseline.columns} col, in ${baseline.inputBelt} ${baseline.inputInserters}x${baseline.inputInserter}, out ${baseline.outputBelt} ${baseline.outputInserters}x${baseline.outputInserter}`)
        if (p.notes) {
            console.log(`  notes: ${p.notes}`)
        }
    }
    if (!result.ok) {
        for (let e of result.errors) {
            console.log("  - " + e)
        }
    }
    for (let entry of result.log) {
        if (entry.errors && entry.errors.length) {
            console.log(`  attempt ${entry.attempt} rejected: ${entry.errors.join("; ")}`)
        }
    }
}
console.log(`\n${passed}/${TASKS.length} accepted`)
