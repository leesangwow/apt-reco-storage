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
  last_inserted_at: string | null;
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

  // 지역 8조합 × 2단계라 최근 400행이면 충분히 여러 회차를 덮는다.
  const [{ data: runs, error: runsError }, { data: stats }] = await Promise.all([
    supabase
      .from('ingestion_runs')
      .select('stage, deal_type, region_key, status, finished_at, duration_ms, attempts, rows_total, rows_new, file_bytes, error, run_url')
      .order('finished_at', { ascending: false })
      .limit(400),
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
      const stat     = statRows.find(s => s.deal_type === dealType && s.sido === region.sido);

      const failed = download?.status === 'failed' || load?.status === 'failed';
      const lastRun = load?.finished_at ?? download?.finished_at ?? null;

      return {
        regionKey:  region.key,
        sido:       region.sido,
        dealType,
        status:     failed ? 'failed' : lastRun ? 'success' : 'unknown',
        lastRunAt:  lastRun,
        durationMs: (download?.duration_ms ?? 0) + (load?.duration_ms ?? 0) || null,
        attempts:   download?.attempts ?? 1,
        rowsTotal:  load?.rows_total ?? null,
        rowsNew:    load?.rows_new ?? null,
        fileBytes:  download?.file_bytes ?? null,
        error:      download?.error ?? load?.error ?? null,
        runUrl:     download?.run_url ?? load?.run_url ?? null,
        txCount:            stat?.tx_count ?? 0,
        latestContractDate: stat?.latest_contract_date ?? null,
        lastInsertedAt:     stat?.last_inserted_at ?? null,
      };
    }),
  );

  return NextResponse.json({
    rows,
    generatedAt: new Date().toISOString(),
    hasHistory: runRows.length > 0,
  });
}
