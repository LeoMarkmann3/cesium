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
// Tileset locations. All four are LOCAL 3D Tiles; serve ~/output over HTTP with
// permissive CORS (see README) and point BASE_URL at it. Override with ?base=<url>.
// The "ion" entries are local copies of Cesium Ion's output — no token needed.
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = "http://localhost:8003";

const DATASETS = {
  Sauen: {
    ours: "/ImprovedV34/out_tileset/tileset.json",
    ion: "/CesiumIon/out_tileset/tileset.json",
  },
  Synthetic: {
    ours: "/ImprovedV35/out_tileset/tileset.json",
    ion: "/CesiumIon2/out_tileset/tileset.json",
  },
};

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
  };
  let currentDataset = "Sauen";
  let oursTileset;
  let ionTileset;

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
    applyControls(oursTileset);
    applyControls(ionTileset);
  }

  // -------------------------------------------------------------------------
  // Camera presets, derived from the loaded bounding sphere so they work for any
  // dataset pair. Applied to the left (active) viewer; sync propagates to the right.
  // -------------------------------------------------------------------------
  function applyPreset(name) {
    if (!defined(oursTileset)) {
      return;
    }
    const sphere = oursTileset.boundingSphere;
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
  // Load (or reload) a dataset pair.
  // -------------------------------------------------------------------------
  async function loadPair(datasetName) {
    currentDataset = datasetName;
    loadingIndicator.style.display = "block";
    loadingIndicator.textContent = `Loading ${datasetName}…`;

    if (defined(oursTileset)) {
      leftViewer.scene.primitives.remove(oursTileset);
      oursTileset = undefined;
    }
    if (defined(ionTileset)) {
      rightViewer.scene.primitives.remove(ionTileset);
      ionTileset = undefined;
    }

    const spec = DATASETS[datasetName];
    const oursUrl = baseUrl + spec.ours;
    const ionUrl = baseUrl + spec.ion;
    const options = {
      cullRequestsWhileMoving: false,
      preloadWhenHidden: true,
      preloadFlightDestinations: true,
    };

    try {
      [oursTileset, ionTileset] = await Promise.all([
        Cesium3DTileset.fromUrl(oursUrl, options),
        Cesium3DTileset.fromUrl(ionUrl, options),
      ]);
    } catch (error) {
      loadingIndicator.textContent = `Error loading ${datasetName}`;
      console.error("ABTest: error loading tileset pair:", error);
      // eslint-disable-next-line no-alert
      window.alert(
        `Error loading ${datasetName}.\nExpected:\n  ${oursUrl}\n  ${ionUrl}\n\n${error}`,
      );
      return;
    }

    leftViewer.scene.primitives.add(oursTileset);
    rightViewer.scene.primitives.add(ionTileset);
    applyControlsToBoth();

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

  let lastPreset = "oblique";
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      lastPreset = button.getAttribute("data-preset");
      applyPreset(lastPreset);
    });
  });

  // -------------------------------------------------------------------------
  // Capture. One row per capture holds both sides' statistics under a matched
  // camera + SSE. FPS is the shared page FPS (both viewers render together).
  // -------------------------------------------------------------------------
  const SIDE_FIELDS = [
    "selected",
    "numberOfCommands",
    "numberOfPointsSelected",
    "numberOfPendingRequests",
    "numberOfTilesProcessing",
    "numberOfTilesWithContentReady",
    "numberOfTilesTotal",
  ];

  function readSide(tileset) {
    const s = defined(tileset) ? tileset.statistics : undefined;
    const out = {};
    SIDE_FIELDS.forEach((f) => {
      out[f] = defined(s) ? s[f] : 0;
    });
    return out;
  }

  const captures = [];

  function capture() {
    const row = {
      dataset: currentDataset,
      preset: lastPreset,
      sse: controls.sse,
      cacheMB: Math.round(controls.cacheBytes / (1024 * 1024)),
      fps: Math.round(fps * 10) / 10,
      ours: readSide(oursTileset),
      ion: readSide(ionTileset),
    };
    captures.push(row);
    renderTable();
  }

  const SIDE_LABELS = {
    selected: "Selected",
    numberOfCommands: "Commands",
    numberOfPointsSelected: "Points",
    numberOfPendingRequests: "Pending",
    numberOfTilesProcessing: "Processing",
    numberOfTilesWithContentReady: "Ready",
    numberOfTilesTotal: "Total",
  };

  function renderTable() {
    const thead = document.querySelector("#captureTable thead");
    const tbody = document.querySelector("#captureTable tbody");

    if (thead.childElementCount === 0) {
      const top = document.createElement("tr");
      const bottom = document.createElement("tr");
      const meta = ["#", "Dataset", "Preset", "SSE", "Cache MB", "FPS"];
      meta.forEach((label) => {
        const th = document.createElement("th");
        th.className = "text";
        th.rowSpan = 2;
        th.textContent = label;
        top.appendChild(th);
      });
      [
        ["Ours (py3dtiles)", "oursCol"],
        ["Cesium Ion", "ionCol"],
      ].forEach(([label, cls]) => {
        const th = document.createElement("th");
        th.className = `text ${cls}`;
        th.colSpan = SIDE_FIELDS.length;
        th.textContent = label;
        top.appendChild(th);
        SIDE_FIELDS.forEach((f) => {
          const sub = document.createElement("th");
          sub.className = cls;
          sub.textContent = SIDE_LABELS[f];
          bottom.appendChild(sub);
        });
      });
      thead.appendChild(top);
      thead.appendChild(bottom);
    }

    tbody.innerHTML = "";
    captures.forEach((row, index) => {
      const tr = document.createElement("tr");
      const cells = [
        [index + 1, "text"],
        [row.dataset, "text"],
        [row.preset, "text"],
        [row.sse, ""],
        [row.cacheMB, ""],
        [row.fps, ""],
      ];
      cells.forEach(([value, cls]) => {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = value;
        tr.appendChild(td);
      });
      [
        [row.ours, "oursCol"],
        [row.ion, "ionCol"],
      ].forEach(([side, cls]) => {
        SIDE_FIELDS.forEach((f) => {
          const td = document.createElement("td");
          td.className = cls;
          td.textContent = side[f].toLocaleString();
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

  function toCsv() {
    const header = ["#", "dataset", "preset", "sse", "cacheMB", "fps"];
    ["ours", "ion"].forEach((side) => {
      SIDE_FIELDS.forEach((f) => header.push(`${side}_${f}`));
    });
    const lines = captures.map((row, index) => {
      const values = [
        index + 1,
        row.dataset,
        row.preset,
        row.sse,
        row.cacheMB,
        row.fps,
      ];
      ["ours", "ion"].forEach((side) => {
        SIDE_FIELDS.forEach((f) => values.push(row[side][f]));
      });
      return values.join(",");
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

  // Keyboard: 'c' captures, so screenshots and captures stay in sync.
  document.addEventListener("keydown", (event) => {
    if (event.key === "c" || event.key === "C") {
      capture();
    }
  });

  await loadPair(currentDataset);
}

main();
