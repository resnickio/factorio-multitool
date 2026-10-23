import { spec } from "./factory.js"
import { getRecipeGroups } from "./groups.js"
import { packRank, researchClosure } from "./technology.js"
import { sorted } from "./sort.js"

// The research and recipe-toggle controls on the settings tab.

let recipeFilter = ""
let techFilter = ""
// The last set of researched technologies chosen, so that switching to
// "everything unlocked" and back is not lossy.
let remembered = null
let openSections = new Set()

function matches(text, filter) {
    return filter === "" || text.toLowerCase().includes(filter)
}

function titleCase(key) {
    let s = key.replace(/-/g, " ")
    return s.charAt(0).toUpperCase() + s.slice(1)
}

function shortPackName(key) {
    let item = spec.items.get(key)
    let name = item ? item.name : titleCase(key)
    return name.replace(/ science pack$/i, "")
}

// ---------------------------------------------------------------------------
// Recipe toggles
// ---------------------------------------------------------------------------

function lockNote(recipe) {
    if (!spec.locked.has(recipe)) {
        return ""
    }
    return "locked: " + recipe.unlockedBy.map(t => t.name).join(" / ")
}

function unlockTitle(recipe) {
    if (recipe.unlockedBy === undefined || recipe.unlockedBy.length === 0) {
        return recipe.name
    }
    if (recipe.enabledAtStart) {
        return recipe.name + " (available from the start)"
    }
    return recipe.name + " (unlocked by " + recipe.unlockedBy.map(t => t.name).join(" or ") + ")"
}

function searchText(recipe) {
    let parts = [recipe.name]
    for (let p of recipe.products) {
        parts.push(p.item.name)
    }
    if (recipe.unlockedBy) {
        for (let t of recipe.unlockedBy) {
            parts.push(t.name)
        }
    }
    return parts.join(" ")
}

// Refreshes the selected and locked state of the recipe toggles.
export function refreshRecipeToggles() {
    let toggles = d3.selectAll("#recipe_toggles .toggle")
    toggles.classed("selected", d => !spec.disable.has(d))
        .classed("locked", d => spec.locked.has(d))
    toggles.select(".lock-note")
        .text(d => lockNote(d))
}

function applyRecipeFilter() {
    let filter = recipeFilter.trim().toLowerCase()
    d3.selectAll("#recipe_toggles .toggle")
        .style("display", d => matches(searchText(d), filter) ? null : "none")
    d3.selectAll("#recipe_toggles .recipe-section").each(function() {
        let section = d3.select(this)
        let visible = section.selectAll(".toggle").filter(function() {
            return this.style.display !== "none"
        }).size()
        section.style("display", visible > 0 ? null : "none")
        if (section.node().tagName === "DETAILS" && filter !== "") {
            section.property("open", visible > 0)
        }
    })
}

