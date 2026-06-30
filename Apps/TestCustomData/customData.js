window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  formatError,
  Viewer,
  RequestScheduler,
  Matrix4,
  Cartesian3,
  Cartographic,
  SceneMode,
  JulianDate,
  Math as CesiumMath,
  Cesium3DTileStyle,
  // Color,
  CustomShader,
} from "../../Build/CesiumUnminified/index.js";

async function main() {
  /*
     Options parsed from query string:
       source=url          The URL of a CZML/GeoJSON/KML data source to load at startup.
                           Automatic data type detection uses file extension.
       sourceType=czml/geojson/kml
                           Override data type detection for source.
       flyTo=false         Don't automatically fly to the loaded source.
       tmsImageryUrl=url   Automatically use a TMS imagery provider.
       lookAt=id           The ID of the entity to track at startup.
       stats=true          Enable the FPS performance display.
       inspector=true      Enable the inspector widget.
       debug=true          Full WebGL error reporting at substantial performance cost.
       theme=lighter       Use the dark-text-on-light-background theme.
       scene3DOnly=true    Enable 3D only mode.
       view=longitude,latitude,[height,heading,pitch,roll]
                           Automatically set a camera view. Values in degrees and meters.
                           [height,heading,pitch,roll] default is looking straight down, [300,0,-90,0]
       saveCamera=false    Don't automatically update the camera view in the URL when it changes.
     */
  // const endUserOptions = queryToObject(window.location.search.substring(1));

  const loadingIndicator = document.getElementById("loadingIndicator");

  // Set higher request limits for faster loading
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
    if (!document.querySelector(".cesium-widget-errorPanel")) {
      //eslint-disable-next-line no-alert
      window.alert(message);
    }
    return;
  }

  const scene = viewer.scene;
  let tileset;

  const loadTileset = async () => {
    try {
      // Offset height in meters - due to inaccuracies in the terrain provided by fromWorldTerrain
      const heightOffsetMeters = 50.0;

      tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.37:8002/out_tileset/tileset.json",
        {
          cullRequestsWhileMoving: false,
          preloadWhenHidden: true,
          preloadFlightDestinations: true,
          foveatedScreenSpaceError: true,
          foveatedConeSize: 0.3,
          dynamicScreenSpaceError: true,
          skipLevelOfDetail: false,
          preferLeaves: true,
          maximumScreenSpaceError: 8.0,

          cacheBytes: 2000000000,
          maximumCacheOverflowBytes: 1000000000,
        },
      ); /**/

      viewer.scene.primitives.add(tileset);

      await tileset.readyPromise;

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

      const translation = Cartesian3.subtract(
        offset,
        surface,
        new Cartesian3(),
      );

      tileset.modelMatrix = Matrix4.fromTranslation(translation);

      tileset.style = new Cesium3DTileStyle({
        pointSize: 2.0,
        color:
          "rgb((${instance_id} * 137) % 256, (${instance_id} * 149) % 256, (${instance_id} * 83) % 256)",
      });

      // Fixed point size: style.pointSize is ignored for batch-table point clouds,
      // so set gl_PointSize directly via a CustomShader. Change the value to resize.
      tileset.customShader = new CustomShader({
        vertexShaderText: [
          "void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {",
          "  vsOutput.pointSize = 2.0;",
          "}",
        ].join("\n"),
      });

      // tileset.pointCloudShading.attenuation = true;
      // tileset.pointCloudShading.eyeDomeLighting = true;
      // tileset.pointCloudShading.eyeDomeLightingStrength = 1.5;
      // tileset.pointCloudShading.eyeDomeLightingRadius = 2.0;
    } catch (error) {
      console.log("Error loading tileset:", error);
    }
  };

  await loadTileset();

  // Scene 3
  const cameraPath = [
    {
      time: 0,
      position: { lon: 14.19875, lat: 52.2808, height: 152.71 },
      orientation: { heading: 294.75, pitch: 15.14, roll: 0.0 },
    },
    {
      time: 5,
      position: { lon: 14.19875, lat: 52.2808, height: 152.71 },
      orientation: { heading: 294.75, pitch: 15.14, roll: 0.0 },
    },
    {
      time: 120,
      position: { lon: 14.19736, lat: 52.28056, height: 158.23 },
      orientation: { heading: 317.93, pitch: -4.53, roll: 0.0 },
    },
    {
      time: 160,
      position: { lon: 14.19578, lat: 52.28089, height: 361.74 },
      orientation: { heading: 364.49, pitch: -86.33, roll: 0.0 },
    },
  ];

  // Scene 1
  // const cameraPath = [
  //   {
  //     time: 0,
  //     position: { lon: 14.19955, lat: 52.28126, height: 152.34 },
  //     orientation: { heading: 219.36, pitch: -1.88, roll: 0.0 },
  //   },
  //   {
  //     time: 5,
  //     position: { lon: 14.19955, lat: 52.28126, height: 152.34 },
  //     orientation: { heading: 219.36, pitch: -1.88, roll: 0.0 },
  //   },
  //   {
  //     time: 20,
  //     position: { lon: 14.19928, lat: 52.28103, height: 152.42 },
  //     orientation: { heading: 246.24, pitch: -1.55, roll: 0.0 },
  //   },
  //   {
  //     time: 35,
  //     position: { lon: 14.19894, lat: 52.2809, height: 153.78 },
  //     orientation: { heading: 242.64, pitch: -7.46, roll: 0.0 },
  //   },
  //   {
  //     time: 50,
  //     position: { lon: 14.19875, lat: 52.2808, height: 212.71 },
  //     orientation: { heading: 304.75, pitch: -35.14, roll: 0.0 },
  //   }
  // ];

  // Scene 2
  // const cameraPath = [
  //   {
  //     time: 0,
  //     position: { lon: 14.19875, lat: 52.2808, height: 212.71 },
  //     orientation: { heading: 304.75, pitch: -35.14, roll: 0.0 },
  //   },
  //   {
  //     time: 5,
  //     position: { lon: 14.19875, lat: 52.2808, height: 212.71 },
  //     orientation: { heading: 304.75, pitch: -35.14, roll: 0.0 },
  //   },
  //   {
  //     time: 13,
  //     position: { lon: 14.19875, lat: 52.2808, height: 212.71 },
  //     orientation: { heading: 304.75, pitch: -35.14, roll: 0.0 },
  //   },
  //   {
  //     time: 23,
  //     position: { lon: 14.19875, lat: 52.2808, height: 152.71 },
  //     orientation: { heading: 294.75, pitch: 15.14, roll: 0.0 },
  //   },
  // ];

  // Scene 3
  // const cameraPath = [
  //   {
  //     time: 0,
  //     position: { lon: 14.19875, lat: 52.2808, height: 152.71 },
  //     orientation: { heading: 294.75, pitch: 15.14, roll: 0.0 },
  //   },
  //   {
  //     time: 5,
  //     position: { lon: 14.19875, lat: 52.2808, height: 152.71 },
  //     orientation: { heading: 294.75, pitch: 15.14, roll: 0.0 },
  //   },
  //   {
  //     time: 30,
  //     position: { lon: 14.19736, lat: 52.28056, height: 158.23 },
  //     orientation: { heading: 317.93, pitch: -4.53, roll: 0.0 },
  //   },
  //   {
  //     time: 40,
  //     position: { lon: 14.19578, lat: 52.28089, height: 361.74 },
  //     orientation: { heading: 364.49, pitch: -86.33, roll: 0.0 },
  //   },
  // ];

  const startTime = JulianDate.now();
  const stopTime = JulianDate.addSeconds(
    startTime,
    cameraPath[cameraPath.length - 1].time,
    new JulianDate(),
  );

  viewer.clock.startTime = startTime.clone();
  viewer.clock.stopTime = stopTime.clone();
  viewer.clock.currentTime = startTime.clone();
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = true;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function interpolateCamera(path, elapsed) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (elapsed >= a.time && elapsed <= b.time) {
        const t = b.time > a.time ? (elapsed - a.time) / (b.time - a.time) : 0;
        return {
          position: {
            lon: lerp(a.position.lon, b.position.lon, t),
            lat: lerp(a.position.lat, b.position.lat, t),
            height: lerp(a.position.height, b.position.height, t),
          },
          orientation: {
            heading: CesiumMath.toRadians(
              lerp(a.orientation.heading, b.orientation.heading, t),
            ),
            pitch: CesiumMath.toRadians(
              lerp(a.orientation.pitch, b.orientation.pitch, t),
            ),
            roll: CesiumMath.toRadians(
              lerp(a.orientation.roll, b.orientation.roll, t),
            ),
          },
        };
      }
    }
    return null;
  }

  scene.preUpdate.addEventListener(() => {
    const elapsed = JulianDate.secondsDifference(
      viewer.clock.currentTime,
      startTime,
    );
    const frame = interpolateCamera(cameraPath, elapsed);
    if (!frame) {
      return;
    }
    const destination = Cartesian3.fromDegrees(
      frame.position.lon,
      frame.position.lat,
      frame.position.height,
    );
    viewer.camera.setView({ destination, orientation: frame.orientation });
  });

  loadingIndicator.style.display = "none";
}

main();
