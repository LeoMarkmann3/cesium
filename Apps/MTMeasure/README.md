# MTMeasure — multi-temporal point-cloud measurement

A **single-viewer, URL-driven** measurement app for multi-temporal (MT) 3D Tiles point
clouds. It is meant to be opened by an automation pipeline (Selenium + Firefox), run a fixed
protocol unattended, and download its results — but it also works by hand.

Two measurers run in parallel:

- the fork's **`PerformanceMeasurer`** samples continuous performance (fps, frame times,
  request behaviour, tile counters) every 100 ms for the whole run, and
- **MTMeasure's own rows** are captured only at meaningful moments: one `state` row and one
  `switch` row per measurement stop (switch latency, memory, cache deltas).

The camera flies a path at a **constant speed**, so every tileset gets the same stimulus per
metre of camera travel regardless of how fast it renders.

## Run it

```bash
# 1. Serve the tilesets with permissive CORS.
npx http-server ~/output --cors -p 8002

# 2. Serve the app.
npm run start
```

Then open `http://localhost:8080/Apps/MTMeasure/index.html` with parameters, e.g.

```text
…/index.html?tileset=http://localhost:8002/MT_REAL_shared/out_tileset/tileset.json&auto=1
```

Without `auto` or `record` the page shows a usage overlay and loads nothing.

## URL parameters

| Param            | Default                        | Meaning                                                                                   |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `tileset`        | — (required)                   | Tileset URL, absolute or relative to the page. Alerts and stops if missing or unloadable. |
| `name`           | second-to-last path segment    | Label used in rows and in both CSV filenames.                                             |
| `path`           | generated (see below)          | URL of a camera-path JSON.                                                                |
| `speed`          | path JSON's `speed`, else `15` | Camera speed in m/s along the path. The URL wins over the JSON.                           |
| `laps`           | `2`                            | Sequential epoch-sweep laps per waypoint.                                                 |
| `randomSwitches` | epoch count                    | Seeded-random epoch switches per waypoint, after the laps.                                |
| `seed`           | `42`                           | Seed of the PRNG driving the random switch order. Recorded in every row.                  |
| `sse`            | Cesium default (16)            | `maximumScreenSpaceError` override. Recorded either way.                                  |
| `cacheMB`        | Cesium default                 | `cacheBytes` override in MB. Recorded either way.                                         |
| `auto`           | off                            | `auto=1`: run the protocol, download both CSVs, set `window.MTMEASURE_DONE`.              |
| `record`         | off                            | `record=1`: record a camera path. Mutually exclusive with `auto`.                         |

The `PerformanceMeasurer` sample rate is fixed at 100 ms, as in `Apps/ComparisonTest`.

## Camera path

With `path=<url>`, a JSON of this shape (positions in **ECEF metres**, angles in **degrees**):

```json
{
  "name": "ofental",
  "speed": 15,
  "waypoints": [
    {
      "label": "start",
      "position": [3791052.4, 958685.6, 5022018.6],
      "heading": 30.0,
      "pitch": -30.0,
      "roll": 0.0
    },
    {
      "label": "over the ridge",
      "position": [3790984.5, 958833.7, 5022008.9],
      "heading": 85.0,
      "pitch": -15.0,
      "roll": 0.0
    }
  ]
}
```

At least one waypoint is required; a single waypoint means no flight, just the protocol at
that pose. Malformed input alerts and stops.

Without `path`, a three-waypoint traverse is **generated** from the tileset's bounding
sphere in its local ENU frame — in from the south-west at (−1 r, −1 r, +0.6 r), over the
centre at +0.45 r, out to the north-east at (+1 r, +1 r, +0.6 r), with headings 45° / 30° /
60° and pitches −25° / −40° / −20°. It is a real flown path (≈2.83 r long), not a set of
teleports, so any tileset can be measured without first recording a path.

**Motion model.** The path is the polyline through the waypoints. On every frame the camera
is placed at `speed × (now − flightStart)` metres along it — wall-clock, never a per-frame
step. A slow-rendering tileset therefore does **not** get a slower camera; dropped frames
make the camera jump further, which is exactly what keeps the stimulus comparable. Position
interpolates linearly, orientation by shortest-arc quaternion slerp, and each segment ends
exactly on the next waypoint's recorded pose. User input is disabled during an auto run.

## Protocol (`auto=1`)

Measurement stops are scheduled **by distance along the path** — every `speed × switchEvery`
metres — so the schedule is independent of how many waypoints the path happens to have.

1. Load the tileset, start the `PerformanceMeasurer`, place the camera at the path start.
2. At every stop: settle → capture a `state` row → (if multi-temporal) measure **one** epoch
   switch → fly on to the next stop at `speed`, capturing nothing during the flight.
3. After the last stop, fly the remainder of the path, settle, capture a closing `state` row,
   download `mtmeasure_<name>.csv` and `perf_<name>.csv`, and set
   `window.MTMEASURE_DONE = true`.

The first `state` row is the baseline. The first `laps × epochs` switches sweep the epochs in
order; every switch after that is a seeded-random draw. A single-epoch tileset runs the same
protocol minus all epoch machinery: `state` rows and the perf CSV, no `switch` rows.

**Why distance and not wall clock.** The camera is already wall-clock arc-length driven, so
distance along the path equals `speed × accumulated flight time`, and the flight clock only
advances while the camera is actually moving — never while settling or measuring. Stop _k_
therefore sits at exactly the same pose in every run and for every tileset, however long that
tileset takes to settle or switch. Scheduling on the true wall clock would let a slow format
spend its budget on switching rather than flying, so switch _k_ would be measured from a
different viewpoint in each run and the comparison would drift.

