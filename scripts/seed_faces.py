#!/usr/bin/env python3
"""Face-recognition demo with public-domain NASA photos (Artemis II crew).

Enrolls the 4 Artemis II crew members as demo students through the real pipeline (S3 enroll/
upload -> enroll Lambda -> Rekognition IndexFaces), in their own class owned by the given
teacher. The 2 backup crew members are on the roster too but have NO face data: in the
6-person group photo they show up as "unknown" and are marked absent until the teacher
toggles them present. A few earlier sessions of manual attendance give the reports history.
Demo students get no Cognito login and no e-mail, so nothing is sent anywhere.

    PY=local/.venv/bin/python
    $PY scripts/seed_faces.py --teacher you@example.com                 # enroll (≈8 Rekognition calls)
    $PY scripts/seed_faces.py --teacher you@example.com --verify local/demo-faces/group-crew4.jpg
    $PY scripts/seed_faces.py --teacher you@example.com --repair        # rebuild rows from the collection (0 calls)
    $PY scripts/seed_faces.py --teacher you@example.com --remove        # delete faces + data

Photos are expected in local/demo-faces/ (see SOURCES.md there).
"""
import argparse
import datetime as dt
import time
from pathlib import Path

import boto3
from boto3.dynamodb.conditions import Key

REGION = "ap-south-1"
STACK = "CloudAttendStack"
COLLECTION = "cloudattend-students"
CLASS_ID = "DEMO-FACES"
CLASS_NAME = "Face demo: Artemis II crew"
PHOTO_DIR = Path(__file__).resolve().parents[1] / "local" / "demo-faces"
STUDENTS = [  # (studentId, name, reference photo)
    ("ART-WISEMAN", "Reid Wiseman", "wiseman.jpg"),
    ("ART-GLOVER", "Victor Glover", "glover.jpg"),
    ("ART-KOCH", "Christina Koch", "koch.jpg"),
    ("ART-HANSEN", "Jeremy Hansen", "hansen.jpg"),
]
NO_FACE_STUDENTS = [  # on the roster, no reference photo
    ("ART-DOUGLAS", "Andre Douglas"),
    ("ART-GIBBONS", "Jenni Gibbons"),
]
ALL_IDS = [s[0] for s in STUDENTS] + [s[0] for s in NO_FACE_STUDENTS]
# Earlier sessions (manual marks): sessions attended out of HISTORY_SESSIONS
HISTORY_SESSIONS = 4
HISTORY = {"ART-WISEMAN": 4, "ART-GLOVER": 4, "ART-KOCH": 3, "ART-HANSEN": 4, "ART-DOUGLAS": 2, "ART-GIBBONS": 1}


class Stack:
    def __init__(self):
        cfn = boto3.client("cloudformation", region_name=REGION)
        self.out = {o["OutputKey"]: o["OutputValue"]
                    for o in cfn.describe_stacks(StackName=STACK)["Stacks"][0]["Outputs"]}
        names = boto3.client("dynamodb", region_name=REGION).list_tables()["TableNames"]
        ddb = boto3.resource("dynamodb", region_name=REGION)
        t = lambda part: ddb.Table(next(n for n in names if n.startswith(f"{STACK}-{part}")))  # noqa: E731
        self.students, self.classes = t("StudentsTable"), t("ClassesTable")
        self.sessions, self.attendance = t("SessionsTable"), t("AttendanceTable")
        self.s3 = boto3.client("s3", region_name=REGION)
        self.rek = boto3.client("rekognition", region_name=REGION)
        self.idp = boto3.client("cognito-idp", region_name=REGION)
        self.bucket = self.out["PhotosBucketName"]

    def teacher_sub(self, email):
        pool = self.out["UserPoolId"]
        groups = [g["GroupName"] for g in self.idp.admin_list_groups_for_user(UserPoolId=pool, Username=email)["Groups"]]
        if "teacher" not in groups:
            raise SystemExit(f"{email} is not a teacher (run scripts/create-teacher.sh first)")
        attrs = self.idp.admin_get_user(UserPoolId=pool, Username=email)["UserAttributes"]
        return next(a["Value"] for a in attrs if a["Name"] == "sub")


