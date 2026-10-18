from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import aiosqlite

from app.auth import require_admin, TokenData
from app.database import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])


class RoomsUpdate(BaseModel):
    rooms: int


@router.get("/rooms")
async def get_rooms(_: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("SELECT value FROM settings WHERE key = 'hotel_rooms'")
    row = await cursor.fetchone()
    return {"rooms": int(row["value"]) if row else 394}


@router.put("/rooms")
async def update_rooms(data: RoomsUpdate, _: TokenData = Depends(require_admin), db: aiosqlite.Connection = Depends(get_db)):
    if data.rooms < 1 or data.rooms > 5000:
        raise HTTPException(status_code=400, detail="Rooms must be between 1 and 5000")
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('hotel_rooms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(data.rooms),),
    )
    await db.commit()
    return {"rooms": data.rooms}
