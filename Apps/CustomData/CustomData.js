window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Color,
  formatError,
  queryToObject,
  Viewer,
  Cartesian3,
  Math as CesiumMath,
} from "../../Build/CesiumUnminified/index.js";

async function main() {
  const endUserOptions = queryToObject(window.location.search.substring(1));
  const loadingIndicator = document.getElementById("loadingIndicator");

  let viewer;
  try {
    viewer = new Viewer("cesiumContainer", {
      imageryProvider: false,
      baseLayerPicker: false,
      timeline: false,
      animation: false,
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
      globe: false,
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

  scene.backgroundColor = Color.BLACK;
  scene.fog.enabled = false;

  const camera = viewer.camera;
  camera.constrainedAxis = undefined;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  viewer.scene.screenSpaceCameraController.enableTranslate = true;
  viewer.scene.screenSpaceCameraController.enableZoom = true;
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.enableLook = true;

  const loadTileset = async () => {
    try {
      const tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.46:8000/get/centered/tileset.json",
      );

      tileset.cullRequestsWhileMoving = false;
      tileset.cullWithChildrenBounds = false;
      tileset.skipLevelOfDetail = false;
      tileset.immediatelyLoadDesiredLevelOfDetail = true;
      tileset.enableVisibilityTest = false;
      tileset.maximumScreenSpaceError = 1;
      tileset.maximumMemoryUsage = 10240;

      viewer.scene.primitives.add(tileset);

      const center = tileset.boundingSphere.center;
      camera.setView({
        destination: new Cartesian3(center.x, center.y, center.z + 50),
        orientation: {
          heading: 0,
          pitch: CesiumMath.toRadians(-90),
          roll: 0,
        },
      });
    } catch (error) {
      console.log(`Error loading tileset: ${error}`);
    }
  };

  loadTileset();
  loadingIndicator.style.display = "none";
}

main();
