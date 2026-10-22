# QuizRoom — 50-player live quiz website

A mobile-friendly, host-controlled multiplayer trivia application. Host creates 1–30 questions; up to 50 guests join by nickname and 6-digit PIN; timed questions, automatic points, live results and final leaderboard. Players don't need accounts.

## Deployment (GitHub Pages + Supabase)

1. Create a free project at https://supabase.com and open **SQL Editor**.
2. Paste the complete content of `setup.sql` and run it **once**. It creates the tables, RPC endpoints, access controls, and Realtime publication. Do not re-run it while games are active.
3. In Supabase **Project Settings → API**, copy the **Project URL** and **anon/publishable key** into `config.js`. **Never** use the service-role/secret key in browser code.
4. Create a **public** GitHub repository (for example `quiz-room`). Upload `index.html`, `styles.css`, `app.js`, `config.js`, `setup.sql` and this README to the repository root.
5. Go to repository **Settings → Pages**. Under **Build and deployment**, select **Deploy from a branch**, branch **main**, folder **/(root)**, and save.
6. Open `https://YOUR-USERNAME.github.io/quiz-room/`. Share that URL with your players. Everyone opens the same website; the host creates the PIN.
7. To create another game, use **Host a quiz**. Keep the host page open for automated phase changes, and use different browsers/devices to test multiplayer before an event.

### Important deployment facts
- GitHub Pages hosts the frontend only. Supabase powers multiplayer; Pages by itself cannot synchronize players.
- `git.io` is retired for new short links; the correct GitHub site is `github.io`.
- GitHub Pages uses HTTPS. Configure Supabase network and allowed origins as needed.
- Designed for **50 maximum participants per game**, enforced atomically by a database lock. The host is separate.
- Supabase free tier currently lists **200 peak realtime connections** and **100 realtime messages/second**. These are provider limits, not a guarantee of 50-player event performance.
- Scores and correctness are calculated and validated on the database, never trusted from browser-supplied scores.
- The host secret is stored in localStorage on the hosting browser. Clearing browser data or switching devices loses host control of that game. There is intentionally no permanent account system yet.
- A newly created game persists in Supabase; there is no automatic deletion policy. Set a retention policy before public, long-term usage.
- This is an MVP, **not a load-tested production system**. Public users can create games and consume Supabase resources. Add authentication, abuse controls, rate limiting, monitoring and an admin cleanup process before publicly advertising the site.

### Test checklist
1. Open the site and create a two-question quiz in one browser.
2. Open the same URL in incognito or on another phone and join using the PIN.
3. Verify that the player appears in the lobby and can answer.
4. Check automatic timer, results, leaderboard, and final standings.
5. Test duplicate nicknames, bad PINs and a 51st join attempt. For an event, test real Wi-Fi and mobile connections with multiple devices.

### Project files
- `index.html`: HTML entry point
- `styles.css`: responsive visual design
- `app.js`: reusable UI helpers, host/player flow, Realtime subscriptions
- `config.js`: public Supabase configuration (fill yourself)
- `setup.sql`: PostgreSQL tables, access controls and security-definer RPCs
