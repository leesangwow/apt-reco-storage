'use client';

import { useEffect, useRef, useState } from 'react';
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

/** 수집 워크플로의 최근 실행. running이면 화면이 주기적으로 다시 물어본다. */
interface Run {
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string | null;
  running: boolean;
}

/** 실행 중일 때만 상태를 다시 물어보는 간격. 수집은 2시간짜리라 촘촘할 이유가 없다. */
const POLL_MS = 20_000;

const CONCLUSION_LABEL: Record<string, string> = {
  success:   '성공',
  failure:   '실패',
  cancelled: '취소됨',
  timed_out: '시간 초과',
};

export default function AdminContent() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const [run, setRun] = useState<Run | null>(null);
  const [canDispatch, setCanDispatch] = useState(false);
  const [dealType, setDealType] = useState<'all' | DealType>('all');
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState('');
  const [pollKey, setPollKey] = useState(0);
  const wasRunning = useRef(false);

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

  // 수집 실행 상태는 현황표와 별개로 가져온다. GitHub API 쪽이 막혀 있어도
  // (토큰 미설정·만료 등) 현황표는 그대로 보여야 한다.
  //
  // 실행 중일 때만 스스로 다음 조회를 예약한다. 끝나면 멈추고, 버튼을 누르면
  // pollKey가 바뀌면서 다시 시작한다 — 가만히 열어둔 화면이 API를 두드리지 않게.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch('/api/admin/collect');
        if (!alive || !res.ok) return;
        const body = await res.json();
        if (!alive) return;

        setRun(body.run);
        setCanDispatch(body.configured);

        if (body.run?.running) {
          wasRunning.current = true;
          timer = setTimeout(poll, POLL_MS);
        } else if (wasRunning.current) {
          // 방금 끝났다. 현황표의 숫자도 함께 움직였을 테니 다시 읽는다.
          wasRunning.current = false;
          const r = await fetch('/api/admin/status');
          if (alive && r.ok) setRows((await r.json()).rows);
        }
      } catch {
        /* 상태 조회 실패는 화면을 막을 이유가 못 된다 */
      }
    }

    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [pollKey]);

  async function startCollect(regions: string[] = []) {
    setStarting(true);
    setNotice('');
    try {
      const res = await fetch('/api/admin/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: dealType, regions: regions.join(',') }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? '실행하지 못했습니다');

      setNotice(
        regions.length
          ? `${regions.length}개 지역 재수집을 시작했습니다.`
          : '전체 수집을 시작했습니다.',
      );
      // dispatch 응답(204)에는 실행 id가 없고, 목록에 잡히기까지 몇 초 걸린다.
      // 잠깐 두었다가 폴링을 다시 켠다.
      setTimeout(() => setPollKey(k => k + 1), 3_000);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '실행하지 못했습니다');
    } finally {
      setStarting(false);
    }
  }

  async function logout() {
    await fetch('/api/admin/login', { method: 'DELETE' });
    router.replace('/admin/login');
  }

  const worst = !rows ? '—'
              : rows.some(r => health(r).tone === 'bad') ? '실패 있음'
              : rows.some(r => health(r).tone === 'warn') ? '주의'
              : '정상';
  const lastRun = rows ? rows.map(latestAt).filter(Boolean).sort().reverse()[0] ?? null : null;
  const totalTx = rows ? rows.reduce((s, r) => s + r.txCount, 0) : 0;

  // 실패한 지역만 골라 다시 돌리기 위한 목록. 유형이 달라도 같은 지역이면 한 번에 받는다
  // (워크플로의 regions 입력은 지역 단위라 유형별로 나눌 수 없다).
  const failedKeys = Array.from(
    new Set(
      (rows ?? []).filter(r => health(r).tone === 'bad').map(r => r.regionKey),
    ),
  );
  const busy = starting || Boolean(run?.running);

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
          { label: '총 거래', value: rows ? totalTx.toLocaleString() : '—' },
        ].map(c => (
          <div key={c.label} className="rounded-lg bg-[#F5F5F0] p-4">
            <p className="text-[13px] text-[#8A8A82] mb-1">{c.label}</p>
            <p className="text-[20px] font-medium">{c.value}</p>
          </div>
        ))}
      </div>

      {/* 수동 수집 — 주 2회 스케줄에서 한 번 실패하면 3~4일이 빈다.
          Actions 탭에 들어가지 않고 여기서 바로 다시 돌린다. */}
      <div className="rounded-lg border border-[#E6E6DE] p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={dealType}
            onChange={e => setDealType(e.target.value as 'all' | DealType)}
            disabled={busy || !canDispatch}
            className="rounded-md border border-[#E6E6DE] bg-white px-3 py-2 text-[13px] disabled:opacity-50"
          >
            <option value="all">매매 + 전월세</option>
            <option value="buy">매매만</option>
            <option value="rent">전월세만</option>
          </select>

          <button
            onClick={() => startCollect()}
            disabled={busy || !canDispatch}
            className="rounded-md bg-[#1F1F1D] px-4 py-2 text-[13px] text-white disabled:opacity-40"
          >
            {run?.running ? '수집 중...' : '전체 수집 시작'}
          </button>

          <button
            onClick={() => startCollect(failedKeys)}
            disabled={busy || !canDispatch || failedKeys.length === 0}
            className="rounded-md border border-[#E6E6DE] px-4 py-2 text-[13px] disabled:opacity-40"
          >
            실패 지역만 재수집
            {failedKeys.length > 0 && ` (${failedKeys.length})`}
          </button>

          {run && (
            <span className="text-[13px] text-[#8A8A82]">
              {run.running
                ? `실행 중 · ${ago(run.createdAt)} 시작`
                : `마지막 실행 ${ago(run.createdAt)} · ${run.conclusion ? CONCLUSION_LABEL[run.conclusion] ?? run.conclusion : '—'}`}
              {run.url && (
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-[#3A6EA5]"
                >
                  로그 →
                </a>
              )}
            </span>
          )}
        </div>

        {!canDispatch && (
          <p className="mt-3 text-[12px] text-[#8A6100]">
            COLLECT_DISPATCH_TOKEN 환경변수가 없어 실행 요청을 보낼 수 없습니다.
            Actions 권한(read/write)을 가진 fine-grained 토큰을 설정해 주세요.
          </p>
        )}
        {notice && <p className="mt-3 text-[12px] text-[#8A8A82]">{notice}</p>}
        <p className="mt-3 text-[12px] text-[#8A8A82]">
          전체 수집은 16개 지역 × 매매·전월세라 2시간 가까이 걸립니다. 시작해도 화면의
          숫자는 적재가 끝나야 움직입니다.
        </p>
      </div>

      {unmatched.length > 0 && (
        <div className="rounded-lg bg-[#FDF3D8] text-[#8A6100] text-[13px] p-4 mb-6">
          아래 시도의 거래가 어느 수집 지역에도 잡히지 않아 표의 총 건수에서 빠져 있습니다.
          <code className="font-mono"> {unmatched.join(', ')} </code>
          — lib/regions-admin.ts의 sidos에 추가해야 합니다.
        </div>
      )}

      {/* 현황 조회가 실패해도 위의 수집 패널은 남긴다 — 표가 안 뜨는 상황이야말로
          수동으로 다시 돌려야 할 때다. */}
      {error && (
        <div className="rounded-lg bg-[#FBEAEA] text-[#A32D2D] text-[13px] p-4 mb-6">
          현황을 불러오지 못했습니다: {error}
        </div>
      )}
      {!rows && !error && <p className="text-[14px] text-[#8A8A82]">불러오는 중...</p>}

      {rows && (
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
      )}

      <p className="mt-4 text-[12px] text-[#8A8A82]">
        수집은 매주 월·목 오전 10시에 자동 실행되고, 실패하면 90분 뒤 한 번 자동으로 다시 돌립니다.
        실패한 행을 누르면 원인과 실행 로그가 열립니다.
        <br />
        다운로드는 CSV를 받는 단계, 적재는 그 CSV를 DB에 넣는 단계입니다. 둘 다 끝나야 &lsquo;정상&rsquo;이며,
        화면의 최신 계약일·총 건수는 적재가 끝나야 움직입니다.
      </p>
    </>
  );
}
