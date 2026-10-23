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

import { entityInfo, NORTH, SOUTH, EAST, WEST } from "./entities.js"
import { validateLayout } from "./validate.js"

// Params:
//   machine, machines, recipe (for assembling machines), columns (1 or 2),
//   inputBelt, outputBelt, inputInserter, outputInserter,
//   inputInserters, outputInserters (1 or 2 per machine), pole
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
    let columns = params.columns
    let counts = columns === 1
        ? [params.machines]
        : [Math.ceil(params.machines / 2), Math.floor(params.machines / 2)]
    let insertRows = count => count === 2 ? [mid, mid - 1] : [mid]

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

    let rows = Math.max(...counts) * size
    for (let y = 0; y < rows; y++) {
        add(params.inputBelt, x.belt1, y, SOUTH)
        add(params.outputBelt, x.outBelt, y, SOUTH)
        if (columns === 2) {
            add(params.inputBelt, x.belt2, y, SOUTH)
        }
    }

    let recipe = machine.type === "assembling-machine" ? {recipe: params.recipe} : {}
    for (let c = 0; c < columns; c++) {
        let left = c === 0
        for (let i = 0; i < counts[c]; i++) {
            let y = i * size
            add(params.machine, left ? x.machine1 : x.machine2, y, NORTH, recipe)
            for (let row of insertRows(params.inputInserters)) {
                add(params.inputInserter, left ? x.ins1 : x.ins2, y + row, left ? WEST : EAST)
            }
            for (let row of insertRows(params.outputInserters)) {
                add(params.outputInserter, left ? x.out1 : x.out2, y + row, left ? WEST : EAST)
            }
        }
    }

    // Poles: one every poleStep machines, beside each inserter column. The
    // pole next to the left output inserters also reaches the right ones.
    let poleColumns = columns === 1 ? [[x.ins1, 0], [x.out1, 0]] : [[x.ins1, 0], [x.out1, 0], [x.ins2, 1]]
    for (let [tx, c] of poleColumns) {
        for (let i = 0; i < counts[c]; i += poleStep) {
            add(params.pole, tx, i * size + size - 1, NORTH)
        }
    }
    return {entities, width: columns === 1 ? 4 + size : 7 + 2 * size, height: rows}
}
