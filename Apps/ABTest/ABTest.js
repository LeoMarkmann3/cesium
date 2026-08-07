window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Viewer,
  RequestScheduler,
  SceneMode,
  Color,
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  defined,
  formatError,
} from "../../Build/CesiumUnminified/index.js";

// ---------------------------------------------------------------------------
// Tileset locations. All entries are LOCAL 3D Tiles; serve ~/output over HTTP with
// permissive CORS (see README) and point BASE_URL at it. Override with ?base=<url>.
//
// Each dataset declares exactly TWO sides, and their KEYS ARE FREE-FORM: whatever you
// name them here is what labels the viewers, the table column groups and the CSV column
// prefixes. Declaration order decides the layout — first key is the left viewer, second
// the right. A side is either a URL string or an object { url, anchor }, where
// anchor: true marks the side whose bounding sphere the camera presets are anchored to
// (defaults to the right side; anchor the fixed reference, not the variable under test).
//
// Multi-temporal tilesets need no special declaration: if a side exposes timestampKeys,
// the epoch controls appear automatically and switching is applied to both sides.
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = "http://localhost:8003";

const DATASETS = {
  Sauen: {
    "ours (py3dtiles)": "/ImprovedV36/out_tileset/tileset.json",
    "Cesium Ion": { url: "/CesiumIon/out_tileset/tileset.json", anchor: true },
  },
  Synthetic: {
    "ours (py3dtiles)": "/ImprovedV37/out_tileset/tileset.json",
    "Cesium Ion": { url: "/CesiumIon2/out_tileset/tileset.json", anchor: true },
  },
  MT: {
    "shared tree": "/MT_REAL_shared/out_tileset/tileset.json",
    "referenced tilesets": "/MT_REAL_referenced/out_tileset/tileset.json",
  },
};

/**
 * Normalize a dataset entry into the two sides the app works with, in declaration order.
 * @param {object} spec The dataset entry from DATASETS.
 * @returns {object[]} Two side descriptors: { key, path, anchor }.
 */
function readSides(spec) {
  const sides = Object.entries(spec).map(([key, value]) => {
    const isObject = typeof value === "object" && value !== null;
    return {
      key: key,
      path: isObject ? value.url : value,
      anchor: isObject ? value.anchor === true : false,
    };
  });
  if (sides.length !== 2) {
    throw new Error(
      `A dataset must declare exactly two sides, got ${sides.length}: ${Object.keys(spec).join(", ")}`,
    );
  }
  if (!sides.some((side) => side.anchor)) {
    // Default: anchor presets to the right side.
    sides[1].anchor = true;
  }
  return sides;
}

function getBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("base") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

const VIEWER_OPTIONS = {
  sceneMode: SceneMode.SCENE3D,
  skyBox: false,
  timeline: false,
  globe: false,
  infoBox: false,
  homeButton: false,
  sceneModePicker: false,
  animation: false,
  baseLayerPicker: false,
  geocoder: false,
  selectionIndicator: false,
  fullscreenButton: false,
  navigationHelpButton: false,
};

