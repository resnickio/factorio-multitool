// Builds a blueprint sample in a real (headless) Factorio server and reports
// how it behaves: what each inserter picks up from and drops onto, whether
// everything has power, and how much the layout actually produces.
//
//   node tools/game-test.mjs [--sample iron-4-furnaces] [--port 34299]
//        [--game-dir D:/SteamLibrary/steamapps/common/Factorio]
//        [--work-dir DIR] [--seconds 60] [--warmup 90]
//        [--model qwen3.8:latest]
//
// With --model, the layout is chosen by that local Ollama model (as in the
// Blueprint tab) instead of by the built-in defaults, and the blueprint made
// from its answer is what gets built. (columns and chains).
//
// The layout says where it meets the rest of the factory (connection points):
// the test feeds the input belts, empties the output belt, and puts an
// infinite supply on each fluid pipe. The server runs from its own data
// directory, so it does not touch your saves or configuration, and can run
// beside the game. It keeps running after the report, so you can join it
// (Multiplayer, Connect to address, localhost:<port>) and look. Stop it with
// the printed taskkill command (or just run the test again: it stops the
// server it left behind first).

import fs from "node:fs"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"
import { defaultParams, buildColumnBlueprint } from "../blueprint/dsl.js"
import { askForLayout } from "../blueprint/llm.js"
import { encodeBlueprint } from "../blueprint/codec.js"
import { STACK_INSERTERS } from "../blueprint/entities.js"
import { SAMPLES, DEFAULT_MACHINE } from "./samples.mjs"

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1]
}
const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = args.sample || "iron-4-furnaces"
const PORT = args.port || "34299"
const GAME = args["game-dir"] || "D:/SteamLibrary/steamapps/common/Factorio"
const WORK = path.resolve(args["work-dir"] || path.join(process.env.TEMP, "factorio-bp-test"))
const SECONDS = parseInt(args.seconds || "60", 10)
// Time for the belts to fill before production is measured.
const WARMUP = parseInt(args.warmup || "90", 10)

const sample = SAMPLES[SAMPLE]
if (!sample) {
    throw new Error("unknown sample " + SAMPLE)
}
const data = JSON.parse(fs.readFileSync(path.join(here, "../data/space-age-2.1.23.json"), "utf8"))
// --stack true lets layouts use stack inserters (the Stack inserter technology).
if (args.stack === "true") {
    data.allowedInserters = STACK_INSERTERS
}
const deflate = bytes => new Uint8Array(zlib.deflateSync(bytes, {level: 9}))

