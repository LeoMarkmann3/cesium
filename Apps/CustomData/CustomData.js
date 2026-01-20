window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
    Ion,
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

    Ion.defaultAccessToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5ZDgxMjNjMi03MTRlLTRjNzctODgyMi05ZWRiYTllZGQzN2YiLCJpZCI6MzU3ODE2LCJpYXQiOjE3NjI0Mjk2NDJ9.vD7C8Iy8dFXX21tneNfCYl51FtbUGIrBfJHwiQsRNp0";

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
    let tileset;

  // // OPTIONAL — black background but keep the globe
  // scene.skyBox = undefined;
  // scene.skyAtmosphere = undefined;

  // scene.backgroundColor = Color.RED;

  const loadTileset = async () => {
    try {
      // Offset height in meters - due to inaccuracies in the terrain provided by fromWorldTerrain
      const heightOffsetMeters = 15.0;

            // Load Tileset from URL with various options for performance and LOD management

            /*
            tileset = await Cesium3DTileset.fromUrl(
                "http://172.18.21.46:8000/get/20240820_Sauen_3512a1_UAV_PLS_fused_3_1_TRANSFORMED_2024-12-12_13h48_53_169_georef/tileset.json",
            ); /**/

            tileset = await Cesium3DTileset.fromUrl(
                "http://172.19.0.1:8001/output_georef/tileset.json",
            ); /**/

            /*
            tileset = viewer.scene.primitives.add(
                await Cesium3DTileset.fromIonAssetId(4331253),
            );
            /**/

            /*
            tileset = await Cesium3DTileset.fromUrl(
                "https://3d.oslandia.com/lidar_hd/tileset.json",
            ); /**/

            /*
            {
                    skipLevelOfDetail: false,

          preferLeaves: true,

          dynamicScreenSpaceError: false,

          progressiveResolutionHeightFraction: 0.0,

          foveatedScreenSpaceError: false,

          cullRequestsWhileMoving: false,

                    maximumScreenSpaceError: 1,

                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },),
            */

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

            //testing
            tileset.pointCloudShading.maximumAttenuation = 4.0;
            tileset.pointCloudShading.baseResolution = 0.02;
            tileset.pointCloudShading.geometricErrorScale = 0.5;
            tileset.pointCloudShading.attenuation = true;

            // tileset.debugShowBoundingVolume = true;

      // Fly to point cloud
      viewer.flyTo(tileset);
    } catch (error) {
      console.log("Error loading tileset:", error);
    }
  };

    await loadTileset();

    // ==================== PERFORMANCE MEASUREMENT ====================

    let requestsCompleted = 0;
    let totalRequests = 0;

    RequestScheduler.requestCompletedEvent.addEventListener(() => {
        requestsCompleted++;
        totalRequests++;
    });

    let lastSecond = performance.now();
    let frames = 0;
    let pointsPerSecond = 0;
    let maxPointsPerFrame = 0;

    scene.postRender.addEventListener(() => {
        if (!tileset || !tileset._selectedTiles) {
            return;
        }

        frames++;

        let pointsThisFrame = 0;

        tileset._selectedTiles.forEach((tile) => {
            const content = tile.content;
            if (content && content.pointsLength) {
                pointsThisFrame += content.pointsLength;
            }
        });

        pointsPerSecond += pointsThisFrame;
        maxPointsPerFrame = Math.max(maxPointsPerFrame, pointsThisFrame);

        const now = performance.now();
        if (now - lastSecond >= 1000) {
            console.log(
                "FPS:",
                frames,
                "| points/s:",
                pointsPerSecond.toLocaleString(),
                "| req/s:",
                requestsCompleted,
                "| total req:",
                totalRequests,
                "| max points/frame:",
                maxPointsPerFrame.toLocaleString(),
            );

            frames = 0;
            pointsPerSecond = 0;
            requestsCompleted = 0;
            maxPointsPerFrame = 0;
            lastSecond = now;
        }
    });

  loadingIndicator.style.display = "none";
}

main();
