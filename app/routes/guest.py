import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import TokenData, can_write, require_admin, require_auth
from app.database import get_db

router = APIRouter(prefix="/api/guest", tags=["guest"])

TIERS = [
    ("Classic", "A1", "V3"),
    ("Silver", "A2", "V3"),
    ("Gold", "A3", "V3"),
    ("Platinum", "A4", "V2"),
    ("Daimond", "A5", "V2"),
    ("Limitless", "A6", "V2"),
    ("Care Of", "", "V2"),
    ("Complementary", "", "V3"),
    ("Booking", "", "V3"),
    ("Repeated", "", "V3"),
    ("Hony Moon", "", "V3"),
    ("Others", "", "V3"),
]
SCORES = ["rps", "trustYou", "booking", "google", "tripadvisor", "expedia"]


class GuestSave(BaseModel):
    date: str
    time: str = ""
    inCharge: str = ""
    arrivals: str = ""
    departures: str = ""
    occupancy: str = ""
    remarks: str = ""
    scores: Optional[Dict[str, Any]] = None
    membership: Optional[List[Dict[str, Any]]] = None
    preArrival: Optional[List[Dict[str, Any]]] = None
    inHouse: Optional[List[Dict[str, Any]]] = None
    departure: Optional[List[Dict[str, Any]]] = None


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
    return {key: {"mtd": "", "ytd": "", "target": ""} for key in SCORES}


def _blank_membership():
    return [
        {
            "name": name,
            "code": code,
            "vip": vip,
            "arrival": "",
            "arrivalRooms": "",
            "inHouse": "",
            "inHouseRooms": "",
            "departure": "",
            "departureRooms": "",
        }
        for name, code, vip in TIERS
    ]


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
    scores = _blank_scores()
    incoming = data.scores or {}
    for key in SCORES:
        cell = incoming.get(key) if isinstance(incoming.get(key), dict) else {}
        scores[key] = {
            "mtd": _text(cell.get("mtd")),
            "ytd": _text(cell.get("ytd")),
            "target": _text(cell.get("target")),
        }
    by_name = {}
    for item in data.membership or []:
        if isinstance(item, dict) and item.get("name"):
            by_name[item["name"]] = item
    membership = _blank_membership()
    for row in membership:
        src = by_name.get(row["name"]) or {}
        for field in ("arrival", "arrivalRooms", "inHouse", "inHouseRooms", "departure", "departureRooms"):
            row[field] = _text(src.get(field))
    return {
        "time": _text(data.time),
        "inCharge": _text(data.inCharge),
        "arrivals": _text(data.arrivals),
        "departures": _text(data.departures),
        "occupancy": _text(data.occupancy),
        "remarks": _text(data.remarks),
        "scores": scores,
        "membership": membership,
        "preArrival": _rows(data.preArrival, ["reservation", "name", "membership", "arrival", "departure", "arrivalTime", "preferences", "action", "contacted"]),
        "inHouse": _rows(data.inHouse, ["room", "name", "membership", "arrival", "departure", "satisfaction", "request", "service", "drink", "fb", "action", "contacted"]),
        "departure": _rows(data.departure, ["room", "name", "membership", "arrival", "departure", "score", "feedback", "review", "action", "contacted"]),
    }


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


def _number(value):
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


@router.get("")
async def get_guest(date: str, _: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _parse_date(date)
    return _public(date, await _get_row(db, date))


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
    return _public(data.date, await _get_row(db, data.date))


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
    return _public(date, await _get_row(db, date))


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
    cursor = await db.execute("SELECT date, status, submitted_by FROM guest_reports ORDER BY date DESC")
    return [{"date": row["date"], "status": row["status"], "submittedBy": row["submitted_by"]} for row in await cursor.fetchall()]


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
    series = {key: [] for key in SCORES}
    welcome = departure_calls = not_satisfied = submitted = 0
    channels = {"Call": 0, "WhatsApp": 0, "Email": 0}
    scores = []
    cursor_day = start_day
    while cursor_day <= end:
        iso = cursor_day.isoformat()
        labels.append(iso[8:] if start_day.month == end.month and start_day.year == end.year else cursor_day.strftime("%d %b"))
        row = by_date.get(iso)
        body = _loads(row["body_json"], {}) if row else {}
        if row and row["status"] == "submitted":
            submitted += 1
        score_row = body.get("scores") if isinstance(body.get("scores"), dict) else {}
        for key in SCORES:
            cell = score_row.get(key) if isinstance(score_row.get(key), dict) else {}
            series[key].append(_number(cell.get("mtd")))
        for item in body.get("inHouse") or []:
            if isinstance(item, dict):
                welcome += 1
                if item.get("satisfaction") == "Non Satisfied":
                    not_satisfied += 1
                if item.get("contacted") in channels:
                    channels[item["contacted"]] += 1
        for item in body.get("departure") or []:
            if isinstance(item, dict):
                departure_calls += 1
                number = _number(item.get("score"))
                if number is not None:
                    scores.append(number)
                if item.get("contacted") in channels:
                    channels[item["contacted"]] += 1
        for item in body.get("preArrival") or []:
            if isinstance(item, dict) and item.get("contacted") in channels:
                channels[item["contacted"]] += 1
        cursor_day += timedelta(days=1)
    span = (end - start_day).days + 1
    return {
        "startDate": start_day.isoformat(),
        "endDate": end.isoformat(),
        "submitted": submitted,
        "missing": max(0, span - submitted),
        "welcomeCalls": welcome,
        "departureCalls": departure_calls,
        "notSatisfied": not_satisfied,
        "avgDeparture": round(sum(scores) / len(scores), 1) if scores else None,
        "channels": channels,
        "labels": labels,
        "scores": series,
    }
