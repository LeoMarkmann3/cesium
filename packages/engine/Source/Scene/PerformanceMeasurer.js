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
        const avgResponseTime = this._computeAverageResponseTime();
        const avgFrameTime = this._computeAverageFrameTime();

        this.buffer.push({
            timestamp,
            avgResponseTime,
            avgFrameTime,
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
            this._requestsSent.push({ request, t });
        };

        RequestScheduler._onRequestReceived = (request, t) => {
            this._requestsReceived.push({ request, t });
        };
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
        const header = "timestamp,avgResponseTime,avgFrameTime\n";
        const body = this.buffer
            .map(
                (d) =>
                    `${d.timestamp},${d.avgResponseTime !== null ? d.avgResponseTime : "-"},${d.avgFrameTime !== null ? d.avgFrameTime : "-"}`,
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
