# 起動・運用・テストマニュアル（Startup & Operations Manual）

## 1. 動作環境・前提ツール

本プロジェクトをローカル環境で起動・ビルドするための推奨環境は以下の通りです。

| ソフトウェア | 推奨バージョン | 用途 |
| :--- | :--- | :--- |
| **OS** | Windows 10 / 11 (64-bit) | Tauri デスクトップアプリおよびローカル Minecraft サーバー実行 |
| **Node.js** | v20.x 以上（v22+ で `node:sqlite` サンドボックス対応） | フロントエンド（Next.js）・API（Wrangler / Hono）実行 |
| **pnpm** | v8.15.4 以上 | モノレポパッケージ管理 |
| **Rust / Cargo** | stable (1.75 以上) | Tauri デスクトップコア（`apps/client/src-tauri`）のビルド・実行 |
| **Java (JDK/JRE)** | **Java 21**（MC 1.20.5+）または **Java 17**（MC 1.18〜1.20.4） | ローカル Minecraft サーバープロセスの起動（Adoptium Temurin 推奨） |

---

## 2. 初回セットアップ手順

### Step 1: 依存パッケージのインストール

リポジトリルート（`c:\Users\yasud\minecraft-msiaas`）で以下を実行します。

```powershell
pnpm install
```

### Step 2: 環境変数（`.dev.vars`）の確認

CurseForge の MOD 検索・インポートを利用する場合は、`apps/api/.dev.vars` に API キーが設定されていることを確認します（Modrinth のみ利用する場合は空でも動作します）。

```ini
# apps/api/.dev.vars
CURSEFORGE_API_KEY="$2a$10$..."
```

### Step 3: 共通パッケージの初回ビルドとローカル D1 マイグレーション

ローカルの Cloudflare D1（SQLite）データベースに初期スキーマおよびマイグレーション（`0000`〜`0003`）を適用します。必ずプロジェクトルート（`C:\Users\yasud\minecraft-msiaas`）で実行してください。

**PowerShell の場合:**
```powershell
# 共通パッケージのビルド
pnpm --filter @msiaas/shared build
pnpm --filter @msiaas/cloud-provider build
pnpm --filter @msiaas/mod-db-tools build

# ローカル D1 データベースへのマイグレーション適用
$env:CI="true"; pnpm --filter @msiaas/api db:migrate
```

**コマンドプロンプト (cmd.exe) の場合:**
```cmd
# 共通パッケージのビルド
pnpm --filter @msiaas/shared build
pnpm --filter @msiaas/cloud-provider build
pnpm --filter @msiaas/mod-db-tools build

# ローカル D1 データベースへのマイグレーション適用
set CI=true&& pnpm --filter @msiaas/api db:migrate
```

---

## 3. アプリケーションの起動手順

> ⚠️ **重要（実行ディレクトリについて）**:
> コマンドは必ず **プロジェクトのルートディレクトリ (`C:\Users\yasud\minecraft-msiaas`)** で実行してください。`apps\` などのサブフォルダで実行すると `package.json` が見つからずエラーになります。

### 3.1 全サービス一括起動（推奨）

ルートの `package.json` に定義された `dev` スクリプトは Turborepo（`turbo run dev --filter=!@msiaas/sandbox`）を実行するため、**バックエンド API（Hono / D1 DB）も含めてすべてのサービスが一括で起動します。**

お使いのシェル（PowerShell または コマンドプロンプト）に合わせて以下のいずれかを実行してください。

**PowerShell をご利用の場合:**
```powershell
cd C:\Users\yasud\minecraft-msiaas
$env:CI="true"; pnpm dev
```

**コマンドプロンプト (cmd.exe) をご利用の場合:**
```cmd
cd C:\Users\yasud\minecraft-msiaas
set CI=true&& pnpm dev
```
*(※通常のローカル起動であれば、単に `pnpm dev` だけでも動作します)*

#### 起動されるサービスとポート一覧

上記の一括起動コマンドで、以下のすべてのサービスがバックグラウンド並行で自動起動します：

| サービス名 | パッケージ | ローカル URL / ポート | 役割・動作確認方法 |
| :--- | :--- | :--- | :--- |
| **バックエンド API** | `@msiaas/api` | `http://127.0.0.1:8787` | **Hono REST API + ローカル D1 (SQLite)**<br>ブラウザで `http://127.0.0.1:8787/api/health` を開くと動作確認可能 |
| **Web フロントエンド** | `@msiaas/web` | `http://localhost:3000` | **Next.js 14 ダッシュボード UI**<br>ブラウザで `http://localhost:3000` を開くと直接操作可能 |
| **Tauri デスクトップアプリ** | `@msiaas/client` | デスクトップウィンドウ | **ローカル Java サーバー起動・Playit.gg トンネル・MOD同期**<br>専用のネイティブGUIウィンドウが自動表示 |
| **Provisioner Worker** | `@msiaas/provisioner` | `http://127.0.0.1:8788` | Cloudflare Queues コンシューマー（クラウドプロビジョニング用） |

