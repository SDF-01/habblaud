# Habblaud Desktop (Rust / Tauri)

Native Windows desktop shell for Habblaud. The Rust app starts the Habblaud Node server and opens the office UI in a WebView window, then packages as `.exe` / NSIS / MSI.

## Requirements

- Rust stable (`rustc`, `cargo`)
- Node.js 22.12+ on PATH (the desktop shell launches `dist/server/index.js`)
- WebView2 (ships with modern Windows)

## Develop

From the repo root:

```bash
npm install
npm run build
npm --prefix desktop install
npm run desktop:dev
```

## Build Windows installers / exe

```bash
npm run desktop:build
```

Outputs land in:

- `desktop/src-tauri/target/release/habblaud-desktop.exe`
- `desktop/src-tauri/target/release/bundle/nsis/`
- `desktop/src-tauri/target/release/bundle/msi/`

## How it works

1. `desktop-prepare` builds Habblaud and copies `dist/` into Tauri resources
2. The Rust app finds Node, starts Habblaud on `127.0.0.1:4747` if needed
3. After `/api/health` is ready, the window navigates to the office UI
4. Closing the app stops the server process it started

Optional env:

- `HABBLAUD_ROOT` – Habblaud repo/resources root
- `HABBLAUD_PORT` – port (default `4747`)
- `HABBLAUD_NODE` – absolute path to `node.exe`
