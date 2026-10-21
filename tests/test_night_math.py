from app.night_math import money, night_figures, segment_gap, month_to_date, missing_dates

def test_oct_8_last_night_matches_workbook():
    figs = night_figures(394, 235, 83561.14, 12833.52, 0, 0, 406.96)
    assert money(figs["occupancy"] * 100) == 60
    assert money(figs["adr"]) == 356
    assert money(figs["revpar"]) == 212
    assert money(figs["grandTotal"]) == 96802

def test_ood_is_included_in_grand_total():
    figs = night_figures(394, 235, 83561.14, 12833.52, 0, 100, 406.96)
    assert figs["grandTotal"] == 83561.14 + 12833.52 + 0 + 100 + 406.96
    assert figs["oodRevenue"] == 100

def test_adr_blank_when_no_rooms_occupied():
    figs = night_figures(394, 0, 0, 0, 0, 0, 0)
    assert figs["adr"] is None

def test_segment_gap_on_oct_8():
    gap = segment_gap(235, [1, 25, 16, 5, 99, 66, 0])
    assert gap == {"segmentRooms": 212, "unassigned": 23}

def test_mtd_occupancy_counts_saved_nights_only():
    rows = [
        {"rooms_available": 394, "rooms_occupied": 89, "rooms_revenue": 77880.0, "fb_revenue": 0, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 0},
        {"rooms_available": 394, "rooms_occupied": 50, "rooms_revenue": 300000.0, "fb_revenue": 0, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 0},
        {"rooms_available": 394, "rooms_occupied": 0, "rooms_revenue": 0, "fb_revenue": 0, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 0},
    ]
    mtd = month_to_date(394, 18, rows)
    assert mtd["roomsOccupied"] == 139
    assert mtd["available"] == 1182
    assert money(mtd["occupancy"] * 100) == 12
    assert money(mtd["roomsRevenue"]) == 377880


def test_mtd_revenue_still_sums_every_saved_row():
    rows = [
        {"rooms_occupied": 1458, "rooms_revenue": 528049.00, "fb_revenue": 68661.02, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 2980.99},
        {"rooms_occupied": 235, "rooms_revenue": 83561.14, "fb_revenue": 12833.52, "me_revenue": 0, "ood_revenue": 0, "other_revenue": 406.96},
    ]
    mtd = month_to_date(394, 8, rows)
    assert mtd["roomsOccupied"] == 1693
    assert mtd["available"] == 788
    assert money(mtd["adr"]) == 361
    assert money(mtd["grandTotal"]) == 696493

def test_missing_dates_lists_gaps_only():
    saved = {"2026-10-01", "2026-10-03"}
    assert missing_dates(2026, 10, 4, saved) == ["2026-10-02", "2026-10-04"]
