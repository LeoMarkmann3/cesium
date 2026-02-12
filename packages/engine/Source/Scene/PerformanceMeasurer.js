// ##############################################################
// ##############################################################
// ##############################################################
// ----------------- Original Class-based Code ------------------
// ##############################################################
// ##############################################################
// ##############################################################

// import RequestState from "../Core/RequestState.js";

// class PerformanceMeasurer {
//     constructor(sampleRate, totalTime) {
//         this.sampleRate = sampleRate;
//         this.totalTime = totalTime;
//         this.buffer = [];
//         this.startTime = undefined;
//         this.endTime = undefined;
//         this.tileset = undefined;

//         this._requestsSent = [];
//         this._requestsReceived = [];

//         this._renderStartTime = undefined;
//         this._renderFinishTime = undefined;
//         this._frameTimes = [];

//         this._pointsRendered = 0;
//         this._numberOfFrames = 0;
//         this._previousTimeStamp = 0;
//         this._previousFPS = 0;

//         this._tileStats = {
//             requestedTiles: 0,
//             abortedTiles: 0,
//             loadedTiles: 0,
//             unloadedTiles: 0,
//             activeRequests: new Map(),
//         };
//     }

//     start() {
//         this.startTime = performance.now();
//         this.nextSampleTime = this.startTime;

//         const tick = () => {
//             const now = performance.now();

//             while (this.nextSampleTime <= now) {
//                 this._collectData(this.nextSampleTime - this.startTime);
//                 this.nextSampleTime += this.sampleRate;
//             }

//             if (now - this.startTime < this.totalTime) {
//                 requestAnimationFrame(tick);
//             } else {
//                 this.endTime = now;
//                 this.dumpData();
//             }
//         };

//         requestAnimationFrame(tick);
//     }

//     _collectData(timestamp) {
//         // console.log("collectData running");

//         if (!this.tileset) {
//             return;
//         }

//         const fps = this._computeFps(timestamp);
//         const avgResponseTime = this._computeAverageResponseTime();
//         const avgFrameTime = this._computeAverageFrameTime();

//         const pointsRendered = this._pointsRendered;
//         this._pointsRendered = 0;

//         const stats = this.tileset._statistics;

//         const tileEfficiency =
//             stats.selected / stats.numberOfTilesWithContentReady || 0;
//         const requestEfficiency =
//             stats.selected / stats.numberOfAttemptedRequests || 0;
//         const pointEfficiency =
//             stats.numberOfPointsSelected / stats.numberOfPointsLoaded || 0;
//         const tileRequestEfficiency =
//             this._tileStats.loadedTiles / this._tileStats.requestedTiles || 0;
//         const tileUseEfficiency =
//             stats.selected / this._tileStats.loadedTiles || 0;
//         const tileAbortRate =
//             this._tileStats.abortedTiles / this._tileStats.requestedTiles || 0;
//         const tileCacheTurnover =
//             this._tileStats.unloadedTiles / this._tileStats.loadedTiles || 0;

//         this.buffer.push({
//             timestamp,
//             avgResponseTime,
//             avgFrameTime,
//             fps,
//             pointsRendered,

//             requestedTiles: this._tileStats.requestedTiles,
//             abortedTiles: this._tileStats.abortedTiles,
//             loadedTiles: this._tileStats.loadedTiles,
//             unloadedTiles: this._tileStats.unloadedTiles,

//             selected: stats.selected,
//             numberOfAttemptedRequests: stats.numberOfAttemptedRequests,
//             numberOfPendingRequests: stats.numberOfPendingRequests,
//             numberOfTilesProcessing: stats.numberOfTilesProcessing,
//             numberOfTilesWithContentReady: stats.numberOfTilesWithContentReady,
//             numberOfTilesTotal: stats.numberOfTilesTotal,
//             numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
//             numberOfPointsSelected: stats.numberOfPointsSelected,
//             numberOfPointsLoaded: stats.numberOfPointsLoaded,

//             tileEfficiency,
//             requestEfficiency,
//             pointEfficiency,
//             tileRequestEfficiency,
//             tileUseEfficiency,
//             tileAbortRate,
//             tileCacheTurnover,
//         });
//     }

//     _computeAverageResponseTime() {
//         let sum = 0;
//         let count = 0;

//         for (let i = this._requestsReceived.length - 1; i >= 0; i--) {
//             const received = this._requestsReceived[i];

//             const sentIndex = this._requestsSent.findIndex(
//                 (s) => s.request === received.request,
//             );

//             if (sentIndex !== -1) {
//                 const sent = this._requestsSent[sentIndex];
//                 const responseTime = received.t - sent.t;

//                 sum += responseTime;
//                 count++;

