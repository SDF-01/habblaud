# Habblaud for Cursor

Cursor plugin that keeps the Habblaud virtual office running and shows Cursor agents live.

## What it does

- Installs as a local Cursor plugin so every Cursor window can use it
- Starts Habblaud on `http://localhost:4747` if it is not already up
- Forwards session and tool events into the office
- Adds an always-on rule, skill, and `/habblaud` command

## Install

From the Habblaud repository:

```bash
npm install
npm run build
npm run cursor:install
```

Then reload Cursor (**Developer: Reload Window**).

Open http://localhost:4747

## Uninstall

```bash
npm run cursor:uninstall
```

## Config

`~/.habblaud/cursor-hook.json`:

```json
{
  "port": 4747,
  "rootDir": "C:\\path\\to\\habblaud"
}
```

`HABBLAUD_CURSOR=0` disables Cursor discovery in the Habblaud server.
