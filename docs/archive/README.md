# アーカイブディレクトリ (`docs/archive`)

このディレクトリには、プロジェクト初期フェーズ（MVP策定時〜UIプロトタイプ作成時）に作成され、現在は最新の設計書・マイグレーションファイル・本番アセットに統合・置換された過去のファイルを保管しています。

## 保管ファイル一覧

| パス | 内容 | 現在の参照先（後継ファイル） |
| :--- | :--- | :--- |
| [要件定義書_v2.md](file:///c:/Users/yasud/minecraft-msiaas/docs/archive/%E8%A6%81%E4%BB%B6%E5%AE%9A%E7%BE%A9%E6%9B%B8_v2.md) | プロジェクト初期の要件定義書（v2.0） | [01_external_design.md](file:///c:/Users/yasud/minecraft-msiaas/docs/01_external_design.md) / [02_internal_design.md](file:///c:/Users/yasud/minecraft-msiaas/docs/02_internal_design.md) |
| [msiaas_full_screen_flow.svg](file:///c:/Users/yasud/minecraft-msiaas/docs/archive/msiaas_full_screen_flow.svg) | 初期プロトタイプ時の画面遷移SVG図 | [01_external_design.md](file:///c:/Users/yasud/minecraft-msiaas/docs/01_external_design.md) 内の画面遷移図 |
| [msiaas_schema.sql](file:///c:/Users/yasud/minecraft-msiaas/docs/archive/msiaas_schema.sql) | ルート直下に置かれていた旧単一SQLスキーマ | `infra/d1/0000_initial.sql` 〜 `0003_add_user_settings_columns.sql` |
| `raw_sounds/` | 効果音素材の元データ（`.wav`） | `apps/web/public/sounds/click.wav`, `level_up.wav` |
| `scratch/` | 初期のSVGテクスチャ抽出・DB修復用ワンオフスクリプト群 | `apps/web/public/images/*.svg` に生成済み |
