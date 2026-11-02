/**
 * クライアントサイド用インタラクティブオーディオユーティリティ
 */

/**
 * ボタンクリックなどのアクション決定音 (btn121.wav) を再生します
 * 連打時にもスムーズに再生されるよう、毎回新しいインスタンスで再生します
 */
export function playClickSound() {
  if (typeof window === 'undefined') return;

  try {
    const audio = new Audio('/sounds/click.wav');
    audio.volume = 0.3; // 邪魔にならない心地よい音量に設定
    audio.play().catch(err => {
      // ブラウザの自動再生制限によるエラーを安全にバイパス
      console.log('[Sound] Autoplay click sound blocked or failed:', err.message);
    });
  } catch (e) {
    console.error('[Sound] Failed to play click sound:', e);
  }
}

/**
 * サーバー起動完了時のレベルアップ音 (reheruaffu.wav) を再生します
 */
export function playLevelUpSound() {
  if (typeof window === 'undefined') return;

  try {
    const audio = new Audio('/sounds/level_up.wav');
    audio.volume = 0.45;
    audio.play().catch(err => {
      console.log('[Sound] Autoplay level_up sound blocked or failed:', err.message);
    });
  } catch (e) {
    console.error('[Sound] Failed to play level_up sound:', e);
  }
}
