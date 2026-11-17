# CloudAttend web dashboard

React + Vite + TypeScript single-page app for CloudAttend. Teachers manage classes,
enroll students, upload classroom photos and review attendance. Students see their own
attendance. It talks to the API described in [`../docs/api.md`](../docs/api.md) and signs
in with Amazon Cognito through `aws-amplify` (Auth only).

## Prerequisites

- Node.js 20+ and npm
- For real data: a deployed `CloudAttendStack` (see `../infra`) and the AWS CLI with
  credentials for that account

## Run locally

```bash
cd web
npm install
../scripts/write-local-config.sh   # writes public/config.json from the stack outputs
npm run dev                        # http://localhost:5173
```

The dev server is pinned to port **5173** (`strictPort`) because the photo bucket's CORS
rule only allows uploads from `http://localhost:5173`.

`public/config.json` is git-ignored. Without it the app shows a "Configuration missing"
screen. Its shape (see `config.example.json`):

```json
{ "apiUrl": "https://…/prod/", "userPoolId": "ap-south-1_xxx", "userPoolClientId": "xxx", "region": "ap-south-1" }
```

## Build

```bash
npm run build     # type-checks (tsc -b), then bundles to dist/
npm run lint      # oxlint
npm run preview   # serve dist/ locally (copy public/config.json into dist/ first)
```

`dist/` is what CDK uploads to the web bucket. On deploy, CDK writes `config.json` next to
`index.html`, so the same build works in every environment. The build deliberately leaves
`public/config.json` out of `dist/`, so a local config can never be shipped.

Hosting notes:

- `base: '/'`: assets, `config.json` and the logo use absolute paths, so the app must be
  served from the site root. A path-style URL such as `/classes/X/report` that falls back
  to `index.html` still loads correctly.
- Routing uses `HashRouter` (`/#/classes/…`), so every URL loads `index.html`. Deep links
  work on S3 + CloudFront without rewrite rules, and an index.html fallback does no harm.

## Signing in

Accounts are created by the backend (teachers by an admin, students by `POST students`),
and Cognito emails a temporary password. On first sign-in the app asks the user to choose
a new password (`CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`). After sign-in it calls
`GET me` and routes by role:

| Role | Pages |
|---|---|
| teacher | Classes (list + create) · Class → Roster / Take attendance / Sessions / Report · Students (enroll, reference photo, status) · per-student report |
| student | My attendance: % per class, below-threshold warning, present/absent per session date |

The Cognito **ID token** goes in the `Authorization` header without a `Bearer` prefix.

## Code map

```
src/
  main.tsx              loads config.json → Amplify.configure → renders the app
  config.ts             runtime config loader and validation
  api.ts                typed client for every route, resizeToJpeg(), putToS3()
  AuthProvider.tsx      Cognito session + GET me; auth-context.ts has the hooks
  poll.ts / hooks.ts    polling helper, useAsync, unmount-aware abort signals
  components/           Layout, PhotoPicker, FacePhoto (face boxes), SessionView, BarChart, ui
  pages/SignInPage.tsx  sign-in + set-new-password
  pages/teacher/        Classes, ClassLayout (tabs), Roster, TakeAttendance, Sessions,
                        Session, ClassReport, Students (+ EnrollPhotoPanel)
  pages/student/        MyAttendance, StudentReportView (shared with teachers)
```

### Photo flows

- **Enrollment**: `POST students` returns an upload URL. The photo is resized in the
  browser (longest side ≤ 1920 px, JPEG q 0.85), `PUT` to S3 with `Content-Type: image/jpeg`,
  then `GET students/{id}` is polled every 2 s until `enrollStatus` leaves `PENDING`.
  "Re-take photo" gets a fresh URL from `POST students/{id}/photo-url`.
- **Attendance**: for each of 1–3 photos: resize, `POST …/upload-url`, then `PUT`. The app
  polls `GET classes/{id}/sessions/{date}` every 2 s (404 means not processed yet) until all
  uploaded photos appear, or gives up after 90 s. Face boxes are drawn from the ratio
  boxes: green with the student's name when matched, red "unknown" otherwise. Each student
  has a present/absent toggle (manual override).
