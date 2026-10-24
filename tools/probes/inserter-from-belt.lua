DEFER = true
local TICKS = 900
local types = {"inserter", "fast-inserter", "bulk-inserter", "stack-inserter", "long-handed-inserter"}
local rows = {}
local belts = {}
for i, n in pairs(types) do
  local y = 4 * i
  local last
  for x = 0, 9 do
    belts[#belts + 1] = {surface.create_entity{name = "transport-belt", position = {x + 0.5, y + 0.5}, direction = defines.direction.east, force = force}, i}
  end
  local dy = (n == "long-handed-inserter") and 2 or 1
  -- The inserter is south of the belt and picks from it (direction north).
  local ins = surface.create_entity{name = n, position = {5.5, y + 0.5 + dy}, direction = defines.direction.north, force = force}
  local dst = surface.create_entity{name = "steel-chest", position = {5.5, y + 0.5 + 2 * dy}, force = force}
  local eei = surface.create_entity{name = "electric-energy-interface", position = {7.5, y + 0.5 + dy}, force = force}
  eei.power_production = 1e9 / 60
  eei.electric_buffer_size = 1e9
  eei.energy = 1e9
  surface.create_entity{name = "medium-electric-pole", position = {6.5, y + 0.5 + dy}, force = force}
  rows[n] = dst
end
storage.rows = rows
storage.belts = belts
storage.start = game.tick
script.on_event(defines.events.on_tick, function(e)
  for _, b in pairs(storage.belts) do
    local belt = b[1]
    if belt.position.x < 1 then
      for l = 1, 2 do
        local line = belt.get_transport_line(l)
        while line.can_insert_at_back() do line.insert_at_back({name = "iron-plate", count = 1}) end
      end
    end
  end
  if e.tick >= storage.start + TICKS then
    for n, dst in pairs(storage.rows) do
      report("from belt " .. n .. ": " .. dst.get_item_count("iron-plate") .. " items in " .. TICKS .. " ticks = " .. string.format("%.2f", dst.get_item_count("iron-plate") / (TICKS / 60)) .. "/s")
    end
    script.on_event(defines.events.on_tick, nil)
    finish()
  end
end)
