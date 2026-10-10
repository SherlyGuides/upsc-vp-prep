#!/bin/zsh
# Copies the app + question bank into ../docs (served by GitHub Pages) and records the laptop's current tunnel URL.
# Usage: scripts/publish-pages.sh [tunnel-url]
cd "$(dirname "$0")/.."
D=../docs
mkdir -p $D/data
cp public/* $D/
V=$(date +%s); sed -i '' -e "s|href=\"app.css[^\"]*\"|href=\"app.css?v=$V\"|" -e "s|src=\"app.js[^\"]*\"|src=\"app.js?v=$V\"|" $D/index.html
cp data/*.json $D/data/ 2>/dev/null
[ -d data/packs ] && mkdir -p $D/data/packs && cp data/packs/*.json data/packs/*.pdf $D/data/packs/ 2>/dev/null
node -e '
const fs=require("fs"),p=require("path");const dir="data";
const units=fs.readdirSync(dir).filter(f=>f.endsWith(".json")&&f!=="units.json").map(f=>JSON.parse(fs.readFileSync(p.join(dir,f)))).filter(u=>u.id&&u.notes_md).map(u=>{return{id:u.id,available:true,title_en:u.title_en,title_hi:u.title_hi||"",mcq_count:(u.mcqs||[]).length,words:String(u.notes_md||"").split(/\s+/).length}});
fs.writeFileSync("../docs/data/units.json",JSON.stringify({units}));'
[ -n "$1" ] && printf '{"api":"%s","updated":"%s"}\n' "$1" "$(date -u +%FT%TZ)" > $D/backend.json
touch $D/.nojekyll
cd .. && git add docs && git -c user.name=SherlyGuides -c user.email=support@thinkpro.academy commit -qm "Update study app${1:+ (laptop online)}" && git push -q && echo "Pages updated"
