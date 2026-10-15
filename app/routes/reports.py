import json
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
import aiosqlite
from app.database import get_db
from app.models import ReportSave, ReportIndexItem, TrustYouData
from app.auth import can_write, get_current_user, require_admin, require_auth, TokenData
from app.routes.notes import note_payload, timelines_for
from app.ws import ws_manager

router = APIRouter(prefix="/api/reports", tags=["reports"])
logger = logging.getLogger("novotel.reports")

AREA_SECTIONS = [
    {'key':'publicAreas', 'title':'Public Areas – GF', 'items':[
      'Main Entrance (Outside & Inside)','Saudi Coffee Table','Lobby Sound / Smell','Reception / Public Desks on Duty?',
      'Security and Safety on Duty?','Somou Taxi on Duty?','Rose on Table / Indoor & Outdoor Plants','GF – Guest Bathroom',
      'Lights / Clock Timing','Lobby Coffee Shop (Studio)','Guest Elevators','Service Elevators','Lift Landing (Service Area)',
      'GF – Reception / Offices','Electricity Room','Staff Appearance / Uniform','Prayer Area','Luggage Room','TV','Currency Exchange Board'
    ]},
    {'key':'surrounding', 'title':'Hotel Surrounding', 'items':[
      'Hotel Lighting','Security Room','Hotel Signage','Parking Entrance / Security on Duty','Emergency Exits / Basement – 12 Floors'
    ]},
    {'key':'parking', 'title':'Parking & Basement', 'items':[
      {'label':'Basement 1', 'desc':'Receiving area, garbage room, lift landing, cleanliness, lights, generator room, kitchen area'},
      {'label':'Basement 2', 'desc':'Guest entrance lift landing, cleanliness, stores, lights'},
      {'label':'Basement 3', 'desc':'Guest entrance, lift landing, cleanliness, stores, lights, CCTV room'},
      {'label':'Basement 4', 'desc':'Locker room / bathroom & changing room, staff prayer room, server room, pump rooms, stores'}
    ]},
    {'key':'restaurant', 'title':'Restaurant / M-Floor', 'items':[
      'Trio Restaurant','Food Square Restaurant','Kitchen Area','Staff Appearance and Uniform','Lift Landing Area / Service – Guest','Public Toilets'
    ]},
    {'key':'firstFloor', 'title':'1st Floor', 'items':[
      'Admin Offices Locked and Lights Off','Public Toilets','Meeting Rooms – Almuhajren / Alansar','Albustan Lounge & Prayer Area','Lift Landing Area / Service – Guest'
    ]},
    {'key':'guestFloors', 'title':'Guest Floors', 'items': [f'Floor {i+1}' for i in range(12)]}
]

CAFETERIA_ITEMS = [
    'Back of House store is clean and well arranged','All food product items are within their expiry dates',
    'All colleagues are groomed to standard','All food containers are clean and free of cracks or stains',
    'All food is labeled properly, and dishes spelt properly','All condiments are clean and filled','Paper napkins are present',
    'All food is in good appearance','Food variety is to standard','Food quality is to standard','Food temperature is to standard',
    'All counters and surfaces are cleaned','Beverage station is filled to standard','Beverage station is clean to standard',
    'Clearance area is cleaned','Food and beverage supply sufficient for staff on shift','Tables in the outlet are clean and in good condition'
]

def default_report_dict(date: str) -> dict:
    checklists = {}
    for sec in AREA_SECTIONS:
        checklists[sec['key']] = [{'status': None, 'comment': '', 'photos': []} for _ in sec['items']]
    
    return {
        "date": date,
        "status": "draft",
        "submittedAt": None,
        "submittedBy": None,
        "shiftStart": "",
        "shiftEnd": "",
        "occupancy": "",
        "arrivals": "",
        "departures": "",
        "inHouse": "",
        "allMembers": "",
        "cafeteriaMealTime": "",
        "cafeteriaTime": "",
        "checklists": checklists,
        "cafeteriaItems": [{'status': None, 'comment': '', 'photos': []} for _ in CAFETERIA_ITEMS],
        "roomsInspection": [],
        "courtesyCalls": [],
        "trustYou": {"totalReviews": "", "gss": "", "keyPositive": "", "keyNegative": "", "comment": ""},
        "complaints": [],
        "incidents": [],
        "generalComments": [],
        "notes": []
    }

