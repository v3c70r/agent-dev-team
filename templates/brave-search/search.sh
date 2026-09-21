#!/usr/bin/env bash
# Brave web search → compact text results
# usage: search.sh "<query>" [count]
set -euo pipefail
q="${1:?usage: search.sh \"<query>\" [count]}"
n="${2:-5}"

if [ -z "${BRAVE_API_KEY:-}" ]; then
  echo "ERROR: BRAVE_API_KEY is not set (add it to .env; the PM runner exports it)" >&2
  exit 1
fi

curl -sS --get 'https://api.search.brave.com/res/v1/web/search' \
  --data-urlencode "q=$q" \
  --data-urlencode "count=$n" \
  -H 'Accept: application/json' \
  -H 'Accept-Encoding: gzip' \
  --compressed \
  -H "X-Subscription-Token: ${BRAVE_API_KEY}" \
| node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let j; try { j=JSON.parse(d); } catch(e){ console.error("bad JSON from Brave:", d.slice(0,300)); process.exit(2); }
  const rs=(j.web&&j.web.results)||[];
  if(!rs.length) console.log("(no results)");
  rs.forEach((r,i)=>{
    const desc=(r.description||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    console.log(`${i+1}. ${r.title||""}\n   ${r.url||""}\n   ${desc}\n`);
  });
});'