---

### 3.2 個別起動したい場合（バックエンド単体起動など）

「バックエンド API のみ起動してデバッグしたい」「Web UI のみ起動したい」という場合は、プロジェクトルートから以下のコマンドを個別実行します。

#### ① バックエンド API サーバーのみ起動 (ポート 8787)
```powershell
# PowerShell
cd C:\Users\yasud\minecraft-msiaas
pnpm --filter @msiaas/api dev
```
```cmd
:: コマンドプロンプト (cmd.exe)
cd C:\Users\yasud\minecraft-msiaas
pnpm --filter @msiaas/api dev
```
> **バックエンド起動時の確認**: 起動後、別ターミナルまたはブラウザで `http://127.0.0.1:8787/api/presets` や `http://127.0.0.1:8787/api/health` にアクセスして JSON が返れば起動成功です。

#### ② Web UI のみ起動 (ポート 3000)
```powershell
cd C:\Users\yasud\minecraft-msiaas
pnpm --filter @msiaas/web dev
```

#### ③ Tauri デスクトップアプリ（開発モード）のみ起動
```powershell
cd C:\Users\yasud\minecraft-msiaas
pnpm --filter @msiaas/client dev
```

#### ④ ビルド済みデスクトップアプリ本体（`.exe`）の直接起動
```cmd
cd C:\Users\yasud\minecraft-msiaas\apps\client\src-tauri\target\release
start "" "Minecraft MSIaaS.exe"
```
> **🌟 バックエンド自動連動機能**:
> ビルド済みの `Minecraft MSIaaS.exe` を直接起動した場合、ポート `8787`（バックエンド API）が未起動であれば、アプリの起動処理（`ensure_local_api_server_running`）が**バックグラウンドで自動的に `apps/api`（Wrangler APIサーバー）を立ち上げます**。そのため、事前にターミナルでバックエンドを起動していなくても、`.exe` をダブルクリックするだけでアプリとバックエンドの両方が連動して機能します。また、アプリ終了時には自動でバックエンドプロセスも安全に終了します。

---

## 4. 主要機能の操作ガイド

### 4.1 Modpack ZIP インポートと MOD Side 仕分け確認

1. ダッシュボードの **「プリセット管理 (`/dashboard/presets`)」** を開きます。
2. 画面上部のドロップゾーンに、CurseForge / Modrinth の Modpack ZIP、または `mods/*.jar` を含むクライアント用 ZIP ファイルをドラッグ＆ドロップします。
3. **`mods/*.jar` が含まれている場合**:
   - 自動的に各 `.jar` 内のメタデータ（`META-INF/mods.toml`, `fabric.mod.json`, `quilt.mod.json`）がスキャンされ、**「MOD Side 自動判定・仕分け確認モーダル」** が表示されます。
   - **✅ サーバーに追加されるMOD (`server`)**、**🚫 クライアント専用として除外されるMOD (`client_only`・除外理由つき)**、**❓ 判定不明のMOD (`unknown`)** の3一覧を確認します。
   - `unknown` に分類された MOD は安全のためデフォルトで **「除外 (`Client`)」** になっています。サーバーにも入れたい MOD がある場合は、トグルボタンで `Server` または `Both` に切り替えます。
   - **「この仕分け内容でインポート確定」** を押すとプリセットが保存されます。

### 4.2 サーバー起動テストと詳細クラッシュ診断

1. プリセット一覧から **「🚀 この構成で起動」** をクリックし、**「サーバー管理 (`/dashboard/servers`)」** へ移動します。
2. 割り当てメモリ（GB）を確認し、**「サーバーを起動する」** をクリックします。
3. **「サーバー起動前 MOD Side 最終確認モーダル」** が表示されます。
   - **🧪 サンドボックス互換診断**: サーバーの `mods/` に配置される MOD、除外されるクライアント専用 MOD（`oculus`, `embeddium` など）、およびサーバー・クライアント双方で必要な前提 MOD の過不足を自動判定します。
   - **⚠️ ZIP不足前提MODの確認通知**: ZIP 内に含まれていない前提 MOD がある場合、「このMODが足りないため構成に入れてもかまいませんか？」という明確な注意文が表示され、ワンクリックで構成に追加・補完できます。
   - **Forge Dedicated Server 対応**: Forge 構成（1.20.1 等）の場合、従来のバニラサーバーフォールバックではなく、真の Forge Dedicated Server（`@forge_server_args.txt --nogui`）が自動展開・起動され、`config/` や `defaultconfigs/` も同期されます。
