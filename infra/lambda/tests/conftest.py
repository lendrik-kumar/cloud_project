"""Shared fixtures: moto-backed DynamoDB/S3/SNS/Cognito plus a scriptable fake Rekognition."""
import importlib.util
import io
import json
import os
import sys
from pathlib import Path

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from PIL import Image

LAMBDA_DIR = Path(__file__).resolve().parents[1]
REGION = "ap-south-1"
BUCKET = "test-photos"

os.environ.update({
    "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "AWS_SESSION_TOKEN": "testing",
    "AWS_DEFAULT_REGION": REGION, "AWS_REGION": REGION,
    "STUDENTS_TABLE": "Students", "CLASSES_TABLE": "Classes",
    "SESSIONS_TABLE": "Sessions", "ATTENDANCE_TABLE": "Attendance", "USAGE_TABLE": "Usage",
    "COLLECTION_ID": "test-collection", "PHOTOS_BUCKET": BUCKET,
    "ATTENDANCE_THRESHOLD": "75", "MIN_SESSIONS_FOR_ALERT": "3", "FACE_MATCH_THRESHOLD": "90",
    "REK_MONTHLY_CAP": "900", "MAX_FACES_PER_PHOTO": "50",
})


def _table(ddb, name, pk, sk=None, gsi=None):
    keys = [{"AttributeName": pk, "KeyType": "HASH"}] + ([{"AttributeName": sk, "KeyType": "RANGE"}] if sk else [])
    attrs = {pk, sk} - {None}
    kw = {}
    if gsi:
        attrs |= {gsi[1], gsi[2]}
        kw["GlobalSecondaryIndexes"] = [{
            "IndexName": gsi[0],
            "KeySchema": [{"AttributeName": gsi[1], "KeyType": "HASH"}, {"AttributeName": gsi[2], "KeyType": "RANGE"}],
            "Projection": {"ProjectionType": "ALL"}}]
    ddb.create_table(TableName=name, KeySchema=keys, BillingMode="PAY_PER_REQUEST",
                     AttributeDefinitions=[{"AttributeName": a, "AttributeType": "S"} for a in sorted(attrs)], **kw)


class FakeRekognition:
    """Scriptable stand-in for the Rekognition client (moto doesn't model face collections)."""

    def __init__(self):
        self.detect_results = []   # queue of FaceDetails lists, one per detect_faces call
        self.search_results = []   # queue of FaceMatches lists, one per search_faces_by_image call
        self.index_result = None
        self.deleted = []
        self.calls = []

    def detect_faces(self, **kw):
        self.calls.append(("detect_faces", kw))
        return {"FaceDetails": self.detect_results.pop(0)}

    def search_faces_by_image(self, **kw):
        self.calls.append(("search_faces_by_image", kw))
        result = self.search_results.pop(0)
        if result == "NO_FACE":
            raise ClientError({"Error": {"Code": "InvalidParameterException", "Message": "no face"}},
                              "SearchFacesByImage")
        return {"FaceMatches": result}

    def index_faces(self, **kw):
        self.calls.append(("index_faces", kw))
        return self.index_result

    def delete_faces(self, **kw):
        self.deleted += kw["FaceIds"]
        return {"DeletedFaces": kw["FaceIds"]}


class SpySNS:
    def __init__(self):
        self.published, self.subscribed = [], []

    def publish(self, **kw):
        self.published.append(kw)
        return {"MessageId": "m"}

    def subscribe(self, **kw):
        self.subscribed.append(kw)
        return {"SubscriptionArn": "pending confirmation"}


def face(left, top, width=0.1, height=0.15):
    return {"BoundingBox": {"Left": left, "Top": top, "Width": width, "Height": height}, "Confidence": 99.9}


def match(student_id, similarity):
    return {"Similarity": similarity, "Face": {"FaceId": f"f-{student_id}", "ExternalImageId": student_id}}


def jpeg_bytes(w=800, h=600):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 140, 160)).save(buf, "JPEG")
    return buf.getvalue()


def s3_event(key):
    return {"Records": [{"s3": {"bucket": {"name": BUCKET}, "object": {"key": key}}}]}


def load(name):
    """Import lambda/<name>/handler.py fresh (inside the moto mock) under a unique module name."""
    mod_name = f"{name}_handler"
    sys.modules.pop(mod_name, None)
    spec = importlib.util.spec_from_file_location(mod_name, LAMBDA_DIR / name / "handler.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def aws():
    with mock_aws():
        ddb = boto3.client("dynamodb", region_name=REGION)
        _table(ddb, "Students", "studentId")
        _table(ddb, "Classes", "classId")
        _table(ddb, "Sessions", "classId", "date")
        _table(ddb, "Attendance", "classId", "sk", gsi=("by-student", "studentId", "date"))
        _table(ddb, "Usage", "month")
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        os.environ["TOPIC_ARN"] = boto3.client("sns", region_name=REGION).create_topic(Name="alerts")["TopicArn"]

        idp = boto3.client("cognito-idp", region_name=REGION)
        pool_id = idp.create_user_pool(
            PoolName="p", UsernameAttributes=["email"],
            Schema=[{"Name": "studentId", "AttributeDataType": "String", "Mutable": False}])["UserPool"]["Id"]
        for g in ("teacher", "student"):
            idp.create_group(UserPoolId=pool_id, GroupName=g)
        os.environ["USER_POOL_ID"] = pool_id

        res = boto3.resource("dynamodb", region_name=REGION)
        yield {"ddb": res, "s3": boto3.client("s3", region_name=REGION), "idp": idp, "pool_id": pool_id,
               "tables": {n: res.Table(n) for n in ("Students", "Classes", "Sessions", "Attendance", "Usage")}}


# ----------------------------------------------------------------------------- API helpers
TEACHER = {"sub": "teacher-1", "email": "t@example.com", "cognito:groups": "teacher"}
TEACHER2 = {"sub": "teacher-2", "email": "t2@example.com", "cognito:groups": "teacher"}


def student_claims(sid):
    return {"sub": f"sub-{sid}", "email": f"{sid}@example.com", "cognito:groups": "student", "custom:studentId": sid}


def call(api, method, resource, claims, path=None, body=None):
    event = {"httpMethod": method, "resource": resource, "pathParameters": path,
             "body": json.dumps(body) if body is not None else None,
             "requestContext": {"authorizer": {"claims": claims}}}
    r = api.handler(event, None)
    return r["statusCode"], json.loads(r["body"])
