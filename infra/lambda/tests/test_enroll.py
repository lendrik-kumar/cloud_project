import json

import pytest

from conftest import BUCKET, FakeRekognition, SpySNS, face, jpeg_bytes, load, s3_event


@pytest.fixture
def enroll(aws):
    mod = load("enroll")
    mod.rek, mod.sns = FakeRekognition(), SpySNS()
    aws["tables"]["Students"].put_item(Item={"studentId": "s1", "name": "S1", "email": "s1@x.com",
                                             "enrollStatus": "PENDING", "subscribed": False})
    aws["s3"].put_object(Bucket=BUCKET, Key="enroll/s1.jpg", Body=jpeg_bytes())
    return mod


def student(aws):
    return aws["tables"]["Students"].get_item(Key={"studentId": "s1"})["Item"]


def indexed(face_id):
    return {"FaceRecords": [{"Face": {"FaceId": face_id}}], "UnindexedFaces": []}


def test_rejects_photo_without_face(enroll, aws):
    enroll.rek.detect_results = [[]]
    enroll.handler(s3_event("enroll/s1.jpg"), None)
    assert student(aws)["enrollStatus"] == "NO_FACE"


def test_rejects_group_photo(enroll, aws):
    enroll.rek.detect_results = [[face(0.1, 0.1), face(0.5, 0.1)]]
    enroll.handler(s3_event("enroll/s1.jpg"), None)
    s = student(aws)
    assert s["enrollStatus"] == "MULTIPLE_FACES" and "2 faces" in s["enrollError"]


def test_indexes_and_subscribes_once(enroll, aws):
    enroll.rek.detect_results = [[face(0.3, 0.3)]]
    enroll.rek.index_result = indexed("face-1")
    enroll.handler(s3_event("enroll/s1.jpg"), None)

    s = student(aws)
    assert (s["enrollStatus"], s["faceId"], s["subscribed"]) == ("INDEXED", "face-1", True)
    index_call = [kw for name, kw in enroll.rek.calls if name == "index_faces"][0]
    assert index_call["ExternalImageId"] == "s1" and index_call["MaxFaces"] == 1
    assert len(enroll.sns.subscribed) == 1
    assert json.loads(enroll.sns.subscribed[0]["Attributes"]["FilterPolicy"]) == {"studentId": ["s1"]}

    # Re-enrolling replaces the old face and doesn't subscribe again.
    enroll.rek.detect_results = [[face(0.3, 0.3)]]
    enroll.rek.index_result = indexed("face-2")
    enroll.handler(s3_event("enroll/s1.jpg"), None)
    assert student(aws)["faceId"] == "face-2"
    assert enroll.rek.deleted == ["face-1"]
    assert len(enroll.sns.subscribed) == 1


def test_low_quality_face_not_indexed(enroll, aws):
    enroll.rek.detect_results = [[face(0.3, 0.3)]]
    enroll.rek.index_result = {"FaceRecords": [], "UnindexedFaces": [{"Reasons": ["LOW_SHARPNESS"]}]}
    enroll.handler(s3_event("enroll/s1.jpg"), None)
    assert student(aws)["enrollStatus"] == "NO_FACE"


def test_photo_for_unknown_student_is_ignored(enroll, aws):
    aws["s3"].put_object(Bucket=BUCKET, Key="enroll/ghost.jpg", Body=jpeg_bytes())
    enroll.handler(s3_event("enroll/ghost.jpg"), None)
    assert enroll.rek.calls == []
