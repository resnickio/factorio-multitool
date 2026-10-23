// Sample requirements shared by make-sample.mjs and game-test.mjs.
// machine: defaults to electric-furnace. override: layout parameters to force
// (the defaults pick one column unless the loads are too large for one).
export const SAMPLES = {
    "iron-4-furnaces": {recipe: "iron-plate", rate: 2.5},
    "iron-24-furnaces": {recipe: "iron-plate", rate: 15},
    "iron-two-columns": {recipe: "iron-plate", rate: 7.5, override: {columns: 2}},
    "steel-two-columns": {recipe: "steel-plate", rate: 3.75, override: {columns: 2}},
    "circuits-assembler": {recipe: "electronic-circuit", rate: 3, machine: "assembling-machine-2"},
    "gears-assembler": {recipe: "iron-gear-wheel", rate: 2, machine: "assembling-machine-2"},
    "plastic-chemical-plant": {recipe: "plastic-bar", rate: 4, machine: "chemical-plant"},
    "battery-chemical-plant": {recipe: "battery", rate: 2, machine: "chemical-plant", override: {columns: 2}},
    "explosives-chemical-plant": {recipe: "explosives", rate: 2, machine: "chemical-plant"},
    "sulfur-two-columns": {recipe: "sulfur", rate: 4, machine: "chemical-plant", override: {columns: 2}},
    "solid-fuel-chemical-plant": {recipe: "solid-fuel-from-petroleum-gas", rate: 2, machine: "chemical-plant"},
}

export const DEFAULT_MACHINE = "electric-furnace"
