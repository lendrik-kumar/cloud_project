"""CloudAttend REST API (contract: docs/api.md). Role comes from the Cognito groups claim."""
import datetime as dt
import json
import os
import re
import time
import traceback
import uuid
from collections import Counter, defaultdict
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "ap-south-1"))
# Regional virtual-hosted endpoint: a global-endpoint URL would 307-redirect and break browser CORS.
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com",
                  config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
cognito = boto3.client("cognito-idp")
ddb = boto3.resource("dynamodb")
students = ddb.Table(os.environ["STUDENTS_TABLE"])
classes = ddb.Table(os.environ["CLASSES_TABLE"])
sessions = ddb.Table(os.environ["SESSIONS_TABLE"])
attendance = ddb.Table(os.environ["ATTENDANCE_TABLE"])
usage = ddb.Table(os.environ["USAGE_TABLE"])
BUCKET = os.environ["PHOTOS_BUCKET"]
USER_POOL_ID = os.environ["USER_POOL_ID"]
THRESHOLD = float(os.environ.get("ATTENDANCE_THRESHOLD", "75"))
REK_CAP = int(os.environ.get("REK_MONTHLY_CAP", "900"))

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
UPLOAD_TTL = 300
VIEW_TTL = 900


# ----------------------------------------------------------------------------- plumbing
class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def to_json(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError(f"not JSON serializable: {type(o)}")


def resp(status, body):
    return {"statusCode": status,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps(body, default=to_json)}


class Request:
    def __init__(self, event):
        claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
        self.sub = claims.get("sub", "")
        self.email = claims.get("email", "")
        self.student_id = claims.get("custom:studentId")
        g = claims.get("cognito:groups", "")
        # REST API authorizers flatten list claims to strings like "[teacher]" or "teacher,student".
        self.groups = set(g) if isinstance(g, list) else set(g.strip("[]").replace(",", " ").split())
        self.is_teacher = "teacher" in self.groups
        self.is_student = "student" in self.groups
        self.path = event.get("pathParameters") or {}
        try:
            self.body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            raise HttpError(400, "body must be JSON")
        if not isinstance(self.body, dict):
            raise HttpError(400, "body must be a JSON object")

    def param(self, name):
        v = self.path.get(name, "")
        if not ID_RE.match(v):
            raise HttpError(400, f"invalid {name}")
        return v

    def date(self):
        v = self.path.get("date", "")
        try:
            if DATE_RE.match(v) and dt.date.fromisoformat(v):
                return v
        except ValueError:
            pass
        raise HttpError(400, "date must be YYYY-MM-DD")

    def field(self, name, pattern=None, max_len=100):
        v = self.body.get(name)
        if not isinstance(v, str) or not v.strip() or len(v) > max_len:
            raise HttpError(400, f"{name} is required (max {max_len} chars)")
        v = v.strip()
        if pattern and not pattern.match(v):
            raise HttpError(400, f"invalid {name}")
        return v


ROUTES = {}


def route(method, resource, teacher=False):
    def deco(fn):
        ROUTES[(method, resource)] = (fn, teacher)
        return fn
    return deco


def handler(event, _ctx):
    try:
        req = Request(event)
        entry = ROUTES.get((event.get("httpMethod"), event.get("resource")))
        if not entry:
            raise HttpError(404, "unknown route")
        fn, teacher_only = entry
        if not (req.is_teacher or req.is_student):
            raise HttpError(403, "this account has no role")
        if teacher_only and not req.is_teacher:
            raise HttpError(403, "teacher role required")
        status, body = fn(req)
        return resp(status, body)
    except HttpError as e:
        return resp(e.status, {"error": str(e)})
    except Exception:  # noqa: BLE001 - log and return a clean 500 (counted by the API 5xx alarm)
        traceback.print_exc()
        return resp(500, {"error": "internal error"})


# ----------------------------------------------------------------------------- data helpers
def is_conditional_failure(e):
    return e.response["Error"]["Code"] == "ConditionalCheckFailedException"


def _paginate(op, kw):
    items = []
    while True:
        page = op(**kw)
        items += page["Items"]
        if "LastEvaluatedKey" not in page:
            return items
        kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def query_all(table, **kw):
    return _paginate(table.query, kw)


def scan_all(table, **kw):
    return _paginate(table.scan, kw)


def get_students(ids):
    """{studentId: item} for the ids that exist."""
    ids, out = list(dict.fromkeys(ids)), {}
    for i in range(0, len(ids), 100):
        request = {students.name: {"Keys": [{"studentId": s} for s in ids[i:i + 100]]}}
        while request:
            page = ddb.batch_get_item(RequestItems=request)
            for item in page["Responses"].get(students.name, []):
                out[item["studentId"]] = item
            request = page.get("UnprocessedKeys") or None
    return out


def student_view(item):
    return {"studentId": item["studentId"], "name": item.get("name", ""), "email": item.get("email", ""),
            "enrollStatus": item.get("enrollStatus", "PENDING"),
            "enrollError": item.get("enrollError") or None,
            "subscribed": bool(item.get("subscribed"))}


def class_view(item, session_count):
    return {"classId": item["classId"], "name": item.get("name", ""),
            "studentIds": sorted(item.get("studentIds") or []), "sessionCount": session_count}


def owned_class(req, class_id):
    item = classes.get_item(Key={"classId": class_id}).get("Item")
    if not item:
        raise HttpError(404, f"class {class_id} not found")
    if item.get("teacherSub") != req.sub:
        raise HttpError(403, "not your class")
    return item


def session_dates(class_id):
    """Dates of sessions that have attendance data (excludes uploads still pending)."""
    return sorted(s["date"] for s in query_all(
        sessions, KeyConditionExpression=Key("classId").eq(class_id),
        FilterExpression=Attr("photos").exists(),
        ProjectionExpression="#d", ExpressionAttributeNames={"#d": "date"}))


def class_attendance(class_id, prefix=None):
    cond = Key("classId").eq(class_id)
    if prefix:
        cond = cond & Key("sk").begins_with(prefix)
    return query_all(attendance, KeyConditionExpression=cond)


def pct(attended, total):
    return round(attended * 100 / total, 1) if total else 0.0


def upload_url(key):
    return s3.generate_presigned_url(
        "put_object", Params={"Bucket": BUCKET, "Key": key, "ContentType": "image/jpeg"},
        ExpiresIn=UPLOAD_TTL)


# ----------------------------------------------------------------------------- routes: any role
@route("GET", "/me")
def me(req):
    out = {"role": "teacher" if req.is_teacher else "student", "email": req.email}
    if req.student_id:
        out["studentId"] = req.student_id
    if req.is_teacher:
        month = time.strftime("%Y-%m", time.gmtime())
        item = usage.get_item(Key={"month": month}).get("Item") or {}
        out["rekognitionUsage"] = {"month": month, "cap": REK_CAP,
                                   "group1": item.get("group1", 0), "group2": item.get("group2", 0)}
    return 200, out


# ----------------------------------------------------------------------------- routes: classes
@route("GET", "/classes", teacher=True)
def list_classes(req):
    items = scan_all(classes, FilterExpression=Attr("teacherSub").eq(req.sub))
    return 200, {"classes": [class_view(c, len(session_dates(c["classId"])))
                             for c in sorted(items, key=lambda c: c["classId"])]}


@route("POST", "/classes", teacher=True)
def create_class(req):
    class_id, name = req.field("classId", ID_RE, 40), req.field("name")
    item = {"classId": class_id, "name": name, "teacherSub": req.sub,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        classes.put_item(Item=item, ConditionExpression="attribute_not_exists(classId)")
    except ClientError as e:
        if is_conditional_failure(e):
            raise HttpError(409, f"class {class_id} already exists")
        raise
    return 201, {"class": class_view(item, 0)}


@route("PUT", "/classes/{classId}/students", teacher=True)
def set_roster(req):
    cls = owned_class(req, req.param("classId"))
    ids = req.body.get("studentIds")
    if not isinstance(ids, list) or not all(isinstance(s, str) and ID_RE.match(s) for s in ids):
        raise HttpError(400, "studentIds must be a list of student ids")
    ids = sorted(set(ids))
    unknown = sorted(set(ids) - set(get_students(ids)))
    if unknown:
        raise HttpError(400, f"unknown students: {', '.join(unknown)}")
    key = {"classId": cls["classId"]}
    if ids:
        classes.update_item(Key=key, UpdateExpression="SET studentIds = :s",
                            ExpressionAttributeValues={":s": set(ids)})
    else:  # DynamoDB can't store an empty set
        classes.update_item(Key=key, UpdateExpression="REMOVE studentIds")
    cls["studentIds"] = set(ids)
    return 200, {"class": class_view(cls, len(session_dates(cls["classId"])))}


# ----------------------------------------------------------------------------- routes: students
@route("GET", "/students", teacher=True)
def list_students(_req):
    items = sorted(scan_all(students), key=lambda s: s["studentId"])
    return 200, {"students": [student_view(s) for s in items]}


@route("POST", "/students", teacher=True)
def create_student(req):
    sid = req.field("studentId", ID_RE, 40)
    name = req.field("name")
    email = req.field("email", EMAIL_RE, 254).lower()
    item = {"studentId": sid, "name": name, "email": email, "enrollStatus": "PENDING", "subscribed": False}
    try:
        students.put_item(Item=item, ConditionExpression="attribute_not_exists(studentId)")
    except ClientError as e:
        if is_conditional_failure(e):
            raise HttpError(409, f"student {sid} already exists")
        raise

    created = False
    try:
        cognito.admin_create_user(
            UserPoolId=USER_POOL_ID, Username=email, DesiredDeliveryMediums=["EMAIL"],
            UserAttributes=[{"Name": "email", "Value": email},
                            {"Name": "email_verified", "Value": "true"},
                            {"Name": "custom:studentId", "Value": sid}])
        created = True
        cognito.admin_add_user_to_group(UserPoolId=USER_POOL_ID, Username=email, GroupName="student")
    except ClientError as e:
        students.delete_item(Key={"studentId": sid})
        if created:
            cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=email)
        if e.response["Error"]["Code"] == "UsernameExistsException":
            raise HttpError(409, f"a login for {email} already exists")
        raise
    return 201, {"student": student_view(item), "uploadUrl": upload_url(f"enroll/{sid}.jpg")}


@route("GET", "/students/{studentId}", teacher=True)
def get_student(req):
    item = students.get_item(Key={"studentId": req.param("studentId")}).get("Item")
    if not item:
        raise HttpError(404, "student not found")
    return 200, {"student": student_view(item)}


@route("POST", "/students/{studentId}/photo-url", teacher=True)
def student_photo_url(req):
    sid = req.param("studentId")
    try:
        students.update_item(
            Key={"studentId": sid}, ConditionExpression="attribute_exists(studentId)",
            UpdateExpression="SET enrollStatus = :p REMOVE enrollError",
            ExpressionAttributeValues={":p": "PENDING"})
    except ClientError as e:
        if is_conditional_failure(e):
            raise HttpError(404, "student not found")
        raise
    return 200, {"uploadUrl": upload_url(f"enroll/{sid}.jpg")}


# ----------------------------------------------------------------------------- routes: sessions
@route("POST", "/classes/{classId}/sessions/{date}/upload-url", teacher=True)
def session_upload_url(req):
    cls, date = owned_class(req, req.param("classId")), req.date()
    # The ms timestamp lets process_photo ignore uploads that were requested but never sent.
    key = f"classes/{cls['classId']}/{date}/{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.jpg"
    sessions.update_item(Key={"classId": cls["classId"], "date": date},
                         UpdateExpression="ADD pendingKeys :k", ExpressionAttributeValues={":k": {key}})
    return 200, {"uploadUrl": upload_url(key), "key": key}


@route("GET", "/classes/{classId}/sessions", teacher=True)
def list_sessions(req):
    cls = owned_class(req, req.param("classId"))
    items = query_all(sessions, KeyConditionExpression=Key("classId").eq(cls["classId"]),
                      FilterExpression=Attr("photos").exists())
    present = Counter(r["date"] for r in class_attendance(cls["classId"]))
    out = [{"date": s["date"], "photoCount": len(s.get("photos") or []),
            "facesDetected": s.get("facesDetected", 0), "presentCount": present[s["date"]]}
           for s in items]
    return 200, {"sessions": sorted(out, key=lambda s: s["date"], reverse=True)}


@route("GET", "/classes/{classId}/sessions/{date}", teacher=True)
def get_session(req):
    cls, date = owned_class(req, req.param("classId")), req.date()
    s = sessions.get_item(Key={"classId": cls["classId"], "date": date}).get("Item")
    if not s or "photos" not in s:
        raise HttpError(404, "no processed photos for this session yet")

    photos = [{"key": p["key"], "faces": p.get("faces", []),
               "url": s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": p["key"]},
                                                ExpiresIn=VIEW_TTL)}
              for p in s["photos"]]
    rows = class_attendance(cls["classId"], f"{date}#")
    roster = set(cls.get("studentIds") or [])
    names = get_students(roster | {r["studentId"] for r in rows})
    name = lambda sid: names.get(sid, {}).get("name", sid)  # noqa: E731
    present = sorted(({"studentId": r["studentId"], "name": name(r["studentId"]),
                       "source": r.get("source", "auto"), "similarity": r.get("similarity")} for r in rows),
                     key=lambda p: p["name"].lower())
    absent = sorted(({"studentId": sid, "name": name(sid)}
                     for sid in roster - {r["studentId"] for r in rows}),
                    key=lambda p: p["name"].lower())
    return 200, {"session": {"classId": cls["classId"], "date": date,
                             "facesDetected": s.get("facesDetected", 0), "photos": photos},
                 "present": present, "absent": absent}


