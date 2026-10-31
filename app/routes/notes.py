import json
import uuid
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
import aiosqlite
from app.database import get_db
from app.models import NoteCreate, NoteUpdate, NoteResponse
from app.auth import can_write, require_auth, TokenData
from app.ws import ws_manager

async def clean_assignees(db: aiosqlite.Connection, raw) -> list:
    wanted = []
    for item in assignee_ids(raw):
        if item not in wanted:
            wanted.append(item)
    if len(wanted) > 3:
        raise HTTPException(status_code=400, detail="Choose up to 3 people")
    if not wanted:
        return []
    marks = ",".join("?" for _ in wanted)
    cursor = await db.execute(f"SELECT id FROM users WHERE id IN ({marks})", wanted)
    found = {row["id"] for row in await cursor.fetchall()}
    missing = [item for item in wanted if item not in found]
    if missing:
        raise HTTPException(status_code=400, detail="Choose a person from the list")
    return wanted

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

def assignee_ids(raw) -> list:
    if isinstance(raw, list):
        return [str(item) for item in raw if item][:3]
    try:
        loaded = json.loads(raw or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(item) for item in loaded if item][:3] if isinstance(loaded, list) else []

def is_note_follower(note, user: TokenData) -> bool:
    ids = assignee_ids(note["assignees_json"] if "assignees_json" in note.keys() else note.get("assignees_json"))
    created = note["created_by"] if "created_by" in note.keys() else note.get("created_by")
    return user.user_id in ids or (created or "") == user.user_id or (note["manager"] or "") == user.full_name

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
        "createdBy": note.get("created_by") or "",
        "assignees": assignee_ids(note.get("assignees_json")),
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
    assignees = await clean_assignees(db, data.assignees)
    
    # Ensure report exists for this date
    cursor = await db.execute("SELECT date FROM reports WHERE date = ?", (date,))
    if not await cursor.fetchone():
        await db.execute(
            "INSERT INTO reports (date, status, created_at, updated_at) VALUES (?, 'draft', ?, ?)",
            (date, now.isoformat(), now.isoformat())
        )
    
    await db.execute("""
        INSERT INTO notes (
            id, report_date, department, priority, text, photo_url, manager, time, status, created_at, created_by, assignees_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        note_id, date, data.department, data.priority, data.text,
        data.photo_url, manager_name, time_str, data.status, now.isoformat(), user.user_id, json.dumps(assignees)
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
        "createdBy": user.user_id,
        "assignees": assignees,
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
    
    writer = can_write(user.role, "duty")
    if not writer and not is_note_follower(note, user):
        raise HTTPException(status_code=403, detail="You cannot change this action item")
    if not writer and (data.priority is not None or data.text is not None or data.assignees is not None):
        raise HTTPException(status_code=403, detail="You can change the status or add a comment")
    updates = []
    params = []
    status_changed = data.status is not None and data.status != note["status"]
    if data.assignees is not None:
        updates.append("assignees_json = ?")
        params.append(json.dumps(await clean_assignees(db, data.assignees)))
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
    assignee_only = data.assignees is not None and data.status is None and data.priority is None and data.text is None
    if not assignee_only:
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
