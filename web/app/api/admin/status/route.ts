import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { ADMIN_COOKIE, verifyToken } from '@/lib/admin-auth';
import { COLLECTED_REGIONS, DEAL_TYPES, type DealType } from '@/lib/regions-admin';

export const dynamic = 'force-dynamic';

/**
 * ingestion_runs는 RLS로 anon 접근이 막혀 있으므로 service_role 키로 읽는다.
 * 이 키는 절대 클라이언트로 나가면 안 되며, 이 라우트 안에서만 쓴다.
 */
function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

interface RunRow {
  stage: string;
  deal_type: string;
  region_key: string;
  status: string;
  finished_at: string;
  duration_ms: number | null;
  attempts: number;
  rows_total: number | null;
  rows_new: number | null;
  file_bytes: number | null;
  error: string | null;
  run_url: string | null;
}

interface StatRow {
  deal_type: string;
  sido: string;
  tx_count: number;
  latest_contract_date: string | null;
}

export async function GET() {
  // proxy.ts에서 이미 막지만, Next.js 문서 권고대로 라우트 안에서도 다시 검사한다.
  const store = await cookies();
  if (!verifyToken(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = adminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다' },
      { status: 500 },
    );
  }

  // 회차당 16지역 × 2유형 × 2단계 = 64행. 800행이면 최근 12회차(약 6주)를 덮는다.
  const [{ data: runs, error: runsError }, { data: stats }] = await Promise.all([
    supabase
      .from('ingestion_runs')
      .select('stage, deal_type, region_key, status, finished_at, duration_ms, attempts, rows_total, rows_new, file_bytes, error, run_url')
      .order('finished_at', { ascending: false })
      .limit(800),
    supabase.from('region_data_stats').select('*'),
  ]);

  if (runsError) {
    return NextResponse.json({ error: runsError.message }, { status: 500 });
  }

  const runRows = (runs ?? []) as RunRow[];
  const statRows = (stats ?? []) as StatRow[];

  const latest = (dealType: string, regionKey: string, stage: string) =>
    runRows.find(r => r.deal_type === dealType && r.region_key === regionKey && r.stage === stage);

  const rows = DEAL_TYPES.flatMap((dealType: DealType) =>
    COLLECTED_REGIONS.map(region => {
      const download = latest(dealType, region.key, 'download');
      const load     = latest(dealType, region.key, 'load');
      // 한 수집 지역이 sido 여러 개에 걸칠 수 있다 (regions-admin.ts 주석 참고).
      const stats = statRows.filter(
        s => s.deal_type === dealType && region.sidos.includes(s.sido),
      );

      // 두 단계를 따로 내보낸다. 예전에는 여기서 적재 시각이 없으면 다운로드
      // 시각으로 대신하고(load?.finished_at ?? download?.finished_at) 그 값 하나로
      // 상태를 정했다. 그래서 CSV만 받아두고 적재가 통째로 빠진 회차가 화면에는
      // "정상 · 방금 적재됨"으로 보였다 (2026-08-06 낮 실행에서 실제로 겪었다).
      // 판정은 클라이언트 health()가 두 단계를 다 보고 내린다.
      const stageStatus = (r?: RunRow) =>
        r ? (r.status === 'failed' ? 'failed' : 'success') : 'none';

      return {
        regionKey:  region.key,
        sido:       region.label,
        dealType,
        downloadStatus: stageStatus(download),
        loadStatus:     stageStatus(load),
        downloadAt:     download?.finished_at ?? null,
        loadAt:         load?.finished_at ?? null,
        durationMs: (download?.duration_ms ?? 0) + (load?.duration_ms ?? 0) || null,
        attempts:   download?.attempts ?? 1,
        rowsTotal:  load?.rows_total ?? null,
        rowsNew:    load?.rows_new ?? null,
        fileBytes:  download?.file_bytes ?? null,
        error:      download?.error ?? load?.error ?? null,
        runUrl:     download?.run_url ?? load?.run_url ?? null,
        txCount: stats.reduce((sum, s) => sum + Number(s.tx_count ?? 0), 0),
        // 날짜는 'YYYY-MM-DD' 고정 폭이라 문자열 비교로 최댓값을 고를 수 있다.
        latestContractDate:
          stats.map(s => s.latest_contract_date)
               .filter(Boolean)
               .sort()
               .reverse()[0] ?? null,
      };
    }),
  );

  // 어느 지역도 가져가지 않은 sido. 이런 행은 화면에서 조용히 사라지고,
  // 그 지역은 적재가 멀쩡한데도 총 건수가 0으로 보인다. 그래서 드러내 둔다.
  const claimed = new Set(COLLECTED_REGIONS.flatMap(r => r.sidos));
  const unmatchedSidos = [
    ...new Set(statRows.filter(s => !claimed.has(s.sido)).map(s => s.sido)),
  ].sort();

  return NextResponse.json({
    rows,
    unmatchedSidos,
    generatedAt: new Date().toISOString(),
    hasHistory: runRows.length > 0,
  });
}
