import { spec } from "./factory.js"
import { sheetHash, sheetWidth, sheetHeight } from "./icon.js"
import { previewModel } from "./blueprint/preview.js"

// Paints a layout as SVG: machines with their icons, belts with direction and
// tier, inserters as arrows in the direction they move items, pipes, poles with
// their wires, and labels where the factory connects to it.

const SVG_NS = "http://www.w3.org/2000/svg"
const BELT_COLORS = {yellow: "#d9b72a", red: "#d4503c", blue: "#3b8fd9", green: "#5cb85c"}
const DIRECTION_DEGREES = {0: 0, 4: 90, 8: 180, 12: 270}
const DIRECTION_VECTORS = {0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0]}
const MIN_TILE = 8
const MAX_TILE = 48

// Settings which survive re-rendering.
let tileSize = 22
let showCoverage = false
let showLabels = true

function displayName(name) {
    let item = spec.items.get(name)
    return item ? item.name : name
}

// Draws the icon of an object with icon_col and icon_row, cropped from the
// sprite sheet.
function drawIcon(parent, obj, x, y, size) {
    let crop = parent.append("svg")
        .attr("x", x)
        .attr("y", y)
        .attr("width", size)
        .attr("height", size)
        .attr("viewBox", `${obj.icon_col * 32} ${obj.icon_row * 32} 32 32`)
    crop.append("image")
        .attr("href", `images/sprite-sheet-${sheetHash}.png`)
        .attr("width", sheetWidth)
        .attr("height", sheetHeight)
}

// An arrow pointing up in a 1x1 box, turned to face a direction.
function arrowPath(direction, px, py, size, shaft) {
    let cx = px + size / 2
    let cy = py + size / 2
    let s = size
    let points = [[0, -0.42], [0.36, 0.0], [shaft, 0.0], [shaft, 0.42], [-shaft, 0.42], [-shaft, 0.0], [-0.36, 0.0]]
    let angle = DIRECTION_DEGREES[direction] * Math.PI / 180
    return points.map(([x, y]) => {
        let rx = x * Math.cos(angle) - y * Math.sin(angle)
        let ry = x * Math.sin(angle) + y * Math.cos(angle)
        return `${cx + rx * s},${cy + ry * s}`
    }).join(" ")
}

export function renderPreview(container, entities, options) {
    let model = previewModel(entities, spec.data, options)
    let wrap = container.append("div")
        .classed("blueprint-graphic", true)

    let controls = wrap.append("div")
        .classed("blueprint-graphic-controls", true)
    let draw = () => {
        svgHolder.selectAll("*").remove()
        paint(svgHolder, model)
    }
    controls.append("button")
        .attr("title", "Zoom out")
        .text("−")
        .on("click", () => {
            tileSize = Math.max(MIN_TILE, Math.round(tileSize * 0.8))
            draw()
        })
    controls.append("button")
        .attr("title", "Zoom in")
        .text("+")
        .on("click", () => {
            tileSize = Math.min(MAX_TILE, Math.round(tileSize * 1.25))
            draw()
        })
    for (let [text, get, set] of [
        ["Power coverage", () => showCoverage, v => { showCoverage = v }],
        ["Labels", () => showLabels, v => { showLabels = v }],
    ]) {
        let label = controls.append("label")
        label.append("input")
            .attr("type", "checkbox")
            .property("checked", get())
            .on("change", function() {
                set(this.checked)
                draw()
            })
        label.append("span")
            .text(" " + text)
    }
    let svgHolder = wrap.append("div")
        .classed("blueprint-graphic-scroll", true)
    draw()
    wrap.append("div")
        .classed("hint", true)
        .text("Hover a part for its name. Belts show their direction and tier (yellow, red, blue, green); arrows between machines and belts are inserters, pointing the way items move; blue lines are pipes; poles are joined by wires.")
}

