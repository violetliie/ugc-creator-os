"""ET-aware cycle utilities. Mirrors src/lib/cycles.ts.

Cycle id format: 'YYYY-M-H' (M unpadded, H = 1 for days 1 to 15, 2 for 16 to EOM).
Boundaries are precise America/New_York timestamps with hard cutoffs (design notes Q13).
"""
from __future__ import annotations
from datetime import datetime, date, time, timedelta, timezone
import calendar
import pytz

ET = pytz.timezone("America/New_York")


def utcnow() -> datetime:
    """Timezone-aware UTC now.

    Replacement for the deprecated `datetime.utcnow()` (DeprecationWarning on
    Python 3.12+, removal planned). Aware arithmetic (- timedelta, .date())
    behaves identically to the old naive version.
    """
    return datetime.now(timezone.utc)


def utcnow_iso() -> str:
    """ISO-8601 UTC timestamp string for timestamptz columns.

    Emits a '+00:00' suffix (vs the old naive-isoformat + 'Z' concatenation).
    Both forms are valid ISO-8601 and accepted identically by Postgres
    timestamptz, our own parsers (which .replace('Z', '+00:00') first), and
    JS `new Date()`.
    """
    return datetime.now(timezone.utc).isoformat()


def cycle_id_for_datetime(dt_aware) -> str:
    """Given a tz-aware datetime, return its cycle id by converting to ET."""
    et = dt_aware.astimezone(ET)
    half = 1 if et.day <= 15 else 2
    return f"{et.year}-{et.month}-{half}"


def cycle_id_for_date(d: date) -> str:
    """Given a date (e.g., videos.posted_date), return its cycle id.

    Round 18 (2026-05-21): preferred over cycle_id_for_datetime when working
    from Shortimize's `uploaded_at` (date-only) field. The previous code path
    derived the cycle from `created_at_remote` (Shortimize's INDEX timestamp),
    which can lag posted_date by 1-5+ days. For a video posted on Apr 30 but
    indexed May 2, that wrongly assigned it to cycle 2026-5-1 instead of
    2026-4-2 — creator's payout shifted to the wrong cycle.

    We treat the date as an ET calendar day directly. Same `day <= 15` cutoff
    as cycle_id_for_datetime — no tz math needed because the date is already
    the user-perceived posted day.
    """
    half = 1 if d.day <= 15 else 2
    return f"{d.year}-{d.month}-{half}"


def cycle_bounds(year: int, month: int, half: int):
    """Return (start_et_aware, end_et_aware_exclusive, payment_due_et_aware) for the cycle."""
    if half == 1:
        start = ET.localize(datetime(year, month, 1, 0, 0, 0))
        end = ET.localize(datetime(year, month, 16, 0, 0, 0))
        # Pay at 6 PM ET on EOM
        last_day = calendar.monthrange(year, month)[1]
        due = ET.localize(datetime(year, month, last_day, 18, 0, 0))
    else:
        start = ET.localize(datetime(year, month, 16, 0, 0, 0))
        if month == 12:
            ny, nm = year + 1, 1
        else:
            ny, nm = year, month + 1
        end = ET.localize(datetime(ny, nm, 1, 0, 0, 0))
        # Pay at 6 PM ET on the 15th of next month
        due = ET.localize(datetime(ny, nm, 15, 18, 0, 0))
    return start, end, due


def parse_cycle_id(cid: str):
    parts = cid.split("-")
    if len(parts) != 3:
        raise ValueError(f"Invalid cycle id: {cid}")
    return int(parts[0]), int(parts[1]), int(parts[2])


def ensure_cycles_through(db, year: int, month: int) -> int:
    """Make sure cycles up to the given (year, month) Cycle B exist in DB."""
    inserted = 0
    # Find newest existing cycle
    res = db.table("payment_cycles").select("id").order("period_start", desc=True).limit(1).execute()
    if res.data:
        sy, sm, sh = parse_cycle_id(res.data[0]["id"])
    else:
        sy, sm, sh = 2026, 4, 1  # before Apr 16 first cycle
    # Iterate forward
    y, m, h = sy, sm, sh
    while True:
        # Advance to next cycle
        if h == 1:
            h = 2
        else:
            h = 1
            if m == 12:
                y, m = y + 1, 1
            else:
                m += 1
        if (y, m, h) > (year, month, 2):
            break
        start, end, due = cycle_bounds(y, m, h)
        cid = f"{y}-{m}-{h}"
        try:
            db.table("payment_cycles").insert({
                "id": cid,
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
                "payment_due_at": due.isoformat(),
            }).execute()
            inserted += 1
        except Exception:
            pass  # already exists
    return inserted


def is_snapshot_day(now_et: datetime) -> tuple[bool, str | None]:
    """Return (True, cycle_id_to_lock) if today (ET) is a snapshot lock day at 6 PM ET.

    Cycle A locks at 6 PM ET on EOM of month M (locks 'Y-M-1').
    Cycle B locks at 6 PM ET on the 15th of month M (locks the previous month's 'Y-(M-1)-2').
    """
    y, m, d = now_et.year, now_et.month, now_et.day
    last_day = calendar.monthrange(y, m)[1]

    if d == last_day:
        # Lock Cycle A of current month
        return True, f"{y}-{m}-1"
    if d == 15:
        # Lock Cycle B of previous month
        if m == 1:
            py, pm = y - 1, 12
        else:
            py, pm = y, m - 1
        return True, f"{py}-{pm}-2"
    return False, None
