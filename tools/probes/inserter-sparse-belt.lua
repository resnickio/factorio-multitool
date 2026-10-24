-- What each inserter takes from a belt that is not full: items are fed in at a
-- set rate (alternating lanes) onto a 30 tile belt, removed at the end, and an
-- inserter beside the middle takes into a chest. If it keeps up it takes all
-- of them; the rate it takes when it cannot is what to rely on.
DEFER = true
local WARMUP = 300
local TICKS = 1800
local types = {"inserter", "fast-inserter", "stack-inserter", "long-handed-inserter"}
local feeds = {1, 2, 3, 5}
local rows = {}
local row = 0
for _, n in pairs(types) do
  for _, feed in pairs(feeds) do
    row = row + 1
    local y = 5 * row
    local belts = {}
    for x = 0, 29 do
      belts[#belts + 1] = surface.create_entity{name = "transport-belt", position = {x + 0.5, y + 0.5}, direction = defines.direction.east, force = force}
    end
    local dy = (n == "long-handed-inserter") and 2 or 1
    surface.create_entity{name = n, position = {15.5, y + 0.5 + dy}, direction = defines.direction.north, force = force}
    local dst = surface.create_entity{name = "steel-chest", position = {15.5, y + 0.5 + 2 * dy}, force = force}
    local eei = surface.create_entity{name = "electric-energy-interface", position = {17.5, y + 0.5 + dy}, force = force}
    eei.power_production = 1e9 / 60
    eei.electric_buffer_size = 1e9
    eei.energy = 1e9
    surface.create_entity{name = "medium-electric-pole", position = {16.5, y + 0.5 + dy}, force = force}
    rows[#rows + 1] = {key = n .. " fed " .. feed .. "/s", feed = feed, belts = belts, dst = dst, at_warmup = 0, fed = 0, due = 0, lane = 1}
  end
end
storage.rows = rows
storage.start = game.tick
script.on_event(defines.events.on_tick, function(e)
  local elapsed = e.tick - storage.start
  for _, r in pairs(storage.rows) do
    r.due = r.due + r.feed / 60
    while r.due >= 1 do
      local line = r.belts[1].get_transport_line(r.lane)
      if line.can_insert_at_back() then
        line.insert_at_back({name = "iron-plate", count = 1})
        if elapsed > WARMUP then r.fed = r.fed + 1 end
      end
      r.lane = 3 - r.lane
      r.due = r.due - 1
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
      report("sparse belt, " .. r.key .. ": took " .. string.format("%.2f", n / (TICKS / 60)) .. "/s of " .. string.format("%.2f", r.fed / (TICKS / 60)) .. "/s fed")
    end
    script.on_event(defines.events.on_tick, nil)
    finish()
  end
end)
