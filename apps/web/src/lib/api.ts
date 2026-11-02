const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787';

// 開発用モックヘッダー。CF Accessをモックして自動ユーザー登録させる。
export const MOCK_AUTH_HEADERS = {
  'X-Mock-User-Id': 'dev-user-123',
  'X-Mock-Email': 'dev-user@example.com',
};

export async function apiFetch(path: string, options: RequestInit = {}) {
  const url = `${API_BASE_URL}${path}`;
  const isFormData = options.body instanceof FormData;
  
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...MOCK_AUTH_HEADERS,
    ...(options.headers || {}),
  } as Record<string, string>;

  let res: Response | undefined;
  let lastNetworkErr: any = null;
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(url, {
        ...options,
        headers,
      });
      break;
    } catch (networkErr: any) {
      lastNetworkErr = networkErr;
      if (attempt < maxAttempts) {
        // .exe 起動直後のバックグラウンドAPIサーバー立ち上がり待機用リトライ
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  if (!res) {
    // ネットワーク層のエラー（サーバー未起動、CORS、DNS解決失敗等）
    const detail = lastNetworkErr?.message || String(lastNetworkErr);
    throw new Error(
      `APIサーバーへの接続に失敗しました。\n` +
      `原因: ${detail}\n` +
      `確認事項:\n` +
      `  • APIサーバー (${API_BASE_URL}) が起動しているか\n` +
      `  • ファイアウォールやプロキシがブロックしていないか\n` +
      `  • CORSの設定が正しいか`
    );
  }

  if (!res.ok) {
    const errText = await res.text();
    let errJson;
    try {
      errJson = JSON.parse(errText);
    } catch {}
    const status = res.status;
    const statusText = res.statusText || 'Error';
    const serverMsg = errJson?.error || errText || '';
    throw new Error(
      `API エラー (${status} ${statusText}): ${serverMsg}`
    );
  }

  return res.json();
}
