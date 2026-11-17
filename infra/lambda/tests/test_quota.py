"""Free-tier guard: Rekognition calls are capped per month."""
import time

import pytest

from conftest import BUCKET, FakeRekognition, SpySNS, face, jpeg_bytes, load, match, s3_event

MONTH = time.strftime("%Y-%m", time.gmtime())


def usage(aws):
    return aws["tables"]["Usage"].get_item(Key={"month": MONTH}).get("Item", {})


@pytest.fixture
def proc(aws):
    mod = load("process_photo")
    mod.rek, mod.sns = FakeRekognition(), SpySNS()
    aws["tables"]["Classes"].put_item(Item={"classId": "CS101", "name": "Cloud", "teacherSub": "t",
                                            "studentIds": {"s1", "s2"}})
    return mod


def upload(aws, name="1-a.jpg"):
    key = f"classes/CS101/2026-11-17/{name}"
    aws["s3"].put_object(Bucket=BUCKET, Key=key, Body=jpeg_bytes())
    return key


def photo(aws):
    return aws["tables"]["Sessions"].get_item(Key={"classId": "CS101", "date": "2026-11-17"})["Item"]["photos"][-1]


def test_calls_are_counted(proc, aws):
    proc.rek.detect_results = [[face(0.1, 0.1), face(0.5, 0.1)]]
    proc.rek.search_results = [[match("s1", 95.0)], []]
    proc.handler(s3_event(upload(aws)), None)
    assert (usage(aws)["group2"], usage(aws)["group1"]) == (1, 2)
    assert "note" not in photo(aws)


def test_photo_not_analysed_when_detect_cap_reached(proc, aws):
    proc.REK_CAP = 5
    aws["tables"]["Usage"].put_item(Item={"month": MONTH, "group2": 5})
    proc.handler(s3_event(upload(aws)), None)
    assert proc.rek.calls == []
    p = photo(aws)
    assert p["faces"] == [] and "cap reached" in p["note"]
    assert usage(aws)["group2"] == 5  # a refused reservation isn't counted


def test_faces_unknown_when_search_cap_reached(proc, aws):
    proc.REK_CAP = 5
    aws["tables"]["Usage"].put_item(Item={"month": MONTH, "group1": 4})
    proc.rek.detect_results = [[face(0.1, 0.1), face(0.5, 0.1)]]  # needs 2 searches, only 1 left
    proc.handler(s3_event(upload(aws)), None)
    assert [c[0] for c in proc.rek.calls] == ["detect_faces"]
    p = photo(aws)
    assert [f["studentId"] for f in p["faces"]] == [None, None] and "cap reached" in p["note"]


def test_only_largest_faces_are_searched(proc, aws):
    proc.MAX_FACES = 2
    proc.rek.detect_results = [[face(0.0, 0.0, 0.05, 0.05), face(0.3, 0.3, 0.2, 0.2), face(0.6, 0.6, 0.1, 0.1)]]
    proc.rek.search_results = [[match("s1", 95.0)], [match("s2", 95.0)]]
    proc.handler(s3_event(upload(aws)), None)
    p = photo(aws)
    assert [f["studentId"] for f in p["faces"]] == ["s1", "s2", None]  # sorted largest first
    assert float(p["faces"][0]["box"]["width"]) == pytest.approx(0.2)
    assert "2 largest of 3" in p["note"]
    assert usage(aws)["group1"] == 2


def test_enroll_respects_cap(aws):
    mod = load("enroll")
    mod.rek, mod.sns, mod.REK_CAP = FakeRekognition(), SpySNS(), 3
    aws["tables"]["Students"].put_item(Item={"studentId": "s1", "name": "S1", "email": "s1@x.com"})
    aws["tables"]["Usage"].put_item(Item={"month": MONTH, "group2": 3})
    mod.handler(s3_event("enroll/s1.jpg"), None)
    s = aws["tables"]["Students"].get_item(Key={"studentId": "s1"})["Item"]
    assert s["enrollStatus"] == "ERROR" and "cap reached" in s["enrollError"]
    assert mod.rek.calls == []
