-- 평형 구간(size_tier) 추가
--
-- 배경: apts의 키가 (단지명, 구, 동, 전용면적)이라 같은 평형이 84.28·84.74·84.97처럼
-- 여러 행으로 쪼개진다. 운영 데이터에서 해밀마을1단지 34평은 14개 행이었다.
-- 그만큼 연간 거래량이 나뉘어, 어느 행을 봐도 그 평형의 진짜 거래량이 안 보인다.
--
-- 이 마이그레이션이 하는 일:
--   1. apts에 통칭 평형(pyeong_supply)과 구간(size_tier) 생성 컬럼 추가
--   2. 구간 조회용 인덱스
--   3. 두 뷰에 size_tier / size_label / tier_deal_count_12m / pyeong_supply 컬럼 추가
--
-- 뷰의 행 구조는 그대로다(면적당 한 행). 구간 정보를 컬럼으로 얹기만 한다.
--
-- ⚠ 순서 주의: 이 SQL을 먼저 적용한 뒤에 앱을 배포해야 한다.
--   앱이 먼저 나가면 PostgREST가 모르는 컬럼을 거절해 화면이 빈다
--   (2026-08-06 deal_count_12m 때 실제로 겪었다).
--
-- Supabase SQL Editor에 통째로 붙여넣고 한 번 실행하면 된다. 여러 번 돌려도 안전하다.

-- ─── 1. 생성 컬럼 ───────────────────────────────────────────────────────────
-- 통칭 평형: 국토부 area_sqm은 전용면적이라 그대로 나누면 84㎡가 25.4평이 된다.
-- 통상 전용률 0.75로 되돌려야 사람들이 쓰는 "34평"이 나온다.
--
-- 구간: 20평 이상은 4평, 미만은 2평 단위. 32~35평 = 전용 78.1~88.0㎡로
-- 국민평형(84㎡)이 통째로 들어온다. size_tier가 구간 식별자이자 시작 평이다.
--
-- 두 컬럼을 한 문장에 넣어야 테이블 재작성이 한 번으로 끝난다.
alter table apts
  add column if not exists pyeong_supply smallint
    generated always as (round(area_sqm / (3.3058 * 0.75))::smallint) stored,
  add column if not exists size_tier smallint
    generated always as (
      case when round(area_sqm / (3.3058 * 0.75)) >= 20
           then ((round(area_sqm / (3.3058 * 0.75))::int / 4) * 4)::smallint
           else ((round(area_sqm / (3.3058 * 0.75))::int / 2) * 2)::smallint
      end
    ) stored;

-- ─── 2. 인덱스 ──────────────────────────────────────────────────────────────
-- 뷰가 행마다 "같은 단지·같은 구간의 다른 면적들"을 찾는 데 쓴다.
-- include로 pyeong_supply·id를 얹어 힙까지 안 가고 인덱스만 읽고 끝낸다.
create index if not exists idx_apts_complex_tier
  on apts (name, gu, dong, size_tier) include (pyeong_supply, id);

-- 전월세 뷰 전용. 구간 때문에 늘어난 비용을 이 인덱스가 상쇄하고도 남는다.
-- apt_rent_prices의 LATERAL들은 전부 "이 단지의 전세·신규 계약을 최신순으로"를 묻는데,
-- 유니크 인덱스로는 apt_id·contract_date까지만 좁혀지고 deal_type·contract_type은 힙에서
-- 걸러야 해서 월세·갱신까지 다 읽고 버린다. 조건을 인덱스에 박아 그 낭비를 없앤다.
-- 운영과 같은 규모로 만든 데이터에서 실측 (단지 32만, 전월세 거래 160만):
--   구간 없음  전월세 390ms → 구간 추가 715ms → 이 인덱스까지 70ms
create index if not exists idx_rent_tx_jeonse
  on rent_transactions (apt_id, contract_date desc, id desc) include (deposit_man)
  where deal_type = '전세' and contract_type = '신규';

-- 생성 컬럼 추가로 테이블이 재작성됐으니 통계와 visibility map을 다시 만든다.
-- (vacuum이 없으면 위 인덱스가 index only scan으로 안 잡힌다)
vacuum analyze apts;

-- ─── 3. 뷰 ─────────────────────────────────────────────────────────────────
-- 새 컬럼은 반드시 select 맨 뒤에 붙인다.
-- create or replace view는 기존 컬럼의 이름·순서를 바꾸지 못한다
-- (중간에 끼우면 ERROR: cannot change name of view column ...).

create or replace view apt_prices as
select
  a.id, a.name, a.sido, a.gu, a.dong, a.address,
  a.area_sqm, a.pyeong, a.year_built, a.hh, a.lat, a.lng, a.created_at,
  l.avg_price,
  l.deal_count,
  l.latest_date,
  l.oldest_date,
  l1.latest_price,
  l1.latest_floor,
  l1.latest_contract_date,
  case
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '1 month'  then 'fresh_high'
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '3 months' then 'fresh_mid'
    when l.deal_count >= 3                                                         then 'fresh_low'
    else                                                                                'scarce'
  end as freshness,
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m,
  -- ── 여기부터 이번에 추가되는 컬럼 ──
  a.pyeong_supply,
  a.size_tier,
  -- 라벨은 그 단지·구간에 실제로 있는 평형에서 뽑는다. 구간 이름(32~35평)을 그대로 쓰면
  -- 34평만 있는 단지도 32~35평으로 보여 실제보다 넓게 느껴진다.
  case when g.lo_py = g.hi_py then g.lo_py || '평'
       else g.lo_py || '~' || g.hi_py || '평' end as size_label,
  coalesce(g.tier_deal_count_12m, 0)::int         as tier_deal_count_12m
