"""Tender inbox: the atomic store and the /api/tenders endpoints (no index or model needed)."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rag import config, tenders
from rag.api import app


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Each test gets its own empty tender file, so the order of the tests does not matter."""
    path = tmp_path / "inbox" / "tenders.json"
    monkeypatch.setattr(config, "TENDERS_FILE", path)
    return path


@pytest.fixture(scope="module")
def client():
    # Without "with", the startup (index build, model loading) does not run: the inbox does not need it.
    return TestClient(app)


def tender(tender_id: str) -> dict:
    return {"tender_id": tender_id, "title": "Tender " + tender_id, "deadline": "2026-11-20",
            "rag_analysis": {"tender_id": tender_id, "requirements_matrix": []}}


def stored_ids() -> list[str]:
    return sorted(t["tender_id"] for t in tenders.list_all())


def test_delete_one_keeps_the_others(store):
    for tender_id in ("A", "B", "C"):
        tenders.save(tender(tender_id))
    assert tenders.delete("B") is True
    assert stored_ids() == ["A", "C"]
    assert tenders.delete("B") is False  # already gone
    assert tenders.delete("unknown") is False
    assert json.loads(store.read_text(encoding="utf-8")) == {"A": tender("A"), "C": tender("C")}
    assert not store.with_suffix(".tmp").exists()


def test_clear_empties_the_store_and_the_inbox_keeps_working(store):
    assert tenders.clear() == 0 and not store.exists()  # nothing to clear: no file is created
    for i in range(3):
        tenders.save(tender(f"T{i}"))
    assert tenders.clear() == 3
    assert tenders.list_all() == [] and json.loads(store.read_text(encoding="utf-8")) == {}
    assert tenders.clear() == 0
    tenders.save(tender("NEW"))
    assert stored_ids() == ["NEW"]


def test_clear_replaces_a_damaged_store(store):
    store.parent.mkdir(parents=True)
    store.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        tenders.list_all()
    assert tenders.clear() == 0
    assert tenders.list_all() == []


def test_a_failed_write_keeps_the_previous_store(store, monkeypatch):
    tenders.save(tender("A"))
    tenders.save(tender("B"))

    def disk_full(self, target):
        raise OSError("simulated disk failure")
    monkeypatch.setattr(Path, "replace", disk_full)
    with pytest.raises(OSError):
        tenders.delete("A")
    with pytest.raises(OSError):
        tenders.clear()
    # The store file is only ever replaced whole, so it still holds both tenders.
    assert json.loads(store.read_text(encoding="utf-8")) == {"A": tender("A"), "B": tender("B")}


def test_concurrent_saves_and_deletes_lose_nothing(store):
    ids = [f"TN-{i:02d}" for i in range(40)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda tender_id: tenders.save(tender(tender_id)), ids))
    assert stored_ids() == ids
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert all(pool.map(tenders.delete, ids[::2]))
    assert stored_ids() == ids[1::2]


def test_api_deletes_one_tender(store, client):
    for tender_id in ("TN-1", "TN-2"):
        tenders.save(tender(tender_id))
    r = client.delete("/api/tenders/TN-1")
    assert r.status_code == 200 and r.json() == {"deleted": "TN-1"}
    assert client.get("/api/tenders/TN-1").status_code == 404
    assert [t["tender_id"] for t in client.get("/api/tenders").json()["tenders"]] == ["TN-2"]
    missing = client.delete("/api/tenders/TN-1")
    assert missing.status_code == 404 and missing.json()["detail"] == "Tender not found"


def test_api_handles_ids_with_a_slash(store, client):
    tenders.save(tender("BOAMP/26-101240"))
    assert client.get("/api/tenders/BOAMP%2F26-101240").json()["tender_id"] == "BOAMP/26-101240"
    assert client.delete("/api/tenders/BOAMP%2F26-101240").json() == {"deleted": "BOAMP/26-101240"}
    assert stored_ids() == []


def test_api_clears_all_tenders(store, client):
    for tender_id in ("TN-1", "TN-2", "TN-3"):
        tenders.save(tender(tender_id))
    # A trailing slash names an (empty) tender ID: it must never clear the whole inbox.
    assert client.delete("/api/tenders/").status_code == 404
    assert len(stored_ids()) == 3
    r = client.delete("/api/tenders")
    assert r.status_code == 200 and r.json() == {"deleted": 3}
    assert client.get("/api/tenders").json() == {"tenders": []}
    assert client.delete("/api/tenders").json() == {"deleted": 0}