//                 this._requestsReceived.splice(i, 1);
//                 this._requestsSent.splice(sentIndex, 1);
//             }
//         }

//         return count > 0 ? sum / count : null;
//     }

//     _computeAverageFrameTime() {
//         if (this._frameTimes.length === 0) {
//             return null;
//         }

//         const sum = this._frameTimes.reduce((a, b) => a + b, 0);
//         const averaged = sum / this._frameTimes.length;

//         this._frameTimes = [];

//         return averaged;
//     }

//     _computeFps(timestamp) {
//         let fps = 0;

//         if (this._previousTimeStamp === 0) {
//             this._previousTimeStamp = timestamp;
//             return [0, 0];
//         }

//         const timeDiff = timestamp - this._previousTimeStamp;

//         if (timeDiff >= 500) {
//             fps = (this._numberOfFrames * 1000) / timeDiff;

//             this._numberOfFrames = 0;
//             this._previousFPS = fps;
//             this._previousTimeStamp = timestamp;
//         } else {
//             fps = this._previousFPS;
//         }

//         return fps;
//     }

//     attachToRequestScheduler(RequestScheduler) {
//         RequestScheduler._onRequestSent = (request, t) => {
//             this._tileStats.requestedTiles++;
//             this._tileStats.activeRequests.set(request, true);
//             this._requestsSent.push({ request, t });
//         };

//         RequestScheduler._onRequestReceived = (request, t) => {
//             if (this._tileStats.activeRequests.has(request)) {
//                 if (request.state === RequestState.CANCELLED) {
//                     this._tileStats.abortedTiles++;
//                 }
//                 this._tileStats.activeRequests.delete(request);
//             }
//             this._requestsReceived.push({ request, t });
//         };
//     }

//     attachToTileset(tileset) {
//         this.tileset = tileset;

//         tileset.tileLoad.addEventListener((tile) => {
//             this._tileStats.loadedTiles++;
//         });

//         tileset.tileUnload.addEventListener((tile) => {
//             this._tileStats.unloadedTiles++;
//         });
//     }

//     attachToSceneRenderer(Scene) {
//         Scene.preRender.addEventListener(() => {
//             this._renderStartTime = performance.now();
//         });

//         Scene.postRender.addEventListener(() => {
//             this._renderFinishTime = performance.now();
//             this._numberOfFrames++;

//             this._pointsRendered +=
//                 this.tileset._statistics.numberOfPointsSelected;

//             this._frameTimes.push(
//                 this._renderFinishTime - this._renderStartTime,
//             );
//         });
//     }

//     dumpData() {
//         const header = [
//             "timestamp",
//             "avgResponseTime",
//             "avgFrameTime",
//             "fps",
//             "pointsRendered",

//             "requestedTiles",
//             "abortedTiles",
//             "loadedTiles",
//             "unloadedTiles",

//             "selected",
//             "numberOfAttemptedRequests",
//             "numberOfPendingRequests",
//             "numberOfTilesProcessing",
//             "numberOfTilesWithContentReady",
//             "numberOfTilesTotal",
//             "numberOfLoadedTilesTotal",
//             "numberOfPointsSelected",
//             "numberOfPointsLoaded",

//             "tileEfficiency",
//             "requestEfficiency",
//             "pointEfficiency", //nearest to LOD Efficiency (Points)
//             "tileRequestEfficiency", // LOD Efficiency (Tiles)
//             "tileUseEfficiency",
//             "tileAbortRate",
//             "tileCacheTurnover",
//         ].join(",");

//         const body = this.buffer
//             .map((d) =>
//                 [
//                     d.timestamp,
//                     d.avgResponseTime ?? "-",
//                     d.avgFrameTime ?? "-",
//                     d.fps,
//                     d.pointsRendered,

//                     d.requestedTiles,
//                     d.abortedTiles,
//                     d.loadedTiles,
//                     d.unloadedTiles,

//                     d.selected,
//                     d.numberOfAttemptedRequests,
//                     d.numberOfPendingRequests,
//                     d.numberOfTilesProcessing,
//                     d.numberOfTilesWithContentReady,
//                     d.numberOfTilesTotal,
//                     d.numberOfLoadedTilesTotal,
//                     d.numberOfPointsSelected,
//                     d.numberOfPointsLoaded,

//                     d.tileEfficiency,
//                     d.requestEfficiency,
//                     d.pointEfficiency,
//                     d.tileRequestEfficiency,
//                     d.tileUseEfficiency,
//                     d.tileAbortRate,
//                     d.tileCacheTurnover,
//                 ].join(","),
//             )
//             .join("\n");

//         const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
//         const url = URL.createObjectURL(blob);

