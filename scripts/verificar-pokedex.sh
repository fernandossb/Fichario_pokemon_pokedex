#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/app/src/main/assets/www"
APP="$WWW/app.js"
MANIFEST="$ROOT/app/src/main/AndroidManifest.xml"
[ -f "$WWW/data/pokedex.json" ]
[ -f "$APP" ]
grep -qi "pokedex" "$APP"
grep -q "startOwnedPriceUpdate" "$APP"
grep -q "requestLigaPokemon" "$ROOT/app/src/main/java/br/com/fichariopokemon/pokedex/MainActivity.java"
grep -q "imageUrl" "$APP"
grep -q 'android:allowBackup="false"' "$MANIFEST"
SPRITES=$(find "$WWW/sprites" -maxdepth 1 -name '*.png' | wc -l | tr -d ' ')
[ "$SPRITES" -ge 1025 ]
python3 - "$WWW/data/collection-seed.json" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding='utf-8'))
assert d.get('entries') == [], 'O APK contém coleção pessoal embutida.'
assert int(d.get('totalCopies',0)) == 0
PY
echo "Validação concluída: Pokédex ($SPRITES sprites), preços, fotos e instalação limpa."
