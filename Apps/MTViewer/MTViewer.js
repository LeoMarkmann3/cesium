window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Cesium3DTileStyle,
  Viewer,
  RequestScheduler,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  formatError,
} from "../../Build/CesiumUnminified/index.js";

// ---------------------------------------------------------------------------
// Tileset URL — override with ?tileset=<url>, otherwise edit DEFAULT_TILESET_URL
// to wherever you are hosting MT_V4/out_tileset/tileset.json.
// ---------------------------------------------------------------------------
const DEFAULT_TILESET_URL = "http://localhost:8002/out_tileset/tileset.json";

function getTilesetUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("tileset") ?? DEFAULT_TILESET_URL;
}

async function main() {
  const loadingIndicator = document.getElementById("loadingIndicator");
  const panel = document.getElementById("mtPanel");
  const keysRow = document.getElementById("mtKeys");
  const activeRow = document.getElementById("mtActive");
  const pickedRow = document.getElementById("mtPicked");

  // Load everything (small test datasets) and don't cull while moving.
  RequestScheduler.maximumRequests = 2000000;
  RequestScheduler.maximumRequestsPerServer = 100000;

  let viewer;
  try {
    viewer = new Viewer("cesiumContainer", {
      timeline: false,
      animation: false,
      geocoder: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      selectionIndicator: false,
      infoBox: false,
    });
  } catch (exception) {
    loadingIndicator.style.display = "none";
    const message = formatError(exception);
    console.error(message);
    // eslint-disable-next-line no-alert
    window.alert(message);
    return;
  }

  const scene = viewer.scene;
  const url = getTilesetUrl();
  console.log("MTViewer: loading tileset from", url);
  console.log(
    "MTViewer: override the URL with ?tileset=<url> if it is hosted elsewhere.",
  );

  let tileset;
  try {
    tileset = await Cesium3DTileset.fromUrl(url, {
      cullRequestsWhileMoving: false,
      preloadWhenHidden: true,
      preloadFlightDestinations: true,
      maximumScreenSpaceError: 4,
    });
    scene.primitives.add(tileset);
    tileset.pointCloudShading.attenuation = true;
    tileset.pointCloudShading.maximumAttenuation = 4.0;
    await viewer.flyTo(tileset);
  } catch (error) {
    loadingIndicator.style.display = "none";
    console.error("MTViewer: error loading tileset:", error);
    // eslint-disable-next-line no-alert
    window.alert(`Error loading tileset from ${url}\n\n${error}`);
    return;
  }

  loadingIndicator.style.display = "none";

  // -------------------------------------------------------------------------
  // Multi-temporal controls
  // -------------------------------------------------------------------------
  const keys = tileset.timestampKeys;
  panel.style.display = "block";

  if (!defined(keys)) {
    keysRow.textContent =
      "Not a multi-temporal tileset (timestampKeys is undefined).";
    activeRow.textContent = "";
    pickedRow.textContent = "";
    console.warn("MTViewer: tileset.timestampKeys is undefined.");
    return;
  }

  console.log("MTViewer: timestampKeys =", keys);
  console.log("MTViewer: activeTimestamp =", tileset.activeTimestamp);

  const buttons = new Map();

  function refreshActive() {
    const active = tileset.activeTimestamp;
    activeRow.textContent = `Active: ${active}`;
    for (const [key, button] of buttons) {
      button.classList.toggle("active", key === active);
    }
  }

  function setActive(key) {
    try {
      tileset.activeTimestamp = key;
    } catch (e) {
      console.error("MTViewer: failed to set activeTimestamp:", e);
    }
  }

  keysRow.textContent = "Timestamps: ";
  keys.forEach((key) => {
    const button = document.createElement("button");
    button.textContent = key;
    button.addEventListener("click", () => setActive(key));
    keysRow.appendChild(button);
    buttons.set(key, button);
  });

  // Update the panel whenever the active timestamp changes (from any source).
  tileset.activeTimestampChanged.addEventListener((newKey) => {
    console.log("MTViewer: activeTimestampChanged ->", newKey);
    refreshActive();
  });
  refreshActive();

  // Keyboard: number keys select by index; arrows step previous/next.
  document.addEventListener("keydown", (event) => {
    const index = keys.indexOf(tileset.activeTimestamp);
    if (event.key >= "1" && event.key <= "9") {
      const i = parseInt(event.key, 10) - 1;
      if (i < keys.length) {
        setActive(keys[i]);
      }
    } else if (event.key === "ArrowRight") {
      setActive(keys[Math.min(index + 1, keys.length - 1)]);
    } else if (event.key === "ArrowLeft") {
      setActive(keys[Math.max(index - 1, 0)]);
    }
  });

  // -------------------------------------------------------------------------
  // Picking: left-click reads the picked feature's instance_id and highlights
  // every point of that tree (persists across epoch switches). Right-click clears.
  // -------------------------------------------------------------------------
  const handler = new ScreenSpaceEventHandler(scene.canvas);

  handler.setInputAction((movement) => {
    const picked = scene.pick(movement.position);
    if (defined(picked) && defined(picked.getProperty)) {
      const instanceId = picked.getProperty("instance_id");
      pickedRow.textContent = `Picked instance_id: ${instanceId}`;
      console.log("MTViewer: picked instance_id =", instanceId);
      tileset.style = new Cesium3DTileStyle({
        color: `\${instance_id} === ${instanceId} ? color('yellow') : color('white')`,
      });
    } else {
      pickedRow.textContent = "Picked instance_id: — (no feature)";
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction(() => {
    tileset.style = undefined;
    pickedRow.textContent = "Picked instance_id: —";
  }, ScreenSpaceEventType.RIGHT_CLICK);
}

main();
