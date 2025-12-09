window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Color,
  formatError,
  queryToObject,
  Viewer,
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
  const endUserOptions = queryToObject(window.location.search.substring(1));

  const loadingIndicator = document.getElementById("loadingIndicator");

  let viewer;
  try {
    viewer = new Viewer("cesiumContainer", {
      imageryProvider: false,
      baseLayerPicker: false,
      timeline: false,
      animation: false,
      globe: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false,
      skyAtmosphere: false,
      useDefaultRenderLoop: true,
      scene3DOnly: true,
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
  const context = scene.context;
  if (endUserOptions.debug) {
    context.validateShaderProgram = true;
    context.validateFramebuffer = true;
    context.logShaderCompilation = true;
    context.throwOnWebGLError = true;
  }

  scene.skyBox = undefined;
  scene.skyAtmosphere = undefined;
  scene.fog.enabled = false;

  scene.backgroundColor = Color.BLACK;
  scene.globe.depthTestAgainstTerrain = false;

  const loadTileset = async () => {
    try {
      const tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.46:8000/get/centered/tileset.json",
      );

      viewer.scene.primitives.add(tileset);

      tileset.cullRequestsWhileMoving = false;
      tileset.cullRequestsWhileMovingMult = 0;
      tileset.cullRequestsWhileMovingThreshold = 0;

      tileset.cullWithChildrenBounds = false;

      tileset.skipLevelOfDetail = false;
      tileset.immediatelyLoadDesiredLevelOfDetail = true;

      tileset.enableVisibilityTest = false;

      tileset.maximumScreenSpaceError = 1;
      tileset.maximumMemoryUsage = 10240;

      viewer.zoomTo(tileset);
    } catch (error) {
      console.log(`Error loading tileset: ${error}`);
    }
  };

  loadTileset();

  loadingIndicator.style.display = "none";
}

main();