@router.get("/index")
async def get_reports_index(db: aiosqlite.Connection = Depends(get_db), user: TokenData = Depends(require_auth)):
    cursor = await db.execute("""
        SELECT r.date, r.status, r.submitted_at, r.submitted_by, r.occupancy, r.all_members,
               COUNT(n.id) as notes_count
        FROM reports r
        LEFT JOIN notes n ON r.date = n.report_date
        GROUP BY r.date
        ORDER BY r.date DESC
    """)
    rows = await cursor.fetchall()
    results = []
    for row in rows:
        results.append({
            "date": row["date"],
            "status": row["status"],
            "submittedAt": row["submitted_at"],
            "submittedBy": row["submitted_by"],
            "occupancy": row["occupancy"] or "",
            "allMembers": row["all_members"] or "",
            "notesCount": row["notes_count"]
        })
    return results

@router.get("")
async def get_report(date: str, db: aiosqlite.Connection = Depends(get_db), user: TokenData = Depends(require_auth)):
    cursor = await db.execute("SELECT * FROM reports WHERE date = ?", (date,))
    row = await cursor.fetchone()
    
    # Also fetch notes for this date
    notes_cursor = await db.execute(
        "SELECT id, report_date, department, priority, text, photo_url, manager, time, status, created_at FROM notes WHERE report_date = ? ORDER BY created_at ASC",
        (date,)
    )
    own_rows = [dict(n) for n in await notes_cursor.fetchall()]
    carried_cursor = await db.execute(
        """
        SELECT n.id, n.report_date, n.department, n.priority, n.text, n.photo_url, n.manager, n.time, n.status, n.created_at
        FROM notes n
        JOIN reports r ON r.date = n.report_date
        WHERE n.report_date < ? AND n.status IN ('open', 'progress') AND r.status = 'submitted'
        ORDER BY n.report_date ASC, n.created_at ASC
        """,
        (date,),
    )
    carried_rows = [dict(n) for n in await carried_cursor.fetchall()]
    timelines = await timelines_for(db, [n["id"] for n in carried_rows + own_rows])
    notes = [note_payload(n, timelines.get(n["id"]), True) for n in carried_rows]
    notes += [note_payload(n, timelines.get(n["id"]), False) for n in own_rows]
    
    if not row:
        rep = default_report_dict(date)
        rep["notes"] = notes
        return rep
    
    def safe_json_load(val, default_val):
        if not val:
            return default_val
        try:
            return json.loads(val)
        except Exception:
            return default_val

    checklists = safe_json_load(row["checklists_json"], {})
    # Ensure all sections exist
    for sec in AREA_SECTIONS:
        if sec["key"] not in checklists:
            checklists[sec["key"]] = [{'status': None, 'comment': ''} for _ in sec['items']]

    cafeteria_items = safe_json_load(row["cafeteria_items_json"], [{'status': None, 'comment': ''} for _ in CAFETERIA_ITEMS])
    rooms_inspection = safe_json_load(row["rooms_inspection_json"], [])
    courtesy_calls = safe_json_load(row["courtesy_calls_json"], [])
    trust_you = safe_json_load(row["trust_you_json"], {"totalReviews": "", "gss": "", "keyPositive": "", "keyNegative": "", "comment": ""})
    complaints = safe_json_load(row["complaints_json"], [])
    incidents = safe_json_load(row["incidents_json"], [])
    general_comments = safe_json_load(row["general_comments_json"], []) if "general_comments_json" in row.keys() else []
    
    return {
        "date": row["date"],
        "status": row["status"],
        "submittedAt": row["submitted_at"],
        "submittedBy": row["submitted_by"],
        "shiftStart": row["shift_start"] or "",
        "shiftEnd": row["shift_end"] or "",
        "occupancy": row["occupancy"] or "",
        "arrivals": row["arrivals"] or "",
        "departures": row["departures"] or "",
        "inHouse": row["in_house"] or "",
        "allMembers": row["all_members"] or "",
        "cafeteriaMealTime": row["cafeteria_meal_time"] or "",
        "cafeteriaTime": (row["cafeteria_time"] or "") if "cafeteria_time" in row.keys() else "",
        "checklists": checklists,
        "cafeteriaItems": cafeteria_items,
        "roomsInspection": rooms_inspection,
        "courtesyCalls": courtesy_calls,
        "trustYou": trust_you,
        "complaints": complaints,
        "incidents": incidents,
        "generalComments": general_comments,
        "notes": notes
    }

