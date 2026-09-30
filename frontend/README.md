# Frontend — Media Approval Dashboard

React + TypeScript + Vite SPA for the Media Approval Dashboard. Talks to the
backend (Express, `:3000`) through the Vite dev proxy (`localhost:5173`).

```bash
npm install
npm run dev      # dev server on :5173, proxies /api to :3000
npm run build    # production build → dist/
```

The app is **arr-free**: Prowlarr search, Seerr request sync, TMDB Discover and
native franchise metadata, qBittorrent downloads. Sonarr/Radarr are optional
legacy and never required by the UI.

## Layout

- `src/App.tsx` — router + nav + ToastProvider
- `src/api.ts` — Axios client + all API functions
- `src/pages/` — Dashboard, RequestDetail, FranchiseDetail (legacy sonarr-id
  grouping), NativeFranchise (TMDB-backed), Settings, DatabaseViewer
- `src/components/` — TorrentPanel, WorkspacePickerModal, WorkspaceManagerModal,
  ScriptDropdown, DiscoverModal

## Notes

- Internal identifiers (`sonarrId` route params, `radarr_quality`, `sonarr_id`
  fields) are legacy DB column names and are cosmetic — they do not imply a
  Sonarr/Radarr dependency.
- Formatting/lint: `npm run lint` (oxlint). Type-check: `npm run build`
  (runs `tsc -b` before `vite build`).