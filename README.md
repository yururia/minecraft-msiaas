# Minecraft MSIaaS (Minecraft Server Infrastructure as a Service)

> **「遊びたい MOD を選ぶだけ、または Modpack ZIP をドロップするだけで、誰でも安全にマルチサーバーを立てられるプラットフォーム」**

**Minecraft MSIaaS** は、MOD の前提関係自動解決・クライアント専用 MOD の自動除外（**MOD Side Filter**）・ローカル/クラウドサーバー構築・ポート開放不要の Playit.gg トンネル接続・起動失敗時の**日本語クラッシュ原因自動診断**を備えた次世代 Minecraft サーバー管理システムです。

---

## 📚 ドキュメント一覧 (`docs/`)

プロジェクトの全体設計・図解（画面遷移図・ER図・クラス関係図・シーケンス図）・起動手順は以下のドキュメントに体系化されています。

1. **[外部設計書 (01_external_design.md)](file:///c:/Users/yasud/minecraft-msiaas/docs/01_external_design.md)**
   - システム全体アーキテクチャ図
   - 画面一覧・**画面遷移図**（MOD Side 確認モーダル・サーバー起動前確認モーダル含む）
   - UI 外部仕様（MOD Side 3区分表示・詳細クラッシュ診断ログ表示）
   - REST API 外部インターフェース仕様一覧
   - データベース論理設計（**ER図**：全9テーブル＋マイグレーション `0000`〜`0003`）
2. **[内部設計書 (02_internal_design.md)](file:///c:/Users/yasud/minecraft-msiaas/docs/02_internal_design.md)**
   - モノレポ依存関係ルール（Dependency Cruiser）
   - **クラス・構造体・モジュール関係図（Class Diagram）**
   - MOD Side Filter アルゴリズム設計（`parseSimpleTOML`, `classifyModSide`, `scanAndFilterMods`, `should_include_mod_on_server`）
   - **サーバー起動＆クラッシュログ自動診断シーケンス図**
   - 不在検知・自動停止ステートマシン設計（Cron FSM）
   - セキュリティ・レートリミット制御（1時間3回上限・同時1台排他制御）
3. **[起動・運用・テストマニュアル (03_startup_and_operations_manual.md)](file:///c:/Users/yasud/minecraft-msiaas/docs/03_startup_and_operations_manual.md)**
   - 前提ツール・初回セットアップ・D1 マイグレーション手順
   - 開発サーバー＆デスクトップアプリ一括起動（`pnpm dev`）
   - 機能操作ガイド（ZIP インポート、MOD Side 仕分け確認、サーバー起動テスト、ゲスト配布用ZIP作成）
   - テスト・検証コマンド一覧・トラブルシューティング
4. **[アーカイブ (docs/archive/README.md)](file:///c:/Users/yasud/minecraft-msiaas/docs/archive/README.md)**
   - 初期フェーズに作成された旧要件定義書・旧SVG図・一時スクリプト等の保管庫

---

## 🗂️ プロジェクトフォルダ構成

```text
minecraft-msiaas/
├── README.md                          # プロジェクト総合インデックス（本ファイル）
├── package.json                       # ルートスクリプト (dev, build, lint, lint:deps)
├── pnpm-workspace.yaml                # pnpm ワークスペース定義
├── turbo.json                         # Turborepo パイプライン定義
├── .dependency-cruiser.cjs            # レイヤー間依存関係ルール定義
├── docs/                              # 設計書・マニュアル・アーカイブ一式
│   ├── 01_external_design.md          # 外部設計書（画面遷移図・API仕様・ER図）
│   ├── 02_internal_design.md          # 内部設計書（クラス関係図・シーケンス図・FSM）
│   ├── 03_startup_and_operations_manual.md # 起動・運用・テストマニュアル
│   └── archive/                       # 過去の設計ファイル・一時スクリプト保管フォルダ
├── infra/                             # インフラ・データベース定義
│   ├── d1/                            # Cloudflare D1 (SQLite) マイグレーション (0000〜0003)
│   ├── cloud-init/                    # クラウドVM初期化テンプレート
│   └── server-scripts/                # サーバー運用シェルスクリプト
├── packages/                          # フレームワーク非依存の共通パッケージ群
│   ├── shared/                        # @msiaas/shared (Zod スキーマ・型・MOD Side Filter エンジン)
│   ├── mod-db-tools/                  # @msiaas/mod-db-tools (Modrinth / CurseForge API・依存解決)
│   └── cloud-provider/                # @msiaas/cloud-provider (Oracle / AWS / LocalJava 抽象化)
└── apps/                              # アプリケーション群
    ├── web/                           # @msiaas/web (Next.js 14 ダッシュボード UI / Electron 対応)
    ├── client/                        # @msiaas/client (Tauri Rust デスクトップコア・Java起動・クラッシュ解析)
    ├── api/                           # @msiaas/api (Hono REST API + Cron 自動停止ワーカー)
    ├── provisioner/                   # @msiaas/provisioner (Cloudflare Queues コンシューマー)
    └── sandbox/                       # @msiaas/sandbox (インメモリ SQLite による E2E 統合シミュレーター)
```

---

## 🚀 クイックスタート

> ⚠️ コマンドは必ず **プロジェクトのルートディレクトリ (`C:\Users\yasud\minecraft-msiaas`)** で実行してください。

### PowerShell をご利用の場合（推奨）
```powershell
# 1. 依存パッケージのインストール
pnpm install

# 2. ローカル D1 データベースのマイグレーション適用 (0000〜0003)
$env:CI="true"; pnpm --filter @msiaas/api db:migrate

# 3. 開発サーバー＆Tauriデスクトップアプリの一括起動 (バックエンドAPIも自動起動します)
$env:CI="true"; pnpm dev
```

### コマンドプロンプト (cmd.exe) をご利用の場合
```cmd
:: 1. 依存パッケージのインストール
pnpm install

:: 2. ローカル D1 データベースのマイグレーション適用 (0000〜0003)
set CI=true&& pnpm --filter @msiaas/api db:migrate

:: 3. 開発サーバー＆Tauriデスクトップアプリの一括起動 (バックエンドAPIも自動起動します)
set CI=true&& pnpm dev
```

> **💡 バックエンド（API）について**:
> 上記の `pnpm dev` を実行すると、Turborepo により **バックエンド API (`@msiaas/api`: ポート 8787)**、**Web UI (`@msiaas/web`: ポート 3000)**、**Tauri デスクトップアプリ (`@msiaas/client`)** がすべて一括で自動起動します。
> もしバックエンド API のみ単体で起動したい場合は `pnpm --filter @msiaas/api dev` を実行してください。

- **Web UI**: `http://localhost:3000`
- **API Server (バックエンド)**: `http://127.0.0.1:8787` (ヘルスチェック: `http://127.0.0.1:8787/api/health`)
- **E2E シミュレーションテスト実行**: `pnpm --filter @msiaas/sandbox simulate`
- **Rust 単体テスト実行**: `cargo test --manifest-path apps/client/src-tauri/Cargo.toml`
- **Windows デスクトップアプリ直接実行**: `apps/client/src-tauri/target/release/Minecraft MSIaaS.exe` (起動時にポート 8787 のバックエンド API を自動連動起動)
