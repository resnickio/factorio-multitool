// Helpers for reasoning about entities, using the dataset's blueprint_entities
// table (see tools/convert-data.mjs).

export const TICKS_PER_SECOND = 60

// Directions as used in blueprints.
export const NORTH = 0
export const EAST = 4
export const SOUTH = 8
export const WEST = 12

// The tile one step away in a direction.
export const STEP = {[NORTH]: [0, -1], [EAST]: [1, 0], [SOUTH]: [0, 1], [WEST]: [-1, 0]}

export function opposite(direction) {
    return (direction + 8) % 16
}

// Rotates a vector (given as facing north) to face a direction.
function rotate([x, y], direction) {
    switch (direction) {
    case NORTH: return [x, y]
    case EAST: return [-y, x]
    case SOUTH: return [-x, -y]
    default: return [y, -x]
    }
}

// The fluid input connections of a square machine facing a direction, in the
// order the recipe's fluids use them. Each gives the machine tile it is on
// (tx, ty, from the machine's top-left), the tile outside it (outX, outY), and
// the direction it opens in. Positions in the data are from the centre.
export function fluidInputPorts(info, direction) {
    let half = (info.width - 1) / 2
    return info.fluid_inputs.map(port => {
        let [rx, ry] = rotate(port.position, direction)
        let facing = (port.direction + direction) % 16
        let [dx, dy] = STEP[facing]
        let tx = rx + half
        let ty = ry + half
        return {tx, ty, outX: tx + dx, outY: ty + dy, facing}
    })
}

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

// The fluid ingredients of a recipe, in the order the machine's fluid inputs
// are used.
export function fluidIngredients(data, recipe) {
    let solids = solidItems(data)
    return recipe.ingredients.filter(i => !solids.has(i.name))
}

// The rows of a machine (from its top) which can hold inserters, nearest the
// middle first, given rows taken by fluid connections.
export function insertRows(size, taken) {
    let mid = Math.floor(size / 2)
    let rows = []
    for (let r = 0; r < size; r++) {
        if (!taken.has(r)) {
            rows.push(r)
        }
    }
    return rows.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
}

// Machines whose fluid connections have been checked in the game.
export const FLUID_MACHINES = ["chemical-plant"]

// The inserters this generator knows how to reason about: no stack bonuses,
// and reaching one tile.
export const ALLOWED_INSERTERS = ["inserter", "fast-inserter"]
export const ALLOWED_POLES = ["small-electric-pole", "medium-electric-pole"]
