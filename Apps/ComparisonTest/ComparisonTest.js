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
    JulianDate,
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
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
            ); /**/

            /*
            tileset = await Cesium3DTileset.fromUrl(
                "http://172.18.21.37:8002/out_tileset/tileset.json",
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
            ); /**/

            tileset = viewer.scene.primitives.add(
                await Cesium3DTileset.fromIonAssetId(4332925),
                {
                    cullRequestsWhileMoving: false,
                    preloadWhenHidden: true,
                    preloadFlightDestinations: true,
                },
            );
            /**/

            // Add tileset to the scene
            viewer.scene.primitives.add(tileset);

            await tileset.readyPromise;

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
            tileset.pointCloudShading.maximumAttenuation = 4.0;
            tileset.pointCloudShading.baseResolution = 0.02;
            tileset.pointCloudShading.geometricErrorScale = 0.5;
            tileset.pointCloudShading.attenuation = true;

            // tileset.debugShowBoundingVolume = true;

            // Fly to point cloud
            // viewer.flyTo(tileset);
        } catch (error) {
            console.log("Error loading tileset:", error);
        }
    };

    await loadTileset();

    // ==================== CAMERA LOGGER ====================

    /*const CAMERA_LOG_INTERVAL_MS = 2000;
    let lastCameraLog = performance.now();

    scene.postRender.addEventListener(() => {
        const now = performance.now();
        if (now - lastCameraLog < CAMERA_LOG_INTERVAL_MS) {
        return;
        }
        lastCameraLog = now;

        const camera = viewer.camera;
        const carto = Cartographic.fromCartesian(camera.position);

        const lon = Math.toDegrees(carto.longitude);
        const lat = Math.toDegrees(carto.latitude);
        const height = carto.height;

        // Normalize angles (avoid 360 / tiny eps values)
        const heading = (Math.toDegrees(camera.heading) + 360) % 360;
        const pitch = Math.toDegrees(camera.pitch);
        const roll = (Math.toDegrees(camera.roll) + 360) % 360;

        console.log(
        "CAM | lon:",
        lon.toFixed(5),
        "| lat:",
        lat.toFixed(5),
        "| h:",
        height.toFixed(2),
        "| hdg:",
        heading.toFixed(2),
        "| pit:",
        pitch.toFixed(2),
        "| rol:",
        roll.toFixed(2),
        );
    }); /**/

    // ==================== CAMERA PATH ====================

    const cameraPath = [
        {
            time: 0,
            position: { lon: 14.19816, lat: 52.28058, height: 124.47 },
            orientation: { heading: 272.49, pitch: -0.35, roll: 0.0 },
        },
        {
            time: 10,
            position: { lon: 14.19816, lat: 52.28058, height: 124.47 },
            orientation: { heading: 272.49, pitch: -0.35, roll: 0.0 },
        },
        {
            time: 15,
            position: { lon: 14.19719, lat: 52.28058, height: 121.7 },
            orientation: { heading: 272.49, pitch: -0.35, roll: 0.0 },
        },
        {
            time: 20,
            position: { lon: 14.19704, lat: 52.28054, height: 121.94 },
            orientation: { heading: 347.99, pitch: 2.13, roll: 0.0 },
        },
        {
            time: 35,
            position: { lon: 14.19603, lat: 52.28054, height: 125.33 },
            orientation: { heading: 358.32, pitch: -11.33, roll: 0.0 },
        },
        {
            time: 36,
            position: { lon: 14.19603, lat: 52.28054, height: 125.33 },
            orientation: { heading: 358.32, pitch: -11.33, roll: 0.0 },
        },
        {
            time: 40,
            position: { lon: 14.19605, lat: 52.28066, height: 126.18 },
            orientation: { heading: 359.14, pitch: 2.29, roll: 0.0 },
        },
        {
            time: 45,
            position: { lon: 14.19605, lat: 52.281, height: 134.66 },
            orientation: { heading: 356.97, pitch: 12.09, roll: 0.0 },
        },
        {
            time: 50,
            position: { lon: 14.19724, lat: 52.28124, height: 133.67 },
            orientation: { heading: 153.36, pitch: -3.18, roll: 0 },
        },
        {
            time: 55,
            position: { lon: 14.19704, lat: 52.28157, height: 154.87 },
            orientation: { heading: 179.61, pitch: -16.77, roll: 0.0 },
        },
        {
            time: 60,
            position: { lon: 14.20069, lat: 52.28102, height: 178.99 },
            orientation: { heading: 269.51, pitch: -15.07, roll: 0 },
        },
        {
            time: 65,
            position: { lon: 14.19767, lat: 52.2807, height: 131.89 },
            orientation: { heading: 269.45, pitch: 4.74, roll: 0.0 },
        },
        {
            time: 75,
            position: { lon: 14.19767, lat: 52.2807, height: 131.89 },
            orientation: { heading: 269.45, pitch: 4.74, roll: 0.0 },
        },
        {
            time: 80,
            position: { lon: 14.20541, lat: 52.28069, height: 284.25 },
            orientation: { heading: 274.44, pitch: -14.5, roll: 0 },
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
                            lerp(
                                a.orientation.heading,
                                b.orientation.heading,
                                t,
                            ),
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

    // ==================== PERFORMANCE MEASUREMENT ====================

    /*let requestsCompleted = 0;
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
    });*/

    loadingIndicator.style.display = "none";
}

main();
