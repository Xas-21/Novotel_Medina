import uuid
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
import aiosqlite
from app.database import get_db
from app.models import NoteCreate, NoteUpdate, NoteResponse
from app.auth import require_auth, TokenData
from app.ws import ws_manager

async def record_note_event(db: aiosqlite.Connection, note_id: str, status_value: str, actor: str, at: str):
    await db.execute(
        "INSERT INTO note_events (id, note_id, status, actor, created_at) VALUES (?, ?, ?, ?, ?)",
        (f"evt_{uuid.uuid4().hex[:12]}", note_id, status_value, actor or "", at),
    )

async def timelines_for(db: aiosqlite.Connection, note_ids: list):
    if not note_ids:
        return {}
    marks = ",".join("?" for _ in note_ids)
    cursor = await db.execute(
        f"SELECT note_id, status, actor, created_at FROM note_events WHERE note_id IN ({marks}) ORDER BY created_at ASC",
        note_ids,
    )
    grouped = {}
    for row in await cursor.fetchall():
        grouped.setdefault(row["note_id"], []).append({
            "status": row["status"],
            "at": row["created_at"] or "",
            "actor": row["actor"] or "",
        })
    return grouped

def note_payload(note: dict, events: list, carried: bool = False):
    timeline = events or [{
        "status": note.get("status") or "open",
        "at": note.get("created_at") or "",
        "actor": note.get("manager") or "",
    }]
    return {
        "id": note["id"],
        "report_date": note["report_date"],
        "date": note["report_date"],
        "department": note["department"],
        "priority": note["priority"],
        "text": note["text"],
        "photo_url": note["photo_url"],
        "manager": note["manager"],
        "time": note["time"],
        "status": note["status"],
        "created_at": note.get("created_at"),
        "carried": carried,
        "timeline": timeline,
    }

router = APIRouter(prefix="/api/notes", tags=["notes"])
logger = logging.getLogger("novotel.notes")

@router.post("/{date}", response_model=NoteResponse)
async def create_note(
    date: str,
    data: NoteCreate,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_auth)
):
    note_id = f"note_{uuid.uuid4().hex[:10]}"
    now = datetime.utcnow()
    time_str = data.time or now.strftime("%H:%M")
    manager_name = user.full_name
    
    # Ensure report exists for this date
    cursor = await db.execute("SELECT date FROM reports WHERE date = ?", (date,))
    if not await cursor.fetchone():
        await db.execute(
            "INSERT INTO reports (date, status, created_at, updated_at) VALUES (?, 'draft', ?, ?)",
            (date, now.isoformat(), now.isoformat())
        )
    
    await db.execute("""
        INSERT INTO notes (
            id, report_date, department, priority, text, photo_url, manager, time, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        note_id, date, data.department, data.priority, data.text,
        data.photo_url, manager_name, time_str, data.status, now.isoformat()
    ))
    await record_note_event(db, note_id, data.status, manager_name, now.isoformat())
    await db.commit()
    
    note_obj = {
        "id": note_id,
        "report_date": date,
        "department": data.department,
        "priority": data.priority,
        "text": data.text,
        "photo_url": data.photo_url,
        "manager": manager_name,
        "time": time_str,
        "status": data.status,
        "created_at": now.isoformat(),
        "timeline": [{"status": data.status, "at": now.isoformat(), "actor": manager_name}],
    }
    
    await ws_manager.broadcast({
        "event": "NOTE_ADDED",
        "date": date,
        "note": note_obj
    })
    
    return NoteResponse(**note_obj)

@router.patch("/{note_id}")
async def update_note(
    note_id: str,
    data: NoteUpdate,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_auth)
):
    cursor = await db.execute("SELECT * FROM notes WHERE id = ?", (note_id,))
    note = await cursor.fetchone()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    
    updates = []
    params = []
    status_changed = data.status is not None and data.status != note["status"]
    if status_changed:
        updates.append("status = ?")
        params.append(data.status)
    if data.priority is not None:
        updates.append("priority = ?")
        params.append(data.priority)
    if data.text is not None:
        updates.append("text = ?")
        params.append(data.text)
        
    actor = user.full_name
    now = datetime.utcnow().isoformat()
    if updates:
        params.append(note_id)
        await db.execute(f"UPDATE notes SET {', '.join(updates)} WHERE id = ?", tuple(params))
    if status_changed:
        await record_note_event(db, note_id, data.status, actor, now)
    if updates or status_changed:
        await db.commit()
    timeline = (await timelines_for(db, [note_id])).get(note_id) or []
    
    await ws_manager.broadcast({
        "event": "NOTE_UPDATED",
        "date": note["report_date"],
        "noteId": note_id,
        "status": data.status,
        "priority": data.priority,
        "updatedBy": actor
    })

    return {"success": True, "id": note_id, "status": data.status or note["status"], "timeline": timeline}

@router.delete("/{note_id}")
async def delete_note(
    note_id: str,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_auth)
):
    cursor = await db.execute("SELECT * FROM notes WHERE id = ?", (note_id,))
    note = await cursor.fetchone()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    
    report_date = note["report_date"]
    await db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    await db.commit()
    
    await ws_manager.broadcast({
        "event": "NOTE_DELETED",
        "date": report_date,
        "noteId": note_id,
        "deletedBy": user.full_name
    })
    
    return {"success": True, "id": note_id}