//         const a = document.createElement("a");
//         a.href = url;
//         a.download = "performanceData.csv";
//         a.click();

//         URL.revokeObjectURL(url);
//     }
// }

// export default PerformanceMeasurer;

// ##############################################################
// ##############################################################
// ##############################################################
// ----------------- Cesium-style adapted Code ------------------
// ##############################################################
// ##############################################################
// ##############################################################

import RequestState from "../Core/RequestState.js";

function PerformanceMeasurer(sampleRate, totalTime) {
    this.sampleRate = sampleRate;
    this.totalTime = totalTime;
    this.buffer = [];
    this.startTime = undefined;
    this.endTime = undefined;
    this.tileset = undefined;

    this._requestsSent = [];
    this._requestsReceived = [];

    this._renderStartTime = undefined;
    this._renderFinishTime = undefined;
    this._frameTimes = [];

    this._pointsRendered = 0;
    this._numberOfFrames = 0;
    this._previousTimeStamp = 0;
    this._previousFPS = 0;

    this._tileStats = {
        requestedTiles: 0,
        abortedTiles: 0,
        loadedTiles: 0,
        unloadedTiles: 0,
        activeRequests: new Map(),
    };
}

PerformanceMeasurer.prototype.start = function () {
    this.startTime = performance.now();
    this.nextSampleTime = this.startTime;

    const that = this;

    function tick() {
        const now = performance.now();

        while (that.nextSampleTime <= now) {
            that._collectData(that.nextSampleTime - that.startTime);
            that.nextSampleTime += that.sampleRate;
        }

        if (now - that.startTime < that.totalTime) {
            requestAnimationFrame(tick);
        } else {
            that.endTime = now;
            that.dumpData();
        }
    }

    requestAnimationFrame(tick);
};

PerformanceMeasurer.prototype._collectData = function (timestamp) {
    if (!this.tileset) {
        return;
    }

    const fps = this._computeFps(timestamp);
    const avgResponseTime = this._computeAverageResponseTime();
    const avgFrameTime = this._computeAverageFrameTime();

    const pointsRendered = this._pointsRendered;
    this._pointsRendered = 0;

    const stats = this.tileset._statistics;

    const tileEfficiency =
        stats.selected / stats.numberOfTilesWithContentReady || 0;
    const requestEfficiency =
        stats.selected / stats.numberOfAttemptedRequests || 0;
    const pointEfficiency =
        stats.numberOfPointsSelected / stats.numberOfPointsLoaded || 0;
    const tileRequestEfficiency =
        this._tileStats.loadedTiles / this._tileStats.requestedTiles || 0;
    const tileUseEfficiency = stats.selected / this._tileStats.loadedTiles || 0;
    const tileAbortRate =
        this._tileStats.abortedTiles / this._tileStats.requestedTiles || 0;
    const tileCacheTurnover =
        this._tileStats.unloadedTiles / this._tileStats.loadedTiles || 0;

    this.buffer.push({
        timestamp: timestamp,
        avgResponseTime: avgResponseTime,
        avgFrameTime: avgFrameTime,
        fps: fps,
        pointsRendered: pointsRendered,

        requestedTiles: this._tileStats.requestedTiles,
        abortedTiles: this._tileStats.abortedTiles,
        loadedTiles: this._tileStats.loadedTiles,
        unloadedTiles: this._tileStats.unloadedTiles,

        selected: stats.selected,
        numberOfAttemptedRequests: stats.numberOfAttemptedRequests,
        numberOfPendingRequests: stats.numberOfPendingRequests,
        numberOfTilesProcessing: stats.numberOfTilesProcessing,
        numberOfTilesWithContentReady: stats.numberOfTilesWithContentReady,
        numberOfTilesTotal: stats.numberOfTilesTotal,
        numberOfLoadedTilesTotal: stats.numberOfLoadedTilesTotal,
        numberOfPointsSelected: stats.numberOfPointsSelected,
        numberOfPointsLoaded: stats.numberOfPointsLoaded,

        tileEfficiency: tileEfficiency,
        requestEfficiency: requestEfficiency,
        pointEfficiency: pointEfficiency,
        tileRequestEfficiency: tileRequestEfficiency,
        tileUseEfficiency: tileUseEfficiency,
        tileAbortRate: tileAbortRate,
        tileCacheTurnover: tileCacheTurnover,
    });
};

PerformanceMeasurer.prototype._computeAverageResponseTime = function () {
    let sum = 0;
    let count = 0;

    for (let i = this._requestsReceived.length - 1; i >= 0; i--) {
        const received = this._requestsReceived[i];

        const sentIndex = this._requestsSent.findIndex(function (s) {
            return s.request === received.request;
        });

        if (sentIndex !== -1) {
            const sent = this._requestsSent[sentIndex];
            const responseTime = received.t - sent.t;

            sum += responseTime;
            count++;

            this._requestsReceived.splice(i, 1);
            this._requestsSent.splice(sentIndex, 1);
        }
    }

    return count > 0 ? sum / count : null;
};

