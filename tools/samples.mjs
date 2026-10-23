// Sample requirements shared by make-sample.mjs and game-test.mjs.
// override: layout parameters to force (the defaults pick one column unless
// the loads are too large for one).
export const SAMPLES = {
    "iron-4-furnaces": {recipe: "iron-plate", rate: 2.5, input: "iron-ore", output: "iron-plate"},
    "iron-24-furnaces": {recipe: "iron-plate", rate: 15, input: "iron-ore", output: "iron-plate"},
    "iron-two-columns": {recipe: "iron-plate", rate: 7.5, input: "iron-ore", output: "iron-plate", override: {columns: 2}},
    "steel-two-columns": {recipe: "steel-plate", rate: 3.75, input: "iron-plate", output: "steel-plate", override: {columns: 2}},
}
