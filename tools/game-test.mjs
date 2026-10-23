// Builds a blueprint sample in a real (headless) Factorio server and reports
// how it behaves: what each inserter picks up from and drops onto, whether
// everything has power, and how much the column actually produces.
//
//   node tools/game-test.mjs [--sample iron-4-furnaces] [--port 34299]
//        [--game-dir D:/SteamLibrary/steamapps/common/Factorio]
//        [--work-dir DIR] [--seconds 60] [--warmup 90]
//
// The server runs from its own data directory, so it does not touch your
// saves or configuration, and can run beside the game. It keeps running after
// the report, so you can join it (Multiplayer, Connect to address,
// localhost:<port>) and look. Stop it with the printed taskkill command.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { defaultParams } from "../blueprint/dsl.js"
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
const machine = sample.machine || DEFAULT_MACHINE
const params = {...defaultParams({recipe: sample.recipe, rate: sample.rate}, machine, data), ...sample.override}
const recipe = data.recipes.find(r => r.key === sample.recipe)
const inputs = recipe.ingredients.map(i => i.name)
const outputItem = recipe.results[0].name
const blueprint = fs.readFileSync(path.join(here, "samples", SAMPLE + ".txt"), "utf8").trim()

// Lay out the data directory.
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

const lua = `
local BLUEPRINT = "${blueprint}"
-- Each ingredient rides its own lane of the input belt; a single one uses both.
local INPUTS = {${inputs.map(i => '"' + i + '"').join(", ")}}
local OUTPUT_ITEM = "${outputItem}"
local COLUMNS = ${params.columns}
local FURNACE_SIZE = ${data.blueprint_entities[params.machine].width}
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

local function setup()
  -- Furnaces only take ingredients for recipes the force has unlocked.
  game.forces.player.recipes["${sample.recipe}"].enabled = true
  local surface = game.surfaces[1]
  surface.request_to_generate_chunks({15, 40}, 4)
  surface.force_generate_chunk_requests()
  local area = {{-10, -20}, {60, 100}}
  for _, e in pairs(surface.find_entities(area)) do
    if e.type ~= "character" then e.destroy() end
  end
  local tiles = {}
  for x = -10, 60 do
    for y = -20, 100 do
      tiles[#tiles + 1] = {name = "concrete", position = {x, y}}
    end
  end
  surface.set_tiles(tiles)

  local inv = game.create_inventory(1)
  local stack = inv[1]
  local result = stack.import_stack(BLUEPRINT)
  say("import_stack result: " .. tostring(result))
  local entities = stack.get_blueprint_entities()
  say("blueprint entities: " .. tostring(entities and #entities))
  stack.build_blueprint{surface = surface, force = game.forces.player, position = {x = 20, y = 30}, build_mode = defines.build_mode.forced}
  for pass = 1, 5 do
    for _, ghost in pairs(surface.find_entities_filtered{type = "entity-ghost", area = area}) do
      ghost.revive{}
    end
  end
  local left = #surface.find_entities_filtered{type = "entity-ghost", area = area}
  say("ghosts left after reviving: " .. left)
  state.surface = surface
  state.area = area

  local belts = surface.find_entities_filtered{type = "transport-belt", area = area}
  local minx, maxx, miny, maxy = 1e9, -1e9, 1e9, -1e9
  for _, b in pairs(belts) do
    minx = math.min(minx, b.position.x); maxx = math.max(maxx, b.position.x)
    miny = math.min(miny, b.position.y); maxy = math.max(maxy, b.position.y)
  end
  say(string.format("belts: %d, x %.1f..%.1f, y %.1f..%.1f", #belts, minx, maxx, miny, maxy))
  state.minx, state.miny, state.maxy = minx, miny, maxy
  state.inputs = {minx}
  if COLUMNS == 2 then state.inputs[2] = maxx end
  state.output_x = minx + 3 + FURNACE_SIZE
  local function belt_at(x, y)
    return surface.find_entity("transport-belt", {x, y}) or surface.find_entity("fast-transport-belt", {x, y}) or surface.find_entity("express-transport-belt", {x, y}) or surface.find_entity("turbo-transport-belt", {x, y})
  end
  state.belt_at = belt_at

  -- Power: an interface which makes plenty, inside the first pole's area.
  local poles = surface.find_entities_filtered{type = "electric-pole", area = area}
  say("poles: " .. #poles)
  local pole = poles[1]
  local eei = surface.create_entity{name = "electric-energy-interface", position = {pole.position.x - 3, pole.position.y}, force = game.forces.player}
  if eei then
    eei.power_production = 100000000 / 60
    eei.electric_buffer_size = 1000000000
    eei.energy = 1000000000
    say("energy interface placed at " .. serpent.line(eei.position))
  else
    say("could not place energy interface")
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
    local key = e.name .. " " .. status_name(e.status)
    counts[key] = (counts[key] or 0) + 1
  end
  for key, n in pairs(counts) do say(label .. " status " .. key .. " x" .. n) end
end

local produced = 0
local started_tick = nil
local fed = 0
local function network_report()
  local surface, area = state.surface, state.area
  local ids = {}
  for _, pole in pairs(surface.find_entities_filtered{type = "electric-pole", area = area}) do
    local id = pole.electric_network_id or -1
    ids[id] = (ids[id] or 0) + 1
  end
  for id, n in pairs(ids) do say("poles in electric network " .. tostring(id) .. ": " .. n) end
end

script.on_init(function()
  setup()
  network_report()
end)

script.on_event(defines.events.on_tick, function(event)
  if not state.surface then return end
  -- Feed the input belts, and empty the output belt.
  for _, x in pairs(state.inputs) do
    local belt = state.belt_at(x, state.miny)
    if belt then
      for line = 1, 2 do
        local l = belt.get_transport_line(line)
        local item = INPUTS[line] or INPUTS[1]
        for i = 1, 2 do
          if l.can_insert_at_back() then
            l.insert_at_back({name = item, count = 1})
            fed = fed + 1
          end
        end
      end
    end
  end
  local out = state.belt_at(state.output_x, state.maxy)
  if out then
    for line = 1, 2 do
      local removed = out.get_transport_line(line).remove_item({name = OUTPUT_ITEM, count = 100})
      if event.tick >= WARMUP then produced = produced + removed end
    end
  end
  if event.tick == 5 then status_report("tick 5") end
  if event.tick == 600 then
    status_report("tick 600")
    inserter_report()
  end
  if event.tick == WARMUP + SECONDS * 60 then
    say(string.format("produced %d %s in %d s after warm-up = %.3f/s (target ${sample.rate}/s); fed %d items in total", produced, OUTPUT_ITEM, SECONDS, produced / SECONDS, fed))
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
