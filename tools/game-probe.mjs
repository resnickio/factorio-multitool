// Runs a Lua snippet once in a fresh headless Factorio server and prints what
// it reports. Used to check how the game behaves before relying on it.
//
//   node tools/game-probe.mjs --lua probe.lua [--blueprint-json file.json]
//        [--port 34320] [--work-dir DIR]
//
// The snippet runs after a flat concrete area (x -10..60, y -20..100) has been
// laid. It can use `report(text)` to add a line to the output, `surface`,
// `force`, and, if --blueprint-json is given, `BLUEPRINT` (the encoded string).
// Reading the result file finishes the run, and the server is stopped. A
// snippet which has to let game time pass sets `DEFER = true`, and calls
// `finish()` itself once it has its results.

import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { spawn } from "node:child_process"
import { encodeBlueprint } from "../blueprint/codec.js"

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1]
}
const GAME = args["game-dir"] || "D:/SteamLibrary/steamapps/common/Factorio"
const PORT = args.port || "34320"
const WORK = path.resolve(args["work-dir"] || path.join(process.env.TEMP, "factorio-probe"))
const body = fs.readFileSync(args.lua, "utf8")

let blueprint = ""
if (args["blueprint-json"]) {
    let json = JSON.parse(fs.readFileSync(args["blueprint-json"], "utf8"))
    blueprint = encodeBlueprint(json, bytes => new Uint8Array(zlib.deflateSync(bytes, {level: 9})))
}

fs.rmSync(WORK, {recursive: true, force: true})
fs.mkdirSync(path.join(WORK, "write", "scenarios", "probe"), {recursive: true})
fs.writeFileSync(path.join(WORK, "config.ini"), `[path]
read-data=${GAME}/data
write-data=${WORK.replace(/\\/g, "/")}/write
[general]
locale=en
`)
fs.writeFileSync(path.join(WORK, "server-settings.json"), JSON.stringify({
    name: "probe", description: "probe", visibility: {public: false, lan: false}, auto_pause: false,
    autosave_interval: 0, require_user_verification: false, max_players: 2, game_password: "",
}))
fs.writeFileSync(path.join(WORK, "map-gen-settings.json"), JSON.stringify({
    width: 512, height: 512, starting_area: "none", autoplace_controls: {},
    cliff_settings: {name: "cliff", cliff_elevation_0: 1024, cliff_elevation_interval: 40, richness: 0},
}))

const lua = `
local BLUEPRINT = "${blueprint}"
local lines = {}
function report(text) lines[#lines + 1] = tostring(text) end
DEFER = false
function finish() helpers.write_file("probe-result.txt", table.concat(lines, "\\n") .. "\\n", false) end
script.on_init(function()
  local surface = game.surfaces[1]
  local force = game.forces.player
  surface.request_to_generate_chunks({15, 40}, 4)
  surface.force_generate_chunk_requests()
  local area = {{-10, -20}, {60, 100}}
  for _, e in pairs(surface.find_entities(area)) do
    if e.type ~= "character" then e.destroy() end
  end
  local tiles = {}
  for x = -10, 60 do for y = -20, 100 do tiles[#tiles + 1] = {name = "concrete", position = {x, y}} end end
  surface.set_tiles(tiles)
  local ok, err = pcall(function()
${body}
  end)
  if not ok then report("ERROR: " .. tostring(err)) end
  if not DEFER then finish() end
end)
`
fs.writeFileSync(path.join(WORK, "write", "scenarios", "probe", "control.lua"), lua)

const log = fs.openSync(path.join(WORK, "server.log"), "w")
const child = spawn(path.join(GAME, "bin/x64/factorio.exe"), [
    "--config", path.join(WORK, "config.ini"),
    "--start-server-load-scenario", "probe",
    "--server-settings", path.join(WORK, "server-settings.json"),
    "--map-gen-settings", path.join(WORK, "map-gen-settings.json"),
    "--port", PORT,
], {stdio: ["ignore", log, log]})

const resultFile = path.join(WORK, "write", "script-output", "probe-result.txt")
const deadline = Date.now() + 120000
while (!fs.existsSync(resultFile)) {
    if (Date.now() > deadline) {
        console.log("timed out; server log tail:")
        console.log(fs.readFileSync(path.join(WORK, "server.log"), "utf8").split("\n").slice(-30).join("\n"))
        child.kill()
        process.exit(1)
    }
    await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 500))
console.log(fs.readFileSync(resultFile, "utf8"))
child.kill()
