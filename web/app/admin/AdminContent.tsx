'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEAL_LABEL, type DealType } from '@/lib/regions-admin';

interface Row {
  regionKey: string;
  sido: string;
  dealType: DealType;
  status: 'success' | 'failed' | 'unknown';
  lastRunAt: string | null;
  durationMs: number | null;
  attempts: number;
  rowsTotal: number | null;
  rowsNew: number | null;
  fileBytes: number | null;
  error: string | null;
  runUrl: string | null;
  txCount: number;
  latestContractDate: string | null;
  lastInsertedAt: string | null;
}

/** 주 2회(월·목) 스케줄 기준, 4일 넘게 안 돌면 지연으로 본다. */
const STALE_MS = 4 * 24 * 60 * 60 * 1000;

function ago(iso: string | null): string {
  if (!iso) return '기록 없음';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function mmdd(iso: string | null): string {
  return iso ? iso.slice(5, 10) : '—';
}

type Health = { label: string; tone: 'ok' | 'warn' | 'bad' };

function health(r: Row): Health {
  if (r.status === 'failed') return { label: '실패', tone: 'bad' };
  if (r.status === 'unknown') return { label: '기록 없음', tone: 'warn' };
  if (r.lastRunAt && Date.now() - new Date(r.lastRunAt).getTime() > STALE_MS) {
    return { label: '지연', tone: 'warn' };
  }
  if (r.rowsNew === 0) return { label: '신규 0건', tone: 'warn' };
  return { label: '정상', tone: 'ok' };
}

const TONE: Record<Health['tone'], string> = {
  ok:   'bg-[#E6F4EA] text-[#1E6B3A]',
  warn: 'bg-[#FDF3D8] text-[#8A6100]',
  bad:  'bg-[#FBEAEA] text-[#A32D2D]',
};

export default function AdminContent() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/status')
      .then(async res => {
        if (res.status === 401) { router.replace('/admin/login'); return null; }
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? '불러오지 못했습니다');
        return body;
      })
      .then(body => body && setRows(body.rows))
      .catch(e => setError(e.message));
  }, [router]);

  async function logout() {
    await fetch('/api/admin/login', { method: 'DELETE' });
    router.replace('/admin/login');
  }

  if (error) return <p className="text-[14px] text-[#A32D2D]">{error}</p>;
  if (!rows) return <p className="text-[14px] text-[#8A8A82]">불러오는 중...</p>;

  const worst = rows.some(r => health(r).tone === 'bad') ? '실패 있음'
              : rows.some(r => health(r).tone === 'warn') ? '주의'
              : '정상';
  const lastRun = rows.map(r => r.lastRunAt).filter(Boolean).sort().reverse()[0] ?? null;
  const totalTx = rows.reduce((s, r) => s + r.txCount, 0);

  return (
    <>
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-[18px] font-medium">데이터 수집 현황</h1>
        <button onClick={logout} className="text-[13px] text-[#8A8A82] hover:text-[#1F1F1D]">
          로그아웃
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {[
          { label: '전체 상태', value: worst },
          { label: '마지막 실행', value: ago(lastRun) },
          { label: '총 거래', value: totalTx.toLocaleString() },
        ].map(c => (
          <div key={c.label} className="rounded-lg bg-[#F5F5F0] p-4">
            <p className="text-[13px] text-[#8A8A82] mb-1">{c.label}</p>
            <p className="text-[20px] font-medium">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[#E6E6DE] overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="text-left text-[#8A8A82]">
              <th className="font-normal px-4 py-3">지역</th>
              <th className="font-normal py-3">유형</th>
              <th className="font-normal py-3">상태</th>
              <th className="font-normal py-3">마지막 적재</th>
              <th className="font-normal py-3">최신 계약일</th>
              <th className="font-normal py-3 text-right">신규</th>
              <th className="font-normal px-4 py-3 text-right">총 건수</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const h = health(r);
              const id = `${r.dealType}-${r.regionKey}`;
              const expandable = Boolean(r.error || r.runUrl);
              return (
                <tr
                  key={id}
                  onClick={() => expandable && setOpen(open === id ? null : id)}
                  className={`border-t border-[#EFEFE9] ${expandable ? 'cursor-pointer hover:bg-[#FAFAF7]' : ''}`}
                >
                  <td className="px-4 py-3">
                    {r.sido}
                    {open === id && (
                      <div className="mt-2 font-normal">
                        {r.error && (
                          <p className="font-mono text-[12px] text-[#A32D2D] whitespace-pre-wrap">
                            {r.error}
                          </p>
                        )}
                        {r.attempts > 1 && (
                          <p className="text-[12px] text-[#8A8A82] mt-1">{r.attempts}회 시도</p>
                        )}
                        {r.runUrl && (
                          <a
                            href={r.runUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-[12px] text-[#3A6EA5] mt-1 inline-block"
                          >
                            Actions 실행 로그 →
                          </a>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-3 text-[#8A8A82]">{DEAL_LABEL[r.dealType]}</td>
                  <td className="py-3">
                    <span className={`inline-block px-2 py-1 rounded text-[12px] ${TONE[h.tone]}`}>
                      {h.label}
                    </span>
                  </td>
                  <td className="py-3 text-[#8A8A82]">{ago(r.lastRunAt)}</td>
                  <td className="py-3 text-[#8A8A82]">{mmdd(r.latestContractDate)}</td>
                  <td className="py-3 text-right">
                    {r.rowsNew === null ? '—' : `+${r.rowsNew.toLocaleString()}`}
                  </td>
                  <td className="px-4 py-3 text-right text-[#8A8A82]">
                    {r.txCount.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[12px] text-[#8A8A82]">
        수집은 매주 월·목 오전 10시에 자동 실행됩니다. 실패한 행을 누르면 원인과 실행 로그가 열립니다.
      </p>
    </>
  );
}
