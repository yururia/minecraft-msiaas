import { Context, Next } from 'hono';

export async function authMiddleware(c: Context, next: Next) {
  // CORSプリフライト（OPTIONSリクエスト）は認証をスキップする
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  // 起動中サーバーの全MOD取得エンドポイント、およびセッション同期エンドポイントは認証をスキップする（Rustクライアント用）
  const url = new URL(c.req.url);
  if (url.pathname === '/api/servers/active/mods' || url.pathname === '/api/servers/session') {
    await next();
    return;
  }

  // CF Access JWTは Cf-Access-Jwt-Assertion ヘッダーにセットされる
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  
  // 開発用モック: JWTがない場合でも、特定のヘッダーがあればテスト用に通す
  const mockUserId = c.req.header('X-Mock-User-Id');
  const mockEmail = c.req.header('X-Mock-Email');

  let externalId = '';
  let email = '';

  if (jwt) {
    try {
      // TODO: jose等のライブラリを使用してCloudflare Zero TrustのJWKSエンドポイントから
      // パブリックキーを取得し、JWTの署名を厳密に検証するロジックを実装します。
      // const CERTS_URL = 'https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs';
      // const JWKS = createRemoteJWKSet(new URL(CERTS_URL));
      // const { payload } = await jwtVerify(jwt, JWKS, { issuer: '...', audience: '...' });
      
      // 仮実装: （実際には検証にパスしたペイロードを使用する）
      const payloadBase64 = jwt.split('.')[1];
      const payloadStr = atob(payloadBase64);
      const payload = JSON.parse(payloadStr);
      externalId = payload.sub;
      email = payload.email || 'unknown@example.com';
    } catch (e) {
      return c.json({ error: 'Invalid or expired JWT' }, 401);
    }
  } else if (mockUserId) {
    // 開発時のフォールバック
    externalId = mockUserId;
    email = mockEmail || 'mock@example.com';
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const db = c.env.DB as D1Database;

  // DBにユーザーが存在するか確認
  let user = await db
    .prepare('SELECT * FROM users WHERE external_id = ?')
    .bind(externalId)
    .first();

  // 存在しなければ自動登録
  if (!user) {
    const insertResult = await db
      .prepare('INSERT INTO users (external_id, email, plan) VALUES (?, ?, ?) RETURNING *')
      .bind(externalId, email, 'free')
      .first();
    user = insertResult;
  }

  // リクエストコンテキストにユーザー情報をセット
  c.set('user', user);

  await next();
}