function paint(holder, model) {
    let T = tileSize
    let b = model.bounds
    let px = x => (x - b.x) * T
    let py = y => (y - b.y) * T
    let svg = holder.append("svg")
        .attr("xmlns", SVG_NS)
        .attr("width", b.w * T)
        .attr("height", b.h * T)
        .classed("blueprint-svg", true)

    svg.append("rect")
        .attr("width", b.w * T)
        .attr("height", b.h * T)
        .attr("fill", "#1c1f24")
    // Tile grid.
    let grid = svg.append("g")
        .attr("stroke", "#2b3037")
        .attr("stroke-width", 1)
    for (let x = 0; x <= b.w; x++) {
        grid.append("line").attr("x1", x * T).attr("y1", 0).attr("x2", x * T).attr("y2", b.h * T)
    }
    for (let y = 0; y <= b.h; y++) {
        grid.append("line").attr("x1", 0).attr("y1", y * T).attr("x2", b.w * T).attr("y2", y * T)
    }

    let titled = (g, text) => g.append("title").text(text)

    if (showCoverage) {
        let cover = svg.append("g")
            .attr("fill", "#e6c84a")
            .attr("fill-opacity", 0.07)
            .attr("stroke", "#e6c84a")
            .attr("stroke-opacity", 0.25)
        for (let s of model.shapes) {
            if (s.kind === "pole") {
                cover.append("rect")
                    .attr("x", px(s.supply.x))
                    .attr("y", py(s.supply.y))
                    .attr("width", s.supply.size * T)
                    .attr("height", s.supply.size * T)
            }
        }
    }

    // Belts.
    for (let s of model.shapes.filter(s => s.kind === "belt")) {
        let g = svg.append("g")
        g.append("rect")
            .attr("x", px(s.x) + 1)
            .attr("y", py(s.y) + 1)
            .attr("width", T - 2)
            .attr("height", T - 2)
            .attr("fill", BELT_COLORS[s.tier])
            .attr("fill-opacity", 0.28)
            .attr("stroke", BELT_COLORS[s.tier])
            .attr("stroke-opacity", 0.55)
        g.append("polygon")
            .attr("points", arrowPath(s.direction, px(s.x), py(s.y), T, 0.12))
            .attr("fill", BELT_COLORS[s.tier])
            .attr("fill-opacity", 0.9)
        titled(g, displayName(s.name))
    }

    // Pipes.
    let pipeColor = "#5aa0dc"
    for (let s of model.shapes.filter(s => s.kind === "pipe")) {
        let g = svg.append("g")
        let cx = px(s.x) + T / 2
        let cy = py(s.y) + T / 2
        for (let d of s.links) {
            let [dx, dy] = DIRECTION_VECTORS[d]
            g.append("line")
                .attr("x1", cx).attr("y1", cy)
                .attr("x2", cx + dx * T / 2).attr("y2", cy + dy * T / 2)
                .attr("stroke", pipeColor)
                .attr("stroke-width", T * 0.3)
        }
        g.append("circle")
            .attr("cx", cx).attr("cy", cy)
            .attr("r", T * 0.2)
            .attr("fill", pipeColor)
        titled(g, "Pipe")
    }
    for (let s of model.shapes.filter(s => s.kind === "underground")) {
        let g = svg.append("g")
        let cx = px(s.x) + T / 2
        let cy = py(s.y) + T / 2
        let [dx, dy] = DIRECTION_VECTORS[s.direction]
        // The opening faces the direction the entity does.
        g.append("line")
            .attr("x1", cx).attr("y1", cy)
            .attr("x2", cx + dx * T / 2).attr("y2", cy + dy * T / 2)
            .attr("stroke", pipeColor)
            .attr("stroke-width", T * 0.3)
        g.append("rect")
            .attr("x", cx - T * 0.28).attr("y", cy - T * 0.28)
            .attr("width", T * 0.56).attr("height", T * 0.56)
            .attr("fill", "#2d5f8f")
            .attr("stroke", pipeColor)
        titled(g, "Underground pipe")
    }

    // Machines.
    for (let s of model.shapes.filter(s => s.kind === "machine")) {
        let g = svg.append("g")
        g.append("rect")
            .attr("x", px(s.x) + 1)
            .attr("y", py(s.y) + 1)
            .attr("width", s.w * T - 2)
            .attr("height", s.h * T - 2)
            .attr("rx", 3)
            .attr("fill", "#2a2f38")
            .attr("stroke", "#7d8898")
        let item = spec.items.get(s.name)
        let size = Math.min(s.w, s.h) * T * 0.62
        if (item) {
            drawIcon(g, item, px(s.x) + (s.w * T - size) / 2, py(s.y) + (s.h * T - size) / 2, size)
        }
        let tip = displayName(s.name)
        if (s.recipe) {
            let recipe = spec.recipes.get(s.recipe)
            if (recipe) {
                // The recipe is the more useful thing to see: its icon sits in the corner.
                let rs = Math.min(s.w, s.h) * T * 0.4
                drawIcon(g, recipe, px(s.x + s.w) - rs - 3, py(s.y + s.h) - rs - 3, rs)
                tip += `: ${recipe.name}`
            }
        }
        titled(g, tip)
    }

    // Inserters.
    for (let s of model.shapes.filter(s => s.kind === "inserter")) {
        let g = svg.append("g")
        g.append("polygon")
            .attr("points", arrowPath(s.direction, px(s.x), py(s.y), T, 0.15))
            .attr("fill", BELT_COLORS[s.tier])
            .attr("stroke", "#101215")
            .attr("stroke-width", 1)
        titled(g, `${displayName(s.name)} (moves items ${["up", "right", "down", "left"][s.direction / 4]})`)
    }

    // Wires and poles.
    let wires = svg.append("g")
        .attr("stroke", "#d98b5f")
        .attr("stroke-opacity", 0.6)
        .attr("stroke-width", Math.max(1, T / 14))
    for (let w of model.wires) {
        wires.append("line")
            .attr("x1", px(w.x1)).attr("y1", py(w.y1))
            .attr("x2", px(w.x2)).attr("y2", py(w.y2))
    }
    for (let s of model.shapes.filter(s => s.kind === "pole")) {
        let g = svg.append("g")
        g.append("circle")
            .attr("cx", px(s.x + s.w / 2))
            .attr("cy", py(s.y + s.h / 2))
            .attr("r", Math.max(2, T * 0.17))
            .attr("fill", "#e6c84a")
            .attr("stroke", "#101215")
        titled(g, displayName(s.name))
    }

    // Where the factory connects.
    if (showLabels) {
        let colors = {input: "#6fd16f", output: "#f0a24b", fluid: "#6fb7f0"}
        for (let l of model.labels) {
            let g = svg.append("g")
            let cx = px(l.x) + T / 2
            let cy = py(l.y) + T / 2
            g.append("circle")
                .attr("cx", cx).attr("cy", cy)
                .attr("r", T * 0.32)
                .attr("fill", "none")
                .attr("stroke", colors[l.type])
                .attr("stroke-width", 2)
            let prefix = {input: "in: ", output: "out: ", fluid: ""}[l.type]
            let text = g.append("text")
                .attr("fill", colors[l.type])
                .attr("font-size", Math.max(9, T * 0.55))
                .attr("font-family", "sans-serif")
                .text(prefix + l.text.split(" + ").map(displayName).join(" + "))
            if (l.side === "right") {
                text.attr("x", cx + T * 0.5).attr("y", cy + T * 0.2)
            } else if (l.side === "bottom") {
                text.attr("x", cx).attr("y", cy + T * 1.4).attr("text-anchor", "middle")
            } else {
                text.attr("x", cx).attr("y", cy - T * 0.55 - (l.row || 0) * T * 0.9).attr("text-anchor", "middle")
            }
            titled(g, {input: "Supply this here", output: "Take the product from here", fluid: "Connect this fluid here"}[l.type])
        }
    }
}
