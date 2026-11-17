"""S3 upload to enroll/<studentId>.jpg -> check for exactly one face, index it in Rekognition.

Sets Students.enrollStatus to INDEXED, NO_FACE, MULTIPLE_FACES or ERROR. Re-enrolling replaces
the student's previous face in the collection. The first successful enrollment subscribes the
student's e-mail to the low-attendance SNS topic (filtered to their own studentId).
Rekognition calls count against the same monthly free-tier cap as process_photo.
"""
import json
import os
import time
import urllib.parse

import boto3
from botocore.exceptions import ClientError

rek = boto3.client("rekognition")
sns = boto3.client("sns")
ddb = boto3.resource("dynamodb")
students = ddb.Table(os.environ["STUDENTS_TABLE"])
usage = ddb.Table(os.environ["USAGE_TABLE"])
COLLECTION = os.environ["COLLECTION_ID"]
TOPIC = os.environ["TOPIC_ARN"]
REK_CAP = int(os.environ.get("REK_MONTHLY_CAP", "900"))
QUOTA_ERROR = "Monthly Rekognition free-tier cap reached; try again next month"


def log(msg, **fields):
    print(json.dumps({"msg": msg, **fields}, default=str))


def reserve_rekognition(group, n=1):
    """Same monthly counter as process_photo ("group1" = IndexFaces, "group2" = DetectFaces)."""
    try:
        usage.update_item(
            Key={"month": time.strftime("%Y-%m", time.gmtime())},
            UpdateExpression="ADD #g :n",
            ConditionExpression="attribute_not_exists(#g) OR #g <= :limit",
            ExpressionAttributeNames={"#g": group},
            ExpressionAttributeValues={":n": n, ":limit": REK_CAP - n})
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            log("monthly Rekognition cap reached", group=group, cap=REK_CAP)
            return False
        raise


def handler(event, _ctx):
    for rec in event["Records"]:
        bucket = rec["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        student_id = os.path.splitext(os.path.basename(key))[0]
        enroll(bucket, key, student_id)


def set_fields(student_id, **fields):
    names, values, parts = {}, {}, []
    for i, (k, v) in enumerate(fields.items()):
        names[f"#f{i}"] = k
        values[f":v{i}"] = v
        parts.append(f"#f{i} = :v{i}")
    students.update_item(
        Key={"studentId": student_id},
        UpdateExpression="SET " + ", ".join(parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def enroll(bucket, key, student_id):
    item = students.get_item(Key={"studentId": student_id}).get("Item")
    if not item:
        log("no student row for enrollment photo; ignoring", key=key)
        return

    image = {"S3Object": {"Bucket": bucket, "Name": key}}
    if not reserve_rekognition("group2"):
        set_fields(student_id, enrollStatus="ERROR", enrollError=QUOTA_ERROR)
        return
    try:
        faces = rek.detect_faces(Image=image)["FaceDetails"]
    except ClientError as e:
        log("detect_faces failed", key=key, error=str(e))
        set_fields(student_id, enrollStatus="ERROR", enrollError=e.response["Error"]["Code"])
        return

    if len(faces) == 0:
        set_fields(student_id, enrollStatus="NO_FACE", enrollError="No face found in the photo")
        return
    if len(faces) > 1:
        set_fields(student_id, enrollStatus="MULTIPLE_FACES",
                   enrollError=f"{len(faces)} faces found; use a photo with only the student")
        return

    if not reserve_rekognition("group1"):
        set_fields(student_id, enrollStatus="ERROR", enrollError=QUOTA_ERROR)
        return
    resp = rek.index_faces(
        CollectionId=COLLECTION, Image=image, ExternalImageId=student_id,
        MaxFaces=1, QualityFilter="AUTO", DetectionAttributes=[],
    )
    if not resp["FaceRecords"]:
        set_fields(student_id, enrollStatus="NO_FACE",
                   enrollError="Face too small, blurry or dark; retake the photo")
        return

    new_face_id = resp["FaceRecords"][0]["Face"]["FaceId"]
    old_face_id = item.get("faceId")
    if old_face_id and old_face_id != new_face_id:
        try:
            rek.delete_faces(CollectionId=COLLECTION, FaceIds=[old_face_id])
        except ClientError as e:  # stale face is harmless; don't fail the enrollment
            log("delete_faces failed", faceId=old_face_id, error=str(e))

    set_fields(student_id, enrollStatus="INDEXED", faceId=new_face_id, enrollError="")
    log("enrolled", studentId=student_id, faceId=new_face_id)

    if item.get("email") and not item.get("subscribed"):
        sns.subscribe(
            TopicArn=TOPIC, Protocol="email", Endpoint=item["email"],
            Attributes={"FilterPolicy": json.dumps({"studentId": [student_id]})},
        )
        set_fields(student_id, subscribed=True)
