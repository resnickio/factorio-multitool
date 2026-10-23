// Turns placed entities into blueprint JSON, and into a text preview.

import { gameVersion } from "./codec.js"
import { entityInfo, NORTH, EAST, SOUTH, WEST } from "./entities.js"

// entities: as returned by the placers. label: shown in the blueprint's name.
// iconNames: up to four item names for the blueprint's icons.
export function makeBlueprint(entities, label, iconNames) {
    let list = entities.map((e, i) => {
        let entity = {
            entity_number: i + 1,
            name: e.name,
            position: {x: e.x + e.w / 2, y: e.y + e.h / 2},
        }
        if (e.direction) {
            entity.direction = e.direction
        }
        return entity
    })
    return {
        item: "blueprint",
        label,
        version: gameVersion(),
        icons: iconNames.slice(0, 4).map((name, i) => ({signal: {name}, index: i + 1})),
        entities: list,
    }
}

const ARROW = {[NORTH]: "^", [EAST]: ">", [SOUTH]: "v", [WEST]: "<"}

// One character per tile: F furnace, P pole, arrows for belts (lowercase v)
// and inserters (> and <), which point where items are dropped.
export function previewLayout(entities, data) {
    let width = Math.max(...entities.map(e => e.x + e.w))
    let height = Math.max(...entities.map(e => e.y + e.h))
    let grid = []
    for (let y = 0; y < height; y++) {
        grid.push(new Array(width).fill(" "))
    }
    for (let e of entities) {
        let type = entityInfo(data, e.name).type
        let ch = {furnace: "F", "electric-pole": "P"}[type]
        if (type === "transport-belt") {
            ch = ARROW[e.direction]
        } else if (type === "inserter") {
            ch = {[NORTH]: "n", [EAST]: ")", [SOUTH]: "u", [WEST]: "("}[e.direction]
        }
        for (let dx = 0; dx < e.w; dx++) {
            for (let dy = 0; dy < e.h; dy++) {
                grid[e.y + dy][e.x + dx] = ch
            }
        }
    }
    return grid.map(row => row.join("")).join("\n")
}
