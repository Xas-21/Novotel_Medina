import uuid
from datetime import datetime, timedelta, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import TokenData, can_write, require_auth
from app.database import get_db
from app.ws import ws_manager

router = APIRouter(prefix="/api/parking", tags=["parking"])

# Saudi Arabia has no daylight saving, so a fixed offset matches Asia/Riyadh all year.
RIYADH = timezone(timedelta(hours=3))
LOG_LIMIT = 500


class CheckIn(BaseModel):
    room: str = ""
    isVisitor: bool = False
    date: str = ""
    time: str = ""


class Extend(BaseModel):
    date: str = ""
    time: str = ""


def _require_write(user: TokenData):
    if not can_write(user.role, "parking"):
        raise HTTPException(status_code=403, detail="Parkings is read-only for this user")


def _checkout_time(date: str, time: str):
    try:
        datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=400, detail="Date and Time required")


def _spot(row):
    return {
        "id": row["id"],
        "floor": row["floor"],
        "number": row["number"],
        "size": row["size"],
        "isHandicap": bool(row["is_handicap"]),
        "status": row["status"],
        "room": row["room"],
        "isVisitor": bool(row["is_visitor"]),
        "dateOut": row["date_out"],
        "timeOut": row["time_out"],
    }


async def _get_spot(db, spot_id: str):
    cursor = await db.execute("SELECT * FROM parking_spots WHERE id = ?", (spot_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parking spot not found")
    return row


async def _logged(db, user: TokenData, spot_id: str, action: str):
    now = datetime.now(RIYADH)
    await db.execute(
        "INSERT INTO parking_logs (id, actor, action, spot_id, date, time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            f"plog_{uuid.uuid4().hex[:12]}", user.full_name, action, spot_id,
            now.strftime("%Y-%m-%d"), now.strftime("%I:%M:%S %p").lstrip("0"),
            now.isoformat(timespec="microseconds"),
        ),
    )
    await db.commit()
    spot = _spot(await _get_spot(db, spot_id))
    await ws_manager.broadcast({"event": "PARKING_UPDATED", "spot": spot})
    return spot


@router.get("/spots")
async def list_spots(_: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("SELECT * FROM parking_spots ORDER BY floor, number")
    return [_spot(row) for row in await cursor.fetchall()]


@router.post("/spots/{spot_id}/checkin")
async def check_in(spot_id: str, data: CheckIn, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    room = data.room.strip()
    if not data.isVisitor and not room:
        raise HTTPException(status_code=400, detail="Room Number required")
    _checkout_time(data.date, data.time)
    await _get_spot(db, spot_id)
    cursor = await db.execute(
        "UPDATE parking_spots SET status = 'occupied', room = ?, is_visitor = ?, date_out = ?, time_out = ? WHERE id = ? AND status = 'available'",
        ("VISITOR" if data.isVisitor else room, int(data.isVisitor), data.date, data.time, spot_id),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is already taken")
    return await _logged(db, user, spot_id, f"Checked IN ({'Visitor' if data.isVisitor else 'Room ' + room})")


@router.post("/spots/{spot_id}/checkout")
async def check_out(spot_id: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    _require_write(user)
    await _get_spot(db, spot_id)
    cursor = await db.execute(
        "UPDATE parking_spots SET status = 'available', room = '', is_visitor = 0, date_out = '', time_out = '' WHERE id = ? AND status = 'occupied'",
        (spot_id,),
    )
    if cursor.rowcount == 0:
        raise HTTPException(status_code=409, detail=f"Spot {spot_id} is already free")
    return await _logged(db, user, spot_id, "Checked OUT")


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
    return await _logged(db, user, spot_id, f"Extended stay to {data.date}")


def _contains(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/logs")
async def list_logs(
    spot: str = "",
    date: str = "",
    user: str = "",
    _: TokenData = Depends(require_auth),
    db: aiosqlite.Connection = Depends(get_db),
):
    where, params = [], []
    if spot.strip():
        where.append("spot_id LIKE ? ESCAPE '\\'")
        params.append(_contains(spot.strip()))
    if user.strip():
        where.append("actor LIKE ? ESCAPE '\\'")
        params.append(_contains(user.strip()))
    if date.strip():
        where.append("date = ?")
        params.append(date.strip())
    sql = "SELECT * FROM parking_logs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    cursor = await db.execute(sql + " ORDER BY created_at DESC LIMIT ?", (*params, LOG_LIMIT + 1))
    rows = await cursor.fetchall()
    items = [
        {"id": r["id"], "actor": r["actor"], "action": r["action"], "spotId": r["spot_id"], "date": r["date"], "time": r["time"]}
        for r in rows[:LOG_LIMIT]
    ]
    return {"items": items, "more": len(rows) > LOG_LIMIT}
