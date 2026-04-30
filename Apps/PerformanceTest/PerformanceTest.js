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
    PerformanceMeasurer,
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

            tileset = await Cesium3DTileset.fromUrl(
                "http://172.18.21.46:8000/get/Mar19_train_georef/tileset.json",
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
            viewer.flyTo(tileset);
        } catch (error) {
            console.log("Error loading tileset:", error);
        }
    };

    await loadTileset();

    // ==================== CAMERA LOGGER ====================

    const CAMERA_LOG_INTERVAL_MS = 2000;
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

    /*
    const cameraPath = [
        {
            time: 0,
            position: { lon: 14.19176, lat: 52.28191, height: 144.15 },
            orientation: { heading: 86.25, pitch: -14.96, roll: 0.0 },
        },
        {
            time: 10,
            position: { lon: 14.19176, lat: 52.28191, height: 144.15 },
            orientation: { heading: 86.25, pitch: -14.96, roll: 0.0 },
        },
        {
            time: 15,
            position: { lon: 14.19198, lat: 52.28197, height: 143.5 },
            orientation: { heading: 88.31, pitch: -13.26, roll: 0.0 },
        },
        {
            time: 20,
            position: { lon: 14.1921, lat: 52.28201, height: 143.48 },
            orientation: { heading: 142.09, pitch: -13.26, roll: 0.0 },
        },
        {
            time: 25,
            position: { lon: 14.19229, lat: 52.28183, height: 143.42 },
            orientation: { heading: 142.09, pitch: -13.26, roll: 0.0 },
        },
        {
            time: 30,
            position: { lon: 14.19255, lat: 52.28153, height: 142.41 },
            orientation: { heading: 121.97, pitch: -15.53, roll: 0.0 },
        },
        {
            time: 35,
            position: { lon: 14.19289, lat: 52.28148, height: 143.15 },
            orientation: { heading: 110.07, pitch: -13.26, roll: 0 },
        },
        {
            time: 40,
            position: { lon: 14.19358, lat: 52.28124, height: 140.15 },
            orientation: { heading: 85.88, pitch: -7.09, roll: 0.0 },
        },
        {
            time: 45,
            position: { lon: 14.19527, lat: 52.28125, height: 145.21 },
            orientation: { heading: 85.88, pitch: -7.09, roll: 0.0 },
        },
        {
            time: 60,
            position: { lon: 14.19527, lat: 52.28125, height: 145.21 },
            orientation: { heading: 85.88, pitch: -7.09, roll: 0.0 },
        },
        {
            time: 70,
            position: { lon: 14.19572, lat: 52.281, height: 140.2 },
            orientation: { heading: 175.35, pitch: -3.69, roll: 0.0 },
        },
        {
            time: 85,
            position: { lon: 14.19602, lat: 52.28053, height: 126.82 },
            orientation: { heading: 78.25, pitch: -5.63, roll: 0.0 },
        },
        {
            time: 100,
            position: { lon: 14.19756, lat: 52.28052, height: 123.34 },
            orientation: { heading: 10.92, pitch: -4.49, roll: 0.0 },
        },
        {
            time: 115,
            position: { lon: 14.1986, lat: 52.28078, height: 118.31 },
            orientation: { heading: 63.51, pitch: 1.17, roll: 0.0 },
        },
        {
            time: 120,
            position: { lon: 14.19926, lat: 52.28104, height: 116.6 },
            orientation: { heading: 63.53, pitch: 1.85, roll: 0.0 },
        },
        {
            time: 125,
            position: { lon: 14.20005, lat: 52.28131, height: 124.45 },
            orientation: { heading: 63.53, pitch: 1.85, roll: 0.0 },
        },
        {
            time: 130,
            position: { lon: 14.20007, lat: 52.27889, height: 381.28 },
            orientation: { heading: 14.16, pitch: -29.84, roll: 0 },
        },
        {
            time: 140,
            position: { lon: 14.20007, lat: 52.27889, height: 381.28 },
            orientation: { heading: 14.16, pitch: -29.84, roll: 0 },
        },
        {
            time: 145,
            position: { lon: 14.20186, lat: 52.28188, height: 145.69 },
            orientation: { heading: 13.34, pitch: -29.84, roll: 0.0 },
        },
        {
            time: 150,
            position: { lon: 14.2024, lat: 52.28275, height: 114.04 },
            orientation: { heading: 19.12, pitch: -7.77, roll: 0.0 },
        },
        {
            time: 155,
            position: { lon: 14.20254, lat: 52.28296, height: 113.5 },
            orientation: { heading: 19.12, pitch: -7.77, roll: 0.0 },
        },
        {
            time: 160,
            position: { lon: 14.20435, lat: 52.28503, height: 124.0 },
            orientation: { heading: 211.04, pitch: -2.33, roll: 0.0 },
        },
        {
            time: 165,
            position: { lon: 14.20608, lat: 52.28558, height: 174.36 },
            orientation: { heading: 227.34, pitch: -9.86, roll: 0.0 },
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
    }/**/

    // ================== MEASURER SETUP ===================

    /*
    const _performance = new PerformanceMeasurer(
        100,
        (cameraPath[cameraPath.length - 1].time + 5) * 1000,
    );
    _performance.attachToRequestScheduler(RequestScheduler);
    _performance.attachToTileset(tileset);
    _performance.attachToSceneRenderer(scene);

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

    /*
    scene.preUpdate.addEventListener(() => {
        const elapsed = JulianDate.secondsDifference(
            viewer.clock.currentTime,
            startTime,
        );

        // Kamera interpolieren 
        
        const frame = interpolateCamera(cameraPath, elapsed);
        if (frame) {
            const destination = Cartesian3.fromDegrees(
                frame.position.lon,
                frame.position.lat,
                frame.position.height,
            );
            viewer.camera.setView({
                destination,
                orientation: frame.orientation,
            });
        }
    });/**/

    // _performance.start();

    loadingIndicator.style.display = "none";
}

main();
