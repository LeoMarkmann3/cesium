/**
 * The layout of a multi-temporal tileset, declared by the <code>layout</code> field of the
 * multi-temporal tileset extension and resolved into
 * {@link Cesium3DTileset#resolvedMTLayout}. The layout decides how a timestamp's content is
 * reached, and therefore which content type a keyed tile is routed to.
 *
 * @enum {string}
 *
 * @private
 * @experimental This feature is using part of the 3D Tiles spec that is not final and is subject to change without Cesium's standard deprecation policy.
 */
const MTLayout = {
  /**
   * One shared tile hierarchy in which every tile carries one content per timestamp
   * present there. The timestamps share the tile's bounding volume, transform, geometric
   * error and refinement.
   *
   * @type {string}
   * @constant
   */
  SHARED_TREE: "shared_tree",

  /**
   * One standalone tileset per timestamp, referenced by key as an external tileset from a
   * selector tileset. Each timestamp has its own hierarchy, bounding volumes and geometric
   * error ladder, and is loadable on its own.
   *
   * @type {string}
   * @constant
   */
  REFERENCED_TILESETS: "referenced_tilesets",
};

export default Object.freeze(MTLayout);
