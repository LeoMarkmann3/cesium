import Resource from "../Core/Resource.js";
import defined from "../Core/defined.js";

/**
 * A tool that performs static analysis of a 3D Tiles tileset.
 *
 * @alias StaticTilesetAnalyzer
 * @constructor
 */
function StaticTilesetAnalyzer() {
    this._visitedTilesets = new Set();

    this._stats = {
        totalChunks: 0,
        totalPoints: 0,
        totalRequests: 0,
        maxDepth: 0,
    };

    this._result = null;
}

/**
 * Starts the static analysis of a tileset.
 *
 * @param {String|Resource} input The tileset URL or resource.
 * @returns {Promise<void>} A promise that resolves when analysis is complete.
 */
StaticTilesetAnalyzer.prototype.startAnalyze = async function (input) {
    this._reset();

    const rootResource = Resource.createIfNeeded(input);

    await this._analyzeTileset(rootResource, 0);

    const totalChunks = this._stats.totalChunks;
    const totalPoints = this._stats.totalPoints;
    const totalRequests = this._stats.totalRequests;

    this._result = {
        totalChunks: totalChunks,
        totalPoints: totalPoints,
        avgPointsPerChunk: totalChunks > 0 ? totalPoints / totalChunks : 0,
        totalRequests: totalRequests,
        requestsPerMillionPoints:
            totalPoints > 0 ? totalRequests / (totalPoints / 1000000.0) : 0,
        maxDepth: this._stats.maxDepth,
    };

    this.dumpData();
};

/**
 * Resets the internal state of the analyzer.
 *
 * @private
 */
StaticTilesetAnalyzer.prototype._reset = function () {
    this._visitedTilesets.clear();

    this._stats.totalChunks = 0;
    this._stats.totalPoints = 0;
    this._stats.totalRequests = 0;
    this._stats.maxDepth = 0;

    this._result = null;
};

/**
 * Analyzes a tileset JSON resource.
 *
 * @param {Resource} resource The tileset resource.
 * @param {Number} depth The current traversal depth.
 * @returns {Promise<void>} A promise that resolves when traversal is complete.
 * @private
 */
StaticTilesetAnalyzer.prototype._analyzeTileset = async function (
    resource,
    depth,
) {
    const absoluteUrl = resource.url;

    if (this._visitedTilesets.has(absoluteUrl)) {
        return;
    }

    this._visitedTilesets.add(absoluteUrl);

    this._stats.totalRequests++;

    const tilesetJson = await resource.fetchJson();

    await this._traverseTile(tilesetJson.root, resource, depth);
};

/**
 * Traverses a tile and its children.
 *
 * @param {Object} tile The tile JSON definition.
 * @param {Resource} baseResource The base resource used for resolving content URIs.
 * @param {Number} depth The current traversal depth.
 * @returns {Promise<void>} A promise that resolves when traversal is complete.
 * @private
 */
StaticTilesetAnalyzer.prototype._traverseTile = async function (
    tile,
    baseResource,
    depth,
) {
    if (!defined(tile)) {
        return;
    }

    if (depth > this._stats.maxDepth) {
        this._stats.maxDepth = depth;
    }

    if (defined(tile.content) && defined(tile.content.uri)) {
        const contentUri = tile.content.uri;

        const resolvedResource = baseResource.getDerivedResource({
            url: contentUri,
        });

        this._stats.totalRequests++;

        if (contentUri.match(/\.pnts$/i)) {
            const points = await this._readPointsFromPnts(resolvedResource);

            this._stats.totalChunks++;
            this._stats.totalPoints += points;
        } else if (contentUri.match(/\.json$/i)) {
            await this._analyzeTileset(resolvedResource, depth + 1);
        }
    }

    if (defined(tile.children)) {
        const children = tile.children;

        for (let i = 0; i < children.length; i++) {
            await this._traverseTile(children[i], baseResource, depth + 1);
        }
    }
};

/**
 * Reads the POINTS_LENGTH value from a PNTS file.
 *
 * @param {Resource} resource The PNTS resource.
 * @returns {Promise<Number>} A promise that resolves to the number of points in the tile.
 *
 * @exception {Error} The PNTS file does not contain a POINTS_LENGTH field.
 * @private
 */
StaticTilesetAnalyzer.prototype._readPointsFromPnts = async function (
    resource,
) {
    const arrayBuffer = await resource.fetchArrayBuffer();
    const dataView = new DataView(arrayBuffer);

    const featureTableJsonByteLength = dataView.getUint32(12, true);

    const headerByteLength = 28;

    const jsonBytes = new Uint8Array(
        arrayBuffer,
        headerByteLength,
        featureTableJsonByteLength,
    );

    const decoder = new TextDecoder("utf-8");
    const jsonText = decoder.decode(jsonBytes);

    const featureTable = JSON.parse(jsonText);

    if (!defined(featureTable.POINTS_LENGTH)) {
        throw new Error("PNTS file missing POINTS_LENGTH field.");
    }

    return featureTable.POINTS_LENGTH;
};

/**
 * Writes the analysis result to a CSV file and initiates a download.
 *
 * @exception {Error} Static analysis has not been executed yet.
 */
StaticTilesetAnalyzer.prototype.dumpData = function () {
    if (!defined(this._result)) {
        throw new Error("Static analysis has not been executed yet.");
    }

    const header = [
        "totalChunks",
        "totalPoints",
        "avgPointsPerChunk",
        "totalRequests",
        "requestsPerMillionPoints",
        "maxDepth",
    ].join(",");

    const body = [
        this._result.totalChunks,
        this._result.totalPoints,
        this._result.avgPointsPerChunk,
        this._result.totalRequests,
        this._result.requestsPerMillionPoints,
        this._result.maxDepth,
    ].join(",");

    const blob = new Blob([`${header}\n${body}`], {
        type: "text/csv",
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "staticTilesetAnalysis.csv";
    a.click();

    URL.revokeObjectURL(url);
};

export default StaticTilesetAnalyzer;
