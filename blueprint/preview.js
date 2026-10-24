// A drawable description of a layout: the shapes to paint for each entity,
// the wires between poles, and labels where the layout meets the rest of the
// factory. It has no drawing code of its own, so it can be tested without a
// browser; blueprint_preview.js paints it.
//
// Everything is in tiles, in the layout's coordinates.

import { entityInfo, opposite, STEP, NORTH, EAST, SOUTH, WEST } from "./entities.js"

// How belts and inserters are coloured, as in the game.
const BELT_TIERS = {
    "transport-belt": "yellow",
    "fast-transport-belt": "red",
    "express-transport-belt": "blue",
    "turbo-transport-belt": "green",
}
const INSERTER_TIERS = {
    "inserter": "yellow",
    "fast-inserter": "blue",
    "long-handed-inserter": "red",
    "bulk-inserter": "green",
    "stack-inserter": "green",
}

// Approximate width of a label, in tiles.
function labelWidth(text) {
    return text.length * 0.45 + 1
}

// entities: as returned by the placers. Options:
//   wires: pairs of 1-based entity numbers and connector ids, as in a blueprint
//          (so [[1, 5, 2, 5], ...]); only the entity numbers are used
//   connections: the placer's connection points (inputs, output, fluids)
export function previewModel(entities, data, {wires = [], connections = null} = {}) {
    let types = entities.map(e => entityInfo(data, e.name).type)
    let at = new Map()
    entities.forEach((e, i) => {
        for (let dx = 0; dx < e.w; dx++) {
            for (let dy = 0; dy < e.h; dy++) {
                at.set(`${e.x + dx},${e.y + dy}`, i)
            }
        }
    })
    let opens = i => types[i] === "pipe" ? [NORTH, EAST, SOUTH, WEST] : [entities[i].direction]

    let shapes = []
    entities.forEach((e, i) => {
        let base = {name: e.name, x: e.x, y: e.y, w: e.w, h: e.h}
        switch (types[i]) {
        case "transport-belt":
            shapes.push({...base, kind: "belt", direction: e.direction, tier: BELT_TIERS[e.name] || "yellow"})
            break
        case "inserter":
            // The direction points at the pickup, so items move the other way.
            shapes.push({...base, kind: "inserter", direction: opposite(e.direction), tier: INSERTER_TIERS[e.name] || "yellow"})
            break
        case "electric-pole": {
            let reach = entityInfo(data, e.name).supply_area_distance
            shapes.push({...base, kind: "pole", supply: {x: e.x + e.w / 2 - reach, y: e.y + e.h / 2 - reach, size: reach * 2}})
            break
        }
        case "pipe": {
            let links = []
            for (let d of [NORTH, EAST, SOUTH, WEST]) {
                let [dx, dy] = STEP[d]
                let n = at.get(`${e.x + dx},${e.y + dy}`)
                if (n !== undefined && (types[n] === "pipe" || types[n] === "pipe-to-ground") && opens(n).includes(opposite(d))) {
                    links.push(d)
                }
            }
            shapes.push({...base, kind: "pipe", links})
            break
        }
        case "pipe-to-ground":
            shapes.push({...base, kind: "underground", direction: e.direction})
            break
        default:
            // Furnaces and assembling machines.
            shapes.push({...base, kind: "machine", recipe: e.recipe || null})
        }
    })

    let wireShapes = wires.map(([a, , b]) => {
        let ea = entities[a - 1]
        let eb = entities[b - 1]
        return {
            kind: "wire",
            x1: ea.x + ea.w / 2, y1: ea.y + ea.h / 2,
            x2: eb.x + eb.w / 2, y2: eb.y + eb.h / 2,
        }
    })

    // Labels where the layout meets the rest of the factory.
    let labels = []
    if (connections) {
        for (let input of connections.inputs) {
            labels.push({type: "input", x: input.x, y: input.y, side: "right", text: input.items.join(" + ")})
        }
        if (connections.output) {
            labels.push({type: "output", x: connections.output.x, y: connections.output.y, side: "bottom", text: connections.output.item})
        }
        for (let fluid of connections.fluids || []) {
            labels.push({type: "fluid", x: fluid.x, y: fluid.y - 1, side: "top", text: fluid.fluid})
        }
    }

    // Neighbouring labels above the layout would run into each other, so
    // alternate them between two rows.
    labels.filter(l => l.side === "top").sort((a, b) => a.x - b.x).forEach((l, i) => {
        l.row = i % 2
    })

    // The area to paint: everything, with room for the labels.
    let x1 = Math.min(...entities.map(e => e.x))
    let y1 = Math.min(...entities.map(e => e.y))
    let x2 = Math.max(...entities.map(e => e.x + e.w))
    let y2 = Math.max(...entities.map(e => e.y + e.h))
    for (let l of labels) {
        let w = labelWidth(l.text)
        if (l.side === "right") {
            x2 = Math.max(x2, l.x + 1 + w)
        } else if (l.side === "bottom") {
            y2 = Math.max(y2, l.y + 2.5)
            x2 = Math.max(x2, l.x + w / 2 + 1)
            x1 = Math.min(x1, l.x - w / 2)
        } else {
            y1 = Math.min(y1, l.y - 1.5 - 0.9 * (l.row || 0))
            x2 = Math.max(x2, l.x + w / 2 + 1)
            x1 = Math.min(x1, l.x - w / 2)
        }
    }
    let pad = 1
    return {
        shapes,
        wires: wireShapes,
        labels,
        bounds: {x: Math.floor(x1) - pad, y: Math.floor(y1) - pad, w: Math.ceil(x2 - x1) + 2 * pad + 1, h: Math.ceil(y2 - y1) + 2 * pad + 1},
    }
}
