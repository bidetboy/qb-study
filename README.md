# QB Study

Quiz bowl practice reader plus Anki-style cloze flashcards, built on the [QB Reader API](https://www.qbreader.org/api-docs).

## Hosting

The site in `docs/` is fully static and deploys with GitHub Pages (Settings → Pages → Deploy from branch → `main` / `/docs`). Every push to `main` updates the live site. On the hosted site, data is stored in the browser (IndexedDB); use **Settings & data → Export** for backups.

## Local development

```bash
node server.js
```

Then open http://localhost:5178. No dependencies; requires Node 18+. Locally, data is saved to `data/db.json` (daily backups in `data/backups/`).

## Features

- **Decks**: create decks, write cloze notes (`{{c1::answer}}`, `{{c1::answer::hint}}`), study with an SM-2 scheduler (Again/Hard/Good/Easy, undo, daily new-card limit).
- **Reader**: word-by-word tossups with buzzing, power/neg scoring, answer judging via `/check-answer` (directed prompts, offline fallback, override); bonuses part by part; category/difficulty/year filters.
- **Make cards** from any QB Reader question: one card per clue, whole question, per bonus part, or cloze it yourself.
- **Search** (`/query`) with all options and pagination; open any question by ID (`/tossup`, `/bonus`).
- **Packets**: browse all sets (`/set-list`), packet counts (`/num-packets`), read or play any packet (`/packet`).
- **Frequency lists** (`/frequency-list`): most common answers per category/subcategory.
- **Saved questions** with tags, notes, filters, and practice mode.
- **Stats**: your own per-category history plus QB Reader global stats (`/question-stats/*`).
