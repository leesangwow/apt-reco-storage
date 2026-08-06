-- deal_count_12m(연간 거래건수) 추가 마이그레이션
-- Supabase SQL 에디터에서 그대로 실행하면 된다. 컬럼을 select 맨 뒤에 붙였으므로
-- drop 없이 create or replace로 교체된다 (뷰 의존 객체·권한 유지).

create or replace view apt_prices as
with recent as (
  select
    apt_id,
    price_man,
    contract_date,
    floor,
    row_number() over (partition by apt_id order by contract_date desc) as rn
  from transactions
  where contract_date >= current_date - interval '6 months'
),
latest3 as (
  -- 최신 3건 집계
  select
    apt_id,
    round(avg(price_man) / 10000.0, 2) as avg_price,
    count(*)                           as deal_count,
    max(contract_date)                 as latest_date,
    min(contract_date)                 as oldest_date
  from recent
  where rn <= 3
  group by apt_id
),
latest1 as (
  -- 가장 최근 1건의 상세
  select
    apt_id,
    round(price_man::numeric / 10000.0, 2) as latest_price,
    floor                                  as latest_floor,
    contract_date                          as latest_contract_date
  from recent
  where rn = 1
),
yearly as (
  -- 연간 거래량. 위 recent가 rn <= 3으로 표본을 자르는 것과 달리 12개월치를 다 센다.
  --
  -- freshness는 "최근 3건이 얼마나 몰려 있나"만 재기 때문에 거래량 정보가 없다.
  -- 연 50건인 단지와 연 3건 딱 채운 단지가 똑같이 fresh_high로 나온다.
  -- 시세를 믿을 만한지 판단하려면 표본 크기 자체가 필요하다.
  --
  -- 신고 지연 주의: 계약 후 30일 이내 신고라 최근 한 달은 늘 덜 찬 상태로 잡힌다.
  -- 그래도 창을 뒤로 미루지 않는다. 모든 단지가 똑같이 영향받아 단지 간 비교는
  -- 왜곡되지 않고, 미루면 그만큼 최신성을 잃는다.
  select
    apt_id,
    count(*) as deal_count_12m
  from transactions
  where contract_date >= current_date - interval '12 months'
  group by apt_id
)
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
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '1 month'  then 'fresh_high'  -- 진초록
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '3 months' then 'fresh_mid'   -- 연초록
    when l.deal_count >= 3                                                         then 'fresh_low'   -- 노랑
    else                                                                                'scarce'      -- 주황 (1~2건)
  end as freshness,
  -- 새 컬럼은 반드시 맨 뒤에 붙인다. create or replace view는 기존 컬럼의
  -- 이름·순서를 바꾸지 못해서, 중간에 끼우면 운영 배포가 통째로 실패한다.
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id
-- 6개월 창이 12개월 안에 들어가므로 yearly는 항상 매칭된다. 그래도 left join으로
-- 두는 이유는 위 창을 나중에 넓혔을 때 단지가 통째로 사라지지 않게 하려는 것이다.
left join yearly y on y.apt_id = a.id;

create or replace view apt_rent_prices as
with recent as (
  select
    apt_id,
    deposit_man,
    contract_date,
    row_number() over (partition by apt_id order by contract_date desc) as rn
  from rent_transactions
  where deal_type      = '전세'
    and contract_type  = '신규'
    and contract_date >= current_date - interval '6 months'
),
latest3 as (
  select
    apt_id,
    round(avg(deposit_man) / 10000.0, 2) as avg_deposit,
    count(*)                             as deal_count,
    max(contract_date)                   as latest_date,
    min(contract_date)                   as oldest_date
  from recent
  where rn <= 3
  group by apt_id
),
latest1 as (
  select
    apt_id,
    round(deposit_man::numeric / 10000.0, 2) as latest_deposit,
    contract_date                            as latest_contract_date
  from recent
  where rn = 1
),
yearly as (
  -- 연간 거래량 (매매 쪽 yearly 주석 참고).
  -- 전세·신규만 세는 이유는 이 뷰의 보증금 기준과 표본을 맞추기 위해서다.
  -- 월세까지 합치면 "이 보증금 시세를 뒷받침하는 거래가 몇 건인가"가 아니게 된다.
  select
    apt_id,
    count(*) as deal_count_12m
  from rent_transactions
  where deal_type      = '전세'
    and contract_type  = '신규'
    and contract_date >= current_date - interval '12 months'
  group by apt_id
)
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
  -- 새 컬럼은 반드시 맨 뒤에 붙인다. create or replace view는 기존 컬럼의
  -- 이름·순서를 바꾸지 못해서, 중간에 끼우면 운영 배포가 통째로 실패한다.
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id
left join yearly y on y.apt_id = a.id;


-- Supabase의 REST 계층(PostgREST)은 스키마를 캐시한다. 위에서 뷰에 컬럼을 추가해도
-- 캐시가 갱신되기 전까지 API는 계속 "column apt_prices.deal_count_12m does not exist"로
-- 실패한다. 뷰만 바꾸고 이 줄을 빼먹으면 고친 것처럼 보이는데 화면은 그대로 빈다.
notify pgrst, 'reload schema';