**Random draws** come from one seeded mulberry32 instance created at protocol start, and each
draw excludes the epoch that is currently active (a same-epoch switch is a no-op and would
corrupt the first-render measurement). `Math.random` is not used anywhere in the measurement
path, so the whole sequence is reproducible from `seed` alone. With only two epochs each draw
has exactly one legal target, so the random phase alternates; the seed's effect on ordering
becomes visible from three epochs on.

**Switch measurement.** `firstRenderMs` is the first frame whose selected-point count differs
from the pre-switch value and is non-zero; `settleMs` is when streaming has quiesced (no
pending requests, no tiles processing, two consecutive frames) after that; `dippedToZero`
records whether the scene went empty in between — the signature of a layout that refetches
rather than swapping resident content. Timeout 30 s.

## Record mode (`record=1`)

Fly manually with full camera controls. **`w`** appends the current pose as a waypoint,
**`u`** removes the last, **`d`** downloads `camera_path_<name>.json` in exactly the format
`path=` consumes. The panel shows the live pose and the recorded list. No measurement.

## CSV columns

`mtmeasure_<name>.csv` holds the `state` and `switch` rows in this order (switch-only columns
are empty on `state` rows; a JSON export of the same rows is available from the panel):

```text
kind, name, tilesetUrl, stop, stopCount, waypoint, waypointLabel, mode, lap, seed,
requestedEpoch, elapsedMs, pathMeters, speed, switchEverySeconds, switchEveryMeters, sse,
cacheMB, prefetchWindow, retainedHistory, fps, settled, tileFailures,
posX, posY, posZ, heading, pitch, roll, fovy,
bufferWidth, bufferHeight, pixelRatio,
selected, visited, numberOfCommands, numberOfPointsSelected, numberOfPendingRequests,
numberOfTilesProcessing, numberOfTilesWithContentReady, numberOfTilesTotal,
numberOfLoadedTilesTotal, numberOfAttemptedRequests,
layout, epoch, activePoints, residentEpochsMin, residentEpochsMean, residentEpochsMax,
totalMemoryUsageInBytes, geometryByteLength, texturesByteLength, batchTableByteLength,
tileLoads, tileUnloads, epochsEvicted,
firstRenderMs, settleMs, dippedToZero, loadsDuring, unloadsDuring, epochsEvictedDuring,
attemptedDuring
```

Notes on a few of them:

- `elapsedMs` counts from protocol start; `pathMeters` is the distance travelled along the
  polyline at capture time, and on a stop's rows it equals that stop's scheduled distance.
- `stop` is the 1-based measurement stop (`stopCount` of them, plus the closing row);
  `waypoint`/`waypointLabel` say which path segment the stop falls in, so the waypoints keep
  describing the route without driving the schedule.
- `residentEpochs*` sample how many epochs are resident inside the tiles selected that frame
  (min / mean / max). Empty for tilesets whose contents don't expose it.
- `tileLoads`, `tileUnloads`, `epochsEvicted` are cumulative; the `*During` columns are the
  change across one switch. **`attemptedDuring` is a per-frame sum, not a difference**, because
  `statistics.numberOfAttemptedRequests` is reset every frame — a difference would compare two
  single frames.
- `epochsEvicted` counts multi-temporal epochs evicted under memory pressure, which only
  happens in the **shared-tree** layout. The referenced-tilesets layout keeps one epoch
  resident and releases it on every switch by design, which is not an eviction and is visible
  through `unloadsDuring` / `loadsDuring` / `dippedToZero` instead.
- **To observe an eviction you need two things**: memory pressure (`cacheMB` well below what
  the view needs) _and_ a prefetch window smaller than the epoch set. An epoch inside the
  window is never evicted, so on a two-epoch tileset the default window of 2 covers everything
  and nothing can ever be evicted. `cacheMB=1&prefetchWindow=0&retainedHistory=0` reliably
  drives evictions; measured 72 of them in one three-waypoint run.
- `settled` records whether the settle gate was satisfied before the row was captured; on a
  large dataset with a short `SETTLE_TIMEOUT_MS` it will often read `false`, which means the
  row was taken mid-stream and its counters are a snapshot rather than a quiesced state.
- **`loadsDuring` stays 0 for shared-tree epoch switches**, and that is correct: a switch
  swaps the content _inside_ already-loaded tiles, so no tile-level `tileLoad` fires. Read
  `epochsEvictedDuring` and the memory columns for that layout, and `loadsDuring` /
  `unloadsDuring` for referenced-tilesets, where whole subtrees come and go.
- The on-page table shows a readable subset; the CSV always carries every column.

## Gotchas

- **Firefox only features are avoided** (no `performance.memory`); the app is developed
  against Firefox because the pipeline drives Firefox.
- **Screen-space error scales with canvas height**, so keep the window size fixed across runs
  you intend to compare. Every row records the viewport.
- **Referenced-tilesets datasets from py3dtiles have a root-tile geometric error near 1.0**,
  so at Cesium's default SSE they barely refine and the scene can look almost empty. Pass a
  lower `sse` (e.g. `sse=4`) for those; that is a property of the data, not of the app.
- **Do not let the URL end with the `path=…json` parameter** when serving the app from the
  repo's dev server. `server.js` derives the content type from `path.extname(req.url)`, which
  includes the query string, so a URL ending in `.json` makes the server label `index.html` as
  `application/json` and the browser shows the source instead of running the app. Keeping any
  other parameter last (e.g. `…&path=…/path.json&auto=1`) avoids it. This is upstream Cesium
  dev-server behaviour, not an app bug.
- Large datasets take minutes per run: each waypoint settles, sweeps `laps × epochs` switches
  and then flies. Reduce `laps` / `randomSwitches` while iterating.
