# ABTest — A/B point-cloud tileset comparison

A diagnostic harness that renders two 3D Tiles **point-cloud** tilesets side by side
under _identical_ view conditions (matched camera, `maximumScreenSpaceError`, and cache
budget) and surfaces the traversal / streaming statistics, to pin down why one renders
less fluently than the other.

Left = ours (py3dtiles). Right = Cesium Ion (local copy — no Ion token needed).

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

Configured in `ABTest.js` (`DATASETS`), relative to `base`:

| dataset      | ours                                    | Cesium Ion                             |
| ------------ | --------------------------------------- | -------------------------------------- |
| Sauen (real) | `/ImprovedV34/out_tileset/tileset.json` | `/CesiumIon/out_tileset/tileset.json`  |
| Synthetic    | `/ImprovedV35/out_tileset/tileset.json` | `/CesiumIon2/out_tileset/tileset.json` |

Switch the active pair with the **Dataset** buttons. Both tilesets in a pair carry their
own root `transform` and geolocate to the same ECEF location, so one world-space camera
frames both.

## Controls (applied equally to both sides)

- **maximumScreenSpaceError** slider (default 16) — the primary knob.
- **Cache budget (MB)** → sets `cacheBytes` on both; click **Apply**.
- **debugColorizeTiles** — colors each tile differently (shows tile partitioning).
- **debugShowBoundingVolume** — draws the tile boxes.
- **debugFreezeFrame** — freezes LOD selection so stats hold still while reading.
- **Presets** — Top-down / Oblique / Close-up camera bookmarks (derived from the loaded
  bounding sphere; the oblique mid-range view is the most telling).

Point rendering (`pointCloudShading`) is left at defaults on both sides so per-point cost
is equal.

## Capture

**Capture** (or press `c`) reads both tilesets' statistics under the current camera + SSE
and appends a row to the on-page table. **Download CSV / JSON** exports all rows; **Clear**
resets.

Per side, each row records: `selected` (tiles rendered — the key metric), `numberOfCommands`
(draw calls), `numberOfPointsSelected`, `numberOfPendingRequests`,
`numberOfTilesProcessing`, `numberOfTilesWithContentReady`, `numberOfTilesTotal`, plus the
shared `fps`, `sse`, `cacheMB`, `dataset`, and `preset`.

> FPS is the **page** FPS: both viewers render in the same `requestAnimationFrame` loop,
> so it reflects the combined side-by-side cost, not one tileset in isolation. Each viewer
> also shows its own `debugShowFramesPerSecond` overlay for an eyeball figure.

## Expected result

At a matched oblique camera and equal SSE, we expect **ours** to show a **higher
Selected-tiles / Commands** count with **similar-or-lower Points selected** and **higher
Pending** than Ion — the signature of a working-set / culling bottleneck. If instead Points
is much higher on our side, that points to over-refinement dumping raw geometry.