export function renderRecipeToggles() {
    let allGroups = getRecipeGroups(new Set(spec.recipes.values()))
    let recipes = []
    for (let group of allGroups) {
        if (group.size > 1) {
            for (let r of group) {
                recipes.push(r)
            }
        }
    }

    // Position of each item in the game's own group/subgroup ordering.
    let position = new Map()
    spec.itemGroups.forEach((group, gi) => {
        group.forEach((items, si) => {
            for (let item of items) {
                position.set(item, [gi, si])
            }
        })
    })
    let posOf = r => position.get(r.products[0].item) || [999, 0]

    let sections = new Map()
    let recycling = []
    for (let r of recipes) {
        if (r.key.endsWith("-recycling")) {
            recycling.push(r)
            continue
        }
        let [gi] = posOf(r)
        if (!sections.has(gi)) {
            sections.set(gi, {title: titleCase(r.products[0].item.group), recipes: []})
        }
        sections.get(gi).recipes.push(r)
    }
    let recipeOrder = r => {
        let [gi, si] = posOf(r)
        return [si, r.order || "", r.name]
    }
    let compare = (a, b) => {
        let x = recipeOrder(a), y = recipeOrder(b)
        for (let i = 0; i < x.length; i++) {
            if (x[i] < y[i]) {
                return -1
            } else if (x[i] > y[i]) {
                return 1
            }
        }
        return 0
    }

    let div = d3.select("#recipe_toggles")
        .classed("toggle-list", true)
    div.selectAll("*").remove()

    div.append("input")
        .attr("type", "search")
        .attr("placeholder", "Search recipes, items or technologies")
        .attr("autocomplete", "off")
        .classed("filter-input", true)
        .property("value", recipeFilter)
        .on("input", function() {
            recipeFilter = this.value
            applyRecipeFilter()
        })

    function addToggles(container, list) {
        container.append("div")
            .classed("toggle-row", true)
            .selectAll("div")
            .data(list.slice().sort(compare))
            .join("div")
                .classed("toggle recipe named", true)
                .attr("title", d => unlockTitle(d))
                .on("click", function(event, d) {
                    if (spec.disable.has(d)) {
                        spec.setEnable(d)
                    } else {
                        spec.setDisable(d)
                    }
                    refreshRecipeToggles()
                    spec.updateSolution()
                })
                .each(function(d) {
                    let node = d3.select(this)
                    node.append(() => d.icon.make(32))
                    node.append("span")
                        .classed("toggle-name", true)
                        .text(d.name)
                    node.append("span")
                        .classed("lock-note", true)
                })
    }

    for (let gi of sorted(sections.keys())) {
        let {title, recipes} = sections.get(gi)
        let section = div.append("div")
            .classed("recipe-section", true)
        section.append("h4")
            .classed("section-title", true)
            .text(title)
        addToggles(section, recipes)
    }
    if (recycling.length > 0) {
        let section = div.append("details")
            .classed("recipe-section", true)
        section.append("summary")
            .classed("section-title", true)
            .text(`Recycling (${recycling.length})`)
        addToggles(section, recycling)
    }
    refreshRecipeToggles()
    applyRecipeFilter()
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

function setResearch(researched) {
    if (researched !== null) {
        remembered = researched
    }
    spec.setResearched(researched)
    refreshRecipeToggles()
    spec.updateSolution()
    renderResearch()
}

function toggleTech(tech) {
    let r = new Set(spec.researched)
    if (r.has(tech)) {
        r.delete(tech)
        for (let d of tech.allDependents()) {
            r.delete(d)
        }
    } else {
        for (let t of researchClosure([tech])) {
            r.add(t)
        }
    }
    setResearch(r)
}

// All technologies which need no science pack ranked above the given one.
function techsUpTo(rank) {
    let all = Array.from(spec.technologies.values())
    let set = new Set()
    let changed = true
    while (changed) {
        changed = false
        for (let t of all) {
            if (set.has(t)) {
                continue
            }
            if (t.packs.every(p => packRank(p) <= rank) && t.prerequisites.every(p => set.has(p))) {
                set.add(t)
                changed = true
            }
        }
    }
    return set
}

// Technologies are grouped by the most advanced science pack they need.
function techTier(tech) {
    let best = null
    for (let p of tech.packs) {
        if (best === null || packRank(p) > packRank(best)) {
            best = p
        }
    }
    return best
}

function applyTechFilter() {
    let filter = techFilter.trim().toLowerCase()
    d3.selectAll("#research_ui .tech")
        .style("display", d => matches(d.name + " " + d.recipes.map(r => r.name).join(" "), filter) ? null : "none")
    d3.selectAll("#research_ui details.tech-section").each(function() {
        let section = d3.select(this)
        let visible = section.selectAll(".tech").filter(function() {
            return this.style.display !== "none"
        }).size()
        section.style("display", visible > 0 ? null : "none")
        if (filter !== "") {
            section.property("open", visible > 0)
        }
    })
}

export function renderResearch() {
    let row = d3.select("#research_setting_row")
    if (!spec.technologies) {
        row.style("display", "none")
        return
    }
    row.style("display", null)
    let root = d3.select("#research_ui")
        .classed("toggle-list", true)
    root.selectAll("*").remove()

    let limited = spec.researched !== null
    let modes = root.append("div")
        .classed("research-mode", true)
    let modeOptions = [
        [false, "Everything is unlocked"],
        [true, "Only what I have researched"],
    ]
    for (let [value, text] of modeOptions) {
        let label = modes.append("label")
        label.append("input")
            .attr("type", "radio")
            .attr("name", "research_mode")
            .property("checked", limited === value)
            .on("change", function() {
                if (value) {
                    setResearch(remembered || new Set())
                } else {
                    if (spec.researched !== null) {
                        remembered = spec.researched
                    }
                    spec.setResearched(null)
                    refreshRecipeToggles()
                    spec.updateSolution()
                    renderResearch()
                }
            })
        label.append("span")
            .text(" " + text)
    }
    if (!limited) {
        return
    }

    // Presets.
    let packs = new Set()
    for (let t of spec.technologies.values()) {
        for (let p of t.packs) {
            packs.add(p)
        }
    }
    let presets = root.append("div")
        .classed("research-presets", true)
    presets.append("span")
        .text("Quick set: ")
    let addPreset = (text, fn) => {
        presets.append("button")
            .text(text)
            .on("click", () => setResearch(fn()))
    }
    addPreset("Nothing", () => new Set())
    for (let pack of sorted(packs, packRank)) {
        addPreset(shortPackName(pack), () => techsUpTo(packRank(pack)))
    }
    addPreset("Everything", () => new Set(spec.technologies.values()))
    presets.append("span")
        .classed("hint", true)
        .text(" (technologies using up to each science pack)")

    root.append("input")
        .attr("type", "search")
        .attr("placeholder", "Search technologies")
        .attr("autocomplete", "off")
        .classed("filter-input", true)
        .property("value", techFilter)
        .on("input", function() {
            techFilter = this.value
            applyTechFilter()
        })

    // Technologies, grouped by the science packs they need.
    let shown = Array.from(spec.technologies.values()).filter(t => t.recipes.length > 0)
    let groups = new Map()
    for (let t of shown) {
        let tier = techTier(t)
        let key = tier === null ? "" : tier
        if (!groups.has(key)) {
            groups.set(key, {tier, techs: []})
        }
        groups.get(key).techs.push(t)
    }
    let ordered = Array.from(groups.entries()).sort((a, b) => {
        let x = a[1].tier === null ? -1 : packRank(a[1].tier)
        let y = b[1].tier === null ? -1 : packRank(b[1].tier)
        return x - y
    })
    if (openSections.size === 0 && ordered.length > 0) {
        openSections.add(ordered[0][0])
    }
    for (let [key, {tier, techs}] of ordered) {
        let done = techs.filter(t => spec.researched.has(t)).length
        let label = tier === null ? "No science packs needed" : shortPackName(tier) + " science"
        let section = root.append("details")
            .classed("tech-section", true)
            .property("open", openSections.has(key))
            .on("toggle", function() {
                if (this.open) {
                    openSections.add(key)
                } else {
                    openSections.delete(key)
                }
            })
        let summary = section.append("summary")
            .classed("section-title", true)
        summary.append("span")
            .text(`${label} (${done}/${techs.length})`)
        let sorter = t => t.name
        section.append("div")
            .classed("toggle-row", true)
            .selectAll("div")
            .data(sorted(techs, sorter))
            .join("div")
                .classed("toggle tech named", true)
                .classed("selected", d => spec.researched.has(d))
                .on("click", (event, d) => toggleTech(d))
                .each(function(d) {
                    let node = d3.select(this)
                    node.append(() => d.icon.make(32))
                    node.append("span")
                        .classed("toggle-name", true)
                        .text(d.name)
                })
    }
    applyTechFilter()
}