4. **「確認してサーバーを起動」** を押すと、バックグラウンドでサーバープロセスが起動します。
5. **起動に失敗（クラッシュ）した場合**:
   - 画面上部のエラーバナーに **「【サーバー起動失敗・クラッシュ詳細解析】」** が自動表示されます。
   - 「どの前提 MOD が不足しているか」「どの MOD のバージョンが合っていないか」「クライアント専用 MOD が混入していないか」「Java バージョン（Java 17 / 21）が合っているか」が日本語で表示されるため、案内に従ってプリセットや環境設定を調整してください。

### 4.3 ゲスト配布用 MOD 一括 ZIP の作成

- サーバー稼働中に「サーバー管理 (`/dashboard/servers`)」画面の **「📦 ゲスト配布用MOD一括ZIPを作成」** を押すと、参加メンバー（クライアント側）に必要な全 MOD（軽量化 MOD・クライアント専用 MOD 含む）をまとめた `.zip` パッケージをデスクトップ等へ出力できます。

### 4.4 大量MOD（200個以上）読み込みフリーズ防止と高速化仕様

MOD数が200個を超える大型Modpackでもアプリが「応答なし」にならず快適に操作できるよう、以下の高速化・非同期化機構が組み込まれています。

- **Tauri バックグラウンドスレッド実行**: 全スキャン処理が `spawn_blocking` で非同期実行されるため、解析中もウィンドウが一切フリーズしません。
- **並列マルチスレッド解析**: CPU コア数に応じて JAR ファイルをチャンク分割し、並行展開・解析します。
- **ファイルメタデータキャッシュ (`JAR_META_CACHE`)**: サイズと更新日時が変わらない JAR の再解凍をスキップします。
- **分割描画（Chunked List）**: 画面上の MOD リストを 40 件ずつ段階的に描画し、ブラウザの DOM 処理落ちを防ぎます。
- **リアルタイムログのバッチ集約**: サーバー起動時の大量ログを 80 行または 250ms ごとにまとめて IPC 送信し、表示行数を 400 行に制限してメモリと描画負荷を保護します。

---

## 5. テスト・検証コマンド一覧

コード変更後の品質検証には以下のコマンドを使用します。

| 検証内容 | コマンド | 期待される結果 |
| :--- | :--- | :--- |
| **1. アーキテクチャ依存関係チェック** | `pnpm lint:deps` | `✔ no dependency violations found`（違反 0 件） |
| **2. E2E サンドボックス統合テスト** | `pnpm --filter @msiaas/sandbox simulate` | シナリオ A〜I（プロビジョニング、自動終了FSM、前提解決、ZIPインポート、`mods/*.jar` Side 仕分け、設定保存、起動レートリミット）がすべて `[SUCCESS]` |
| **3. Tauri Rust 単体テスト** | `cargo test --manifest-path apps/client/src-tauri/Cargo.toml` | `test result: ok. 6 passed; 0 failed`（MOD 仕分け・`.jar` 正規化・クラッシュ診断・事前キー照合テスト合格） |
| **4. 共通パッケージ・Web 本番ビルド** | `pnpm --filter @msiaas/shared build; pnpm --filter @msiaas/api build; pnpm --filter @msiaas/web build` | 型エラー 0 件・Next.js 全 9 ルートビルド成功 |
| **5. Windows デスクトップ `.exe` ビルド** | `pnpm --filter @msiaas/client build` | `Minecraft MSIaaS.exe`（単体実行用）および NSIS/MSI インストーラー生成 |

### 5.1 生成される Windows 実行ファイル（`.exe` / `.msi`）の出力先

- **ポータブル単体実行ファイル (`.exe`)**:
  `apps/client/src-tauri/target/release/Minecraft MSIaaS.exe`
- **NSIS セットアップインストーラー (`.exe`)**:
  `apps/client/src-tauri/target/release/bundle/nsis/Minecraft MSIaaS_0.1.0_x64-setup.exe`
- **MSI インストーラー (`.msi`)**:
  `apps/client/src-tauri/target/release/bundle/msi/Minecraft MSIaaS_0.1.0_x64_en-US.msi`

> **補足（APIサーバー自動連動）**: `Minecraft MSIaaS.exe` をダブルクリックで起動すると、ポート `8787` が未起動の場合はバックグラウンド（非表示ウィンドウ）でローカル API サーバー（`wrangler dev`）を自動起動し、アプリ終了時に自動でプロセスツリーごと停止します。コマンドプロンプトを開かずに `.exe` 単体でそのままご利用いただけます。

---

## 6. トラブルシューティング

