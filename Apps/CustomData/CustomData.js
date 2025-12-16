window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Color,
  formatError,
  Viewer,
  Terrain,
  RequestScheduler,
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

  const scene = viewer.scene;

  // OPTIONAL — black background but keep the globe
  scene.skyBox = undefined;
  scene.skyAtmosphere = undefined;

  scene.backgroundColor = Color.BLUE;

  const loadTileset = async () => {
    try {
      const tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.46:8000/get/20240820_Sauen_3512a1_UAV_PLS_fused_0_1_TRANSFORMED_2024-12-12_13h21_05_585_georef/tileset.json",
        {
          skipLevelOfDetail: false,

          immediatelyLoadDesiredLevelOfDetail: true,

          loadSiblings: true,
          preferLeaves: true,

          dynamicScreenSpaceError: false,
          progressiveResolutionHeightFraction: 0.0,

          foveatedScreenSpaceError: 0.0,
          foveatedConeSize: 0.0,
          foveatedMinimumScreenSpaceErrorRelaxation: 0.0,

          cullRequestsWhileMoving: false,

          baseScreenSpaceError: 1024,
          maximumScreenSpaceError: 1.0,

          preloadWhenHidden: true,
          preloadFlightDestinations: true,
        },
      );

      viewer.scene.primitives.add(tileset);

      // Now fly to point cloud
      viewer.flyTo(tileset);
    } catch (error) {
      console.log("Error loading tileset:", error);
    }
  };

  await loadTileset();

  loadingIndicator.style.display = "none";
}

main();
