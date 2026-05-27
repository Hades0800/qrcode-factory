"""FastAPI app — 對應 backend/src/server.js."""

import logging
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import bcrypt
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from .auth_deps import authenticate, require_admin
from .config import (ADMIN_NAME, ADMIN_PASSWORD, ADMIN_USERNAME, ALLOWED_MACHINES,
                     ALLOWED_ORIGINS, DATABASE_URL, JWT_SECRET, LOG_LEVEL, PORT)
from .db import connect_db, disconnect_db, prisma
from .routes.admin import router as admin_router
from .routes.auth import router as auth_router
from .routes.equipment_params import router as equipment_router
from .routes.orders import router as orders_router

logging.basicConfig(level=getattr(logging, LOG_LEVEL.upper(), logging.INFO))
logger = logging.getLogger("qcf")


# ── 啟動：prisma db push + ensureAdmin ───────────────────────────────

def run_db_push():
    if not DATABASE_URL:
        logger.warning("⚠️ DATABASE_URL 未設定，跳過 prisma db push")
        return
    try:
        logger.info("→ 執行 prisma db push...")
        subprocess.run(
            [sys.executable, "-m", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
            check=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        logger.info("✓ prisma db push 完成")
    except Exception as e:
        logger.warning(f"⚠️ prisma db push 失敗，但 server 仍會啟動：{e}")


async def ensure_admin():
    """有任何 admin 就跳過；否則用 ADMIN_USERNAME/PASSWORD env 建立。"""
    count = await prisma.leader.count(where={"isAdmin": True})
    if count > 0:
        return
    if not ADMIN_USERNAME or not ADMIN_PASSWORD:
        logger.warning("沒有任何管理員，且 ADMIN_USERNAME/ADMIN_PASSWORD 未設定，跳過建立")
        return
    # 含已軟刪除（逃生口：where 內出現 deletedAt 鍵即繞過 middleware）
    exists = await prisma.leader.find_first(
        where={"username": ADMIN_USERNAME, "deletedAt": None}
    ) or await prisma.leader.find_first(
        where={"username": ADMIN_USERNAME, "deletedAt": {"not": None}}
    )
    if exists:
        patch = {}
        if exists.deletedAt:
            patch["deletedAt"] = None
        if not exists.isAdmin:
            patch["isAdmin"] = True
        if patch:
            await prisma.leader.update(where={"id": exists.id}, data=patch)
            logger.info(f"已恢復/提升管理員：{ADMIN_USERNAME}")
        return
    password_hash = bcrypt.hashpw(ADMIN_PASSWORD.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    await prisma.leader.create(
        data={
            "username": ADMIN_USERNAME,
            "passwordHash": password_hash,
            "displayName": ADMIN_NAME,
            "isAdmin": True,
        }
    )
    logger.info(f"✓ 已建立第一位管理員: {ADMIN_USERNAME}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # schema 同步交給 Node backend 負責（兩邊共用同 DB）
    # 若需要 Python 端也推 schema，設 RUN_DB_PUSH=true
    if os.getenv("RUN_DB_PUSH", "").lower() == "true":
        run_db_push()
    await connect_db()
    try:
        await ensure_admin()
    except Exception as e:
        logger.warning(f"⚠️ ensureAdmin 失敗：{e}")
    yield
    await disconnect_db()


# ── App ───────────────────────────────

limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])
app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"ok": False, "error": "請求太頻繁，請稍候再試"},
    )


# 把 FastAPI 預設的 {"detail": "..."} 換成 Node backend 用的 {"error": "..."} 格式
# 如果 detail 已經是 dict（routes 有些故意傳 dict 多帶 code/hint 等），原樣回傳
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """對應 Fastify helmet 的最小安全 headers。"""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response


def _origin_check(origin: str) -> bool:
    if not origin:
        return True
    return any(origin.startswith(o) for o in ALLOWED_ORIGINS)


# CORS — 用自訂 origin_regex 比對 startswith
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(SlowAPIMiddleware)


# ── 路由 ───────────────────────────────

app.include_router(auth_router, prefix="/api/auth")
app.include_router(orders_router, prefix="/api/orders")
app.include_router(admin_router, prefix="/api/admin")
app.include_router(equipment_router, prefix="/api/equipment-params")


@app.get("/")
async def root():
    return {"ok": True, "msg": "工單記錄系統 API 運作中"}


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/diag", dependencies=[Depends(require_admin)])
async def diag():
    env = {
        "DATABASE_URL": ("已設定 (" + DATABASE_URL[:25] + "...)") if DATABASE_URL else "❌ 未設定",
        "JWT_SECRET": "已設定" if JWT_SECRET and JWT_SECRET != "dev-secret-change-me" else "❌ 未設定",
        "ADMIN_USERNAME": ADMIN_USERNAME or "❌ 未設定",
        "ADMIN_PASSWORD": "已設定" if ADMIN_PASSWORD else "❌ 未設定",
        "ADMIN_NAME": ADMIN_NAME or "❌ 未設定",
    }
    db_status = "unknown"
    db_error = None
    try:
        await prisma.query_raw("SELECT 1")
        db_status = "✓ 連線成功"
    except Exception as e:
        db_status = "❌ 連線失敗"
        db_error = str(e)
    leader_count = None
    try:
        leader_count = await prisma.leader.count()
    except Exception as e:
        leader_count = f"error: {e}"
    return {"env": env, "dbStatus": db_status, "dbError": db_error, "leaderCount": leader_count}


# ── /api/fix-dates ───────────────────────────────

@app.post("/api/fix-dates", dependencies=[Depends(require_admin)])
async def fix_dates():
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


# ── /api/idle-events ───────────────────────────────

@app.post("/api/idle-events", dependencies=[Depends(authenticate)])
@limiter.limit("10/minute")
async def create_idle_event(request: Request):
    body = await request.json()
    machine_no = body.get("machineNo")
    note = body.get("note")
    if not machine_no:
        raise HTTPException(status_code=400, detail="缺少機台號")
    if machine_no not in ALLOWED_MACHINES:
        raise HTTPException(status_code=400, detail="不允許的機台號")
    user = request.state.user
    event = await prisma.idleevent.create(
        data={
            "machineNo": machine_no,
            "leaderId": user.get("id"),
            "leaderName": user.get("displayName"),
            "note": str(note)[:500] if note else None,
        }
    )
    return {"ok": True, "event": event}


@app.get("/api/idle-events", dependencies=[Depends(authenticate)])
async def list_idle_events(request: Request):
    limit = min(int(request.query_params.get("limit") or 100), 500)
    events = await prisma.idleevent.find_many(order={"createdAt": "desc"}, take=limit)
    return {"events": events}


@app.delete("/api/idle-events/{event_id}", dependencies=[Depends(authenticate)])
async def delete_idle_event(event_id: int, request: Request):
    if not event_id:
        raise HTTPException(status_code=400, detail="無效 id")
    event = await prisma.idleevent.find_unique(where={"id": event_id})
    if not event:
        raise HTTPException(status_code=404, detail="找不到紀錄")
    user = request.state.user
    if not user.get("isAdmin") and event.leaderId != user.get("id"):
        raise HTTPException(status_code=403, detail="只能取消自己建立的紀錄")
    await prisma.idleevent.delete(where={"id": event_id})
    return {"ok": True}


# ── 直接執行：uvicorn entry ───────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, log_level=LOG_LEVEL)
