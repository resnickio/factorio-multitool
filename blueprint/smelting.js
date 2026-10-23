// Deterministic placement of smelting columns.
//
// A column is a vertical stack of furnaces, fed by an input belt on one side
// and emptied onto an output belt on the other. All belts flow south. With two
// columns the output belt is shared in the middle:
//
//   one column:   in | ins | furnace | ins | out
//   two columns:  in | ins | furnace | ins | out | ins | furnace | ins | in
//
// Entities are placed on a tile grid: x and y are the top-left tile, and w and
// h the size in tiles. Each furnace has its inserters on its middle row, and
// poles go in the free tile at its bottom edge.

import { entityInfo, NORTH, EAST, SOUTH, WEST } from "./entities.js"

// Params:
//   furnace, furnaces, columns (1 or 2), inputBelt, outputBelt,
//   inputInserter, outputInserter, pole
export function placeSmeltingColumns(params, data) {
    let furnace = entityInfo(data, params.furnace)
    if (furnace.width !== furnace.height) {
        throw new Error("only square furnaces are supported")
    }
    let size = furnace.width
    let mid = Math.floor(size / 2)
    let columns = params.columns
    let counts = columns === 1
        ? [params.furnaces]
        : [Math.ceil(params.furnaces / 2), Math.floor(params.furnaces / 2)]

    // Tile columns, left to right.
    let x
    if (columns === 1) {
        x = {belt1: 0, ins1: 1, furnace1: 2, out1: 2 + size, outBelt: 3 + size}
    } else {
        x = {
            belt1: 0, ins1: 1, furnace1: 2, out1: 2 + size, outBelt: 3 + size,
            out2: 4 + size, furnace2: 5 + size, ins2: 5 + 2 * size, belt2: 6 + 2 * size,
        }
    }

    let entities = []
    let add = (name, tx, ty, direction) => {
        let info = entityInfo(data, name)
        entities.push({name, x: tx, y: ty, w: info.width, h: info.height, direction})
    }

    let rows = Math.max(...counts) * size
    for (let y = 0; y < rows; y++) {
        add(params.inputBelt, x.belt1, y, SOUTH)
        add(params.outputBelt, x.outBelt, y, SOUTH)
        if (columns === 2) {
            add(params.inputBelt, x.belt2, y, SOUTH)
        }
    }

    for (let c = 0; c < columns; c++) {
        let left = c === 0
        for (let i = 0; i < counts[c]; i++) {
            let y = i * size
            add(params.furnace, left ? x.furnace1 : x.furnace2, y, NORTH)
            // Inserters point in the direction items are dropped.
            add(params.inputInserter, left ? x.ins1 : x.ins2, y + mid, left ? EAST : WEST)
            add(params.outputInserter, left ? x.out1 : x.out2, y + mid, left ? EAST : WEST)
        }
    }

    // Poles: one per two furnaces, beside each inserter column. The pole next
    // to the left output inserters also reaches the right ones.
    let poleStep = 2
    let poleColumns = columns === 1 ? [[x.ins1, 0], [x.out1, 0]] : [[x.ins1, 0], [x.out1, 0], [x.ins2, 1]]
    for (let [tx, c] of poleColumns) {
        for (let i = 0; i < counts[c]; i += poleStep) {
            add(params.pole, tx, i * size + size - 1, NORTH)
        }
    }
    return {entities, width: columns === 1 ? 4 + size : 7 + 2 * size, height: rows}
}
