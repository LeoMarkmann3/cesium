import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Request from "../Core/Request.js";
import RequestScheduler from "../Core/RequestScheduler.js";
import RequestState from "../Core/RequestState.js";
import RequestType from "../Core/RequestType.js";
import RuntimeError from "../Core/RuntimeError.js";
import Cesium3DContentGroup from "./Cesium3DContentGroup.js";
import Cesium3DTileContentState from "./Cesium3DTileContentState.js";
import Cesium3DTileContentType from "./Cesium3DTileContentType.js";
import Cesium3DTileContentFactory from "./Cesium3DTileContentFactory.js";
import findContentMetadata from "./findContentMetadata.js";
import findGroupMetadata from "./findGroupMetadata.js";
import MTLayout from "./MTLayout.js";
import preprocess3DTileContent from "./preprocess3DTileContent.js";

/**
 * The per-tile content of a multi-temporal tileset with the
 * {@link MTLayout#REFERENCED_TILESETS} layout, where each timestamp is a standalone
 * tileset referenced by key. The tile JSON carries a plural <code>contents</code> array
 * whose entries have the shape <code>{ key, content: { uri } }</code> — the same shape as
 * the shared-tree layout, except that each <code>uri</code> points at an external
 * <code>tileset.json</code> instead of a tile payload.
 * <p>
 * Only the active timestamp is ever resident: its sub-tileset is fetched and grafted into
 * this tileset's tile tree (as a child of this content's tile, by
 * {@link Cesium3DTileset#loadTileset} via {@link Tileset3DTileContent}), and the epoch is
 * rendered by those grafted tiles rather than by this content. Switching the active
 * timestamp therefore replaces the grafted sub-tileset, so there is nothing to prefetch or
 * retain and {@link Cesium3DTileset#mtPrefetchWindow} /
 * {@link Cesium3DTileset#mtRetainedHistory} do not apply to this layout.
 * </p>
 * <p>
 * Adapted from {@link MTContent}, which serves the shared-tree layout. The differences
 * follow from the payload being a tileset rather than a point cloud: there are no per-epoch
 * models to show or hide, statistics for the rendered epoch accumulate through the grafted
 * tiles' own ordinary bookkeeping, and styling and picking reach those tiles directly.
 * </p>
 * <p>
 * Implements the {@link Cesium3DTileContent} interface.
 * </p>
 *
 * @implements Cesium3DTileContent
 * @private
 * @experimental This feature is using part of the 3D Tiles spec that is not final and is subject to change without Cesium's standard deprecation policy.
 */
class MTTilesetContent {
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

    // The last style / debug settings applied by the app. The grafted sub-tileset's tiles
    // are styled by the tileset's style engine like any other tiles, so these are only
    // forwarded for interface parity with the shared-tree layout.
    this._style = undefined;
    this._debug = undefined;

    // Latches true once the active epoch is grafted (or is absent at this tile).
    this._initialReady = false;

    // The epoch whose sub-tileset is currently grafted into the tile tree, its content
    // object, and the root tile the graft added to this tile's children. -1/undefined
    // while nothing is grafted.
    this._graftedIndex = -1;
    this._graftedContent = undefined;
    this._graftedRoot = undefined;

    this._lastActiveKey = undefined;

    const contentCount = contentHeaders.length;

