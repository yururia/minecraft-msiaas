import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#fff', textAlign: 'center', padding: '2rem' }}>
      <h2 style={{ fontSize: '2rem', marginBottom: '1rem' }}>404 - ページが見つかりません</h2>
      <p style={{ color: '#9ca3af', marginBottom: '1.5rem' }}>お探しのページは存在しないか、移動した可能性があります。</p>
      <Link href="/dashboard" style={{ padding: '0.6rem 1.2rem', background: '#38bdf8', color: '#0f172a', borderRadius: '6px', fontWeight: 'bold', textDecoration: 'none' }}>
        ダッシュボードへ戻る
      </Link>
    </div>
  );
}
