import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// CORS：限制白名單 origin（整串完全相符才放行）
// 公司網域：網域本身與其下所有子網域（限 https）
const COMPANY_DOMAIN = 'sksteel-mes-sys.com';
const ALLOWED_ORIGINS = [
  'https://hades0800.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
// 本地開發用：EXTRA_ORIGIN=http://192.168.x.x:5500 可放行區網來源（例如用手機連 Mac 測試）
// 正式環境不設此變數即無作用
if (process.env.EXTRA_ORIGIN) {
  ALLOWED_ORIGINS.push(...process.env.EXTRA_ORIGIN.split(',').map(s => s.trim()).filter(Boolean));
}

// 註冊安全／效能相關外掛：壓縮、安全 headers、CORS、速率限制
export async function registerSecurity(fastify) {
  // 壓縮回應（gzip/brotli，大 JSON 回應可省 60~80% 流量）
  await fastify.register(compress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'],
    threshold: 1024,
  });

  // 安全 headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // 前端獨立部署，不由後端設 CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 允許 curl/Postman 測試
      // 不可用 startsWith：'https://hades0800.github.io.attacker.com' 也會符合
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      try {
        const u = new URL(origin);
        if (u.protocol === 'https:' && (u.hostname === COMPANY_DOMAIN || u.hostname.endsWith('.' + COMPANY_DOMAIN))) {
          return cb(null, true);
        }
      } catch (e) { /* origin 格式不正確 → 拒絕 */ }
      cb(new Error('不允許的來源'), false);
    },
    credentials: true,
  });

  // 全域速率限制：每 IP 每分鐘 120 次
  await fastify.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({
      ok: false,
      error: `請求太頻繁，請稍候 ${Math.ceil(ctx.ttl / 1000)} 秒再試`,
    }),
  });
}
