// Converts the output of Factorio's own data dumps into the dataset format the
// calculator loads (see data/space-age-*.json).
//
// Inputs (all produced by the game itself):
//   factorio --dump-data              -> script-output/data-raw-dump.json
//   factorio --dump-prototype-locale  -> script-output/*-locale.json
//   factorio --dump-icon-sprites      -> script-output/<type>/<name>.png
//
// Usage:
//   node convert-data.mjs --out ../data/space-age-2.1.23.json [--write-sprites]
//
// Without --write-sprites the sprite sheet is built and hashed, but not saved.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import sharp from "sharp"

const args = parseArgs(process.argv.slice(2))
const DUMP = args["dump-dir"] || path.join(process.env.APPDATA, "Factorio", "script-output")
const GAME = args["game-dir"] || "D:/SteamLibrary/steamapps/common/Factorio"
const OUT = args["out"]
const SHEET_PREFIX = args["sheet-prefix"] || "../images/sprite-sheet"
const CELL = 32

if (!OUT) {
    console.error("--out is required")
    process.exit(1)
}

function parseArgs(argv) {
    let result = {}
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) {
            continue
        }
        let key = argv[i].slice(2)
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            result[key] = argv[++i]
        } else {
            result[key] = true
        }
    }
    return result
}

const raw = JSON.parse(fs.readFileSync(path.join(DUMP, "data-raw-dump.json"), "utf8"))

const localeCache = new Map()
function locale(file) {
    if (!localeCache.has(file)) {
        let p = path.join(DUMP, file + "-locale.json")
        let names = {}
        if (fs.existsSync(p)) {
            names = JSON.parse(fs.readFileSync(p, "utf8")).names
        }
        localeCache.set(file, names)
    }
    return localeCache.get(file)
}

