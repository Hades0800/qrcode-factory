"""orders routes — 對應 backend/src/routes/orders.js（最大檔，含工單核心業務邏輯）。

整個 router 都需要登入。
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from prisma.errors import UniqueViolationError

from ..auth_deps import authenticate
from ..config import ALLOWED_MACHINES
from ..db import prisma
from ..helpers import (STEP_COLS, audit, clip_str, has_activity,
                       taiwan_date_at_8, to_taiwan_date, valid_machine,
                       valid_order_no)

router = APIRouter(dependencies=[Depends(authenticate)])


# ── 共用 helper ───────────────────────────────

ORDER_INCLUDE = {
    "leader": True,
    "pauseEvents": {"where": {"deletedAt": None}},
    "stepEntries": {"where": {"deletedAt": None}, "order_by": {"recordedAt": "asc"}},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_dt(s) -> Optional[datetime]:
    """寬鬆解析 ISO 字串為 timezone-aware datetime。失敗回 None。"""
    if s is None:
        return None
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except (ValueError, TypeError):
        return None


def _valid_date_range(d: datetime) -> bool:
    return 2000 <= d.year <= 2100


async def get_prev_machine_end_at(order) -> Optional[datetime]:
    if not order or not order.machineNo:
        return None
    prev = await prisma.order.find_first(
        where={
            "machineNo": order.machineNo,
            "step11At": {"not": None},
            "id": {"not": order.id},
        },
        order={"step11At": "desc"},
    )
    return prev.step11At if prev else None


async def set_actual_start_date(order, event_time: datetime):
    """規則：actualStartDate 一旦有值就鎖死，不再覆寫。"""
    if order.actualStartDate:
        return
    await prisma.order.update(
        where={"orderNo": order.orderNo},
        data={"actualStartDate": to_taiwan_date(event_time)},
    )


def _summarize_pauses(events, ptype):
    items = [e for e in events if e.type == ptype]
    closed = [e for e in items if e.endAt]
    active = next((e for e in items if not e.endAt), None)
    return {
        "count": len(closed),
        "totalSec": sum((e.duration or 0) for e in closed),
        "active": ({
            "id": active.id, "startAt": active.startAt,
            "note": active.note, "activeStep": active.activeStep,
        } if active else None),
        "history": [{
            "id": e.id, "activeStep": e.activeStep, "startAt": e.startAt,
            "endAt": e.endAt, "duration": e.duration, "note": e.note,
            "qcActualQty": e.qcActualQty,
        } for e in items],
    }


def serialize_order(o, prev_machine_end_at=None):
    if not o:
        return None
    events = o.pauseEvents or []
    return {
        "orderNo": o.orderNo,
        "machineNo": o.machineNo or "",
        "plannedMachineNo": o.plannedMachineNo or "",
        "leaderId": o.leaderId,
        "leaderName": (o.leader.displayName if o.leader else ""),
        "step21At": o.step21At, "step22At": o.step22At, "step23At": o.step23At,
        "step1At": o.step1At, "step2At": o.step2At, "step3At": o.step3At,
        "step4At": o.step4At, "step5At": o.step5At, "step6At": o.step6At,
        "step7At": o.step7At, "step11At": o.step11At,
        "step11Note": o.step11Note or None,
        "step11QcActualQty": o.step11QcActualQty,
        "plannedDate": o.plannedDate or o.productionDate or None,
        "actualStartDate": o.actualStartDate or None,
        "productionDate": o.actualStartDate or o.plannedDate or o.productionDate or None,
        "specType": o.specType or None,
        "difficultyFactor": o.difficultyFactor or None,
        "newSpecAspects": (o.newSpecAspects.split(",") if o.newSpecAspects else []),
        "changeScope": o.changeScope or None,
        "materialType": o.materialType or None,
        "auxEquipment": o.auxEquipment or None,
        "auxEquipmentCustom": o.auxEquipmentCustom or None,
        "operatorName": o.operatorName or None,
        "totalWorkers": o.totalWorkers,
        "productSpec": o.productSpec or "",
        "moldSpec": o.moldSpec or "",
        "material": o.material or "",
        "dispatchQty": o.dispatchQty,
        "bladeCount": o.bladeCount,
        "machineSPM": o.machineSPM,
        "unitWeight": o.unitWeight,
        "totalWeight": o.totalWeight,
        "pause12": _summarize_pauses(events, "12"),
        "pause13": _summarize_pauses(events, "13"),
        "stepEntries": [{
            "id": e.id, "stepNo": e.stepNo, "seq": e.seq,
            "recordedAt": e.recordedAt, "isManual": e.isManual or False,
            "note": e.note, "qcActualQty": e.qcActualQty, "leaderName": e.leaderName,
        } for e in (o.stepEntries or [])],
        "prevMachineEndAt": prev_machine_end_at,
        "createdAt": o.createdAt, "updatedAt": o.updatedAt,
    }


async def serialize_with_prev(order):
    if not order:
        return None
    return serialize_order(order, prev_machine_end_at=await get_prev_machine_end_at(order))


async def _reload_order(order_no):
    return await prisma.order.find_unique(where={"orderNo": order_no}, include=ORDER_INCLUDE)


# ── 上傳批次 ───────────────────────────────
# 必須在 /{order_no} 之前定義以避免路由衝突

@router.get("/upload-batches")
async def list_upload_batches(limit: int = Query(50)):
    limit = min(int(limit or 50), 200)
    batches = await prisma.uploadbatch.find_many(order={"uploadedAt": "desc"}, take=limit)
    return {"batches": batches}


@router.delete("/upload-batches/{batch_id}")
async def cancel_upload_batch(batch_id: int, request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin") and not user.get("isPlanner"):
        raise HTTPException(status_code=403, detail="需要生管或管理員權限")
    batch = await prisma.uploadbatch.find_unique(where={"id": batch_id})
    if not batch:
        raise HTTPException(status_code=404, detail="找不到上傳批次")
    if batch.cancelledAt:
        raise HTTPException(status_code=400, detail="此批次已取消過")

    cleared = 0
    for order_no in (batch.orderNos or []):
        try:
            order = await prisma.order.find_unique(where={"orderNo": order_no})
            if not order:
                continue
            await prisma.order.update(
                where={"orderNo": order_no},
                data={
                    "productSpec": None, "moldSpec": None, "material": None,
                    "dispatchQty": None, "bladeCount": None, "machineSPM": None,
                    "unitWeight": None, "totalWeight": None,
                },
            )
            cleared += 1
        except Exception:
            pass
    await prisma.uploadbatch.update(where={"id": batch_id}, data={"cancelledAt": _now()})
    await audit(request, "cancel_batch", target=batch.id,
                detail=f"filename={batch.filename} cleared={cleared}")
    return {"ok": True, "cleared": cleared}


@router.post("/upload-batches/{batch_id}/restore")
async def restore_upload_batch(batch_id: int, request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    batch = await prisma.uploadbatch.find_unique(where={"id": batch_id})
    if not batch:
        raise HTTPException(status_code=404, detail="找不到上傳批次")
    if not batch.cancelledAt:
        raise HTTPException(status_code=400, detail="此批次未取消，無需救回")

    fields = ["productSpec", "moldSpec", "material", "dispatchQty",
              "bladeCount", "machineSPM", "unitWeight", "totalWeight"]
    restored = 0
    skipped = 0
    for order_no in (batch.orderNos or []):
        try:
            order = await prisma.order.find_unique(where={"orderNo": order_no})
            if not order:
                skipped += 1
                continue
            row = await prisma.uploadrow.find_first(
                where={"batchId": batch_id, "orderNo": order_no,
                       "status": {"in": ["created", "updated"]}},
                order={"id": "asc"},
            )
            if not row:
                skipped += 1
                continue
            data = {}
            for k in fields:
                if getattr(order, k, None) in (None, ""):
                    v = getattr(row, k, None)
                    if v not in (None, ""):
                        data[k] = v
            if not order.plannedDate and batch.productionDate:
                data["plannedDate"] = batch.productionDate
            if data:
                await prisma.order.update(where={"id": order.id}, data=data)
                restored += 1
            else:
                skipped += 1
        except Exception:
            pass
    await prisma.uploadbatch.update(where={"id": batch_id}, data={"cancelledAt": None})
    await audit(request, "restore_batch", target=batch.id,
                detail=f"filename={batch.filename} restored={restored} skipped={skipped}")
    return {"ok": True, "restored": restored, "skipped": skipped}


# ── 批次上傳 ───────────────────────────────

@router.post("/bulk-upload")
async def bulk_upload(request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin") and not user.get("isPlanner"):
        raise HTTPException(status_code=403, detail="需要生管或管理員權限")
    body = await request.json()
    rows = body.get("orders")
    filename = body.get("filename")
    upload_date = body.get("uploadDate")

    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(status_code=400, detail="沒有資料")
    if len(rows) > 500:
        raise HTTPException(status_code=400, detail="單次上傳上限 500 筆")

    clean_filename = re.sub(r"[\\/\x00-\x1f]", "", str(filename or ""))[:200] or "未命名"

    batch_production_date = None
    if upload_date:
        d = _to_dt(upload_date)
        if d and _valid_date_range(d):
            batch_production_date = d

    batch = await prisma.uploadbatch.create(
        data={
            "filename": clean_filename,
            "uploadedBy": user.get("id"),
            "uploadedByName": user.get("displayName"),
            "rowCount": 0,
            "productionDate": batch_production_date,
            "orderNos": [],
        }
    )

    def _num(v, lo, hi, integer=False):
        if v in (None, "", 0):
            return None
        try:
            n = float(v)
        except (TypeError, ValueError):
            return None
        if not (n == n):
            return None
        n = max(lo, min(hi, n))
        return round(n) if integer else n

    created = updated = skipped = 0
    errors = []
    processed = []
    raw_rows = []

    for row in rows:
        order_no = str(row.get("orderNo") or "").upper()
        raw_row = {
            "batchId": batch.id,
            "orderNo": order_no or str(row.get("orderNo") or ""),
            "productSpec": clip_str(row.get("productSpec"), 200),
            "moldSpec": clip_str(row.get("moldSpec"), 100),
            "material": clip_str(row.get("material"), 200),
            "machineNo": clip_str(row.get("machineNo"), 60) if row.get("machineNo") else None,
            "dispatchQty": _num(row.get("dispatchQty"), 0, 1e6, integer=True),
            "bladeCount": _num(row.get("bladeCount"), 0, 1e6, integer=True),
            "machineSPM": _num(row.get("machineSPM"), 0, 1e5, integer=True),
            "unitWeight": _num(row.get("unitWeight"), 0, 1e6),
            "totalWeight": _num(row.get("totalWeight"), 0, 1e9),
            "status": "error",
            "errorMsg": None,
        }
        try:
            if not valid_order_no(order_no):
                raw_row["errorMsg"] = "工單號格式錯誤"
                raw_rows.append(raw_row)
                errors.append((row.get("orderNo") or "(空)") + "：工單號格式錯誤")
                continue
            if row.get("machineNo") and not valid_machine(row.get("machineNo"), ALLOWED_MACHINES):
                raw_row["errorMsg"] = "不允許的機台號 " + str(row.get("machineNo"))
                raw_rows.append(raw_row)
                errors.append(order_no + "：不允許的機台號 " + str(row.get("machineNo")))
                continue

            data = {
                "plannedDate": batch_production_date,
                "productSpec": raw_row["productSpec"],
                "moldSpec": raw_row["moldSpec"],
                "material": raw_row["material"],
                "dispatchQty": raw_row["dispatchQty"],
                "bladeCount": raw_row["bladeCount"],
                "machineSPM": raw_row["machineSPM"],
                "unitWeight": raw_row["unitWeight"],
                "totalWeight": raw_row["totalWeight"],
                "machineNo": raw_row["machineNo"],
                "plannedMachineNo": raw_row["machineNo"],
            }
            existing = await prisma.order.find_unique(where={"orderNo": order_no})
            if existing:
                spec_match = (not existing.productSpec or not data["productSpec"]
                              or existing.productSpec == data["productSpec"])
                if spec_match:
                    merged = {}
                    for k, v in data.items():
                        merged[k] = v if v not in (None, "") else getattr(existing, k, None)
                    await prisma.order.update(where={"orderNo": order_no}, data=merged)
                    raw_row["status"] = "updated"
                    updated += 1
                else:
                    raw_row["status"] = "skipped"
                    raw_row["errorMsg"] = "規格不同，跳過"
                    skipped += 1
            else:
                await prisma.order.create(data={"orderNo": order_no, **data})
                raw_row["status"] = "created"
                created += 1
            processed.append(order_no)
        except Exception as e:
            raw_row["errorMsg"] = str(e)
            errors.append((row.get("orderNo") or "?") + ": " + str(e))
        raw_rows.append(raw_row)

    if raw_rows:
        await prisma.uploadrow.create_many(data=raw_rows)
    await prisma.uploadbatch.update(
        where={"id": batch.id},
        data={"rowCount": len(processed), "orderNos": processed},
    )
    return {
        "ok": True, "created": created, "updated": updated, "skipped": skipped,
        "errors": errors, "total": len(rows), "batchId": batch.id,
    }


@router.post("/bulk-cancel-upload")
async def bulk_cancel_upload(request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin") and not user.get("isPlanner"):
        raise HTTPException(status_code=403, detail="需要生管或管理員權限")
    body = await request.json()
    order_nos = body.get("orderNos")
    if not isinstance(order_nos, list) or len(order_nos) == 0:
        raise HTTPException(status_code=400, detail="沒有資料")
    if len(order_nos) > 500:
        raise HTTPException(status_code=400, detail="單次上限 500 筆")

    cleared = 0
    errs = []
    for raw_no in order_nos:
        try:
            order_no = str(raw_no or "").strip().upper()
            if not order_no:
                continue
            order = await prisma.order.find_unique(where={"orderNo": order_no})
            if not order:
                continue
            await prisma.order.update(
                where={"orderNo": order_no},
                data={
                    "productSpec": None, "moldSpec": None, "material": None,
                    "dispatchQty": None, "bladeCount": None, "machineSPM": None,
                    "unitWeight": None, "totalWeight": None,
                },
            )
            cleared += 1
        except Exception as e:
            errs.append(f"{raw_no}: {e}")
    return {"ok": True, "cleared": cleared, "errors": errs}


# ── 回收桶 ───────────────────────────────

@router.get("/trash")
async def list_trash(user: dict = Depends(authenticate)):
    if not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    orders = await prisma.order.find_many(
        where={"deletedAt": {"not": None}},
        order={"deletedAt": "desc"},
        take=200,
        include={"leader": True},
    )
    return {
        "orders": [{
            "orderNo": o.orderNo,
            "deletedAt": o.deletedAt,
            "productSpec": o.productSpec,
            "moldSpec": o.moldSpec,
            "machineNo": o.machineNo,
            "productionDate": o.productionDate,
            "leader": ({"displayName": o.leader.displayName} if o.leader else None),
        } for o in orders]
    }


# ── 列表 ───────────────────────────────

@router.get("/")
async def list_orders(limit: int = Query(50)):
    limit = min(int(limit or 50), 200)
    orders = await prisma.order.find_many(
        order={"updatedAt": "desc"},
        take=limit,
        include=ORDER_INCLUDE,
    )
    return {"orders": [serialize_order(o) for o in orders]}


# ── 取得（自動建立） ───────────────────────────────

@router.get("/{order_no}")
async def get_or_create_order(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤（需 1 英文 + 10 數字）")
    order = await prisma.order.find_unique(where={"orderNo": order_no}, include=ORDER_INCLUDE)
    was_created = False
    if not order:
        # 顯式查已軟刪除（不被 middleware 過濾）
        soft = await prisma.order.find_first(where={"orderNo": order_no, "deletedAt": {"not": None}})
        if soft:
            raise HTTPException(status_code=409, detail={
                "error": "此工單號之前已被刪除，無法直接重新建立",
                "code": "SOFT_DELETED",
                "hint": "請聯絡管理員到 admin 頁面「回收桶」救回此工單，或請使用其他工單號",
                "deletedAt": soft.deletedAt.isoformat() if soft.deletedAt else None,
            })
        try:
            order = await prisma.order.create(
                data={"orderNo": order_no, "leaderId": user.get("id")},
                include=ORDER_INCLUDE,
            )
            was_created = True
            await audit(request, "auto_create_order", target=order_no,
                        detail=f"via=GET user={user.get('username') or user.get('id')}")
        except UniqueViolationError:
            order = await prisma.order.find_unique(where={"orderNo": order_no}, include=ORDER_INCLUDE)
            if not order:
                raise
    return {"order": await serialize_with_prev(order), "wasCreated": was_created}


# ── step entry（日誌式） ───────────────────────────────

_VALID_STEPS = {"1","2","3","4","5","6","7","8","21","22","23","12","13","30","40","41"}


@router.post("/{order_no}/step-entries")
async def add_step_entry(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    body = await request.json()
    step_no = body.get("stepNo")
    manual_time = body.get("recordedAt")
    raw_note = body.get("note")
    raw_qc = body.get("qcActualQty")

    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    if step_no not in _VALID_STEPS:
        raise HTTPException(status_code=400, detail="無效工序編號")

    note = raw_note.strip()[:200] if isinstance(raw_note, str) else None
    if step_no == "30" and not note:
        raise HTTPException(status_code=400, detail="更換規格需填入規格描述")

    qc_actual_qty = None
    if step_no == "30":
        try:
            n = int(raw_qc)
            assert n >= 0
        except (TypeError, ValueError, AssertionError):
            raise HTTPException(status_code=400, detail="請填入此規格實際生產數量（非負整數）")
        qc_actual_qty = n

    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")

    # step 40 限制：step 41 之後不能再按 40，除非有 30 / 13 / 中午休息結束介入
    if step_no == "40":
        last_41 = await prisma.stepentry.find_first(
            where={"orderId": order.id, "stepNo": "41"},
            order={"recordedAt": "desc"},
        )
        if last_41:
            last_30 = await prisma.stepentry.find_first(
                where={"orderId": order.id, "stepNo": "30"},
                order={"recordedAt": "desc"},
            )
            last_abn = await prisma.pauseevent.find_first(
                where={"orderId": order.id, "type": "13"},
                order={"startAt": "desc"},
            )
            lunch = await prisma.pauseevent.find_first(
                where={
                    "orderId": order.id, "type": "12", "endAt": {"not": None},
                    "OR": [
                        {"note": {"contains": "中午"}},
                        {"note": {"contains": "午休"}},
                        {"note": {"contains": "午餐"}},
                        {"note": {"contains": "下班"}},
                    ],
                },
                order={"endAt": "desc"},
            )
            last_41_ts = last_41.recordedAt
            release_times = []
            if last_30:
                release_times.append(last_30.recordedAt)
            if last_abn:
                release_times.append(last_abn.startAt)
            if lunch and lunch.endAt:
                release_times.append(lunch.endAt)
            last_release = max(release_times) if release_times else datetime.min.replace(tzinfo=timezone.utc)
            if last_41_ts >= last_release:
                raise HTTPException(
                    status_code=400,
                    detail="生產開始後不能再按生產準備（需先「切換規格」、「異常中斷」或「中午休息結束後」才能重新準備）",
                )

    prev_count = await prisma.stepentry.count(where={"orderId": order.id, "stepNo": step_no})
    is_manual = bool(manual_time)
    time_ = _now()
    if manual_time:
        parsed = _to_dt(manual_time)
        if not parsed or not _valid_date_range(parsed):
            raise HTTPException(status_code=400, detail="補登時間格式錯誤")
        if parsed > _now():
            raise HTTPException(status_code=400, detail="補登時間不能超過現在")
        time_ = parsed

    # 強制：本單第一筆生產時態（40/41）的時間
    forced_from_prev = False
    forced_prev_end = None
    forced_reason = None
    if step_no in ("40", "41") and order.machineNo:
        existing_stable = await prisma.stepentry.find_first(
            where={"orderId": order.id, "stepNo": {"in": ["40", "41"]}}
        )
        if not existing_stable:
            prev_end = await get_prev_machine_end_at(order)
            target_day = to_taiwan_date(time_)
            if prev_end and to_taiwan_date(prev_end) == target_day:
                time_ = prev_end + timedelta(minutes=1)
                forced_reason = "prev_same_day"
            else:
                time_ = taiwan_date_at_8(time_)
                forced_reason = "day_start"
            forced_from_prev = True
            forced_prev_end = prev_end

    await set_actual_start_date(order, time_)
    entry = await prisma.stepentry.create(
        data={
            "orderId": order.id,
            "stepNo": step_no,
            "seq": prev_count + 1,
            "recordedAt": time_,
            "isManual": is_manual or forced_from_prev,
            "note": note,
            "qcActualQty": qc_actual_qty,
            "leaderId": user.get("id"),
            "leaderName": user.get("displayName"),
        }
    )
    updated = await _reload_order(order_no)
    return {
        "entry": entry,
        "order": await serialize_with_prev(updated),
        "forcedFromPrev": forced_from_prev,
        "forcedPrevEnd": forced_prev_end,
        "forcedReason": forced_reason,
    }


@router.delete("/{order_no}/step-entries/{entry_id}")
async def delete_step_entry(order_no: str, entry_id: int, user: dict = Depends(authenticate)):
    if not entry_id:
        raise HTTPException(status_code=400, detail="無效 id")
    entry = await prisma.stepentry.find_unique(where={"id": entry_id})
    if not entry:
        raise HTTPException(status_code=404, detail="找不到紀錄")
    elapsed_sec = (_now() - entry.recordedAt).total_seconds()
    if elapsed_sec > 300 and not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="已超過 5 分鐘，無法取消（管理員不受此限制）")
    await prisma.stepentry.delete(where={"id": entry_id})
    updated = await _reload_order(order_no.upper())
    return {"ok": True, "order": (await serialize_with_prev(updated)) if updated else None}


# ── 機台 ───────────────────────────────

@router.post("/{order_no}/machine")
async def set_machine(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    machine_no = body.get("machineNo")
    if not machine_no or not str(machine_no).strip():
        raise HTTPException(status_code=400, detail="機台號不可空白")
    if not valid_machine(machine_no, ALLOWED_MACHINES):
        raise HTTPException(status_code=400, detail="不允許的機台號")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        await prisma.order.create(data={"orderNo": order_no, "leaderId": user.get("id")})
    updated = await prisma.order.update(
        where={"orderNo": order_no},
        data={"machineNo": clip_str(str(machine_no).strip(), 60), "leaderId": user.get("id")},
        include=ORDER_INCLUDE,
    )
    return {"order": await serialize_with_prev(updated)}


# ── 規格類型 ───────────────────────────────

_ALLOWED_ASPECTS = ["mold", "mat", "swm", "raw", "dim"]


@router.post("/{order_no}/spec-type")
async def set_spec_type(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    spec_type = body.get("specType")
    aspects = body.get("aspects")
    if spec_type not in ("new", "mass"):
        raise HTTPException(status_code=400, detail="無效規格類型（需為 new 或 mass）")
    aspects_str = None
    if spec_type == "new" and isinstance(aspects, list):
        cleaned = [a for a in aspects if a in _ALLOWED_ASPECTS]
        aspects_str = ",".join([a for a in _ALLOWED_ASPECTS if a in cleaned]) or None
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    await prisma.order.update(
        where={"orderNo": order_no},
        data={"specType": spec_type, "difficultyFactor": None, "newSpecAspects": aspects_str},
    )
    return {"ok": True, "specType": spec_type, "difficultyFactor": None, "newSpecAspects": aspects_str}


@router.post("/{order_no}/change-scope")
async def set_change_scope(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    change_scope = body.get("changeScope")
    if change_scope is not None and change_scope not in ("@", "#", "@#", "same"):
        raise HTTPException(status_code=400, detail="無效的更換範圍（需為 @ / # / @# / same / null）")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    await prisma.order.update(where={"orderNo": order_no}, data={"changeScope": change_scope})
    return {"ok": True, "changeScope": change_scope}


@router.post("/{order_no}/material-type")
async def set_material_type(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    material_type = body.get("materialType")
    if material_type is not None and material_type not in ("coil", "plate"):
        raise HTTPException(status_code=400, detail="無效的原料類型（需為 coil / plate / null）")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    await prisma.order.update(where={"orderNo": order_no}, data={"materialType": material_type})
    return {"ok": True, "materialType": material_type}


_ALLOWED_AUX = ["flat", "leveler", "slitter", "wave", "rewind", "other"]


@router.post("/{order_no}/aux-equipment")
async def set_aux_equipment(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()

    update_data = {}

    if "auxEquipment" in body:
        aux = body["auxEquipment"]
        codes = []
        if isinstance(aux, list):
            codes = aux
        elif isinstance(aux, str):
            codes = aux.split(",")
        elif aux is None:
            codes = []
        else:
            raise HTTPException(status_code=400, detail="auxEquipment 格式錯誤")
        codes = [str(c).strip() for c in codes if str(c).strip()]
        for c in codes:
            if c not in _ALLOWED_AUX:
                raise HTTPException(status_code=400, detail="無效的輔助設備: " + c)
        uniq = [c for c in _ALLOWED_AUX if c in codes]
        update_data["auxEquipment"] = ",".join(uniq) if uniq else None

    if "auxEquipmentCustom" in body:
        custom = body["auxEquipmentCustom"]
        if custom in (None, ""):
            custom = None
        else:
            custom = str(custom).strip()[:100]
            if not custom:
                custom = None
        update_data["auxEquipmentCustom"] = custom

    if not update_data:
        return {"ok": True}

    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    await prisma.order.update(where={"orderNo": order_no}, data=update_data)
    return {"ok": True, **update_data}


@router.post("/{order_no}/operation-info")
async def set_operation_info(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    update_data = {}

    if "operatorName" in body:
        v = body["operatorName"]
        if v in (None, ""):
            v = None
        else:
            v = str(v).strip()[:50]
            if not v:
                v = None
        update_data["operatorName"] = v

    if "totalWorkers" in body:
        v = body["totalWorkers"]
        if v in (None, ""):
            v = None
        else:
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="人數須為 1-99 的整數")
            if not (1 <= n <= 99):
                raise HTTPException(status_code=400, detail="人數須為 1-99 的整數")
            v = n
        update_data["totalWorkers"] = v

    if not update_data:
        return {"ok": True}

    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    await prisma.order.update(where={"orderNo": order_no}, data=update_data)
    return {"ok": True, **update_data}


# ── 單一欄位式工序 (steps/:step) ───────────────────────────────

@router.post("/{order_no}/steps/{step}")
async def record_step(order_no: str, step: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    cols = STEP_COLS.get(step)
    if not cols:
        raise HTTPException(status_code=400, detail="無效步驟")
    body = await request.json()
    note = body.get("note")
    manual_time = body.get("recordedAt")
    raw_qc = body.get("qcActualQty")

    qc_actual_qty = None
    if step == "11":
        try:
            n = int(raw_qc)
            assert n >= 0
        except (TypeError, ValueError, AssertionError):
            raise HTTPException(status_code=400, detail="請填入此工單／最後規格的實際生產數量（非負整數）")
        qc_actual_qty = n

    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        order = await prisma.order.create(data={"orderNo": order_no, "leaderId": user.get("id")})

    if getattr(order, cols["time"], None):
        existing = await _reload_order(order_no)
        raise HTTPException(status_code=409, detail={
            "error": f"此項目已記錄過：{getattr(order, cols['time']).isoformat()}",
            "order": await serialize_with_prev(existing),
        })

    step_time = _now()
    if manual_time:
        parsed = _to_dt(manual_time)
        if not parsed or not _valid_date_range(parsed):
            raise HTTPException(status_code=400, detail="補登時間格式錯誤")
        if parsed > _now():
            raise HTTPException(status_code=400, detail="補登時間不能超過現在")
        step_time = parsed

    await set_actual_start_date(order, step_time)

    update_data = {cols["time"]: step_time, "leaderId": user.get("id")}
    if cols["note"] and note:
        update_data[cols["note"]] = clip_str(note, 500)
    if step == "11":
        update_data["step11QcActualQty"] = qc_actual_qty

    updated = await prisma.order.update(
        where={"orderNo": order_no}, data=update_data, include=ORDER_INCLUDE,
    )
    return {"order": await serialize_with_prev(updated)}


@router.delete("/{order_no}/steps/{step}")
async def delete_step(order_no: str, step: str, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    cols = STEP_COLS.get(step)
    if not cols:
        raise HTTPException(status_code=400, detail="無效步驟")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    update_data = {cols["time"]: None}
    if cols["note"]:
        update_data[cols["note"]] = None
    updated = await prisma.order.update(
        where={"orderNo": order_no}, data=update_data, include=ORDER_INCLUDE,
    )
    return {"order": await serialize_with_prev(updated)}


# ── 暫停 / 異常 ───────────────────────────────

@router.post("/{order_no}/pause")
async def start_pause(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    ptype = body.get("type")
    note = body.get("note")
    active_step = body.get("activeStep")
    raw_qc = body.get("qcActualQty")
    if ptype not in ("12", "13"):
        raise HTTPException(status_code=400, detail="無效類型")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    active = await prisma.pauseevent.find_first(
        where={"orderId": order.id, "type": ptype, "endAt": None}
    )
    if active:
        raise HTTPException(status_code=409, detail="已在暫停中，請先恢復")

    qc_actual_qty = None
    is_off_work = ptype == "12" and isinstance(note, str) and "下班" in note
    if is_off_work:
        try:
            n = int(raw_qc)
            assert n >= 0
        except (TypeError, ValueError, AssertionError):
            raise HTTPException(status_code=400, detail="請填入此規格實際生產數量（非負整數）")
        qc_actual_qty = n

    pause_start = _now()
    await set_actual_start_date(order, pause_start)
    await prisma.pauseevent.create(
        data={
            "orderId": order.id, "type": ptype,
            "note": clip_str(note, 500), "activeStep": clip_str(active_step, 100),
            "qcActualQty": qc_actual_qty,
        }
    )
    updated = await _reload_order(order_no)
    return {"order": await serialize_with_prev(updated)}


@router.post("/{order_no}/resume")
async def resume_pause(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    ptype = body.get("type")
    if ptype not in ("12", "13"):
        raise HTTPException(status_code=400, detail="無效類型")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    active = await prisma.pauseevent.find_first(
        where={"orderId": order.id, "type": ptype, "endAt": None}
    )
    if not active:
        raise HTTPException(status_code=404, detail="沒有進行中的暫停")
    now = _now()
    await set_actual_start_date(order, active.startAt)
    duration = round((now - active.startAt).total_seconds())
    await prisma.pauseevent.update(where={"id": active.id}, data={"endAt": now, "duration": duration})
    updated = await _reload_order(order_no)
    return {"order": await serialize_with_prev(updated), "resumed": {"type": ptype, "duration": duration}}


@router.post("/{order_no}/pause-backfill")
async def pause_backfill(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    body = await request.json()
    ptype = body.get("type")
    note = body.get("note") or ""
    start_str = body.get("startAt")
    end_str = body.get("endAt")
    raw_qc = body.get("qcActualQty")

    if ptype not in ("12", "13"):
        raise HTTPException(status_code=400, detail="無效類型")
    if not start_str or not end_str:
        raise HTTPException(status_code=400, detail="請填寫開始和結束時間")
    start_at = _to_dt(start_str)
    end_at = _to_dt(end_str)
    if not start_at or not end_at:
        raise HTTPException(status_code=400, detail="時間格式錯誤")
    if end_at <= start_at:
        raise HTTPException(status_code=400, detail="結束時間必須晚於開始時間")
    if end_at > _now():
        raise HTTPException(status_code=400, detail="補登時間不能超過現在")

    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")

    duration = round((end_at - start_at).total_seconds())
    backfill_note = "【補登】" + (note or "")

    qc_actual_qty = None
    if raw_qc not in (None, ""):
        try:
            n = int(raw_qc)
            assert n >= 0
        except (TypeError, ValueError, AssertionError):
            raise HTTPException(status_code=400, detail="QC 數量必須是非負整數")
        qc_actual_qty = n

    await set_actual_start_date(order, start_at)
    await prisma.pauseevent.create(
        data={
            "orderId": order.id, "type": ptype,
            "note": clip_str(backfill_note, 500),
            "startAt": start_at, "endAt": end_at, "duration": duration,
            "qcActualQty": qc_actual_qty,
        }
    )
    updated = await _reload_order(order_no)
    return {"ok": True, "order": await serialize_with_prev(updated)}


# ── 工單刪除 / 重設 / 還原 / 永刪 ───────────────────────────────

@router.delete("/{order_no}")
async def delete_order(order_no: str, request: Request, force: str = Query(""),
                       user: dict = Depends(authenticate)):
    is_admin = user.get("isAdmin")
    is_planner = user.get("isPlanner")
    if not is_admin and not is_planner:
        raise HTTPException(status_code=403, detail="權限不足")
    force_flag = force in ("true", "1")
    if force_flag and not is_admin:
        raise HTTPException(status_code=403, detail="force 模式僅限管理員")
    raw_no = order_no.strip()
    if not raw_no:
        raise HTTPException(status_code=400, detail="缺少工單號")
    order = await prisma.order.find_unique(where={"orderNo": raw_no})
    if not order:
        order = await prisma.order.find_unique(where={"orderNo": raw_no.upper()})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")

    entry_count = await prisma.stepentry.count(where={"orderId": order.id})
    pause_count = await prisma.pauseevent.count(where={"orderId": order.id})
    has_production = has_activity(order) or entry_count > 0 or pause_count > 0

    if has_production and not force_flag:
        raise HTTPException(status_code=409, detail={
            "error": "工單已有生產紀錄，無法直接刪除",
            "code": "HAS_PRODUCTION_DATA",
            "canReset": is_admin,
            "entryCount": entry_count, "pauseCount": pause_count,
        })

    if force_flag and has_production:
        await prisma.stepentry.delete_many(where={"orderId": order.id})
        await prisma.pauseevent.delete_many(where={"orderId": order.id})

    await prisma.order.delete(where={"orderNo": order.orderNo})
    detail = (f"admin_force_delete entries={entry_count} pauses={pause_count}"
              if force_flag else ("admin_delete" if is_admin else "planner_delete_unscanned"))
    await audit(request, "delete_order", target=order.orderNo, detail=detail)
    return {
        "ok": True, "deleted": True, "force": force_flag,
        "entries": entry_count if force_flag else 0,
        "pauses": pause_count if force_flag else 0,
    }


@router.post("/{order_no}/reset-production")
async def reset_production(order_no: str, request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    raw_no = order_no.strip()
    if not raw_no:
        raise HTTPException(status_code=400, detail="缺少工單號")
    order = await prisma.order.find_unique(where={"orderNo": raw_no})
    if not order:
        order = await prisma.order.find_unique(where={"orderNo": raw_no.upper()})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")

    entry_count = await prisma.stepentry.count(where={"orderId": order.id})
    pause_count = await prisma.pauseevent.count(where={"orderId": order.id})
    await prisma.stepentry.delete_many(where={"orderId": order.id})
    await prisma.pauseevent.delete_many(where={"orderId": order.id})
    await prisma.order.update(
        where={"orderNo": order.orderNo},
        data={
            "step1At": None, "step2At": None, "step3At": None, "step4At": None,
            "step5At": None, "step6At": None, "step7At": None,
            "step11At": None, "step12At": None, "step13At": None,
            "step21At": None, "step22At": None, "step23At": None,
            "step12Note": None, "step13Note": None,
            "step4Note": None, "step7Note": None,
            "machineNo": None, "leaderId": None, "actualStartDate": None,
        },
    )
    await audit(request, "reset_production", target=order.orderNo,
                detail=f"entries={entry_count} pauses={pause_count}")
    return {"ok": True, "reset": True, "entryCount": entry_count, "pauseCount": pause_count}


@router.post("/{order_no}/restore")
async def restore_order(order_no: str, request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    raw_no = order_no.strip()
    if not raw_no:
        raise HTTPException(status_code=400, detail="缺少工單號")
    candidates = list({raw_no, raw_no.upper()})
    order = None
    for no in candidates:
        order = await prisma.order.find_first(where={"orderNo": no, "deletedAt": {"not": None}})
        if order:
            break
        order = await prisma.order.find_first(where={"orderNo": no, "deletedAt": None})
        if order:
            break
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")

    order_restored = False
    if order.deletedAt:
        await prisma.order.update(where={"id": order.id}, data={"deletedAt": None})
        order_restored = True
    entry_res = await prisma.stepentry.update_many(
        where={"orderId": order.id, "deletedAt": {"not": None}},
        data={"deletedAt": None},
    )
    pause_res = await prisma.pauseevent.update_many(
        where={"orderId": order.id, "deletedAt": {"not": None}},
        data={"deletedAt": None},
    )
    if not order_restored and entry_res == 0 and pause_res == 0:
        raise HTTPException(status_code=400, detail="此工單沒有任何已刪除的內容可救回")
    action = "restore_order" if order_restored else "restore_records"
    await audit(request, action, target=order.orderNo,
                detail=f"entries={entry_res} pauses={pause_res}")
    return {
        "ok": True, "restored": True, "orderRestored": order_restored,
        "entries": entry_res, "pauses": pause_res,
    }


@router.post("/{order_no}/purge")
async def purge_order(order_no: str, request: Request, user: dict = Depends(authenticate)):
    if not user.get("isAdmin"):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    raw_no = order_no.strip()
    if not raw_no:
        raise HTTPException(status_code=400, detail="缺少工單號")
    candidates = list({raw_no, raw_no.upper()})

    # 用 raw SQL 繞過軟刪除 middleware
    order_id = None
    found_no = None
    for no in candidates:
        rows = await prisma.query_raw(
            'SELECT id, "orderNo" FROM "Order" WHERE "orderNo" = $1 LIMIT 1', no
        )
        if rows:
            order_id = rows[0]["id"]
            found_no = rows[0]["orderNo"]
            break
    if not order_id:
        raise HTTPException(status_code=404, detail="找不到工單")

    entry_rows = await prisma.query_raw(
        'SELECT COUNT(*)::int AS cnt FROM "StepEntry" WHERE "orderId" = $1', order_id
    )
    pause_rows = await prisma.query_raw(
        'SELECT COUNT(*)::int AS cnt FROM "PauseEvent" WHERE "orderId" = $1', order_id
    )
    entry_count = entry_rows[0]["cnt"] if entry_rows else 0
    pause_count = pause_rows[0]["cnt"] if pause_rows else 0

    await prisma.execute_raw('DELETE FROM "StepEntry" WHERE "orderId" = $1', order_id)
    await prisma.execute_raw('DELETE FROM "PauseEvent" WHERE "orderId" = $1', order_id)
    await prisma.execute_raw('DELETE FROM "Order" WHERE "id" = $1', order_id)

    await audit(request, "purge_order", target=found_no,
                detail=f"entries={entry_count} pauses={pause_count}")
    return {"ok": True, "purged": True, "orderNo": found_no,
            "entries": entry_count, "pauses": pause_count}


# ── upload-rows ───────────────────────────────

@router.get("/{order_no}/upload-rows")
async def get_upload_rows(order_no: str):
    order_no = order_no.strip().upper()
    if not valid_order_no(order_no):
        return {"rows": []}
    latest = await prisma.uploadrow.find_first(
        where={
            "orderNo": order_no,
            "status": {"in": ["created", "updated"]},
            "batch": {"is": {"cancelledAt": None}},
        },
        order={"batchId": "desc"},
    )
    if not latest:
        return {"rows": []}
    rows = await prisma.uploadrow.find_many(
        where={"orderNo": order_no, "batchId": latest.batchId},
        order={"id": "asc"},
    )
    return {"rows": rows}
