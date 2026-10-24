DEFER = true
local TICKS = 900
local types = {"inserter", "fast-inserter", "stack-inserter"}
local rows = {}
for i, n in pairs(types) do
  local y = 4 * i
  local belts = {}
  for x = 0, 9 do
    belts[#belts + 1] = surface.create_entity{name = "transport-belt", position = {x + 0.5, y + 0.5}, direction = defines.direction.east, force = force}
  end
  -- chest north of the belt, inserter between them, dropping south onto the belt (pickup north)
  local src = surface.create_entity{name = "infinity-chest", position = {3.5, y - 1.5}, force = force}
  src.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "at-least"})
  local ins = surface.create_entity{name = n, position = {3.5, y - 0.5}, direction = defines.direction.north, force = force}
  local eei = surface.create_entity{name = "electric-energy-interface", position = {5.5, y - 0.5}, force = force}
  eei.power_production = 1e9 / 60
  eei.electric_buffer_size = 1e9
  eei.energy = 1e9
  surface.create_entity{name = "medium-electric-pole", position = {4.5, y - 0.5}, force = force}
  rows[n] = {belts = belts, count = 0}
end
storage.rows = rows
storage.start = game.tick
script.on_event(defines.events.on_tick, function(e)
  if (e.tick - storage.start) % 20 == 0 then
    for n, r in pairs(storage.rows) do
      for _, b in pairs(r.belts) do
        for l = 1, 2 do
          local line = b.get_transport_line(l)
          r.count = r.count + line.get_item_count()
          line.clear()
        end
      end
    end
  end
  if e.tick >= storage.start + TICKS then
    for n, r in pairs(storage.rows) do
      report("to belt " .. n .. ": " .. r.count .. " items in " .. TICKS .. " ticks = " .. string.format("%.2f", r.count / (TICKS / 60)) .. "/s")
    end
    script.on_event(defines.events.on_tick, nil)
    finish()
  end
end)
