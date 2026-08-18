import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Request from "../Core/Request.js";
import RequestScheduler from "../Core/RequestScheduler.js";
import RequestState from "../Core/RequestState.js";
import RequestType from "../Core/RequestType.js";
import Cesium3DContentGroup from "./Cesium3DContentGroup.js";
import Cesium3DTileContentState from "./Cesium3DTileContentState.js";
import Cesium3DTileContentType from "./Cesium3DTileContentType.js";
import Cesium3DTileContentFactory from "./Cesium3DTileContentFactory.js";
import findContentMetadata from "./findContentMetadata.js";
import findGroupMetadata from "./findGroupMetadata.js";
import preprocess3DTileContent from "./preprocess3DTileContent.js";

/**
 * A collection of per-timestamp contents for a multi-temporal tile produced by the
 * py3dtiles multi-temporal tiler. The tile JSON carries a plural <code>contents</code>
 * array whose entries have the shape <code>{ key, content: { uri } }</code> — one entry
 * per timestamp present at the tile.
 * <p>
 * Adapted from {@link Multiple3DTileContent}, with these differences:
 * (1) each inner content's URI is read from <code>entry.content.uri</code> (not
 * <code>entry.uri</code>); (2) each inner content remembers its timestamp
 * <code>key</code>; (3) epochs are loaded lazily — only the content whose key matches
 * <code>tileset.activeTimestamp</code> is requested, and switching the active timestamp
 * loads the new epoch on demand; (4) in <code>update</code>, only the active epoch is
 * shown via each inner {@link Model3DTileContent}'s <code>show</code> flag.
 * </p>
 * <p>
 * Per-epoch state is tracked with the native {@link Cesium3DTileContentState} enum in
 * an index-aligned array, mirroring the parallel-array style of
 * {@link Multiple3DTileContent}; there is no separate handle abstraction.
 * </p>
 * <p>
 * Implements the {@link Cesium3DTileContent} interface.
 * </p>
 *
 * @implements Cesium3DTileContent
 * @private
 * @experimental This feature is using part of the 3D Tiles spec that is not final and is subject to change without Cesium's standard deprecation policy.
 */
class MTContent {
  /**
   * @param {Cesium3DTileset} tileset The tileset this content belongs to
   * @param {Cesium3DTile} tile The tile this content belongs to
   * @param {Resource} tilesetResource The resource that points to the tileset. Used to derive each inner content's resource.
   * @param {object[]|object} contentsJson The tile's <code>contents</code> array (entries of the form <code>{ key, content: { uri } }</code>), or a tile JSON object containing such a <code>contents</code> array.
   */
  constructor(tileset, tile, tilesetResource, contentsJson) {
    this._tileset = tileset;
    this._tile = tile;
    this._tilesetResource = tilesetResource;

    // requestMTContent passes the contents array directly; be robust to either
    // the array or a tile-JSON object that contains it.
    const contentHeaders = defined(contentsJson.contents)
      ? contentsJson.contents
      : contentsJson;

    this._innerContentHeaders = contentHeaders;
    this._requestsInFlight = 0;

    // How many times the requests have been canceled (on tile cancel/destroy).
    // Used to short-circuit in-flight loads via the originalCancelCount guard.
    this._cancelCount = 0;

    // The number of contents that turned out to be external tilesets. Not
    // expected for multi-temporal point clouds, kept for parity.
    this._externalTilesetCount = 0;
    this._disableSkipLevelOfDetail = false;

    // The last style / debug settings applied by the app, re-applied to each epoch
    // as it loads so lazily-loaded epochs match the ones already resident.
    this._style = undefined;
    this._debug = undefined;

    // Latches true once the active epoch is first ready (or is absent at this tile).
    // Drives the public ready flag; never reset, to avoid refinement churn on switch.
    this._initialReady = false;

    // The active timestamp as of the previous update, used to detect a switch.
    this._lastActiveKey = undefined;

    const contentCount = contentHeaders.length;

    // Index-aligned per-epoch state. _contents[i].content stays undefined until the
    // epoch is loaded; _innerContentStates[i] tracks its lifecycle.
    this._contents = new Array(contentCount);
    this._innerContentStates = new Array(contentCount);
    // Whether each epoch has been added to the tileset load statistics. MT tiles are
    // excluded from the generic tile-level incrementLoadCounts (which runs once, at
    // tile-ready, and cannot account for lazily loaded/evicted epochs), so MTContent
    // counts each epoch itself once its model is ready and decrements it on removal.
    this._loadCounted = new Array(contentCount);
    this._requests = new Array(contentCount);
    this._innerContentResources = new Array(contentCount);
    this._serverKeys = new Array(contentCount);

    for (let i = 0; i < contentCount; i++) {
      // Note the nested shape: the URI lives under entry.content.uri.
      const contentResource = tilesetResource.getDerivedResource({
        url: contentHeaders[i].content.uri,
      });

      const serverKey = RequestScheduler.getServerKey(
        contentResource.getUrlComponent(),
      );

      this._contents[i] = {
        key: contentHeaders[i].key,
        content: undefined,
      };
      this._innerContentStates[i] = Cesium3DTileContentState.UNLOADED;
      this._loadCounted[i] = false;
      this._innerContentResources[i] = contentResource;
      this._serverKeys[i] = serverKey;
    }
  }

