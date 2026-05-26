"""共用 helper：日期換算、稽核日誌、字串裁切、orderNo 驗證。

對應 backend/src/routes/orders.js 開頭的共用函式。
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from .db import prisma

ORDER_NO_RE = re.compile(r"^[A-Z]\d{10}$")


def valid_order_no(s) -> bool:
    return isinstance(s, str) and bool(ORDER_NO_RE.match(s))


def valid_machine(s, allowed: set) -> bool:
    return not s or str(s) in allowed


def clip_str(s, max_len: int) -> Optional[str]:
    if s is None:
        return None
    return str(s)[:max_len]


def to_taiwan_date(t) -> datetime:
    """轉成「台灣日期」（UTC 午夜，作為純日期標記）。對應 toTaiwanDate(t)。"""
    if t is None:
        d = datetime.now(timezone.utc)
    elif isinstance(t, datetime):
        d = t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    else:
        d = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
    tw = d.astimezone(timezone.utc) + timedelta(hours=8)
    return datetime(tw.year, tw.month, tw.day, tzinfo=timezone.utc)


def taiwan_date_at_8(t) -> datetime:
    """台灣當日 08:00 對應的 UTC 時間（= 台灣日期的 UTC 00:00）。"""
    return to_taiwan_date(t)


def has_activity(o) -> bool:
    keys = [
        "step1At", "step2At", "step3At", "step4At",
        "step5At", "step6At", "step7At", "step11At",
        "step21At", "step22At", "step23At",
    ]
    return any(getattr(o, k, None) for k in keys)


async def audit(request, action: str, target=None, detail=None):
    """寫稽核日誌；任何錯誤都吞掉不擴散。"""
    try:
        user = getattr(request.state, "user", None)
        await prisma.auditlog.create(
            data={
                "actorId": (user or {}).get("id"),
                "actorName": (user or {}).get("displayName"),
                "action": action,
                "target": clip_str(target, 200),
                "detail": clip_str(detail, 500),
                "ip": request.client.host if request.client else None,
            }
        )
    except Exception:
        pass


STEP_COLS = {
    "21": {"time": "step21At", "note": None},
    "22": {"time": "step22At", "note": None},
    "23": {"time": "step23At", "note": None},
    "1":  {"time": "step1At",  "note": None},
    "2":  {"time": "step2At",  "note": None},
    "3":  {"time": "step3At",  "note": None},
    "4":  {"time": "step4At",  "note": None},
    "5":  {"time": "step5At",  "note": None},
    "6":  {"time": "step6At",  "note": None},
    "7":  {"time": "step7At",  "note": None},
    "11": {"time": "step11At", "note": "step11Note"},
    "12": {"time": "step12At", "note": "step12Note"},
    "13": {"time": "step13At", "note": "step13Note"},
}
