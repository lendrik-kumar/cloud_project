# CloudAttend demo script (≈5 minutes)

Dashboard: https://d2di3cn41yfc1c.cloudfront.net · sign in as your teacher account.

## What's already loaded

Class **Face demo: Artemis II crew**, roster of 6 (public-domain NASA photos, see `SOURCES.md`):

| Student | Face data | Attendance so far (5 sessions) |
|---|---|---|
| Reid Wiseman | enrolled | 5/5 · 100% |
| Victor Glover | enrolled | 5/5 · 100% |
| Jeremy Hansen | enrolled | 5/5 · 100% |
| Christina Koch | enrolled | 4/5 · 80% |
| Andre Douglas | **none** (backup crew) | 2/5 · 40% (below 75%) |
| Jenni Gibbons | **none** (backup crew) | 1/5 · 20% (below 75%) |

Yesterday's session came from a real classroom-style photo processed by Rekognition (4/4 crew recognised). The 4 earlier sessions are manual marks.

## Demo steps

1. **Students page:** 4 students show `INDEXED` (face enrolled), and Douglas and Gibbons show no face data.
2. **Class → Report:** per-student percentages, with Douglas and Gibbons highlighted below 75%, plus the sessions chart.
3. **Class → Take attendance:** keep today's date and upload **`1-take-attendance-6-people.jpg`**.
   - The browser shrinks it, gets a pre-signed URL, and uploads straight to S3, which triggers the Lambda.
   - Within a few seconds you get 6 face boxes: **4 green with names** (Wiseman, Glover, Koch, Hansen) and **2 red "unknown"** (Douglas and Gibbons, who have no face data).
   - Present: the 4 crew. Absent: Douglas and Gibbons.
4. **Manual override:** Douglas is in the photo, but the camera can't know him. Toggle **Andre Douglas → present**.
5. **Report again:** now 6 sessions. Douglas goes to 3/6 (50%), and Gibbons drops to 1/6 (17%).
6. **Cost guard:** the Rekognition counter (this month's calls vs the 900 free-tier cap) went up by 7: 1 DetectFaces + 6 searches.
7. *(Optional)* Upload **`2-take-attendance-crew-portrait.jpg`** for the same date. A second photo of the same session just merges the present lists.

## Talking points

- **Fully serverless and event-driven:** S3 upload → Lambda → Rekognition → DynamoDB. Nothing runs while idle.
- **Security:** Cognito login with teacher/student roles, private buckets reached only through pre-signed URLs, and least-privilege IAM per Lambda.
- **Monitoring:** CloudWatch dashboard "CloudAttend" (Lambda, API and faces-per-hour metrics), error alarms emailed to you, and a zero-spend budget.
- **Infrastructure as Code:** the whole stack is one `npm run deploy` (AWS CDK), and `cdk destroy` removes it.

`reference-portraits/` holds the 4 enrollment photos already used. Upload one with "re-take photo" on the Students page to show enrollment; that costs 2 Rekognition calls.

Reset the demo afterwards: `local/.venv/bin/python scripts/seed_faces.py --teacher <you> --remove`