async function main() {
  const baseUrl = getBaseUrl();
  const loadingIndicator = document.getElementById("loadingIndicator");

  // Load everything (large test datasets) and don't cull while moving so both
  // sides stream identically.
  RequestScheduler.maximumRequests = 2000000;
  RequestScheduler.maximumRequestsPerServer = 100000;

  let leftViewer;
  let rightViewer;
  try {
    leftViewer = new Viewer("leftContainer", VIEWER_OPTIONS);
    rightViewer = new Viewer("rightContainer", VIEWER_OPTIONS);
  } catch (exception) {
    loadingIndicator.style.display = "none";
    const message = formatError(exception);
    console.error(message);
    // eslint-disable-next-line no-alert
    window.alert(message);
    return;
  }

  const background = Color.fromCssColorString("#1c1c1c");
  leftViewer.scene.backgroundColor = background;
  rightViewer.scene.backgroundColor = background;
  leftViewer.scene.debugShowFramesPerSecond = true;
  rightViewer.scene.debugShowFramesPerSecond = true;

  // -------------------------------------------------------------------------
  // Camera sync. Whichever canvas the user last touched is the "active" viewer;
  // the other mirrors its camera exactly (position/direction/up/right) each frame
  // before it renders. Both tilesets share one ECEF world, so a direct copy frames
  // them identically.
  // -------------------------------------------------------------------------
  let activeViewer = leftViewer;
  function markActive(viewer) {
    activeViewer = viewer;
  }
  leftViewer.scene.canvas.addEventListener("pointerdown", () =>
    markActive(leftViewer),
  );
  rightViewer.scene.canvas.addEventListener("pointerdown", () =>
    markActive(rightViewer),
  );
  leftViewer.scene.canvas.addEventListener("wheel", () =>
    markActive(leftViewer),
  );
  rightViewer.scene.canvas.addEventListener("wheel", () =>
    markActive(rightViewer),
  );

  function syncFrom(active, passive) {
    const a = active.camera;
    const c = passive.camera;
    c.position = Cartesian3.clone(a.position, c.position);
    c.direction = Cartesian3.clone(a.direction, c.direction);
    c.up = Cartesian3.clone(a.up, c.up);
    c.right = Cartesian3.clone(a.right, c.right);
  }
  leftViewer.scene.preRender.addEventListener(() => {
    if (activeViewer !== leftViewer) {
      syncFrom(activeViewer, leftViewer);
    }
  });
  rightViewer.scene.preRender.addEventListener(() => {
    if (activeViewer !== rightViewer) {
      syncFrom(activeViewer, rightViewer);
    }
  });

  // -------------------------------------------------------------------------
  // Page-level FPS sampler. Both viewers render in the same requestAnimationFrame
  // loop, so a single page FPS reflects the combined side-by-side cost. Read the
  // per-scene overlays (debugShowFramesPerSecond) for a per-viewer eyeball figure.
  // -------------------------------------------------------------------------
  let fps = 0;
  let frames = 0;
  let fpsLast = performance.now();
  function sampleFps(now) {
    frames++;
    const dt = now - fpsLast;
    if (dt >= 500) {
      fps = (frames * 1000) / dt;
      frames = 0;
      fpsLast = now;
    }
    requestAnimationFrame(sampleFps);
  }
  requestAnimationFrame(sampleFps);

  // -------------------------------------------------------------------------
  // Current state that must apply equally to both tilesets.
  // -------------------------------------------------------------------------
  const controls = {
    sse: 16,
    cacheBytes: 512 * 1024 * 1024,
    colorize: false,
    boundingVolume: false,
    freeze: false,
    settle: true,
  };
  let currentDataset = Object.keys(DATASETS)[0];

  // The two sides of the loaded dataset, in declaration order: [left, right]. Each is
  // { key, path, anchor, viewer, labelElement, tileset }.
  let sides = [];
  // Timestamp keys offered by the loaded pair (union, in first-seen order), and the epoch
  // currently requested. Empty when neither side is multi-temporal.
  let epochKeys = [];
  let currentEpoch = null;

  function eachTileset(fn) {
    sides.forEach((side) => {
      if (defined(side.tileset)) {
        fn(side.tileset, side);
      }
    });
  }

  function applyControls(tileset) {
    if (!defined(tileset)) {
      return;
    }
    tileset.maximumScreenSpaceError = controls.sse;
    tileset.cacheBytes = controls.cacheBytes;
    tileset.debugColorizeTiles = controls.colorize;
    tileset.debugShowBoundingVolume = controls.boundingVolume;
    tileset.debugFreezeFrame = controls.freeze;
    tileset.debugShowStatistics = true;
  }

  function applyControlsToBoth() {
    eachTileset((tileset) => applyControls(tileset));
  }

  // -------------------------------------------------------------------------
  // Settle gate. A capture is only meaningful once the scene has quiesced; reading
  // mid-stream makes selected/points/fps depend on network timing, not the tileset.
  // Gate on BOTH tilesets reporting no pending requests and no tiles processing for a
  // couple of consecutive frames. Toggleable — turn it off to sample mid-load.
  // -------------------------------------------------------------------------
  function tilesetStable(tileset) {
    if (!defined(tileset)) {
      return true;
    }
    const s = tileset.statistics;
    return s.numberOfPendingRequests === 0 && s.numberOfTilesProcessing === 0;
  }

  function bothStable() {
    return sides.every((side) => tilesetStable(side.tileset));
  }

  function waitForSettle(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = performance.now();
      let stableFrames = 0;
      function tick(now) {
        stableFrames = bothStable() ? stableFrames + 1 : 0;
        if (stableFrames >= 2) {
          resolve(true);
        } else if (now - start > timeoutMs) {
          resolve(false);
        } else {
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // -------------------------------------------------------------------------
  // Self-describing capture: record the exact camera pose and viewport so every row
  // is verifiable and two captures can be confirmed identical-camera before comparing.
  // -------------------------------------------------------------------------
  function readCameraPose() {
    const cam = leftViewer.camera;
    const p = cam.positionWC;
    const frustum = cam.frustum;
    return {
      posX: p.x,
      posY: p.y,
      posZ: p.z,
      heading: CesiumMath.toDegrees(cam.heading),
      pitch: CesiumMath.toDegrees(cam.pitch),
      roll: CesiumMath.toDegrees(cam.roll),
      fovy: defined(frustum.fovy) ? CesiumMath.toDegrees(frustum.fovy) : null,
    };
  }

  function readViewport() {
    const s = leftViewer.scene;
    return {
      bufferWidth: s.drawingBufferWidth,
      bufferHeight: s.drawingBufferHeight,
      pixelRatio: s.pixelRatio,
    };
  }

  // -------------------------------------------------------------------------
  // Camera presets, anchored to the side marked anchor: true in DATASETS (by default the
  // right one). Anchor the fixed reference rather than the variable under test, so a
  // preset reproduces the same pose across sessions no matter what the other side is.
  // Applied to the left (active) viewer; sync propagates to the right.
  // -------------------------------------------------------------------------
  function applyPreset(name) {
    const anchorSide =
      sides.find((side) => side.anchor && defined(side.tileset)) ??
      sides.find((side) => defined(side.tileset));
    if (!defined(anchorSide)) {
      return;
    }
    const sphere = anchorSide.tileset.boundingSphere;
    const r = sphere.radius;
    let hpr;
    if (name === "top") {
      hpr = new HeadingPitchRange(0.0, CesiumMath.toRadians(-89.9), r * 2.2);
    } else if (name === "oblique") {
      hpr = new HeadingPitchRange(
        CesiumMath.toRadians(30.0),
        CesiumMath.toRadians(-30.0),
        r * 1.4,
      );
    } else {
      // close-up
      hpr = new HeadingPitchRange(
        CesiumMath.toRadians(30.0),
        CesiumMath.toRadians(-15.0),
        r * 0.5,
      );
    }
    markActive(leftViewer);
    leftViewer.camera.flyToBoundingSphere(sphere, { offset: hpr, duration: 0 });
  }

  // -------------------------------------------------------------------------
  // Multi-temporal controls. A side is multi-temporal when it exposes timestampKeys;
  // the epoch buttons offer the union of both sides' keys, and switching applies to
  // every side that actually has that key (so an MT tileset can be compared against a
  // single-epoch one, or two multi-temporal tilesets against each other).
  // -------------------------------------------------------------------------
  const epochRow = document.getElementById("epochRow");
  const switchSweepBtn = document.getElementById("switchSweepBtn");
  const epochButtons = new Map();

  function isMultiTemporal(side) {
    return defined(side.tileset) && defined(side.tileset.timestampKeys);
  }

  function buildEpochControls() {
    epochButtons.forEach((button) => button.remove());
    epochButtons.clear();

    epochKeys = [];
    sides.forEach((side) => {
      if (!isMultiTemporal(side)) {
        return;
      }
      side.tileset.timestampKeys.forEach((key) => {
        if (!epochKeys.includes(key)) {
          epochKeys.push(key);
        }
      });
    });

    const hasEpochs = epochKeys.length > 0;
    epochRow.style.display = hasEpochs ? "" : "none";
    switchSweepBtn.style.display = hasEpochs ? "" : "none";
    if (!hasEpochs) {
      currentEpoch = null;
      return;
    }

    currentEpoch = epochKeys[0];
    epochKeys.forEach((key) => {
      const button = document.createElement("button");
      button.textContent = key;
      button.addEventListener("click", () => switchEpoch(key));
      epochRow.appendChild(button);
      epochButtons.set(key, button);
    });
    markEpochButton(currentEpoch);
  }

  function markEpochButton(key) {
    epochButtons.forEach((button, buttonKey) => {
      button.classList.toggle("active", buttonKey === key);
    });
  }

  function readEpochState(side) {
    const tileset = side.tileset;
    if (!defined(tileset) || !defined(tileset.timestampKeys)) {
      return { layout: null, epoch: null, activePoints: null };
    }
    return {
      layout: tileset.resolvedMTLayout ?? null,
      epoch: tileset.activeTimestamp ?? null,
      activePoints: tileset.activePointsRendered,
    };
  }

  /**
   * Switch every side that has the given timestamp key, and measure how long each side
   * takes to show the new epoch. Two markers per side, because the formats differ in
   * exactly this: <code>firstRenderMs</code> is the first frame whose selected-point count
   * reflects the new epoch, <code>settleMs</code> is when that side has no pending requests
   * and no tiles processing for two consecutive frames. A shared-tree tileset that already
   * has the epoch resident switches in about a frame; a referenced-tilesets tileset must
   * refetch its sub-tileset, so its points drop to zero first (recorded as dippedToZero).
   *
   * @param {string} key The timestamp key to switch to.
   * @param {boolean} [record=true] Whether to append a capture row for the switch.
   * @returns {Promise<object>} The measurement, one entry per side.
   */
  function switchEpoch(key, record = true) {
    const participants = sides.filter(
      (side) =>
        isMultiTemporal(side) && side.tileset.timestampKeys.includes(key),
    );
    if (participants.length === 0) {
      return Promise.resolve(null);
    }

    currentEpoch = key;
    markEpochButton(key);

    const start = performance.now();
    const tracked = participants.map((side) => ({
      side: side,
      baseline: side.tileset.statistics.numberOfPointsSelected,
      firstRenderMs: null,
      settleMs: null,
      dippedToZero: false,
      stableFrames: 0,
    }));

    participants.forEach((side) => {
      side.tileset.activeTimestamp = key;
    });

    return new Promise((resolve) => {
      function tick(now) {
        const elapsed = now - start;
        tracked.forEach((entry) => {
          const stats = entry.side.tileset.statistics;
          const points = stats.numberOfPointsSelected;
          if (points === 0) {
            entry.dippedToZero = true;
          }
          if (
            entry.firstRenderMs === null &&
            points > 0 &&
            points !== entry.baseline
          ) {
            entry.firstRenderMs = Math.round(elapsed);
          }
          if (entry.settleMs === null) {
            const quiet = tilesetStable(entry.side.tileset) && points > 0;
            entry.stableFrames = quiet ? entry.stableFrames + 1 : 0;
            if (entry.stableFrames >= 2 && entry.firstRenderMs !== null) {
              entry.settleMs = Math.round(elapsed);
            }
          }
        });

        const done = tracked.every((entry) => entry.settleMs !== null);
        if (done || elapsed > 30000) {
          const measurement = tracked.map((entry) => ({
            key: entry.side.key,
            firstRenderMs: entry.firstRenderMs,
            settleMs: entry.settleMs,
            dippedToZero: entry.dippedToZero,
          }));
          if (record) {
            pushRow("switch", key, measurement);
          }
          resolve(measurement);
        } else {
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  }

  /**
   * Walk every epoch once, measuring each switch — the epoch-switch-latency benchmark in
   * one click. Starts from the epoch after the current one and comes back round to it.
   * @returns {Promise<void>}
   */
  async function sweepSwitches() {
    if (epochKeys.length < 2) {
      return;
    }
    switchSweepBtn.disabled = true;
    loadingIndicator.style.display = "block";
    const startIndex = Math.max(0, epochKeys.indexOf(currentEpoch));
    for (let i = 1; i <= epochKeys.length; ++i) {
      const key = epochKeys[(startIndex + i) % epochKeys.length];
      loadingIndicator.textContent = `Measuring switch to ${key}…`;
      // Sequential on purpose: overlapping switches would measure each other's streaming.
      await switchEpoch(key);
    }
    loadingIndicator.style.display = "none";
    switchSweepBtn.disabled = false;
  }

  // -------------------------------------------------------------------------
  // Load (or reload) a dataset pair.
  // -------------------------------------------------------------------------
  const viewerLabels = [
    document.getElementById("leftLabel"),
    document.getElementById("rightLabel"),
  ];
  const viewers = [leftViewer, rightViewer];

  async function loadPair(datasetName) {
    currentDataset = datasetName;
    loadingIndicator.style.display = "block";
    loadingIndicator.textContent = `Loading ${datasetName}…`;

    sides.forEach((side) => {
      if (defined(side.tileset)) {
        side.viewer.scene.primitives.remove(side.tileset);
        side.tileset = undefined;
      }
    });

    sides = readSides(DATASETS[datasetName]).map((side, index) => ({
      ...side,
      viewer: viewers[index],
      tileset: undefined,
    }));
    sides.forEach((side, index) => {
      viewerLabels[index].textContent = side.anchor
        ? `${side.key} (anchor)`
        : side.key;
    });

    const options = {
      cullRequestsWhileMoving: false,
      preloadWhenHidden: true,
      preloadFlightDestinations: true,
    };
    const urls = sides.map((side) => baseUrl + side.path);

    let tilesets;
    try {
      tilesets = await Promise.all(
        urls.map((url) => Cesium3DTileset.fromUrl(url, options)),
      );
    } catch (error) {
      loadingIndicator.textContent = `Error loading ${datasetName}`;
      console.error("ABTest: error loading tileset pair:", error);
      // eslint-disable-next-line no-alert
      window.alert(
        `Error loading ${datasetName}.\nExpected:\n  ${urls.join("\n  ")}\n\n${error}`,
      );
      return;
    }

    sides.forEach((side, index) => {
      side.tileset = tilesets[index];
      side.tileset.tileFailed.addEventListener((e) =>
        console.error(`ABTest[${side.key}] tileFailed:`, e.url, e.message),
      );
      side.viewer.scene.primitives.add(side.tileset);
    });

    applyControlsToBoth();
    buildEpochControls();
    renderTable();

    loadingIndicator.style.display = "none";
    applyPreset("oblique");
  }

  // -------------------------------------------------------------------------
  // Wire up the control panel.
  // -------------------------------------------------------------------------
  const datasetRow = document.getElementById("datasetRow");
  const datasetButtons = new Map();
  Object.keys(DATASETS).forEach((name) => {
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", async () => {
      for (const [key, b] of datasetButtons) {
        b.classList.toggle("active", key === name);
      }
      await loadPair(name);
    });
    datasetRow.appendChild(button);
    datasetButtons.set(name, button);
  });
  datasetButtons.get(currentDataset).classList.add("active");

  const sseRange = document.getElementById("sseRange");
  const sseValue = document.getElementById("sseValue");
  sseRange.addEventListener("input", () => {
    controls.sse = Number(sseRange.value);
    sseValue.textContent = sseRange.value;
    applyControlsToBoth();
  });

  const cacheInput = document.getElementById("cacheInput");
  document.getElementById("cacheApply").addEventListener("click", () => {
    const mb = Math.max(1, Number(cacheInput.value) || 0);
    controls.cacheBytes = mb * 1024 * 1024;
    applyControlsToBoth();
  });

  document.getElementById("colorizeToggle").addEventListener("change", (e) => {
    controls.colorize = e.target.checked;
    applyControlsToBoth();
  });
  document.getElementById("bvToggle").addEventListener("change", (e) => {
    controls.boundingVolume = e.target.checked;
    applyControlsToBoth();
  });
  document.getElementById("freezeToggle").addEventListener("change", (e) => {
    controls.freeze = e.target.checked;
    applyControlsToBoth();
  });

  document.getElementById("settleToggle").addEventListener("change", (e) => {
    controls.settle = e.target.checked;
  });

  let lastPreset = "oblique";
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      lastPreset = button.getAttribute("data-preset");
      applyPreset(lastPreset);
    });
  });

  switchSweepBtn.addEventListener("click", sweepSwitches);

  // -------------------------------------------------------------------------
  // Capture. One row per capture holds both sides' statistics under a matched
  // camera + SSE. FPS is the shared page FPS (both viewers render together).
  // Rows are self-describing: they carry the side keys they were captured with, so a
  // table (or CSV) may mix datasets whose sides are named differently.
  // -------------------------------------------------------------------------
  const STAT_FIELDS = [
    "selected",
    "numberOfCommands",
    "numberOfPointsSelected",
    "numberOfPendingRequests",
    "numberOfTilesProcessing",
    "numberOfTilesWithContentReady",
    "numberOfTilesTotal",
  ];
  const EPOCH_FIELDS = ["epoch", "activePoints"];
  const SWITCH_FIELDS = ["firstRenderMs", "settleMs"];
  const SIDE_COLUMNS = [...STAT_FIELDS, ...EPOCH_FIELDS, ...SWITCH_FIELDS];

  const SIDE_LABELS = {
    selected: "Selected",
    numberOfCommands: "Commands",
    numberOfPointsSelected: "Points",
    numberOfPendingRequests: "Pending",
    numberOfTilesProcessing: "Processing",
    numberOfTilesWithContentReady: "Ready",
    numberOfTilesTotal: "Total",
    epoch: "Epoch",
    activePoints: "Active pts",
    firstRenderMs: "First ms",
    settleMs: "Settle ms",
  };

  function readSide(side, switchMeasurement) {
    const stats = defined(side.tileset) ? side.tileset.statistics : undefined;
    const out = { key: side.key };
    STAT_FIELDS.forEach((f) => {
      out[f] = defined(stats) ? stats[f] : 0;
    });
    const epochState = readEpochState(side);
    out.layout = epochState.layout;
    out.epoch = epochState.epoch;
    out.activePoints = epochState.activePoints;
    const measured = defined(switchMeasurement)
      ? switchMeasurement.find((m) => m.key === side.key)
      : undefined;
    out.firstRenderMs = defined(measured) ? measured.firstRenderMs : null;
    out.settleMs = defined(measured) ? measured.settleMs : null;
    out.dippedToZero = defined(measured) ? measured.dippedToZero : null;
    return out;
  }

  const captures = [];
  let capturing = false;

  function pushRow(kind, requestedEpoch, switchMeasurement, settled) {
    captures.push({
      kind: kind,
      dataset: currentDataset,
      preset: lastPreset,
      sse: controls.sse,
      cacheMB: Math.round(controls.cacheBytes / (1024 * 1024)),
      fps: Math.round(fps * 10) / 10,
      settled: settled ?? null,
      requestedEpoch: requestedEpoch ?? null,
      camera: readCameraPose(),
      viewport: readViewport(),
      sides: sides.map((side) => readSide(side, switchMeasurement)),
    });
    renderTable();
  }

  async function capture() {
    // Ignore re-entrant triggers (e.g. holding 'c') while a settle is in flight.
    if (capturing) {
      return;
    }
    capturing = true;

    let settled = null;
    if (controls.settle) {
      loadingIndicator.style.display = "block";
      loadingIndicator.textContent = "Settling…";
      settled = await waitForSettle();
      loadingIndicator.style.display = "none";
      if (!settled) {
        console.warn("ABTest: settle gate timed out; capturing anyway.");
      }
    }

    pushRow("state", currentEpoch, undefined, settled);
    capturing = false;
  }

  const META_COLUMNS = [
    "#",
    "Kind",
    "Dataset",
    "Preset",
    "SSE",
    "Cache MB",
    "FPS",
  ];

  function renderTable() {
    const thead = document.querySelector("#captureTable thead");
    const tbody = document.querySelector("#captureTable tbody");

    // The header carries the ACTIVE dataset's side keys, so it is rebuilt whenever the
    // pair changes; each row still records the keys it was captured with.
    thead.innerHTML = "";
    const top = document.createElement("tr");
    const bottom = document.createElement("tr");
    META_COLUMNS.forEach((label) => {
      const th = document.createElement("th");
      th.className = "text";
      th.rowSpan = 2;
      th.textContent = label;
      top.appendChild(th);
    });
    const columnClasses = ["oursCol", "ionCol"];
    sides.forEach((side, index) => {
      const th = document.createElement("th");
      th.className = `text ${columnClasses[index]}`;
      th.colSpan = SIDE_COLUMNS.length;
      th.textContent = side.anchor ? `${side.key} (anchor)` : side.key;
      top.appendChild(th);
      SIDE_COLUMNS.forEach((f) => {
        const sub = document.createElement("th");
        sub.className = columnClasses[index];
        sub.textContent = SIDE_LABELS[f];
        bottom.appendChild(sub);
      });
    });
    thead.appendChild(top);
    thead.appendChild(bottom);

    const format = (value) => {
      if (value === null || !defined(value)) {
        return "—";
      }
      return typeof value === "number" ? value.toLocaleString() : value;
    };

    tbody.innerHTML = "";
    captures.forEach((row, index) => {
      const tr = document.createElement("tr");
      [
        [index + 1, "text"],
        [
          row.kind === "switch" ? `switch → ${row.requestedEpoch}` : "state",
          "text",
        ],
        [row.dataset, "text"],
        [row.preset, "text"],
        [row.sse, ""],
        [row.cacheMB, ""],
        [row.fps, ""],
      ].forEach(([value, cls]) => {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = value;
        tr.appendChild(td);
      });
      row.sides.forEach((side, sideIndex) => {
        SIDE_COLUMNS.forEach((f) => {
          const td = document.createElement("td");
          td.className = columnClasses[sideIndex];
          td.textContent = format(side[f]);
          tr.appendChild(td);
        });
      });
      tbody.appendChild(tr);
    });
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const CAMERA_FIELDS = [
    "posX",
    "posY",
    "posZ",
    "heading",
    "pitch",
    "roll",
    "fovy",
  ];
  const VIEWPORT_FIELDS = ["bufferWidth", "bufferHeight", "pixelRatio"];
  // Per-side CSV columns. "key" and "layout" ride along so a CSV that mixes datasets with
  // differently named sides stays readable.
  const CSV_SIDE_FIELDS = [
    "key",
    "layout",
    ...STAT_FIELDS,
    ...EPOCH_FIELDS,
    ...SWITCH_FIELDS,
    "dippedToZero",
  ];

  function csvValue(value) {
    if (value === null || !defined(value)) {
      return "";
    }
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv() {
    // Sides are positional (a = left, b = right); each row carries their keys.
    const prefixes = ["a", "b"];
    const header = [
      "#",
      "kind",
      "dataset",
      "requestedEpoch",
      "preset",
      "sse",
      "cacheMB",
      "fps",
      "settled",
      ...CAMERA_FIELDS,
      ...VIEWPORT_FIELDS,
    ];
    prefixes.forEach((prefix) => {
      CSV_SIDE_FIELDS.forEach((f) => header.push(`${prefix}_${f}`));
    });

    const lines = captures.map((row, index) => {
      const values = [
        index + 1,
        row.kind,
        row.dataset,
        row.requestedEpoch,
        row.preset,
        row.sse,
        row.cacheMB,
        row.fps,
        row.settled,
        ...CAMERA_FIELDS.map((f) => row.camera[f]),
        ...VIEWPORT_FIELDS.map((f) => row.viewport[f]),
      ];
      prefixes.forEach((prefix, sideIndex) => {
        const side = row.sides[sideIndex];
        CSV_SIDE_FIELDS.forEach((f) =>
          values.push(defined(side) ? side[f] : null),
        );
      });
      return values.map(csvValue).join(",");
    });
    return [header.join(","), ...lines].join("\n");
  }

  document.getElementById("captureBtn").addEventListener("click", capture);
  document.getElementById("downloadCsvBtn").addEventListener("click", () => {
    download("ab_captures.csv", toCsv(), "text/csv");
  });
  document.getElementById("downloadJsonBtn").addEventListener("click", () => {
    download(
      "ab_captures.json",
      JSON.stringify(captures, null, 2),
      "application/json",
    );
  });
  document.getElementById("clearBtn").addEventListener("click", () => {
    captures.length = 0;
    renderTable();
  });

  // Keyboard: 'c' captures, so screenshots and captures stay in sync. Number keys and the
  // arrow keys switch epochs (and measure the switch) when the pair is multi-temporal.
  document.addEventListener("keydown", (event) => {
    if (event.key === "c" || event.key === "C") {
      capture();
      return;
    }
    if (epochKeys.length === 0) {
      return;
    }
    const index = epochKeys.indexOf(currentEpoch);
    if (event.key === "ArrowRight" && index < epochKeys.length - 1) {
      switchEpoch(epochKeys[index + 1]);
    } else if (event.key === "ArrowLeft" && index > 0) {
      switchEpoch(epochKeys[index - 1]);
    } else if (/^[1-9]$/.test(event.key)) {
      const target = epochKeys[Number(event.key) - 1];
      if (defined(target)) {
        switchEpoch(target);
      }
    }
  });

  await loadPair(currentDataset);
}

main();
