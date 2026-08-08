-- 평형 구간 라벨(size_label) 규칙 보정
--
-- 문제: 실제로는 한 평형인데 라벨이 범위로 나온다.
--   고산더라피니엘(의정부 산곡동)  전용 55.52~55.99㎡  →  "22~23평"
-- 면적 차이가 0.85%뿐인데, 통칭 평 환산값이 22.39평과 22.58평이라 반올림 경계
-- (22.5)를 걸쳐 두 평형처럼 보인다. 운영 데이터에서 범위 라벨 6,147개 중
-- 1,331개(22%)가 이 경우였다.
--
-- 고침: 구간 안 면적이 3% 미만으로만 벌어졌으면 가운데 면적의 평 하나로 적는다.
--   고산더라피니엘  55.52~55.99  (0.9%)  →  22~23평  →  22평
--   더블유          141.08~144.74 (2.6%)  →  57~59평  →  58평
--   해운대 I PARK   108.11~117.75 (8.9%)  →  44~47평  →  그대로 (진짜 여러 평형)
--
-- 3%를 고른 이유: 34평(84㎡)에서 3%는 2.5㎡, 약 0.76평이다. 그 안에 든 면적들은
-- 84A·84B처럼 같은 평형의 타입 차이로 보는 게 맞다.
--
-- 뷰의 컬럼은 이름·순서·타입 모두 그대로다 (size_label의 계산식만 바뀐다).
-- 앱은 size_label을 그대로 그리므로 배포 없이 이 SQL만으로 화면이 바뀐다.
--
-- Supabase SQL Editor에 통째로 붙여넣고 한 번 실행하면 된다. 여러 번 돌려도 안전하다.

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
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m,
  -- ── 평형 구간 (위 주석 참고). 새 컬럼은 반드시 맨 뒤에 붙인다 —
  --    create or replace view는 기존 컬럼의 이름·순서를 바꾸지 못한다 ──
  a.pyeong_supply,
  a.size_tier,
  -- 라벨은 그 단지·구간에 실제로 있는 평형에서 뽑는다. 구간 이름(32~35평)을 그대로 쓰면
  -- 34평만 있는 단지도 32~35평으로 보여 실제보다 넓게 느껴진다.
  case
    when g.lo_py = g.hi_py then g.lo_py || '평'
    -- 면적이 3% 미만으로만 벌어졌으면 실제로는 한 평형이고, 통칭 평 환산값이
    -- 반올림 경계를 걸쳤을 뿐이다. 고산더라피니엘 55.52~55.99㎡가 22.39·22.58평으로
    -- 갈려 "22~23평"이 되는 식으로, 운영 데이터의 범위 라벨 6,147개 중 1,331개가
    -- 이 경우였다. 이때는 가운데 면적의 평 하나로 적는다.
    when g.hi_area < g.lo_area * 1.03
      then round((g.lo_area + g.hi_area) / 2 / (3.3058 * 0.75))::int || '평'
    else g.lo_py || '~' || g.hi_py || '평'
  end as size_label,
  coalesce(g.tier_deal_count_12m, 0)::int         as tier_deal_count_12m
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
) y on true
-- 같은 단지·같은 구간의 다른 면적들을 모아 라벨과 구간 거래량을 만든다.
-- 라벨과 거래량을 한 LATERAL에 합쳐 apts 인덱스를 두 번 타지 않게 했다.
-- 가격대 필터가 위 l에서 이미 걸린 뒤라 살아남은 행에 대해서만 돈다. 게다가
-- 같은 단지·구간이면 결과가 같아 Postgres가 Memoize로 재사용한다
-- (운영과 같은 규모로 만든 데이터에서 1,050행 → 실제 조회 268회).
cross join lateral (
  select min(s.pyeong_supply) as lo_py,
         max(s.pyeong_supply) as hi_py,
         min(s.area_sqm)      as lo_area,
         max(s.area_sqm)      as hi_area,
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
  -- 평형 구간. 매매 뷰와 같은 규칙, 거래량만 전세·신규 기준이다.
  a.pyeong_supply,
  a.size_tier,
  case
    when g.lo_py = g.hi_py then g.lo_py || '평'
    -- 면적이 3% 미만으로만 벌어졌으면 실제로는 한 평형이고, 통칭 평 환산값이
    -- 반올림 경계를 걸쳤을 뿐이다. 고산더라피니엘 55.52~55.99㎡가 22.39·22.58평으로
    -- 갈려 "22~23평"이 되는 식으로, 운영 데이터의 범위 라벨 6,147개 중 1,331개가
    -- 이 경우였다. 이때는 가운데 면적의 평 하나로 적는다.
    when g.hi_area < g.lo_area * 1.03
      then round((g.lo_area + g.hi_area) / 2 / (3.3058 * 0.75))::int || '평'
    else g.lo_py || '~' || g.hi_py || '평'
  end as size_label,
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
         min(s.area_sqm)      as lo_area,
         max(s.area_sqm)      as hi_area,
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

-- 컬럼 구성이 안 바뀌었으니 꼭 필요하진 않지만, 확실히 하기 위해 갱신한다.
notify pgrst, 'reload schema';
