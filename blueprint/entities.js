// Helpers for reasoning about entities, using the dataset's blueprint_entities
// table (see tools/convert-data.mjs).

export const TICKS_PER_SECOND = 60

// Directions as used in blueprints.
export const NORTH = 0
export const EAST = 4
export const SOUTH = 8
export const WEST = 12

export function entityInfo(data, name) {
    let info = data.blueprint_entities[name]
    if (!info) {
        throw new Error("unknown entity: " + name)
    }
    return info
}

// Items per second a belt can carry, across both lanes.
export function beltThroughput(info) {
    return info.speed * 480
}

// Approximate items per second moved by an inserter without stack bonuses,
// from a chest. A swing is a rotation out and back, plus a little overhead.
// Taking from a moving belt is slower; the factor is a conservative estimate.
export function inserterThroughput(info, fromBelt) {
    let cycleTicks = 1 / info.rotation_speed + 1
    let rate = TICKS_PER_SECOND * (1 + info.stack_size_bonus) / cycleTicks
    return fromBelt ? rate * 0.7 : rate
}

// Crafts per second of one machine on a recipe.
export function machineCrafts(machineInfo, recipe) {
    return machineInfo.crafting_speed / recipe.energy_required
}

// Furnaces and assembling machines.
export function isMachineType(type) {
    return type === "furnace" || type === "assembling-machine"
}

let solidCache = new WeakMap()

// The names of the items which are not fluids.
export function solidItems(data) {
    if (!solidCache.has(data)) {
        solidCache.set(data, new Set(data.items.filter(i => i.type !== "fluid").map(i => i.key)))
    }
    return solidCache.get(data)
}

export function lookupRecipe(data, key) {
    let recipe = data.recipes.find(r => r.key === key)
    if (!recipe) {
        throw new Error("unknown recipe: " + key)
    }
    return recipe
}

// The inserters this generator knows how to reason about: no stack bonuses,
// and reaching one tile.
export const ALLOWED_INSERTERS = ["inserter", "fast-inserter"]
export const ALLOWED_POLES = ["small-electric-pole", "medium-electric-pole"]
