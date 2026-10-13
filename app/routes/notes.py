import uuid
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
import aiosqlite
from app.database import get_db
from app.models import NoteCreate, NoteUpdate, NoteResponse
from app.auth import get_current_user, TokenData
from app.ws import ws_manager

router = APIRouter(prefix="/api/notes", tags=["notes"])
logger = logging.getLogger("novotel.notes")

@router.post("/{date}", response_model=NoteResponse)
async def create_note(
    date: str,
    data: NoteCreate,
    db: aiosqlite.Connection = Depends(get_db),
    user: Optional[TokenData] = Depends(get_current_user)
):
    note_id = f"note_{uuid.uuid4().hex[:10]}"
    now = datetime.utcnow()
    time_str = data.time or now.strftime("%H:%M")
    manager_name = user.full_name if user else (data.manager or "Duty Manager")
    
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
        "created_at": now.isoformat()
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
    user: Optional[TokenData] = Depends(get_current_user)
):
    cursor = await db.execute("SELECT * FROM notes WHERE id = ?", (note_id,))
    note = await cursor.fetchone()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    
    updates = []
    params = []
    if data.status is not None:
        updates.append("status = ?")
        params.append(data.status)
    if data.priority is not None:
        updates.append("priority = ?")
        params.append(data.priority)
    if data.text is not None:
        updates.append("text = ?")
        params.append(data.text)
        
    if updates:
        params.append(note_id)
        await db.execute(f"UPDATE notes SET {', '.join(updates)} WHERE id = ?", tuple(params))
        await db.commit()
    
    await ws_manager.broadcast({
        "event": "NOTE_UPDATED",
        "date": note["report_date"],
        "noteId": note_id,
        "status": data.status,
        "priority": data.priority,
        "updatedBy": user.full_name if user else "Manager"
    })
    
    return {"success": True, "id": note_id}

@router.delete("/{note_id}")
async def delete_note(
    note_id: str,
    db: aiosqlite.Connection = Depends(get_db),
    user: Optional[TokenData] = Depends(get_current_user)
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
        "deletedBy": user.full_name if user else "Manager"
    })
    
    return {"success": True, "id": note_id}
