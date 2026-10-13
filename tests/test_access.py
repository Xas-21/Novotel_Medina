from app.auth import can_write

def test_staff_writes_duty_only():
    assert can_write("staff", "duty") is True
    assert can_write("staff", "night") is False

def test_night_writes_night_only():
    assert can_write("night", "night") is True
    assert can_write("night", "duty") is False

def test_admin_writes_both():
    assert can_write("admin", "duty") is True
    assert can_write("admin", "night") is True

def test_unknown_role_writes_nothing():
    assert can_write("guest", "duty") is False
