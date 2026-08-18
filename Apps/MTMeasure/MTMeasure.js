window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cartesian3,
  Cesium3DTileset,
  Color,
  Ellipsoid,
  HeadingPitchRoll,
  Math as CesiumMath,
  Matrix4,
  PerformanceMeasurer,
  Quaternion,
  RequestScheduler,
  Resource,
  SceneMode,
  Transforms,
  Viewer,
  defined,
  formatError,
} from "../../Build/CesiumUnminified/index.js";

// ---------------------------------------------------------------------------
// A single-viewer measurement app for multi-temporal (MT) point-cloud tilesets. It is
// driven entirely by URL parameters so an external pipeline can run it unattended: with
// auto=1 it flies a camera path at a CONSTANT SPEED, stopping every switchEvery seconds of
// flight to measure one epoch switch, and downloads two CSVs — its own per-stop rows plus the
// fork's PerformanceMeasurer's continuous samples. The stop schedule is a distance schedule
// (speed * switchEvery metres), so it does not depend on how many waypoints the path has, nor
// on how fast a tileset renders. The SWITCH SCHEDULE ends the run — laps * epochCount
// sequential switches then randomSwitches random ones — and the camera ping-pongs along the
// path for as long as that takes. See README.md for the parameters and the column order.
// ---------------------------------------------------------------------------
const DEFAULT_SPEED = 15; // m/s along the camera path
const DEFAULT_LAPS = 2;
// Seconds of FLIGHT between measurement stops. Converted to metres with the camera speed, so
// the schedule is a property of the path, not of how fast a tileset renders.
const DEFAULT_SWITCH_EVERY_SECONDS = 4;
const DEFAULT_SEED = 42;
const PERF_SAMPLE_MS = 100; // fixed, as in Apps/ComparisonTest
const SETTLE_TIMEOUT_MS = 2000;
const SWITCH_TIMEOUT_MS = 2000;
// A switch that never changes the frame (identical point counts, or a viewpoint that frames
// nothing) still has to finish: once streaming is quiet for this long it counts as settled
// with firstRenderMs left empty.
const SWITCH_MIN_OBSERVE_MS = 500;
const DOWNLOAD_GAP_MS = 400; // Firefox takes two programmatic downloads more reliably apart

// Where a local-coordinate tileset is planted when it is anchored (see anchorMatrix). The
// exact spot is irrelevant — the globe is off and nothing else is in the scene — but it must
// be deterministic, because a recorded camera path is only valid for the anchor it was
// recorded at.
const DEFAULT_ANCHOR = { lon: 0.0, lat: 0.0, height: 0.0 };
// A tileset counts as local-coordinate only if BOTH hold: it lies wholly deeper than this
// below the ellipsoid, and it is smaller than this across. Both together leave no room for a
// georeferenced dataset to be misread — real surface data is never 100 km down, and local
// point clouds are metres to kilometres wide, never continental.
const LOCAL_DEPTH_MARGIN_METRES = 100000.0;
const LOCAL_MAX_RADIUS_METRES = 100000.0;

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

/**
 * mulberry32 — a small deterministic 32-bit PRNG. One instance drives every random epoch
 * draw of a run, so the whole switch sequence is reproducible from the seed alone.
 * Math.random is deliberately not used anywhere in the measurement path.
 *
 * @param {number} seed The seed.
 * @returns {Function} A function returning floats in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function csvValue(value) {
  if (value === null || !defined(value)) {
    return "";
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function numberParam(params, key, fallback) {
  const raw = params.get(key);
  if (raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Is this tileset in a local coordinate system rather than ECEF? Deliberately conservative:
 * it must be certain, because anchoring moves the data. py3dtiles writes a local frame when
 * the convert had no output CRS, which leaves the whole dataset sitting near the geocentre —
 * i.e. thousands of kilometres inside the ellipsoid, where the camera controls stop working
 * (Cesium navigates the WGS84 ellipsoid, and a camera inside it picks the far side).
 *
 * @param {BoundingSphere} sphere The tileset's bounding sphere, before any anchoring.
 * @returns {boolean} True only when the frame cannot be ECEF.
 */
function isLocalFrame(sphere) {
  const surface = Ellipsoid.default.minimumRadius;
  const outerReach = Cartesian3.magnitude(sphere.center) + sphere.radius;
  return (
    sphere.radius < LOCAL_MAX_RADIUS_METRES &&
    outerReach < surface - LOCAL_DEPTH_MARGIN_METRES
  );
}

/**
 * The east-north-up frame that puts a local tileset's centre on the ellipsoid at the anchor.
 * The ENU frame alone would plant the data's own origin there, which for a py3dtiles local
 * convert is some hundreds of metres off the cloud (the root transform carries that offset),
 * so the cloud's centre is translated onto the anchor first. Local +X/+Y/+Z then read as
 * east/north/up, which is how a projected CRS is meant to be interpreted.
 *
 * @param {object} anchor Anchor as { lon, lat, height } in degrees and metres.
 * @param {Cartesian3} localCentre The bounding-sphere centre in the tileset's own frame.
 * @returns {Matrix4} The matrix to assign to <code>tileset.modelMatrix</code>.
 */
function anchorMatrix(anchor, localCentre) {
  const enu = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.height),
  );
  return Matrix4.multiply(
    enu,
    Matrix4.fromTranslation(Cartesian3.negate(localCentre, new Cartesian3())),
    new Matrix4(),
  );
}

/**
 * Canonical text for an anchor, used in the CSV column, the recorded path JSON and the
 * mismatch check. Fixed precision so two anchors compare exactly.
 *
 * @param {object} [anchor] Anchor as { lon, lat, height }.
 * @returns {string|null} <code>"lon,lat,height"</code>, or null when not anchored.
 */
