# CloudAttend REST API contract

Base URL: `apiUrl` from `config.json` (CDK output `ApiUrl`). It **ends with a slash**,
e.g. `https://abc123.execute-api.ap-south-1.amazonaws.com/prod/` — join paths without
a leading slash.

## Auth

Every route requires the Cognito **ID token** (not the access token) in the header:

```
Authorization: <idToken>          # raw token, no "Bearer " prefix
```

The ID token carries `cognito:groups` (`teacher` or `student`) and, for students,
`custom:studentId`. All bodies are JSON. Errors return `{ "error": string }` with
400 (bad input), 403 (wrong role / not your data), 404 (not found), 409 (already exists).

## Formats

- `date`: `YYYY-MM-DD`
- `classId`, `studentId`: `^[A-Za-z0-9_-]{1,40}$`
- Face `box`: ratios of the image size, `{ left, top, width, height }` each in 0..1
- Percentages: number 0..100, rounded to 1 decimal

## Types

```ts
type EnrollStatus = "PENDING" | "INDEXED" | "NO_FACE" | "MULTIPLE_FACES" | "ERROR";
type Student = { studentId: string; name: string; email: string; enrollStatus: EnrollStatus;
                 enrollError: string | null /* why NO_FACE / MULTIPLE_FACES / ERROR */; subscribed: boolean };
type Class   = { classId: string; name: string; studentIds: string[]; sessionCount: number };
type Face    = { box: { left: number; top: number; width: number; height: number };
                 studentId: string | null; similarity: number | null };
```

## Any signed-in user

| Method & path | Body | Response |
|---|---|---|
| `GET me` | – | `{ role: "teacher" \| "student", email: string, studentId?: string, rekognitionUsage?: { month: "YYYY-MM", cap: number, group1: number, group2: number } }` — `rekognitionUsage` (teachers only) is this month's Rekognition calls vs the free-tier cap |

## Teacher only

Classes are scoped to the teacher who created them (403 on another teacher's class).

| Method & path | Body | Response |
|---|---|---|
| `GET classes` | – | `{ classes: Class[] }` |
| `POST classes` | `{ classId, name }` | 201 `{ class: Class }` · 409 if it exists |
| `PUT classes/{classId}/students` | `{ studentIds: string[] }` (replaces roster) | `{ class: Class }` |
| `GET students` | – | `{ students: Student[] }` |
| `POST students` | `{ studentId, name, email }` | 201 `{ student: Student, uploadUrl: string }` · 409 if it exists. Also creates the student's Cognito login (Cognito emails a temporary password). |
| `GET students/{studentId}` | – | `{ student: Student }` — poll after uploading the enrollment photo until `enrollStatus !== "PENDING"` |
| `POST students/{studentId}/photo-url` | – | `{ uploadUrl: string }` — re-take the enrollment photo (status resets to `PENDING`) |
| `POST classes/{classId}/sessions/{date}/upload-url` | – | `{ uploadUrl: string, key: string }` — one URL per photo; call once per photo |
| `GET classes/{classId}/sessions` | – | `{ sessions: { date, photoCount, facesDetected, presentCount }[] }` (newest first) |
| `GET classes/{classId}/sessions/{date}` | – | see below · 404 until the first photo has been processed |
| `PUT classes/{classId}/sessions/{date}/attendance/{studentId}` | `{ present: boolean }` | `{ studentId, present }` — manual override; creates the session if needed |
| `GET reports/class/{classId}` | – | see below |

`GET classes/{classId}/sessions/{date}`:

```ts
{
  session: {
    classId: string; date: string; facesDetected: number;
    photos: { key: string; url: string /* pre-signed GET, 15 min */; faces: Face[];
              note?: string /* e.g. monthly Rekognition cap reached, or only N largest faces checked — show it */ }[];
  };
  present: { studentId: string; name: string; source: "auto" | "manual"; similarity: number | null }[];
  absent:  { studentId: string; name: string }[];   // roster students not present
}
```

Free-tier guard: Rekognition calls are capped per month. When the cap is reached a photo is
still stored and listed, but with `faces: []` and a `note`; the teacher marks attendance by hand.

Processing is asynchronous (S3 → Lambda, usually 3–15 s per photo). After uploading N
photos, poll this route every ~2 s until `session.photos.length >= N` (give up after ~90 s).

`GET reports/class/{classId}`:

```ts
{
  classId: string; name: string; threshold: number; totalSessions: number;
  sessions: { date: string; presentCount: number }[];               // oldest first
  students: { studentId: string; name: string; attended: number; total: number;
              pct: number; belowThreshold: boolean }[];
}
```

## Teacher, or the student whose record it is

| Method & path | Response |
|---|---|
| `GET reports/student/{studentId}` | see below · 403 for any other student |

```ts
{
  student: { studentId: string; name: string };
  threshold: number;
  classes: { classId: string; name: string; attended: number; total: number; pct: number;
             belowThreshold: boolean; sessionDates: string[]; presentDates: string[] }[];
}
```

## Uploading photos

`uploadUrl` is a pre-signed S3 PUT valid for 5 minutes. Send the JPEG bytes with the
matching content type, or S3 rejects the signature:

```
PUT <uploadUrl>
Content-Type: image/jpeg
<jpeg bytes>
```

Resize in the browser first (longest side ≤ 1920 px, JPEG quality ~0.85). The photo
bucket's CORS allows `PUT` from `http://localhost:5173` and the CloudFront domain.

## Runtime config (`/config.json`)

Served next to `index.html`; generated by CDK on deploy, or by
`scripts/write-local-config.sh` for `npm run dev`:

```json
{ "apiUrl": "https://…/prod/", "userPoolId": "ap-south-1_xxx", "userPoolClientId": "xxx", "region": "ap-south-1" }
```

CloudFormation stack `CloudAttendStack` outputs: `ApiUrl`, `UserPoolId`,
`UserPoolClientId`, `Region`, `PhotosBucketName`, `WebUrl`.
