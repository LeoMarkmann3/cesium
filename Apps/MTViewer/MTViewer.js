window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Cesium3DTileStyle,
  Color,
  Viewer,
  RequestScheduler,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  formatError,
  SceneMode,
  JulianDate,
  Cartesian3,
  Quaternion,
  HeadingPitchRoll,
  Math as CesiumMath,
  QuaternionSpline,
  Cartographic,
  Matrix4,
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
  scene.backgroundColor = Color.fromCssColorString("#3a3a3a");
  const url = getTilesetUrl();
  console.log("MTViewer: loading tileset from", url);
  console.log(
    "MTViewer: override the URL with ?tileset=<url> if it is hosted elsewhere.",
  );

  let tileset;
  try {
    const heightOffsetMeters = 50.0;

    tileset = await Cesium3DTileset.fromUrl(url, {
      cullRequestsWhileMoving: false,
      preloadWhenHidden: true,
      preloadFlightDestinations: true,
    });
    scene.primitives.add(tileset);
    tileset.style = new Cesium3DTileStyle({ pointSize: 2.0 });

    // Eye-dome lighting
    tileset.pointCloudShading.eyeDomeLighting = true;
    tileset.pointCloudShading.eyeDomeLightingStrength = 1.0;
    tileset.pointCloudShading.eyeDomeLightingRadius = 1.0;
    await viewer.flyTo(tileset);

    const boundingSphere = tileset.boundingSphere;
    const cartographic = Cartographic.fromCartesian(boundingSphere.center);

    const surface = Cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      cartographic.height,
    );

    const offset = Cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      cartographic.height + heightOffsetMeters,
    );

    const translation = Cartesian3.subtract(offset, surface, new Cartesian3());

    tileset.modelMatrix = Matrix4.fromTranslation(translation);
  } catch (error) {
    loadingIndicator.style.display = "none";
    console.error("MTViewer: error loading tileset:", error);
    // eslint-disable-next-line no-alert
    window.alert(`Error loading tileset from ${url}\n\n${error}`);
    return;
  }

  const cameraPath = [
    {
      position: { lon: 14.19935, lat: 52.28108, height: 149.68 },
      orientation: { heading: 231.83, pitch: -2.69, roll: 0.0 },
      speed: 2,
      dwell: 4,
    },
    {
      position: { lon: 14.19917, lat: 52.28098, height: 150.79 },
      orientation: { heading: 249.7, pitch: -5.0, roll: 0.0 },
      speed: 4,
      dwell: 0,
    },
    {
      position: { lon: 14.19848, lat: 52.28075, height: 153.48 },
      orientation: { heading: 264.65, pitch: -5.0, roll: 0.0 },
      speed: 4,
      dwell: 0,
    },
    {
      position: { lon: 14.19814, lat: 52.28067, height: 155.49 },
      orientation: { heading: 268.63, pitch: -5.0, roll: 0.0 },
      speed: 4,
      dwell: 0,
    },
    {
      position: { lon: 14.19748, lat: 52.2806, height: 156.79 },
      orientation: { heading: 281.39, pitch: -5.0, roll: 0.0 },
      speed: 4,
      dwell: 0,
    },
    {
      position: { lon: 14.19664, lat: 52.28057, height: 159.7 },
      orientation: { heading: 319.73, pitch: -6.6, roll: 0.0 },
      speed: 12,
      dwell: 10,
    },
    {
      position: { lon: 14.19578, lat: 52.28089, height: 361.74 },
      orientation: { heading: 4.49, pitch: -86.33, roll: 0.0 },
      speed: 12,
      dwell: 0,
    },
  ];

  // --- Spline + speed-driven flythrough -----------------------------------

  // Constant acceleration (m/s^2) used to ease into/out of cruise speed.
  const ACCEL = 2.0;
  // Arc-length sampling resolution per spline segment.
  const SAMPLES_PER_SEGMENT = 100;

  // Reused scratch objects to avoid per-frame allocation.
  const scratchPos = new Cartesian3();
  const scratchQuat = new Quaternion();
  const scratchHpr = new HeadingPitchRoll();

  // Monotone cubic (Fritsch-Carlson PCHIP) tangents for a single component,
  // uniform knot spacing h = 1 (index parameterization). The limiter clamps
  // tangents so the curve never overshoots or dips between samples; at a local
  // extremum the tangent is flattened to 0. This is what removes the altitude
  // dip a plain Catmull-Rom produces ahead of the steep final climb.
  function pchipTangents(y) {
    const n = y.length;
    const d = new Array(n - 1);
    for (let k = 0; k < n - 1; k++) {
      d[k] = y[k + 1] - y[k]; // secant slope (h = 1)
    }
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) {
      m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    }
    for (let k = 0; k < n - 1; k++) {
      if (d[k] === 0) {
        m[k] = 0;
        m[k + 1] = 0;
      } else {
        const a = m[k] / d[k];
        const b = m[k + 1] / d[k];
        const sum = a * a + b * b;
        if (sum > 9) {
          const tau = 3 / Math.sqrt(sum);
          m[k] = tau * a * d[k];
          m[k + 1] = tau * b * d[k];
        }
      }
    }
    return m;
  }

  // A monotone cubic Hermite spline for position. Each geographic component
  // (lon/lat/height) is interpolated independently with PCHIP tangents, so the
  // path is smooth (C1) yet provably free of overshoot, loops, and dips.
  // Parameterized so evaluate(i) === waypoint i and u in [i, i+1] traverses
  // segment i. Exposes the same evaluate(u, result) contract as before.
  function buildPositionSpline(path) {
    const n = path.length;
    const lon = path.map((w) => w.position.lon);
    const lat = path.map((w) => w.position.lat);
    const hgt = path.map((w) => w.position.height);
    const mLon = pchipTangents(lon);
    const mLat = pchipTangents(lat);
    const mHgt = pchipTangents(hgt);

    // Cubic Hermite basis on [0,1] with unit interval (tangents are dValue/dIndex).
    function hermite(y, m, i, h00, h10, h01, h11) {
      return h00 * y[i] + h10 * m[i] + h01 * y[i + 1] + h11 * m[i + 1];
    }

    function evaluate(u, result) {
      let i = Math.floor(u);
      i = Math.max(0, Math.min(i, n - 2));
      const s = CesiumMath.clamp(u - i, 0, 1);
      const s2 = s * s;
      const s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;
      return Cartesian3.fromDegrees(
        hermite(lon, mLon, i, h00, h10, h01, h11),
        hermite(lat, mLat, i, h00, h10, h01, h11),
        hermite(hgt, mHgt, i, h00, h10, h01, h11),
        undefined,
        result,
      );
    }

    return { evaluate };
  }

  // Build the position spline (monotone cubic) and a quaternion-slerp spline for
  // orientation, both parameterized by waypoint index (0..N-1).
  function buildSplines(path) {
    const N = path.length;
    const times = [];
    const quats = [];
    for (let i = 0; i < N; i++) {
      times.push(i);
      const o = path[i].orientation;
      // Local-frame HPR quaternion: camera.setView re-bases heading/pitch/roll
      // into the ENU frame at the destination, so slerping local-frame
      // quaternions and converting back is the correct path.
      const hpr = HeadingPitchRoll.fromDegrees(o.heading, o.pitch, o.roll);
      quats.push(Quaternion.fromHeadingPitchRoll(hpr));
    }
    const posSpline = buildPositionSpline(path);
    const oriSpline = new QuaternionSpline({ times, points: quats });
    return { posSpline, oriSpline, N };
  }

  // Densely sample the position spline to map cumulative arc length (meters)
  // to spline parameter, plus per-segment arc lengths.
  function buildArcTable(posSpline, N, samplesPerSegment) {
    const cumDist = [0];
    const paramAt = [0];
    const segArcLen = new Array(N - 1).fill(0);
    let total = 0;
    const prev = new Cartesian3();
    const cur = new Cartesian3();
    posSpline.evaluate(0, prev);
    for (let i = 0; i < N - 1; i++) {
      for (let k = 1; k <= samplesPerSegment; k++) {
        const u = i + k / samplesPerSegment;
        posSpline.evaluate(u, cur);
        const d = Cartesian3.distance(prev, cur);
        total += d;
        segArcLen[i] += d;
        cumDist.push(total);
        paramAt.push(u);
        Cartesian3.clone(cur, prev);
      }
    }
    return { cumDist, paramAt, segArcLen, totalLen: total };
  }

  // Inverse of the arc table: distance (meters) -> spline parameter.
  function arcLengthToParam(s, cumDist, paramAt) {
    const n = cumDist.length;
    if (s <= 0) {
      return paramAt[0];
    }
    if (s >= cumDist[n - 1]) {
      return paramAt[n - 1];
    }
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] <= s) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const d0 = cumDist[lo];
    const d1 = cumDist[hi];
    const t = d1 > d0 ? (s - d0) / (d1 - d0) : 0;
    return CesiumMath.lerp(paramAt[lo], paramAt[hi], t);
  }

  // Build an (elapsed time -> cumulative distance) timeline from per-segment
  // cruise speeds, with trapezoidal easing. Velocity ramps from 0 at the path
  // start/end and into/out of dwells; between two moving segments it dips to the
  // slower of the two cruise speeds rather than stopping.
  function buildMotionProfile(path, segArcLen, accel) {
    const N = path.length;

    // Junction (waypoint) speeds.
    const vj = new Array(N);
    for (let k = 0; k < N; k++) {
      if (k === N - 1) {
        // Final waypoint: keep full speed so the flythrough ends abruptly
        // (the last segment accelerates in and stops hard, no deceleration).
        vj[k] = path[k - 1].speed;
      } else if (k === 0 || path[k].dwell > 0) {
        vj[k] = 0;
      } else {
        vj[k] = Math.min(path[k - 1].speed, path[k].speed);
      }
    }

    const keyTimes = [0];
    const keyDist = [0];
    let t = 0;
    let d = 0;
    const STEPS = 12; // sub-samples per accel/decel ramp (for smooth time->dist)

    const pushRamp = (va, vb, T) => {
      if (T <= 0) {
        return;
      }
      const a = (vb - va) / T;
      for (let j = 1; j <= STEPS; j++) {
        const tau = (T * j) / STEPS;
        keyTimes.push(t + tau);
        keyDist.push(d + va * tau + 0.5 * a * tau * tau);
      }
      t += T;
      d += ((va + vb) / 2) * T;
    };
    const pushCruise = (vc, T) => {
      if (T <= 0) {
        return;
      }
      keyTimes.push(t + T);
      keyDist.push(d + vc * T);
      t += T;
      d += vc * T;
    };
    const pushDwell = (sec) => {
      if (sec <= 0) {
        return;
      }
      keyTimes.push(t + sec);
      keyDist.push(d); // distance held constant -> position + orientation freeze
      t += sec;
    };

    for (let k = 0; k < N; k++) {
      pushDwell(path[k].dwell || 0);

      if (k === N - 1) {
        break;
      }

      const L = segArcLen[k];
      if (L <= 1e-6) {
        continue; // zero-length segment (e.g. duplicate waypoints)
      }

      const v0 = vj[k];
      const v1 = vj[k + 1];
      let vc = path[k].speed;
      if (vc <= 0) {
        // A non-terminal segment must move; fall back rather than divide by zero.
        console.warn(`cameraPath segment ${k} has speed <= 0; using 1 m/s`);
        vc = 1;
      }

      // Final segment: accelerate in and stop hard (no decel phase).
      if (k === N - 2) {
        const tToVc = (vc - v0) / accel;
        const dToVc = ((v0 + vc) / 2) * tToVc;
        if (dToVc <= L) {
          pushRamp(v0, vc, tToVc);
          pushCruise(vc, (L - dToVc) / vc);
        } else {
          // Too short to reach cruise: accelerate across the whole segment.
          const vEnd = Math.sqrt(v0 * v0 + 2 * accel * L);
          pushRamp(v0, vEnd, (vEnd - v0) / accel);
        }
        continue;
      }

      let tAcc = (vc - v0) / accel;
      const dAcc = ((v0 + vc) / 2) * tAcc;
      let tDec = (vc - v1) / accel;
      const dDec = ((vc + v1) / 2) * tDec;

      if (dAcc + dDec <= L) {
        const dCruise = L - dAcc - dDec;
        pushRamp(v0, vc, tAcc);
        pushCruise(vc, dCruise / vc);
        pushRamp(vc, v1, tDec);
      } else {
        // Segment too short to reach cruise: triangular profile.
        let vpeak = Math.sqrt((2 * accel * L + v0 * v0 + v1 * v1) / 2);
        vpeak = Math.min(vpeak, vc);
        tAcc = (vpeak - v0) / accel;
        tDec = (vpeak - v1) / accel;
        pushRamp(v0, vpeak, tAcc);
        pushRamp(vpeak, v1, tDec);
      }
    }

    return { keyTimes, keyDist, totalTime: t };
  }

  // Map elapsed seconds to cumulative distance along the path.
  function timeToDistance(elapsed, profile) {
    const { keyTimes, keyDist } = profile;
    const n = keyTimes.length;
    if (elapsed <= 0) {
      return keyDist[0];
    }
    if (elapsed >= keyTimes[n - 1]) {
      return keyDist[n - 1];
    }
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (keyTimes[mid] <= elapsed) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const t0 = keyTimes[lo];
    const t1 = keyTimes[hi];
    const f = t1 > t0 ? (elapsed - t0) / (t1 - t0) : 0;
    return CesiumMath.lerp(keyDist[lo], keyDist[hi], f);
  }

  // Sample the camera pose (destination + heading/pitch/roll) at a given time.
  function sampleCamera(elapsed, ctx) {
    const dist = timeToDistance(elapsed, ctx.profile);
    const u = arcLengthToParam(dist, ctx.arc.cumDist, ctx.arc.paramAt);
    const destination = ctx.posSpline.evaluate(u, scratchPos);
    const q = ctx.oriSpline.evaluate(u, scratchQuat);
    const hpr = HeadingPitchRoll.fromQuaternion(q, scratchHpr);
    return { destination, hpr };
  }

  const { posSpline, oriSpline, N } = buildSplines(cameraPath);
  const arc = buildArcTable(posSpline, N, SAMPLES_PER_SEGMENT);
  const profile = buildMotionProfile(cameraPath, arc.segArcLen, ACCEL);
  const cameraCtx = { posSpline, oriSpline, arc, profile };

  const startTime = JulianDate.now();
  const stopTime = JulianDate.addSeconds(
    startTime,
    profile.totalTime,
    new JulianDate(),
  );

  viewer.clock.startTime = startTime.clone();
  viewer.clock.stopTime = stopTime.clone();
  viewer.clock.currentTime = startTime.clone();
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;

  scene.preUpdate.addEventListener(() => {
    const elapsed = JulianDate.secondsDifference(
      viewer.clock.currentTime,
      startTime,
    );
    const t = CesiumMath.clamp(elapsed, 0, profile.totalTime);
    const { destination, hpr } = sampleCamera(t, cameraCtx);
    viewer.camera.setView({ destination, orientation: hpr });
  });

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
