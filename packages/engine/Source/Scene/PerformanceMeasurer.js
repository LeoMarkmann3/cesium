class PerformanceMeasurer {
    constructor(sampleRate, totalTime) {
        this.sampleRate = sampleRate;
        this.totalTime = totalTime;
        this.buffer = [];
        this.startTime = undefined;
        this.endTime = undefined;
        this._interval = null;
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
        this.buffer.push({
            timestamp,
            value: Math.random(),
        });
    }

    dumpData() {
        const header = "timestamp,value\n";
        const body = this.buffer
            .map((d) => `${d.timestamp},${d.value}`)
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