function localName(files, name) {
    for (let f of files) {
        let n = locale(f)[name]
        if (n !== undefined) {
            return {en: n}
        }
    }
    console.warn("missing localized name:", name)
    return {en: name}
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const PREFIX = {"": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15}

function clean(x) {
    return Math.round(x * 1e9) / 1e9
}

function energy(s) {
    if (typeof s === "number") {
        return s
    }
    let m = /^\s*([0-9.eE+-]+)\s*([kMGTP]?)[WJ]\s*$/.exec(s)
    if (!m) {
        throw new Error("cannot parse energy: " + s)
    }
    return clean(parseFloat(m[1]) * PREFIX[m[2]])
}

// ---------------------------------------------------------------------------
// Icons. Objects are given an `_icon` file path, which is replaced with a
// sprite sheet position once the sheet is laid out.
// ---------------------------------------------------------------------------

const iconUsers = []
const iconFiles = new Map()  // path -> true

function iconPath(dir, name) {
    let p = path.join(DUMP, dir, name + ".png")
    return fs.existsSync(p) ? p : null
}

function setIcon(obj, ...candidates) {
    for (let [dir, name] of candidates) {
        let p = iconPath(dir, name)
        if (p) {
            obj._icon = p
            iconFiles.set(p, true)
            iconUsers.push(obj)
            return true
        }
    }
    console.warn("missing icon:", candidates.map(c => c.join("/")).join(" | "))
    return false
}

// Machine and belt icons are the same as their item's.
function entityIcon(obj, name) {
    return setIcon(obj, ["item", name], ["entity", name])
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const ITEM_TYPES = [
    "ammo", "armor", "blueprint", "blueprint-book", "capsule",
    "deconstruction-item", "fluid", "gun", "item", "item-with-entity-data",
    "module", "rail-planner", "repair-tool", "space-platform-starter-pack",
    "tool",
]

const protoItems = new Map()
for (let type of ITEM_TYPES) {
    for (let [name, proto] of Object.entries(raw[type] || {})) {
        protoItems.set(name, {type, proto})
    }
}

const subgroupGroup = new Map()
for (let [name, sg] of Object.entries(raw["item-subgroup"])) {
    subgroupGroup.set(name, sg.group)
}

function toArray(x) {
    if (x === undefined) {
        return []
    }
    if (Array.isArray(x)) {
        return x
    }
    if (typeof x === "object") {
        return Object.keys(x).length === 0 ? [] : Object.values(x)
    }
    return [x]
}

const BARREL_SUBGROUPS = new Set(["fill-barrel", "empty-barrel"])

function recipeCategories(proto) {
    if (proto.categories) {
        return proto.categories
    }
    return [proto.category || "crafting"]
}

function isRecycling(proto) {
    return recipeCategories(proto).includes("recycling")
}

function recipeIsCandidate(name, proto) {
    if (!Array.isArray(proto.ingredients) && proto.ingredients !== undefined && Object.keys(proto.ingredients).length !== 0) {
        return false
    }
    if (recipeCategories(proto).includes("parameters")) {
        return false
    }
    if (BARREL_SUBGROUPS.has(proto.subgroup)) {
        return false
    }
    return Array.isArray(proto.results) && proto.results.length > 0
}

// Items which are hidden are only worth keeping if something other than the
// auto-generated recycling recipes touches them.
const usedByRealRecipe = new Set()
for (let [name, proto] of Object.entries(raw.recipe)) {
    if (!recipeIsCandidate(name, proto) || isRecycling(proto)) {
        continue
    }
    for (let i of toArray(proto.ingredients)) {
        usedByRealRecipe.add(i.name)
    }
    for (let i of proto.results) {
        usedByRealRecipe.add(i.name)
    }
}

const items = []
const itemByKey = new Map()
for (let [name, {type, proto}] of [...protoItems].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (/-unknown$/.test(name) || name === "no-item") {
        continue
    }
    if (proto.hidden && !usedByRealRecipe.has(name)) {
        continue
    }
    let subgroup = proto.subgroup || "other"
    let item = {
        group: subgroupGroup.get(subgroup),
        key: name,
        localized_name: localName(type === "fluid" ? ["fluid", "item"] : ["item", "fluid"], name),
        order: proto.order || "",
        subgroup,
        type,
    }
    if (item.group === undefined) {
        console.warn("item with unknown subgroup:", name, subgroup)
        continue
    }
    if (type !== "fluid") {
        item.stack_size = proto.stack_size
    }
    if (!setIcon(item, [type === "fluid" ? "fluid" : "item", name])) {
        continue
    }
    items.push(item)
    itemByKey.set(name, item)
}

// ---------------------------------------------------------------------------
// Fluids, fuel, modules, spoilage
// ---------------------------------------------------------------------------

const fluids = []
for (let [name, proto] of Object.entries(raw.fluid)) {
    if (!itemByKey.has(name)) {
        continue
    }
    let f = {item_key: name, default_temperature: proto.default_temperature}
    if (proto.heat_capacity !== undefined) {
        f.heat_capacity = energy(proto.heat_capacity)
    }
    if (proto.max_temperature !== undefined) {
        f.max_temperature = proto.max_temperature
    }
    if (proto.fuel_value !== undefined) {
        f.fuel_value = proto.fuel_value
    }
    fluids.push(f)
}

function fuelCategory(proto) {
    let cats = proto.fuel_categories || (proto.fuel_category ? [proto.fuel_category] : ["chemical"])
    if (cats.length !== 1) {
        console.warn("item with", cats.length, "fuel categories:", proto.name)
    }
    return cats[0]
}

const fuel = []
for (let item of items) {
    let {proto} = protoItems.get(item.key)
    if (item.type !== "fluid" && proto.fuel_value !== undefined) {
        fuel.push({
            category: fuelCategory(proto),
            item_key: item.key,
            value: energy(proto.fuel_value),
        })
    }
}

const MODULE_EFFECTS = ["consumption", "pollution", "productivity", "speed"]
const modules = []
for (let [name, proto] of Object.entries(raw.module)) {
    if (!itemByKey.has(name)) {
        continue
    }
    let effect = {}
    for (let e of MODULE_EFFECTS) {
        if (proto.effect[e] !== undefined) {
            effect[e] = proto.effect[e]
        }
    }
    modules.push({category: proto.category, effect, item_key: name})
}

const spoilage = []
for (let item of items) {
    let {proto} = protoItems.get(item.key)
    if (proto.spoil_ticks !== undefined && proto.spoil_result !== undefined) {
        spoilage.push({from_item: item.key, time: proto.spoil_ticks, to_item: proto.spoil_result})
    }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

// Expected number of items for one craft.
function productAmount(p) {
    let amount = (p.amount !== undefined ? p.amount : ((p.amount_min + p.amount_max) / 2)) + (p.extra_count_fraction || 0)
    let probability = 1
    if (p.independent_probability !== undefined) {
        probability = p.independent_probability
    } else if (p.shared_probability !== undefined) {
        probability = clean(p.shared_probability.max - p.shared_probability.min)
    } else if (p.probability !== undefined) {
        probability = p.probability
    }
    return {amount: clean(amount), probability}
}

function convertConditions(conditions) {
    return conditions.map(c => {
        let r = {property: c.property}
        if (c.min !== undefined) {
            r.min = c.min
        }
        if (c.max !== undefined) {
            r.max = c.max
        }
        return r
    })
}

const recipes = []
for (let [name, proto] of Object.entries(raw.recipe)) {
    if (!recipeIsCandidate(name, proto)) {
        continue
    }
    let ingredients = toArray(proto.ingredients).map(i => ({amount: i.amount, name: i.name}))
    let results = proto.results.map(p => {
        let {amount, probability} = productAmount(p)
        let r = {amount, name: p.name}
        if (probability !== 1) {
            r.probability = probability
        }
        return r
    })
    if (ingredients.some(i => !itemByKey.has(i.name)) || results.some(r => !itemByKey.has(r.name))) {
        continue
    }
    let main = proto.main_product || (results.length === 1 ? results[0].name : undefined)
    let subgroup = proto.subgroup
    if (!subgroup && main && itemByKey.has(main)) {
        subgroup = itemByKey.get(main).subgroup
    }
    let r = {
        allow_productivity: proto.allow_productivity === true,
        categories: recipeCategories(proto),
        energy_required: proto.energy_required !== undefined ? proto.energy_required : 0.5,
        ingredients,
        key: name,
        localized_name: localName(["recipe"], name),
        results,
        subgroup: subgroup || "other",
    }
    let order = proto.order
    if (!order && main && itemByKey.has(main)) {
        order = itemByKey.get(main).order
    }
    if (order) {
        r.order = order
    }
    if (proto.surface_conditions) {
        r.surface_conditions = convertConditions(proto.surface_conditions)
    }
    if (!setIcon(r, ["recipe", name])) {
        continue
    }
    recipes.push(r)
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function energySource(src) {
    let result = {type: src.type}
    if (src.type === "burner") {
        let cats = src.fuel_categories || (src.fuel_category ? [src.fuel_category] : [])
        if (cats.length !== 1) {
            console.warn("burner with", cats.length, "fuel categories:", cats)
        }
        result.fuel_category = cats[0]
    }
    result.emissions_per_minute = src.emissions_per_minute !== undefined ? src.emissions_per_minute : []
    return result
}

function effects(x) {
    if (x === undefined) {
        return undefined
    }
    if (typeof x === "string") {
        return [x]
    }
    return toArray(x)
}

function baseEntity(name, proto, itemIcon = true) {
    let e = {
        key: name,
        localized_name: localName(["entity", "item"], name),
    }
    if (itemIcon) {
        entityIcon(e, name)
    } else {
        setIcon(e, ["entity", name])
    }
    return e
}

function sorted(map) {
    return Object.entries(map || {}).sort((a, b) => a[0] < b[0] ? -1 : 1)
}

const crafting_machines = []
for (let type of ["assembling-machine", "furnace"]) {
    for (let [name, proto] of sorted(raw[type])) {
        if (!proto.crafting_categories) {
            continue
        }
        let e = baseEntity(name, proto)
        e.crafting_categories = proto.crafting_categories
        e.crafting_speed = proto.crafting_speed
        e.energy_source = energySource(proto.energy_source)
        e.energy_usage = energy(proto.energy_usage)
        e.module_slots = proto.module_slots || 0
        e.prod_bonus = (proto.effect_receiver && proto.effect_receiver.base_effect && proto.effect_receiver.base_effect.productivity) || 0
        let allowed = effects(proto.allowed_effects)
        if (allowed !== undefined) {
            e.allowed_effects = allowed
        }
        if (proto.surface_conditions) {
            e.surface_conditions = convertConditions(proto.surface_conditions)
        }
        crafting_machines.push(e)
    }
}
crafting_machines.sort((a, b) => a.key < b.key ? -1 : 1)

const rocket_silo = []
for (let [name, proto] of sorted(raw["rocket-silo"])) {
    let e = baseEntity(name, proto)
    e.allowed_effects = effects(proto.allowed_effects)
    e.crafting_categories = proto.crafting_categories
    e.crafting_speed = proto.crafting_speed
    e.energy_usage = energy(proto.energy_usage)
    e.module_slots = proto.module_slots || 0
    rocket_silo.push(e)
}

const mining_drills = []
for (let [name, proto] of sorted(raw["mining-drill"])) {
    let e = baseEntity(name, proto)
    e.energy_source = energySource(proto.energy_source)
    e.energy_usage = energy(proto.energy_usage)
    e.mining_speed = proto.mining_speed
    e.module_slots = proto.module_slots || 0
    e.resource_categories = proto.resource_categories
    e.takes_fluid = proto.input_fluid_box !== undefined
    let allowed = effects(proto.allowed_effects)
    if (allowed !== undefined) {
        e.allowed_effects = allowed
    }
    mining_drills.push(e)
}

const offshore_pumps = []
for (let [name, proto] of sorted(raw["offshore-pump"])) {
    let e = baseEntity(name, proto)
    e.pumping_speed = proto.pumping_speed
    offshore_pumps.push(e)
}

const agricultural_tower = []
for (let [name, proto] of sorted(raw["agricultural-tower"])) {
    let e = baseEntity(name, proto)
    e.energy_source = energySource(proto.energy_source)
    e.energy_usage = energy(proto.energy_usage)
    agricultural_tower.push(e)
}

const boilers = []
for (let [name, proto] of sorted(raw.boiler)) {
    let e = baseEntity(name, proto)
    e.energy_consumption = energy(proto.energy_consumption)
    e.energy_source = energySource(proto.energy_source)
    e.target_temperature = proto.target_temperature
    boilers.push(e)
}

const belts = []
for (let [name, proto] of sorted(raw["transport-belt"])) {
    let e = baseEntity(name, proto)
    e.speed = proto.speed
    belts.push(e)
}

const beaconName = Object.keys(raw.beacon)[0]
const beaconProto = raw.beacon[beaconName]
const beacon = {
    allowed_effects: effects(beaconProto.allowed_effects),
    distribution_effectivity: beaconProto.distribution_effectivity,
    energy_usage: energy(beaconProto.energy_usage),
    profile: beaconProto.profile.map(clean),
}

// ---------------------------------------------------------------------------
// Resources, plants, planets
// ---------------------------------------------------------------------------

function minableResults(minable) {
    if (minable.results) {
        return minable.results.map(p => ({amount: clean(productAmount(p).amount * productAmount(p).probability), name: p.name}))
    }
    return [{amount: minable.count || 1, name: minable.result}]
}

const resources = []
for (let [name, proto] of sorted(raw.resource)) {
    let e = baseEntity(name, proto, false)
    if (proto.category) {
        e.category = proto.category
    }
    e.mining_time = proto.minable.mining_time
    e.results = minableResults(proto.minable)
    if (proto.minable.required_fluid) {
        e.required_fluid = proto.minable.required_fluid
        e.fluid_amount = proto.minable.fluid_amount
    }
    resources.push(e)
}

const seedFor = new Map()
for (let item of items) {
    let {proto} = protoItems.get(item.key)
    if (proto.plant_result) {
        seedFor.set(proto.plant_result, item.key)
    }
}

const plants = []
for (let [name, proto] of sorted(raw.plant)) {
    let e = baseEntity(name, proto, false)
    e.growth_ticks = proto.growth_ticks
    e.order = proto.order
    e.results = minableResults(proto.minable)
    e.seed = seedFor.get(name)
    if (proto.surface_conditions) {
        e.surface_conditions = convertConditions(proto.surface_conditions)
    }
    plants.push(e)
}

const tileFluid = new Map()
for (let [name, tile] of Object.entries(raw.tile)) {
    if (tile.fluid) {
        tileFluid.set(name, tile.fluid)
    }
}

function plantGrowsOn(plantKey, tiles) {
    let proto = raw.plant[plantKey]
    // Plants with surface conditions are handled as recipe conditions.
    if (proto.surface_conditions) {
        return false
    }
    let autoplace = proto.autoplace
    if (!autoplace || !autoplace.tile_restriction) {
        return false
    }
    return autoplace.tile_restriction.some(t => tiles.has(t))
}

const planets = []
for (let [name, proto] of sorted(raw.planet)) {
    let e = {
        key: name,
        localized_name: localName(["space-location"], name),
        order: proto.order,
    }
    setIcon(e, ["space-location", name])
    let settings = proto.map_gen_settings.autoplace_settings
    let placed = new Set(Object.keys(settings.entity.settings))
    let offshore = new Set()
    let tiles = new Set(Object.keys(settings.tile.settings))
    for (let t of tiles) {
        if (tileFluid.has(t)) {
            offshore.add(tileFluid.get(t))
        }
    }
    e.resources = {
        offshore: [...offshore].sort(),
        plants: plants.filter(p => plantGrowsOn(p.key, tiles)).map(p => p.key),
        resource: resources.filter(r => placed.has(r.key)).map(r => r.key),
    }
    e.surface_properties = proto.surface_properties
    planets.push(e)
}

// The space platform is a surface, not a planet, but is treated like one.
for (let [name, proto] of sorted(raw.surface)) {
    let e = {
        key: name,
        localized_name: localName(["surface"], name),
        order: proto.order,
        resources: {offshore: [], plants: [], resource: []},
        surface_properties: proto.surface_properties,
    }
    setIcon(e, ["surface", name])
    planets.push(e)
}
planets.sort((a, b) => a.key < b.key ? -1 : 1)

const surface_properties = sorted(raw["surface-property"]).map(([name, p]) => ({
    default_value: p.default_value,
    name,
}))

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const groups = {}
for (let [name, g] of Object.entries(raw["item-group"])) {
    groups[name] = {order: g.order, subgroups: {}}
}
for (let [name, sg] of Object.entries(raw["item-subgroup"])) {
    if (groups[sg.group]) {
        groups[sg.group].subgroups[name] = sg.order
    }
}

// ---------------------------------------------------------------------------
// Sprite sheet
// ---------------------------------------------------------------------------

const clockPath = path.join(GAME, "data/core/graphics/clock-icon.png")
const slotPath = path.join(GAME, "data/core/graphics/icons/mip/empty-module-slot.png")

async function loadCell(file) {
    let img = sharp(file)
    let meta = await img.metadata()
    // Mipmapped icons store the smaller versions beside the full-size one.
    let size = Math.min(meta.width, meta.height)
    return img
        .extract({left: 0, top: 0, width: size, height: size})
        .resize(CELL, CELL, {kernel: "lanczos3"})
        .ensureAlpha()
        .raw()
        .toBuffer()
}

async function buildSheet() {
    let files = [...iconFiles.keys(), clockPath, slotPath]
    // Identical images share one cell.
    let byContent = new Map()
    let cellOf = new Map()
    let buffers = new Map()
    for (let f of files) {
        let buf = await loadCell(f)
        let hash = crypto.createHash("md5").update(buf).digest("hex")
        if (!byContent.has(hash)) {
            byContent.set(hash, {file: f, buf})
        }
        cellOf.set(f, hash)
    }
    let unique = [...byContent.entries()].sort((a, b) => {
        let an = path.basename(a[1].file, ".png"), bn = path.basename(b[1].file, ".png")
        if (an !== bn) {
            return an < bn ? -1 : 1
        }
        return a[1].file < b[1].file ? -1 : 1
    })
    let width = Math.floor(Math.sqrt(unique.length))
    let height = Math.ceil(unique.length / width)
    let sheet = Buffer.alloc(width * CELL * height * CELL * 4)
    let position = new Map()
    unique.forEach(([hash, {buf}], i) => {
        let row = Math.floor(i / width)
        let col = i % width
        position.set(hash, {col, row})
        for (let y = 0; y < CELL; y++) {
            buf.copy(sheet, ((row * CELL + y) * width * CELL + col * CELL) * 4, y * CELL * 4, (y + 1) * CELL * 4)
        }
    })
    let png = await sharp(sheet, {raw: {width: width * CELL, height: height * CELL, channels: 4}})
        .png({compressionLevel: 9})
        .toBuffer()
    let md5 = crypto.createHash("md5").update(png).digest("hex")
    return {png, md5, width: width * CELL, height: height * CELL, posOf: f => position.get(cellOf.get(f))}
}

const sheet = await buildSheet()
for (let obj of iconUsers) {
    let {col, row} = sheet.posOf(obj._icon)
    obj.icon_col = col
    obj.icon_row = row
    delete obj._icon
}
let clock = sheet.posOf(clockPath)
let slot = sheet.posOf(slotPath)

if (args["write-sprites"]) {
    fs.writeFileSync(`${SHEET_PREFIX}-${sheet.md5}.png`, sheet.png)
}

const data = {
    agricultural_tower,
    beacon,
    belts,
    boilers,
    crafting_machines,
    fluids,
    fuel,
    groups,
    items,
    mining_drills,
    modules,
    offshore_pumps,
    planets,
    plants,
    recipes: recipes.sort((a, b) => a.key < b.key ? -1 : 1),
    resources,
    rocket_silo,
    spoilage,
    sprites: {
        extra: {
            clock: {icon_col: clock.col, icon_row: clock.row, name: "time"},
            slot_icon_module: {icon_col: slot.col, icon_row: slot.row, name: "no module"},
        },
        hash: sheet.md5,
        height: sheet.height,
        width: sheet.width,
    },
    surface_properties,
}

function sortKeys(x) {
    if (Array.isArray(x)) {
        return x.map(sortKeys)
    }
    if (x && typeof x === "object") {
        return Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])]))
    }
    return x
}

fs.writeFileSync(OUT, JSON.stringify(sortKeys(data), null, 4) + "\n")
console.log(`wrote ${OUT}: ${items.length} items, ${recipes.length} recipes, sheet ${sheet.width}x${sheet.height} (${sheet.md5})`)