PerformanceMeasurer.prototype._computeAverageFrameTime = function () {
    if (this._frameTimes.length === 0) {
        return null;
    }

    const sum = this._frameTimes.reduce(function (a, b) {
        return a + b;
    }, 0);

    const averaged = sum / this._frameTimes.length;

    this._frameTimes = [];

    return averaged;
};

PerformanceMeasurer.prototype._computeFps = function (timestamp) {
    let fps = 0;

    if (this._previousTimeStamp === 0) {
        this._previousTimeStamp = timestamp;
        return 0;
    }

    const timeDiff = timestamp - this._previousTimeStamp;

    if (timeDiff >= 500) {
        fps = (this._numberOfFrames * 1000) / timeDiff;

        this._numberOfFrames = 0;
        this._previousFPS = fps;
        this._previousTimeStamp = timestamp;
    } else {
        fps = this._previousFPS;
    }

    return fps;
};

PerformanceMeasurer.prototype.attachToRequestScheduler = function (
    RequestScheduler,
) {
    const that = this;

    RequestScheduler._onRequestSent = function (request, t) {
        that._tileStats.requestedTiles++;
        that._tileStats.activeRequests.set(request, true);
        that._requestsSent.push({ request: request, t: t });
    };

    RequestScheduler._onRequestReceived = function (request, t) {
        if (that._tileStats.activeRequests.has(request)) {
            if (request.state === RequestState.CANCELLED) {
                that._tileStats.abortedTiles++;
            }
            that._tileStats.activeRequests.delete(request);
        }
        that._requestsReceived.push({ request: request, t: t });
    };
};

PerformanceMeasurer.prototype.attachToTileset = function (tileset) {
    this.tileset = tileset;

    const that = this;

    tileset.tileLoad.addEventListener(function () {
        that._tileStats.loadedTiles++;
    });

    tileset.tileUnload.addEventListener(function () {
        that._tileStats.unloadedTiles++;
    });
};

PerformanceMeasurer.prototype.attachToSceneRenderer = function (scene) {
    const that = this;

    scene.preRender.addEventListener(function () {
        that._renderStartTime = performance.now();
    });

    scene.postRender.addEventListener(function () {
        that._renderFinishTime = performance.now();
        that._numberOfFrames++;

        that._pointsRendered += that.tileset._statistics.numberOfPointsSelected;

        that._frameTimes.push(that._renderFinishTime - that._renderStartTime);
    });
};

PerformanceMeasurer.prototype.dumpData = function () {
    const header = [
        "timestamp",
        "avgResponseTime",
        "avgFrameTime",
        "fps",
        "pointsRendered",
        "requestedTiles",
        "abortedTiles",
        "loadedTiles",
        "unloadedTiles",
        "selected",
        "numberOfAttemptedRequests",
        "numberOfPendingRequests",
        "numberOfTilesProcessing",
        "numberOfTilesWithContentReady",
        "numberOfTilesTotal",
        "numberOfLoadedTilesTotal",
        "numberOfPointsSelected",
        "numberOfPointsLoaded",
        "tileEfficiency",
        "requestEfficiency",
        "pointEfficiency",
        "tileRequestEfficiency",
        "tileUseEfficiency",
        "tileAbortRate",
        "tileCacheTurnover",
    ].join(",");

    const body = this.buffer
        .map(function (d) {
            return [
                d.timestamp,
                d.avgResponseTime ?? "-",
                d.avgFrameTime ?? "-",
                d.fps,
                d.pointsRendered,
                d.requestedTiles,
                d.abortedTiles,
                d.loadedTiles,
                d.unloadedTiles,
                d.selected,
                d.numberOfAttemptedRequests,
                d.numberOfPendingRequests,
                d.numberOfTilesProcessing,
                d.numberOfTilesWithContentReady,
                d.numberOfTilesTotal,
                d.numberOfLoadedTilesTotal,
                d.numberOfPointsSelected,
                d.numberOfPointsLoaded,
                d.tileEfficiency,
                d.requestEfficiency,
                d.pointEfficiency,
                d.tileRequestEfficiency,
                d.tileUseEfficiency,
                d.tileAbortRate,
                d.tileCacheTurnover,
            ].join(",");
        })
        .join("\n");

    const blob = new Blob([`${header}\n${body}`], {
        type: "text/csv",
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "performanceData.csv";
    a.click();

    URL.revokeObjectURL(url);
};

export default PerformanceMeasurer;
