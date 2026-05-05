#!/bin/bash
set -euo pipefail

CONFIG_FILE="config.local.json"
REGISTRY="https://npm.pkg.github.com"

########################################
# CLEANUP
########################################

cleanup() {
  echo "Restoring package.json files..."

  node <<'EOF' || true
const fs = require("fs");

function restore(file) {
  if (!fs.existsSync(file)) return;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (pkg._originalName) {
    pkg.name = pkg._originalName;
    delete pkg._originalName;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
}

restore("package.json");
restore("packages/engine/package.json");
restore("packages/widgets/package.json");
EOF

  rm -f .npmrc
}
trap cleanup EXIT

########################################
# LOAD CONFIG
########################################

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: Missing $CONFIG_FILE"
  exit 1
fi

GH_USER=$(jq -r '.ghUser' "$CONFIG_FILE")
GH_TOKEN=$(jq -r '.ghToken' "$CONFIG_FILE")
GH_ORG=$(jq -r '.ghOrg' "$CONFIG_FILE")
PKG_NAME=$(jq -r '.packageName' "$CONFIG_FILE")
REWRITE_SCOPE=$(jq -r '.rewriteScope // false' "$CONFIG_FILE")

########################################
# NPM AUTH
########################################

echo "Configuring npm auth..."

cat <<EOF > .npmrc
@${GH_ORG}:registry=${REGISTRY}
//npm.pkg.github.com/:_authToken=${GH_TOKEN}
EOF

########################################
# INSTALL FIRST (CRITICAL)
########################################

echo "Installing dependencies..."
npm install

########################################
# REWRITE PACKAGE NAMES
########################################

rewrite_name() {
  local file="$1"
  local new_name="$2"

  node <<EOF
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("$file", "utf8"));
pkg._originalName = pkg.name;
pkg.name = "$new_name";
fs.writeFileSync("$file", JSON.stringify(pkg, null, 2));
EOF
}

if [[ "$REWRITE_SCOPE" == "true" ]]; then
  echo "Rewriting workspace scope → @$GH_ORG"

  rewrite_name "packages/engine/package.json" "@$GH_ORG/engine"
  rewrite_name "packages/widgets/package.json" "@$GH_ORG/widgets"
fi

ROOT_NAME=$(node -p "require('./package.json').name")
if [[ "$ROOT_NAME" != "$PKG_NAME" ]]; then
  echo "Rewriting root package → $PKG_NAME"
  rewrite_name "package.json" "$PKG_NAME"
fi

########################################
# BUILD
########################################

echo "Building Cesium..."
npx gulp buildRelease

########################################
# VERSION MANAGEMENT (PER PACKAGE)
########################################

get_latest_version() {
  npm view "$1" version --registry=$REGISTRY 2>/dev/null || echo ""
}

increment_patch() {
  node -e "const semver=require('semver');console.log(process.argv[1]?semver.inc(process.argv[1],'patch'):'1.0.0')" "$1"
}

PKG_ENGINE="@$GH_ORG/engine"
PKG_WIDGETS="@$GH_ORG/widgets"
PKG_ROOT="$PKG_NAME"

V_ENGINE=$(get_latest_version "$PKG_ENGINE")
V_WIDGETS=$(get_latest_version "$PKG_WIDGETS")
V_ROOT=$(get_latest_version "$PKG_ROOT")

NEW_ENGINE=$(increment_patch "$V_ENGINE")
NEW_WIDGETS=$(increment_patch "$V_WIDGETS")
NEW_ROOT=$(increment_patch "$V_ROOT")

echo "Versions:"
echo "  engine  → $NEW_ENGINE"
echo "  widgets → $NEW_WIDGETS"
echo "  root    → $NEW_ROOT"

########################################
# APPLY VERSIONS + REWRITE DEPENDENCIES
########################################

node <<EOF
const fs = require("fs");

function update(file, version, deps = {}, rewriteScope = false) {
  if (!fs.existsSync(file)) return;

  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;

  function rewriteDeps(obj) {
    if (!obj) return;

    // rewrite scope
    for (const key of Object.keys(obj)) {
      if (rewriteScope && key.startsWith("@cesium/")) {
        const newKey = key.replace("@cesium/", "@${GH_ORG}/");
        obj[newKey] = obj[key];
        delete obj[key];
      }
    }

    // update versions
    for (const key of Object.keys(obj)) {
      if (deps[key]) {
        obj[key] = "^" + deps[key];
      }
    }
  }

  rewriteDeps(pkg.dependencies);
  rewriteDeps(pkg.devDependencies);
  rewriteDeps(pkg.peerDependencies);

  if (pkg.overrides) {
    for (const key of Object.keys(pkg.overrides)) {
      if (rewriteScope && key.startsWith("@cesium/")) {
        const newKey = key.replace("@cesium/", "@${GH_ORG}/");
        pkg.overrides[newKey] = pkg.overrides[key];
        delete pkg.overrides[key];
      }
    }
  }

  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
}

// engine
update("packages/engine/package.json", "$NEW_ENGINE", {}, false);

// widgets → depends on engine
update("packages/widgets/package.json", "$NEW_WIDGETS", {
  "@${GH_ORG}/engine": "$NEW_ENGINE"
}, true);

// root → depends on both
update("package.json", "$NEW_ROOT", {
  "@${GH_ORG}/engine": "$NEW_ENGINE",
  "@${GH_ORG}/widgets": "$NEW_WIDGETS"
}, true);

EOF

########################################
# VALIDATE BUILD
########################################

echo "Validating build..."

[[ -d "Build" ]] || { echo "ERROR: Build missing"; exit 1; }
[[ -f "Source/Cesium.js" ]] || { echo "ERROR: Missing Source/Cesium.js"; exit 1; }

########################################
# PUBLISH
########################################

publish_pkg() {
  local dir="$1"
  local name="$2"

  pushd "$dir" >/dev/null

  for i in 1 2 3; do
    echo "Publishing $name (attempt $i)..."

    if npm publish --registry=$REGISTRY; then
      popd >/dev/null
      return
    fi

    echo "Retrying..."
    sleep 1
  done

  echo "ERROR: Failed publishing $name"
  exit 1
}

echo "Publishing packages..."

publish_pkg "packages/engine" "@$GH_ORG/engine"
publish_pkg "packages/widgets" "@$GH_ORG/widgets"
publish_pkg "." "$PKG_NAME"

########################################
# DONE
########################################

echo "----------------------------------------"
echo "Published:"
echo "  $PKG_NAME@$NEW_ROOT"
echo "  @$GH_ORG/engine@$NEW_ENGINE"
echo "  @$GH_ORG/widgets@$NEW_WIDGETS"
echo "----------------------------------------"