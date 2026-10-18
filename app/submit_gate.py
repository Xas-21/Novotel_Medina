"""Sections that must be finished before a duty or night report can be submitted."""

SOMOU = "Somou Taxi on Duty?"
CAFETERIA_TITLE = "Staff Cafeteria Audit"


def _catalog():
    from app.routes.reports import AREA_SECTIONS, CAFETERIA_ITEMS
    return AREA_SECTIONS, CAFETERIA_ITEMS


def night_sections():
    sections, _items = _catalog()
    built = []
    for sec in sections:
        if sec["key"] != "publicAreas":
            built.append(sec)
            continue
        built.append({
            "key": sec["key"],
            "title": sec["title"],
            "items": [item for item in sec["items"] if item != SOMOU],
        })
    return built


def _checked(item):
    if not isinstance(item, dict):
        return False
    return item.get("status") is True or item.get("status") is False


def unchecked_sections(sections, checklists):
    lists = checklists or {}
    missing = []
    for sec in sections:
        rows = lists.get(sec["key"]) or []
        if any(i >= len(rows) or not _checked(rows[i]) for i in range(len(sec["items"]))):
            missing.append(sec["title"])
    return missing


def cafeteria_open(items):
    _sections, cafeteria_items = _catalog()
    rows = items or []
    if any(i >= len(rows) or not _checked(rows[i]) for i in range(len(cafeteria_items))):
        return [CAFETERIA_TITLE]
    return []


def rooms_open(rows):
    named = [row for row in (rows or []) if str((row or {}).get("room") or "").strip()]
    return [] if named else ["Rooms Inspection"]


def courtesy_open(rows):
    def filled(row):
        row = row or {}
        if str(row.get("room") or "").strip() or str(row.get("comment") or "").strip():
            return True
        return row.get("impression") is True or row.get("impression") is False

    return [] if any(filled(row) for row in (rows or [])) else ["Courtesy Calls"]


def duty_missing(body):
    sections, _items = _catalog()
    body = body or {}
    return (
        unchecked_sections(sections, body.get("checklists"))
        + cafeteria_open(body.get("cafeteriaItems"))
        + rooms_open(body.get("roomsInspection"))
        + courtesy_open(body.get("courtesyCalls"))
    )


def night_missing(inspection):
    pack = inspection or {}
    return (
        unchecked_sections(night_sections(), pack.get("checklists"))
        + cafeteria_open(pack.get("cafeteriaItems"))
        + rooms_open(pack.get("roomsInspection"))
    )
