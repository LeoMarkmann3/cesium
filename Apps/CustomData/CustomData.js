window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cesium3DTileset,
  Color,
  Matrix4,
  formatError,
  Viewer,
  Terrain,
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
  scene.backgroundColor = Color.BLACK;

  const loadTileset = async () => {
    try {
      const tileset = await Cesium3DTileset.fromUrl(
        "http://172.18.21.46:8000/get/20240820_Sauen/tileset.json",
      );

      viewer.scene.primitives.add(tileset);

      // Wait until bounding volumes are ready
      await tileset.ready;

      // If your point cloud is already in EPSG:4978 (ECEF), leave this as identity
      // If NOT — I need the EPSG to generate the correct matrix
      if (tileset.root.transform) {
        console.log("Tileset already contains a transform.");
      } else {
        tileset.root.transform = Matrix4.IDENTITY;
      }

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
