import json
from datetime import UTC, datetime, timedelta
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import TokenData, can_write, require_admin, require_auth
from app.database import get_db
from app.night_math import missing_dates, money, month_to_date, night_figures, segment_gap
from app.submit_gate import night_missing
from app.ws import ws_manager

router = APIRouter(prefix="/api/night", tags=["night"])

SEGMENT_CODES = ["SLA", "KGACI", "QEACI", "TWBCI", "TWACI", "TWACS", "SKP"]
CHECKLIST_AREAS = [
    "Security Check points",
    "Meeting halls",
    "Departmental Offices",
    "Restaurants",
    "Kitchens",
    "Engineering Section",
    "Staff Cafeteria",
    "Main Lobby",
    "Business Centre",
    "Garbage Room",
    "Floors Inspection",
    "Stores",
    "Car Parking",
]
FORECAST_NUMBERS = ["totalOcc", "arrRooms", "depRooms", "occPct", "compRooms", "averageRate"]


class NightSave(BaseModel):
    date: str
    roomsOccupied: float = 0
    roomsRevenue: float = 0
    fbRevenue: float = 0
    meRevenue: float = 0
    oodRevenue: float = 0
    otherRevenue: float = 0
    segments: Optional[List[Dict[str, Any]]] = None
    forecast: Optional[List[Dict[str, Any]]] = None
    groups: Optional[List[Dict[str, Any]]] = None
    vip: Optional[List[Dict[str, Any]]] = None
    checklist: Optional[List[Dict[str, Any]]] = None
    comments: Optional[List[str]] = None
    inspection: Optional[Dict[str, Any]] = None
    shiftStart: str = ""
    shiftEnd: str = ""
    arrivals: str = ""
    departures: str = ""
    inHouse: str = ""
    allMembers: str = ""
    overviewOccupancy: str = ""


