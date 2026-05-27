"""admin routes — 對應 backend/src/routes/admin.js.

整個 router 都需要 admin 權限。
"""

import re
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..auth_deps import require_admin
from ..db import prisma
from ..helpers import audit, clip_str

router = APIRouter(dependencies=[Depends(require_admin)])

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{2,30}$")

_LEADER_PUBLIC_FIELDS = ("id", "username", "displayName", "isAdmin", "isPlanner", "createdAt")


def _leader_public(leader) -> dict:
    return {k: getattr(leader, k) for k in _LEADER_PUBLIC_FIELDS}


@router.get("/leaders")
async def list_leaders():
    leaders = await prisma.leader.find_many(order={"createdAt": "asc"})
    return {"leaders": [_leader_public(l) for l in leaders]}


@router.post("/leaders")
async def create_leader(request: Request, user: dict = Depends(require_admin)):
    body = await request.json()
    username = body.get("username")
    password = body.get("password")
    display_name = body.get("displayName")
    is_admin = bool(body.get("isAdmin"))
    is_planner = bool(body.get("isPlanner"))

    if not username or not password or not display_name:
        raise HTTPException(status_code=400, detail="請填寫帳號、密碼、顯示名稱")
    if not USERNAME_RE.match(username):
        raise HTTPException(status_code=400, detail="帳號限英數底線 2~30 字")
    if not isinstance(display_name, str) or not (1 <= len(display_name) <= 30):
        raise HTTPException(status_code=400, detail="顯示名稱長度需 1~30 字")
    if not isinstance(password, str) or not (6 <= len(password) <= 200):
        raise HTTPException(status_code=400, detail="密碼長度需 6~200 字")

    exists = await prisma.leader.find_unique(where={"username": username})
    if exists:
        raise HTTPException(status_code=409, detail="帳號已存在")

    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    leader = await prisma.leader.create(
        data={
            "username": username,
            "passwordHash": password_hash,
            "displayName": display_name,
            "isAdmin": is_admin,
            "isPlanner": is_planner,
        }
    )
    await audit(request, "create_leader", target=username,
                detail=f"admin={is_admin} planner={is_planner}")
    return {"leader": _leader_public(leader)}


@router.post("/leaders/{leader_id}/reset-password")
async def reset_password(leader_id: int, request: Request, user: dict = Depends(require_admin)):
    body = await request.json()
    new_password = body.get("newPassword")
    if not isinstance(new_password, str) or not (6 <= len(new_password) <= 200):
        raise HTTPException(status_code=400, detail="密碼長度需 6~200 字")
    leader = await prisma.leader.find_unique(where={"id": leader_id})
    if not leader:
        raise HTTPException(status_code=404, detail="帳號不存在")
    new_hash = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    await prisma.leader.update(where={"id": leader_id}, data={"passwordHash": new_hash})
    await audit(request, "reset_password", target=leader.username)
    return {"ok": True}


@router.delete("/leaders/{leader_id}")
async def delete_leader(leader_id: int, request: Request, user: dict = Depends(require_admin)):
    if leader_id == user.get("id"):
        raise HTTPException(status_code=400, detail="不能刪除自己")
    leader = await prisma.leader.find_unique(where={"id": leader_id})
    if not leader:
        raise HTTPException(status_code=404, detail="帳號不存在")
    await prisma.order.update_many(where={"leaderId": leader_id}, data={"leaderId": None})
    await prisma.leader.delete(where={"id": leader_id})
    await audit(request, "delete_leader", target=leader.username)
    return {"ok": True}


