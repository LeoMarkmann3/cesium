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
    Math,
    // StaticTilesetAnalyzer,
    JulianDate,
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
                "http://172.18.21.46:8000/get/20240820_Sauen_3512a1_UAV_PLS_fused_2_0_TRANSFORMED_2024-12-12_13h37_33_000_georef/tileset.json",
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
            ); /**/

            tileset = await Cesium3DTileset.fromUrl(
                "http://172.18.21.37:8002/out_tileset/tileset.json",
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
            ); /**/

            /*
            tileset = viewer.scene.primitives.add(
                await Cesium3DTileset.fromIonAssetId(4332925),
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
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

            tileset.style = new Cesium3DTileStyle({
                pointSize: "3.0",
            });

            // Compute offset to raise tileset above terrain

            const boundingSphere = tileset.boundingSphere;
            const cartographic = Cartographic.fromCartesian(
                boundingSphere.center,
            );

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
            // tileset.pointCloudShading.maximumAttenuation = 4.0;
            // tileset.pointCloudShading.baseResolution = 0.02;
            // tileset.pointCloudShading.geometricErrorScale = 0.5;
            tileset.pointCloudShading.attenuation = true;

            tileset.pointCloudShading.eyeDomeLighting = true;

            // tileset.debugShowBoundingVolume = true;

            // Fly to point cloud
            // viewer.flyTo(tileset);

            const cameraView = {
                position: { lon: 14.1987, lat: 52.2805, height: 204.52 },
                orientation: { heading: 358.96, pitch: -36.61, roll: 0.0 },
            };

            const destination = Cartesian3.fromDegrees(
                cameraView.position.lon,
                cameraView.position.lat,
                cameraView.position.height,
            );

            viewer.camera.setView({
                destination,
                orientation: {
                    heading: Math.toRadians(358.96),
                    pitch: Math.toRadians(-36.61),
                    roll: Math.toRadians(0.0),
                },
            });
        } catch (error) {
            console.log("Error loading tileset:", error);
        }
    };

    await loadTileset();

    const viewpoints = [
        {
            time: 10,
            position: { lon: 14.19816, lat: 52.28058, height: 124.47 },
            orientation: { heading: 272.49, pitch: -0.35, roll: 0.0 },
        },
        {
            time: 20,
            position: { lon: 14.19704, lat: 52.28054, height: 121.94 },
            orientation: { heading: 347.99, pitch: 2.13, roll: 0.0 },
        },
        {
            time: 30,
            position: { lon: 14.19603, lat: 52.28054, height: 125.33 },
            orientation: { heading: 358.32, pitch: -11.33, roll: 0.0 },
        },
        {
            time: 40,
            position: { lon: 14.19704, lat: 52.28157, height: 154.87 },
            orientation: { heading: 179.61, pitch: -16.77, roll: 0.0 },
        },
        {
            time: 50,
            position: { lon: 14.20069, lat: 52.28102, height: 178.99 },
            orientation: { heading: 269.51, pitch: -15.07, roll: 0 },
        },
    ];

    // const analyzer = new StaticTilesetAnalyzer();
    // await analyzer.startAnalyze(tileset._resource);

    function waitUntil(conditionFn, interval = 100) {
        return new Promise((resolve) => {
            const handle = setInterval(() => {
                if (conditionFn()) {
                    clearInterval(handle);
                    resolve();
                }
            }, interval);
        });
    }

    const screenshotConfigs = [
        { time: 15, area: "full" },
        { time: 25, area: "full" },
        { time: 35, area: "full" },
        { time: 45, area: "full" },
        { time: 55, area: { x: 400, y: 100, width: 1000, height: 700 } },
    ];
    const takenScreenshots = new Set();

    function cropCanvas(sourceCanvas, crop) {
        const { x, y, width, height } = crop;

        const cropped = document.createElement("canvas");
        cropped.width = width;
        cropped.height = height;

        const ctx = cropped.getContext("2d");
        ctx.drawImage(
            sourceCanvas,
            x,
            y,
            width,
            height, // Quelle
            0,
            0,
            width,
            height, // Ziel
        );

        return cropped;
    }

    async function takeScreenshot(time, area) {
        console.log("Taking screenshot at t =", time);

        // Warten bis Szene stabil ist
        await waitUntil(
            () =>
                viewer.scene.globe.tilesLoaded &&
                tileset._statistics.numberOfPendingRequests === 0,
        );

        // Render erzwingen
        viewer.render();

        let dataUrl;
        if (area === "full") {
            dataUrl = viewer.canvas.toDataURL("image/png");
        } else {
            const croppedCanvas = cropCanvas(viewer.canvas, area);
            dataUrl = croppedCanvas.toDataURL("image/png");
        }

        // Download im Browser
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `image-t${time}.png`;
        a.click();
    }

    const startTime = JulianDate.now();
    viewer.clock.startTime = startTime.clone();
    viewer.clock.currentTime = startTime.clone();
    viewer.clock.multiplier = 1;
    viewer.clock.shouldAnimate = true;

    const visited = new Set();

    scene.preUpdate.addEventListener(() => {
        const elapsed = JulianDate.secondsDifference(
            viewer.clock.currentTime,
            startTime,
        );

        for (const vp of viewpoints) {
            if (elapsed >= vp.time && !visited.has(vp.time)) {
                visited.add(vp.time);

                const destination = Cartesian3.fromDegrees(
                    vp.position.lon,
                    vp.position.lat,
                    vp.position.height,
                );

                viewer.camera.setView({
                    destination,
                    orientation: {
                        heading: Math.toRadians(vp.orientation.heading),
                        pitch: Math.toRadians(vp.orientation.pitch),
                        roll: Math.toRadians(vp.orientation.roll),
                    },
                });
            }
        }

        // Screenshot auslösen
        for (const cfg of screenshotConfigs) {
            if (elapsed >= cfg.time && !takenScreenshots.has(cfg.time)) {
                takenScreenshots.add(cfg.time);
                takeScreenshot(cfg.time, cfg.area);
            }
        }
    });

    loadingIndicator.style.display = "none";
}

main();
