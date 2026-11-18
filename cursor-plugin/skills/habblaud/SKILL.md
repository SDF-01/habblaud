---
name: habblaud
description: Open or check the Habblaud virtual office for Cursor agents at http://localhost:4747. Use when the user asks about Habblaud, the agent office, who is working, or Cursor agent activity visualization.
---

# Habblaud

Habblaud is the pixel-art virtual office for agent sessions.

## Quick checks

1. Open http://localhost:4747
2. Confirm Cursor agents show a **CURSOR** badge
3. If the page does not load, from the Habblaud repo run:

```bash
npm run cursor:install
npm start
```

## Notes

- Sessions are discovered from `~/.cursor/projects/*/agent-transcripts`
- Plugin hooks keep the local Habblaud server running and push live status
- Nothing leaves the machine; Habblaud talks only to localhost
