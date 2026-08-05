-- 아파트 실거래가 저장소 스키마
--
-- 전체를 여러 번 실행해도 안전하도록 작성되어 있다 (idempotent).
-- 적재 스크립트(scripts/load_csv.py, scripts/load_rent_csv.py)의 ON CONFLICT 대상과
-- 웹앱(web/app/api/*)이 조회하는 뷰 컬럼이 여기 정의와 일치해야 한다.

-- ─── 단지 테이블 ────────────────────────────────────────────────────────────
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

-- ─── 매매 실거래 ────────────────────────────────────────────────────────────
create table if not exists transactions (
  id            bigserial primary key,
  apt_id        bigint references apts(id) on delete cascade,
  contract_date date not null,
  price_man     int not null,
  floor         int,
  deal_type     text,
  created_at    timestamptz default now()
);

-- ─── 전월세 실거래 ──────────────────────────────────────────────────────────
create table if not exists rent_transactions (
  id              bigserial primary key,
  apt_id          bigint references apts(id) on delete cascade,
  contract_date   date not null,
  deposit_man     int not null,          -- 보증금(만원)
  monthly_man     int not null default 0,-- 월세금(만원), 전세는 0
  deal_type       text not null,         -- 전세 | 월세
  contract_type   text,                  -- 신규 | 갱신
  floor           int,
  contract_period text,                  -- 예: '202610~202810'
  -- 운영 DB의 rent_transactions에는 created_at이 없다 (transactions와 다름).
  -- 적재 시각은 ingestion_runs가 갖고 있어 따로 필요하지 않다.

  -- load_rent_csv.py의 ON CONFLICT 대상.
  -- 제약 이름은 PostgreSQL이 자동 생성한다 (운영 DB:
  --  rent_transactions_apt_id_contract_date_deposit_man_monthly__key)
  unique (apt_id, contract_date, deposit_man, monthly_man, floor, deal_type)
);

-- ─── 중복 방지 유니크 인덱스 ────────────────────────────────────────────────
-- 수집 스크립트는 주 2회 최근 1년치를 통째로 다시 받아 재적재한다.
-- 이 인덱스가 있어야 load_csv.py의 ON CONFLICT ... DO NOTHING이 동작해
-- 중복 행이 쌓이지 않는다. 이름은 운영 DB와 동일하게 맞춰져 있다.
--
-- NULL 취급 참고: 기본값(nulls distinct)이라 floor가 NULL인 행끼리는 충돌하지 않아
-- 재적재마다 중복이 생길 수 있다. 다만 국토부 아파트 자료는 층이 항상 채워져 나오므로
-- (수집분 202,064행 전수 확인, NULL 0건) 실제 문제가 되지 않는다.
-- 층이 비는 물건유형(토지 등)으로 수집을 확장하면 nulls not distinct 전환을 검토할 것.
create unique index if not exists transactions_unique
  on transactions (apt_id, contract_date, price_man, floor);
-- rent_transactions의 유니크 제약은 위 create table 안에 정의되어 있다.

-- ─── 조회 인덱스 ────────────────────────────────────────────────────────────
create index if not exists idx_transactions_apt_id            on transactions(apt_id);
create index if not exists idx_transactions_contract_date     on transactions(contract_date desc);
create index if not exists idx_rent_transactions_apt_id       on rent_transactions(apt_id);
create index if not exists idx_rent_transactions_contract_date on rent_transactions(contract_date desc);
create index if not exists idx_apts_gu   on apts(gu);
create index if not exists idx_apts_dong on apts(dong);

-- ─── 수집·적재 이력 ─────────────────────────────────────────────────────────
-- 관리자 페이지(/admin)가 읽는 실행 기록. 지역·유형·단계별로 한 행씩 남는다.
-- 기록 실패가 파이프라인을 멈추면 안 되므로 스크립트 쪽에서 best-effort로 쓴다
-- (scripts/run_log.py 참고).
create table if not exists ingestion_runs (
  id          bigserial primary key,
  run_id      text not null,        -- GitHub Actions run id, 로컬 실행은 local-<타임스탬프>
  stage       text not null check (stage     in ('download', 'load')),
  deal_type   text not null check (deal_type in ('buy', 'rent')),
  region_key  text not null,        -- choongbuk, jeonbuktuk, ...
  status      text not null check (status    in ('success', 'failed')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  duration_ms int,
  attempts    int not null default 1,
  from_date   date,                 -- download: 수집 기간
  to_date     date,
  file_bytes  bigint,               -- download: 내려받은 CSV 크기
  rows_total  int,                  -- load: CSV의 유효 행수
  rows_new    int,                  -- load: 실제로 새로 들어간 행수 (중복 제외)
  error       text,
  run_url     text,                 -- Actions 실행 로그 링크
  created_at  timestamptz not null default now()
);

create index if not exists idx_ingestion_runs_lookup
  on ingestion_runs (deal_type, region_key, stage, finished_at desc);

-- 운영 로그는 공개 anon 키로 읽히면 안 된다. RLS를 켜고 정책을 두지 않으면
-- anon/authenticated 모두 차단되고, 서버의 service_role 키만 우회한다.
alter table ingestion_runs enable row level security;

-- ─── region_data_stats 뷰 ───────────────────────────────────────────────────
-- 관리자 페이지의 "데이터 자체가 신선한가" 쪽 지표.
-- 적재가 언제 돌았는지는 ingestion_runs가 갖고 있으므로 여기서는
-- 데이터 자체의 최신성(최신 계약일)과 규모만 본다.
create or replace view region_data_stats as
  select 'buy'::text as deal_type, a.sido,
         count(*)::bigint     as tx_count,
         max(t.contract_date) as latest_contract_date
    from transactions t
    join apts a on a.id = t.apt_id
   group by a.sido
  union all
  select 'rent'::text, a.sido,
         count(*)::bigint,
         max(r.contract_date)
    from rent_transactions r
    join apts a on a.id = r.apt_id
   group by a.sido;

-- ─── apt_prices 뷰 (매매) ───────────────────────────────────────────────────
-- 최근 6개월 내 최신 3건 평균 + 신선도. 금액 단위는 '억'(만원 / 10000).
--
-- 신선도 판정에 latest_date가 아니라 oldest_date(최신 3건 중 가장 오래된 건)를 쓴다.
-- "최근 거래가 있다"가 아니라 "최근 3건이 모두 그 기간 안에 몰려 있다"는 뜻이라
-- 거래가 꾸준한 단지만 fresh로 잡히는 더 엄격한 기준이다.
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
  end as freshness
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id;
-- 6개월 내 거래 0건인 단지는 join에서 자동 제외 → 추천에 안 나옴

-- ─── apt_rent_prices 뷰 (전월세) ────────────────────────────────────────────
-- 매매와 같은 규칙이되 기준 금액은 보증금(억).
-- 월세·갱신 계약은 rent_transactions에 저장은 하되 이 뷰에서는 제외한다.
-- (보증금 비교의 기준을 맞추기 위해 '전세' + '신규' 계약만 사용)
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
  end as freshness
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id;
