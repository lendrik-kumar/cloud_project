import pytest

from conftest import TEACHER, TEACHER2, call, load, student_claims


@pytest.fixture
def api(aws):
    return load("api")


def seed_student(aws, sid, name=None):
    aws["tables"]["Students"].put_item(Item={"studentId": sid, "name": name or sid.upper(),
                                             "email": f"{sid}@example.com", "enrollStatus": "INDEXED"})


def make_class(api, aws, class_id="CS101", roster=("s1", "s2")):
    for sid in roster:
        seed_student(aws, sid)
    assert call(api, "POST", "/classes", TEACHER, body={"classId": class_id, "name": "Cloud"})[0] == 201
    status, _ = call(api, "PUT", "/classes/{classId}/students", TEACHER,
                     path={"classId": class_id}, body={"studentIds": list(roster)})
    assert status == 200


def mark(api, class_id, date, sid, present=True):
    return call(api, "PUT", "/classes/{classId}/sessions/{date}/attendance/{studentId}", TEACHER,
                path={"classId": class_id, "date": date, "studentId": sid}, body={"present": present})


def test_me_reports_role_and_rekognition_usage(api, aws):
    import time
    month = time.strftime("%Y-%m", time.gmtime())
    aws["tables"]["Usage"].put_item(Item={"month": month, "group1": 12, "group2": 3})
    status, body = call(api, "GET", "/me", TEACHER)
    assert status == 200 and body["role"] == "teacher" and body["email"] == "t@example.com"
    assert body["rekognitionUsage"] == {"month": month, "cap": 900, "group1": 12, "group2": 3}
    status, body = call(api, "GET", "/me", student_claims("s1"))
    assert status == 200 and body["role"] == "student" and body["studentId"] == "s1"
    assert "rekognitionUsage" not in body


def test_user_without_group_is_rejected(api):
    assert call(api, "GET", "/me", {"sub": "x", "cognito:groups": ""})[0] == 403


def test_create_class_and_duplicate(api):
    status, body = call(api, "POST", "/classes", TEACHER, body={"classId": "CS101", "name": "Cloud"})
    assert status == 201 and body["class"] == {"classId": "CS101", "name": "Cloud", "studentIds": [], "sessionCount": 0}
    assert call(api, "POST", "/classes", TEACHER, body={"classId": "CS101", "name": "x"})[0] == 409
    assert call(api, "POST", "/classes", TEACHER, body={"classId": "bad id!", "name": "x"})[0] == 400


def test_student_cannot_use_teacher_routes(api, aws):
    make_class(api, aws)
    for method, resource, path in [("GET", "/classes", None), ("GET", "/students", None),
                                   ("GET", "/reports/class/{classId}", {"classId": "CS101"})]:
        assert call(api, method, resource, student_claims("s1"), path=path)[0] == 403


def test_classes_are_scoped_to_their_teacher(api, aws):
    make_class(api, aws)
    assert call(api, "GET", "/classes", TEACHER2) == (200, {"classes": []})
    assert call(api, "GET", "/reports/class/{classId}", TEACHER2, path={"classId": "CS101"})[0] == 403


def test_roster_rejects_unknown_students(api, aws):
    make_class(api, aws)
    status, body = call(api, "PUT", "/classes/{classId}/students", TEACHER,
                        path={"classId": "CS101"}, body={"studentIds": ["s1", "ghost"]})
    assert status == 400 and "ghost" in body["error"]
    status, body = call(api, "PUT", "/classes/{classId}/students", TEACHER,
                        path={"classId": "CS101"}, body={"studentIds": []})
    assert status == 200 and body["class"]["studentIds"] == []


def test_create_student_makes_cognito_login(api, aws):
    status, body = call(api, "POST", "/students", TEACHER,
                        body={"studentId": "102403", "name": "Asha", "email": "Asha@Example.com"})
    assert status == 201
    assert body["student"]["enrollStatus"] == "PENDING" and body["student"]["email"] == "asha@example.com"
    assert "s3.ap-south-1.amazonaws.com" in body["uploadUrl"] and "enroll/102403.jpg" in body["uploadUrl"]

    user = aws["idp"].admin_get_user(UserPoolId=aws["pool_id"], Username="asha@example.com")
    attrs = {a["Name"]: a["Value"] for a in user["UserAttributes"]}
    assert attrs["custom:studentId"] == "102403"
    groups = aws["idp"].admin_list_groups_for_user(UserPoolId=aws["pool_id"], Username="asha@example.com")
    assert [g["GroupName"] for g in groups["Groups"]] == ["student"]

    assert call(api, "POST", "/students", TEACHER,
                body={"studentId": "102403", "name": "Asha", "email": "other@example.com"})[0] == 409


def test_create_student_rolls_back_when_login_exists(api, aws):
    call(api, "POST", "/students", TEACHER, body={"studentId": "a1", "name": "A", "email": "same@example.com"})
    status, body = call(api, "POST", "/students", TEACHER,
                        body={"studentId": "a2", "name": "B", "email": "same@example.com"})
    assert status == 409 and "same@example.com" in body["error"]
    assert "Item" not in aws["tables"]["Students"].get_item(Key={"studentId": "a2"})


