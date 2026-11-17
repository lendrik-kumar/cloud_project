import time

import pytest

from conftest import BUCKET, FakeRekognition, SpySNS, face, jpeg_bytes, load, match, s3_event


@pytest.fixture
def proc(aws):
    mod = load("process_photo")
    mod.rek, mod.sns = FakeRekognition(), SpySNS()
    t = aws["tables"]
    t["Classes"].put_item(Item={"classId": "CS101", "name": "Cloud", "teacherSub": "teacher-1",
                                "studentIds": {"s1", "s2", "s3"}})
    for sid in ("s1", "s2", "s3", "outsider"):
        t["Students"].put_item(Item={"studentId": sid, "name": sid.upper(), "email": f"{sid}@x.com",
                                     "subscribed": sid != "s3"})
    return mod


def upload(aws, date, n=None):
    key = f"classes/CS101/{date}/{n if n is not None else int(time.time() * 1000)}-abc.jpg"
    aws["s3"].put_object(Bucket=BUCKET, Key=key, Body=jpeg_bytes())
    return key


def present(aws, date):
    rows = aws["tables"]["Attendance"].query(
        KeyConditionExpression="classId = :c AND begins_with(sk, :d)",
        ExpressionAttributeValues={":c": "CS101", ":d": f"{date}#"})["Items"]
    return {r["studentId"] for r in rows}


def session(aws, date):
    return aws["tables"]["Sessions"].get_item(Key={"classId": "CS101", "date": date})["Item"]


def test_matches_only_roster_students(proc, aws):
    key = upload(aws, "2026-11-17")
    proc.rek.detect_results = [[face(0.1, 0.1), face(0.5, 0.1), face(0.8, 0.5)]]
    proc.rek.search_results = [
        [match("outsider", 99.5), match("s1", 97.0)],  # best overall isn't enrolled in CS101
        [match("outsider", 98.0)],                      # only an outsider -> unknown face
        "NO_FACE",                                      # Rekognition found no face in the crop
    ]
    proc.handler(s3_event(key), None)

    assert present(aws, "2026-11-17") == {"s1"}
    s = session(aws, "2026-11-17")
    assert s["facesDetected"] == 3
    faces = s["photos"][0]["faces"]
    assert [f["studentId"] for f in faces] == ["s1", None, None]
    assert float(faces[0]["similarity"]) == 97.0
    assert set(faces[0]["box"]) == {"left", "top", "width", "height"}
    # DetectFaces got normalised bytes, searches got crops
    assert "Bytes" in proc.rek.calls[0][1]["Image"]


def test_student_counted_once_per_photo(proc, aws):
    key = upload(aws, "2026-11-17")
    proc.rek.detect_results = [[face(0.1, 0.1), face(0.5, 0.1)]]
    proc.rek.search_results = [[match("s1", 91.0)], [match("s1", 99.0)]]
    proc.handler(s3_event(key), None)
    assert [f["studentId"] for f in session(aws, "2026-11-17")["photos"][0]["faces"]] == [None, "s1"]


def test_boxes_are_clamped_to_image(proc, aws):
    key = upload(aws, "2026-11-17")
    proc.rek.detect_results = [[face(-0.05, 0.9, 0.2, 0.2)]]
    proc.rek.search_results = [[]]
    proc.handler(s3_event(key), None)
    box = {k: float(v) for k, v in session(aws, "2026-11-17")["photos"][0]["faces"][0]["box"].items()}
    assert box["left"] == 0.0 and box["top"] == 0.9
    assert box["width"] == pytest.approx(0.15) and box["height"] == pytest.approx(0.1)


def test_multiple_photos_union_and_duplicate_events(proc, aws):
    k1, k2 = upload(aws, "2026-11-17", 1), upload(aws, "2026-11-17", 2)
    proc.rek.detect_results = [[face(0.1, 0.1)], [face(0.4, 0.4)]]
    proc.rek.search_results = [[match("s1", 95.0)], [match("s2", 96.0)]]
    proc.handler(s3_event(k1), None)
    proc.handler(s3_event(k2), None)
    proc.handler(s3_event(k2), None)  # S3 may deliver an event twice

    s = session(aws, "2026-11-17")
    assert [p["key"] for p in s["photos"]] == [k1, k2]
    assert s["facesDetected"] == 2
    assert present(aws, "2026-11-17") == {"s1", "s2"}


def test_auto_match_keeps_manual_mark(proc, aws):
    aws["tables"]["Attendance"].put_item(Item={"classId": "CS101", "sk": "2026-11-17#s1", "studentId": "s1",
                                               "date": "2026-11-17", "source": "manual"})
    key = upload(aws, "2026-11-17")
    proc.rek.detect_results = [[face(0.1, 0.1)]]
    proc.rek.search_results = [[match("s1", 95.0)]]
    proc.handler(s3_event(key), None)
    row = aws["tables"]["Attendance"].get_item(Key={"classId": "CS101", "sk": "2026-11-17#s1"})["Item"]
    assert row["source"] == "manual"


def run_session(proc, aws, date, matched):
    key = upload(aws, date)
    proc.rek.detect_results.append([face(0.1 * i, 0.1) for i in range(len(matched))])
    proc.rek.search_results += [[match(sid, 95.0)] for sid in matched]
    proc.handler(s3_event(key), None)


def test_alerts_absent_low_attendance_students_once(proc, aws):
    proc.MIN_SESSIONS = 2
    run_session(proc, aws, "2026-11-10", ["s1", "s2"])
    assert proc.sns.published == []  # only 1 session so far (< MIN_SESSIONS)

    run_session(proc, aws, "2026-11-11", ["s1"])
    # s2: 1/2 = 50% and absent -> alert. s3: 0% but not subscribed. s1: present.
    assert [m["MessageAttributes"]["studentId"]["StringValue"] for m in proc.sns.published] == ["s2"]
    assert "50%" in proc.sns.published[0]["Message"]
    assert session(aws, "2026-11-11")["alertsSent"] == {"s2"}

    # A second photo for the same session must not e-mail s2 again.
    run_session(proc, aws, "2026-11-11", [])
    assert len(proc.sns.published) == 1


def test_no_alert_while_other_uploads_pending(proc, aws):
    proc.MIN_SESSIONS = 1
    pending = f"classes/CS101/2026-11-12/{int(time.time() * 1000)}-zzz.jpg"
    aws["tables"]["Sessions"].put_item(Item={"classId": "CS101", "date": "2026-11-12", "pendingKeys": {pending}})
    run_session(proc, aws, "2026-11-12", ["s1"])
    assert proc.sns.published == []

    # An abandoned upload (older than the TTL) doesn't block alerts.
    assert not proc.has_fresh_pending({"classes/CS101/2026-11-12/1000-old.jpg"})
    assert proc.has_fresh_pending({pending})


def test_unknown_class_is_ignored(proc, aws):
    key = "classes/NOPE/2026-11-17/1-a.jpg"
    aws["s3"].put_object(Bucket=BUCKET, Key=key, Body=jpeg_bytes())
    proc.handler(s3_event(key), None)
    assert proc.rek.calls == []


def test_large_photo_is_downscaled_under_limit(proc):
    big = jpeg_bytes(5000, 3500)
    img, data = proc.normalize(big)
    assert max(img.size) <= proc.MAX_SIDE and len(data) <= proc.MAX_BYTES
