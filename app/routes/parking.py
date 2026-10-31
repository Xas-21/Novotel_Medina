import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import TokenData, can_write, require_admin, require_auth
from app.database import get_db
from app.ws import ws_manager

router = APIRouter(prefix="/api/parking", tags=["parking"])

# shortcut: holds live in this process and drop on restart; a closed browser expires after 90s
HOLD_SECONDS = 90
HELD_DETAIL = "This parking is about to check-in by another user, please choose another spot to check-in."
_holds = {}

# Saudi Arabia has no daylight saving, so a fixed offset matches Asia/Riyadh all year.
RIYADH = timezone(timedelta(hours=3))
LOG_PAGE = 20
LOG_MAX = 2000


class CheckIn(BaseModel):
    room: str = Field("", max_length=40)
    isVisitor: bool = False
    date: str = ""
    time: str = ""
    isHod: bool = False
    position: str = Field("", max_length=80)
    guestName: str = Field("", max_length=120)
    plate: str = Field("", max_length=40)
    carModel: str = Field("", max_length=80)
    carColour: str = Field("", max_length=40)


class Extend(BaseModel):
    date: str = ""
    time: str = ""


class OutOfService(BaseModel):
    dateFrom: str = ""
    dateTo: str = ""


def _require_write(user: TokenData):
    if not can_write(user.role, "parking"):
        raise HTTPException(status_code=403, detail="Parkings is read-only for this user")


def _checkout_time(date: str, time: str):
    try:
        datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=400, detail="Date and Time required")


def _today() -> str:
    return datetime.now(RIYADH).strftime("%Y-%m-%d")


def _due_or_overdue(row) -> bool:
    # Same split the floor uses: overdue once the checkout minute has passed,
    # otherwise due out only when the checkout date is today.
    if row["status"] != "occupied" or not row["date_out"]:
        return False
    when = f"{row['date_out']} {row['time_out'] or '00:00'}"
    if when <= datetime.now(RIYADH).strftime("%Y-%m-%d %H:%M"):
        return True
    return row["date_out"] == _today()


def _car(row):
    return {
        "room": row["room"],
        "isVisitor": bool(row["is_visitor"]),
        "isHod": bool(row["is_hod"]),
        "position": row["position"],
        "guestName": row["guest_name"],
        "plate": row["plate"],
        "carModel": row["car_model"],
        "carColour": row["car_colour"],
        "dateOut": row["date_out"],
        "timeOut": row["time_out"],
    }


def _active_hold(spot_id: str):
    item = _holds.get(spot_id)
    if not item or item["until"] <= time.time():
        _holds.pop(spot_id, None)
        return None
    return item


def _held_by_other(spot_id: str, user_id: str) -> bool:
    item = _active_hold(spot_id)
    return bool(item and item["userId"] != user_id)


def _drop_hold(spot_id: str) -> bool:
    return _holds.pop(spot_id, None) is not None


async def _broadcast_hold(spot_id: str, held: bool, user: TokenData):
    item = _active_hold(spot_id) if held else None
    await ws_manager.broadcast({
        "event": "PARKING_HOLD",
        "spotId": spot_id,
        "userId": user.user_id,
        "held": held,
        "until": item["until"] if item else 0,
    })


def _spot(row):
    spot = {
        "id": row["id"],
        "floor": row["floor"],
        "number": row["number"],
        "size": row["size"],
        "isHandicap": bool(row["is_handicap"]),
        "status": row["status"],
        **_car(row),
        "oosFrom": row["oos_from"],
        "oosTo": row["oos_to"],
    }
    item = _active_hold(row["id"])
    if item:
        spot["heldBy"] = item["userId"]
        spot["heldUntil"] = item["until"]
    return spot


def _out_of_service_now(row) -> bool:
    today = _today()
    return bool(row["oos_from"]) and row["oos_from"] <= today <= row["oos_to"]