def _parse_date(value: str):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _loads(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _blank_segments():
    return [{"code": code, "rooms": 0, "adr": 0} for code in SEGMENT_CODES]


def _blank_checklist():
    return [{"area": area, "remark": ""} for area in CHECKLIST_AREAS]


def _blank_comments():
    return ["", "", "", ""]


def _blank_forecast(report_date):
    days = []
    for offset in range(1, 10):
        day = {"date": (report_date + timedelta(days=offset)).isoformat()}
        for key in FORECAST_NUMBERS:
            day[key] = ""
        days.append(day)
    return days


def _require_night_write(user: TokenData):
    if not can_write(user.role, "night"):
        raise HTTPException(status_code=403, detail="Night section is read-only for this user")


async def _broadcast(date: str):
    await ws_manager.broadcast({"event": "NIGHT_REPORT_UPDATED", "date": date})


async def _hotel_rooms(db: aiosqlite.Connection) -> int:
    cursor = await db.execute("SELECT value FROM settings WHERE key = 'hotel_rooms'")
    row = await cursor.fetchone()
    if not row:
        return 394
    return int(row["value"])


async def _get_row(db: aiosqlite.Connection, date: str):
    cursor = await db.execute("SELECT * FROM night_reports WHERE date = ?", (date,))
    return await cursor.fetchone()


async def _month_rows(db: aiosqlite.Connection, report_date):
    cursor = await db.execute(
        "SELECT * FROM night_reports WHERE date >= ? AND date <= ? ORDER BY date",
        (report_date.replace(day=1).isoformat(), report_date.isoformat()),
    )
    return [dict(row) for row in await cursor.fetchall()]


async def _submitted_by(db: aiosqlite.Connection, user_id: str) -> str:
    cursor = await db.execute(
        "SELECT first_name, last_name, title FROM users WHERE id = ?",
        (user_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    name = f"{row['first_name']} {row['last_name']}".strip()
    title = (row["title"] or "").strip()
    if title:
        return f"{name} \u2014 {title}"
    return name


def _forecast_with_occupancy(forecast, rooms_available):
    rooms = int(rooms_available or 0)
    for day in forecast:
        raw = str(day.get("totalOcc") if day.get("totalOcc") is not None else "").replace(",", "").strip()
        if raw == "" or rooms <= 0:
            day["occPct"] = ""
            continue
        try:
            occupied = float(raw)
        except ValueError:
            day["occPct"] = ""
            continue
        day["occPct"] = str(money(occupied / rooms * 100))
    return forecast


def _forecast_for_save(report_date, incoming, existing):
    if incoming is None:
        return existing if existing is not None else _blank_forecast(report_date)
    template = _blank_forecast(report_date)
    for index, item in enumerate(incoming[:9]):
        if not isinstance(item, dict):
            continue
        for key in FORECAST_NUMBERS:
            if key in item and item[key] is not None:
                template[index][key] = item[key]
    return template


def _comments_for_save(incoming, existing):
    if incoming is None:
        return existing if existing is not None else _blank_comments()
    values = ["" if item is None else str(item) for item in incoming[:4]]
    while len(values) < 4:
        values.append("")
    return values


async def _response(db: aiosqlite.Connection, date_text: str, row):
    report_date = _parse_date(date_text)
    if row:
        rooms_available = row["rooms_available"]
        rooms_occupied = row["rooms_occupied"]
        rooms_revenue = row["rooms_revenue"]
        fb = row["fb_revenue"]
        me = row["me_revenue"]
        ood = row["ood_revenue"]
        other = row["other_revenue"]
        segments = _loads(row["segments_json"], _blank_segments())
        forecast = _forecast_with_occupancy(_loads(row["forecast_json"], _blank_forecast(report_date)), rooms_available)
        groups = _loads(row["groups_json"], [])
        vip = _loads(row["vip_json"], [])
        checklist = _loads(row["checklist_json"], _blank_checklist())
        comments = _loads(row["comments_json"], _blank_comments())
        inspection = _loads(row["inspection_json"], None) if "inspection_json" in row.keys() else None
    else:
        rooms_available = await _hotel_rooms(db)
        rooms_occupied = rooms_revenue = fb = me = ood = other = 0
        segments = _blank_segments()
        forecast = _blank_forecast(report_date)
        groups = []
        vip = []
        checklist = _blank_checklist()
        comments = _blank_comments()
        inspection = None

    saved = await _month_rows(db, report_date)
    payload = {
        "date": date_text,
        "submittedAt": row["submitted_at"] if row else None,
        "submittedBy": row["submitted_by"] if row else None,
        "roomsAvailable": rooms_available,
        "roomsOccupied": rooms_occupied,
        "roomsRevenue": rooms_revenue,
        "fbRevenue": fb,
        "meRevenue": me,
        "oodRevenue": ood,
        "otherRevenue": other,
        "segments": segments,
        "forecast": forecast,
        "groups": groups,
        "vip": vip,
        "checklist": checklist,
        "comments": comments,
        "inspection": inspection,
        "shiftStart": (row["shift_start"] or "") if row else "",
        "shiftEnd": (row["shift_end"] or "") if row else "",
        "arrivals": (row["arrivals"] or "") if row else "",
        "departures": (row["departures"] or "") if row else "",
        "inHouse": (row["in_house"] or "") if row else "",
        "allMembers": (row["all_members"] or "") if row else "",
        "overviewOccupancy": (row["overview_occupancy"] or "") if row else "",
        "calculated": night_figures(rooms_available, rooms_occupied, rooms_revenue, fb, me, ood, other),
        "segmentGap": segment_gap(rooms_occupied, [_num(item.get("rooms")) for item in segments]),
        "mtd": month_to_date(rooms_available, report_date.day, saved),
        "missingDates": missing_dates(
            report_date.year,
            report_date.month,
            report_date.day,
            {item["date"] for item in saved},
        ),
    }
    if row:
        payload["status"] = row["status"]
    return payload


@router.get("/index")
async def get_night_index(
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute(
        """
        SELECT date, status, submitted_by, rooms_available, rooms_occupied, rooms_revenue,
               fb_revenue, me_revenue, ood_revenue, other_revenue
        FROM night_reports
        ORDER BY date DESC
        """
    )
    rows = await cursor.fetchall()
    results = []
    for row in rows:
        occupancy = night_figures(
            row["rooms_available"],
            row["rooms_occupied"],
            row["rooms_revenue"],
            row["fb_revenue"],
            row["me_revenue"],
            row["ood_revenue"],
            row["other_revenue"],
        )["occupancy"]
        results.append({
            "date": row["date"],
            "status": row["status"],
            "submittedBy": row["submitted_by"],
            "occupancy": money(occupancy * 100) if occupancy is not None else None,
        })
    return results


@router.get("/analysis")
async def get_night_analysis(
    date: str,
    range: str = Query("week", pattern="^(week|month)$"),
    start: str | None = None,
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    report_date = _parse_date(date)
    if start:
        start_day = _parse_date(start)
    elif range == "week":
        start_day = report_date - timedelta(days=6)
    else:
        start_day = report_date.replace(day=1)
    cursor = await db.execute(
        "SELECT * FROM night_reports WHERE date >= ? AND date <= ? ORDER BY date",
        (start_day.isoformat(), report_date.isoformat()),
    )
    saved = {row["date"]: dict(row) for row in await cursor.fetchall()}

    labels = []
    occupancy = []
    loyalty = []
    adr = []
    revpar = []
    rooms_daily = []
    rooms = fb = me = ood = other = 0.0
    day = start_day
    while day <= report_date:
        labels.append(f"{day.day:02d}")
        row = saved.get(day.isoformat())
        if row is None:
            occupancy.append(None)
            loyalty.append(0)
            adr.append(None)
            revpar.append(None)
            rooms_daily.append(0)
        else:
            figures = night_figures(
                row["rooms_available"],
                row["rooms_occupied"],
                row["rooms_revenue"],
                row["fb_revenue"],
                row["me_revenue"],
                row["ood_revenue"],
                row["other_revenue"],
            )
            occupancy.append(None if figures["occupancy"] is None else money(figures["occupancy"] * 100))
            loyalty.append(_num(row["all_members"]) if "all_members" in row.keys() else 0)
            adr.append(None if figures["adr"] is None else money(figures["adr"]))
            revpar.append(None if figures["revpar"] is None else money(figures["revpar"]))
            rooms_daily.append(money(row["rooms_revenue"]))
            rooms += row["rooms_revenue"]
            fb += row["fb_revenue"]
            me += row["me_revenue"]
            ood += row["ood_revenue"]
            other += row["other_revenue"]
        day += timedelta(days=1)

    selected = saved.get(report_date.isoformat())
    stored = _loads(selected["segments_json"], []) if selected else []
    by_code = {}
    if isinstance(stored, list):
        for item in stored:
            if isinstance(item, dict) and item.get("code") in SEGMENT_CODES:
                by_code[item["code"]] = item.get("rooms") or 0

    return {
        "date": date,
        "range": range,
        "labels": labels,
        "occupancy": occupancy,
        "loyalty": loyalty,
        "adr": adr,
        "revpar": revpar,
        "roomsSeries": rooms_daily,
        "revenue": {
            "rooms": money(rooms),
            "fb": money(fb),
            "me": money(me),
            "ood": money(ood),
            "other": money(other),
        },
        "segments": [{"code": code, "rooms": by_code.get(code, 0)} for code in SEGMENT_CODES],
    }


@router.get("")
async def get_night(
    date: str,
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    _parse_date(date)
    return await _response(db, date, await _get_row(db, date))


@router.put("")
async def save_night(
    data: NightSave,
    user: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    _require_night_write(user)
    report_date = _parse_date(data.date)
    row = await _get_row(db, data.date)
    if row and row["status"] == "submitted" and user.role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can edit a submitted report.")

    existing_segments = _loads(row["segments_json"], None) if row else None
    existing_forecast = _loads(row["forecast_json"], None) if row else None
    existing_groups = _loads(row["groups_json"], None) if row else None
    existing_vip = _loads(row["vip_json"], None) if row else None
    existing_checklist = _loads(row["checklist_json"], None) if row else None
    existing_comments = _loads(row["comments_json"], None) if row else None
    existing_inspection = _loads(row["inspection_json"], None) if row and "inspection_json" in row.keys() else None

    segments = data.segments if data.segments is not None else (existing_segments if existing_segments is not None else _blank_segments())
    forecast = _forecast_with_occupancy(
        _forecast_for_save(report_date, data.forecast, existing_forecast),
        row["rooms_available"] if row else await _hotel_rooms(db),
    )
    groups = data.groups if data.groups is not None else (existing_groups if existing_groups is not None else [])
    vip = data.vip if data.vip is not None else (existing_vip if existing_vip is not None else [])
    checklist = data.checklist if data.checklist is not None else (existing_checklist if existing_checklist is not None else _blank_checklist())
    comments = _comments_for_save(data.comments, existing_comments)
    inspection = data.inspection if data.inspection is not None else (existing_inspection if existing_inspection is not None else {})
    now = _now()

    if row:
        await db.execute(
            """
            UPDATE night_reports SET
                rooms_occupied = ?, rooms_revenue = ?, fb_revenue = ?, me_revenue = ?,
                ood_revenue = ?, other_revenue = ?, segments_json = ?, forecast_json = ?,
                groups_json = ?, vip_json = ?, checklist_json = ?, comments_json = ?,
                inspection_json = ?,
                shift_start = ?, shift_end = ?, arrivals = ?, departures = ?,
                all_members = ?, updated_at = ?
            WHERE date = ?
            """,
            (
                data.roomsOccupied, data.roomsRevenue, data.fbRevenue, data.meRevenue,
                data.oodRevenue, data.otherRevenue, json.dumps(segments), json.dumps(forecast),
                json.dumps(groups), json.dumps(vip), json.dumps(checklist), json.dumps(comments),
                json.dumps(inspection),
                data.shiftStart, data.shiftEnd, data.arrivals, data.departures,
                data.allMembers, now, data.date,
            ),
        )
    else:
        await db.execute(
            """
            INSERT INTO night_reports (
                date, status, rooms_available, rooms_occupied, rooms_revenue, fb_revenue,
                me_revenue, ood_revenue, other_revenue, segments_json, forecast_json,
                groups_json, vip_json, checklist_json, comments_json, inspection_json,
                shift_start, shift_end, arrivals, departures, all_members,
                created_at, updated_at
            ) VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.date, await _hotel_rooms(db), data.roomsOccupied, data.roomsRevenue,
                data.fbRevenue, data.meRevenue, data.oodRevenue, data.otherRevenue,
                json.dumps(segments), json.dumps(forecast), json.dumps(groups), json.dumps(vip),
                json.dumps(checklist), json.dumps(comments), json.dumps(inspection),
                data.shiftStart, data.shiftEnd, data.arrivals, data.departures,
                data.allMembers, now, now,
            ),
        )

    await db.commit()
    await _broadcast(data.date)
    return await _response(db, data.date, await _get_row(db, data.date))


@router.post("/submit")
async def submit_night(
    date: str,
    user: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    _require_night_write(user)
    report_date = _parse_date(date)
    submitted_by = await _submitted_by(db, user.user_id)
    now = _now()
    row = await _get_row(db, date)
    inspection = _loads(row["inspection_json"], {}) if row and "inspection_json" in row.keys() else {}
    missing = night_missing(inspection)
    if missing:
        raise HTTPException(status_code=400, detail=missing)
    if row:
        await db.execute(
            "UPDATE night_reports SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = ? WHERE date = ?",
            (now, submitted_by, now, date),
        )
    else:
        blank = _blank_forecast(report_date)
        await db.execute(
            """
            INSERT INTO night_reports (
                date, status, submitted_at, submitted_by, rooms_available, segments_json,
                forecast_json, groups_json, vip_json, checklist_json, comments_json,
                created_at, updated_at
            ) VALUES (?, 'submitted', ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)
            """,
            (
                date, now, submitted_by, await _hotel_rooms(db), json.dumps(_blank_segments()),
                json.dumps(blank), json.dumps(_blank_checklist()), json.dumps(_blank_comments()),
                now, now,
            ),
        )
    await db.commit()
    await _broadcast(date)
    return {"success": True, "date": date, "submittedAt": now, "submittedBy": submitted_by}


@router.post("/reopen")
async def reopen_night(
    date: str,
    _: TokenData = Depends(require_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    _parse_date(date)
    if not await _get_row(db, date):
        raise HTTPException(status_code=404, detail="Night report not found")
    await db.execute(
        "UPDATE night_reports SET status = 'draft', submitted_at = NULL, submitted_by = NULL, updated_at = ? WHERE date = ?",
        (_now(), date),
    )
    await db.commit()
    await _broadcast(date)
    return {"success": True, "date": date}


@router.delete("")
async def delete_night(
    date: str,
    _: TokenData = Depends(require_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    _parse_date(date)
    if not await _get_row(db, date):
        raise HTTPException(status_code=404, detail="Night report not found")
    await db.execute("DELETE FROM night_reports WHERE date = ?", (date,))
    await db.commit()
    await _broadcast(date)
    return {"success": True, "date": date}
