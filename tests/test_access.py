import pytest
from app.auth import can_write, create_access_token, signing_key


def test_signing_key_is_required(monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError, match="Set SECRET_KEY"):
        signing_key()
    with pytest.raises(RuntimeError, match="Set SECRET_KEY"):
        create_access_token({"sub": "usr_test"})


def test_staff_covers_duty_and_night():
    assert can_write("staff", "duty") is True
    assert can_write("staff", "night") is True
    assert can_write("staff", "guest") is True

def test_night_writes_night_only():
    assert can_write("night", "night") is True
    assert can_write("night", "duty") is False
    assert can_write("night", "guest") is False

def test_guest_relation_writes_guest_only():
    assert can_write("guest", "guest") is True
    assert can_write("guest", "duty") is False
    assert can_write("guest", "night") is False

def test_admin_writes_both():
    assert can_write("admin", "duty") is True
    assert can_write("admin", "night") is True
    assert can_write("admin", "guest") is True

def test_unknown_role_writes_nothing():
    assert can_write("visitor", "duty") is False

def test_parking_roles():
    for role in ("admin", "staff", "night", "guest", "parking"):
        assert can_write(role, "parking") is True
    for section in ("duty", "night", "guest"):
        assert can_write("parking", section) is False