// Works out the layout to build: its entities, connection points, the recipes
// to unlock, and the product to measure.
let layout
if (sample.line) {
    const { defaultLineParams, buildLineBlueprint } = await import("../blueprint/line.js")
    let spec = {root: {...sample.line.root, rate: sample.rate}, east: sample.line.east, west: sample.line.west}
    let params, result
    if (args.model) {
        const { askForLineLayout } = await import("../blueprint/llm.js")
        result = await askForLineLayout({provider: "ollama", model: args.model, maxAttempts: 6, spec, data})
        console.log(`${args.model}: ${result.ok ? "accepted" : "REJECTED"} after ${result.attempts} attempt(s)`)
        params = result.params
    } else {
        params = defaultLineParams(spec, data)
        result = buildLineBlueprint(params, spec, data)
    }
    if (!result.ok) {
        console.log("line rejected:\n" + result.errors.join("\n"))
        process.exit(1)
    }
    console.log("line layout:", JSON.stringify(params))
    layout = {
        entities: result.entities,
        connections: result.connections,
        blueprint: encodeBlueprint(result.blueprint, deflate),
        recipes: [spec.root.recipe, ...spec.east.map(s => s.recipe), ...spec.west.map(s => s.recipe)],
        product: data.recipes.find(r => r.key === spec.root.recipe).results[0].name,
        target: sample.rate,
    }
} else if (sample.chain) {
    const { defaultChainParams, buildChainBlueprint } = await import("../blueprint/chain.js")
    const { askForChainLayout } = await import("../blueprint/llm.js")
    let requirement = {recipe: sample.chain.downstream, rate: sample.rate, upstream: sample.chain.upstream}
    let machines = {upstream: sample.chain.upstreamMachine, downstream: sample.chain.downstreamMachine}
    let params, result
    if (args.model) {
        result = await askForChainLayout({provider: "ollama", model: args.model, maxAttempts: 6, requirement, machines, data})
        console.log(`${args.model}: ${result.ok ? "accepted" : "REJECTED"} after ${result.attempts} attempt(s)`)
        params = result.params
        if (params && params.notes) {
            console.log("model's notes:", params.notes)
        }
    } else {
        params = defaultChainParams(requirement, machines, data)
        result = buildChainBlueprint(params, requirement, data)
    }
    if (!result.ok) {
        console.log("chain rejected:\n" + result.errors.join("\n"))
        process.exit(1)
    }
    console.log("chain layout:", JSON.stringify({...params, notes: undefined}))
    layout = {
        entities: result.entities,
        connections: result.connections,
        blueprint: encodeBlueprint(result.blueprint, deflate),
        recipes: [sample.chain.upstream, sample.chain.downstream],
        product: data.recipes.find(r => r.key === sample.chain.downstream).results[0].name,
        target: sample.rate,
    }
} else {
    const machine = sample.machine || DEFAULT_MACHINE
    let requirement = {recipe: sample.recipe, rate: sample.rate}
    let params, result
    if (args.model) {
        result = await askForLayout({provider: "ollama", model: args.model, maxAttempts: 6, requirement, machine, data})
        console.log(`${args.model}: ${result.ok ? "accepted" : "REJECTED"} after ${result.attempts} attempt(s)`)
        if (!result.ok) {
            console.log(result.errors.join("\n"))
            process.exit(1)
        }
        params = result.params
        console.log("model's layout:", JSON.stringify({...params, notes: undefined}))
        if (params.notes) {
            console.log("model's notes:", params.notes)
        }
    } else {
        params = {...defaultParams(requirement, machine, data), ...sample.override}
        result = buildColumnBlueprint(params, requirement, data)
        if (!result.ok) {
            console.log("layout rejected:\n" + result.errors.join("\n"))
            process.exit(1)
        }
    }
    let blueprint = encodeBlueprint(result.blueprint, deflate)
    if (args.model) {
        fs.mkdirSync(path.join(here, "samples", "model"), {recursive: true})
        fs.writeFileSync(path.join(here, "samples", "model", SAMPLE + ".txt"), blueprint + "\n")
    }
    layout = {
        entities: result.entities,
        connections: result.connections,
        blueprint,
        recipes: [sample.recipe],
        product: data.recipes.find(r => r.key === sample.recipe).results[0].name,
        target: sample.rate,
    }
}

// Layout coordinates are tiles from the layout's own origin; the game places
// the blueprint somewhere else, so the test translates by the difference
// between the two bounding boxes.
const minX = Math.min(...layout.entities.map(e => e.x))
const minY = Math.min(...layout.entities.map(e => e.y))
const maxX = Math.max(...layout.entities.map(e => e.x + e.w))
const maxY = Math.max(...layout.entities.map(e => e.y + e.h))
const lua_list = (items, fn) => "{" + items.map(fn).join(", ") + "}"
const feeds = lua_list(layout.connections.inputs, f => `{x = ${f.x}, y = ${f.y}, items = ${lua_list(f.items, i => '"' + i + '"')}}`)
const sinks = lua_list([layout.connections.output], s => `{x = ${s.x}, y = ${s.y}, item = "${s.item}"}`)
const fluidSupplies = lua_list(layout.connections.fluids, f => `{x = ${f.x}, y = ${f.y}, fluid = "${f.fluid}"}`)
// Extra feeds some layouts have (belts supplied from outside).
const extraFeeds = lua_list(layout.connections.extraInputs || [], f => `{x = ${f.x}, y = ${f.y}, items = ${lua_list(f.items, i => '"' + i + '"')}}`)