@route("PUT", "/classes/{classId}/sessions/{date}/attendance/{studentId}", teacher=True)
def override_attendance(req):
    cls, date, sid = owned_class(req, req.param("classId")), req.date(), req.param("studentId")
    present = req.body.get("present")
    if not isinstance(present, bool):
        raise HttpError(400, "present must be true or false")
    if sid not in set(cls.get("studentIds") or []):
        raise HttpError(400, f"{sid} is not on this class's roster")

    sessions.update_item(  # make sure the session counts even if it had no photos
        Key={"classId": cls["classId"], "date": date},
        UpdateExpression="SET photos = if_not_exists(photos, :empty), facesDetected = if_not_exists(facesDetected, :zero)",
        ExpressionAttributeValues={":empty": [], ":zero": 0})
    key = {"classId": cls["classId"], "sk": f"{date}#{sid}"}
    if present:
        attendance.put_item(Item={**key, "studentId": sid, "date": date, "source": "manual",
                                  "similarity": None, "markedBy": req.sub})
    else:
        attendance.delete_item(Key=key)
    return 200, {"studentId": sid, "present": present}


# ----------------------------------------------------------------------------- routes: reports
@route("GET", "/reports/class/{classId}", teacher=True)
def class_report(req):
    cls = owned_class(req, req.param("classId"))
    dates = session_dates(cls["classId"])
    valid = set(dates)
    rows = [r for r in class_attendance(cls["classId"]) if r["date"] in valid]
    per_date = Counter(r["date"] for r in rows)
    attended = Counter(r["studentId"] for r in rows)
    ids = set(cls.get("studentIds") or []) | set(attended)
    names = get_students(ids)
    total = len(dates)
    report = [{"studentId": sid, "name": names.get(sid, {}).get("name", sid),
               "attended": attended[sid], "total": total, "pct": pct(attended[sid], total),
               "belowThreshold": total > 0 and pct(attended[sid], total) < THRESHOLD}
              for sid in sorted(ids)]
    return 200, {"classId": cls["classId"], "name": cls.get("name", ""), "threshold": THRESHOLD,
                 "totalSessions": total,
                 "sessions": [{"date": d, "presentCount": per_date[d]} for d in dates],
                 "students": report}


