import json
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import TokenData, can_write, require_admin, require_auth
from app.database import get_db

router = APIRouter(prefix="/api/guest", tags=["guest"])

SCORE_TYPES = [
    ("rps", "RPS"),
    ("trustYou", "TrustYou"),
    ("booking", "Booking"),
    ("google", "Google"),
    ("tripadvisor", "TripAdvisor"),
    ("expedia", "Expedia"),
]
SCORE_KEY = {label: key for key, label in SCORE_TYPES}
TIERS = ["Classic", "Silver", "Gold", "Platinum", "Daimond", "Limitless", "Care Of", "Complementary", "Booking", "Repeated", "Hony Moon", "Others"]
VIPS = ["V1", "V2", "V3"]


class GuestSave(BaseModel):
    date: str
    time: str = ""
    shiftStart: str = ""
    shiftEnd: str = ""
    inCharge: str = ""
    arrivals: str = ""
    departures: str = ""
    occupancy: str = ""
    remarks: str = ""
    scores: Optional[Any] = None
    membership: Optional[List[Dict[str, Any]]] = None
    preArrival: Optional[List[Dict[str, Any]]] = None
    inHouse: Optional[List[Dict[str, Any]]] = None
    departure: Optional[List[Dict[str, Any]]] = None
    generalComments: Optional[List[Dict[str, Any]]] = None


def _parse_date(value: str):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")


def _now() -> str:
    return datetime.utcnow().isoformat()