### Q1. `ファイル名、ディレクトリ名、またはボリューム ラベルの構文が間違っています。` と表示されて起動できない
- **原因 1 (シェル構文の不一致)**: コマンドプロンプト (cmd.exe) で PowerShell 専用の構文 `$env:CI="true";` を実行しています。
  - **対策**: PowerShell を開いて実行するか、cmd.exe の場合は `set CI=true&& pnpm dev` を使用してください。
- **原因 2 (実行ディレクトリの誤り)**: `C:\Users\yasud\minecraft-msiaas\apps` などのサブディレクトリでコマンドを実行しています。
  - **対策**: `cd C:\Users\yasud\minecraft-msiaas` でプロジェクトルートに移動してから実行してください。

### Q2. バックエンド API サーバーは `pnpm dev` で起動しますか？
- **回答**: **はい、自動的に一緒に起動します。**
  - ルートの `pnpm dev` は Turborepo 経由で `@msiaas/api`（ポート 8787）、`@msiaas/web`（ポート 3000）、`@msiaas/provisioner`（ポート 8788）を一括起動します。
  - また、ビルド済みの `Minecraft MSIaaS.exe` を直接起動した場合も、Rust 側の自動連動機構によりポート 8787 のバックエンドが自動起動します。
  - バックエンド単体のみを起動したい場合は、ルートで `pnpm --filter @msiaas/api dev` を実行してください。

### Q3. サーバー起動時に `UnsupportedClassVersionError (class file version 65.0)` と表示される
- **原因**: Minecraft 1.20.5 以降は **Java 21** が必須ですが、PC のデフォルト `java` が Java 17 以前になっています。
- **対策**: Java 21（Adoptium Temurin 21 等）をインストールするか、ダッシュボードの **「環境設定 (`/dashboard/settings`)」** の「Java 実行ファイルパス」に `C:\Program Files\Eclipse Adoptium\jdk-21...\bin\java.exe` を指定して保存してください。

### Q4. 「1時間あたりのサーバー起動上限（3回）に達しました」と表示される
- **原因**: 不正利用防止のレートリミット（1時間3回まで）が作動しています。
- **対策**: ローカル開発中にリセットしたい場合は、`apps/api` ディレクトリで以下を実行してください。
  ```powershell
  npx wrangler d1 execute msiaas-db --local --command "UPDATE users SET server_launch_count_1h = 0;"
  ```

### Q5. ポート `3000` または `8787` が既に使用中になる
- **対策**: 既存の Node.js / Wrangler プロセスがバックグラウンドに残っている可能性があります。タスクマネージャーまたは以下の PowerShell コマンドで該当ポートのプロセスを終了してから再起動してください。
  ```powershell
  Get-NetTCPConnection -LocalPort 3000,8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
  ```

---

## 7. 更新履歴（Revision History）

| 更新日 | 版 | 更新内容・変更概要 |
| :--- | :--- | :--- |
| **2026-11-01** | **v1.3.0** | **・大量MOD読み込み時のアプリ「応答なし」・フリーズ防止対策**<br>- 全Tauri重処理の `async` + `spawn_blocking` 非同期スレッド化<br>- JAR解析の並列マルチスレッド化（`scan_jars_in_dir_with_progress`）<br>- メタデータメモリキャッシュ (`JAR_META_CACHE`) 導入<br>- フロントエンド MOD 一覧の分割描画 (`ChunkedList`: 40件ずつ表示)<br>- 起動時ログのバッチ集約送信 (`server-log-batch`) と 400 行上限化<br>**・起動マニュアルの改訂**<br>- PowerShell / コマンドプロンプト両対応のコマンド記載<br>- バックエンド API 同時起動仕様・単体起動手順の明記<br>- 構文エラー（Q1）のトラブルシューティング追加 |
| **2026-10-30** | **v1.2.0** | **・Forge Dedicated Server 対応の実装**<br>- 真の Forge サーバー展開・起動（`@forge_server_args.txt --nogui`）<br>- クライアント専用 MOD 自動除外、`config/` 同期、初回ワールドリセット機能<br>**・ZIP 前提 MOD 不足検出および確認通知機能**<br>- サーバー側/クライアント側不足判定と「構成に入れてよいか」の注意文・自動補完 |
| **2026-10-29** | **v1.1.0** | **・MOD Side Filter 自動仕分け確認モーダル実装**<br>- ZIP インポート時およびサーバー起動前の 3 区分確認・トグル切り替え<br>- 日本語クラッシュログ自動診断エンジンの強化（Fabric/Javaバージョン/クライアントMOD混入） |
| **2026-10-22** | **v1.0.0** | **・初版リリース**<br>- モノレポ構造設計、D1 データベース設計、E2E サンドボックス統合テスト整備 |
