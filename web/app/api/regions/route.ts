import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { NEIGHBORS } from '@/lib/regions';
import { COLLECTED_REGIONS } from '@/lib/regions-admin';

// 가격대 탐색의 시도·시군구 목록.
//
// 원래는 get_sido_list / get_gu_list RPC만 불렀는데, 이 두 함수는 저장소 어디에도
// 정의가 없었다 (supabase/migrations/2026-10-07_region_lists.sql로 추가). 운영 DB에
// 함수가 없으면 { error }가 내려가고, 화면이 그걸 배열로 펼치다 깨져서 "가격대로 찾기"
// 탭 전체가 동작하지 않았다. 마이그레이션 적용 전이어도 돌아가도록, RPC가 실패하면
// 추천 API가 읽는 apt_prices_mv를 직접 읽는다. 목록은 데이터 적재(주 2회) 때만 바뀌므로
// 대체 경로 결과는 메모리에 잠시 들고 있는다.

type GuRow = { gu: string; count: number };

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// DB의 sido 값이 될 수 있는 이름들. 있는지만 하나씩 확인한다.
const SIDO_CANDIDATES = Array.from(new Set([
  ...Object.keys(NEIGHBORS),
  ...COLLECTED_REGIONS.flatMap(r => r.sidos),
]));

async function sidoListFallback(): Promise<string[]> {
  const found = await Promise.all(SIDO_CANDIDATES.map(async sido => {
    const { data, error } = await supabase
      .from('apt_prices_mv').select('id').eq('sido', sido).limit(1);
    if (error) throw error;
    return (data?.length ?? 0) > 0 ? sido : null;
  }));
  return found.filter((s): s is string => s !== null);
}

// PostgREST에는 distinct가 없어 gu 열만 페이지로 나눠 받아 센다.
// 한 번에 오는 행 수는 서버 max-rows(기본 1000)에 묶인다.
const PAGE = 1000;
async function guListFallback(sido: string): Promise<GuRow[]> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('apt_prices_mv').select('gu').eq('sido', sido)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) counts.set(r.gu, (counts.get(r.gu) ?? 0) + 1);
    if ((data?.length ?? 0) < PAGE) break;
  }
  return Array.from(counts, ([gu, count]) => ({ gu, count }))
    .sort((a, b) => a.gu.localeCompare(b.gu, 'ko'));
}

export async function GET(req: NextRequest) {
  const sido = req.nextUrl.searchParams.get('sido');

  try {
    if (!sido) {
      const { data, error } = await supabase.rpc('get_sido_list');
      if (!error) return NextResponse.json((data ?? []).map((r: { sido: string }) => r.sido));
      return NextResponse.json(await cached('sido', sidoListFallback));
    }

    const { data, error } = await supabase.rpc('get_gu_list', { p_sido: sido });
    if (!error) return NextResponse.json(data ?? []);
    return NextResponse.json(await cached(`gu:${sido}`, () => guListFallback(sido)));
  } catch (e) {
    const message = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
