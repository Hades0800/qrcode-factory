"""equipment_params routes — 對應 backend/src/routes/equipmentParams.js.

一張工單對應一筆設備參數（upsert）。寫入前必須是「今日有活動」的工單（admin 例外）。
"""

from datetime import datetime, time, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth_deps import authenticate
from ..db import prisma
from ..helpers import clip_str, valid_order_no

router = APIRouter()


def _int_or_none(v):
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if not (n == n) or n in (float("inf"), float("-inf")):
        return None
    return max(0, min(1_000_000_000, round(n)))


def _float_or_none(v):
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if not (n == n) or n in (float("inf"), float("-inf")):
        return None
    return max(0.0, min(1e9, n))


async def _is_today_active(order_id: int) -> bool:
    """工單是否「今日（本地時間）有實際活動」。"""
    day_start = datetime.combine(datetime.now().date(), time.min)
    day_end = datetime.combine(datetime.now().date(), time.max)
    step_count = await prisma.stepentry.count(
        where={"orderId": order_id, "recordedAt": {"gte": day_start, "lt": day_end}}
    )
    if step_count > 0:
        return True
    pause_count = await prisma.pauseevent.count(
        where={"orderId": order_id, "startAt": {"gte": day_start, "lt": day_end}}
    )
    if pause_count > 0:
        return True
    order = await prisma.order.find_unique(where={"id": order_id})
    if order and order.step11At and day_start <= order.step11At < day_end:
        return True
    return False


@router.get("/{order_no}")
async def get_equipment_param(order_no: str, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="找不到工單")
    ep = await prisma.equipmentparam.find_first(
        where={"orderId": order.id, "deletedAt": None}
    )
    return {"equipmentParam": ep}


@router.post("/{order_no}")
async def upsert_equipment_param(order_no: str, request: Request, user: dict = Depends(authenticate)):
    order_no = order_no.upper()
    if not valid_order_no(order_no):
        raise HTTPException(status_code=400, detail="工單號格式錯誤")
    order = await prisma.order.find_unique(where={"orderNo": order_no})
    if not order:
        raise HTTPException(status_code=404, detail="工單不存在，無法上傳設備參數")

    if not user.get("isAdmin"):
        if not await _is_today_active(order.id):
            raise HTTPException(status_code=400, detail="此工單號今日無生產活動，無法上傳設備參數")

    body = await request.json()
    data = {
        "operation":        clip_str(body.get("operation"), 200),
        "totalWorkers":     _int_or_none(body.get("totalWorkers")),
        "paramFileName":    clip_str(body.get("paramFileName"), 200),
        "paramFileAttr":    clip_str(body.get("paramFileAttr"), 200),
        "productSpecAttr":  clip_str(body.get("productSpecAttr"), 200),
        "moldSpec":         clip_str(body.get("moldSpec"), 200),
        "machineSPM":       _float_or_none(body.get("machineSPM")),
        "bladeCount":       _int_or_none(body.get("bladeCount")),
        "feedSetting":      clip_str(body.get("feedSetting"), 200),
        "cutterStroke":     clip_str(body.get("cutterStroke"), 200),
        "strokeUpdateFreq": clip_str(body.get("strokeUpdateFreq"), 200),
        "baseParamFileName":    clip_str(body.get("baseParamFileName"), 200),
        "baseParamFileAttr":    clip_str(body.get("baseParamFileAttr"), 200),
        "baseMoldSpec":         clip_str(body.get("baseMoldSpec"), 200),
        "baseMachineSPM":       _float_or_none(body.get("baseMachineSPM")),
        "baseBladeCount":       _int_or_none(body.get("baseBladeCount")),
        "baseFeedSetting":      clip_str(body.get("baseFeedSetting"), 200),
        "baseCutterStroke":     clip_str(body.get("baseCutterStroke"), 200),
        "baseStrokeUpdateFreq": clip_str(body.get("baseStrokeUpdateFreq"), 200),
    }

    ep = await prisma.equipmentparam.upsert(
        where={"orderId": order.id},
        data={
            "create": {
                **data,
                "orderId": order.id,
                "orderNo": order_no,
                "createdBy": user.get("id"),
                "createdByName": user.get("displayName"),
            },
            "update": {
                **data,
                "deletedAt": None,
            },
        },
    )
    return {"ok": True, "equipmentParam": ep}
