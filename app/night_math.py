from decimal import Decimal, ROUND_HALF_UP

def money(value: float) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))

def pct(part: float, whole: float):
    if not whole:
        return None
    return part / whole

def night_figures(rooms_available, rooms_occupied, rooms_revenue, fb_revenue, me_revenue, ood_revenue, other_revenue):
    return {
        "occupancy": pct(rooms_occupied, rooms_available),
        "adr": pct(rooms_revenue, rooms_occupied),
        "revpar": pct(rooms_revenue, rooms_available),
        "grandTotal": rooms_revenue + fb_revenue + me_revenue + ood_revenue + other_revenue,
        "oodRevenue": ood_revenue,
    }

def segment_gap(rooms_occupied, segment_rooms):
    total = sum(segment_rooms)
    return {"segmentRooms": total, "unassigned": rooms_occupied - total}

def month_to_date(rooms_available, day_number, rows):
    occupied = sum(r["rooms_occupied"] for r in rows)
    rooms_rev = sum(r["rooms_revenue"] for r in rows)
    fb = sum(r["fb_revenue"] for r in rows)
    me = sum(r["me_revenue"] for r in rows)
    ood = sum(r["ood_revenue"] for r in rows)
    other = sum(r["other_revenue"] for r in rows)
    available = rooms_available * day_number
    return {
        "roomsOccupied": occupied,
        "roomsRevenue": rooms_rev,
        "fbRevenue": fb,
        "meRevenue": me,
        "oodRevenue": ood,
        "otherRevenue": other,
        "available": available,
        "occupancy": pct(occupied, available),
        "adr": pct(rooms_rev, occupied),
        "revpar": pct(rooms_rev, available),
        "grandTotal": rooms_rev + fb + me + ood + other,
    }

def missing_dates(year, month, through_day, saved):
    out = []
    for day in range(1, through_day + 1):
        iso = f"{year:04d}-{month:02d}-{day:02d}"
        if iso not in saved:
            out.append(iso)
    return out
