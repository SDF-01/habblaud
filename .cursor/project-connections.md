# Project connections

- GitHub remote: `https://github.com/SDF-01/habblaud.git` (fork of `marmottajr/habblaud`)
- Default branch: `main`
- Deployment provider: none (local Habblaud server on `http://localhost:4747`)
- Production URL: n/a (local-only office UI)
- Preview URL rules: n/a
- Linked services: Cursor local plugin at `~/.cursor/plugins/local/habblaud`
- Protected files: `.env`, `~/.habblaud/*` secrets, account credentials
- Project specific deploy behavior: Habblaud runs locally; use `npm run cursor:install` and `npm start` / Windows Startup shortcut, or `npm run desktop:build` for the Rust/Tauri `.exe`. Do not treat preview URLs as production.
