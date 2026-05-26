"""JWT 認證依賴：對應 Fastify 的 authenticate / requireAdmin decorator。"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError, jwt

from .config import JWT_ALGORITHM, JWT_EXPIRES_DAYS, JWT_SECRET


def create_token(payload: dict) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRES_DAYS)
    to_encode = {**payload, "exp": exp}
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _extract_token(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth:
        return None
    parts = auth.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


async def authenticate(request: Request) -> dict:
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="請先登入")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="請先登入")
    request.state.user = payload
    return payload


async def require_admin(user: dict = Depends(authenticate)) -> dict:
    if not user.get("isAdmin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理員權限")
    return user


async def require_planner_or_admin(user: dict = Depends(authenticate)) -> dict:
    if not (user.get("isAdmin") or user.get("isPlanner")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要排程權限")
    return user