def _loads(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _blank_scores():
    return []


def _scores_from(incoming):
    rows = []
    if isinstance(incoming, list):
        for item in incoming:
            if not isinstance(item, dict):
                continue
            score_type = _text(item.get("type"))
            if score_type not in SCORE_KEY and score_type:
                continue
            if not score_type and not _text(item.get("ytd")):
                continue
            rows.append({"type": score_type, "ytd": _text(item.get("ytd"))})
        return rows
    if isinstance(incoming, dict):
        for key, label in SCORE_TYPES:
            cell = incoming.get(key) if isinstance(incoming.get(key), dict) else {}
            ytd = _text(cell.get("ytd") or cell.get("mtd"))
            if ytd:
                rows.append({"type": label, "ytd": ytd})
    return rows


def _membership_from(incoming):
    rows = []
    for item in incoming or []:
        if not isinstance(item, dict):
            continue
        tier = _text(item.get("tier") or item.get("name"))
        vip = _text(item.get("vip"))
        arrival = _text(item.get("arrival"))
        in_house = _text(item.get("inHouse"))
        departure = _text(item.get("departure"))
        filled = any([
            arrival, in_house, departure,
            _text(item.get("arrivalRooms")), _text(item.get("inHouseRooms")), _text(item.get("departureRooms")),
        ])
        if "tier" not in item and not filled:
            continue
        if tier and tier not in TIERS:
            tier = ""
        if vip and vip not in VIPS:
            vip = ""
        rows.append({"tier": tier, "vip": vip, "arrival": arrival, "inHouse": in_house, "departure": departure})
    return rows


def _ytd_value(scores, key):
    label = dict(SCORE_TYPES).get(key)
    if isinstance(scores, list):
        found = None
        for item in scores:
            if isinstance(item, dict) and item.get("type") == label:
                found = _number(item.get("ytd"))
        return found
    if isinstance(scores, dict):
        cell = scores.get(key) if isinstance(scores.get(key), dict) else {}
        return _number(cell.get("ytd") or cell.get("mtd"))
    return None


def _text(value) -> str:
    return "" if value is None else str(value)


def _rows(items, fields):
    rows = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        rows.append({field: _text(item.get(field)) for field in fields})
    return rows


def _body_from_save(data: GuestSave) -> dict:
    return {
        "shiftStart": _text(data.shiftStart) or _text(data.time),
        "shiftEnd": _text(data.shiftEnd),
        "inCharge": _text(data.inCharge),
        "arrivals": _text(data.arrivals),
        "departures": _text(data.departures),
        "occupancy": "",
        "remarks": _text(data.remarks),
        "scores": _scores_from(data.scores),
        "membership": _membership_from(data.membership),
        "preArrival": _rows(data.preArrival, ["reservation", "name", "membership", "arrival", "departure", "arrivalTime", "preferences", "action", "contacted", "priority"]),
        "inHouse": _rows(data.inHouse, ["room", "name", "membership", "arrival", "departure", "satisfaction", "request", "service", "drink", "fb", "action", "contacted", "feedback", "priority"]),
        "departure": _rows(data.departure, ["room", "name", "membership", "arrival", "departure", "score", "feedback", "review", "action", "contacted", "employeeRating", "priority"]),
        "generalComments": _rows(data.generalComments, ["comment", "time"]),
    }


async def _hotel_rooms(db) -> int:
    cursor = await db.execute("SELECT value FROM settings WHERE key = 'hotel_rooms'")
    row = await cursor.fetchone()
    try:
        return int(row["value"]) if row else 394
    except (TypeError, ValueError):
        return 394


def _vip_occ(arrivals, rooms: int) -> str:
    raw = _text(arrivals).replace(",", "").strip()
    if not raw or rooms <= 0:
        return ""
    try:
        occupied = Decimal(raw)
    except InvalidOperation:
        return ""
    percent = (occupied / Decimal(rooms) * Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return str(int(percent))


def _apply_occ(payload, rooms: int):
    payload["roomsAvailable"] = rooms
    payload["occupancy"] = _vip_occ(payload.get("arrivals"), rooms)
    return payload


def _require_write(user: TokenData):
    if not can_write(user.role, "guest"):
        raise HTTPException(status_code=403, detail="Guest Relation is read-only for this user")


async def _get_row(db, date: str):
    cursor = await db.execute("SELECT * FROM guest_reports WHERE date = ?", (date,))
    return await cursor.fetchone()


async def _submitted_by(db, user_id: str) -> str:
    cursor = await db.execute("SELECT first_name, last_name, title FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    if not row:
        return ""
    name = f"{row['first_name']} {row['last_name']}".strip()
    title = (row["title"] or "").strip()
    return f"{name} — {title}" if title else name


def _public(date: str, row):
    body = _body_from_save(GuestSave(date=date, **_loads(row["body_json"], {}))) if row else _body_from_save(GuestSave(date=date))
    payload = {"date": date, **body, "submittedAt": row["submitted_at"] if row else None, "submittedBy": row["submitted_by"] if row else None}
    if row:
        payload["status"] = row["status"]
    return payload


async def _ready(db, date: str, row):
    return _apply_occ(_public(date, row), await _hotel_rooms(db))


def _number(value):
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


@router.get("")
async def get_guest(date: str, _: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _parse_date(date)
    return await _ready(db, date, await _get_row(db, date))


@router.put("")
async def save_guest(data: GuestSave, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    _parse_date(data.date)
    row = await _get_row(db, data.date)
    if row and row["status"] == "submitted" and user.role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can edit a submitted report.")
    now = _now()
    body = json.dumps(_body_from_save(data))
    if row:
        await db.execute("UPDATE guest_reports SET body_json = ?, updated_at = ? WHERE date = ?", (body, now, data.date))
    else:
        await db.execute(
            "INSERT INTO guest_reports (date, status, body_json, created_at, updated_at) VALUES (?, 'draft', ?, ?, ?)",
            (data.date, body, now, now),
        )
    await db.commit()
    return await _ready(db, data.date, await _get_row(db, data.date))


@router.post("/submit")
async def submit_guest(date: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    _parse_date(date)
    now = _now()
    submitted_by = await _submitted_by(db, user.user_id)
    row = await _get_row(db, date)
    if row:
        await db.execute(
            "UPDATE guest_reports SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = ? WHERE date = ?",
            (now, submitted_by, now, date),
        )
    else:
        await db.execute(
            "INSERT INTO guest_reports (date, status, submitted_at, submitted_by, body_json, created_at, updated_at) VALUES (?, 'submitted', ?, ?, ?, ?, ?)",
            (date, now, submitted_by, json.dumps(_body_from_save(GuestSave(date=date))), now, now),
        )
    await db.commit()
    return await _ready(db, date, await _get_row(db, date))


@router.post("/reopen")
async def reopen_guest(date: str, _: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    _parse_date(date)
    if not await _get_row(db, date):
        raise HTTPException(status_code=404, detail="Guest Relation report not found")
    await db.execute(
        "UPDATE guest_reports SET status = 'draft', submitted_at = NULL, submitted_by = NULL, updated_at = ? WHERE date = ?",
        (_now(), date),
    )
    await db.commit()
    return {"success": True, "date": date}


@router.delete("")
async def delete_guest(date: str, _: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    _parse_date(date)
    if not await _get_row(db, date):
        raise HTTPException(status_code=404, detail="Guest Relation report not found")
    await db.execute("DELETE FROM guest_reports WHERE date = ?", (date,))
    await db.commit()
    return {"success": True, "date": date}


@router.get("/index")
async def guest_index(_: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    rooms = await _hotel_rooms(db)
    cursor = await db.execute("SELECT date, status, submitted_by, body_json FROM guest_reports ORDER BY date DESC")
    items = []
    for row in await cursor.fetchall():
        body = _loads(row["body_json"], {})
        items.append({
            "date": row["date"],
            "status": row["status"],
            "submittedBy": row["submitted_by"],
            "occupancy": _vip_occ(body.get("arrivals"), rooms),
        })
    return items


@router.get("/analysis")
async def guest_analysis(
    date: str,
    range: str = Query("week", pattern="^(week|month)$"),
    start: str | None = None,
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    end = _parse_date(date)
    if start:
        start_day = _parse_date(start)
    elif range == "week":
        start_day = end - timedelta(days=6)
    else:
        start_day = end.replace(day=1)
    cursor = await db.execute(
        "SELECT date, status, body_json FROM guest_reports WHERE date >= ? AND date <= ? ORDER BY date",
        (start_day.isoformat(), end.isoformat()),
    )
    rows = await cursor.fetchall()
    by_date = {}
    for row in rows:
        by_date[row["date"]] = row
    labels = []
    series = {key: [] for key, _label in SCORE_TYPES}
    welcome = departure_calls = not_satisfied = submitted = urgent = 0
    channels = {"Call": 0, "WhatsApp": 0, "Email": 0}
    scores = []
    employee = []
    vip_occ_values = []
    rooms = await _hotel_rooms(db)
    sections = ("preArrival", "inHouse", "departure")
    levels = ("Normal", "Mid", "Urgent")
    priority_by_section = {name: {level: 0 for level in levels} for name in sections}
    satisfaction = {"Satisfied": 0, "Non Satisfied": 0, "Have Comment": 0}
    membership_totals = {name: {"arrival": 0, "inHouse": 0, "departure": 0} for name in TIERS}
    vip_arrivals, vip_departures, vip_occ_series = [], [], []
    departure_series, employee_series = [], []
    cursor_day = start_day
    while cursor_day <= end:
        iso = cursor_day.isoformat()
        labels.append(iso[8:] if start_day.month == end.month and start_day.year == end.year else cursor_day.strftime("%d %b"))
        row = by_date.get(iso)
        body = _loads(row["body_json"], {}) if row else {}
        if row and row["status"] == "submitted":
            submitted += 1
        for key, _label in SCORE_TYPES:
            series[key].append(_ytd_value(body.get("scores"), key))
        occ = _vip_occ(body.get("arrivals"), rooms)
        vip_arrivals.append(_number(body.get("arrivals")) or 0)
        vip_departures.append(_number(body.get("departures")) or 0)
        vip_occ_series.append(int(occ) if occ != "" else None)
        if occ != "":
            vip_occ_values.append(int(occ))
        for bucket in sections:
            for item in body.get(bucket) or []:
                if isinstance(item, dict) and item.get("priority") in levels:
                    priority_by_section[bucket][item["priority"]] += 1
                    if item.get("priority") == "Urgent":
                        urgent += 1
        for item in body.get("membership") or []:
            if not isinstance(item, dict) or item.get("tier") not in membership_totals:
                continue
            cell = membership_totals[item["tier"]]
            cell["arrival"] += _number(item.get("arrival")) or 0
            cell["inHouse"] += _number(item.get("inHouse")) or 0
            cell["departure"] += _number(item.get("departure")) or 0
        for item in body.get("inHouse") or []:
            if isinstance(item, dict):
                welcome += 1
                if item.get("satisfaction") == "Non Satisfied":
                    not_satisfied += 1
                if item.get("satisfaction") in satisfaction:
                    satisfaction[item["satisfaction"]] += 1
                if item.get("contacted") in channels:
                    channels[item["contacted"]] += 1
        day_scores, day_employee = [], []
        for item in body.get("departure") or []:
            if isinstance(item, dict):
                departure_calls += 1
                number = _number(item.get("score"))
                if number is not None:
                    scores.append(number)
                    day_scores.append(number)
                rating = _number(item.get("employeeRating"))
                if rating is not None:
                    employee.append(rating)
                    day_employee.append(rating)
                if item.get("contacted") in channels:
                    channels[item["contacted"]] += 1
        departure_series.append(round(sum(day_scores) / len(day_scores), 1) if day_scores else None)
        employee_series.append(round(sum(day_employee) / len(day_employee), 1) if day_employee else None)
        for item in body.get("preArrival") or []:
            if isinstance(item, dict) and item.get("contacted") in channels:
                channels[item["contacted"]] += 1
        cursor_day += timedelta(days=1)
    span = (end - start_day).days + 1
    membership = [
        {"tier": name, **counts}
        for name, counts in membership_totals.items()
        if counts["arrival"] or counts["inHouse"] or counts["departure"]
    ]
    return {
        "startDate": start_day.isoformat(),
        "endDate": end.isoformat(),
        "submitted": submitted,
        "missing": max(0, span - submitted),
        "welcomeCalls": welcome,
        "departureCalls": departure_calls,
        "notSatisfied": not_satisfied,
        "urgent": urgent,
        "avgDeparture": round(sum(scores) / len(scores), 1) if scores else None,
        "avgEmployee": round(sum(employee) / len(employee), 1) if employee else None,
        "avgVipOcc": round(sum(vip_occ_values) / len(vip_occ_values), 1) if vip_occ_values else None,
        "channels": channels,
        "labels": labels,
        "scores": series,
        "priority": {level: sum(priority_by_section[name][level] for name in sections) for level in levels},
        "priorityBySection": priority_by_section,
        "satisfaction": satisfaction,
        "membershipTiers": membership,
        "vipArrivals": vip_arrivals,
        "vipDepartures": vip_departures,
        "vipOcc": vip_occ_series,
        "departureScores": departure_series,
        "employeeRatings": employee_series,
    }