  /**
   * The index of the entry whose timestamp key matches the tileset's active
   * timestamp, or <code>-1</code> if that timestamp is not present at this tile.
   *
   * @type {number}
   * @readonly
   * @private
   */
  get _activeIndex() {
    return this._indexOfKey(this._tileset.activeTimestamp);
  }

  /**
   * The local index of the epoch with the given timestamp key, or <code>-1</code>
   * if that timestamp is not present at this tile.
   *
   * @param {string} key The timestamp key.
   * @returns {number} The local index, or -1.
   * @private
   */
  _indexOfKey(key) {
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      if (contents[i].key === key) {
        return i;
      }
    }
    return -1;
  }

  /**
   * The inner content whose timestamp key matches the tileset's active timestamp,
   * or <code>undefined</code> if that timestamp is not present at this tile (sparse)
   * or not yet loaded.
   *
   * @type {Cesium3DTileContent|undefined}
   * @readonly
   * @private
   */
  get _activeContent() {
    const index = this._activeIndex;
    return index >= 0 ? this._contents[index].content : undefined;
  }

  /**
   * The number of points in the active epoch (the one actually rendered), or 0 if
   * it is absent/unloaded. The {@link Cesium3DTileContent} aggregate getters return
   * 0 for statistics correctness, so these expose the active-epoch counts for display
   * and benchmarking.
   *
   * @type {number}
   * @readonly
   * @private
   */
  get activePointsLength() {
    const content = this._activeContent;
    return defined(content) ? content.pointsLength : 0;
  }

  get activeFeaturesLength() {
    const content = this._activeContent;
    return defined(content) ? content.featuresLength : 0;
  }

  /**
   * The timestamp keys of the epochs currently resident in memory. Intended for
   * verifying lazy-loading / eviction behavior.
   *
   * @type {string[]}
   * @readonly
   * @private
   */
  get loadedTimestampKeys() {
    const keys = [];
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      if (defined(contents[i].content)) {
        keys.push(contents[i].key);
      }
    }
    return keys;
  }

  get featurePropertiesDirty() {
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (defined(content) && content.featurePropertiesDirty) {
        return true;
      }
    }
    return false;
  }

  set featurePropertiesDirty(value) {
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (defined(content)) {
        content.featurePropertiesDirty = value;
      }
    }
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. Like {@link Multiple3DTileContent},
   * an <code>MTContent</code> has multiple inner contents, so these aggregate getters
   * always return <code>0</code>; the tileset's statistics are accumulated instead by
   * recursing into {@link MTContent#innerContents}. (Per-epoch counts for the active
   * timestamp are exposed separately for display/benchmarking.)
   *
   * @type {number}
   * @readonly
   * @private
   */
  get featuresLength() {
    return 0;
  }

  get pointsLength() {
    return 0;
  }

  get trianglesLength() {
    return 0;
  }

  get geometryByteLength() {
    return 0;
  }

  get texturesByteLength() {
    return 0;
  }

  get batchTableByteLength() {
    return 0;
  }

  get innerContents() {
    const result = [];
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      if (defined(contents[i].content)) {
        result.push(contents[i].content);
      }
    }
    return result;
  }

  get ready() {
    return this._initialReady;
  }

  get tileset() {
    return this._tileset;
  }

  get tile() {
    return this._tile;
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. Unlike other content types,
   * <code>MTContent</code> does not have a single URL, so this returns undefined.
   *
   * @type {string}
   * @readonly
   * @private
   */
  get url() {
    return undefined;
  }

  get metadata() {
    return undefined;
  }

  set metadata(_) {
    //>>includeStart('debug', pragmas.debug);
    throw new DeveloperError("MTContent cannot have metadata");
    //>>includeEnd('debug');
  }

  get batchTable() {
    return undefined;
  }

  get group() {
    return undefined;
  }

  set group(_) {
    //>>includeStart('debug', pragmas.debug);
    throw new DeveloperError("MTContent cannot have group metadata");
    //>>includeEnd('debug');
  }

  /**
   * Get an array of the inner content URLs, regardless of whether they've been
   * fetched. Intended for use with {@link Cesium3DTileset#debugShowUrl}.
   *
   * @type {string[]}
   * @readonly
   * @private
   */
  get innerContentUrls() {
    return this._innerContentHeaders.map(function (contentHeader) {
      return contentHeader.content.uri;
    });
  }

  /**
   * Request the active epoch only. Per the multi-temporal design, the other epochs
   * present at this tile are loaded lazily in {@link MTContent#update} when they
   * become active. Must be called once a frame until the returned promise is defined.
   *
   * @returns {Promise<void>|undefined} A promise that resolves when the active epoch is ready, or undefined if it cannot be scheduled this frame.
   * @private
   */
  requestInnerContents() {
    const activeIndex = this._activeIndex;

    // Active epoch absent at this tile (sparse): nothing to load, render nothing.
    // ADD refinement keeps ancestors rendered, so this leaves no hole.
    if (activeIndex < 0) {
      this._initialReady = true;
      return Promise.resolve(this);
    }

    // Respect the request scheduler's throttle (avoid leaking content buffers):
    // only schedule if there is an open slot, otherwise try again next frame.
    if (!canScheduleRequest(this._serverKeys[activeIndex])) {
      this.tileset.statistics.numberOfAttemptedRequests += 1;
      return undefined;
    }

    const promise = requestInnerContent(
      this,
      activeIndex,
      this._tile._contentState,
    );
    if (!defined(promise)) {
      // Request could not be scheduled this frame.
      return undefined;
    }

    // Resolving with the created content drives the tile to PROCESSING; the ready
    // latch happens in update() once the inner content is actually ready.
    return promise;
  }

  /**
   * Cancel all in-flight requests for inner contents. Reconciles the pending-request
   * statistics for the loads that are short-circuited by the cancel-count guard, and
   * returns the affected epochs to UNLOADED so they can be re-requested.
   *
   * @private
   */
  cancelRequests() {
    // Invalidate any in-flight loads still being created.
    this._cancelCount++;

    for (let i = 0; i < this._requests.length; i++) {
      const request = this._requests[i];
      if (defined(request)) {
        request.cancel();
        this._requests[i] = undefined;
      }
      if (this._innerContentStates[i] === Cesium3DTileContentState.LOADING) {
        this._innerContentStates[i] = Cesium3DTileContentState.UNLOADED;
      }
    }

    // The short-circuited promises will not decrement these themselves.
    const statistics = this.tileset.statistics;
    statistics.numberOfPendingRequests -= this._requestsInFlight;
    statistics.numberOfAttemptedRequests += this._requestsInFlight;
    this._requestsInFlight = 0;

    // Reset the tile so the traversal re-requests it when it returns to view.
    // cancelOutOfViewRequests only cancels tiles still in the LOADING state, so
    // without this the tile would be stuck LOADING forever and never reload.
    if (this._tile._contentState === Cesium3DTileContentState.LOADING) {
      this._tile._contentState = Cesium3DTileContentState.UNLOADED;
    }
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. Delegates to the active epoch.
   * @private
   */
  hasProperty(batchId, name) {
    const content = this._activeContent;
    return defined(content) ? content.hasProperty(batchId, name) : false;
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. Delegates to the active epoch.
   * @private
   */
  getFeature(batchId) {
    const content = this._activeContent;
    return defined(content) ? content.getFeature(batchId) : undefined;
  }

  applyDebugSettings(enabled, color) {
    this._debug = { enabled: enabled, color: color };
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (defined(content)) {
        content.applyDebugSettings(enabled, color);
      }
    }
  }

  applyStyle(style) {
    this._style = style;
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (defined(content)) {
        content.applyStyle(style);
      }
    }
  }

  /**
   * Evict a resident epoch: decrement the tileset load statistics, destroy its
   * content, and return the slot to UNLOADED so it can be reloaded on demand.
   * <p>
   * Counted in {@link Cesium3DTilesetStatistics#numberOfEpochsEvicted}, which is the only
   * observable signal that an epoch left memory. The tile itself stays resident, so
   * <code>tileset.tileUnload</code> is deliberately not raised — that event's contract is
   * "tile leaving the cache".
   * </p>
   *
   * @param {number} index The local epoch index.
   * @private
   */
  _evictEpoch(index) {
    const entry = this._contents[index];
    const content = entry.content;
    if (defined(content)) {
      if (this._loadCounted[index]) {
        this._tileset.statistics.decrementLoadCounts(content);
        this._loadCounted[index] = false;
      }
      ++this._tileset.statistics.numberOfEpochsEvicted;
      content.destroy();
    }
    entry.content = undefined;
    this._innerContentStates[index] = Cesium3DTileContentState.UNLOADED;
  }

  update(tileset, frameState) {
    const activeTimestamp = tileset.activeTimestamp;
    const activeIndex = this._activeIndex;

    // On a switch, give a previously-failed epoch another chance to load.
    if (activeTimestamp !== this._lastActiveKey) {
      this._lastActiveKey = activeTimestamp;
      if (
        activeIndex >= 0 &&
        this._innerContentStates[activeIndex] ===
          Cesium3DTileContentState.FAILED
      ) {
        this._innerContentStates[activeIndex] =
          Cesium3DTileContentState.UNLOADED;
      }
    }

    // The "hot" window of timestamps to keep prefetched/resident: the active epoch
    // and its symmetric ±N neighbors over the global key order.
    const timestampKeys = tileset.timestampKeys;
    const activeGlobalIndex = defined(timestampKeys)
      ? timestampKeys.indexOf(activeTimestamp)
      : -1;
    const windowKeys = computeWindowKeys(
      timestampKeys,
      activeTimestamp,
      tileset.mtPrefetchWindow,
    );

    // Load the active epoch on demand (covers epoch switches, since requestContent
    // does not fire again once the tile is ready), then prefetch the window neighbors
    // present at this tile so switching within the window is instant. Nearer epochs
    // get higher priority (lower offset); epochs not present here are skipped.
    if (activeGlobalIndex >= 0) {
      for (let w = 0; w < windowKeys.length; ++w) {
        const localIndex = this._indexOfKey(windowKeys[w]);
        if (
          localIndex < 0 ||
          this._innerContentStates[localIndex] !==
            Cesium3DTileContentState.UNLOADED
        ) {
          continue;
        }
        if (!canScheduleRequest(this._serverKeys[localIndex])) {
          this.tileset.statistics.numberOfAttemptedRequests += 1;
          continue;
        }
        const priorityOffset = Math.abs(
          timestampKeys.indexOf(windowKeys[w]) - activeGlobalIndex,
        );
        requestInnerContent(
          this,
          localIndex,
          this._tile._contentState,
          priorityOffset,
        );
      }
    }

    // Under memory pressure only, evict resident epochs that are neither in the hot
    // window nor recently selected. This bounds epochs piling up inside in-view tiles
    // (which the tileset's tile-level cache cannot reclaim); under budget we keep them
    // so revisiting a recent epoch stays instant. Reuses the tile cache's cacheBytes
    // budget — no separate budget or LRU. Eviction is at timestamp granularity.
    if (tileset.totalMemoryUsageInBytes > tileset.cacheBytes) {
      const recent = tileset._recentTimestamps;
      const contents = this._contents;
      for (let i = 0; i < contents.length; ++i) {
        if (this._innerContentStates[i] !== Cesium3DTileContentState.READY) {
          continue;
        }
        const key = contents[i].key;
        if (
          key === activeTimestamp ||
          windowKeys.indexOf(key) !== -1 ||
          recent.indexOf(key) !== -1
        ) {
          continue;
        }
        this._evictEpoch(i);
      }
    }

    // Gate drawing via the inner Model's show BEFORE update(): the draw-command
    // submission happens inside model.update, so show must be set first. Hidden
    // epochs are still updated so their bookkeeping continues.
    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (!defined(content)) {
        continue;
      }
      content.show = contents[i].key === activeTimestamp;
      content.update(tileset, frameState);

      // Add this epoch to the tileset load statistics once its model is ready (its
      // pointsLength/byteLength are only populated then). This is the single place
      // resident epochs are counted, since MT tiles are excluded from the generic
      // tile-level incrementLoadCounts.
      if (content.ready && !this._loadCounted[i]) {
        this._loadCounted[i] = true;
        tileset.statistics.incrementLoadCounts(content);
      }
    }

    // Latch ready once the active epoch's inner content is actually ready, or it
    // is absent at this tile. Mirrors Multiple3DTileContent waiting on inner ready.
    if (!this._initialReady) {
      const activeContent =
        activeIndex >= 0 ? this._contents[activeIndex].content : undefined;
      if (activeIndex < 0 || (defined(activeContent) && activeContent.ready)) {
        this._initialReady = true;
      }
    }
  }

  /**
   * Find an intersection between a ray and the active epoch's surface. The ray must
   * be given in world coordinates.
   *
   * @param {Ray} ray The ray to test for intersection.
   * @param {FrameState} frameState The frame state.
   * @param {Cartesian3|undefined} [result] The intersection or <code>undefined</code> if none was found.
   * @returns {Cartesian3|undefined} The intersection or <code>undefined</code> if none was found.
   * @private
   */
  pick(ray, frameState, result) {
    if (!this._initialReady) {
      return undefined;
    }
    const content = this._activeContent;
    if (!defined(content)) {
      return undefined;
    }
    return content.pick(ray, frameState, result);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    // Invalidate any in-flight loads so a late buffer is not built onto a
    // destroyed content, and reconcile the pending-request statistics.
    this.cancelRequests();

    const contents = this._contents;
    for (let i = 0; i < contents.length; ++i) {
      const content = contents[i].content;
      if (defined(content)) {
        // MT tiles are excluded from the generic tile-level decrementLoadCounts, so
        // release each counted epoch's load statistics here.
        if (this._loadCounted[i]) {
          this._tileset.statistics.decrementLoadCounts(content);
          this._loadCounted[i] = false;
        }
        content.destroy();
      }
    }
    return destroyObject(this);
  }
}

