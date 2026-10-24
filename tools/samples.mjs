// Sample requirements shared by make-sample.mjs and game-test.mjs.
// machine: defaults to electric-furnace. override: layout parameters to force
// (the defaults pick one column unless the loads are too large for one).
export const SAMPLES = {
    "iron-4-furnaces": {recipe: "iron-plate", rate: 2.5},
    "iron-24-furnaces": {recipe: "iron-plate", rate: 15},
    "iron-two-columns": {recipe: "iron-plate", rate: 7.5, override: {columns: 2}},
    "steel-two-columns": {recipe: "steel-plate", rate: 3.75, override: {columns: 2}},
    "circuits-assembler": {recipe: "electronic-circuit", rate: 3, machine: "assembling-machine-2"},
    "circuits-asm1-4": {recipe: "electronic-circuit", rate: 4, machine: "assembling-machine-1"},
    "gears-assembler": {recipe: "iron-gear-wheel", rate: 2, machine: "assembling-machine-2"},
    "plastic-chemical-plant": {recipe: "plastic-bar", rate: 4, machine: "chemical-plant"},
    "battery-chemical-plant": {recipe: "battery", rate: 2, machine: "chemical-plant", override: {columns: 2}},
    "explosives-chemical-plant": {recipe: "explosives", rate: 2, machine: "chemical-plant"},
    "sulfur-two-columns": {recipe: "sulfur", rate: 4, machine: "chemical-plant", override: {columns: 2}},
    "solid-fuel-chemical-plant": {recipe: "solid-fuel-from-petroleum-gas", rate: 2, machine: "chemical-plant"},
}

// Chains: an upstream recipe whose product the downstream recipe uses.
SAMPLES["circuits-from-cable"] = {
    rate: 3,
    chain: {
        upstream: "copper-cable", downstream: "electronic-circuit",
        upstreamMachine: "assembling-machine-2", downstreamMachine: "assembling-machine-2",
    },
}

SAMPLES["circuits-from-cable-asm1"] = {
    rate: 3,
    chain: {
        upstream: "copper-cable", downstream: "electronic-circuit",
        upstreamMachine: "assembling-machine-1", downstreamMachine: "assembling-machine-1",
    },
}
// Furnaces upstream: the iron plate they make shares the belt with cable
// arriving on the feeder.
SAMPLES["circuits-from-iron-furnaces"] = {
    rate: 3,
    chain: {
        upstream: "iron-plate", downstream: "electronic-circuit",
        upstreamMachine: "electric-furnace", downstreamMachine: "assembling-machine-2",
    },
}

// Lines: a final recipe with branches of producers on either side of a shared belt.
SAMPLES["circuits-from-copper-ore"] = {
    rate: 3,
    line: {
        root: {recipe: "electronic-circuit", machine: "assembling-machine-2"},
        east: [
            {recipe: "copper-cable", machine: "assembling-machine-2"},
            {recipe: "copper-plate", machine: "electric-furnace"},
        ],
        west: [],
    },
}
SAMPLES["circuits-from-ore"] = {
    rate: 3,
    line: {
        root: {recipe: "electronic-circuit", machine: "assembling-machine-2"},
        east: [
            {recipe: "copper-cable", machine: "assembling-machine-2"},
            {recipe: "copper-plate", machine: "electric-furnace"},
        ],
        west: [{recipe: "iron-plate", machine: "electric-furnace"}],
    },
}

// The mirror image: the producers on the west, so the other ingredient comes
// in from the west.
SAMPLES["circuits-west-branch"] = {
    rate: 3,
    line: {
        root: {recipe: "electronic-circuit", machine: "assembling-machine-2"},
        east: [],
        west: [
            {recipe: "copper-cable", machine: "assembling-machine-2"},
            {recipe: "copper-plate", machine: "electric-furnace"},
        ],
    },
}

// An inserter takes three solids: gears from the west, circuits from the east
// (second belt), iron plate on a feeder.
SAMPLES["inserters-from-parts"] = {
    rate: 2,
    line: {
        root: {recipe: "inserter", machine: "assembling-machine-2"},
        east: [{recipe: "electronic-circuit", machine: "assembling-machine-2"}],
        west: [{recipe: "iron-gear-wheel", machine: "assembling-machine-2"}],
    },
}

// Iron and copper plates all the way to inserters.
SAMPLES["inserters-from-plates"] = {
    rate: 2,
    line: {
        root: {recipe: "inserter", machine: "assembling-machine-2"},
        east: [
            {recipe: "electronic-circuit", machine: "assembling-machine-2"},
            {recipe: "copper-cable", machine: "assembling-machine-2"},
        ],
        west: [{recipe: "iron-gear-wheel", machine: "assembling-machine-2"}],
    },
}

export const DEFAULT_MACHINE = "electric-furnace"

// Plastic made from coal and petroleum gas (a fluid, piped in beside its coal
// belt) and circuits, with the cable brought in on a feeder.
SAMPLES["advanced-circuits-plastic"] = {
    rate: 1,
    line: {
        root: {recipe: "advanced-circuit", machine: "assembling-machine-2"},
        east: [{recipe: "plastic-bar", machine: "chemical-plant"}],
        west: [{recipe: "electronic-circuit", machine: "assembling-machine-2"}],
    },
}

// Two assembling machine 1 of inserters, as the calculator might count them:
// the inserters beside the machines are the limit, so more machines are needed.
SAMPLES["inserters-two-asm1"] = {
    rate: 2,
    line: {
        root: {recipe: "inserter", machine: "assembling-machine-1"},
        east: [
            {recipe: "electronic-circuit", machine: "assembling-machine-1"},
            {recipe: "copper-cable", machine: "assembling-machine-1"},
        ],
        west: [{recipe: "iron-gear-wheel", machine: "assembling-machine-1"}],
    },
}
