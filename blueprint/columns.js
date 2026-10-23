// Deterministic placement of machine columns: furnaces or assembling machines.
//
// A column is a vertical stack of machines, fed by an input belt on one side
// and emptied onto an output belt on the other. All belts flow south. With two
// columns the output belt is shared in the middle:
//
//   one column:   in | ins | machine | ins | out
//   two columns:  in | ins | machine | ins | out | ins | machine | ins | in
//
// Entities are placed on a tile grid: x and y are the top-left tile, and w and
// h the size in tiles. Inserters go on the rows at the middle of each machine
// (one, or two for more throughput), and poles in the free tile at its bottom
// edge. In a blueprint an inserter's direction points at the tile it picks up
// from (checked against the game).
//
// Recipes with fluid ingredients turn each machine to face its fluid inputs at
// the input belt. Each fluid has a vertical collector pipe beyond the belt, and
// each machine reaches it through a pair of underground pipes which pass under
// the belt:
//
//   collector | exit ==tunnel== entry | machine port
//
// A second fluid tunnels further, under the first fluid's pipe. The collector
// extends one tile above the first machine, where the fluid is connected.

import {
    entityInfo, lookupRecipe, fluidIngredients, insertRows, fluidInputPorts, STEP, opposite,
    NORTH, SOUTH, EAST, WEST,
} from "./entities.js"
import { validateLayout } from "./validate.js"

// Params:
//   machine, machines, recipe, columns (1 or 2), inputBelt, outputBelt,
//   inputInserter, outputInserter, inputInserters, outputInserters (per
//   machine), pole, pipe, pipeToGround (for fluid recipes)
export function placeColumns(params, data) {
    // Poles go as far apart as still covers every inserter and machine.
    let best = null
    for (let step of [4, 3, 2, 1]) {
        let placed = place(params, data, step)
        best = placed
        if (validateLayout(placed.entities, data).errors.length === 0) {
            break
        }
    }
    return best
}

function place(params, data, poleStep) {
    let machine = entityInfo(data, params.machine)
    if (machine.width !== machine.height) {
        throw new Error("only square machines are supported")
    }
    let size = machine.width
    let mid = Math.floor(size / 2)
    let recipe = lookupRecipe(data, params.recipe)
    let fluids = fluidIngredients(data, recipe)
    let columns = params.columns
    let counts = columns === 1
        ? [params.machines]
        : [Math.ceil(params.machines / 2), Math.floor(params.machines / 2)]

    // Tile columns, left to right.
    let x
    if (columns === 1) {
        x = {belt1: 0, ins1: 1, machine1: 2, out1: 2 + size, outBelt: 3 + size}
    } else {
        x = {
            belt1: 0, ins1: 1, machine1: 2, out1: 2 + size, outBelt: 3 + size,
            out2: 4 + size, machine2: 5 + size, ins2: 5 + 2 * size, belt2: 6 + 2 * size,
        }
    }

    let entities = []
    let add = (name, tx, ty, direction, extra) => {
        let info = entityInfo(data, name)
        entities.push({name, x: tx, y: ty, w: info.width, h: info.height, direction, ...extra})
    }

    // A recipe of fluids alone has nothing to bring on a belt.
    let hasSolids = fluids.length < recipe.ingredients.length
    let rows = Math.max(...counts) * size
    for (let y = 0; y < rows; y++) {
        if (hasSolids) {
            add(params.inputBelt, x.belt1, y, SOUTH)
        }
        add(params.outputBelt, x.outBelt, y, SOUTH)
        if (columns === 2 && hasSolids) {
            add(params.inputBelt, x.belt2, y, SOUTH)
        }
    }

    let machineExtra = machine.type === "assembling-machine" ? {recipe: params.recipe} : {}
    for (let c = 0; c < columns; c++) {
        let left = c === 0
        // Fluid-fed machines face their inputs at the input belt.
        let facing = fluids.length === 0 ? NORTH : (left ? WEST : EAST)
        let ports = fluids.length === 0 ? [] : fluidInputPorts(machine, facing).slice(0, fluids.length)
        let taken = new Set(ports.map(p => p.ty))
        let inRows = insertRows(size, taken).slice(0, params.inputInserters)
        let outRows = insertRows(size, new Set()).slice(0, params.outputInserters)
        let insX = left ? x.ins1 : x.ins2
        for (let i = 0; i < counts[c]; i++) {
            let y = i * size
            let mx = left ? x.machine1 : x.machine2
            add(params.machine, mx, y, facing, machineExtra)
            for (let row of hasSolids ? inRows : []) {
                add(params.inputInserter, insX, y + row, left ? WEST : EAST)
            }
            for (let row of outRows) {
                add(params.outputInserter, left ? x.out1 : x.out2, y + row, left ? WEST : EAST)
            }
            ports.forEach((port, k) => {
                let [dx] = STEP[port.facing]
                let entryX = mx + port.outX
                let exitX = entryX + dx * (2 + 2 * k)
                // The opening of the entry faces the machine, the exit's faces away.
                add(params.pipeToGround, entryX, y + port.outY, opposite(port.facing))
                add(params.pipeToGround, exitX, y + port.outY, port.facing)
            })
        }
        // Collector pipes, from one tile above the first machine.
        ports.forEach((port, k) => {
            let [dx] = STEP[port.facing]
            let collectorX = x[left ? "machine1" : "machine2"] + port.outX + dx * (3 + 2 * k)
            for (let y = -1; y < counts[c] * size; y++) {
                add(params.pipe, collectorX, y, NORTH)
            }
        })
    }

    // Poles: one every poleStep machines, beside the inserters. The pole next
    // to the left output inserters also reaches the right ones. With fluids the
    // input side has no free tile beside the inserters, so those poles go
    // outside the fluid connections.
    let inputPole = (left) => {
        if (fluids.length === 0) {
            return {tx: left ? x.ins1 : x.ins2, row: size - 1}
        }
        return {tx: left ? x.ins1 - 2 : x.ins2 + 2, row: mid}
    }
    let poleColumns = [[inputPole(true), 0], [{tx: x.out1, row: size - 1}, 0]]
    if (columns === 2) {
        poleColumns.push([inputPole(false), 1])
    }
    for (let [{tx, row}, c] of poleColumns) {
        for (let i = 0; i < counts[c]; i += poleStep) {
            add(params.pole, tx, i * size + row, NORTH)
        }
    }
    return {entities, width: columns === 1 ? 4 + size : 7 + 2 * size, height: rows}
}
