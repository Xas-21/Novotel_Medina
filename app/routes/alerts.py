import json
import time
import uuid
from datetime import datetime

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import TokenData, can_write, require_auth
from app.database import get_db
from app.routes.notes import assignee_ids, is_note_follower
from app.routes.parking import RIYADH
from app.ws import ws_manager

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

SNOOZE_MINUTES = {10, 30, 60, 180, 360, 480}
PRIORITY_LABEL = {"urgent": "Urgent", "follow": "Needs follow-up", "normal": "Normal"}
STATUS_LABEL = {"open": "Open", "progress": "In progress", "closed": "Closed"}


class SnoozeBody(BaseModel):
    minutes: int


class CommentBody(BaseModel):
    source: str
    id: str
    date: str = ""
    body: str = ""


class StatusBody(BaseModel):
    source: str
    id: str
    date: str = ""
    status: str


def _loads(raw, fallback):
    try:
        value = json.loads(raw or "")
    except (TypeError, json.JSONDecodeError):
        return fallback
    return value


def _room_label(details: dict) -> str:
    if details.get("isHod"):
        return details.get("position") or "HOD"
    if details.get("isVisitor") or details.get("room") == "VISITOR":
        return "Visitor"
    return details.get("room") or ""


def _kind(action: str) -> str:
    if action.startswith("Checked IN"):
        return "checkin"
    if action.startswith("Checked OUT"):
        return "checkout"
    if action.startswith("Extended"):
        return "extend"
    return ""


