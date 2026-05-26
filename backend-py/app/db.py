"""Prisma client + 軟刪除行為。

prisma-client-py 0.15 沒有等價於 Node Prisma 的 $use middleware（已移除）。
這裡用「proxy 包住每個軟刪除 model 的 actions」實作相同效果。

規則：
  - find_unique/find_first/find_many/count/aggregate/group_by 預設加上 deletedAt: None
  - delete / delete_many 改寫為 update / update_many，設定 deletedAt = now
  - caller 在 where 內明確指定 deletedAt（含 None / {"not": None}）即可跳過
  - nested include 不會被 proxy 攔截，仍需在 include 內手動加 where={"deletedAt": None}
"""

from datetime import datetime, timezone

from prisma import Prisma

from .config import SOFT_DELETE_MODELS


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class _SoftDeleteProxy:
    """包住單一 model 的 actions（如 prisma.order）以自動套用軟刪除規則。"""

    def __init__(self, actions):
        object.__setattr__(self, "_actions", actions)

    async def find_unique(self, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            # find_unique 只能 by unique key；加 deletedAt 後改走 find_first
            where["deletedAt"] = None
            return await self._actions.find_first(where=where, **kwargs)
        return await self._actions.find_unique(where=where, **kwargs)

    async def find_first(self, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            where["deletedAt"] = None
        return await self._actions.find_first(where=where, **kwargs)

    async def find_many(self, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            where["deletedAt"] = None
        return await self._actions.find_many(where=where, **kwargs)

    async def count(self, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            where["deletedAt"] = None
        return await self._actions.count(where=where, **kwargs)

    async def aggregate(self, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            where["deletedAt"] = None
        return await self._actions.aggregate(where=where, **kwargs)

    async def group_by(self, by, where=None, **kwargs):
        where = dict(where or {})
        if "deletedAt" not in where:
            where["deletedAt"] = None
        return await self._actions.group_by(by=by, where=where, **kwargs)

    async def delete(self, where, **kwargs):
        return await self._actions.update(where=where, data={"deletedAt": _utcnow()})

    async def delete_many(self, where=None, **kwargs):
        return await self._actions.update_many(
            where=where or {}, data={"deletedAt": _utcnow()}
        )

    def __getattr__(self, name):
        # 其他方法（create / update / upsert / create_many / update_many）透傳
        return getattr(self._actions, name)


prisma = Prisma(auto_register=True)


def _install_soft_delete():
    """把指定 model 的 actions attribute 換成 proxy 版本。"""
    # SOFT_DELETE_MODELS 用的是 PascalCase；Prisma Python 的 accessor 是 lowercase 全小寫
    name_map = {
        "Order": "order",
        "Leader": "leader",
        "IdleEvent": "idleevent",
        "StepEntry": "stepentry",
        "PauseEvent": "pauseevent",
    }
    for model_name, attr in name_map.items():
        if model_name not in SOFT_DELETE_MODELS:
            continue
        original = getattr(prisma, attr, None)
        if original is None:
            continue
        setattr(prisma, attr, _SoftDeleteProxy(original))


_install_soft_delete()


async def connect_db():
    if not prisma.is_connected():
        await prisma.connect()


async def disconnect_db():
    if prisma.is_connected():
        await prisma.disconnect()
