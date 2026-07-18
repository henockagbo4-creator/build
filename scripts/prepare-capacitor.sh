#!/bin/bash
# prepare-capacitor.sh
# Usage: prepare-capacitor.sh <dossier_source> <nom_app> <package_id>
#
# Détecte si le dossier source est déjà un projet Capacitor,
# ou juste un site web brut (HTML/CSS/JS) à empaqueter.

set -e

SRC_DIR="$1"
APP_NAME="$2"
PACKAGE_ID="$3"
DEST_DIR="capacitor-project"

echo "== Préparation du projet Capacitor =="
echo "Source: $SRC_DIR"
echo "Nom app: $APP_NAME"
echo "Package: $PACKAGE_ID"

# Cas 1 : le zip contient déjà un capacitor.config.json/ts -> projet préexistant
if find "$SRC_DIR" -iname "capacitor.config.*" | grep -q .; then
  echo "Projet Capacitor existant détecté."
  mv "$SRC_DIR" "$DEST_DIR"
  cd "$DEST_DIR"
  npm install
  npx cap sync android
  exit 0
fi

# Cas 2 : site web brut (index.html à la racine ou dans un sous-dossier)
echo "Aucun projet Capacitor détecté — génération automatique autour du site web."

mkdir -p "$DEST_DIR"
cd "$DEST_DIR"

npm init -y >/dev/null
npm install @capacitor/core @capacitor/cli @capacitor/android >/dev/null

# Dossier www = contenu du zip utilisateur (copie brute)
mkdir -p www
cp -r "../$SRC_DIR"/* www/ 2>/dev/null || true

# Si index.html n'est pas à la racine du zip, on le cherche et on aplati
if [ ! -f "www/index.html" ]; then
  FOUND_INDEX=$(find www -iname "index.html" | head -n 1)
  if [ -n "$FOUND_INDEX" ]; then
    SUBDIR=$(dirname "$FOUND_INDEX")
    cp -r "$SUBDIR"/* www/
  else
    echo "ERREUR: aucun index.html trouvé dans le zip." >&2
    exit 1
  fi
fi

# Config Capacitor minimale
cat > capacitor.config.json << EOF
{
  "appId": "$PACKAGE_ID",
  "appName": "$APP_NAME",
  "webDir": "www"
}
EOF

npx cap add android
npx cap sync android

echo "== Projet Capacitor prêt dans $DEST_DIR/android =="