async def _get_spot(db, spot_id: str):
    cursor = await db.execute("SELECT * FROM parking_spots WHERE id = ?", (spot_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parking spot not found")
    return row


async def _logged(db, user: TokenData, spot_id: str, action: str, details: dict):
    now = datetime.now(RIYADH)
    log_id = f"plog_{uuid.uuid4().hex[:12]}"
    await db.execute(
        "INSERT INTO parking_logs (id, actor, action, spot_id, date, time, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            log_id, user.full_name, action, spot_id,
            now.strftime("%Y-%m-%d"), now.strftime("%I:%M:%S %p").lstrip("0"),
            now.isoformat(timespec="microseconds"), json.dumps(details),
        ),
    )
    from app.routes.alerts import record_parking_event
    alerted = await record_parking_event(db, user, spot_id, action, details, log_id, now.isoformat(timespec="microseconds"))
    await db.commit()
    spot = _spot(await _get_spot(db, spot_id))
    await ws_manager.broadcast({"event": "PARKING_UPDATED", "spot": spot})
    if alerted:
        await ws_manager.broadcast({"event": "PARKING_ALERT"})
    return spot


@router.get("/spots")
async def list_spots(_: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("SELECT * FROM parking_spots ORDER BY floor, number")
    return [_spot(row) for row in await cursor.fetchall()]


@router.post("/spots/{spot_id}/checkin")
async def check_in(spot_id: str, data: CheckIn, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    room = data.room.strip()
    position = data.position.strip()
    if data.isHod and data.isVisitor:
        raise HTTPException(status_code=400, detail="Choose Visitor or HOD")
    if data.isHod and not position:
        raise HTTPException(status_code=400, detail="Position required")
    if not data.isVisitor and not data.isHod and not room:
        raise HTTPException(status_code=400, detail="Room Number required")
    _checkout_time(data.date, data.time)
    row = await _get_spot(db, spot_id)
    if _out_of_service_now(row):
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is out of service until {row['oos_to']}")
    if _held_by_other(spot_id, user.user_id):
        raise HTTPException(status_code=409, detail=HELD_DETAIL)
    stored_room = "" if data.isHod else ("VISITOR" if data.isVisitor else room)
    who = "HOD" if data.isHod else ("Visitor" if data.isVisitor else "Room " + room)
    cursor = await db.execute(
        """UPDATE parking_spots SET status = 'occupied', room = ?, is_visitor = ?, is_hod = ?, position = ?,
           date_out = ?, time_out = ?, guest_name = ?, plate = ?, car_model = ?, car_colour = ?
           WHERE id = ? AND status = 'available'""",
        (
            stored_room, int(data.isVisitor), int(data.isHod), position if data.isHod else "",
            data.date, data.time, data.guestName.strip(), data.plate.strip().upper(),
            data.carModel.strip(), data.carColour.strip(), spot_id,
        ),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is already taken")
    dropped = _drop_hold(spot_id)
    details = _car(await _get_spot(db, spot_id))
    spot = await _logged(db, user, spot_id, f"Checked IN ({who})", details)
    if dropped:
        await _broadcast_hold(spot_id, False, user)
    return spot


@router.post("/spots/{spot_id}/checkout")
async def check_out(spot_id: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    row = await _get_spot(db, spot_id)
    if user.role == "security":
        if not _due_or_overdue(row):
            raise HTTPException(status_code=403, detail="Security can check out only cars that are due out today or overdue")
    else:
        _require_write(user)
    details = _car(row)
    cursor = await db.execute(
        """UPDATE parking_spots SET status = 'available', room = '', is_visitor = 0, is_hod = 0, position = '',
           date_out = '', time_out = '', guest_name = '', plate = '', car_model = '', car_colour = ''
           WHERE id = ? AND status = 'occupied'""",
        (spot_id,),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is already free")
    return await _logged(db, user, spot_id, "Checked OUT", details)


@router.post("/spots/{spot_id}/extend")
async def extend(spot_id: str, data: Extend, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    _checkout_time(data.date, data.time)
    await _get_spot(db, spot_id)
    cursor = await db.execute(
        "UPDATE parking_spots SET date_out = ?, time_out = ? WHERE id = ? AND status = 'occupied'",
        (data.date, data.time, spot_id),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is free")
    details = _car(await _get_spot(db, spot_id))
    return await _logged(db, user, spot_id, f"Extended stay to {data.date}", details)


@router.post("/spots/{spot_id}/out-of-service")
async def set_out_of_service(spot_id: str, data: OutOfService, user: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    try:
        start = datetime.strptime(data.dateFrom, "%Y-%m-%d").date()
        end = datetime.strptime(data.dateTo, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="From and To dates required")
    if start > end:
        raise HTTPException(status_code=400, detail="The To date must be on or after the From date")
    if data.dateTo < _today():
        raise HTTPException(status_code=400, detail="The To date has already passed")
    await _get_spot(db, spot_id)
    cursor = await db.execute(
        "UPDATE parking_spots SET oos_from = ?, oos_to = ? WHERE id = ? AND status = 'available'",
        (data.dateFrom, data.dateTo, spot_id),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Check the car out of {spot_id} first")
    details = {"oosFrom": data.dateFrom, "oosTo": data.dateTo}
    return await _logged(db, user, spot_id, f"Set out of service ({data.dateFrom} to {data.dateTo})", details)


@router.post("/spots/{spot_id}/back-in-service")
async def back_in_service(spot_id: str, user: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    row = await _get_spot(db, spot_id)
    if not row["oos_to"] or row["oos_to"] < _today():
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is already in service")
    details = {"oosFrom": row["oos_from"], "oosTo": row["oos_to"]}
    await db.execute("UPDATE parking_spots SET oos_from = '', oos_to = '' WHERE id = ?", (spot_id,))
    return await _logged(db, user, spot_id, "Back in service", details)


def _contains(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.post("/spots/{spot_id}/hold")
async def hold_spot(spot_id: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    row = await _get_spot(db, spot_id)
    if row["status"] != "available" or _out_of_service_now(row):
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is not free")
    if _held_by_other(spot_id, user.user_id):
        raise HTTPException(status_code=409, detail=HELD_DETAIL)
    _holds[spot_id] = {"userId": user.user_id, "until": time.time() + HOLD_SECONDS}
    await _broadcast_hold(spot_id, True, user)
    item = _active_hold(spot_id)
    return {"held": True, "until": item["until"]}


@router.post("/spots/{spot_id}/release")
async def release_spot(spot_id: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    await _get_spot(db, spot_id)
    item = _active_hold(spot_id)
    if item and item["userId"] == user.user_id:
        _drop_hold(spot_id)
        await _broadcast_hold(spot_id, False, user)
    return {"held": False}


@router.get("/users")
async def list_log_users(_: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("""
        SELECT name FROM (
            SELECT CASE WHEN TRIM(first_name || ' ' || last_name) = '' THEN username
                        ELSE TRIM(first_name || ' ' || last_name) END AS name FROM users
            UNION
            SELECT actor FROM parking_logs
        ) WHERE name != '' ORDER BY name COLLATE NOCASE
    """)
    return [row["name"] for row in await cursor.fetchall()]


def _details(raw):
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


@router.get("/logs")
async def list_logs(
    spot: str = "",
    date: str = "",
    user: str = "",
    room: str = "",
    limit: int = LOG_PAGE,
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    where, params = [], []
    if spot.strip():
        where.append("spot_id LIKE ? ESCAPE '\\'")
        params.append(_contains(spot.strip()))
    if user.strip():
        where.append("actor = ?")
        params.append(user.strip())
    if date.strip():
        where.append("date = ?")
        params.append(date.strip())
    if room.strip():
        where.append("json_extract(details_json, '$.room') = ?")
        params.append(room.strip())
    sql = "SELECT * FROM parking_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    show = LOG_PAGE if limit < 1 else min(limit, LOG_MAX)
    cursor = await db.execute(sql + " ORDER BY created_at DESC LIMIT ?", (*params, show + 1))
    rows = await cursor.fetchall()
    items = [
        {
            "id": r["id"], "actor": r["actor"], "action": r["action"], "spotId": r["spot_id"],
            "date": r["date"], "time": r["time"], "details": _details(r["details_json"]),
        }
        for r in rows[:show]
    ]
    return {"items": items, "more": len(rows) > show}
