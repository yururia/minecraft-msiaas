import { Context, Next } from 'hono';

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export async function verifyJwtAssertion(
  jwt: string,
  expectedAud?: string,
  expectedIssuer?: string
): Promise<{ sub: string; email: string }> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[2]) {
    throw new Error('Malformed JWT token');
  }

  const header = JSON.parse(base64UrlDecode(parts[0]));
  if (!header.alg || header.alg === 'none') {
    throw new Error('Unsupported or insecure JWT algorithm');
  }

  const payload = JSON.parse(base64UrlDecode(parts[1]));
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Missing JWT subject (sub)');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSec) {
    throw new Error('JWT token has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) {
    throw new Error('JWT token is not yet valid');
  }

  if (expectedAud) {
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(expectedAud)) {
      throw new Error('Invalid JWT audience (aud)');
    }
  }

  if (expectedIssuer && payload.iss && payload.iss !== expectedIssuer) {
    throw new Error('Invalid JWT issuer (iss)');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : 'unknown@example.com',
  };
}

export async function authMiddleware(c: Context, next: Next) {
  // CORSプリフライト（OPTIONSリクエスト）は認証をスキップする
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const url = new URL(c.req.url);
  if (url.pathname === '/api/health' || url.pathname === '/') {
    await next();
    return;
  }

  const isDev = c.env?.ENVIRONMENT === 'dev';

  // Internal/Sync endpoints require either valid Internal API Token or normal authentication
  if (url.pathname === '/api/servers/active/mods' || url.pathname === '/api/servers/session') {
    const internalToken = c.req.header('X-Internal-Token');
    const expectedToken = c.env?.INTERNAL_API_TOKEN;
    if (isDev || (expectedToken && internalToken === expectedToken)) {
      await next();
      return;
    }
    // If not carrying internal token in production, fall through to require normal user auth
  }

  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  const mockUserId = c.req.header('X-Mock-User-Id');
  const mockEmail = c.req.header('X-Mock-Email');

  let externalId = '';
  let email = '';

  if (jwt) {
    try {
      const claims = await verifyJwtAssertion(
        jwt,
        c.env?.CF_ACCESS_AUD,
        c.env?.CF_ACCESS_TEAM_DOMAIN
      );
      externalId = claims.sub;
      email = claims.email;
    } catch (e: any) {
      return c.json({ error: `Invalid or expired JWT: ${e.message}` }, 401);
    }
  } else if (mockUserId) {
    // SECURITY FIX: Restrict X-Mock-User-Id strictly to ENVIRONMENT === 'dev'
    if (!isDev) {
      return c.json({ error: 'Mock authentication is disabled in production.' }, 403);
    }
    externalId = mockUserId;
    email = mockEmail || 'mock@example.com';
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const db = c.env.DB as D1Database;

  let user = await db
    .prepare('SELECT * FROM users WHERE external_id = ?')
    .bind(externalId)
    .first();

  if (!user) {
    const insertResult = await db
      .prepare('INSERT INTO users (external_id, email, plan) VALUES (?, ?, ?) RETURNING *')
      .bind(externalId, email, 'free')
      .first();
    user = insertResult;
  }

  c.set('user', user);
  await next();
}
