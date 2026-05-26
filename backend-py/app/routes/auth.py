"""auth routes — 對應 backend/src/routes/auth.js."""

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth_deps import authenticate, create_token
from ..db import prisma

router = APIRouter()

# 防止帳號列舉用的假 hash（與 backend/src/routes/auth.js 同）
_FAKE_HASH = b"$2a$10$CwTycUXWue0Thq9StjUM0uJ8VjWZSp9YJ0.dFaVBRYHx3N4L5UoEe"


def _check_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


@router.post("/login")
async def login(request: Request):
    """登入：每 IP 每 15 分鐘最多 10 次（rate limit 由 main.py 套用）。"""
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    username = body.get("username")
    password = body.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="請輸入帳號密碼")
    if not isinstance(username, str) or not isinstance(password, str) \
            or len(username) > 60 or len(password) > 200:
        raise HTTPException(status_code=400, detail="輸入格式錯誤")

    leader = await prisma.leader.find_unique(where={"username": username})
    hash_to_check = leader.passwordHash if leader else _FAKE_HASH.decode()
    ok = _check_password(password, hash_to_check)
    if not leader or not ok:
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")

    token = create_token({
        "id": leader.id,
        "username": leader.username,
        "displayName": leader.displayName,
        "isAdmin": leader.isAdmin,
        "isPlanner": leader.isPlanner,
    })
    return {
        "token": token,
        "leader": {
            "id": leader.id,
            "username": leader.username,
            "displayName": leader.displayName,
            "isAdmin": leader.isAdmin,
            "isPlanner": leader.isPlanner,
        },
    }


@router.get("/me")
async def me(user: dict = Depends(authenticate)):
    return {"leader": user}


@router.post("/change-password")
async def change_password(request: Request, user: dict = Depends(authenticate)):
    body = await request.json()
    old_password = body.get("oldPassword")
    new_password = body.get("newPassword")
    if not old_password or not new_password:
        raise HTTPException(status_code=400, detail="請填寫舊密碼與新密碼")
    if not isinstance(new_password, str) or len(new_password) < 6 or len(new_password) > 200:
        raise HTTPException(status_code=400, detail="新密碼長度需 6~200 字")

    leader = await prisma.leader.find_unique(where={"id": user["id"]})
    if not leader:
        raise HTTPException(status_code=404, detail="帳號不存在")
    if not _check_password(old_password, leader.passwordHash):
        raise HTTPException(status_code=401, detail="舊密碼錯誤")

    new_hash = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    await prisma.leader.update(where={"id": leader.id}, data={"passwordHash": new_hash})
    return {"ok": True}