@route("GET", "/reports/student/{studentId}")
def student_report(req):
    sid = req.param("studentId")
    if not req.is_teacher and req.student_id != sid:
        raise HttpError(403, "you can only view your own attendance")
    student = students.get_item(Key={"studentId": sid}).get("Item")
    if not student:
        raise HttpError(404, "student not found")

    filt = Attr("studentIds").contains(sid)
    if req.is_teacher:
        filt = filt & Attr("teacherSub").eq(req.sub)
    enrolled = sorted(scan_all(classes, FilterExpression=filt), key=lambda c: c["classId"])

    present_by_class = defaultdict(set)
    for r in query_all(attendance, IndexName="by-student", KeyConditionExpression=Key("studentId").eq(sid)):
        present_by_class[r["classId"]].add(r["date"])

    out = []
    for c in enrolled:
        dates = session_dates(c["classId"])
        present = sorted(present_by_class[c["classId"]] & set(dates))
        p = pct(len(present), len(dates))
        out.append({"classId": c["classId"], "name": c.get("name", ""), "attended": len(present),
                    "total": len(dates), "pct": p, "belowThreshold": bool(dates) and p < THRESHOLD,
                    "sessionDates": dates, "presentDates": present})
    return 200, {"student": {"studentId": sid, "name": student.get("name", "")},
                 "threshold": THRESHOLD, "classes": out}
