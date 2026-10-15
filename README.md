# QB Study

Quiz bowl practice reader plus Anki-style cloze flashcards, built on the [QB Reader API](https://www.qbreader.org/api-docs).

## Hosting

The site in `docs/` is fully static and deploys with GitHub Pages (Settings → Pages → Deploy from branch → `main` / `/docs`). Every push to `main` updates the live site. When accounts are configured, each user's progress is saved to Supabase and syncs across devices; otherwise data is stored in the browser (IndexedDB).

## Accounts & sync (Supabase)

Logins and cross-device sync use a free [Supabase](https://supabase.com) project. Until `docs/js/config.js` is filled in, the app runs without accounts.

1. Create a project at supabase.com (free tier).
2. **SQL Editor → New query**: paste `supabase/schema.sql` and run it. This creates one private row of app data per user, protected by row-level security.
3. **Authentication → Sign In / Providers → Email**: turn **off** “Confirm email”. (Usernames are mapped to placeholder addresses that are never emailed.)
4. **Project Settings → API**: copy the Project URL and the `anon` public key into `docs/js/config.js`, then commit and push.

**Forgot password:** there is no email, so each account gets a one-time recovery code at sign-up (stored only as a bcrypt hash). “Forgot password?” on the login screen takes username + recovery code + new password, then issues a fresh code. Users can change their password or make a new code under **Decks → Settings & data → Account**.

Note: free Supabase projects pause after a week with no activity; restore it from the dashboard if that happens.

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