@router.get("/find-orderno")
async def find_orderno(q: str = Query(...)):
    q = q.strip().upper()
    if not q:
        raise HTTPException(status_code=400, detail="請提供 q 參數")
    if len(q) > 60:
        raise HTTPException(status_code=400, detail="q 太長")

    active_orders = await prisma.order.find_many(
        where={"orderNo": {"contains": q}},
        order={"createdAt": "desc"},
        take=50,
        include={"leader": True},
    )
    deleted_orders = await prisma.order.find_many(
        where={"orderNo": {"contains": q}, "deletedAt": {"not": None}},
        order={"deletedAt": "desc"},
        take=50,
        include={"leader": True},
    )
    orders = list(active_orders) + list(deleted_orders)

    order_ids = [o.id for o in orders]
    soft_entries = []
    soft_pauses = []
    if order_ids:
        soft_entries = await prisma.stepentry.group_by(
            by=["orderId"],
            where={"orderId": {"in": order_ids}, "deletedAt": {"not": None}},
            count={"_all": True},
        )
        soft_pauses = await prisma.pauseevent.group_by(
            by=["orderId"],
            where={"orderId": {"in": order_ids}, "deletedAt": {"not": None}},
            count={"_all": True},
        )
    entry_count = {g["orderId"]: g["_count"]["_all"] for g in soft_entries}
    pause_count = {g["orderId"]: g["_count"]["_all"] for g in soft_pauses}

    upload_rows = await prisma.uploadrow.find_many(
        where={"orderNo": {"contains": q}},
        order={"id": "desc"},
        take=100,
        include={"batch": True},
    )

    def serialize_order(o):
        d = o.model_dump() if hasattr(o, "model_dump") else dict(o.__dict__)
        d["leaderName"] = (o.leader.displayName if o.leader else None)
        d.pop("leader", None)
        d["softDeletedEntries"] = entry_count.get(o.id, 0)
        d["softDeletedPauses"] = pause_count.get(o.id, 0)
        return d

    return {
        "ok": True,
        "orders": [serialize_order(o) for o in orders],
        "uploadRows": upload_rows,
    }


