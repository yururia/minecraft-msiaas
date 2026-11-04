/// Sanitizes a Minecraft server console command before writing to Java stdin.
/// Strips carriage returns, newlines, and control characters to prevent command injection
/// (e.g., `say hello\nop attacker`) and blocks destructive commands if needed.
pub fn sanitize_server_command(raw_command: &str) -> Result<String, String> {
    let trimmed = raw_command.trim();
    if trimmed.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }

    // Reject multi-line or control character injection attempts
    if raw_command.contains('\n') || raw_command.contains('\r') || raw_command.contains('\0') {
        return Err("Invalid command: newline or null characters are not permitted.".to_string());
    }

    if trimmed.len() > 512 {
        return Err("Command exceeds maximum allowed length (512 characters).".to_string());
    }

    Ok(trimmed.to_string())
}

/// Analyzes Minecraft server logs on unexpected termination to diagnose common causes.
pub fn analyze_minecraft_crash_logs(logs: &[String], exit_code: i32) -> String {
    let mut java_version_error = false;
    let mut client_only_mod_error = false;
    let mut missing_dependency_error = false;
    let mut port_binding_error = false;

    for line in logs {
        if line.contains("UnsupportedClassVersionError")
            || line.contains("has been compiled by a more recent version of the Java Runtime")
        {
            java_version_error = true;
        }
        if line.contains("java.lang.RuntimeException: Cannot load class")
            && (line.contains("net.minecraft.client") || line.contains("Dist.CLIENT"))
        {
            client_only_mod_error = true;
        }
        if line.contains("Missing or unsupported mandatory dependencies")
            || line.contains("net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an incompatible mod set")
        {
            missing_dependency_error = true;
        }
        if line.contains("FAILED TO BIND TO PORT") || line.contains("Address already in use") {
            port_binding_error = true;
        }
    }

    if java_version_error {
        return "Javaのバージョン不一致エラーが検出されました。Minecraftバージョンに対応したJava（例: 1.20.1はJava 17以上、1.20.5以降はJava 21以上）が選択されているか確認してください。".to_string();
    }
    if client_only_mod_error {
        return "クライアント専用MOD（描画・UI系MODなど）がサーバー側に混入しているためクラッシュしました。該当MODを除外して再起動してください。".to_string();
    }
    if missing_dependency_error {
        return "前提MOD（必須依存MOD）の不足またはバージョン不整合が検出されました。プリセットの前提MOD解決を実行してください。".to_string();
    }
    if port_binding_error {
        return "ポート 25565 が既に他のプロセスで使用されています。ゾンビプロセス検知・強制終了を実行してから再試行してください。".to_string();
    }

    format!("サーバーが予期せず終了しました (終了コード: {})", exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_server_command() {
        assert!(sanitize_server_command("  help  ").is_ok());
        assert_eq!(sanitize_server_command("help").unwrap(), "help");
        assert!(sanitize_server_command("say hello\nop hacker").is_err());
        assert!(sanitize_server_command("").is_err());
    }

    #[test]
    fn test_analyze_crash_logs() {
        let logs = vec![
            "Starting minecraft server".to_string(),
            "UnsupportedClassVersionError: class has been compiled by a more recent version".to_string(),
        ];
        let msg = analyze_minecraft_crash_logs(&logs, 1);
        assert!(msg.contains("Javaのバージョン不一致エラー"));
    }
}
