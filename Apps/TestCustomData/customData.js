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
  Math,
  Cesium3DTileStyle,
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

      // Point size (distance attenuation)
      // tileset.pointCloudShading.attenuation = true;
      // tileset.pointCloudShading.maximumAttenuation = 1.5;
      // tileset.pointCloudShading.baseResolution = 1.0;
      // tileset.pointCloudShading.geometricErrorScale = 1.0;

      tileset.style = new Cesium3DTileStyle({ pointSize: 2.0 });

      // Eye-dome lighting
      tileset.pointCloudShading.eyeDomeLighting = true;
      tileset.pointCloudShading.eyeDomeLightingStrength = 1.0;
      tileset.pointCloudShading.eyeDomeLightingRadius = 1.0;

      // viewer.flyTo(tileset);
    } catch (error) {
      console.log("Error loading tileset:", error);
    }
  };

  await loadTileset();

  // const cameraPath = [
  //       {
  //           time: 0,
  //           position: { lon: 14.19935, lat: 52.28108, height: 149.68 },
  //           orientation: { heading: 231.83, pitch: -2.69, roll: 0.0 },
  //       },
  //       {
  //           time: 2,
  //           position: { lon: 14.19935, lat: 52.28108, height: 149.68 },
  //           orientation: { heading: 231.83, pitch: -2.69, roll: 0.0 },
  //       },
  //       {
  //           time: 10,
  //           position: { lon: 14.19917, lat: 52.28098, height: 150.79 },
  //           orientation: { heading: 249.70, pitch: -5.00, roll: 0.0 },
  //       },
  //       {
  //           time: 25,
  //           position: { lon: 14.19848, lat: 52.28075, height: 153.48 },
  //           orientation: { heading: 264.65, pitch: -5.00, roll: 0.0 },
  //       },
  //       {
  //           time: 35,
  //           position: { lon: 14.19814, lat: 52.28067, height: 155.49 },
  //           orientation: { heading: 268.63, pitch: -5.00, roll: 0.0 },
  //       },
  //       {
  //           time: 45,
  //           position: { lon: 14.19748, lat: 52.28060, height: 156.79 },
  //           orientation: { heading: 281.39, pitch: -5.00, roll: 0.0 },
  //       },
  //       {
  //           time: 65,
  //           position: { lon: 14.19664, lat: 52.28057, height: 159.70 },
  //           orientation: { heading: 319.73, pitch: -6.60, roll: 0.0 },
  //       },
  //       {
  //           time: 70,
  //           position: { lon: 14.19664, lat: 52.28057, height: 159.70 },
  //           orientation: { heading: 319.73, pitch: -6.60, roll: 0.0 },
  //       },
  //       {
  //           time: 80,
  //           position: { lon: 14.19578, lat: 52.28089, height: 361.74 },
  //           orientation: { heading: 364.49, pitch: -86.33, roll: 0.0 },
  //       },
  //   ];

  const cameraPath = [
    {
      time: 0,
      position: { lon: 14.19935, lat: 52.28108, height: 149.68 },
      orientation: { heading: 231.83, pitch: -2.69, roll: 0.0 },
    },
    {
      time: 4,
      position: { lon: 14.19935, lat: 52.28108, height: 149.68 },
      orientation: { heading: 231.83, pitch: -2.69, roll: 0.0 },
    },
    {
      time: 20,
      position: { lon: 14.19917, lat: 52.28098, height: 150.79 },
      orientation: { heading: 249.7, pitch: -5.0, roll: 0.0 },
    },
    {
      time: 50,
      position: { lon: 14.19848, lat: 52.28075, height: 153.48 },
      orientation: { heading: 264.65, pitch: -5.0, roll: 0.0 },
    },
    {
      time: 70,
      position: { lon: 14.19814, lat: 52.28067, height: 155.49 },
      orientation: { heading: 268.63, pitch: -5.0, roll: 0.0 },
    },
    {
      time: 90,
      position: { lon: 14.19748, lat: 52.2806, height: 156.79 },
      orientation: { heading: 281.39, pitch: -5.0, roll: 0.0 },
    },
    {
      time: 130,
      position: { lon: 14.19664, lat: 52.28057, height: 159.7 },
      orientation: { heading: 319.73, pitch: -6.6, roll: 0.0 },
    },
    {
      time: 140,
      position: { lon: 14.19664, lat: 52.28057, height: 159.7 },
      orientation: { heading: 319.73, pitch: -6.6, roll: 0.0 },
    },
    {
      time: 160,
      position: { lon: 14.19578, lat: 52.28089, height: 361.74 },
      orientation: { heading: 364.49, pitch: -86.33, roll: 0.0 },
    },
  ];

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
        const t = (elapsed - a.time) / (b.time - a.time);

        return {
          position: {
            lon: lerp(a.position.lon, b.position.lon, t),
            lat: lerp(a.position.lat, b.position.lat, t),
            height: lerp(a.position.height, b.position.height, t),
          },
          orientation: {
            heading: Math.toRadians(
              lerp(a.orientation.heading, b.orientation.heading, t),
            ),
            pitch: Math.toRadians(
              lerp(a.orientation.pitch, b.orientation.pitch, t),
            ),
            roll: Math.toRadians(
              lerp(a.orientation.roll, b.orientation.roll, t),
            ),
          },
        };
      }
    }
    return null;
  }

  // Camera Path
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

    viewer.camera.setView({
      destination,
      orientation: frame.orientation,
    });
  }); /**/

  loadingIndicator.style.display = "none";
}

main();
