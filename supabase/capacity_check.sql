-- 용량 점검 — 과거분을 몇 년치까지 넣을 수 있는지 판단하는 근거
--
-- Supabase SQL Editor에 그대로 붙여 실행한다. 읽기만 하므로 언제 돌려도 안전하다.
-- 과거분 적재(.github/workflows/backfill.yml)는 한 해씩 끊어 도는데, 그 사이사이에
-- 이걸 돌려 남은 여유를 보고 멈출 시점을 정한다.
--
-- 비교 기준: 무료 플랜 500MB · Pro 8GB.

-- ① 무엇이 얼마나 차지하나 + 행 하나당 실제 바이트(인덱스 포함)
--    행당 바이트 × (한 해치 행수)가 곧 "한 해를 더 넣으면 늘어날 양"이다.
select
  c.relname                                     as 객체,
  s.n_live_tup                                  as 행수,
  pg_size_pretty(pg_total_relation_size(c.oid)) as 전체,
  pg_size_pretty(pg_indexes_size(c.oid))        as 그중_인덱스,
  case when s.n_live_tup > 0
       then round(pg_total_relation_size(c.oid)::numeric / s.n_live_tup)
  end                                           as 행당_바이트
from pg_class c
left join pg_stat_user_tables s on s.relid = c.oid
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'm')
order by pg_total_relation_size(c.oid) desc;

-- ② DB 전체 크기
select pg_size_pretty(pg_database_size(current_database())) as db_전체;

-- ③ 계약연도별 행수 — "한 해치가 몇 행인가"와 과거분이 실제로 들어왔는지 확인
--    정기 수집만 돌던 상태라면 최근 2개 연도에만 값이 있는 것이 정상이다.
select extract(year from contract_date)::int as 계약연도,
       count(*) filter (where src = 'buy')   as 매매,
       count(*) filter (where src = 'rent')  as 전월세
from (select contract_date, 'buy'::text as src from transactions
      union all select contract_date, 'rent' from rent_transactions) t
group by 1
order by 1 desc;
