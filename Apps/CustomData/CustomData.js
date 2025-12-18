window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  formatError,
  Viewer,
  Terrain,
  RequestScheduler,
  Matrix4,
  Cartesian3,
  Cartographic,
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

  RequestScheduler.maximumRequests = 2000000;
  RequestScheduler.maximumRequestsPerServer = 100000;

  let viewer;
  try {
    viewer = new Viewer("cesiumContainer", {
      terrain: Terrain.fromWorldTerrain(),
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
    if (!document.querySelector(".cesium-widget-errorPanel")) {
      //eslint-disable-next-line no-alert
      window.alert(message);
    }
    return;
  }

  //const scene = viewer.scene;

  // // OPTIONAL — black background but keep the globe
  // scene.skyBox = undefined;
  // scene.skyAtmosphere = undefined;

  // scene.backgroundColor = Color.RED;

  const loadTileset = async () => {
    try {
      // Offset height in meters - due to inaccuracies in the terrain provided by fromWorldTerrain
      const heightOffsetMeters = 15.0;

      // Load Tileset from URL with various options for performance and LOD management
      const tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.46:8000/get/20240820_Sauen_3512a1_UAV_PLS_fused_0_1_TRANSFORMED_2024-12-12_13h21_05_585_georef/tileset.json",
        {
          skipLevelOfDetail: false,

          preferLeaves: true,

          dynamicScreenSpaceError: false,
          progressiveResolutionHeightFraction: 0.0,

          foveatedScreenSpaceError: false,

          cullRequestsWhileMoving: false,

          maximumScreenSpaceError: 0.0001,

          preloadWhenHidden: true,
          preloadFlightDestinations: true,
        },
      );

      // Add tileset to the scene
      viewer.scene.primitives.add(tileset);

      await tileset.readyPromise;

      // Compute offset to raise tileset above terrain

      const boundingSphere = tileset.boundingSphere;
      const cartographic = Cartographic.fromCartesian(boundingSphere.center);

      // Create surface and offset positions
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

      // Compute translation vector
      const translation = Cartesian3.subtract(
        offset,
        surface,
        new Cartesian3(),
      );

      // Apply model matrix
      tileset.modelMatrix = Matrix4.fromTranslation(translation);

      // Fly to point cloud
      viewer.flyTo(tileset);
    } catch (error) {
      console.log("Error loading tileset:", error);
    }
  };

  await loadTileset();

  loadingIndicator.style.display = "none";
}

main();