function updatePendingRequests(mtContent, deltaRequestCount) {
  mtContent._requestsInFlight += deltaRequestCount;
  mtContent.tileset.statistics.numberOfPendingRequests += deltaRequestCount;
}

/**
 * Check if a single inner-content request can be scheduled this frame.
 *
 * @param {string} serverKey The server key for the inner content.
 * @returns {boolean} True if the request scheduler has an open slot for it.
 * @private
 */
function canScheduleRequest(serverKey) {
  return (
    RequestScheduler.serverHasOpenSlots(serverKey, 1) &&
    RequestScheduler.heapHasOpenSlots(1)
  );
}

/**
 * Compute the "hot" window of timestamp keys around the active one: the active key
 * plus a symmetric window of <code>windowSize</code> neighbors on each side over the
 * ordered global key list, clamped at the ends. Returned in global order.
 * <p>
 * (A future look-ahead mode would shift this window toward the last switch direction;
 * that would extend this one function without touching its callers.)
 * </p>
 *
 * @param {string[]} timestampKeys The tileset's ordered timestamp keys.
 * @param {string} activeKey The active timestamp key.
 * @param {number} windowSize The number of neighbors to include on each side.
 * @returns {string[]} The window keys (includes <code>activeKey</code>), or empty if the active key is not found.
 * @private
 */
