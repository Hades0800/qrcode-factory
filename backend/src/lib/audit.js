// 稽核紀錄：寫入 auditLog，失敗不影響主流程
export async function audit(prisma, request, action, target, detail) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: request.user?.id || null,
        actorName: request.user?.displayName || null,
        action,
        target: target ? String(target).slice(0, 200) : null,
        detail: detail ? String(detail).slice(0, 500) : null,
        ip: request.ip || null,
      },
    });
  } catch (e) { /* ignore audit errors */ }
}
