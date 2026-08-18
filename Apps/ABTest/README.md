# ABTest — A/B point-cloud tileset comparison

A diagnostic harness that renders two 3D Tiles **point-cloud** tilesets side by side
under _identical_ view conditions (matched camera, `maximumScreenSpaceError`, and cache
budget) and surfaces the traversal / streaming statistics, to pin down why one renders
less fluently than the other.

The two sides are whatever a dataset declares — "ours vs Cesium Ion" for tiling comparisons,
or two **multi-temporal** tilesets (e.g. shared-tree vs referenced-tilesets) whose epochs are
switched in lockstep and whose switch latency is measured per side.

## Run it

Two static servers: one for the app (the repo's dev server) and one for the tilesets
(rooted at `~/output`, with CORS so the cross-origin fetch works).

```bash
# 1. Serve the tilesets from ~/output with permissive CORS on port 8003.
npx http-server ~/output --cors -p 8003
#   (or any static server that sends Access-Control-Allow-Origin: *)

# 2. Serve the app (from the repo root, as usual).
npm run start
```

Then open:

```text
http://localhost:8080/Apps/ABTest/index.html
```

Override the tileset server with `?base=<url>`, e.g.
`…/index.html?base=http://localhost:9000`.

If you serve the app and the tilesets from the **same** origin (e.g. put the app under
`~/output` too), no CORS setup is needed.

## Datasets

Configured in `ABTest.js` (`DATASETS`), relative to `base`. Each dataset declares exactly
**two sides, named however you like** — the keys are the labels used for the viewers, the
table column groups and the CSV column prefixes, so nothing is hardcoded to "ours"/"ion":

```js
const DATASETS = {
  Sauen: {
    "ours (py3dtiles)": "/ImprovedV36/out_tileset/tileset.json",
    "Cesium Ion": { url: "/CesiumIon/out_tileset/tileset.json", anchor: true },
  },
  MT: {
    "shared tree": "/MT_REAL_shared/out_tileset/tileset.json",
    "referenced tilesets": "/MT_REAL_referenced/out_tileset/tileset.json",
  },
};
```

A side is a URL string, or `{ url, anchor }`. Declaration order is layout order: first key
is the left viewer, second the right. `anchor: true` marks the side the camera presets are
anchored to; without it the right side is used. Anchor the **fixed reference**, never the
variable under test, so a preset reproduces the same pose across sessions.

Switch the active pair with the **Dataset** buttons. Both tilesets in a pair carry their
own root `transform` and geolocate to the same ECEF location, so one world-space camera
frames both.

## Multi-temporal datasets

If either side exposes `timestampKeys`, the app notices and shows an **Epoch** row with one
button per timestamp (the union of both sides' keys, in first-seen order). Selecting an epoch
switches **every side that has that key**, so you can compare two multi-temporal tilesets
against each other, or one against a single-epoch tileset. Arrow keys step through epochs and
number keys jump to one.

Each switch is measured per side and recorded as a `switch` row:

- **First ms** — the first frame whose selected-point count reflects the new epoch.
- **Settle ms** — when that side has no pending requests and no tiles processing for two
  consecutive frames.
- **dippedToZero** (export only) — whether that side rendered nothing in between, which is
  the signature of a layout that has to refetch rather than swap resident content.

**Measure every epoch switch** walks all epochs once and records a row per switch — the
epoch-switch-latency benchmark in one click. Rows also carry each side's `layout`, active
`epoch` and `activePoints`, so a capture states which epoch produced it.

## Controls (applied equally to both sides)

- **maximumScreenSpaceError** slider (default 16) — the primary knob.
- **Cache budget (MB)** → sets `cacheBytes` on both; click **Apply**.
- **debugColorizeTiles** — colors each tile differently (shows tile partitioning).
- **debugShowBoundingVolume** — draws the tile boxes.
- **debugFreezeFrame** — freezes LOD selection so stats hold still while reading.
- **Presets** — Top-down / Oblique / Close-up camera bookmarks. These are anchored to the
  side marked `anchor` in `DATASETS` (the fixed reference), so a preset reproduces
  the exact same pose every session regardless of what the other side is — the camera is
  never coupled to the variable under test. The oblique mid-range view is the most telling.
- **Settle before capture** (default on) — a capture waits until _both_ tilesets report no
  pending requests and no tiles processing for a couple of frames before recording. Turn it
  **off** to sample mid-load. If the gate times out (~15 s) it records anyway and warns.

Screen-space error also scales with the canvas height, so keep the window the same size
between capture sessions for reproducible selection. The viewport
(`bufferWidth/bufferHeight/pixelRatio`) is recorded on every capture, so any mismatch between
two rows is detectable after the fact.

Point rendering (`pointCloudShading`) is left at defaults on both sides so per-point cost
is equal.

## Capture

**Capture** (or press `c`) reads both tilesets' statistics under the current camera + SSE
and appends a row to the on-page table. **Download CSV / JSON** exports all rows; **Clear**
resets.

Per side, each row records: `selected` (tiles rendered — the key metric), `numberOfCommands`
(draw calls), `numberOfPointsSelected`, `numberOfPendingRequests`,
`numberOfTilesProcessing`, `numberOfTilesWithContentReady`, `numberOfTilesTotal`, the
multi-temporal `epoch` / `activePoints` / `layout`, and for switch rows `firstRenderMs` /
`settleMs` / `dippedToZero`, plus the shared `kind`, `fps`, `sse`, `cacheMB`, `dataset`, and
`preset`.

Sides are positional in the export — `a_` is the left side, `b_` the right — and each row
carries `a_key` / `b_key`, so a single CSV may mix datasets whose sides are named
differently and still be readable.

Each row is also **self-describing** for reproducibility: the CSV/JSON carry `settled`
(whether the settle gate was satisfied), the camera pose (`posX/posY/posZ` in ECEF,
`heading/pitch/roll` in degrees, `fovy`), and the viewport (`bufferWidth/bufferHeight/pixelRatio`).
Two captures can therefore be confirmed identical-camera before they're compared. (These extra
columns are in the export only, to keep the on-page table readable.)

> FPS is the **page** FPS: both viewers render in the same `requestAnimationFrame` loop,
> so it reflects the combined side-by-side cost, not one tileset in isolation. Each viewer
> also shows its own `debugShowFramesPerSecond` overlay for an eyeball figure.

## Reproducibility check

Run the same preset twice in separate sessions on the anchored side; its `selected` /
`numberOfPointsSelected` must be **identical** (not just close). With presets anchored, the
settle gate on, and the same window size, that equality should hold for all three presets
(before anchoring, only `close` held). If it ever doesn't, compare the recorded camera-pose
and viewport columns between the two rows to find what differed.

## Expected result

At a matched oblique camera and equal SSE, we expect **ours** to show a **higher
Selected-tiles / Commands** count with **similar-or-lower Points selected** and **higher
Pending** than Ion — the signature of a working-set / culling bottleneck. If instead Points
is much higher on our side, that points to over-refinement dumping raw geometry.
