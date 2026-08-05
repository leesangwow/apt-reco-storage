'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.replace(params.get('next') ?? '/admin');
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? '로그인에 실패했습니다');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-[320px]">
      <h1 className="text-[18px] font-medium mb-1">관리자 로그인</h1>
      <p className="text-[13px] text-[#8A8A82] mb-6">데이터 수집 현황을 보려면 로그인하세요.</p>

      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="비밀번호"
        autoFocus
        className="w-full h-10 px-3 rounded-lg border border-[#DCDCD4] text-[14px] outline-none focus:border-[#8A8A82]"
      />

      {error && <p className="mt-2 text-[13px] text-[#C0392B]">{error}</p>}

      <button
        type="submit"
        disabled={busy || !password}
        className="mt-4 w-full h-10 rounded-lg bg-[#1F1F1D] text-white text-[14px] disabled:opacity-40"
      >
        {busy ? '확인 중...' : '로그인'}
      </button>
    </form>
  );
}

export default function AdminLoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
