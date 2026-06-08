// v2 Auth — 對應 v1 backend/src/routes/auth.js
// 差別：
//   1. 資料來源從 Leader → Account
//   2. 加上 Account.enable 檢查（停用帳號不能登入）
//   3. 因為 Account 不在 soft-delete middleware 名單中，需手動過濾 deletedAt: null
//   4. 回應 key 從 leader → account（v2 全面更名）
//   5. 統一加 ok: true/false（給 v2 前端方便判斷）
//
// ⚠️ 注意：Account 目前是空表（之前作為平行測試表加入）。要登入需先有帳號 —
//    可由 admin 在後台新增 Account（v2 的 admin endpoint 之後實作），
//    或用既有的 ensureAdmin 流程做一個 Account 版本（看你要不要）。

import bcrypt from 'bcryptjs';

// 防帳號列舉用的假 hash（無論帳號存在與否都跑 bcrypt，避免響應時間差被觀察）
const FAKE_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VjWZSp9YJ0.dFaVBRYHx3N4L5UoEe';

export default async function v2AuthRoutes(fastify) {
  // ── 登入 ────────────────────────────────────
  // POST /v2/login → { token, account: {..., permissions: [...]} }
  fastify.post('/login', {
    // 每 IP 每 15 分鐘最多 10 次（防暴力破解）
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({
          ok: false,
          error: '登入嘗試過多，請 15 分鐘後再試',
        }),
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ ok: false, error: '請輸入帳號密碼' });
    }
    if (typeof username !== 'string' || typeof password !== 'string'
        || username.length > 60 || password.length > 200) {
      return reply.code(400).send({ ok: false, error: '輸入格式錯誤' });
    }

    // Account 不在 SOFT_DELETE_MODELS → 手動加 deletedAt: null
    const account = await fastify.prisma.account.findFirst({
      where: { username, deletedAt: null },
    });

    // 不區分帳號存在與否，避免帳號列舉攻擊
    const hash = account ? account.passwordHash : FAKE_HASH;
    const passOk = await bcrypt.compare(password, hash);
    if (!account || !passOk) {
      return reply.code(401).send({ ok: false, error: '帳號或密碼錯誤' });
    }

    // 停用帳號不能登入（Account 比 Leader 多的安全機制）
    if (account.enable === false) {
      return reply.code(403).send({ ok: false, error: '此帳號已停用' });
    }

    const token = fastify.jwt.sign(
      {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        roles: account.roles || 'qc',
      },
      { expiresIn: '7d' },
    );

    return {
      ok: true,
      token,
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        roles: account.roles || 'qc',
        permissions: fastify.resolvePermissions(account.roles || 'qc'),
      },
    };
  });

  // ── 取目前登入者 ─────────────────────────────
  // GET /v2/me → { account: {...} }
  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    return {
      ok: true,
      account: {
        ...request.user,
        permissions: fastify.resolvePermissions(request.user.roles),
      },
    };
  });

  // ── 改自己的密碼 ─────────────────────────────
  // POST /v2/change-password { oldPassword, newPassword }
  fastify.post('/change-password', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { oldPassword, newPassword } = request.body || {};
    if (!oldPassword || !newPassword) {
      return reply.code(400).send({ ok: false, error: '請填寫舊密碼與新密碼' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
      return reply.code(400).send({ ok: false, error: '新密碼長度需 6~200 字' });
    }
    const account = await fastify.prisma.account.findFirst({
      where: { id: request.user.id, deletedAt: null },
    });
    if (!account) return reply.code(404).send({ ok: false, error: '帳號不存在' });
    if (account.enable === false) {
      return reply.code(403).send({ ok: false, error: '此帳號已停用' });
    }
    const ok = await bcrypt.compare(oldPassword, account.passwordHash);
    if (!ok) return reply.code(401).send({ ok: false, error: '舊密碼錯誤' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await fastify.prisma.account.update({
      where: { id: account.id },
      data: { passwordHash },
    });
    return { ok: true };
  });

  // ── 登出 ────────────────────────────────────
  // POST /v2/logout — 目前無狀態（前端清 token 即可），保留 endpoint 給未來 token 黑名單
  fastify.post('/logout', { onRequest: [fastify.authenticate] }, async () => {
    return { ok: true };
  });
}
