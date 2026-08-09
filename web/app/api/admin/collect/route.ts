import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, verifyToken } from '@/lib/admin-auth';
import { COLLECTED_REGIONS, DEAL_TYPES } from '@/lib/regions-admin';

export const dynamic = 'force-dynamic';

/**
 * /admin에서 수집 워크플로를 직접 돌리기 위한 라우트.
 *
 * 주 2회 스케줄에서는 한 번 실패가 3~4일 공백이 된다. Actions 탭에 들어가지 않고도
 * 재실행할 수 있어야 한다. 자동 재시도(.github/workflows/retry-collect.yml)가
 * 예약 실행 실패는 알아서 한 번 더 돌리므로, 이 버튼은 그마저 실패했을 때와
 * 지금 당장 받아야 할 때를 위한 수단이다.
 *
 * 토큰은 Actions read/write 권한만 가진 fine-grained PAT이며 서버에서만 쓴다.
 * 절대 클라이언트로 내려보내지 않는다 (GET 응답에도 설정 여부만 담는다).
 */
const WORKFLOW_FILE = 'auto-collect.yml';
const REPO = process.env.COLLECT_REPO ?? 'leesangwow/apt-reco-storage';
const REF  = process.env.COLLECT_REF  ?? 'main';

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

function token(): string | null {
  return process.env.COLLECT_DISPATCH_TOKEN || null;
}

interface RunSummary {
  id: number;
  status: string;              // queued | in_progress | completed
  conclusion: string | null;   // success | failure | cancelled | ...
  createdAt: string;
  url: string | null;
  event: string;
  running: boolean;
}

/** 최근 실행 1건. 토큰이 없어도 공개 저장소라 읽기는 되지만, 있으면 호출 한도가 넉넉하다. */
async function latestRun(): Promise<RunSummary | null> {
  const t = token();
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`,
    {
      headers: t ? { ...GH_HEADERS, Authorization: `Bearer ${t}` } : GH_HEADERS,
      cache: 'no-store',
    },
  );
  if (!res.ok) return null;

  const body = await res.json();
  const run = body.workflow_runs?.[0];
  if (!run) return null;

  return {
    id:         run.id,
    status:     run.status,
    conclusion: run.conclusion,
    createdAt:  run.created_at,
    url:        run.html_url ?? null,
    event:      run.event,
    running:    run.status !== 'completed',
  };
}

export async function GET() {
  const store = await cookies();
  if (!verifyToken(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    configured: Boolean(token()),
    run: await latestRun(),
  });
}

export async function POST(req: NextRequest) {
  // proxy.ts에서 이미 막지만, Next.js 문서 권고대로 라우트 안에서도 다시 검사한다.
  const store = await cookies();
  if (!verifyToken(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const t = token();
  if (!t) {
    return NextResponse.json(
      { error: 'COLLECT_DISPATCH_TOKEN이 설정되지 않았습니다' },
      { status: 500 },
    );
  }

  let type = 'all';
  let regions = '';
  try {
    ({ type = 'all', regions = '' } = await req.json());
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
  }

  if (type !== 'all' && !(DEAL_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ error: `알 수 없는 수집 유형: ${type}` }, { status: 400 });
  }

  // 지역 키를 그대로 워크플로 입력으로 넘기므로 목록에 있는 값만 통과시킨다.
  // (스크립트도 모르는 키를 받으면 종료코드 2로 죽지만, 2시간짜리 실행을 띄워놓고
  //  오타 때문에 실패하는 것보다 여기서 막는 편이 낫다)
  const keys = String(regions).split(',').map(s => s.trim()).filter(Boolean);
  const known = new Set(COLLECTED_REGIONS.map(r => r.key));
  const unknown = keys.filter(k => !known.has(k));
  if (unknown.length) {
    return NextResponse.json(
      { error: `알 수 없는 지역: ${unknown.join(', ')}` },
      { status: 400 },
    );
  }

  // 워크플로의 concurrency가 겹친 실행을 대기시키긴 하지만, 그러면 버튼을 누른 만큼
  // 2시간짜리 수집이 줄줄이 예약된다. 이미 도는 중이면 여기서 되돌린다.
  const current = await latestRun();
  if (current?.running) {
    return NextResponse.json(
      { error: '이미 수집이 실행 중입니다', run: current },
      { status: 409 },
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: { ...GH_HEADERS, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: REF, inputs: { type, regions: keys.join(',') } }),
    },
  );

  if (!res.ok) {
    // 토큰 만료·권한 부족이 여기로 온다. 원문을 그대로 보여줘야 고칠 수 있다.
    const detail = (await res.text()).slice(0, 300);
    return NextResponse.json(
      { error: `실행 요청 실패 (${res.status}): ${detail}` },
      { status: 502 },
    );
  }

  // dispatch 응답(204)에는 실행 id가 없다. 화면은 GET으로 상태를 다시 물어본다.
  return NextResponse.json({ ok: true, type, regions: keys });
}