@router.post("")
async def save_report(
    data: ReportSave,
    db: aiosqlite.Connection = Depends(get_db),
    user: Optional[TokenData] = Depends(get_current_user)
):
    if not user or not can_write(user.role, "duty"):
        raise HTTPException(status_code=403, detail="Duty section is read-only for this user")

    checklists_json = json.dumps({k: [item.dict() for item in v] for k, v in data.checklists.items()})
    cafeteria_json = json.dumps([item.dict() for item in data.cafeteriaItems])
    rooms_json = json.dumps(data.roomsInspection)
    courtesy_json = json.dumps(data.courtesyCalls)
    trust_you_json = json.dumps(data.trustYou.dict() if data.trustYou else {})
    complaints_json = json.dumps(data.complaints)
    incidents_json = json.dumps(data.incidents)
    general_comments_json = json.dumps(data.generalComments or [])
    
    cursor = await db.execute("SELECT date, status FROM reports WHERE date = ?", (data.date,))
    exists = await cursor.fetchone()
    
    if exists and exists["status"] == "submitted":
        if not user or user.role != "admin":
            raise HTTPException(status_code=403, detail="Only admins can edit a submitted report.")
    
    now_str = datetime.utcnow().isoformat()
    if exists:
        await db.execute("""
            UPDATE reports SET
                shift_start = ?, shift_end = ?, occupancy = ?, arrivals = ?, departures = ?,
                in_house = ?, all_members = ?, cafeteria_meal_time = ?, cafeteria_time = ?, checklists_json = ?,
                cafeteria_items_json = ?, rooms_inspection_json = ?, courtesy_calls_json = ?,
                trust_you_json = ?, complaints_json = ?, incidents_json = ?, general_comments_json = ?, updated_at = ?
            WHERE date = ?
        """, (
            data.shiftStart, data.shiftEnd, data.occupancy, data.arrivals, data.departures,
            data.inHouse, data.allMembers, data.cafeteriaMealTime, data.cafeteriaTime or "", checklists_json,
            cafeteria_json, rooms_json, courtesy_json,
            trust_you_json, complaints_json, incidents_json, general_comments_json, now_str,
            data.date
        ))
    else:
        await db.execute("""
            INSERT INTO reports (
                date, status, shift_start, shift_end, occupancy, arrivals, departures,
                in_house, all_members, cafeteria_meal_time, cafeteria_time, checklists_json,
                cafeteria_items_json, rooms_inspection_json, courtesy_calls_json,
                trust_you_json, complaints_json, incidents_json, general_comments_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data.date, data.status or 'draft', data.shiftStart, data.shiftEnd, data.occupancy, data.arrivals, data.departures,
            data.inHouse, data.allMembers, data.cafeteriaMealTime, data.cafeteriaTime or "", checklists_json,
            cafeteria_json, rooms_json, courtesy_json,
            trust_you_json, complaints_json, incidents_json, general_comments_json, now_str, now_str
        ))
    
    await db.commit()
    
    # Broadcast to connected WebSocket clients
    await ws_manager.broadcast({
        "event": "REPORT_UPDATED",
        "date": data.date,
        "updatedBy": user.full_name if user else "Manager"
    })
    
    return {"success": True, "date": data.date}

@router.post("/{date}/submit")
async def submit_report(
    date: str,
    db: aiosqlite.Connection = Depends(get_db),
    user: Optional[TokenData] = Depends(get_current_user)
):
    if not user or not can_write(user.role, "duty"):
        raise HTTPException(status_code=403, detail="Duty section is read-only for this user")

    now_str = datetime.utcnow().isoformat()
    submitted_by = (user.full_name + (f" — {user.title}" if user.title else "")) if user else "Duty Manager"
    
    # Ensure report row exists
    cursor = await db.execute("SELECT date FROM reports WHERE date = ?", (date,))
    if not await cursor.fetchone():
        rep = default_report_dict(date)
        await db.execute(
            "INSERT INTO reports (date, status, submitted_at, submitted_by, created_at, updated_at) VALUES (?, 'submitted', ?, ?, ?, ?)",
            (date, now_str, submitted_by, now_str, now_str)
        )
    else:
        await db.execute(
            "UPDATE reports SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = ? WHERE date = ?",
            (now_str, submitted_by, now_str, date)
        )
    await db.commit()
    
    await ws_manager.broadcast({
        "event": "REPORT_SUBMITTED",
        "date": date,
        "submittedBy": submitted_by,
        "submittedAt": now_str
    })
    
    return {"success": True, "date": date, "submittedAt": now_str, "submittedBy": submitted_by}

@router.post("/{date}/reopen")
async def reopen_report(
    date: str,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_admin)
):
    await db.execute(
        "UPDATE reports SET status = 'draft', submitted_at = NULL, submitted_by = NULL, updated_at = ? WHERE date = ?",
        (datetime.utcnow().isoformat(), date)
    )
    await db.commit()
    
    await ws_manager.broadcast({
        "event": "REPORT_REOPENED",
        "date": date,
        "reopenedBy": user.full_name
    })
    
    return {"success": True, "date": date}

@router.delete("/{date}")
async def delete_report(
    date: str,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_admin)
):
    cursor = await db.execute("SELECT date FROM reports WHERE date = ?", (date,))
    if not await cursor.fetchone():
        raise HTTPException(status_code=404, detail="Report not found")

    await db.execute("DELETE FROM reports WHERE date = ?", (date,))
    await db.commit()

    await ws_manager.broadcast({
        "event": "REPORT_DELETED",
        "date": date,
        "deletedBy": user.full_name
    })

    return {"success": True, "date": date}

@router.get("/analysis")
async def get_analysis(
    date: str,
    range: str = Query("week", pattern="^(week|month)$"),
    start: str | None = None,
    db: aiosqlite.Connection = Depends(get_db),
    user: TokenData = Depends(require_auth)
):
    try:
        ref_date = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        ref_date = datetime.utcnow()
    
    if range == "week":
        start_date = (ref_date - timedelta(days=6)).strftime("%Y-%m-%d")
    else:
        start_date = ref_date.replace(day=1).strftime("%Y-%m-%d")
    if start:
        try:
            datetime.strptime(start, "%Y-%m-%d")
            start_date = start
        except ValueError:
            pass
    end_date = ref_date.strftime("%Y-%m-%d")
    
    cursor = await db.execute(
        "SELECT * FROM reports WHERE date >= ? AND date <= ? ORDER BY date ASC",
        (start_date, end_date)
    )
    rows = await cursor.fetchall()
    
    # Also fetch notes in date range
    notes_cursor = await db.execute(
        "SELECT * FROM notes WHERE report_date >= ? AND report_date <= ?",
        (start_date, end_date)
    )
    notes_rows = await notes_cursor.fetchall()
    all_notes = [dict(n) for n in notes_rows]
    earlier_cursor = await db.execute(
        """
        SELECT n.id, n.report_date, n.department, n.priority, n.text, n.photo_url, n.manager, n.time, n.status, n.created_at
        FROM notes n
        JOIN reports r ON r.date = n.report_date
        WHERE n.report_date < ? AND n.status IN ('open', 'progress') AND r.status = 'submitted'
        ORDER BY n.report_date ASC, n.created_at ASC
        """,
        (start_date,),
    )
    earlier_notes = [dict(n) for n in await earlier_cursor.fetchall()]
    action_timelines = await timelines_for(db, [n["id"] for n in earlier_notes + all_notes])
    report_status = {row["date"]: row["status"] for row in rows}
    action_items = []
    for note in earlier_notes + all_notes:
        item = note_payload(note, action_timelines.get(note["id"]), note["report_date"] < start_date)
        item["reportStatus"] = "submitted" if item["carried"] else (report_status.get(note["report_date"]) or "")
        action_items.append(item)
    
    total_fail = 0
    section_fails = {sec["title"]: 0 for sec in AREA_SECTIONS}
    section_fails["Staff Cafeteria"] = 0
    item_fail_counts: Dict[str, int] = {}
    item_notes: Dict[str, list] = {}
    
    complaints_list = []
    incidents_list = []
    general_comments_list = []
    courtesy_neg_list = []
    courtesy_pos_count = 0
    courtesy_neg_count = 0
    gss_sum = 0.0
    gss_count = 0
    gss_by_date = {}
    reviews_sum = 0
    neg_comments = []
    pos_comments = []
    
    for row in rows:
        r_date = row["date"]
        checklists = json.loads(row["checklists_json"]) if row["checklists_json"] else {}
        cafeteria_items = json.loads(row["cafeteria_items_json"]) if row["cafeteria_items_json"] else []
        complaints = json.loads(row["complaints_json"]) if row["complaints_json"] else []
        incidents = json.loads(row["incidents_json"]) if row["incidents_json"] else []
        general_comments = json.loads(row["general_comments_json"]) if "general_comments_json" in row.keys() and row["general_comments_json"] else []
        courtesy = json.loads(row["courtesy_calls_json"]) if row["courtesy_calls_json"] else []
        trust_you = json.loads(row["trust_you_json"]) if row["trust_you_json"] else {}
        
        for sec in AREA_SECTIONS:
            sec_items = checklists.get(sec["key"], [])
            for idx, entry in enumerate(sec_items):
                if entry.get("status") is False:
                    total_fail += 1
                    section_fails[sec["title"]] += 1
                    sec_def_item = sec["items"][idx] if idx < len(sec["items"]) else f"Item {idx+1}"
                    label = sec_def_item if isinstance(sec_def_item, str) else sec_def_item.get("label", f"Item {idx+1}")
                    item_key = f"{sec['title']} — {label}"
                    item_fail_counts[item_key] = item_fail_counts.get(item_key, 0) + 1
                    note = str(entry.get("comment") or "").strip()
                    if note:
                        item_notes.setdefault(item_key, []).append({"date": r_date, "text": note})
        
        for idx, entry in enumerate(cafeteria_items):
            if entry.get("status") is False:
                total_fail += 1
                section_fails["Staff Cafeteria"] += 1
                label = CAFETERIA_ITEMS[idx] if idx < len(CAFETERIA_ITEMS) else f"Cafeteria Item {idx+1}"
                item_key = f"Staff Cafeteria — {label}"
                item_fail_counts[item_key] = item_fail_counts.get(item_key, 0) + 1
                note = str(entry.get("comment") or "").strip()
                if note:
                    item_notes.setdefault(item_key, []).append({"date": r_date, "text": note})
        
        for c in complaints:
            if c.get("complaint"):
                complaints_list.append({"date": r_date, **c})
                
        for inc in incidents:
            if inc.get("description"):
                incidents_list.append({"date": r_date, **inc})
        for comment in general_comments:
            if comment.get("comment"):
                general_comments_list.append({"date": r_date, **comment})
                
        for cc in courtesy:
            if cc.get("impression") is False:
                courtesy_neg_count += 1
                courtesy_neg_list.append({"date": r_date, **cc})
            elif cc.get("impression") is True:
                courtesy_pos_count += 1
                
        if trust_you:
            gss_val = trust_you.get("gss")
            if gss_val:
                try:
                    gss_num = float(gss_val)
                    gss_sum += gss_num
                    gss_count += 1
                    gss_by_date[r_date] = round(gss_num, 1)
                except ValueError:
                    pass
            rev_val = trust_you.get("totalReviews")
            if rev_val:
                try:
                    reviews_sum += int(float(rev_val))
                except ValueError:
                    pass
            if trust_you.get("keyNegative"):
                neg_comments.append({"date": r_date, "text": trust_you["keyNegative"]})
            if trust_you.get("keyPositive"):
                pos_comments.append({"date": r_date, "text": trust_you["keyPositive"]})
    
    top_sections = sorted([[k, v] for k, v in section_fails.items() if v > 0], key=lambda x: x[1], reverse=True)
    top_items = [
        {"label": label, "count": count, "notes": item_notes.get(label, [])}
        for label, count in sorted(item_fail_counts.items(), key=lambda x: x[1], reverse=True)[:8]
    ]
    avg_gss = round(gss_sum / gss_count, 1) if gss_count > 0 else "—"
    gss_series = []
    cursor_day = datetime.strptime(start_date, "%Y-%m-%d")
    end_day = datetime.strptime(end_date, "%Y-%m-%d")
    while cursor_day <= end_day:
        gss_series.append(gss_by_date.get(cursor_day.strftime("%Y-%m-%d")))
        cursor_day += timedelta(days=1)
    open_notes_count = len([n for n in action_items if n.get("status") != "closed"])
    
    return {
        "range": range,
        "days": len(rows),
        "startDate": start_date,
        "endDate": end_date,
        "totalFail": total_fail,
        "totalNotesOpen": open_notes_count,
        "actionItems": action_items,
        "totalIncidents": len(incidents_list),
        "courtesyNeg": courtesy_neg_count,
        "courtesyPos": courtesy_pos_count,
        "avgGss": avg_gss,
        "gss": gss_series,
        "reviewsSum": reviews_sum,
        "sectionFails": section_fails,
        "topSections": top_sections,
        "topItems": top_items,
        "complaintsList": complaints_list,
        "incidentsList": incidents_list,
        "generalCommentsList": general_comments_list,
        "courtesyNegList": courtesy_neg_list,
        "negComments": neg_comments,
        "posComments": pos_comments
    }
