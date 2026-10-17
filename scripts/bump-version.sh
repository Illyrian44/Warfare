#!/bin/sh
# Erhöht die Versionsnummer an allen Skript- und CSS-Verweisen, damit Browser
# nach einem Update keine alten Dateien aus dem Cache verwenden.
set -e
cd "$(dirname "$0")/.."
v=$(($(cat VERSION 2>/dev/null || echo 0) + 1))
echo "$v" > VERSION
sed -i -E "s#(from '\./[a-z]+\.js)(\?v=[0-9]+)?'#\1?v=$v'#" js/*.js
sed -i -E "s#(js/main\.js|css/style\.css)(\?v=[0-9]+)?\"#\1?v=$v\"#" index.html
sed -i -E "s#(id=\"version\">)[^<]*#\1Version $v#" index.html
echo "Version $v"
