// Turns placed entities into blueprint JSON, and into a text preview.

import { gameVersion } from "./codec.js"
import { entityInfo, NORTH, EAST, SOUTH, WEST } from "./entities.js"

// Copper wire connector of an electric pole, in blueprint wire lists.
const POLE_COPPER = 5

// Wires linking the poles into one network: the shortest set of connections
// which reaches every pole, using only connections within wire reach. Returns
// pairs of indexes into the entity list.
export function poleWires(entities, data) {
    let poles = []
    entities.forEach((e, i) => {
        if (entityInfo(data, e.name).type === "electric-pole") {
            poles.push(i)
        }
    })
    let centre = e => [e.x + e.w / 2, e.y + e.h / 2]
    let reach = (a, b) => {
        let d = Math.min(entityInfo(data, entities[a].name).maximum_wire_distance, entityInfo(data, entities[b].name).maximum_wire_distance)
        let [ax, ay] = centre(entities[a])
        let [bx, by] = centre(entities[b])
        let dist = Math.hypot(ax - bx, ay - by)
        return dist <= d ? dist : null
    }
    // Prim's algorithm.
    let wires = []
    if (poles.length === 0) {
        return wires
    }
    let inTree = new Set([poles[0]])
    while (inTree.size < poles.length) {
        let best = null
        for (let a of inTree) {
            for (let b of poles) {
                if (inTree.has(b)) {
                    continue
                }
                let dist = reach(a, b)
                if (dist !== null && (best === null || dist < best.dist)) {
                    best = {a, b, dist}
                }
            }
        }
        if (best === null) {
            break
        }
        wires.push([best.a, best.b])
        inTree.add(best.b)
    }
    return wires
}

// entities: as returned by the placers. label: shown in the blueprint's name.
// iconNames: up to four item names for the blueprint's icons.
export function makeBlueprint(entities, label, iconNames, data) {
    let list = entities.map((e, i) => {
        let entity = {
            entity_number: i + 1,
            name: e.name,
            position: {x: e.x + e.w / 2, y: e.y + e.h / 2},
        }
        if (e.direction) {
            entity.direction = e.direction
        }
        if (e.recipe) {
            entity.recipe = e.recipe
        }
        return entity
    })
    return {
        item: "blueprint",
        label,
        version: gameVersion(),
        icons: iconNames.slice(0, 4).map((name, i) => ({signal: {name}, index: i + 1})),
        entities: list,
        wires: poleWires(entities, data).map(([a, b]) => [a + 1, POLE_COPPER, b + 1, POLE_COPPER]),
    }
}

const ARROW = {[NORTH]: "^", [EAST]: ">", [SOUTH]: "v", [WEST]: "<"}

// One character per tile: F furnace, A assembling machine, P pole, = pipe, O underground pipe, v for belts, and ) or ( for
// inserters, pointing where they drop items.
export function previewLayout(entities, data) {
    // Pipes can lie above and to the left of the machines.
    let left = Math.min(...entities.map(e => e.x))
    let top = Math.min(...entities.map(e => e.y))
    let width = Math.max(...entities.map(e => e.x + e.w)) - left
    let height = Math.max(...entities.map(e => e.y + e.h)) - top
    let grid = []
    for (let y = 0; y < height; y++) {
        grid.push(new Array(width).fill(" "))
    }
    for (let e of entities) {
        let type = entityInfo(data, e.name).type
        let ch = {furnace: "F", "assembling-machine": "A", "electric-pole": "P", pipe: "=", "pipe-to-ground": "O"}[type]
        if (type === "transport-belt") {
            ch = ARROW[e.direction]
        } else if (type === "inserter") {
            // An inserter's direction points at its pickup, so it drops the
            // other way.
            ch = {[NORTH]: "u", [EAST]: "(", [SOUTH]: "n", [WEST]: ")"}[e.direction]
        }
        for (let dx = 0; dx < e.w; dx++) {
            for (let dy = 0; dy < e.h; dy++) {
                grid[e.y + dy - top][e.x + dx - left] = ch
            }
        }
    }
    return grid.map(row => row.join("")).join("\n")
}
