-- 단지 테이블
create table if not exists apts (
  id         bigserial primary key,
  name       text not null,
  sido       text not null,
  gu         text not null,
  dong       text not null,
  address    text,
  area_sqm   numeric(6,2) not null,
  pyeong     numeric(5,1) generated always as (round(area_sqm / 3.3058, 1)) stored,
  year_built int,
  hh         int,
  lat        numeric(10,7),
  lng        numeric(10,7),
  created_at timestamptz default now(),
  unique (name, gu, dong, area_sqm)
);

-- 실거래 내역 테이블
create table if not exists transactions (
  id            bigserial primary key,
  apt_id        bigint references apts(id) on delete cascade,
  contract_date date not null,
  price_man     int not null,
  floor         int,
  deal_type     text,
  created_at    timestamptz default now()
);

create index if not exists idx_transactions_apt_id on transactions(apt_id);
create index if not exists idx_transactions_contract_date on transactions(contract_date desc);
create index if not exists idx_apts_gu on apts(gu);
create index if not exists idx_apts_dong on apts(dong);

-- apt_prices 뷰: 최근 6개월 내 최신 3건 평균 + 신선도
create or replace view apt_prices as
with recent as (
  -- 최근 6개월 거래만
  select
    apt_id,
    price_man,
    contract_date,
    row_number() over (partition by apt_id order by contract_date desc) as rn
  from transactions
  where contract_date >= current_date - interval '6 months'
),
latest3 as (
  -- 그 중 최신 3건
  select
    apt_id,
    round(avg(price_man) / 10000.0, 2)  as avg_price,
    count(*)                              as deal_count,
    max(contract_date)                    as latest_date
  from recent
  where rn <= 3
  group by apt_id
)
select
  a.*,
  l.avg_price,
  l.deal_count,
  l.latest_date,
  -- 신선도: 건수 + 최신 거래일 조합
  case
    when l.deal_count >= 3 and l.latest_date >= current_date - interval '1 month'  then 'fresh_high'   -- 진초록
    when l.deal_count >= 3 and l.latest_date >= current_date - interval '3 months' then 'fresh_mid'    -- 연초록
    when l.deal_count >= 3                                                          then 'fresh_low'    -- 노랑
    else                                                                                 'scarce'       -- 주황 (1~2건)
  end as freshness
from apts a
join latest3 l on l.apt_id = a.id;
-- 6개월 내 거래 0건인 단지는 join에서 자동 제외 → 추천에 안 나옴