@router.get("/orders-with-soft-deleted-records")
async def orders_with_soft_deleted_records():
    soft_entry_groups = await prisma.stepentry.group_by(
        by=["orderId"],
        where={"deletedAt": {"not": None}},
        count={"_all": True},
        max={"deletedAt": True},
    )
    soft_pause_groups = await prisma.pauseevent.group_by(
        by=["orderId"],
        where={"deletedAt": {"not": None}},
        count={"_all": True},
        max={"deletedAt": True},
    )
    order_ids = list({g["orderId"] for g in soft_entry_groups} |
                     {g["orderId"] for g in soft_pause_groups})
    if not order_ids:
        return {"orders": []}
    orders = await prisma.order.find_many(
        where={"id": {"in": order_ids}},
        include={"leader": True},
    )
    entry_map = {g["orderId"]: g for g in soft_entry_groups}
    pause_map = {g["orderId"]: g for g in soft_pause_groups}

    def serialize(o):
        d = o.model_dump() if hasattr(o, "model_dump") else dict(o.__dict__)
        d["leaderName"] = (o.leader.displayName if o.leader else None)
        d.pop("leader", None)
        e = entry_map.get(o.id, {})
        p = pause_map.get(o.id, {})
        d["softDeletedEntries"] = (e.get("_count") or {}).get("_all", 0)
        d["softDeletedPauses"] = (p.get("_count") or {}).get("_all", 0)
        last_dates = [
            (e.get("_max") or {}).get("deletedAt"),
            (p.get("_max") or {}).get("deletedAt"),
        ]
        last_dates = [d for d in last_dates if d]
        d["lastDeletedAt"] = max(last_dates) if last_dates else None
        return d

    result = [serialize(o) for o in orders]
    result.sort(key=lambda x: x["lastDeletedAt"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {"orders": result}


@router.get("/cancelled-upload-batches")
async def cancelled_upload_batches():
    batches = await prisma.uploadbatch.find_many(
        where={"cancelledAt": {"not": None}},
        order={"cancelledAt": "desc"},
        take=200,
    )
    return {"batches": batches}


@router.get("/audit-log")
async def audit_log(days: int = Query(7), action: str = Query(None)):
    days = max(1, min(int(days or 7), 90))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    where = {"createdAt": {"gte": since}}
    if action:
        where["action"] = str(action)[:60]
    logs = await prisma.auditlog.find_many(where=where, order={"createdAt": "desc"}, take=500)
    return {"logs": logs, "days": days}


@router.post("/migrate-dates")
async def migrate_dates():
    orders = await prisma.order.find_many(
        include={
            "stepEntries": {"where": {"deletedAt": None}, "order_by": {"recordedAt": "asc"}, "take": 1},
            "pauseEvents": {"where": {"deletedAt": None}, "order_by": {"startAt": "asc"}, "take": 1},
        }
    )
    updated = 0
    step_keys = ["step1At", "step2At", "step3At", "step4At", "step5At", "step6At",
                 "step7At", "step11At", "step21At", "step22At", "step23At"]
    for o in orders:
        times = []
        for k in step_keys:
            v = getattr(o, k, None)
            if v:
                times.append(v)
        if o.stepEntries:
            times.append(o.stepEntries[0].recordedAt)
        if o.pauseEvents:
            times.append(o.pauseEvents[0].startAt)
        actual_start_date = min(times) if times else None

        planned_date = None
        earliest_row = await prisma.uploadrow.find_first(
            where={"orderNo": o.orderNo, "batch": {"is": {"cancelledAt": None}}},
            include={"batch": True},
            order={"batchId": "asc"},
        )
        if earliest_row and earliest_row.batch and earliest_row.batch.productionDate:
            planned_date = earliest_row.batch.productionDate
        elif o.productionDate:
            planned_date = o.productionDate

        need_update = (
            (actual_start_date and (not o.actualStartDate or o.actualStartDate != actual_start_date)) or
            (planned_date and (not o.plannedDate or o.plannedDate != planned_date))
        )
        if need_update:
            await prisma.order.update(
                where={"id": o.id},
                data={"actualStartDate": actual_start_date, "plannedDate": planned_date},
            )
            updated += 1
    return {"ok": True, "total": len(orders), "updated": updated}


@router.post("/fix-production-dates")
async def fix_production_dates():
    orders = await prisma.order.find_many(
        include={
            "stepEntries": {"where": {"deletedAt": None}, "order_by": {"recordedAt": "asc"}, "take": 1},
            "pauseEvents": {"where": {"deletedAt": None}, "order_by": {"startAt": "asc"}, "take": 1},
        }
    )
    fixed = 0
    step_keys = ["step1At", "step2At", "step3At", "step4At", "step5At", "step6At",
                 "step7At", "step11At", "step21At", "step22At", "step23At"]
    for o in orders:
        times = []
        for k in step_keys:
            v = getattr(o, k, None)
            if v:
                times.append(v)
        if o.stepEntries:
            times.append(o.stepEntries[0].recordedAt)
        if o.pauseEvents:
            times.append(o.pauseEvents[0].startAt)
        if not times:
            if o.productionDate:
                await prisma.order.update(where={"id": o.id}, data={"productionDate": None})
                fixed += 1
            continue
        earliest = min(times)
        if o.productionDate != earliest:
            await prisma.order.update(where={"id": o.id}, data={"productionDate": earliest})
            fixed += 1
    return {"ok": True, "total": len(orders), "fixed": fixed}


@router.post("/recompute-actual-start-dates")
async def recompute_actual_start_dates():
    """UTC 重構後的資料修補：把舊的 actualStartDate（台灣日期 marker）重算成
    第一筆事件的原始 UTC timestamp。"""
    orders = await prisma.order.find_many(
        include={
            "stepEntries": {"where": {"deletedAt": None}, "order_by": {"recordedAt": "asc"}, "take": 1},
            "pauseEvents": {"where": {"deletedAt": None}, "order_by": {"startAt": "asc"}, "take": 1},
        }
    )
    updated = 0
    step_keys = ["step1At", "step2At", "step3At", "step4At", "step5At", "step6At",
                 "step7At", "step11At", "step21At", "step22At", "step23At"]
    for o in orders:
        times = []
        for k in step_keys:
            v = getattr(o, k, None)
            if v:
                times.append(v)
        if o.stepEntries:
            times.append(o.stepEntries[0].recordedAt)
        if o.pauseEvents:
            times.append(o.pauseEvents[0].startAt)
        new_start = min(times) if times else None
        if o.actualStartDate != new_start:
            await prisma.order.update(
                where={"id": o.id},
                data={"actualStartDate": new_start},
            )
            updated += 1
    return {"ok": True, "total": len(orders), "updated": updated}
