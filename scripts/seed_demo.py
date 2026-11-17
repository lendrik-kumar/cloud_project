#!/usr/bin/env python3
"""Load (or remove) a demo class so the dashboard has something to show.

Writes straight to DynamoDB: no Rekognition calls, no Cognito logins, no e-mails, $0.
The class belongs to the given teacher (classes are scoped to their creator).

    local/.venv/bin/python scripts/seed_demo.py --teacher you@example.com
    local/.venv/bin/python scripts/seed_demo.py --teacher you@example.com --remove

Demo students are fictional, have no reference photo (status PENDING) and no login.
Attendance is 8 past sessions of manual marks, with a couple of students under 75%.
"""
import argparse
import datetime as dt

import boto3
from boto3.dynamodb.conditions import Key

REGION = "ap-south-1"
STACK = "CloudAttendStack"
CLASS_ID = "DEMO-UCS531"
CLASS_NAME = "Cloud Computing (demo)"
# (studentId, name, sessions attended out of 8)
STUDENTS = [
    ("DEMO01", "Aarav Mehta", 8), ("DEMO02", "Diya Kapoor", 7), ("DEMO03", "Kabir Singh", 7),
    ("DEMO04", "Ananya Rao", 6), ("DEMO05", "Vihaan Gupta", 6), ("DEMO06", "Ishita Verma", 5),
    ("DEMO07", "Arjun Nair", 4), ("DEMO08", "Meera Joshi", 3),
]
SESSIONS = 8


def tables():
    names = boto3.client("dynamodb", region_name=REGION).list_tables()["TableNames"]
    ddb = boto3.resource("dynamodb", region_name=REGION)
    pick = lambda part: ddb.Table(next(n for n in names if n.startswith(f"{STACK}-{part}")))  # noqa: E731
    return {k: pick(k) for k in ("StudentsTable", "ClassesTable", "SessionsTable", "AttendanceTable")}


def teacher_sub(email):
    cfn = boto3.client("cloudformation", region_name=REGION)
    outputs = {o["OutputKey"]: o["OutputValue"] for o in cfn.describe_stacks(StackName=STACK)["Stacks"][0]["Outputs"]}
    idp = boto3.client("cognito-idp", region_name=REGION)
    user = idp.admin_get_user(UserPoolId=outputs["UserPoolId"], Username=email)
    groups = idp.admin_list_groups_for_user(UserPoolId=outputs["UserPoolId"], Username=email)["Groups"]
    if "teacher" not in [g["GroupName"] for g in groups]:
        raise SystemExit(f"{email} is not in the teacher group (run scripts/create-teacher.sh first)")
    return next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")


def past_weekdays(n):
    days, d = [], dt.date.today()
    while len(days) < n:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5:
            days.append(d.isoformat())
    return sorted(days)


def seed(t, sub):
    dates = past_weekdays(SESSIONS)
    t["ClassesTable"].put_item(Item={"classId": CLASS_ID, "name": CLASS_NAME, "teacherSub": sub,
                                     "studentIds": {s[0] for s in STUDENTS}, "demo": True})
    with t["StudentsTable"].batch_writer() as w:
        for sid, name, _ in STUDENTS:
            w.put_item(Item={"studentId": sid, "name": name, "email": f"{sid.lower()}@example.com",
                             "enrollStatus": "PENDING", "subscribed": False, "demo": True})
    with t["SessionsTable"].batch_writer() as w:
        for d in dates:
            w.put_item(Item={"classId": CLASS_ID, "date": d, "photos": [], "facesDetected": 0, "demo": True})
    rows = 0
    with t["AttendanceTable"].batch_writer() as w:
        for i, (sid, _, attended) in enumerate(STUDENTS):
            # spread each student's absences across the term, deterministically
            absent = {dates[(i * 3 + k * 2) % SESSIONS] for k in range(SESSIONS - attended)}
            while len(absent) < SESSIONS - attended:
                absent.add(next(d for d in dates if d not in absent))
            for d in dates:
                if d not in absent:
                    w.put_item(Item={"classId": CLASS_ID, "sk": f"{d}#{sid}", "studentId": sid, "date": d,
                                     "source": "manual", "similarity": None, "markedBy": "demo-seed"})
                    rows += 1
    print(f"Seeded class {CLASS_ID}: {len(STUDENTS)} students, {len(dates)} sessions "
          f"({dates[0]} .. {dates[-1]}), {rows} attendance marks.")


def remove(t):
    att = t["AttendanceTable"].query(KeyConditionExpression=Key("classId").eq(CLASS_ID))["Items"]
    with t["AttendanceTable"].batch_writer() as w:
        for r in att:
            w.delete_item(Key={"classId": CLASS_ID, "sk": r["sk"]})
    ses = t["SessionsTable"].query(KeyConditionExpression=Key("classId").eq(CLASS_ID))["Items"]
    with t["SessionsTable"].batch_writer() as w:
        for s in ses:
            w.delete_item(Key={"classId": CLASS_ID, "date": s["date"]})
    with t["StudentsTable"].batch_writer() as w:
        for sid, _, _ in STUDENTS:
            w.delete_item(Key={"studentId": sid})
    t["ClassesTable"].delete_item(Key={"classId": CLASS_ID})
    print(f"Removed demo class {CLASS_ID}, its {len(ses)} sessions, {len(att)} marks and {len(STUDENTS)} demo students.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--teacher", required=True, help="teacher login e-mail that will own the demo class")
    ap.add_argument("--remove", action="store_true", help="delete the demo data instead")
    args = ap.parse_args()
    t = tables()
    if args.remove:
        remove(t)
    else:
        seed(t, teacher_sub(args.teacher))


if __name__ == "__main__":
    main()
