import RequestState from "../Core/RequestState.js";

/**
 * A tool that measures different metrics of performance.
 *
 * @alias PerformanceMeasurer
 * @constructor
 *
 * @param {Number} sampleRate The measurement interval in milliseconds.
 * @param {Number} totalTime The total measurement duration in milliseconds.
 */
function PerformanceMeasurer(sampleRate, totalTime) {
    /**
     * The measurement interval in milliseconds.
     * @type {Number}
     */
    this.sampleRate = sampleRate;

    /**
     * The total time in milliseconds.
     * @type {Number}
     */
    this.totalTime = totalTime;

    /**
     * The start time in milliseconds.
     * @type {Number}
     */
    this.startTime = undefined;

    /**
     * The end time in milliseconds.
     * @type {Number}
     */
    this.endTime = undefined;

    this._buffer = [];
    this._tileset = undefined;

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

/**
 * Starts the measurement process.
 */
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

/**
 * Collects the data necessary for analyzing the metrics and writes to a buffer.
 *
 * @param {Number} timestamp The timestamp for the currently evaluated time interval.
 *
 * @private
 */
PerformanceMeasurer.prototype._collectData = function (timestamp) {
    if (!this._tileset) {
        return;
    }

    const fps = this._computeFps(timestamp);
    const avgResponseTime = this._computeAverageResponseTime();
    const avgFrameTime = this._computeAverageFrameTime();

    const pointsRendered = this._pointsRendered;
    this._pointsRendered = 0;

    const stats = this._tileset._statistics;

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

    this._buffer.push({
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

/**
 * Computes the average response times of the requests send by the {@link RequestScheduler} in one time interval.
 *
 * @returns {Number|undefined} The average response time in milliseconds, or <code>undefined</code> if no requests were completed.

 *
 * @private
 */
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

    return count > 0 ? sum / count : undefined;
};

/**
 * Computes the average frame generation time, to be precise, the time between {@link Scene#preRender} and {@link Scene#postRender}, in one time interval.
 *
 * @returns {Number|undefined} The average frame time in ms, or <code>undefined</code> if no frames were completed.
 *
 * @private
 */
PerformanceMeasurer.prototype._computeAverageFrameTime = function () {
    if (this._frameTimes.length === 0) {
        return undefined;
    }

    const sum = this._frameTimes.reduce(function (a, b) {
        return a + b;
    }, 0);

    const averaged = sum / this._frameTimes.length;

    this._frameTimes = [];

    return averaged;
};

/**
 * Computes the average FPS for one time interval.
 *
 * @param {Number} timestamp The timestamp for the currently evaluated time interval.
 * @returns {Number} The average FPS.
 *
 * @private
 */
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

/**
 * Attaches events to the {@link RequestScheduler} to measure response times.
 *
 * @param {RequestScheduler} RequestScheduler The current RequestScheduler.
 */
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

/**
 * Attaches events to the {@link Cesium3DTileset} to measure load behaviour.
 *
 * @param {Cesium3DTileset} tileset The to be measured Cesium3DTileset.
 */
PerformanceMeasurer.prototype.attachToTileset = function (tileset) {
    this._tileset = tileset;

    const that = this;

    tileset.tileLoad.addEventListener(function () {
        that._tileStats.loadedTiles++;
    });

    tileset.tileUnload.addEventListener(function () {
        that._tileStats.unloadedTiles++;
    });
};

/**
 * Attaches events to the {@link Scene} to measure frame times via {@link Scene#preRender} and {@link Scene#postRender}.
 *
 * @param {Scene} scene The current Scene.
 */
PerformanceMeasurer.prototype.attachToSceneRenderer = function (scene) {
    const that = this;

    scene.preRender.addEventListener(function () {
        that._renderStartTime = performance.now();
    });

    scene.postRender.addEventListener(function () {
        that._renderFinishTime = performance.now();
        that._numberOfFrames++;

        that._pointsRendered +=
            that._tileset._statistics.numberOfPointsSelected;

        that._frameTimes.push(that._renderFinishTime - that._renderStartTime);
    });
};

/**
 * Writes the collected data to a csv and downloads it.
 */
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

    const body = this._buffer
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
