# Dataset tools

`convert-data.mjs` builds a calculator dataset (`data/space-age-<version>.json`)
and its sprite sheet (`images/sprite-sheet-<hash>.png`) from the game's own
dumps. It replaces the stale `process_data.py` for 2.x data.

## Producing the dumps

Close Factorio (and Steam's instance) first; the game holds a lock file.

```
factorio --dump-data
factorio --dump-prototype-locale
factorio --dump-icon-sprites
```

Output lands in `%APPDATA%\Factorio\script-output`. If `--dump-icon-sprites`
reports "Steam requires game restart", put a `steam_appid.txt` containing
`427520` next to `factorio.exe`.

## Converting

```
cd tools
npm install
node convert-data.mjs --out ../data/space-age-2.1.23.json --write-sprites
```

Options: `--dump-dir` (default: the script-output folder), `--game-dir` (the
install; used for the `clock` and `slot_icon_module` sprites, which the icon
dump omits), `--sheet-prefix`.

Add the dataset to `MODIFICATIONS` in `settings.js` afterwards.

`serve.mjs` is a tiny static server for trying the result locally.

## Probes

`tools/probes/*.lua` are snippets for `game-probe.mjs` (`node tools/game-probe.mjs
--lua tools/probes/inserter-chests.lua`) which measured what each inserter moves
in the game: between chests, from a compressed belt and onto a belt. They are
where the stack inserter figures in `blueprint/entities.js` come from. A snippet
which needs game time to pass sets `DEFER = true` and calls `finish()` when it
has its results.
