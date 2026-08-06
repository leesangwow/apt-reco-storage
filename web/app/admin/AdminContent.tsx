'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEAL_LABEL, type DealType } from '@/lib/regions-admin';

/** 단계별 최신 기록의 상태. 'none'은 기록 자체가 없다는 뜻이다. */
type Stage = 'success' | 'failed' | 'none';

interface Row {
  regionKey: string;
  sido: string;
  dealType: DealType;
  downloadStatus: Stage;
  loadStatus: Stage;
  downloadAt: string | null;
  loadAt: string | null;
  durationMs: number | null;
  attempts: number;
  rowsTotal: number | null;
  rowsNew: number | null;
  fileBytes: number | null;
  error: string | null;
  runUrl: string | null;
  txCount: number;
  latestContractDate: string | null;
}

/** 주 2회(월·목) 스케줄 기준, 4일 넘게 안 돌면 지연으로 본다. */
const STALE_MS = 4 * 24 * 60 * 60 * 1000;

function ago(iso: string | null): string {
  if (!iso) return '—';
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

/** 두 단계 중 마지막으로 움직인 시각. 적재가 옛 회차 것일 수 있어 단순 우선순위로는 못 고른다. */
function latestAt(r: Row): string | null {
  const stamps = [r.downloadAt, r.loadAt].filter(Boolean) as string[];
  if (!stamps.length) return null;
  return stamps.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));
}

function health(r: Row): Health {
  // 어느 단계가 깨졌는지까지 알려준다. 원인이 다르면 손댈 곳도 다르다.
  if (r.downloadStatus === 'failed') return { label: '다운로드 실패', tone: 'bad' };
  if (r.loadStatus === 'failed')     return { label: '적재 실패',     tone: 'bad' };
  if (r.downloadStatus === 'none' && r.loadStatus === 'none') {
    return { label: '기록 없음', tone: 'warn' };
  }
  // CSV는 받았는데 그걸 넣은 적재 기록이 없거나, 적재가 그 CSV보다 오래됐다.
  // 화면에 보이는 거래 데이터는 아직 이번 회차분이 아니라는 뜻이다.
  if (r.loadStatus === 'none') return { label: '적재 없음', tone: 'warn' };
  if (r.downloadAt && r.loadAt && new Date(r.loadAt) < new Date(r.downloadAt)) {
    return { label: '적재 대기', tone: 'warn' };
  }
  const last = latestAt(r);
  if (last && Date.now() - new Date(last).getTime() > STALE_MS) {
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
  const [unmatched, setUnmatched] = useState<string[]>([]);
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
      .then(body => {
        if (!body) return;
        setRows(body.rows);
        setUnmatched(body.unmatchedSidos ?? []);
      })
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
  const lastRun = rows.map(latestAt).filter(Boolean).sort().reverse()[0] ?? null;
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

      {unmatched.length > 0 && (
        <div className="rounded-lg bg-[#FDF3D8] text-[#8A6100] text-[13px] p-4 mb-6">
          아래 시도의 거래가 어느 수집 지역에도 잡히지 않아 표의 총 건수에서 빠져 있습니다.
          <code className="font-mono"> {unmatched.join(', ')} </code>
          — lib/regions-admin.ts의 sidos에 추가해야 합니다.
        </div>
      )}

      <div className="rounded-xl border border-[#E6E6DE] overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="text-left text-[#8A8A82]">
              <th className="font-normal px-4 py-3">지역</th>
              <th className="font-normal py-3">유형</th>
              <th className="font-normal py-3">상태</th>
              <th className="font-normal py-3">다운로드</th>
              <th className="font-normal py-3">적재</th>
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
                  <td className="py-3 text-[#8A8A82]">{ago(r.downloadAt)}</td>
                  <td className="py-3 text-[#8A8A82]">{ago(r.loadAt)}</td>
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
        <br />
        다운로드는 CSV를 받는 단계, 적재는 그 CSV를 DB에 넣는 단계입니다. 둘 다 끝나야 &lsquo;정상&rsquo;이며,
        화면의 최신 계약일·총 건수는 적재가 끝나야 움직입니다.
      </p>
    </>
  );
}
