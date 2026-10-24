local names = {"inserter", "fast-inserter", "bulk-inserter", "long-handed-inserter", "stack-inserter"}
for _, n in pairs(names) do
  local p = prototypes.entity[n]
  if p then
    report(n .. ": rot=" .. tostring(p.get_inserter_rotation_speed and p.get_inserter_rotation_speed() or p.inserter_rotation_speed)
      .. " ext=" .. tostring(p.get_inserter_extension_speed and p.get_inserter_extension_speed() or p.inserter_extension_speed)
      .. " stackbonus=" .. tostring(p.inserter_stack_size_bonus)
      .. " grabless=" .. tostring(p.grab_less_to_match_belt_stack)
      .. " waitfull=" .. tostring(p.wait_for_full_hand))
  else
    report(n .. ": missing")
  end
end
report("force bonuses: inserter_stack_size_bonus=" .. tostring(force.inserter_stack_size_bonus) .. " bulk=" .. tostring(force.bulk_inserter_capacity_bonus) .. " non-stack=" .. tostring(force.inserter_stack_size_bonus))

-- Chest to chest over a fixed time, for each inserter.
DEFER = true
local TICKS = 600
local rows = {}
for i, n in pairs({"inserter", "fast-inserter", "bulk-inserter", "stack-inserter"}) do
  local y = 2 * i
  local src = surface.create_entity{name = "infinity-chest", position = {5.5, y + 0.5}, force = force}
  src.set_infinity_container_filter(1, {name = "iron-plate", count = 100, mode = "at-least"})
  local ins = surface.create_entity{name = n, position = {6.5, y + 0.5}, direction = defines.direction.west, force = force}
  local dst = surface.create_entity{name = "steel-chest", position = {7.5, y + 0.5}, force = force}
  local eei = surface.create_entity{name = "electric-energy-interface", position = {6.5, y - 0.5}, force = force}
  eei.power_production = 1e9 / 60
  eei.electric_buffer_size = 1e9
  eei.energy = 1e9
  local pole = surface.create_entity{name = "medium-electric-pole", position = {8.5, y - 0.5}, force = force}
  rows[n] = {dst = dst, ins = ins}
end
storage.rows = rows
storage.start = game.tick
script.on_nth_tick(TICKS, function(e)
  if e.tick >= storage.start + TICKS then
    for n, r in pairs(storage.rows) do
      report("chest-to-chest " .. n .. ": " .. r.dst.get_item_count("iron-plate") .. " items in " .. TICKS .. " ticks = " .. string.format("%.2f", r.dst.get_item_count("iron-plate") / (TICKS / 60)) .. "/s")
    end
    script.on_nth_tick(TICKS, nil)
    finish()
  end
end)
