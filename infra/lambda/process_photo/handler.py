"""S3 upload to classes/<classId>/<date>/<ms>-<id>.jpg -> match faces, record attendance.

1. Normalise the photo (EXIF rotation, <= 2560 px, < 5 MB) and run DetectFaces on it.
2. Crop each face and SearchFacesByImage; accept the best match that is on the class roster.
   A student is assigned to at most one face per photo.
3. Append the photo's results to the session (several photos per date = union of present).
4. When no other upload for that session is still pending, e-mail roster students who were
   absent this session and whose attendance is below the threshold (once per session).

Free-tier guard: every Rekognition call is counted per month in the Usage table. Past
REK_MONTHLY_CAP the photo is still stored, but not analysed (the teacher marks attendance by
hand), and only the MAX_FACES_PER_PHOTO largest faces are searched.
"""
import io
import json
import os
import time
import urllib.parse
from collections import Counter
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from PIL import Image, ImageOps

s3 = boto3.client("s3")
rek = boto3.client("rekognition")
sns = boto3.client("sns")
ddb = boto3.resource("dynamodb")
students = ddb.Table(os.environ["STUDENTS_TABLE"])
classes = ddb.Table(os.environ["CLASSES_TABLE"])
sessions = ddb.Table(os.environ["SESSIONS_TABLE"])
attendance = ddb.Table(os.environ["ATTENDANCE_TABLE"])
usage = ddb.Table(os.environ["USAGE_TABLE"])
COLLECTION = os.environ["COLLECTION_ID"]
TOPIC = os.environ["TOPIC_ARN"]
THRESHOLD = float(os.environ.get("ATTENDANCE_THRESHOLD", "75"))
MIN_SESSIONS = int(os.environ.get("MIN_SESSIONS_FOR_ALERT", "3"))
MATCH = float(os.environ.get("FACE_MATCH_THRESHOLD", "90"))
REK_CAP = int(os.environ.get("REK_MONTHLY_CAP", "900"))
MAX_FACES = int(os.environ.get("MAX_FACES_PER_PHOTO", "50"))
QUOTA_NOTE = "Monthly Rekognition free-tier cap reached: this photo was not analysed. Mark attendance by hand."

MAX_SIDE = 2560
MAX_BYTES = 5 * 1024 * 1024  # Rekognition limit for images passed as bytes
PENDING_TTL_MS = 10 * 60 * 1000  # an upload URL older than this is treated as abandoned


def log(msg, **fields):
    print(json.dumps({"msg": msg, **fields}, default=str))


def dec(x, places=4):
    return None if x is None else Decimal(str(round(float(x), places)))


def is_conditional_failure(e):
    return e.response["Error"]["Code"] == "ConditionalCheckFailedException"


def reserve_rekognition(group, n):
    """Count n calls of an API group ("group1" = Index/SearchFaces, "group2" = DetectFaces)
    against this month's cap. Returns False, without counting, if they would exceed it."""
    if n <= 0:
        return True
    if n > REK_CAP:
        return False
    try:
        usage.update_item(
            Key={"month": time.strftime("%Y-%m", time.gmtime())},
            UpdateExpression="ADD #g :n",
            ConditionExpression="attribute_not_exists(#g) OR #g <= :limit",
            ExpressionAttributeNames={"#g": group},
            ExpressionAttributeValues={":n": n, ":limit": REK_CAP - n})
        return True
    except ClientError as e:
        if is_conditional_failure(e):
            log("monthly Rekognition cap reached", group=group, requested=n, cap=REK_CAP)
            return False
        raise


