#!/usr/bin/env bash
# Fetch a URL and print readable text (tags/scripts stripped)
# usage: fetch.sh <url> [max_chars]
set -euo pipefail
url="${1:?usage: fetch.sh <url> [max_chars]}"
max="${2:-6000}"

curl -sSL --max-time 25 --compressed \
  -A 'Mozilla/5.0 (compatible; qc-gas-research/1.0)' \
  "$url" \
| node -e '
const max=parseInt(process.argv[1]||"6000",10);
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let t=d
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi," ")
    .replace(/<!--[\s\S]*?-->/g," ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi,"\n")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"\x27").replace(/&quot;/g,"\"")
    .replace(/[ \t]+/g," ")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
  console.log(t.slice(0,max));
  if(t.length>max) console.log(`\n…[truncated ${t.length-max} chars]`);
});' "$max"
