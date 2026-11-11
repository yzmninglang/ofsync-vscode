# Ofsync for VS Code

A standalone VS Code extension that connects to the local `ofsync` daemon. This repository is deliberately independent: it does **not** import, modify, or bundle the existing `ofsync` source code.

## Included workflow

- Connection status in the VS Code status bar and the **Ofsync** activity-bar view.
- **Sync Now** and **Compile Remote Project** commands.
- Shortcuts: `Ctrl+Alt+B` / `Cmd+Alt+B` compiles, `Ctrl+Alt+J` / `Cmd+Alt+J` resolves the active LaTeX cursor to a PDF location, and `Ctrl+Alt+P` / `Cmd+Alt+P` opens the PDF preview.
- A PDF.js preview opened beside the LaTeX editor (VS Code handles the editor/PDF split).
- Source → PDF SyncTeX request for the current LaTeX cursor.
- Double-click PDF content to convert the clicked page position into SyncTeX `page`/`h`/`v` coordinates, then open the mapped local source line after source-path validation.

## Requirements

1. Start the local `ofsync` daemon.
2. Open the synced local LaTeX project as a VS Code workspace.
3. Compile the remote project once. A current ofsync daemon automatically exposes the remote Build ID for both SyncTeX endpoints. The legacy ofsync.buildId setting remains available only as a fallback for older daemons.

The extension defaults to `http://127.0.0.1:43821`. Change `ofsync.serverUrl` when the daemon uses another port. Use `ofsync.projectRoot` when the VS Code workspace is not the project root. With the Manager API, the extension automatically matches this directory to the mapping's `id` and uses the per-project routes; the mapping must already exist in `manager.json`.

## Development

```powershell
npm install
npm run compile
npm run lint
```

Open this folder in VS Code and press `F5` to start an Extension Development Host.

## Build ID handling

After a successful remote compile, current ofsync daemons publish the Build ID associated with the cached PDF through the status API. The extension uses that value automatically for both SyncTeX directions, including compiles started by the daemon watch process. The ofsync.buildId workspace setting is retained only as a fallback for older daemons.

## Current daemon protocol

The extension supports both the Manager API and the legacy single-project API. When `/api/manage/mappings` is available, it matches `ofsync.projectRoot` and calls:

- `GET /api/manage/mappings`
- `GET /api/projects/:pid/status`
- `POST /api/projects/:pid/sync` and `POST /api/projects/:pid/compile`
- `GET /api/projects/:pid/pdf`
- `POST /api/projects/:pid/synctex/code`
- `POST /api/projects/:pid/synctex/pdf`

If the Manager API is unavailable, it falls back to the legacy routes:

- `GET /api/health` and `GET /api/status`
- `POST /api/sync` and `POST /api/compile`
- `GET /api/pdf`
- `POST /api/synctex/code`
- `POST /api/synctex/pdf`

If the Manager API is running but no mapping directory matches the configured project root, the status bar shows **project not mapped** instead of silently calling a different project.

The extension renders the daemon's PDF stream locally with bundled PDF.js, so browser-native PDF viewer limitations do not block PDF → source double-click navigation. SyncTeX uses the Build ID that ofsync associates with the currently cached PDF; it falls back to the optional ofsync.buildId setting for older daemons.

With a current daemon, the Build ID is supplied automatically and is cleared whenever ofsync receives a replacement PDF without a recognizable Build ID. This prevents SyncTeX from using a stale version against a newer cached PDF.
