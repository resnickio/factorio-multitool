import { Icon } from "./icon.js"

// Order in which science packs are listed. Packs not in this list sort last.
const PACK_ORDER = [
    "automation-science-pack",
    "logistic-science-pack",
    "military-science-pack",
    "chemical-science-pack",
    "production-science-pack",
    "utility-science-pack",
    "space-science-pack",
    "metallurgic-science-pack",
    "agricultural-science-pack",
    "electromagnetic-science-pack",
    "cryogenic-science-pack",
    "promethium-science-pack",
]

export function packRank(key) {
    let i = PACK_ORDER.indexOf(key)
    return i === -1 ? PACK_ORDER.length : i
}

export class Technology {
    constructor(key, name, col, row, packs, trigger) {
        this.key = key
        this.name = name
        this.packs = packs
        this.trigger = trigger
        this.prerequisites = []
        this.dependents = []
        this.recipes = []

        this.icon_col = col
        this.icon_row = row
        this.icon = new Icon(this)
    }
    // All technologies required, directly or indirectly.
    allPrerequisites() {
        let found = new Set()
        let visit = t => {
            for (let p of t.prerequisites) {
                if (!found.has(p)) {
                    found.add(p)
                    visit(p)
                }
            }
        }
        visit(this)
        return found
    }
    // All technologies which, directly or indirectly, require this one.
    allDependents() {
        let found = new Set()
        let visit = t => {
            for (let d of t.dependents) {
                if (!found.has(d)) {
                    found.add(d)
                    visit(d)
                }
            }
        }
        visit(this)
        return found
    }
    renderTooltip() {
        let t = d3.create("div")
            .classed("frame", true)
        let header = t.append("h3")
        header.append(() => this.icon.make(32, true))
        header.append(() => new Text(this.name))
        if (this.recipes.length > 0) {
            let line = t.append("div")
            line.append("b")
                .text("Unlocks: ")
            line.append("span")
                .text(this.recipes.map(r => r.name).join(", "))
        }
        return t.node()
    }
}

// Returns a Map of technology key to Technology, or null if the dataset has
// no technology information. Each recipe is given an `unlockedBy` list, and
// an `enabledAtStart` flag.
export function getTechnologies(data, recipes) {
    if (!data.technologies) {
        return null
    }
    for (let d of data.recipes) {
        let recipe = recipes.get(d.key)
        if (recipe) {
            recipe.enabledAtStart = d.enabled_at_start === true
            recipe.unlockedBy = []
        }
    }
    let techs = new Map()
    for (let d of data.technologies) {
        techs.set(d.key, new Technology(
            d.key,
            d.localized_name.en,
            d.icon_col,
            d.icon_row,
            d.science_packs,
            d.trigger === true,
        ))
    }
    for (let d of data.technologies) {
        let tech = techs.get(d.key)
        for (let key of d.prerequisites) {
            let p = techs.get(key)
            tech.prerequisites.push(p)
            p.dependents.push(tech)
        }
        for (let key of d.recipes) {
            let recipe = recipes.get(key)
            if (recipe) {
                tech.recipes.push(recipe)
                recipe.unlockedBy.push(tech)
            }
        }
    }
    return techs
}

// Returns a new Set containing the given technologies and everything they
// require.
export function researchClosure(techs) {
    let result = new Set()
    for (let t of techs) {
        result.add(t)
        for (let p of t.allPrerequisites()) {
            result.add(p)
        }
    }
    return result
}

// The technologies in a (closed) set which no other technology in the set
// requires. Together with the prerequisite graph, these describe the set.
export function researchLeaves(researched) {
    let leaves = []
    for (let t of researched) {
        if (!t.dependents.some(d => researched.has(d))) {
            leaves.push(t)
        }
    }
    return leaves
}