from apts a
cross join lateral (
  select round(avg(r.price_man) / 10000.0, 2) as avg_price,
         count(*)             as deal_count,
         max(r.contract_date) as latest_date,
         min(r.contract_date) as oldest_date
    from (select t.price_man, t.contract_date
            from transactions t
           where t.apt_id = a.id
             and t.contract_date >= current_date - interval '6 months'
           order by t.contract_date desc, t.id desc
           limit 3) r
) l
cross join lateral (
  select round(t.price_man::numeric / 10000.0, 2) as latest_price,
         t.floor                                  as latest_floor,
         t.contract_date                          as latest_contract_date
    from transactions t
   where t.apt_id = a.id
     and t.contract_date >= current_date - interval '6 months'
   order by t.contract_date desc, t.id desc
   limit 1
) l1
left join lateral (
  select count(*) as deal_count_12m
    from transactions t
   where t.apt_id = a.id
     and t.contract_date >= current_date - interval '12 months'
) y on true
-- 같은 단지·같은 구간의 다른 면적들을 모아 라벨과 구간 거래량을 만든다.
-- 라벨과 거래량을 한 LATERAL에 합쳐 apts 인덱스를 두 번 타지 않게 했다.
-- 가격대 필터가 위 l에서 이미 걸린 뒤라 살아남은 행에 대해서만 돈다. 게다가
-- 같은 단지·구간이면 결과가 같아 Postgres가 Memoize로 재사용한다.
cross join lateral (
  select min(s.pyeong_supply) as lo_py,
         max(s.pyeong_supply) as hi_py,
         sum(c.n)             as tier_deal_count_12m
    from apts s
    cross join lateral (
      select count(*) as n
        from transactions t
       where t.apt_id = s.id
         and t.contract_date >= current_date - interval '12 months'
    ) c
   where s.name = a.name and s.gu = a.gu and s.dong = a.dong
     and s.size_tier = a.size_tier
) g;


create or replace view apt_rent_prices as
select
  a.id, a.name, a.sido, a.gu, a.dong, a.address,
  a.area_sqm, a.pyeong, a.year_built, a.hh, a.lat, a.lng, a.created_at,
  l.avg_deposit,
  l.deal_count,
  l.latest_date,
  l.oldest_date,
  l1.latest_deposit,
  l1.latest_contract_date,
  case
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '1 month'  then 'fresh_high'
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '3 months' then 'fresh_mid'
    when l.deal_count >= 3                                                         then 'fresh_low'
    else                                                                                'scarce'
  end as freshness,
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m,
  -- ── 여기부터 이번에 추가되는 컬럼 ──
  a.pyeong_supply,
  a.size_tier,
  case when g.lo_py = g.hi_py then g.lo_py || '평'
       else g.lo_py || '~' || g.hi_py || '평' end as size_label,
  coalesce(g.tier_deal_count_12m, 0)::int         as tier_deal_count_12m
from apts a
cross join lateral (
  select round(avg(r.deposit_man) / 10000.0, 2) as avg_deposit,
         count(*)             as deal_count,
         max(r.contract_date) as latest_date,
         min(r.contract_date) as oldest_date
    from (select t.deposit_man, t.contract_date
            from rent_transactions t
           where t.apt_id = a.id
             and t.deal_type     = '전세'
             and t.contract_type = '신규'
             and t.contract_date >= current_date - interval '6 months'
           order by t.contract_date desc, t.id desc
           limit 3) r
) l
cross join lateral (
  select round(t.deposit_man::numeric / 10000.0, 2) as latest_deposit,
         t.contract_date                            as latest_contract_date
    from rent_transactions t
   where t.apt_id = a.id
     and t.deal_type     = '전세'
     and t.contract_type = '신규'
     and t.contract_date >= current_date - interval '6 months'
   order by t.contract_date desc, t.id desc
   limit 1
) l1
left join lateral (
  select count(*) as deal_count_12m
    from rent_transactions t
   where t.apt_id = a.id
     and t.deal_type     = '전세'
     and t.contract_type = '신규'
     and t.contract_date >= current_date - interval '12 months'
) y on true
cross join lateral (
  select min(s.pyeong_supply) as lo_py,
         max(s.pyeong_supply) as hi_py,
         sum(c.n)             as tier_deal_count_12m
    from apts s
    cross join lateral (
      select count(*) as n
        from rent_transactions t
       where t.apt_id = s.id
         and t.deal_type     = '전세'
         and t.contract_type = '신규'
         and t.contract_date >= current_date - interval '12 months'
    ) c
   where s.name = a.name and s.gu = a.gu and s.dong = a.dong
     and s.size_tier = a.size_tier
) g;

-- ─── 4. PostgREST 스키마 캐시 갱신 ──────────────────────────────────────────
-- 이걸 안 하면 새 컬럼을 select할 때 PostgREST가 "column does not exist"로 거절한다.
notify pgrst, 'reload schema';
