class PerformanceMeasurer {
    constructor(sampleRate, totalTime) {
        this.sampleRate = sampleRate;
        this.totalTime = totalTime;
        this.buffer = [];
        this.startTime = undefined;
        this.endTime = undefined;

        this._requestsSent = [];
        this._requestsReceived = [];

        this._renderStartTime = undefined;
        this._renderFinishTime = undefined;
        this._frameTimes = [];

        this._tileStats = {
            requestedTiles: 0,
            abortedTiles: 0,
            loadedTiles: 0,
            unloadedTiles: 0,
            activeRequests: new Map(),
        };
    }

    start() {
        this.startTime = performance.now();
        this.nextSampleTime = this.startTime;

        const tick = () => {
            const now = performance.now();

            while (this.nextSampleTime <= now) {
                this.collectData(this.nextSampleTime - this.startTime);
                this.nextSampleTime += this.sampleRate;
            }

            if (now - this.startTime < this.totalTime) {
                requestAnimationFrame(tick);
            } else {
                this.endTime = now;
                this.dumpData();
            }
        };

        requestAnimationFrame(tick);
    }

    collectData(timestamp) {
        console.log("collectData running");
        if (!this.tileset) {
            return;
        }
        const avgResponseTime = this._computeAverageResponseTime();
        const avgFrameTime = this._computeAverageFrameTime();

        const stats = this.tileset._statistics;

        const tileEfficiency =
            stats.selected / stats.numberOfTilesWithContentReady || 0;
        const requestEfficiency =
            stats.selected / stats.numberOfAttemptedRequests || 0;
        const pointEfficiency =
            stats.numberOfPointsSelected / stats.numberOfPointsLoaded || 0;
        const tileRequestEfficiency =
            this._tileStats.loadedTiles / this._tileStats.requestedTiles || 0;
        const tileUseEfficiency =
            stats.selected / this._tileStats.loadedTiles || 0;
        const tileAbortRate =
            this._tileStats.abortedTiles / this._tileStats.requestedTiles || 0;
        const tileCacheTurnover =
            this._tileStats.unloadedTiles / this._tileStats.loadedTiles || 0;

        this.buffer.push({
            timestamp,
            avgResponseTime,
            avgFrameTime,

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

            tileEfficiency,
            requestEfficiency,
            pointEfficiency,
            tileRequestEfficiency,
            tileUseEfficiency,
            tileAbortRate,
            tileCacheTurnover,
        });
    }

    _computeAverageResponseTime() {
        let sum = 0;
        let count = 0;

        for (let i = this._requestsReceived.length - 1; i >= 0; i--) {
            const received = this._requestsReceived[i];

            const sentIndex = this._requestsSent.findIndex(
                (s) => s.request === received.request,
            );

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
    }

    _computeAverageFrameTime() {
        if (this._frameTimes.length === 0) {
            return null;
        }

        const sum = this._frameTimes.reduce((a, b) => a + b, 0);
        const averaged = sum / this._frameTimes.length;

        this._frameTimes = [];

        return averaged;
    }

    attachToRequestScheduler(RequestScheduler) {
        RequestScheduler._onRequestSent = (request, t) => {
            this._tileStats.requestedTiles++;
            this._tileStats.activeRequests.set(request, true);
            this._requestsSent.push({ request, t });
        };

        RequestScheduler._onRequestReceived = (request, t) => {
            if (this._tileStats.activeRequests.has(request)) {
                if (request.state === 3) {
                    // CANCELLED
                    this._tileStats.abortedTiles++;
                }
                this._tileStats.activeRequests.delete(request);
            }
            this._requestsReceived.push({ request, t });
        };
    }

    attachToTileset(tileset) {
        this.tileset = tileset;

        tileset.tileLoad.addEventListener((tile) => {
            this._tileStats.loadedTiles++;
        });

        tileset.tileUnload.addEventListener((tile) => {
            this._tileStats.unloadedTiles++;
        });
    }

    attachToSceneRenderer(Scene) {
        Scene.preRender.addEventListener(() => {
            this._renderStartTime = performance.now();
        });

        Scene.postRender.addEventListener(() => {
            this._renderFinishTime = performance.now();
            this._frameTimes.push(
                this._renderFinishTime - this._renderStartTime,
            );
        });
    }

    dumpData() {
        const header = [
            "timestamp",
            "avgResponseTime",
            "avgFrameTime",

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
            "pointEfficiency", //nearest to LOD Efficiency (Points)
            "tileRequestEfficiency", // LOD Efficiency (Tiles)
            "tileUseEfficiency",
            "tileAbortRate",
            "tileCacheTurnover",
        ].join(",");

        const body = this.buffer
            .map((d) =>
                [
                    d.timestamp,
                    d.avgResponseTime ?? "-",
                    d.avgFrameTime ?? "-",

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
                ].join(","),
            )
            .join("\n");

        const blob = new Blob([header + body], { type: "text/csv" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "performanceData.csv";
        a.click();

        URL.revokeObjectURL(url);
    }
}

export default PerformanceMeasurer;
