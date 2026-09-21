---
name: brave-search
description: Web search and page fetch via the Brave Search API. Use for competitive research, market/product research, finding public data sources, or any web fact lookup.
---

# Brave Search (competitive research toolkit)

Use these scripts with `bash`. The API key is read from the `BRAVE_API_KEY`
environment variable (the PM runner exports it from the repo `.env`).

## 1. Web search

```bash
.agents/skills/brave-search/search.sh "gas price app quebec features" 5
```

Output: one block per result — title / url / description (HTML stripped).

Options to try when a query is too narrow or too broad:
- add `site:` (e.g. `site:apps.apple.com gasbuddy`)
- add a year (`2026`) for freshness
- search in French for Québec-specific sources (`prix essence québec application`)

## 2. Fetch a page as text

```bash
.agents/skills/brave-search/fetch.sh "https://example.com/pricing"
```

Strips scripts/styles/tags and prints readable text (truncated). Some sites
(login walls, heavy JS, bot protection) may return little — in that case fall
back to `search.sh` and cite the description, or try another source.

## 3. Other zero-cost sources for this product

- OSS competitors / similar projects: `gh search repos "fuel price map" --limit 20 --json fullName,description,stargazersCount,updatedAt`
- Québec open data: search via Brave for `données ouvertes essence québec API`, `Régie de l'énergie prix Essence`, `data.gouv.qc.ca carburant`
- App stores: `site:apps.apple.com` / `site:play.google.com` for feature lists & reviews

## Rules

- Always cite the URL of any claim you use in a proposal.
- Prefer 2–3 independent sources over one.
- Never invent numbers or features: if you cannot verify, say so explicitly.
