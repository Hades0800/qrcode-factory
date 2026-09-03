import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// CORS：限制白名單 origin
const ALLOWED_ORIGINS = [
  'https://hades0800.github.io',
  'https://qrcf-py.zeabur.app',   // Zeabur 前端服務（qrcode-factory-frontend）
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

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
      if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
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