function computeWindowKeys(timestampKeys, activeKey, windowSize) {
  if (!defined(timestampKeys)) {
    return [];
  }
  const activeGlobalIndex = timestampKeys.indexOf(activeKey);
  if (activeGlobalIndex < 0) {
    return [];
  }
  const start = Math.max(0, activeGlobalIndex - windowSize);
  const end = Math.min(
    timestampKeys.length - 1,
    activeGlobalIndex + windowSize,
  );
  const keys = [];
  for (let i = start; i <= end; ++i) {
    keys.push(timestampKeys[i]);
  }
  return keys;
}

/**
 * Request and create a single epoch's inner content. The caller must have checked
 * {@link canScheduleRequest} first. Sets the epoch's state and re-applies any app
 * style/debug settings once it is ready.
 *
 * @param {number} [priorityOffset=0] Added to the tile priority so nearer prefetch neighbors load before farther ones (and before the active epoch's neighbors).
 * @returns {Promise<Cesium3DTileContent|undefined>|undefined} A promise resolving to the created content, to undefined if the request was canceled, or undefined synchronously if it could not be scheduled.
 * @private
 */
function requestInnerContent(
  mtContent,
  index,
  originalContentState,
  priorityOffset,
) {
  const originalCancelCount = mtContent._cancelCount;
  const offset = priorityOffset ?? 0;

  // It is important to clone here: fetchArrayBuffer() uses throttling, but other
  // uses of the resource do not.
  const contentResource = mtContent._innerContentResources[index].clone();
  const tile = mtContent.tile;

  // Always create a new request. If the tile gets canceled, this avoids getting
  // stuck in the canceled state. Prefetch neighbors add an offset so the active
  // epoch (offset 0) and nearer neighbors win contended request slots.
  const priorityFunction = function () {
    return tile._priority + offset;
  };
  const serverKey = mtContent._serverKeys[index];
  const request = new Request({
    throttle: true,
    throttleByServer: true,
    type: RequestType.TILES3D,
    priorityFunction: priorityFunction,
    serverKey: serverKey,
  });
  contentResource.request = request;

  const promise = contentResource.fetchArrayBuffer();
  if (!defined(promise)) {
    // Could not be scheduled this frame; leave the epoch UNLOADED to retry.
    return undefined;
  }

  mtContent._requests[index] = request;
  mtContent._innerContentStates[index] = Cesium3DTileContentState.LOADING;
  updatePendingRequests(mtContent, 1);

  return promise
    .then(function (arrayBuffer) {
      // Requests have already been canceled (tile canceled/destroyed).
      if (originalCancelCount < mtContent._cancelCount) {
        return undefined;
      }

      if (
        contentResource.request.cancelled ||
        contentResource.request.state === RequestState.CANCELLED
      ) {
        handleInnerContentCancelled(mtContent, index, originalContentState);
        return undefined;
      }

      updatePendingRequests(mtContent, -1);
      mtContent._requests[index] = undefined;
      return createInnerContent(mtContent, arrayBuffer, index);
    })
    .catch(function (error) {
      // Requests have already been canceled (tile canceled/destroyed).
      if (originalCancelCount < mtContent._cancelCount) {
        return undefined;
      }

      if (
        contentResource.request.cancelled ||
        contentResource.request.state === RequestState.CANCELLED
      ) {
        handleInnerContentCancelled(mtContent, index, originalContentState);
        return undefined;
      }

      updatePendingRequests(mtContent, -1);
      mtContent._requests[index] = undefined;
      mtContent._innerContentStates[index] = Cesium3DTileContentState.FAILED;
      handleInnerContentFailed(mtContent, index, error);
      return undefined;
    });
}

