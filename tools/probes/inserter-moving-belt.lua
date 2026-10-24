-- What each inserter takes from a belt which keeps moving: items are fed in at
-- the start of a 30 tile belt and removed at the end, and the inserter beside
-- the middle takes into a chest. Both lanes full, then only the lane nearest
-- the inserter, then only the far lane. Counts after a warm-up.
DEFER = true
local WARMUP = 300
local TICKS = 1200
local types = {"inserter", "fast-inserter", "stack-inserter", "long-handed-inserter"}
local modes = {{name = "both lanes", lanes = {1, 2}}, {name = "lane 1 only", lanes = {1}}, {name = "lane 2 only", lanes = {2}}}
local rows = {}
local row = 0
for _, n in pairs(types) do
  for _, mode in pairs(modes) do
    row = row + 1
    local y = 5 * row
    local belts = {}
    for x = 0, 29 do
      belts[#belts + 1] = surface.create_entity{name = "transport-belt", position = {x + 0.5, y + 0.5}, direction = defines.direction.east, force = force}
    end
    local dy = (n == "long-handed-inserter") and 2 or 1
    -- The inserter is south of the belt and picks from it (direction north).
    local ins = surface.create_entity{name = n, position = {15.5, y + 0.5 + dy}, direction = defines.direction.north, force = force}
    local dst = surface.create_entity{name = "steel-chest", position = {15.5, y + 0.5 + 2 * dy}, force = force}
    local eei = surface.create_entity{name = "electric-energy-interface", position = {17.5, y + 0.5 + dy}, force = force}
    eei.power_production = 1e9 / 60
    eei.electric_buffer_size = 1e9
    eei.energy = 1e9
    surface.create_entity{name = "medium-electric-pole", position = {16.5, y + 0.5 + dy}, force = force}
    rows[#rows + 1] = {key = n .. ", " .. mode.name, belts = belts, lanes = mode.lanes, dst = dst, at_warmup = 0}
  end
end
storage.rows = rows
storage.start = game.tick
script.on_event(defines.events.on_tick, function(e)
  local elapsed = e.tick - storage.start
  for _, r in pairs(storage.rows) do
    for _, l in pairs(r.lanes) do
      local line = r.belts[1].get_transport_line(l)
      while line.can_insert_at_back() do line.insert_at_back({name = "iron-plate", count = 1}) end
    end
    for x = 25, 30 do
      local b = r.belts[x]
      if b then
        for l = 1, 2 do b.get_transport_line(l).clear() end
      end
    end
    if elapsed == WARMUP then r.at_warmup = r.dst.get_item_count("iron-plate") end
  end
  if elapsed >= WARMUP + TICKS then
    for _, r in pairs(storage.rows) do
      local n = r.dst.get_item_count("iron-plate") - r.at_warmup
      report("moving belt, " .. r.key .. ": " .. string.format("%.2f", n / (TICKS / 60)) .. "/s")
    end
    script.on_event(defines.events.on_tick, nil)
    finish()
  end
end)