// Stops servers an earlier run left on this data directory (they hold it open,
// so it could not be cleared), and no other Factorio process.
function stopServersOn(dir) {
    let config = path.join(dir, "config.ini").replace(/'/g, "''")
    let script = `Get-CimInstance Win32_Process -Filter "Name='factorio.exe'" | Where-Object { $_.CommandLine -like '*${config}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`
    let stopped = execFileSync("powershell", ["-NoProfile", "-Command", script], {encoding: "utf8"}).split(/\s+/).filter(Boolean)
    if (stopped.length > 0) {
        console.log(`stopped earlier test server pid ${stopped.join(", ")}`)
        execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3"])
    }
}

// Lay out the data directory.
stopServersOn(WORK)
fs.rmSync(WORK, {recursive: true, force: true})
fs.mkdirSync(path.join(WORK, "write", "scenarios", "bp-test"), {recursive: true})
fs.writeFileSync(path.join(WORK, "config.ini"), `[path]
read-data=${GAME}/data
write-data=${WORK.replace(/\\/g, "/")}/write
[general]
locale=en
`)
fs.writeFileSync(path.join(WORK, "server-settings.json"), JSON.stringify({
    name: "blueprint test",
    description: "Headless blueprint test",
    visibility: {public: false, lan: false},
    auto_pause: false,
    autosave_interval: 0,
    require_user_verification: false,
    max_players: 4,
    game_password: "",
    allow_commands: "admins-only",
}, null, 2))
fs.writeFileSync(path.join(WORK, "map-gen-settings.json"), JSON.stringify({
    width: 512, height: 512, starting_area: "none",
    autoplace_controls: {}, cliff_settings: {name: "cliff", cliff_elevation_0: 1024, cliff_elevation_interval: 40, richness: 0},
}))

const AREA_X1 = -20 - 20
const AREA_X2 = 60 + (maxX - minX)
const AREA_Y2 = 60 + (maxY - minY)
const lua = `
local BLUEPRINT = "${layout.blueprint}"
local RECIPES = ${lua_list(layout.recipes, r => '"' + r + '"')}
local FEEDS = ${feeds}
local EXTRA_FEEDS = ${extraFeeds}
local SINKS = ${sinks}
local FLUID_SUPPLIES = ${fluidSupplies}
local PRODUCT = "${layout.product}"
local TARGET = ${layout.target}
local JS_MIN_X, JS_MIN_Y = ${minX}, ${minY}
local SECONDS = ${SECONDS}
local WARMUP = ${WARMUP} * 60
local report = {}
local state = {}

local function say(s)
  report[#report + 1] = s
  log(s)
end

local function status_name(status)
  for name, value in pairs(defines.entity_status) do
    if value == status then return name end
  end
  return tostring(status)
end

local BELTS = {"transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt"}
local function belt_at(surface, x, y)
  for _, name in pairs(BELTS) do
    local belt = surface.find_entity(name, {x, y})
    if belt then return belt end
  end
end

local function setup()
  -- Machines only take ingredients for recipes the force has unlocked.
  for _, recipe in pairs(RECIPES) do
    game.forces.player.recipes[recipe].enabled = true
  end
  local surface = game.surfaces[1]
  surface.request_to_generate_chunks({15, 40}, 5)
  surface.force_generate_chunk_requests()
  local area = {{${AREA_X1}, -40}, {${AREA_X2}, ${AREA_Y2}}}
  for _, e in pairs(surface.find_entities(area)) do
    if e.type ~= "character" then e.destroy() end
  end
  local tiles = {}
  for x = ${AREA_X1}, ${AREA_X2} do
    for y = -40, ${AREA_Y2} do
      tiles[#tiles + 1] = {name = "concrete", position = {x, y}}
    end
  end
  surface.set_tiles(tiles)

  local inv = game.create_inventory(1)
  local stack = inv[1]
  say("import_stack result: " .. tostring(stack.import_stack(BLUEPRINT)))
  say("blueprint entities: " .. tostring(#stack.get_blueprint_entities()))
  stack.build_blueprint{surface = surface, force = game.forces.player, position = {x = 20, y = 30}, build_mode = defines.build_mode.forced}
  for pass = 1, 5 do
    for _, ghost in pairs(surface.find_entities_filtered{type = "entity-ghost", area = area}) do
      ghost.revive{}
    end
  end
  say("ghosts left after reviving: " .. #surface.find_entities_filtered{type = "entity-ghost", area = area})
  state.surface = surface
  state.area = area

  -- Where the layout's own origin ended up: the top-left of its bounding box.
  local min_x, min_y = 1e9, 1e9
  for _, e in pairs(surface.find_entities_filtered{area = area}) do
    local w = e.prototype.tile_width or 1
    local h = e.prototype.tile_height or 1
    if e.type ~= "character" then
      min_x = math.min(min_x, math.floor(e.position.x - w / 2 + 0.01))
      min_y = math.min(min_y, math.floor(e.position.y - h / 2 + 0.01))
    end
  end
  state.dx = min_x - JS_MIN_X
  state.dy = min_y - JS_MIN_Y
  say(string.format("layout origin in the game: (%d,%d)", min_x, min_y))
  local function at(c) return {c.x + state.dx + 0.5, c.y + state.dy + 0.5} end
  state.at = at

  -- Power: an interface which makes plenty, beside a pole.
  local poles = surface.find_entities_filtered{type = "electric-pole", area = area}
  say("poles: " .. #poles)
  local eei = nil
  local offsets = {{-3, 0}, {3, 0}, {0, -3}, {0, 3}, {-4, 2}, {4, 2}, {-4, -2}, {4, -2}, {0, -6}, {-6, 0}, {6, 0}}
  for _, pole in pairs(poles) do
    for _, o in pairs(offsets) do
      local pos = {pole.position.x + o[1], pole.position.y + o[2]}
      if surface.can_place_entity{name = "electric-energy-interface", position = pos, force = game.forces.player} then
        eei = surface.create_entity{name = "electric-energy-interface", position = pos, force = game.forces.player}
        break
      end
    end
    if eei then break end
  end
  if eei then
    eei.power_production = 100000000 / 60
    eei.electric_buffer_size = 1000000000
    eei.energy = 1000000000
    say("energy interface placed at " .. serpent.line(eei.position))
  else
    say("could not place energy interface")
  end

  -- Fluids: an infinite supply above the top of each collector pipe.
  for _, f in pairs(FLUID_SUPPLIES) do
    local p = at({x = f.x, y = f.y - 1})
    local pipe = surface.create_entity{name = "infinity-pipe", position = p, force = game.forces.player}
    if pipe then
      pipe.set_infinity_pipe_filter{name = f.fluid, percentage = 1, mode = "at-least"}
      say("supplying " .. f.fluid .. " at " .. serpent.line(pipe.position))
    else
      say("could not place a supply for " .. f.fluid)
    end
  end
end

local function inserter_report()
  local surface, area = state.surface, state.area
  local counts = {}
  for _, ins in pairs(surface.find_entities_filtered{type = "inserter", area = area}) do
    local pick = ins.pickup_target and ins.pickup_target.type or "none"
    local drop = ins.drop_target and ins.drop_target.type or "none"
    local key = ins.name .. ": " .. pick .. " -> " .. drop .. " (direction " .. tostring(ins.direction) .. ")"
    counts[key] = (counts[key] or 0) + 1
  end
  for key, n in pairs(counts) do say("inserters " .. key .. " x" .. n) end
end

local function status_report(label)
  local surface, area = state.surface, state.area
  local counts = {}
  for _, e in pairs(surface.find_entities_filtered{type = {"furnace", "assembling-machine", "inserter"}, area = area}) do
    local recipe = nil
    if e.type ~= "inserter" then recipe = e.get_recipe() end
    local key = e.name .. (recipe and (" [" .. recipe.name .. "]") or "") .. " " .. status_name(e.status)
    counts[key] = (counts[key] or 0) + 1
  end
  for key, n in pairs(counts) do say(label .. " status " .. key .. " x" .. n) end
end

local function network_report()
  local surface, area = state.surface, state.area
  local ids = {}
  for _, pole in pairs(surface.find_entities_filtered{type = "electric-pole", area = area}) do
    local id = pole.electric_network_id or -1
    ids[id] = (ids[id] or 0) + 1
  end
  for id, n in pairs(ids) do say("poles in electric network " .. tostring(id) .. ": " .. n) end
end

local produced = 0
local fed = 0
script.on_init(function()
  setup()
  network_report()
end)

local function feed(f)
  local belt = belt_at(state.surface, table.unpack(state.at(f)))
  if not belt then return end
  for line = 1, 2 do
    local l = belt.get_transport_line(line)
    local item = f.items[line] or f.items[1]
    for i = 1, 2 do
      if l.can_insert_at_back() then
        l.insert_at_back({name = item, count = 1})
        fed = fed + 1
      end
    end
  end
end

script.on_event(defines.events.on_tick, function(event)
  if not state.surface then return end
  for _, f in pairs(FEEDS) do feed(f) end
  for _, f in pairs(EXTRA_FEEDS) do feed(f) end
  for _, s in pairs(SINKS) do
    local out = belt_at(state.surface, table.unpack(state.at(s)))
    if out then
      for line = 1, 2 do
        local removed = out.get_transport_line(line).remove_item({name = s.item, count = 100})
        if event.tick >= WARMUP then produced = produced + removed end
      end
    end
  end
  if event.tick == 5 then status_report("tick 5") end
  if event.tick == 600 then
    status_report("tick 600")
    inserter_report()
  end
  if event.tick == WARMUP + SECONDS * 60 then
    say(string.format("produced %d %s in %d s after warm-up = %.3f/s (target %s/s); fed %d items in total", produced, PRODUCT, SECONDS, produced / SECONDS, tostring(TARGET), fed))
    status_report("end")
    helpers.write_file("bp-result.txt", table.concat(report, "\\n") .. "\\n", false)
  end
end)
`
fs.writeFileSync(path.join(WORK, "write", "scenarios", "bp-test", "control.lua"), lua)

const exe = path.join(GAME, "bin/x64/factorio.exe")
const log = fs.openSync(path.join(WORK, "server.log"), "w")
const child = spawn(exe, [
    "--config", path.join(WORK, "config.ini"),
    "--start-server-load-scenario", "bp-test",
    "--server-settings", path.join(WORK, "server-settings.json"),
    "--map-gen-settings", path.join(WORK, "map-gen-settings.json"),
    "--port", PORT,
], {detached: true, stdio: ["ignore", log, log]})
child.unref()
console.log(`started server pid ${child.pid} on UDP port ${PORT}; data in ${WORK}`)
console.log(`stop it with: taskkill /PID ${child.pid} /F`)

const resultFile = path.join(WORK, "write", "script-output", "bp-result.txt")
const deadline = Date.now() + (SECONDS + WARMUP + 120) * 1000
while (!fs.existsSync(resultFile)) {
    if (Date.now() > deadline) {
        console.log("timed out; server log tail:")
        console.log(fs.readFileSync(path.join(WORK, "server.log"), "utf8").split("\n").slice(-40).join("\n"))
        process.exit(1)
    }
    await new Promise(r => setTimeout(r, 2000))
}
console.log(fs.readFileSync(resultFile, "utf8"))