    // Index-aligned per-epoch state, mirroring MTContent. Only one entry is ever loaded,
    // but the arrays keep the two layouts' bookkeeping recognizably the same.
    this._contents = new Array(contentCount);
    this._innerContentStates = new Array(contentCount);
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
   * The timestamp keys of the epochs currently resident, i.e. at most the grafted one.
   * Intended for verifying the one-epoch-at-a-time behavior.
   *
   * @type {string[]}
   * @readonly
   * @private
   */
  get loadedTimestampKeys() {
    return this._graftedIndex >= 0
      ? [this._contents[this._graftedIndex].key]
      : [];
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. The active epoch's points and
   * features are counted by the grafted sub-tileset's own tiles, so the per-epoch counts
   * that {@link MTContent} exposes for the shared-tree layout are <code>0</code> here.
   * Use {@link Cesium3DTileset#activePointsRendered} instead.
   *
   * @type {number}
   * @readonly
   * @private
   */
  get activePointsLength() {
    return 0;
  }

  get activeFeaturesLength() {
    return 0;
  }

  get featurePropertiesDirty() {
    const content = this._graftedContent;
    return defined(content) ? content.featurePropertiesDirty : false;
  }

  set featurePropertiesDirty(value) {
    const content = this._graftedContent;
    if (defined(content)) {
      content.featurePropertiesDirty = value;
    }
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. Like {@link MTContent} and
   * {@link Multiple3DTileContent}, these aggregate getters always return <code>0</code>;
   * the tileset's statistics come from the grafted sub-tileset's tiles.
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
    const content = this._graftedContent;
    return defined(content) ? [content] : [];
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
   * <code>MTTilesetContent</code> does not have a single URL, so this returns undefined.
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
    throw new DeveloperError("MTTilesetContent cannot have metadata");
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
    throw new DeveloperError("MTTilesetContent cannot have group metadata");
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
   * Request the active epoch's sub-tileset. The other epochs present at this tile are not
   * fetched: this layout keeps exactly one epoch resident and refetches on a switch. Must
   * be called once a frame until the returned promise is defined.
   *
   * @returns {Promise<void>|undefined} A promise that resolves when the active epoch's sub-tileset is grafted, or undefined if the request cannot be scheduled this frame.
   * @private
   */
  requestInnerContents() {
    // A re-request means the epoch changed (the tile was expired in update). Release the
    // outgoing epoch's content object here: the caller destroys the grafted *tiles* right
    // afterwards, in the same synchronous block, so by the time the new payload arrives
    // this tile's children are empty again.
    this._releaseGraft();

    const activeIndex = this._activeIndex;

    // Active epoch absent at this tile: nothing to load and nothing to render.
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

    // Resolving with the created content drives the tile to PROCESSING; the ready latch
    // happens in update() once the sub-tileset is grafted.
    return promise;
  }

  /**
   * Cancel the in-flight request for the epoch being loaded. Reconciles the
   * pending-request statistics for the load that is short-circuited by the cancel-count
   * guard, and returns the epoch to UNLOADED so it can be re-requested.
   *
   * @private
   */
  cancelRequests() {
    // Invalidate any in-flight load still being created.
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
   * Part of the {@link Cesium3DTileContent} interface. The features of the active epoch
   * belong to the grafted sub-tileset's own tiles, which Cesium picks and queries
   * directly, so this content has no features of its own.
   * @private
   */
  hasProperty(batchId, name) {
    return false;
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. See {@link MTTilesetContent#hasProperty}.
   * @private
   */
  getFeature(batchId) {
    return undefined;
  }

  applyDebugSettings(enabled, color) {
    this._debug = { enabled: enabled, color: color };
    const content = this._graftedContent;
    if (defined(content)) {
      content.applyDebugSettings(enabled, color);
    }
  }

  applyStyle(style) {
    this._style = style;
    const content = this._graftedContent;
    if (defined(content)) {
      content.applyStyle(style);
    }
  }

  /**
   * Release the epoch currently grafted into the tile tree: destroy its content object and
   * forget it, returning its entry to UNLOADED so it can be requested again later.
   * <p>
   * Only the content object is destroyed here. The tiles the graft added are children of
   * this content's tile, and the tileset destroys them itself — through
   * <code>destroySubtree</code> when this tile is expired for a switch, and through its own
   * tile-tree walk when it is destroyed. Destroying them here would destroy them twice.
   * </p>
   *
   * @private
   */
  _releaseGraft() {
    const index = this._graftedIndex;
    if (index < 0) {
      return;
    }

    const content = this._graftedContent;
    if (defined(content) && defined(content.destroy)) {
      content.destroy();
    }

    this._contents[index].content = undefined;
    this._innerContentStates[index] = Cesium3DTileContentState.UNLOADED;
    this._graftedContent = undefined;
    this._graftedRoot = undefined;
    this._graftedIndex = -1;
  }

  /**
   * Mark this tile as needing to (re)load its epoch.
   * <p>
   * <code>EXPIRED</code> is the state Cesium uses for "this content must be fetched again",
   * and it is the only one that works here: once an epoch has been grafted the tile's
   * <code>hasRenderableContent</code> is false, so
   * {@link Cesium3DTilesetTraversal#loadTile} would ignore an <code>UNLOADED</code> tile
   * and the epoch would never load. Expiring also stops the outgoing epoch from being
   * rendered in the very next frame, because <code>canTraverse</code> refuses to descend
   * into an expired external tileset, and it makes the tileset destroy the outgoing
   * subtree when it re-requests this tile.
   * </p>
   * <p>
   * <code>_expiredContent</code> is deliberately left unset: it would make the tile render
   * (and keep <code>contentAvailable</code> true) while the new epoch loads, and would stop
   * this content's own <code>update</code> from running.
   * </p>
   *
   * @private
   */
  _expireForSwitch() {
    this._tile._contentState = Cesium3DTileContentState.EXPIRED;
  }

  /**
   * The index of the epoch whose request is currently in flight, or <code>-1</code>.
   *
   * @returns {number} The loading epoch's index, or -1.
   * @private
   */
  _loadingIndex() {
    const states = this._innerContentStates;
    for (let i = 0; i < states.length; ++i) {
      if (states[i] === Cesium3DTileContentState.LOADING) {
        return i;
      }
    }
    return -1;
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

    const content = this._graftedContent;
    if (defined(content)) {
      // A no-op for an external tileset content, but the interface expects it: the epoch
      // is drawn by the grafted tiles, which the traversal updates on their own.
      content.update(tileset, frameState);
    }

    if (this._graftedIndex >= 0) {
      // The resident epoch is no longer the active one (or the active one is absent at this
      // tile): expire so the outgoing subtree stops being traversed and, if there is an
      // epoch to show here, the new one is requested. Only from a settled tile — an
      // in-flight load is handled below.
      if (this._graftedIndex !== activeIndex && this._tile.contentReady) {
        this._expireForSwitch();
      }
    } else {
      const loadingIndex = this._loadingIndex();
      if (loadingIndex >= 0) {
        // A load for a now-stale epoch is still in flight: cancel it and expire, so the
        // request slot goes to the epoch the user actually selected.
        if (loadingIndex !== activeIndex) {
          this.cancelRequests();
          this._expireForSwitch();
        }
      } else if (
        activeIndex >= 0 &&
        this._innerContentStates[activeIndex] ===
          Cesium3DTileContentState.UNLOADED &&
        this._tile.contentReady
      ) {
        // Nothing resident, nothing in flight, yet this tile does carry the active epoch.
        // Reached after switching away to an epoch that is absent here (which leaves the
        // tile settled with no graft) and after a canceled reload, so the tile must be
        // expired again or it would never request anything else.
        this._expireForSwitch();
      }
    }

    if (!this._initialReady) {
      if (activeIndex < 0 || this._graftedIndex === activeIndex) {
        this._initialReady = true;
      }
    }
  }

  /**
   * Part of the {@link Cesium3DTileContent} interface. The active epoch's surface belongs
   * to the grafted sub-tileset's tiles, which are picked directly.
   *
   * @param {Ray} ray The ray to test for intersection.
   * @param {FrameState} frameState The frame state.
   * @param {Cartesian3|undefined} [result] The intersection or <code>undefined</code> if none was found.
   * @returns {Cartesian3|undefined} Always <code>undefined</code>.
   * @private
   */
  pick(ray, frameState, result) {
    return undefined;
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    // Invalidate any in-flight load so a late payload is not grafted onto a destroyed
    // tile, and reconcile the pending-request statistics.
    this.cancelRequests();

    // Releases the grafted content object but not the grafted tiles, which the tileset
    // destroys through its own tile-tree walk.
    this._releaseGraft();

    return destroyObject(this);
  }
}

function updatePendingRequests(mtContent, deltaRequestCount) {
  mtContent._requestsInFlight += deltaRequestCount;
  mtContent.tileset.statistics.numberOfPendingRequests += deltaRequestCount;
}

/**
 * Check if the inner-content request can be scheduled this frame.
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
 * Request one epoch's sub-tileset. The caller must have checked
 * {@link canScheduleRequest} first.
 *
 * @returns {Promise<Cesium3DTileContent|undefined>|undefined} A promise resolving to the created content, to undefined if the request was canceled, or undefined synchronously if it could not be scheduled.
 * @private
 */
function requestInnerContent(mtContent, index, originalContentState) {
  const originalCancelCount = mtContent._cancelCount;

  // It is important to clone here: fetchArrayBuffer() uses throttling, but other
  // uses of the resource do not.
  const contentResource = mtContent._innerContentResources[index].clone();
  const tile = mtContent.tile;

  // Always create a new request. If the tile gets canceled, this avoids getting
  // stuck in the canceled state.
  const priorityFunction = function () {
    return tile._priority;
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
 * out or the tile went out of view). Returns the epoch to UNLOADED so it can retry, and
 * puts the tile back into a state the traversal will re-request from — otherwise a
 * canceled load leaves the tile stuck LOADING with nobody to revive it.
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
    // The initial load was canceled; let the tile retry from where it was.
    mtContent._tile._contentState = originalContentState;
    return;
  }

  // A reload after a switch was canceled. The tile is past its initial load, so its
  // hasRenderableContent is false and only EXPIRED gets it re-requested (see
  // MTTilesetContent#_expireForSwitch).
  mtContent._expireForSwitch();
}

/**
 * Create one epoch's content and graft its sub-tileset into the tile tree.
 * <p>
 * The payload must be an external tileset: this content type is only used for the
 * {@link MTLayout#REFERENCED_TILESETS} layout, so a tile payload here means the declared
 * layout and the actual data disagree, which fails the tile loudly instead of rendering
 * something arbitrary.
 * </p>
 *
 * @private
 */
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
    const key = mtContent._contents[index].key;

    if (preprocessed.contentType !== Cesium3DTileContentType.EXTERNAL_TILESET) {
      throw new RuntimeError(
        `Expected an external tileset for timestamp "${key}" of a "${MTLayout.REFERENCED_TILESETS}" multi-temporal tileset, but ${resource.url} is "${preprocessed.contentType}" content.`,
      );
    }

    // Canceled while fetching completed (tile canceled/destroyed); do not graft.
    if (originalCancelCount < mtContent._cancelCount || tile.isDestroyed()) {
      return undefined;
    }

    // Mirror the stock single-content external-tileset path: the host tile draws nothing
    // itself, the grafted sub-tileset's tiles do.
    tile.hasTilesetContent = true;
    tile.hasRenderableContent = false;

    // Tileset3DTileContent.fromJson grafts the sub-tileset's root onto tile.children
    // synchronously, so the tail of the children array is that root.
    const childCountBefore = tile.children.length;
    const contentFactory = Cesium3DTileContentFactory[preprocessed.contentType];
    const content = await Promise.resolve(
      contentFactory(tileset, tile, resource, preprocessed.jsonPayload),
    );

    const graftedRoots = tile.children.slice(childCountBefore);
    //>>includeStart('debug', pragmas.debug);
    if (graftedRoots.length !== 1) {
      throw new DeveloperError(
        `Expected the external tileset for timestamp "${key}" to graft exactly one root tile, got ${graftedRoots.length}.`,
      );
    }
    //>>includeEnd('debug');

    const contentHeader = mtContent._innerContentHeaders[index].content;
    content.metadata = findContentMetadata(tileset, contentHeader);

    const groupMetadata = findGroupMetadata(tileset, contentHeader);
    if (defined(groupMetadata)) {
      content.group = new Cesium3DContentGroup({
        metadata: groupMetadata,
      });
    }

    mtContent._contents[index].content = content;
    mtContent._innerContentStates[index] = Cesium3DTileContentState.READY;
    mtContent._graftedContent = content;
    mtContent._graftedRoot = graftedRoots[0];
    mtContent._graftedIndex = index;

    // Forwarded for parity; the grafted tiles are styled by the tileset's style engine.
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

export default MTTilesetContent;
