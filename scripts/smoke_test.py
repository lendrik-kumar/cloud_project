#!/usr/bin/env python3
"""End-to-end smoke test against the deployed CloudAttendStack.

Creates a temporary teacher (welcome e-mail suppressed, random password), exercises the API,
pushes ONE blank photo through S3 -> process_photo -> Rekognition (1 DetectFaces call, counted
against the monthly free-tier cap) -> DynamoDB, checks CORS and the website, then deletes
everything it created.

    local/.venv/bin/python scripts/smoke_test.py            # full run
    local/.venv/bin/python scripts/smoke_test.py --no-photo # skip the Rekognition call
"""
import argparse
import datetime as dt
import io
import json
import secrets
import ssl
import sys
import time
import urllib.error
import urllib.request

import boto3
from PIL import Image

try:  # python.org builds ship without a CA bundle
    import certifi
    TLS = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    TLS = ssl.create_default_context()

REGION = "ap-south-1"
STACK = "CloudAttendStack"
USER = "smoke-test-teacher@example.com"
CLASS = "SMOKE1"

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" (got {got!r}, want {want!r})"))
    return ok


def http(method, url, body=None, headers=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30, context=TLS) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-photo", action="store_true", help="don't call Rekognition")
    args = ap.parse_args()

    cfn = boto3.client("cloudformation", region_name=REGION)
    outputs = {o["OutputKey"]: o["OutputValue"] for o in cfn.describe_stacks(StackName=STACK)["Stacks"][0]["Outputs"]}
    api, web = outputs["ApiUrl"].rstrip("/"), outputs["WebUrl"]
    pool, client_id, bucket = outputs["UserPoolId"], outputs["UserPoolClientId"], outputs["PhotosBucketName"]
    idp = boto3.client("cognito-idp", region_name=REGION)
    ddb = boto3.client("dynamodb", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)
    tables = ddb.list_tables()["TableNames"]
    table = lambda part: next(t for t in tables if part in t)  # noqa: E731
    today = dt.date.today().isoformat()

    password = "Aa1#" + secrets.token_urlsafe(18)
    try:
        print("== temporary teacher")
        idp.admin_create_user(UserPoolId=pool, Username=USER, MessageAction="SUPPRESS",
                              UserAttributes=[{"Name": "email", "Value": USER},
                                              {"Name": "email_verified", "Value": "true"}])
        idp.admin_set_user_password(UserPoolId=pool, Username=USER, Password=password, Permanent=True)
        idp.admin_add_user_to_group(UserPoolId=pool, Username=USER, GroupName="teacher")
        token = idp.admin_initiate_auth(
            UserPoolId=pool, ClientId=client_id, AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": USER, "PASSWORD": password})["AuthenticationResult"]["IdToken"]
        check("got ID token", len(token) > 100, True)

        def call(method, path, body=None):
            status, _, raw = http(method, f"{api}/{path}", body,
                                  {"Authorization": token, "Content-Type": "application/json"})
            try:
                return status, json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return status, {"raw": raw[:200]}

        print("== API")
        status, headers, _ = http("GET", f"{api}/classes")
        check("no token -> 401", status, 401)
        check("401 carries CORS header", headers.get("Access-Control-Allow-Origin") or headers.get("access-control-allow-origin"), "*")
        status, me = call("GET", "me")
        check("GET /me", (status, me.get("role")), (200, "teacher"))
        print(f"  rekognitionUsage before: {me.get('rekognitionUsage')}")
        check("POST /classes", call("POST", "classes", {"classId": CLASS, "name": "Smoke test"})[0], 201)
        check("POST /classes duplicate -> 409", call("POST", "classes", {"classId": CLASS, "name": "x"})[0], 409)
        status, body = call("GET", "classes")
        check("GET /classes lists it", (status, [c["classId"] for c in body.get("classes", [])]), (200, [CLASS]))
        check("session 404 before upload", call("GET", f"classes/{CLASS}/sessions/{today}")[0], 404)
        check("bad date -> 400", call("POST", f"classes/{CLASS}/sessions/2026-13-40/upload-url")[0], 400)
        check("student route as teacher: unknown student -> 404",
              call("GET", "reports/student/nobody")[0], 404)

        if not args.no_photo:
            print("== pipeline: 1 blank photo (1 DetectFaces call)")
            status, body = call("POST", f"classes/{CLASS}/sessions/{today}/upload-url")
            check("upload-url", status, 200)
            url = body.get("uploadUrl", "")
            check("regional S3 endpoint", f"s3.{REGION}.amazonaws.com" in url, True)
            buf = io.BytesIO()
            Image.new("RGB", (640, 480), (90, 120, 150)).save(buf, "JPEG")
            check("PUT photo to S3", http("PUT", url, buf.getvalue(), {"Content-Type": "image/jpeg"})[0], 200)
            for _ in range(30):
                status, session = call("GET", f"classes/{CLASS}/sessions/{today}")
                if status == 200:
                    break
                time.sleep(2)
            check("session processed within 60 s", status, 200)
            if status == 200:
                photos = session["session"]["photos"]
                check("1 photo, 0 faces", (len(photos), session["session"]["facesDetected"]), (1, 0))
                check("photo view URL works", http("GET", photos[0]["url"])[0], 200)
            status, report = call("GET", f"reports/class/{CLASS}")
            check("class report", (status, report.get("totalSessions")), (200, 1))
            check("sessions list", call("GET", f"classes/{CLASS}/sessions")[0], 200)
            print(f"  rekognitionUsage after: {call('GET', 'me')[1].get('rekognitionUsage')}")

        print("== CORS + website")
        status, headers, _ = http("OPTIONS", f"{api}/classes", headers={
            "Origin": web, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type"})
        check("API preflight", status, 204 if status == 204 else 200)
        s3_url = f"https://{bucket}.s3.{REGION}.amazonaws.com/classes/x.jpg"
        status, headers, _ = http("OPTIONS", s3_url, headers={"Origin": web, "Access-Control-Request-Method": "PUT"})
        check("S3 preflight from dashboard origin", (status, headers.get("Access-Control-Allow-Origin")), (200, web))
        status, _, _ = http("OPTIONS", s3_url, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
        check("S3 preflight from other origin denied", status, 403)
        check("photo bucket not public", http("GET", f"https://{bucket}.s3.{REGION}.amazonaws.com/")[0], 403)
        check("website index", http("GET", web + "/")[0], 200)
        check("SPA deep link -> index.html", http("GET", web + "/classes/abc")[0], 200)
        status, _, raw = http("GET", web + "/config.json")
        check("config.json apiUrl", json.loads(raw).get("apiUrl"), api + "/")
    finally:
        print("== cleanup")
        try:
            idp.admin_delete_user(UserPoolId=pool, Username=USER)
        except idp.exceptions.UserNotFoundException:
            pass
        ddb.delete_item(TableName=table("ClassesTable"), Key={"classId": {"S": CLASS}})
        ddb.delete_item(TableName=table("SessionsTable"), Key={"classId": {"S": CLASS}, "date": {"S": today}})
        for obj in s3.list_objects_v2(Bucket=bucket, Prefix=f"classes/{CLASS}/").get("Contents", []):
            s3.delete_object(Bucket=bucket, Key=obj["Key"])
        print("  removed test user, class, session and photos")

    print(f"== {sum(results)} passed, {len(results) - sum(results)} failed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