def test_photo_url_resets_enrollment(api, aws):
    seed_student(aws, "s1")
    status, body = call(api, "POST", "/students/{studentId}/photo-url", TEACHER, path={"studentId": "s1"})
    assert status == 200 and "enroll/s1.jpg" in body["uploadUrl"]
    assert call(api, "GET", "/students/{studentId}", TEACHER, path={"studentId": "s1"})[1]["student"]["enrollStatus"] == "PENDING"
    assert call(api, "POST", "/students/{studentId}/photo-url", TEACHER, path={"studentId": "nope"})[0] == 404


def test_upload_url_registers_pending_key(api, aws):
    make_class(api, aws)
    status, body = call(api, "POST", "/classes/{classId}/sessions/{date}/upload-url", TEACHER,
                        path={"classId": "CS101", "date": "2026-11-17"})
    assert status == 200 and body["key"].startswith("classes/CS101/2026-11-17/") and body["key"].endswith(".jpg")
    session = aws["tables"]["Sessions"].get_item(Key={"classId": "CS101", "date": "2026-11-17"})["Item"]
    assert session["pendingKeys"] == {body["key"]}
    # A session with only a pending upload isn't visible yet.
    assert call(api, "GET", "/classes/{classId}/sessions/{date}", TEACHER,
                path={"classId": "CS101", "date": "2026-11-17"})[0] == 404
    assert call(api, "GET", "/classes/{classId}/sessions", TEACHER, path={"classId": "CS101"})[1] == {"sessions": []}
    assert call(api, "POST", "/classes/{classId}/sessions/{date}/upload-url", TEACHER,
                path={"classId": "CS101", "date": "2026-13-01"})[0] == 400


def test_manual_override_and_reports(api, aws):
    make_class(api, aws, roster=("s1", "s2"))
    assert mark(api, "CS101", "2026-11-10", "s1") == (200, {"studentId": "s1", "present": True})
    assert mark(api, "CS101", "2026-11-11", "s1")[0] == 200
    assert mark(api, "CS101", "2026-11-11", "s2")[0] == 200
    assert mark(api, "CS101", "2026-11-11", "s2", present=False)[0] == 200
    assert mark(api, "CS101", "2026-11-11", "outsider")[0] == 400

    status, report = call(api, "GET", "/reports/class/{classId}", TEACHER, path={"classId": "CS101"})
    assert status == 200 and report["totalSessions"] == 2
    assert report["sessions"] == [{"date": "2026-11-10", "presentCount": 1}, {"date": "2026-11-11", "presentCount": 1}]
    by_id = {s["studentId"]: s for s in report["students"]}
    assert by_id["s1"]["pct"] == 100.0 and not by_id["s1"]["belowThreshold"]
    assert by_id["s2"]["pct"] == 0.0 and by_id["s2"]["belowThreshold"]

    status, session = call(api, "GET", "/classes/{classId}/sessions/{date}", TEACHER,
                           path={"classId": "CS101", "date": "2026-11-11"})
    assert status == 200 and session["session"]["photos"] == []
    assert [p["studentId"] for p in session["present"]] == ["s1"] and session["present"][0]["source"] == "manual"
    assert [a["studentId"] for a in session["absent"]] == ["s2"]

    status, listing = call(api, "GET", "/classes/{classId}/sessions", TEACHER, path={"classId": "CS101"})
    assert [s["date"] for s in listing["sessions"]] == ["2026-11-11", "2026-11-10"]
    assert call(api, "GET", "/classes", TEACHER)[1]["classes"][0]["sessionCount"] == 2


def test_student_sees_only_own_report(api, aws):
    make_class(api, aws, roster=("s1", "s2"))
    mark(api, "CS101", "2026-11-10", "s1")
    status, body = call(api, "GET", "/reports/student/{studentId}", student_claims("s1"), path={"studentId": "s1"})
    assert status == 200
    assert body["classes"] == [{"classId": "CS101", "name": "Cloud", "attended": 1, "total": 1, "pct": 100.0,
                                "belowThreshold": False, "sessionDates": ["2026-11-10"], "presentDates": ["2026-11-10"]}]
    assert call(api, "GET", "/reports/student/{studentId}", student_claims("s1"), path={"studentId": "s2"})[0] == 403
    assert call(api, "GET", "/reports/student/{studentId}", TEACHER, path={"studentId": "s2"})[1]["classes"][0]["pct"] == 0.0
    assert call(api, "GET", "/reports/student/{studentId}", TEACHER2, path={"studentId": "s2"})[1]["classes"] == []


def test_unknown_route_and_bad_body(api):
    assert call(api, "GET", "/nope", TEACHER)[0] == 404
    event = {"httpMethod": "POST", "resource": "/classes", "body": "{not json",
             "requestContext": {"authorizer": {"claims": TEACHER}}}
    assert api.handler(event, None)["statusCode"] == 400