/**
 * Handle an inner-content request that was canceled by the scheduler (e.g. throttled
 * out or the tile went out of view). Returns the epoch to UNLOADED so it can retry.
 * Only the initial active-epoch load resets the tile's content state; steady-state
 * (post-ready) switches must not disturb the tile state machine.
 *
 * @private
 */
function handleInnerContentCancelled(mtContent, index, originalContentState) {
  const statistics = mtContent.tileset.statistics;
  statistics.numberOfPendingRequests -= 1;
  statistics.numberOfAttemptedRequests += 1;
  mtContent._requestsInFlight -= 1;

  mtContent._innerContentStates[index] = Cesium3DTileContentState.UNLOADED;
  mtContent._requests[index] = undefined;

  if (!mtContent._initialReady) {
    // The initial active-epoch load was canceled; let the tile retry.
    mtContent._tile._contentState = originalContentState;
  }
}

async function createInnerContent(mtContent, arrayBuffer, index) {
  if (!defined(arrayBuffer)) {
    // Content was not fetched. The error was handled in the fetch promise.
    return undefined;
  }

  const originalCancelCount = mtContent._cancelCount;
  try {
    const preprocessed = preprocess3DTileContent(arrayBuffer);

    const tileset = mtContent._tileset;
    const resource = mtContent._innerContentResources[index];
    const tile = mtContent._tile;

    if (preprocessed.contentType === Cesium3DTileContentType.EXTERNAL_TILESET) {
      mtContent._externalTilesetCount++;
      tile.hasTilesetContent = true;
    }

    mtContent._disableSkipLevelOfDetail =
      mtContent._disableSkipLevelOfDetail ||
      preprocessed.contentType === Cesium3DTileContentType.GEOMETRY ||
      preprocessed.contentType === Cesium3DTileContentType.VECTOR;

    let content;
    const contentFactory = Cesium3DTileContentFactory[preprocessed.contentType];
    if (defined(preprocessed.binaryPayload)) {
      content = await Promise.resolve(
        contentFactory(
          tileset,
          tile,
          resource,
          preprocessed.binaryPayload.buffer,
          0,
        ),
      );
    } else {
      // JSON formats
      content = await Promise.resolve(
        contentFactory(tileset, tile, resource, preprocessed.jsonPayload),
      );
    }

    // Canceled while creating (tile canceled/destroyed); discard the content.
    if (originalCancelCount < mtContent._cancelCount) {
      if (defined(content) && defined(content.destroy)) {
        content.destroy();
      }
      return undefined;
    }

    // The full entry { key, content: { uri, ... } }; metadata lives on the inner
    // content header (entry.content), the timestamp key on entry.key.
    const entry = mtContent._innerContentHeaders[index];
    const contentHeader = entry.content;

    if (tile.hasImplicitContentMetadata) {
      const subtree = tile.implicitSubtree;
      const coordinates = tile.implicitCoordinates;
      content.metadata = subtree.getContentMetadataView(coordinates, index);
    } else if (!tile.hasImplicitContent) {
      content.metadata = findContentMetadata(tileset, contentHeader);
    }

    const groupMetadata = findGroupMetadata(tileset, contentHeader);
    if (defined(groupMetadata)) {
      content.group = new Cesium3DContentGroup({
        metadata: groupMetadata,
      });
    }

    // Store the loaded epoch and re-apply any app-set style / debug settings so a
    // lazily-loaded epoch matches the epochs already resident.
    mtContent._contents[index].content = content;
    mtContent._innerContentStates[index] = Cesium3DTileContentState.READY;
    // Load statistics are added in update() once the epoch's model is actually ready
    // (pnts content reports pointsLength/byteLength only after it finishes processing),
    // not here where those values are still 0.

    if (defined(mtContent._style)) {
      content.applyStyle(mtContent._style);
    }
    if (defined(mtContent._debug)) {
      content.applyDebugSettings(
        mtContent._debug.enabled,
        mtContent._debug.color,
      );
    }

    return content;
  } catch (error) {
    mtContent._innerContentStates[index] = Cesium3DTileContentState.FAILED;
    handleInnerContentFailed(mtContent, index, error);
    return undefined;
  }
}

function handleInnerContentFailed(mtContent, index, error) {
  const tileset = mtContent._tileset;
  const url = mtContent._innerContentResources[index].url;
  const message = defined(error.message) ? error.message : error.toString();
  if (tileset.tileFailed.numberOfListeners > 0) {
    tileset.tileFailed.raiseEvent({
      url: url,
      message: message,
    });
  } else {
    console.log(`A content failed to load: ${url}`);
    console.log(`Error: ${message}`);
  }
}

export default MTContent;
