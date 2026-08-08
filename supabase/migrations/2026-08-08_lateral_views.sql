-- 조회 성능: apt_prices / apt_rent_prices 를 LATERAL 구조로 교체
--
-- 기존 구조는 CTE로 전국을 먼저 집계한 뒤 마지막에 gu를 걸러, 강남구 27곳을
-- 얻는 데 6,803ms가 걸렸다 (운영 explain analyze, 269,094행 정렬에만 4,471ms).
-- apts를 구동 테이블로 뒤집으면 gu 조건이 맨 먼저 걸린다.
--
-- 컬럼 이름·순서·타입은 그대로라 create or replace로 교체되고 앱 코드는 안 바뀐다.
-- 로컬 postgres에서 기존 정의와 전수 대조해 양방향 차집합 0을 확인했다.

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
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '1 month'  then 'fresh_high'  -- 진초록
    when l.deal_count >= 3 and l.oldest_date >= current_date - interval '3 months' then 'fresh_mid'   -- 연초록
    when l.deal_count >= 3                                                         then 'fresh_low'   -- 노랑
    else                                                                                'scarce'      -- 주황 (1~2건)
  end as freshness,
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m
from apts a
-- 최신 3건 집계
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
-- 가장 최근 1건의 상세. 0건이면 이 조인에서 행이 사라진다
-- (기존 `join latest1`과 같은 효과 — 6개월 내 거래 없는 단지는 뷰에 안 나온다).
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
-- 연간 거래량
left join lateral (
  select count(*) as deal_count_12m
    from transactions t
   where t.apt_id = a.id
     and t.contract_date >= current_date - interval '12 months'
) y on true;


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
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m
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
) y on true;

-- 뷰 정의가 바뀌었으므로 REST 계층의 스키마 캐시를 갱신한다.
notify pgrst, 'reload schema';