def weekdays_before(day, n):
    out, d = [], day
    while len(out) < n:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5:
            out.append(d.isoformat())
    return sorted(out)


def class_and_extras(st, sub, history_before):
    """Class with the full roster, the no-face students, and earlier manual sessions (idempotent)."""
    st.classes.put_item(Item={"classId": CLASS_ID, "name": CLASS_NAME, "teacherSub": sub,
                              "studentIds": set(ALL_IDS), "demo": True})
    for sid, name in NO_FACE_STUDENTS:
        st.students.put_item(Item={"studentId": sid, "name": name, "email": "", "enrollStatus": "PENDING",
                                   "subscribed": False, "demo": True})
    dates = weekdays_before(history_before, HISTORY_SESSIONS)
    for d in dates:
        st.sessions.put_item(Item={"classId": CLASS_ID, "date": d, "photos": [], "facesDetected": 0, "demo": True})
    with st.attendance.batch_writer() as w:
        for i, sid in enumerate(ALL_IDS):
            absent = {dates[(i + k) % HISTORY_SESSIONS] for k in range(HISTORY_SESSIONS - HISTORY[sid])}
            for d in dates:
                if d not in absent:
                    w.put_item(Item={"classId": CLASS_ID, "sk": f"{d}#{sid}", "studentId": sid, "date": d,
                                     "source": "manual", "similarity": None, "markedBy": "demo-seed"})
    print(f"Class {CLASS_ID}: roster of {len(ALL_IDS)} ({len(NO_FACE_STUDENTS)} without face data), "
          f"history sessions {dates[0]} .. {dates[-1]}")


def collection_faces():
    """{studentId: faceId} for this demo's students currently in the Rekognition collection."""
    rek = boto3.client("rekognition", region_name=REGION)
    found, token = {}, None
    while True:
        page = rek.list_faces(CollectionId=COLLECTION, MaxResults=1000, **({"NextToken": token} if token else {}))
        for f in page["Faces"]:
            if f.get("ExternalImageId") in {s[0] for s in STUDENTS}:
                found[f["ExternalImageId"]] = f["FaceId"]
        token = page.get("NextToken")
        if not token:
            return found


def repair(st, sub, history_before):
    """Recreate missing rows for students whose face is still indexed (no Rekognition calls)."""
    faces = collection_faces()
    for sid, name, _ in STUDENTS:
        if sid not in faces:
            print(f"  {sid}: no face in the collection; run without --repair to enroll it")
            continue
        item = st.students.get_item(Key={"studentId": sid}).get("Item")
        if not item or item.get("faceId") != faces[sid]:
            st.students.put_item(Item={"studentId": sid, "name": name, "email": "", "enrollStatus": "INDEXED",
                                       "faceId": faces[sid], "subscribed": False, "demo": True})
            print(f"  {sid}: restored (face {faces[sid]})")
        else:
            print(f"  {sid}: ok")
    class_and_extras(st, sub, history_before)


def enroll(st, sub, history_before):
    for _, _, photo in STUDENTS:
        if not (PHOTO_DIR / photo).is_file():
            raise SystemExit(f"missing {PHOTO_DIR / photo}")
    class_and_extras(st, sub, history_before)
    for sid, name, photo in STUDENTS:
        # No e-mail: the enroll Lambda only subscribes students that have one.
        st.students.put_item(Item={"studentId": sid, "name": name, "email": "", "enrollStatus": "PENDING",
                                   "subscribed": False, "demo": True})
        st.s3.upload_file(str(PHOTO_DIR / photo), st.bucket, f"enroll/{sid}.jpg",
                          ExtraArgs={"ContentType": "image/jpeg"})
        print(f"  uploaded {photo} -> enroll/{sid}.jpg")

    print("Waiting for the enroll Lambda ...")
    deadline = time.time() + 120
    pending = {s[0] for s in STUDENTS}
    while pending and time.time() < deadline:
        time.sleep(3)
        for sid in sorted(pending):
            item = st.students.get_item(Key={"studentId": sid}, ConsistentRead=True)["Item"]
            if item.get("enrollStatus") != "PENDING":
                pending.discard(sid)
                print(f"  {sid:12} {item['enrollStatus']:15} {item.get('enrollError') or item.get('faceId', '')}")
    if pending:
        print(f"  still PENDING after 120 s: {sorted(pending)} (check the EnrollFn logs)")