def query_all(table, **kw):
    items = []
    while True:
        page = table.query(**kw)
        items += page["Items"]
        if "LastEvaluatedKey" not in page:
            return items
        kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def handler(event, _ctx):
    for rec in event["Records"]:
        bucket = rec["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        parts = key.split("/")
        if len(parts) != 4 or parts[0] != "classes":
            log("unexpected key; ignoring", key=key)
            continue
        _, class_id, date, _name = parts
        process(bucket, key, class_id, date)


# ----------------------------------------------------------------------------- image helpers
def normalize(raw):
    """Upright RGB image (<= MAX_SIDE px) plus JPEG bytes under Rekognition's 5 MB limit."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    while True:
        for quality in (90, 80, 70):
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=quality)
            if buf.tell() <= MAX_BYTES:
                return img, buf.getvalue()
        img.thumbnail((img.width * 3 // 4, img.height * 3 // 4))


def clamp_box(b):
    x1, y1 = max(0.0, b["Left"]), max(0.0, b["Top"])
    x2, y2 = min(1.0, b["Left"] + b["Width"]), min(1.0, b["Top"] + b["Height"])
    return {"left": x1, "top": y1, "width": max(0.0, x2 - x1), "height": max(0.0, y2 - y1)}


def crop_face(img, box, pad=0.25, min_side=160):
    """JPEG bytes of the face plus padding, upscaled so small faces stay searchable."""
    w, h = img.size
    left = max(0, int((box["Left"] - pad * box["Width"]) * w))
    top = max(0, int((box["Top"] - pad * box["Height"]) * h))
    right = min(w, int((box["Left"] + box["Width"] * (1 + pad)) * w))
    bottom = min(h, int((box["Top"] + box["Height"] * (1 + pad)) * h))
    if right - left < 2 or bottom - top < 2:
        return None
    face = img.crop((left, top, right, bottom))
    short = min(face.size)
    if short < min_side:
        scale = min_side / short
        face = face.resize((round(face.width * scale), round(face.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    face.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def match_faces(img, faces, roster, search_limit):
    """[{box, studentId, similarity}] per detected face; each student wins at most one face.
    Only the first `search_limit` faces are searched; the rest stay unknown."""
    results = []
    for i, f in enumerate(faces):
        best = None
        crop = crop_face(img, f["BoundingBox"]) if i < search_limit and roster else None
        if crop:
            try:
                res = rek.search_faces_by_image(
                    CollectionId=COLLECTION, Image={"Bytes": crop},
                    FaceMatchThreshold=MATCH, MaxFaces=5)
                # FaceMatches is sorted by similarity; take the best one on this class's roster.
                best = next((m for m in res["FaceMatches"]
                             if m["Face"].get("ExternalImageId") in roster), None)
            except ClientError as e:
                if e.response["Error"]["Code"] != "InvalidParameterException":  # = no face in crop
                    raise
        results.append({
            "box": f["BoundingBox"],
            "studentId": best["Face"]["ExternalImageId"] if best else None,
            "similarity": best["Similarity"] if best else None,
        })

    winner = {}
    for i, r in enumerate(results):
        sid = r["studentId"]
        if sid and (sid not in winner or r["similarity"] > results[winner[sid]]["similarity"]):
            winner[sid] = i
    for i, r in enumerate(results):
        if r["studentId"] and winner[r["studentId"]] != i:
            r["studentId"], r["similarity"] = None, None
    return results


# ----------------------------------------------------------------------------- main flow
def process(bucket, key, class_id, date):
    cls = classes.get_item(Key={"classId": class_id}).get("Item")
    if not cls:
        log("photo for unknown class; ignoring", key=key)
        return
    roster = set(cls.get("studentIds") or [])

    # S3 can deliver an event twice; skip before paying for Rekognition calls.
    # (The conditional update below still guards against two concurrent deliveries.)
    seen = sessions.get_item(Key={"classId": class_id, "date": date},
                             ProjectionExpression="processedKeys").get("Item") or {}
    if key in (seen.get("processedKeys") or set()):
        log("photo already processed", key=key)
        return

    raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    img, jpeg = normalize(raw)
    note = None
    if reserve_rekognition("group2", 1):
        faces = rek.detect_faces(Image={"Bytes": jpeg})["FaceDetails"]
    else:
        faces, note = [], QUOTA_NOTE
    area = lambda f: f["BoundingBox"]["Width"] * f["BoundingBox"]["Height"]  # noqa: E731
    faces.sort(key=area, reverse=True)  # largest (closest, clearest) faces first

    search_limit = min(len(faces), MAX_FACES) if roster else 0
    if not reserve_rekognition("group1", search_limit):
        search_limit, note = 0, QUOTA_NOTE
    elif len(faces) > search_limit and roster:
        note = f"Only the {search_limit} largest of {len(faces)} faces were checked."
    results = match_faces(img, faces, roster, search_limit)
    matched = [r for r in results if r["studentId"]]

    photo = {"key": key, "faces": [
        {"box": {k: dec(v) for k, v in clamp_box(r["box"]).items()},
         "studentId": r["studentId"], "similarity": dec(r["similarity"], 2)}
        for r in results]}
    if note:
        photo["note"] = note
    try:
        session = sessions.update_item(
            Key={"classId": class_id, "date": date},
            UpdateExpression=(
                "SET photos = list_append(if_not_exists(photos, :empty), :photo), "
                "facesDetected = if_not_exists(facesDetected, :zero) + :n "
                "ADD processedKeys :keyset DELETE pendingKeys :keyset"),
            ConditionExpression="attribute_not_exists(processedKeys) OR NOT contains(processedKeys, :key)",
            ExpressionAttributeValues={
                ":empty": [], ":photo": [photo], ":zero": 0, ":n": len(faces),
                ":keyset": {key}, ":key": key},
            ReturnValues="ALL_NEW",
        )["Attributes"]
    except ClientError as e:
        if is_conditional_failure(e):  # S3 delivered the event twice
            log("photo already processed", key=key)
            return
        raise

    for r in matched:
        try:
            attendance.put_item(
                Item={"classId": class_id, "sk": f"{date}#{r['studentId']}", "studentId": r["studentId"],
                      "date": date, "source": "auto", "similarity": dec(r["similarity"], 2), "photoKey": key},
                ConditionExpression="attribute_not_exists(sk)")  # keep earlier/manual marks
        except ClientError as e:
            if not is_conditional_failure(e):
                raise

    emit_metrics(len(faces), len(matched))
    log("photo processed", key=key, faces=len(faces), matched=[r["studentId"] for r in matched])

    if has_fresh_pending(session.get("pendingKeys") or set()):
        log("waiting for other photos of this session before alerting", key=key)
        return
    alert_low_attendance(class_id, cls, date, roster, session)


def has_fresh_pending(pending_keys, now_ms=None):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    for k in pending_keys:
        try:
            issued = int(os.path.basename(k).split("-", 1)[0])
        except ValueError:
            continue
        if now_ms - issued < PENDING_TTL_MS:
            return True
    return False


def emit_metrics(faces, matched):
    """CloudWatch Embedded Metric Format: the log line becomes metrics in namespace CloudAttend."""
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
            "Namespace": "CloudAttend", "Dimensions": [["Service"]],
            "Metrics": [{"Name": n, "Unit": "Count"} for n in ("FacesDetected", "StudentsMatched", "UnmatchedFaces")],
        }]},
        "Service": "ProcessPhoto",
        "FacesDetected": faces, "StudentsMatched": matched, "UnmatchedFaces": faces - matched,
    }))


def alert_low_attendance(class_id, cls, date, roster, session):
    if not roster:
        return
    dates = {s["date"] for s in query_all(
        sessions, KeyConditionExpression=Key("classId").eq(class_id),
        FilterExpression=Attr("photos").exists(),
        ProjectionExpression="#d", ExpressionAttributeNames={"#d": "date"})}
    total = len(dates)
    if total < MIN_SESSIONS:
        return

    rows = query_all(attendance, KeyConditionExpression=Key("classId").eq(class_id),
                     ProjectionExpression="studentId, #d", ExpressionAttributeNames={"#d": "date"})
    attended = Counter(r["studentId"] for r in rows if r["date"] in dates)
    present_today = {r["studentId"] for r in rows if r["date"] == date}
    already_alerted = set(session.get("alertsSent") or set())

    sent = set()
    for sid in sorted(roster - present_today - already_alerted):
        pct = attended[sid] * 100 / total
        if pct >= THRESHOLD:
            continue
        student = students.get_item(Key={"studentId": sid}).get("Item")
        if not student or not student.get("subscribed"):
            continue
        sns.publish(
            TopicArn=TOPIC,
            Subject=f"CloudAttend: low attendance in {cls.get('name', class_id)}"[:100],
            Message=(f"Hi {student.get('name', sid)},\n\nYou were marked absent in "
                     f"{cls.get('name', class_id)} ({class_id}) on {date}. Your attendance is now "
                     f"{pct:.0f}% ({attended[sid]}/{total} sessions), below the required "
                     f"{THRESHOLD:.0f}%.\n\nIf this is a mistake, please contact your teacher."),
            MessageAttributes={"studentId": {"DataType": "String", "StringValue": sid}},
        )
        sent.add(sid)

    if sent:
        sessions.update_item(Key={"classId": class_id, "date": date},
                             UpdateExpression="ADD alertsSent :s", ExpressionAttributeValues={":s": sent})
        log("low-attendance alerts sent", classId=class_id, date=date, students=sorted(sent))