function anchorLabel(anchor) {
  if (!defined(anchor) || anchor === null) {
    return null;
  }
  return (
    `${anchor.lon.toFixed(6)},${anchor.lat.toFixed(6)},` +
    `${anchor.height.toFixed(3)}`
  );
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const statusElement = document.getElementById("mtStatus");
  const infoElement = document.getElementById("mtInfo");
  const progressElement = document.getElementById("mtProgress");
  const poseElement = document.getElementById("mtPose");
  const loadingIndicator = document.getElementById("loadingIndicator");

  function setStatus(text, cls) {
    statusElement.textContent = text;
    statusElement.className = `mtStatus${defined(cls) ? ` ${cls}` : ""}`;
  }
  function setProgress(text) {
    progressElement.textContent = text;
  }
  function fail(message) {
    loadingIndicator.style.display = "none";
    setStatus("error", "error");
    setProgress(message);
    console.error(`MTMeasure: ${message}`);
    // eslint-disable-next-line no-alert
    window.alert(`MTMeasure: ${message}`);
  }

  const tilesetUrl = params.get("tileset");
  const auto = params.get("auto") === "1";
  const record = params.get("record") === "1";

  if (auto && record) {
    fail("auto=1 and record=1 are mutually exclusive.");
    return;
  }
  if (!auto && !record) {
    // No mode: usage overlay only, nothing is loaded or measured.
    document.getElementById("mtUsage").style.display = "block";
    loadingIndicator.style.display = "none";
    setStatus("usage");
    return;
  }
  if (!defined(tilesetUrl) || tilesetUrl === "") {
    fail("the tileset parameter is required.");
    return;
  }

  const name =
    params.get("name") ??
    tilesetUrl.split("?")[0].split("/").filter(Boolean).slice(-2, -1)[0] ??
    "tileset";
  const seed = numberParam(params, "seed", DEFAULT_SEED);
  const laps = Math.max(1, numberParam(params, "laps", DEFAULT_LAPS));
  const sseParam =
    params.get("sse") === null ? null : numberParam(params, "sse", null);
  const cacheMBParam =
    params.get("cacheMB") === null
      ? null
      : numberParam(params, "cacheMB", null);
  // The shared-tree layout's memory knobs. Worth exposing for their own sake — they are what
  // decides how many epochs stay resident — and required to observe eviction at all: an epoch
  // inside the prefetch window is never evicted, so with few epochs the default window of 2
  // covers the whole set and nothing can ever be evicted.
  const prefetchWindowParam =
    params.get("prefetchWindow") === null
      ? null
      : numberParam(params, "prefetchWindow", null);
  const retainedHistoryParam =
    params.get("retainedHistory") === null
      ? null
      : numberParam(params, "retainedHistory", null);

  // Where to plant a local-coordinate tileset: "off" leaves it where it is, "lon,lat[,height]"
  // overrides the default spot. Only ever applied to a tileset that is certainly local.
  const anchorParam = params.get("anchor");
  let anchorRequest = DEFAULT_ANCHOR;
  if (anchorParam === "off") {
    anchorRequest = null;
  } else if (anchorParam !== null && anchorParam !== "") {
    const parts = anchorParam.split(",").map(Number);
    if (
      parts.length < 2 ||
      parts.length > 3 ||
      parts.some((value) => !Number.isFinite(value))
    ) {
      fail(
        `anchor must be "off" or "lon,lat[,height]" — got "${anchorParam}".`,
      );
      return;
    }
    anchorRequest = {
      lon: parts[0],
      lat: parts[1],
      height: parts.length === 3 ? parts[2] : 0.0,
    };
  }

  // -------------------------------------------------------------------------
  // Viewer. Same construction as Apps/ABTest so streaming behaves identically.
  // -------------------------------------------------------------------------
  RequestScheduler.maximumRequests = 2000000;
  RequestScheduler.maximumRequestsPerServer = 100000;

  let viewer;
  try {
    viewer = new Viewer("cesiumContainer", VIEWER_OPTIONS);
  } catch (exception) {
    fail(formatError(exception));
    return;
  }
  const scene = viewer.scene;
  scene.backgroundColor = Color.fromCssColorString("#1c1c1c");
  scene.debugShowFramesPerSecond = true;

  // Page-level FPS sampler over a 500 ms window, exactly as ABTest does it.
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
  // Load the tileset and start counting the events the rows report.
  // -------------------------------------------------------------------------
  loadingIndicator.style.display = "block";
  loadingIndicator.textContent = `Loading ${name}…`;
  setStatus("loading");

  let tileset;
  try {
    tileset = await Cesium3DTileset.fromUrl(tilesetUrl, {
      cullRequestsWhileMoving: false,
    });
  } catch (error) {
    fail(`could not load ${tilesetUrl}\n\n${error}`);
    return;
  }
  if (sseParam !== null) {
    tileset.maximumScreenSpaceError = sseParam;
  }
  if (cacheMBParam !== null) {
    tileset.cacheBytes = cacheMBParam * 1024 * 1024;
  }
  if (prefetchWindowParam !== null) {
    tileset.mtPrefetchWindow = prefetchWindowParam;
  }
  if (retainedHistoryParam !== null) {
    tileset.mtRetainedHistory = retainedHistoryParam;
  }
  tileset.debugShowStatistics = true;

  // -------------------------------------------------------------------------
  // Local-coordinate tilesets. A convert without an output CRS leaves the data near the
  // geocentre, thousands of kilometres inside the WGS84 ellipsoid — and since Cesium's camera
  // controls navigate that ellipsoid, a camera inside it picks the far side: orbiting a
  // 577 m-wide cloud then moves the camera ~4 m per 120 px drag, and one wheel notch jumps
  // ~240 m regardless of how big the data is. Anchoring the data onto the ellipsoid with an
  // east-north-up frame restores ordinary controls, because to Cesium it is then simply a
  // georeferenced tileset. Applied before the tileset is added so nothing renders at the
  // wrong place, and before the camera path is built so the path is in the anchored frame.
  //
  // Note the cost: a recorded path's positions are ECEF, hence only valid for the anchor they
  // were recorded at. The anchor therefore goes into the path JSON, into every CSV row, and is
  // checked on replay (see parsePathJson) rather than being allowed to fail silently.
  const localCentre = Cartesian3.clone(
    tileset.boundingSphere.center,
    new Cartesian3(),
  );
  const localRadius = tileset.boundingSphere.radius;
  const tilesetIsLocal = isLocalFrame(tileset.boundingSphere);
  let anchor = null;
  if (tilesetIsLocal && defined(anchorRequest) && anchorRequest !== null) {
    anchor = anchorRequest;
    tileset.modelMatrix = anchorMatrix(anchor, localCentre);
    console.log(
      `MTMeasure: local-coordinate tileset (centre ${Cartesian3.magnitude(
        localCentre,
      ).toFixed(
        1,
      )} m from the geocentre, radius ${localRadius.toFixed(1)} m) ` +
        `anchored at ${anchorLabel(anchor)} so the camera controls behave normally.`,
    );
  } else if (tilesetIsLocal) {
    console.warn(
      "MTMeasure: this tileset is in local coordinates and anchoring is off — " +
        "the camera controls will barely respond. Drop anchor=off to fix it.",
    );
  } else if (
    anchorParam !== null &&
    anchorParam !== "" &&
    anchorParam !== "off"
  ) {
    console.warn(
      `MTMeasure: ignoring anchor=${anchorParam} — this tileset is already georeferenced ` +
        "and is left where it is.",
    );
  }

  scene.primitives.add(tileset);

  let tileLoads = 0;
  let tileUnloads = 0;
  let tileFailures = 0;
  tileset.tileLoad.addEventListener(() => {
    tileLoads++;
  });
  tileset.tileUnload.addEventListener(() => {
    tileUnloads++;
  });
  tileset.tileFailed.addEventListener((event) => {
    tileFailures++;
    console.error("MTMeasure: tileFailed:", event.url, event.message);
  });

  const epochKeys = defined(tileset.timestampKeys)
    ? tileset.timestampKeys.slice()
    : [];
  const isMT = epochKeys.length > 0;
  // How many seeded-random switches follow the sequential laps. Defaults to one per epoch, and
  // is forced to 0 for a single-key tileset: a draw must exclude the active epoch, so there is
  // no legal target and the run would otherwise schedule stops it cannot fill.
  const randomSwitches =
    epochKeys.length < 2
      ? 0
      : Math.max(0, numberParam(params, "randomSwitches", epochKeys.length));

  infoElement.innerHTML = `${name} — ${
    isMT
      ? `${epochKeys.length} epochs (${tileset.resolvedMTLayout ?? "layout unknown"})`
      : "single epoch"
  }${anchor === null ? "" : ` — local frame, anchored at ${anchorLabel(anchor)}`}`;

  // -------------------------------------------------------------------------
  // Camera path. Either a recorded JSON (path=<url>) or a traverse generated from the
  // tileset's bounding sphere, so any tileset can be flown without a recording.
  // Waypoint poses are stored in radians; the JSON carries degrees.
  // -------------------------------------------------------------------------
  function makeWaypoint(label, position, headingDeg, pitchDeg, rollDeg) {
    return {
      label: label,
      position: position,
      heading: CesiumMath.toRadians(headingDeg),
      pitch: CesiumMath.toRadians(pitchDeg),
      roll: CesiumMath.toRadians(rollDeg ?? 0.0),
    };
  }

  /**
   * The heading/pitch that looks from <code>position</code> at <code>target</code>, expressed
   * in the local ENU frame at <code>position</code> — which is the frame
   * <code>camera.setView</code> interprets heading/pitch in.
   *
   * @param {Cartesian3} position Camera position, ECEF.
   * @param {Cartesian3} target Point to look at, ECEF.
   * @returns {object} <code>{ headingDeg, pitchDeg }</code>.
   */
  function lookAtAngles(position, target) {
    const toTargetEcef = Cartesian3.subtract(
      target,
      position,
      new Cartesian3(),
    );
    const enuAtPosition = Transforms.eastNorthUpToFixedFrame(position);
    const ecefToEnu = Matrix4.inverseTransformation(
      enuAtPosition,
      new Matrix4(),
    );
    const local = Matrix4.multiplyByPointAsVector(
      ecefToEnu,
      toTargetEcef,
      new Cartesian3(),
    );
    Cartesian3.normalize(local, local);
    // ENU: x = east, y = north, z = up. Heading is measured from north, clockwise; pitch is
    // negative when looking down.
    return {
      headingDeg: CesiumMath.toDegrees(Math.atan2(local.x, local.y)),
      pitchDeg: CesiumMath.toDegrees(Math.asin(local.z)),
    };
  }

  function generatePath() {
    const sphere = tileset.boundingSphere;
    const r = sphere.radius;
    const enu = Transforms.eastNorthUpToFixedFrame(sphere.center);
    const at = (east, north, up) =>
      Matrix4.multiplyByPoint(
        enu,
        new Cartesian3(east * r, north * r, up * r),
        new Cartesian3(),
      );
    // A real traverse across the site: in from the south-west, over the centre, out to the
    // north-east. Every waypoint LOOKS AT the bounding-sphere centre, so the tileset stays
    // framed for the whole flight (a fixed heading would leave the site behind the camera
    // once past the centre, and nothing would be measured there). The look-at directions
    // differ per waypoint, so the orientation interpolation is still exercised.
    const positions = [
      { label: "wp0-approach", position: at(-1.0, -1.0, 0.6) },
      { label: "wp1-centre", position: at(0.0, 0.0, 0.45) },
      { label: "wp2-exit", position: at(1.0, 1.0, 0.6) },
    ];
    return {
      name: name,
      speed: DEFAULT_SPEED,
      generated: true,
      waypoints: positions.map((entry) => {
        // The centre waypoint sits above the middle of the site; looking straight at the
        // centre from there would be a nadir view, which is a fine measurement stimulus.
        const angles = lookAtAngles(entry.position, sphere.center);
        return makeWaypoint(
          entry.label,
          entry.position,
          angles.headingDeg,
          angles.pitchDeg,
          0.0,
        );
      }),
    };
  }

  function parsePathJson(json) {
    if (
      !defined(json) ||
      !Array.isArray(json.waypoints) ||
      json.waypoints.length < 1
    ) {
      throw new Error(
        "camera path JSON needs a waypoints array with at least one entry",
      );
    }
    // Waypoint positions are ECEF, so a path recorded on an anchored tileset only means
    // anything at that same anchor. A mismatch would otherwise fly the camera through empty
    // space with no complaint, so it is refused here instead.
    const pathAnchor = Array.isArray(json.anchor)
      ? anchorLabel({
          lon: json.anchor[0],
          lat: json.anchor[1],
          height: json.anchor.length === 3 ? json.anchor[2] : 0.0,
        })
      : null;
    const runAnchor = anchorLabel(anchor);
    if (pathAnchor !== runAnchor) {
      throw new Error(
        `this path was recorded ${
          pathAnchor === null ? "without an anchor" : `at anchor ${pathAnchor}`
        }, but the run is ${
          runAnchor === null ? "not anchored" : `anchored at ${runAnchor}`
        }. Its ECEF positions do not describe this scene — re-record the path, pass a ` +
          `matching anchor=lon,lat[,height], or pass anchor=off.`,
      );
    }
    const waypoints = json.waypoints.map((wp, index) => {
      const p = wp.position;
      if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) {
        throw new Error(
          `waypoint ${index}: position must be [x, y, z] in ECEF metres`,
        );
      }
      const angles = [wp.heading, wp.pitch, wp.roll ?? 0.0];
      if (!angles.every(Number.isFinite)) {
        throw new Error(
          `waypoint ${index}: heading/pitch/roll must be numbers (degrees)`,
        );
      }
      return makeWaypoint(
        wp.label ?? `wp${index}`,
        new Cartesian3(p[0], p[1], p[2]),
        wp.heading,
        wp.pitch,
        wp.roll,
      );
    });
    return {
      name: json.name ?? name,
      speed: Number.isFinite(json.speed) ? json.speed : DEFAULT_SPEED,
      generated: false,
      waypoints: waypoints,
    };
  }

  let path;
  const pathUrl = params.get("path");
  if (defined(pathUrl) && pathUrl !== "") {
    try {
      const json = await Resource.fetchJson({ url: pathUrl });
      path = parsePathJson(json);
    } catch (error) {
      fail(`could not use the camera path ${pathUrl}\n\n${error}`);
      return;
    }
  } else {
    path = generatePath();
  }

  // URL speed wins over the JSON's, which wins over the default.
  const speed = Math.max(0.01, numberParam(params, "speed", path.speed));
  // The stop schedule: every switchEvery seconds of flight, i.e. every speed * switchEvery
  // metres along the path.
  const switchEverySeconds = Math.max(
    0.01,
    numberParam(params, "switchEvery", DEFAULT_SWITCH_EVERY_SECONDS),
  );
  const switchEveryMeters = speed * switchEverySeconds;

  // Polyline geometry: per-segment lengths and the cumulative distance at each waypoint.
  const segmentLengths = [];
  const cumulativeAt = [0];
  for (let i = 0; i < path.waypoints.length - 1; ++i) {
    const length = Cartesian3.distance(
      path.waypoints[i].position,
      path.waypoints[i + 1].position,
    );
    segmentLengths.push(length);
    cumulativeAt.push(cumulativeAt[i] + length);
  }
  const pathLength = cumulativeAt[cumulativeAt.length - 1];

  // Total metres travelled so far; recorded on every row. It counts UP for the whole run and
  // never bounces with the direction, so stop k always sits at k * switchEveryMeters.
  let pathMeters = 0;
  // 1-based index of the traversal the camera is on: odd = forward, even = backward.
  let traverse = 1;

  /**
   * Ping-pong fold: total distance travelled to a distance along the polyline plus the
   * traversal it belongs to. When the camera reaches the end of the path it REVERSES rather
   * than teleporting back to the start, so the motion stays continuous and every leg remains a
   * valid streaming stimulus. The schedule can then ask for more distance than the path is
   * long, which is what lets the switch schedule — rather than the path — end a run.
   *
   * @param {number} travelled Total distance travelled, in metres.
   * @returns {object} <code>{ along, traverse }</code>: distance along the polyline, and the
   * 1-based traversal index (odd forward, even backward).
   */
  function foldDistance(travelled) {
    if (pathLength <= 0) {
      return { along: 0, traverse: 1 };
    }
    const cycle = 2 * pathLength;
    const phase = travelled % cycle;
    return {
      along: phase <= pathLength ? phase : cycle - phase,
      // Ceil, not floor+1, so arriving exactly AT the far end still counts as the traversal
      // that just finished rather than flipping to the next one — otherwise a run that merely
      // flies the path to its end reports traverse 2 and reads as though it had looped.
      traverse: travelled <= 0 ? 1 : Math.ceil(travelled / pathLength),
    };
  }

  function setPose(position, heading, pitch, roll) {
    viewer.camera.setView({
      destination: position,
      orientation: { heading: heading, pitch: pitch, roll: roll },
    });
  }

  const scratchQuaternionA = new Quaternion();
  const scratchQuaternionB = new Quaternion();
  const scratchQuaternion = new Quaternion();
  const scratchHpr = new HeadingPitchRoll();
  const scratchPosition = new Cartesian3();

  /**
   * The index of the path segment containing a distance along the polyline. Distances at or
   * beyond the end map to the last segment, so the path end resolves to the final waypoint.
   *
   * @param {number} metres Distance along the polyline.
   * @returns {number} Segment index, or -1 for a zero-length path.
   */
  function segmentAt(metres) {
    if (segmentLengths.length === 0) {
      return -1;
    }
    for (let i = 0; i < segmentLengths.length; ++i) {
      if (metres <= cumulativeAt[i + 1] || i === segmentLengths.length - 1) {
        return i;
      }
    }
    return segmentLengths.length - 1;
  }

  /**
   * Place the camera at a distance along the polyline. Position interpolates linearly within
   * the segment; orientation is a shortest-arc slerp between the segment endpoints' poses
   * (Quaternion.slerp negates the end quaternion when the dot product is negative, so a
   * 350deg -> 10deg turn takes the 20deg route). Exactly at a waypoint the recorded pose is
   * applied verbatim.
   * <p>
   * The argument is TOTAL distance travelled, folded onto the polyline (see foldDistance), so
   * the pose is a pure function of it: the same travelled distance gives the same pose in every
   * run, on backward traversals as much as forward ones.
   * </p>
   *
   * @param {number} travelled Total distance travelled, in metres.
   */
  function setPoseAtDistance(travelled) {
    const folded = foldDistance(travelled);
    const metres = folded.along;
    traverse = folded.traverse;
    pathMeters = travelled;
    const index = segmentAt(metres);
    if (index < 0) {
      const only = path.waypoints[0];
      setPose(only.position, only.heading, only.pitch, only.roll);
      return;
    }
    const from = path.waypoints[index];
    const to = path.waypoints[index + 1];
    const length = segmentLengths[index];
    const local = CesiumMath.clamp(metres - cumulativeAt[index], 0, length);
    const t = length === 0 ? 1 : local / length;

    if (t <= 0) {
      setPose(from.position, from.heading, from.pitch, from.roll);
    } else if (t >= 1) {
      setPose(to.position, to.heading, to.pitch, to.roll);
    } else {
      Cartesian3.lerp(from.position, to.position, t, scratchPosition);
      Quaternion.fromHeadingPitchRoll(
        new HeadingPitchRoll(from.heading, from.pitch, from.roll),
        scratchQuaternionA,
      );
      Quaternion.fromHeadingPitchRoll(
        new HeadingPitchRoll(to.heading, to.pitch, to.roll),
        scratchQuaternionB,
      );
      Quaternion.slerp(
        scratchQuaternionA,
        scratchQuaternionB,
        t,
        scratchQuaternion,
      );
      HeadingPitchRoll.fromQuaternion(scratchQuaternion, scratchHpr);
      setPose(
        scratchPosition,
        scratchHpr.heading,
        scratchHpr.pitch,
        scratchHpr.roll,
      );
    }
  }

  /**
   * Fly along the path to a distance at a CONSTANT SPEED, driven by the wall clock: on every
   * frame the camera is placed at `startMetres + speed * elapsed` metres. Never a per-frame
   * step — a slow-rendering tileset must not get a slower camera, and dropped frames must make
   * the camera jump further, which is what keeps the stimulus fair between tilesets.
   * <p>
   * The flight clock advances only inside this function, so time spent settling or measuring a
   * switch never moves the camera. That is what makes a given switch happen at the same pose in
   * every run and for every tileset, however fast or slow each one renders.
   * </p>
   *
   * The target is a TOTAL travelled distance and may exceed the path length: the camera then
   * reverses at the end and flies back (see foldDistance), which is what keeps it moving until
   * the switch schedule is finished. A zero-length path is the one case with nowhere to fly, so
   * it returns immediately rather than idling for the scheduled time.
   *
   * @param {number} targetMetres Total travelled distance to fly to.
   * @returns {Promise<number>} Wall-clock duration of the flight in ms.
   */
  async function flyToDistance(targetMetres) {
    const startMetres = pathMeters;
    const distance = targetMetres - startMetres;
    const start = performance.now();
    if (pathLength <= 0) {
      setPoseAtDistance(0);
      return 0;
    }
    if (distance <= 0) {
      setPoseAtDistance(targetMetres);
      return 0;
    }
    for (;;) {
      const now = await nextFrame();
      const travelled = (speed * (now - start)) / 1000;
      if (travelled >= distance) {
        break;
      }
      setPoseAtDistance(startMetres + travelled);
    }
    setPoseAtDistance(startMetres + distance);
    return performance.now() - start;
  }

  // -------------------------------------------------------------------------
  // Settle gate and sampling helpers.
  // -------------------------------------------------------------------------
  function isStable() {
    const s = tileset.statistics;
    return s.numberOfPendingRequests === 0 && s.numberOfTilesProcessing === 0;
  }

  async function waitForSettle(timeoutMs = SETTLE_TIMEOUT_MS) {
    const start = performance.now();
    let stableFrames = 0;
    while (performance.now() - start <= timeoutMs) {
      await nextFrame();
      stableFrames = isStable() ? stableFrames + 1 : 0;
      if (stableFrames >= 2) {
        return true;
      }
    }
    return false;
  }

  function readCameraPose() {
    const cam = viewer.camera;
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
    return {
      bufferWidth: scene.drawingBufferWidth,
      bufferHeight: scene.drawingBufferHeight,
      pixelRatio: scene.pixelRatio,
    };
  }

  /**
   * How many epochs are resident inside the tiles selected this frame. Reads the fork's
   * per-tile content (private _selectedTiles, guarded) and reports the spread, which is the
   * only way to see prefetch/eviction behaviour from the outside.
   *
   * @returns {object} min / mean (2 dp) / max, all null when no selected tile exposes it.
   */
  function readResidentEpochs() {
    const selected = tileset._selectedTiles;
    if (!defined(selected)) {
      return { min: null, mean: null, max: null };
    }
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < selected.length; ++i) {
      const content = selected[i].content;
      const keys = defined(content) ? content.loadedTimestampKeys : undefined;
      if (!defined(keys)) {
        continue;
      }
      const n = keys.length;
      min = Math.min(min, n);
      max = Math.max(max, n);
      sum += n;
      count++;
    }
    if (count === 0) {
      return { min: null, mean: null, max: null };
    }
    return {
      min: min,
      mean: Math.round((sum / count) * 100) / 100,
      max: max,
    };
  }

  // -------------------------------------------------------------------------
  // Rows. One flat schema; switch-only columns stay empty on state rows.
  // -------------------------------------------------------------------------
  const CSV_COLUMNS = [
    "kind",
    "name",
    "tilesetUrl",
    "stop",
    "stopCount",
    "traverse",
    "waypoint",
    "waypointLabel",
    "mode",
    "lap",
    "seed",
    "requestedEpoch",
    "elapsedMs",
    "pathMeters",
    "speed",
    "switchEverySeconds",
    "switchEveryMeters",
    "sse",
    "cacheMB",
    "prefetchWindow",
    "retainedHistory",
    "anchor",
    "fps",
    "settled",
    "tileFailures",
    "posX",
    "posY",
    "posZ",
    "heading",
    "pitch",
    "roll",
    "fovy",
    "bufferWidth",
    "bufferHeight",
    "pixelRatio",
    "selected",
    "visited",
    "numberOfCommands",
    "numberOfPointsSelected",
    "numberOfPendingRequests",
    "numberOfTilesProcessing",
    "numberOfTilesWithContentReady",
    "numberOfTilesTotal",
    "numberOfLoadedTilesTotal",
    "numberOfAttemptedRequests",
    "layout",
    "epoch",
    "activePoints",
    "residentEpochsMin",
    "residentEpochsMean",
    "residentEpochsMax",
    "totalMemoryUsageInBytes",
    "geometryByteLength",
    "texturesByteLength",
    "batchTableByteLength",
    "tileLoads",
    "tileUnloads",
    "epochsEvicted",
    "firstRenderMs",
    "settleMs",
    "dippedToZero",
    "loadsDuring",
    "unloadsDuring",
    "epochsEvictedDuring",
    "attemptedDuring",
  ];

  const rows = [];
  let protocolStart = performance.now();
  let currentStop = 0;
  let lastSettled = null;

  /**
   * The path segment the camera is currently in, from its folded position. Clamped to 0 so a
   * zero-length path still names its single waypoint.
   *
   * @returns {number} Segment index.
   */
  function foldedSegment() {
    const index = segmentAt(foldDistance(pathMeters).along);
    return index < 0 ? 0 : index;
  }

  /**
   * Append one row. `extra` carries the switch-only fields; everything else is sampled here
   * so state and switch rows are directly comparable.
   *
   * @param {string} kind "state" or "switch".
   * @param {object} [extra] Switch-only fields.
   */
  function pushRow(kind, extra) {
    const s = tileset.statistics;
    const pose = readCameraPose();
    const viewport = readViewport();
    const resident = readResidentEpochs();
    const row = {
      kind: kind,
      name: name,
      tilesetUrl: tilesetUrl,
      stop: currentStop,
      stopCount: stopCount,
      traverse: traverse,
      // The segment a stop falls in is a property of where it is ON the path, so the total
      // travelled distance is folded back onto the polyline first.
      waypoint: foldedSegment(),
      waypointLabel: path.waypoints[foldedSegment()].label,
      mode: null,
      lap: null,
      seed: seed,
      requestedEpoch: null,
      elapsedMs: Math.round(performance.now() - protocolStart),
      pathMeters: Math.round(pathMeters * 100) / 100,
      speed: speed,
      switchEverySeconds: switchEverySeconds,
      switchEveryMeters: Math.round(switchEveryMeters * 100) / 100,
      sse: tileset.maximumScreenSpaceError,
      cacheMB: Math.round(tileset.cacheBytes / (1024 * 1024)),
      prefetchWindow: isMT ? tileset.mtPrefetchWindow : null,
      retainedHistory: isMT ? tileset.mtRetainedHistory : null,
      anchor: anchorLabel(anchor),
      fps: Math.round(fps * 10) / 10,
      settled: lastSettled,
      tileFailures: tileFailures,
      ...pose,
      ...viewport,
      selected: s.selected,
      visited: s.visited,
      numberOfCommands: s.numberOfCommands,
      numberOfPointsSelected: s.numberOfPointsSelected,
      numberOfPendingRequests: s.numberOfPendingRequests,
      numberOfTilesProcessing: s.numberOfTilesProcessing,
      numberOfTilesWithContentReady: s.numberOfTilesWithContentReady,
      numberOfTilesTotal: s.numberOfTilesTotal,
      numberOfLoadedTilesTotal: s.numberOfLoadedTilesTotal,
      numberOfAttemptedRequests: s.numberOfAttemptedRequests,
      layout: tileset.resolvedMTLayout ?? null,
      epoch: tileset.activeTimestamp ?? null,
      activePoints: isMT ? tileset.activePointsRendered : null,
      residentEpochsMin: resident.min,
      residentEpochsMean: resident.mean,
      residentEpochsMax: resident.max,
      totalMemoryUsageInBytes: tileset.totalMemoryUsageInBytes,
      geometryByteLength: s.geometryByteLength,
      texturesByteLength: s.texturesByteLength,
      batchTableByteLength: s.batchTableByteLength,
      tileLoads: tileLoads,
      tileUnloads: tileUnloads,
      epochsEvicted: s.numberOfEpochsEvicted,
      firstRenderMs: null,
      settleMs: null,
      dippedToZero: null,
      loadsDuring: null,
      unloadsDuring: null,
      epochsEvictedDuring: null,
      attemptedDuring: null,
      ...(extra ?? {}),
    };
    rows.push(row);
    renderTable();
  }

  /**
   * Switch to an epoch and measure how long it takes to appear. Ported from ABTest's
   * switchEpoch for a single tileset: firstRenderMs is the first frame whose selected-point
   * count reflects the new epoch, settleMs the point at which streaming has quiesced.
   * <p>
   * The during-columns are deltas of cumulative counters, except attemptedDuring:
   * statistics.numberOfAttemptedRequests is reset every frame, so it is SUMMED per frame
   * across the switch instead of differenced.
   * </p>
   *
   * @param {string} key The timestamp key to switch to.
   * @param {string} mode "sequential" or "random".
   * @param {number} lap Lap number, or the 1-based random draw index.
   * @returns {Promise<object>} The measured values.
   */
  async function switchEpoch(key, mode, lap) {
    const baselinePoints = tileset.statistics.numberOfPointsSelected;
    const before = {
      loads: tileLoads,
      unloads: tileUnloads,
      evicted: tileset.statistics.numberOfEpochsEvicted,
    };

    const start = performance.now();
    tileset.activeTimestamp = key;

    let firstRenderMs = null;
    let settleMs = null;
    let dippedToZero = false;
    let attemptedDuring = 0;
    let stableFrames = 0;
    for (;;) {
      const now = await nextFrame();
      const elapsed = now - start;
      const s = tileset.statistics;
      const points = s.numberOfPointsSelected;
      attemptedDuring += s.numberOfAttemptedRequests;

      if (points === 0) {
        dippedToZero = true;
      }
      if (firstRenderMs === null && points > 0 && points !== baselinePoints) {
        firstRenderMs = Math.round(elapsed);
      }

      // Settle is judged from streaming alone, NOT from having seen a first render: the new
      // epoch's frame content can legitimately be identical to the old one (equal selected
      // point counts), and a viewpoint that frames nothing renders zero points either way.
      // Gating settle on firstRenderMs would then hang until the timeout. The floor gives a
      // switch a fair chance to start rendering before it is called settled without one.
      stableFrames = isStable() ? stableFrames + 1 : 0;
      if (
        stableFrames >= 2 &&
        (firstRenderMs !== null || elapsed >= SWITCH_MIN_OBSERVE_MS)
      ) {
        settleMs = Math.round(elapsed);
        break;
      }
      if (elapsed > SWITCH_TIMEOUT_MS) {
        break;
      }
    }

    const measured = {
      mode: mode,
      lap: lap,
      requestedEpoch: key,
      firstRenderMs: firstRenderMs,
      settleMs: settleMs,
      dippedToZero: dippedToZero,
      loadsDuring: tileLoads - before.loads,
      unloadsDuring: tileUnloads - before.unloads,
      epochsEvictedDuring:
        tileset.statistics.numberOfEpochsEvicted - before.evicted,
      attemptedDuring: attemptedDuring,
    };
    pushRow("switch", measured);
    return measured;
  }

  // -------------------------------------------------------------------------
  // On-page table: a readable subset. The CSV carries every column.
  // -------------------------------------------------------------------------
  const TABLE_COLUMNS = [
    "kind",
    "stop",
    "waypointLabel",
    "mode",
    "lap",
    "epoch",
    "elapsedMs",
    "pathMeters",
    "fps",
    "numberOfPointsSelected",
    "totalMemoryUsageInBytes",
    "residentEpochsMean",
    "firstRenderMs",
    "settleMs",
    "loadsDuring",
    "unloadsDuring",
    "epochsEvictedDuring",
    "attemptedDuring",
  ];

  function renderTable() {
    const wrap = document.getElementById("mtTableWrap");
    wrap.style.display = "block";
    const thead = wrap.querySelector("thead");
    const tbody = wrap.querySelector("tbody");
    if (thead.childElementCount === 0) {
      const tr = document.createElement("tr");
      ["#", ...TABLE_COLUMNS].forEach((label) => {
        const th = document.createElement("th");
        th.className = "text";
        th.textContent = label;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }
    tbody.innerHTML = "";
    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      if (row.kind === "switch") {
        tr.className = "switchRow";
      }
      const indexCell = document.createElement("td");
      indexCell.textContent = index + 1;
      tr.appendChild(indexCell);
      TABLE_COLUMNS.forEach((column) => {
        const td = document.createElement("td");
        const value = row[column];
        if (value === null || !defined(value)) {
          td.textContent = "—";
        } else if (typeof value === "number") {
          td.textContent = value.toLocaleString();
        } else {
          td.className = "text";
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function toCsv() {
    const lines = rows.map((row) =>
      CSV_COLUMNS.map((column) => csvValue(row[column])).join(","),
    );
    return [CSV_COLUMNS.join(","), ...lines].join("\n");
  }

  document.getElementById("downloadCsvBtn").addEventListener("click", () => {
    download(`mtmeasure_${name}.csv`, toCsv(), "text/csv");
  });
  document.getElementById("downloadJsonBtn").addEventListener("click", () => {
    download(
      `mtmeasure_${name}.json`,
      JSON.stringify(rows, null, 2),
      "application/json",
    );
  });

  // -------------------------------------------------------------------------
  // Record mode: fly manually, collect waypoints, download the path JSON.
  // -------------------------------------------------------------------------
  if (record) {
    loadingIndicator.style.display = "none";
    setStatus("record");
    document.getElementById("mtRecordHelp").style.display = "";
    const listWrap = document.getElementById("mtWaypoints");
    const list = document.getElementById("mtWaypointList");
    listWrap.style.display = "block";
    setPoseAtDistance(0);

    const recorded = [];
    function renderWaypoints() {
      list.innerHTML = "";
      recorded.forEach((wp) => {
        const li = document.createElement("li");
        li.textContent = `${wp.label} — h ${wp.heading.toFixed(1)}° p ${wp.pitch.toFixed(1)}°`;
        list.appendChild(li);
      });
      setProgress(`${recorded.length} waypoint(s) recorded`);
    }
    renderWaypoints();

    scene.postRender.addEventListener(() => {
      const pose = readCameraPose();
      poseElement.textContent = `pose: ${pose.posX.toFixed(1)}, ${pose.posY.toFixed(
        1,
      )}, ${pose.posZ.toFixed(1)} — h ${pose.heading.toFixed(1)}° p ${pose.pitch.toFixed(1)}°`;
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "w" || event.key === "W") {
        const pose = readCameraPose();
        recorded.push({
          label: `wp${recorded.length}`,
          position: [pose.posX, pose.posY, pose.posZ],
          heading: pose.heading,
          pitch: pose.pitch,
          roll: pose.roll,
        });
        renderWaypoints();
      } else if (event.key === "u" || event.key === "U") {
        recorded.pop();
        renderWaypoints();
      } else if (event.key === "d" || event.key === "D") {
        download(
          `camera_path_${name}.json`,
          JSON.stringify(
            {
              name: name,
              speed: DEFAULT_SPEED,
              // Only meaningful together with the anchor the poses were recorded at.
              ...(anchor === null
                ? {}
                : { anchor: [anchor.lon, anchor.lat, anchor.height] }),
              waypoints: recorded,
            },
            null,
            2,
          ),
          "application/json",
        );
      }
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Auto mode: the measurement protocol.
  // -------------------------------------------------------------------------
  document.getElementById("mtButtons").style.display = "";
  const controller = scene.screenSpaceCameraController;
  const inputsWereEnabled = controller.enableInputs;
  controller.enableInputs = false;

  const random = mulberry32(seed);
  const measurer = new PerformanceMeasurer(
    PERF_SAMPLE_MS,
    Number.MAX_SAFE_INTEGER,
  );
  measurer.attachToRequestScheduler(RequestScheduler);
  measurer.attachToTileset(tileset);
  measurer.attachToSceneRenderer(scene);

  protocolStart = performance.now();
  measurer.start();

  setStatus("running");
  loadingIndicator.textContent = "Settling…";

  // Measurement stops stay scheduled by DISTANCE — one every switchEveryMeters of travelled
  // distance — but the SCHEDULE, not the path, ends the run: `laps * epochCount` sequential
  // switches followed by `randomSwitches` seeded-random ones. When the camera reaches the end
  // of the path it REVERSES and flies back (ping-pong, see foldDistance), over as many
  // traversals as the schedule needs, so a short recorded path no longer truncates a dataset
  // with many timestamps. Since the flight clock only advances while flying, stop k sits at
  // travelled distance k * switchEveryMeters — the same pose in every run and for every
  // tileset, no matter how long that tileset takes to settle or to switch.
  const sequentialTotal = isMT ? laps * epochKeys.length : 0;
  const scheduledSwitches = sequentialTotal + randomSwitches;
  // A tileset with no timestamps has no schedule to follow, so it keeps the as-built
  // behaviour: a single traverse of the path, one state row per stop, no looping.
  const pathStops =
    1 +
    (pathLength > 0 ? Math.floor((pathLength - 1e-6) / switchEveryMeters) : 0);
  const stopCount = isMT ? scheduledSwitches : pathStops;
  let switchIndex = 0;
  let randomDraw = 0;

  // How far the schedule will make the camera travel, and how many traversals of the path
  // that folds into.
  const plannedTravel = (stopCount - 1) * switchEveryMeters;
  const plannedTraversals =
    pathLength > 0 ? Math.floor(plannedTravel / pathLength) + 1 : 1;
  const scheduleNote = isMT
    ? `, ${sequentialTotal} sequential + ${randomSwitches} random switches over ` +
      `${plannedTraversals} traversal(s) (${plannedTravel.toFixed(0)} m of travel)`
    : " (single traverse, no epochs to switch)";
  console.log(
    `MTMeasure: ${pathLength.toFixed(1)} m path, stop every ` +
      `${switchEveryMeters.toFixed(1)} m (${switchEverySeconds} s at ${speed} m/s) → ` +
      `${stopCount} stops${scheduleNote}`,
  );

  setPoseAtDistance(0);

  for (let stop = 0; stop < stopCount; ++stop) {
    const target = stop * switchEveryMeters;
    if (stop > 0) {
      setProgress(
        `stop ${stop + 1}/${stopCount} — flying to ${target.toFixed(0)} m`,
      );
      const flightMs = await flyToDistance(target);
      if (flightMs > 0) {
        console.log(
          `MTMeasure: flew ${switchEveryMeters.toFixed(1)} m in ${Math.round(flightMs)} ms ` +
            `(${(switchEveryMeters / (flightMs / 1000)).toFixed(2)} m/s target ${speed}), ` +
            `traverse ${traverse} ${traverse % 2 === 1 ? "forward" : "backward"}`,
        );
      }
    }
    currentStop = stop + 1;

    setProgress(`stop ${stop + 1}/${stopCount} — settling`);
    lastSettled = await waitForSettle();
    loadingIndicator.style.display = "none";

    // One state row per measurement stop; the first is the baseline.
    pushRow("state");

    if (!isMT) {
      continue;
    }

    // One switch per stop: sequential while the laps last, seeded-random afterwards. Random
    // draws never re-select the epoch that is already active, since a same-epoch switch is a
    // no-op that would corrupt the first-render measurement.
    let key;
    let mode;
    let lap;
    if (switchIndex < sequentialTotal) {
      const activeIndex = epochKeys.indexOf(tileset.activeTimestamp);
      key = epochKeys[(activeIndex + 1) % epochKeys.length];
      mode = "sequential";
      lap = Math.floor(switchIndex / epochKeys.length) + 1;
    } else {
      const candidates = epochKeys.filter(
        (candidate) => candidate !== tileset.activeTimestamp,
      );
      if (candidates.length === 0) {
        // Unreachable: randomSwitches is 0 unless there are at least two epochs. If it ever
        // did happen the schedule could not be fulfilled, so end rather than leave a stop
        // that carries a state row but no switch.
        console.warn(
          "MTMeasure: no epoch left to draw — ending the schedule early.",
        );
        break;
      }
      key = candidates[Math.floor(random() * candidates.length)];
      mode = "random";
      randomDraw++;
      lap = randomDraw;
    }
    switchIndex++;
    setProgress(`stop ${stop + 1}/${stopCount} — ${mode} switch → ${key}`);
    await switchEpoch(key, mode, lap);
  }

  // An MT run is over the moment its schedule is: the closing state row is taken at the last
  // stop's pose, without flying the rest of the path. A non-MT run still finishes the path.
  if (!isMT && pathMeters < pathLength) {
    setProgress("flying to the end of the path");
    await flyToDistance(pathLength);
  }
  setProgress("final settle");
  lastSettled = await waitForSettle();
  currentStop = stopCount + 1;
  pushRow("state");

  // Two downloads: this app's rows, then the PerformanceMeasurer's continuous samples.
  download(`mtmeasure_${name}.csv`, toCsv(), "text/csv");
  await sleep(DOWNLOAD_GAP_MS);
  measurer.dumpData(`perf_${name}.csv`);

  controller.enableInputs = inputsWereEnabled;
  setStatus("done", "done");
  setProgress(
    `${rows.length} rows, ${switchIndex} switches, ${pathMeters.toFixed(1)} m travelled ` +
      `over ${traverse} traverse(s) of a ${pathLength.toFixed(1)} m path at ${speed} m/s, ` +
      `stop every ${switchEveryMeters.toFixed(1)} m`,
  );
  window.MTMEASURE_DONE = true;
}

main();
