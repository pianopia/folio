# folio

A Google Drive connected artwork library for Web, iOS, and Android.

- Production Web: https://folio-biti2v34ya-an.a.run.app
- API health: https://folio-biti2v34ya-an.a.run.app/api/health
- Public source: https://github.com/pianopia/folio

- Web: Remix 2 + TypeScript, served as an SPA by the Hono application.
- API: Bun + Hono, with the Web and `/api/*` on one Cloud Run origin.
- Database: a dedicated Turso database through `@libsql/client`.
- Mobile: React Native + Expo SDK 54, using the same API.

## Features

Group and collection organization, search, favorites, artwork editing, Google Drive import, and one-click image copying. Drive browsing uses 512px thumbnails, 1024px detail previews, bounded caches, nearby-image preloading, and previous/next navigation. Copying fetches the original image and writes PNG data to the clipboard.

The current application is a single workspace. Groups organize artworks; they are not separate access-control boundaries. The API requires a workspace token when hosted remotely.

## Local development

Bun 1.2.20 is the validated runtime.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Web: `http://127.0.0.1:5173`. API: `http://127.0.0.1:3001/api/health`.

Leave `TURSO_DATABASE_URL` empty to use a local SQLite file through libSQL. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use a dedicated Turso database. The application creates its tables and seeds the initial sample artwork exactly once, inside a transaction. Production requires Turso and never falls back to an ephemeral local database.

The sample photos are loaded from Unsplash. When the API is unavailable or authentication has not been configured, the Web displays **Demo mode** and keeps demo edits in the browser. Those edits are not synchronized to the API.

## Cloud Run

The root Dockerfile builds the Remix SPA and bundles the Bun/Hono server. The runtime image contains the server, the static assets, and the libSQL runtime dependencies. Static files are public; library and Google Drive APIs require authentication.

Production defaults:

- GCP project: `pianopia`
- Region: `asia-northeast1`
- Cloud Run service / Artifact Registry repository: `folio`
- Runtime service account: `folio-runtime`
- Database: a new Turso database named `folio`

Runtime configuration:

| Variable                                    | Purpose                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| `TURSO_DATABASE_URL`                        | Dedicated Turso database URL                                   |
| `TURSO_AUTH_TOKEN`                          | Database-scoped token, injected from Secret Manager            |
| `API_TOKEN`                                 | Workspace access token, injected from Secret Manager           |
| `TOKEN_ENCRYPTION_KEY`                      | 64-character hexadecimal key for Google OAuth token encryption |
| `WEB_ORIGIN`                                | Exact public Web origin for CORS and redirects                 |
| `API_ORIGIN`                                | Public API origin for Google OAuth callbacks                   |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional until Google Drive OAuth is configured                |

The runtime identity has access only to the application's three secrets:

- `folio-turso-auth-token`
- `folio-api-token`
- `folio-token-encryption-key`

Do not put secret values in source files, Docker build arguments, GitHub, or public build logs. The deployment script references Secret Manager names only. To redeploy after the initial infrastructure setup:

```sh
GCLOUD_ACCOUNT=you@example.com \
PROJECT_ID=pianopia \
TURSO_DATABASE_URL=libsql://YOUR-DEDICATED-DATABASE.turso.io \
./scripts/deploy.sh
```

The script builds an image in Cloud Build, deploys it, and updates the Web/API origins using the actual Cloud Run service URL. Maximum instances default to 3; minimum instances to 0.

To authenticate the Web, open Workspace settings, leave the API URL blank for the same origin, and enter the workspace API token. Saving establishes an HttpOnly session cookie so reloading keeps the connection. Retrieve the workspace token securely with an authorized GCP identity:

```sh
gcloud secrets versions access latest --secret=folio-api-token --project=pianopia
```

`GET /api/health` checks the database and reports `storage: "turso"`. An unauthenticated request to `/api/library` returns 401.

## Google Drive setup

Enable the Google Drive API in a Google Cloud project, configure the consent screen, and create an OAuth client of type **Web application**. Register this exact redirect URI using your deployed origin:

```text
https://YOUR-CLOUD-RUN-ORIGIN/api/drive/callback
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on Cloud Run (use Secret Manager for the secret). Then choose **Google Drive を接続** in the Web.

The application requests `drive.readonly`. It does not change or delete original Drive files. OAuth access/refresh tokens are encrypted with AES-256-GCM before being saved to Turso. The token-encryption key must remain stable across revisions. Disconnecting revokes Google's token and clears the preview caches.

Google OAuth credentials must be configured separately; deploying the service does not create a Google OAuth client or connect a Drive account.

## Mobile

```sh
cd apps/mobile
bun run start
# Xcode or Android SDK required for local simulators:
bun run ios
bun run android
```

Open the project in Expo Go, then set the Cloud Run origin and workspace token in Settings. The token is stored in SecureStore. Local iOS simulators can use `http://localhost:3001`; Android emulators use `http://10.0.2.2:3001`. For physical devices on a LAN, start the API with `HOST=0.0.0.0` and `API_TOKEN` configured, then enter the computer's LAN address.

Google Drive is connected from the Web first. The mobile app then uses that same workspace connection. Store publication and signed app binaries are not included.

## Validation

```sh
bun run check
bun test apps/api
bun run build
cd apps/mobile
bunx expo export --platform all --output-dir /tmp/folio-mobile-export
```

The API tests exercise authentication, session cookies, validation, persistence, thumbnail request deduplication, concurrency limits, expiry recovery, and cache invalidation. Local tests use isolated in-memory libSQL databases. Real Google-account latency requires OAuth setup; the preview tests use a simulated Drive provider.

## API overview

| Method         | Path                                | Purpose                                       |
| -------------- | ----------------------------------- | --------------------------------------------- |
| GET            | `/api/health`                       | Readiness/database check                      |
| POST / DELETE  | `/api/session`                      | Establish/remove an authenticated Web session |
| GET            | `/api/library`                      | Groups and artworks                           |
| POST           | `/api/groups`                       | Create a group                                |
| POST           | `/api/artworks`                     | Add an HTTPS image URL                        |
| PATCH / DELETE | `/api/artworks/:id`                 | Edit/remove a library item                    |
| GET            | `/api/drive/status`                 | Drive configuration/connection status         |
| GET            | `/api/drive/connect`                | Start Google OAuth                            |
| GET            | `/api/drive/callback`               | OAuth callback                                |
| GET            | `/api/drive/files`                  | Paged image/folder list                       |
| POST           | `/api/drive/import`                 | Import selected image references              |
| GET            | `/api/drive/thumbnail/:id?size=512` | Cached preview (1024 also supported)          |
| GET            | `/api/drive/image/:id`              | Original image for copying                    |
| DELETE         | `/api/drive`                        | Disconnect Drive                              |