async def record_parking_event(db, user: TokenData, spot_id: str, action: str, details: dict, log_id: str, created_at: str) -> bool:
    kind = _kind(action)
    if not kind:
        return False
    if kind == "checkout":
        cursor = await db.execute(
            "SELECT id FROM parking_alerts WHERE spot_id = ? AND kind IN ('due', 'overdue')",
            (spot_id,),
        )
        old_ids = [row["id"] for row in await cursor.fetchall()]
        if old_ids:
            marks = ",".join("?" for _ in old_ids)
            await db.execute(f"DELETE FROM parking_alert_reads WHERE alert_id IN ({marks})", old_ids)
            await db.execute(f"DELETE FROM parking_alerts WHERE id IN ({marks})", old_ids)
    cursor = await db.execute("SELECT floor FROM parking_spots WHERE id = ?", (spot_id,))
    spot = await cursor.fetchone()
    floor = spot["floor"] if spot else ""
    await db.execute(
        """INSERT INTO parking_alerts
           (id, kind, spot_id, floor, guest_name, room_label, actor_name, log_id, details_json, created_at, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            f"pal_{uuid.uuid4().hex[:12]}", kind, spot_id, floor,
            details.get("guestName") or "", _room_label(details), user.full_name, log_id,
            json.dumps(details), created_at, log_id,
        ),
    )
    return True


def _due_state(row) -> str:
    from app.routes.parking import _today
    if row["status"] != "occupied" or not row["date_out"]:
        return ""
    when = f"{row['date_out']} {row['time_out'] or '00:00'}"
    now = datetime.now(RIYADH).strftime("%Y-%m-%d %H:%M")
    if when <= now:
        return "overdue"
    if row["date_out"] == _today():
        return "due"
    return ""


async def _sync_due_alerts(db):
    cursor = await db.execute("SELECT * FROM parking_spots WHERE status = 'occupied'")
    live = {}
    for row in await cursor.fetchall():
        state = _due_state(row)
        if not state:
            continue
        key = f"{state}:{row['id']}:{row['date_out']}:{row['time_out']}"
        details = {
            "guestName": row["guest_name"], "room": row["room"], "isVisitor": bool(row["is_visitor"]),
            "isHod": bool(row["is_hod"]), "position": row["position"], "plate": row["plate"],
            "carModel": row["car_model"], "carColour": row["car_colour"],
            "dateOut": row["date_out"], "timeOut": row["time_out"],
        }
        live[row["id"]] = (key, state, row["floor"], details)
    cursor = await db.execute("SELECT id, spot_id, kind, dedupe_key FROM parking_alerts WHERE kind IN ('due', 'overdue')")
    existing = await cursor.fetchall()
    remove = []
    seen = set()
    for alert in existing:
        wanted = live.get(alert["spot_id"])
        if wanted and alert["kind"] == wanted[1]:
            seen.add(alert["spot_id"])
            key, _state, floor, details = wanted
            if alert["dedupe_key"] != key:
                await db.execute(
                    """UPDATE parking_alerts
                       SET dedupe_key = ?, floor = ?, guest_name = ?, room_label = ?, details_json = ?
                       WHERE id = ?""",
                    (key, floor, details.get("guestName") or "", _room_label(details), json.dumps(details), alert["id"]),
                )
            continue
        remove.append(alert["id"])
    if remove:
        marks = ",".join("?" for _ in remove)
        await db.execute(f"DELETE FROM parking_alert_reads WHERE alert_id IN ({marks})", remove)
        await db.execute(f"DELETE FROM parking_alerts WHERE id IN ({marks})", remove)
    from datetime import datetime
    from app.routes.parking import RIYADH
    now = datetime.now(RIYADH).isoformat(timespec="seconds")
    for spot_id, (key, state, floor, details) in live.items():
        if spot_id in seen:
            continue
        await db.execute(
            """INSERT OR IGNORE INTO parking_alerts
               (id, kind, spot_id, floor, guest_name, room_label, actor_name, log_id, details_json, created_at, dedupe_key)
               VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)""",
            (
                f"pal_{uuid.uuid4().hex[:12]}", state, spot_id, floor,
                details.get("guestName") or "", _room_label(details), json.dumps(details), now, key,
            ),
        )
    await db.commit()


def _alert_public(row) -> dict:
    details = _loads(row["details_json"], {})
    if not isinstance(details, dict):
        details = {}
    label = {"checkin": "Check-in", "checkout": "Check-out", "extend": "Extended stay", "due": "Due out today", "overdue": "Overdue"}.get(row["kind"], row["kind"])
    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": f"{label} · {row['spot_id']}",
        "floor": f"Floor {row['floor']}" if row["floor"] else "",
        "guestName": row["guest_name"],
        "room": row["room_label"],
        "actorName": row["actor_name"],
        "createdAt": row["created_at"],
        "details": details,
    }


@router.get("/people")
async def list_people(_: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute(
        "SELECT id, first_name, last_name, username FROM users ORDER BY first_name COLLATE NOCASE, username COLLATE NOCASE"
    )
    people = []
    for row in await cursor.fetchall():
        name = f"{row['first_name']} {row['last_name']}".strip() or row["username"]
        people.append({"id": row["id"], "name": name})
    return people


@router.get("/parking")
async def parking_alerts(user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    await _sync_due_alerts(db)
    # Due and overdue stay in the list. Only check-in, check-out, and extension rows are capped.
    unread = "NOT EXISTS (SELECT 1 FROM parking_alert_reads r WHERE r.alert_id = a.id AND r.user_id = ?)"
    due_rows = await (await db.execute(
        f"SELECT a.* FROM parking_alerts a WHERE a.kind IN ('due', 'overdue') AND {unread} ORDER BY a.created_at DESC",
        (user.user_id,),
    )).fetchall()
    event_rows = await (await db.execute(
        f"SELECT a.* FROM parking_alerts a WHERE a.kind NOT IN ('due', 'overdue') AND {unread} ORDER BY a.created_at DESC LIMIT 20",
        (user.user_id,),
    )).fetchall()
    rows = list(due_rows) + list(event_rows)
    rows.sort(key=lambda row: row["created_at"] or "", reverse=True)
    return [_alert_public(row) for row in rows]


@router.post("/parking/{alert_id}/ok")
async def dismiss_parking_alert(alert_id: str, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("SELECT id FROM parking_alerts WHERE id = ?", (alert_id,))
    if not await cursor.fetchone():
        raise HTTPException(status_code=404, detail="Alert not found")
    await db.execute(
        "INSERT OR IGNORE INTO parking_alert_reads (alert_id, user_id) VALUES (?, ?)",
        (alert_id, user.user_id),
    )
    await db.commit()
    return {"ok": True}


def _line(at: str, label: str, actor: str) -> str:
    when = (at or "").replace("T", " ")[:16]
    return " — ".join(part for part in (when, label, actor) if part)


def _priority_cls(priority: str) -> str:
    if priority == "urgent":
        return "urgent"
    if priority == "follow":
        return "follow"
    return "normal"


async def _names(db) -> dict:
    cursor = await db.execute("SELECT id, first_name, last_name, username FROM users")
    names = {}
    for row in await cursor.fetchall():
        names[row["id"]] = f"{row['first_name']} {row['last_name']}".strip() or row["username"]
    return names


async def _comment_list(db, followup_id: str) -> list:
    cursor = await db.execute(
        "SELECT actor_name, body, created_at FROM followup_comments WHERE followup_id = ? ORDER BY created_at ASC",
        (followup_id,),
    )
    return [{
        "at": (row["created_at"] or "").replace("T", " ")[:16],
        "actor": row["actor_name"],
        "body": row["body"],
    } for row in await cursor.fetchall()]


async def _tell_follow(source: str, item_id: str, date: str):
    await ws_manager.broadcast({
        "event": "FOLLOWUP_UPDATED",
        "source": source,
        "id": item_id,
        "date": date or "",
    })


def _follows(user: TokenData, created_by: str, assignees: list, manager: str) -> bool:
    if user.user_id in assignees or (created_by or "") == user.user_id:
        return True
    name = user.full_name
    if not name or not manager:
        return False
    return manager == name or manager.startswith(name + " — ")


@router.get("/followups")
async def followups(user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute("SELECT until_ts FROM followup_snooze WHERE user_id = ?", (user.user_id,))
    snooze = await cursor.fetchone()
    if snooze and float(snooze["until_ts"] or 0) > time.time():
        return {"show": False, "items": []}
    names = await _names(db)
    items = []
    cursor = await db.execute("SELECT * FROM notes WHERE status IN ('open', 'progress')")
    for note in await cursor.fetchall():
        assignees = assignee_ids(note["assignees_json"])
        if not _follows(user, note["created_by"], assignees, note["manager"]):
            continue
        events = await db.execute(
            "SELECT status, actor, created_at FROM note_events WHERE note_id = ? ORDER BY created_at ASC",
            (note["id"],),
        )
        lines = [_line(row["created_at"], STATUS_LABEL.get(row["status"], row["status"]), row["actor"]) for row in await events.fetchall()]
        if not lines:
            lines = [_line(note["created_at"], note["status"], note["manager"])]
        items.append({
            "id": note["id"], "source": "duty", "date": note["report_date"],
            "priority": note["priority"], "cls": _priority_cls(note["priority"]),
            "priorityLabel": PRIORITY_LABEL.get(note["priority"], "Normal"),
            "department": note["department"], "status": note["status"],
            "title": note["text"], "text": note["text"], "photo": note["photo_url"] or "",
            "assignedBy": note["manager"], "assignedTo": [names.get(item, item) for item in assignees],
            "lines": lines, "comments": await _comment_list(db, f"duty:{note['id']}"),
            "reportLabel": f"Duty report · {note['report_date']}",
        })
    cursor = await db.execute("SELECT date, inspection_json FROM night_reports")
    for row in await cursor.fetchall():
        inspection = _loads(row["inspection_json"], {})
        if not isinstance(inspection, dict):
            continue
        for note in inspection.get("notes") or []:
            if not isinstance(note, dict) or note.get("status") not in ("open", "progress"):
                continue
            assignees = assignee_ids(note.get("assignees"))
            if not _follows(user, note.get("createdBy") or "", assignees, note.get("manager") or ""):
                continue
            lines = []
            for event in note.get("timeline") or []:
                if isinstance(event, dict):
                    lines.append(_line(event.get("at") or "", event.get("status") or "", event.get("actor") or ""))
            if not lines:
                lines = [_line(note.get("time") or "", note.get("status") or "open", note.get("manager") or "")]
            items.append({
                "id": note.get("id") or "", "source": "night", "date": row["date"],
                "priority": note.get("priority") or "normal", "cls": _priority_cls(note.get("priority") or "normal"),
                "priorityLabel": PRIORITY_LABEL.get(note.get("priority") or "normal", "Normal"),
                "department": note.get("department") or "", "status": note.get("status") or "open",
                "title": note.get("text") or "", "text": note.get("text") or "", "photo": note.get("photo_url") or "",
                "assignedBy": note.get("manager") or "", "assignedTo": [names.get(item, item) for item in assignees],
                "lines": [line for line in lines if line],
                "comments": await _comment_list(db, f"night:{row['date']}:{note.get('id')}"),
                "reportLabel": f"Night report · {row['date']}",
            })
    return {"show": bool(items), "items": items}


@router.post("/snooze")
async def snooze(data: SnoozeBody, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    if data.minutes not in SNOOZE_MINUTES:
        raise HTTPException(status_code=400, detail="Choose 10 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, or 8 hours")
    until = time.time() + data.minutes * 60
    await db.execute(
        "INSERT INTO followup_snooze (user_id, until_ts) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET until_ts = excluded.until_ts",
        (user.user_id, until),
    )
    await db.commit()
    return {"until": until}


async def _night_note(db, date: str, note_id: str):
    cursor = await db.execute("SELECT inspection_json FROM night_reports WHERE date = ?", (date,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    inspection = _loads(row["inspection_json"], {})
    notes = inspection.get("notes") if isinstance(inspection, dict) else None
    if not isinstance(notes, list):
        raise HTTPException(status_code=404, detail="Action item not found")
    for note in notes:
        if isinstance(note, dict) and note.get("id") == note_id:
            return inspection, note
    raise HTTPException(status_code=404, detail="Action item not found")


def _can_follow_night(user: TokenData, note: dict) -> bool:
    return can_write(user.role, "night") or _follows(user, note.get("createdBy") or "", assignee_ids(note.get("assignees")), note.get("manager") or "")


@router.post("/comment")
async def add_comment(data: CommentBody, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    text = (data.body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Type a comment first")
    if data.source == "duty":
        cursor = await db.execute("SELECT * FROM notes WHERE id = ?", (data.id,))
        note = await cursor.fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Action item not found")
        if not can_write(user.role, "duty") and not is_note_follower(note, user):
            raise HTTPException(status_code=403, detail="You cannot comment on this action item")
        followup_id = f"duty:{data.id}"
    elif data.source == "night":
        _, note = await _night_note(db, data.date, data.id)
        if not _can_follow_night(user, note):
            raise HTTPException(status_code=403, detail="You cannot comment on this action item")
        followup_id = f"night:{data.date}:{data.id}"
    else:
        raise HTTPException(status_code=400, detail="Unknown action item")
    created = datetime.now(RIYADH).isoformat(timespec="seconds")
    await db.execute(
        "INSERT INTO followup_comments (id, followup_id, user_id, actor_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (f"fcm_{uuid.uuid4().hex[:12]}", followup_id, user.user_id, user.full_name, text, created),
    )
    await db.commit()
    await _tell_follow(data.source, data.id, data.date)
    return {"line": _line(created, "Comment", f"{user.full_name} — {text}"), "at": created.replace("T", " ")[:16], "actor": user.full_name, "body": text}


@router.post("/status")
async def set_follow_status(data: StatusBody, user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    if data.status not in ("open", "progress", "closed"):
        raise HTTPException(status_code=400, detail="Unknown status")
    if data.source != "night":
        raise HTTPException(status_code=400, detail="Use the duty note update for duty items")
    inspection, note = await _night_note(db, data.date, data.id)
    if not _can_follow_night(user, note):
        raise HTTPException(status_code=403, detail="You cannot change this action item")
    from datetime import datetime
    from app.routes.parking import RIYADH
    now = datetime.now(RIYADH).isoformat(timespec="seconds")
    note["status"] = data.status
    timeline = note.get("timeline") if isinstance(note.get("timeline"), list) else []
    timeline.append({"status": data.status, "at": now, "actor": user.full_name})
    note["timeline"] = timeline
    await db.execute("UPDATE night_reports SET inspection_json = ? WHERE date = ?", (json.dumps(inspection), data.date))
    await db.commit()
    await _tell_follow("night", data.id, data.date)
    return {"line": _line(now, data.status, user.full_name)}