def verify(st, photo, date):
    key = f"classes/{CLASS_ID}/{date}/{int(time.time() * 1000)}-verify.jpg"
    st.s3.upload_file(photo, st.bucket, key, ExtraArgs={"ContentType": "image/jpeg"})
    print(f"Uploaded {Path(photo).name} as a session on {date}; waiting for process_photo ...")
    names = {s[0]: s[1] for s in STUDENTS}
    for _ in range(45):
        time.sleep(2)
        item = st.sessions.get_item(Key={"classId": CLASS_ID, "date": date}, ConsistentRead=True).get("Item")
        photos = [p for p in (item or {}).get("photos", []) if p["key"] == key]
        if photos:
            p = photos[0]
            print(f"  {len(p['faces'])} faces detected{'  note: ' + p['note'] if p.get('note') else ''}")
            for f in p["faces"]:
                b = f["box"]
                who = f"{names.get(f['studentId'], f['studentId'])} ({float(f['similarity']):.1f}%)" if f["studentId"] else "unknown"
                print(f"   - box left={float(b['left']):.2f} top={float(b['top']):.2f}: {who}")
            matched = {f["studentId"] for f in p["faces"] if f["studentId"]}
            missing = [names[s] for s in names if s not in matched]
            print(f"  matched {len(matched)}/{len(STUDENTS)}" + (f"; not found: {', '.join(missing)}" if missing else ""))
            return
    print("  timed out waiting for the session (check the ProcessPhotoFn logs)")


def remove(st):
    # Faces first, found via the collection itself, so an interrupted run never orphans them.
    face_ids = list(collection_faces().values())
    if face_ids:
        st.rek.delete_faces(CollectionId=COLLECTION, FaceIds=face_ids)
    for sid in ALL_IDS:
        st.students.delete_item(Key={"studentId": sid})
        st.s3.delete_object(Bucket=st.bucket, Key=f"enroll/{sid}.jpg")
    att = st.attendance.query(KeyConditionExpression=Key("classId").eq(CLASS_ID))["Items"]
    with st.attendance.batch_writer() as w:
        for r in att:
            w.delete_item(Key={"classId": CLASS_ID, "sk": r["sk"]})
    ses = st.sessions.query(KeyConditionExpression=Key("classId").eq(CLASS_ID))["Items"]
    with st.sessions.batch_writer() as w:
        for s in ses:
            w.delete_item(Key={"classId": CLASS_ID, "date": s["date"]})
    for obj in st.s3.list_objects_v2(Bucket=st.bucket, Prefix=f"classes/{CLASS_ID}/").get("Contents", []):
        st.s3.delete_object(Bucket=st.bucket, Key=obj["Key"])
    st.classes.delete_item(Key={"classId": CLASS_ID})
    print(f"Removed {len(face_ids)} faces from Rekognition, {len(ALL_IDS)} demo students, "
          f"class {CLASS_ID} with {len(ses)} sessions and {len(att)} marks, and their photos.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--teacher", required=True)
    ap.add_argument("--verify", metavar="GROUP_PHOTO", help="upload a group photo as a session and print the matches")
    ap.add_argument("--date", default=(dt.date.today() - dt.timedelta(days=1)).isoformat(),
                    help="session date for --verify (default: yesterday, so today stays free for the dashboard)")
    ap.add_argument("--repair", action="store_true", help="rebuild missing rows from the collection (0 Rekognition calls)")
    ap.add_argument("--remove", action="store_true")
    args = ap.parse_args()
    st = Stack()
    # History goes before the verify date (default yesterday), so neither collides with today.
    history_before = dt.date.fromisoformat(args.date)
    if args.remove:
        remove(st)
    elif args.verify:
        verify(st, args.verify, args.date)
    elif args.repair:
        repair(st, st.teacher_sub(args.teacher), history_before)
    else:
        enroll(st, st.teacher_sub(args.teacher), history_before)


if __name__ == "__main__":
    main()
