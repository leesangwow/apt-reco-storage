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


-- ─── 평형 구간 (size_tier) ──────────────────────────────────────────────────
-- apts의 키가 (단지명, 구, 동, 전용면적)이라 같은 평형이 84.28·84.74·84.97처럼
-- 여러 행으로 쪼개진다. 운영 데이터에서 해밀마을1단지 34평은 14개 행, 자연앤힐스테이트는
-- 13개 행이었다. 그만큼 거래량·신선도가 나뉘어 어느 행을 봐도 그 평형의 진짜 수치가
-- 안 보이고, 6개월 3건을 못 채워 뷰에서 아예 빠지는 행도 생긴다.
--
-- 묶는 규칙: 전용면적을 통칭 평형으로 바꾼 뒤 20평 이상은 4평, 미만은 2평 단위로 자른다.
--   통칭평 = round(전용면적 / (3.3058 * 0.75))     0.75는 통상 전용률(전용/공급)
--   32~35평 = 전용 78.10~88.01㎡  ← 국민평형(84㎡)이 통째로 들어온다
--
-- 왜 고정 구간인가: 처음엔 "이웃 면적과 간격이 벌어지면 끊기"를 검토했으나 운영
-- 데이터에서 연쇄가 폭주했다. 해운대 아이파크는 45개 면적이 80.57~139.44㎡에 평균
-- 1.34㎡ 간격으로 깔려 있어 전부 한 덩어리가 됐다. 고정 구간은 그 폭주가 원천적으로 없다.
--
-- 왜 경계를 ㎡가 아니라 평으로 잡았나: ㎡ 어림수(80·92)로 자르면 32평(78.10~80.57㎡)처럼
-- 한 평이 두 구간에 걸쳐, 79.99와 80.00이 다른 구간으로 간다. 평 단위면 걸침이 없다.
--
-- 20평 미만을 2평으로 좁힌 이유: 4평 구간을 그대로 내리면 4~7평이 전용 8.68~18.59㎡로
-- 폭 114%가 된다. 실제로 센트럴S타운은 30개 면적이 12.07~16.43㎡에 있어 한 덩어리가 된다.
--
-- tier_min이 구간 식별자이자 구간의 시작 평이다. 20평 경계에서 값이 겹치지 않는다
-- (19평 → 18, 20평 → 20).
--
-- ⚠ 평당가를 구할 때 이 구간을 쓰면 안 된다. 32~35평 구간은 전용 78.10~88.01㎡로
--   12.7% 벌어져 있어, 구간 평균가를 구간 대표 평형으로 나누면 값이 왜곡된다.
--   평당가는 반드시 행별 area_sqm으로 계산할 것.

-- ─── apt_prices 뷰 (매매) ───────────────────────────────────────────────────
-- 최근 6개월 내 최신 3건 평균 + 신선도. 금액 단위는 '억'(만원 / 10000).
--
-- 신선도 판정에 latest_date가 아니라 oldest_date(최신 3건 중 가장 오래된 건)를 쓴다.
-- "최근 거래가 있다"가 아니라 "최근 3건이 모두 그 기간 안에 몰려 있다"는 뜻이라
-- 거래가 꾸준한 단지만 fresh로 잡히는 더 엄격한 기준이다.
create or replace view apt_prices as
with tier_map as (
  select a.id as apt_id, a.name, a.gu, a.dong, x.p,
         case when x.p >= 20 then (x.p / 4) * 4 else (x.p / 2) * 2 end as tier_min
    from apts a,
         lateral (select round(a.area_sqm / (3.3058 * 0.75))::int as p) x
),
tier_info as (
  -- 라벨은 그 단지·구간에 실제로 있는 면적에서 뽑는다. 구간 이름(32~35평)을 그대로 쓰면
  -- 34평만 있는 단지도 32~35평으로 보여 실제보다 넓게 느껴진다.
  --
  -- group_id는 아래 집계들이 쓰는 숫자 그룹 키다. (name, gu, dong, tier_min) 네 컬럼으로
  -- 직접 파티션하면 텍스트 3개를 정렬해야 해서 윈도 함수가 3.7배 느려진다 (10만 단지
  -- 기준 11.5초 → 42.3초). apt_id는 정수라 정렬이 훨씬 싸다.
  select name, gu, dong, tier_min,
         min(apt_id) as group_id,
         min(p) as lo_py, max(p) as hi_py
    from tier_map
   group by name, gu, dong, tier_min
),
tier_key as (
  select m.apt_id, i.group_id
    from tier_map m
    join tier_info i
      on i.name = m.name and i.gu = m.gu and i.dong = m.dong and i.tier_min = m.tier_min
),
recent as (
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
),
tier_recent as (
  -- 구간 전체의 최근 거래. 위 recent와 규칙은 같고 파티션만 구간이다.
  select k.group_id, t.price_man, t.contract_date,
         row_number() over (partition by k.group_id
                            order by t.contract_date desc) as rn
    from transactions t
    join tier_key k on k.apt_id = t.apt_id
   where t.contract_date >= current_date - interval '6 months'
),
tier_latest3 as (
  select group_id,
         round(avg(price_man) / 10000.0, 2) as tier_avg,
         count(*)           as tier_deal_count,
         min(contract_date) as tier_oldest
    from tier_recent
   where rn <= 3
   group by group_id
),
tier_yearly as (
  select k.group_id, count(*) as tier_deal_count_12m
    from transactions t
    join tier_key k on k.apt_id = t.apt_id
   where t.contract_date >= current_date - interval '12 months'
   group by k.group_id
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
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m,
  -- ── 평형 구간 (위 주석 참고). 행 구조는 그대로 두고 구간 정보를 얹기만 한다 ──
  tm.tier_min                                       as size_tier,
  case when ti.lo_py = ti.hi_py then ti.lo_py || '평'
       else ti.lo_py || '~' || ti.hi_py || '평' end as size_label,
  coalesce(ty.tier_deal_count_12m, 0)::int          as tier_deal_count_12m,
  tl.tier_avg                                       as tier_avg_price,
  case
    when tl.tier_deal_count >= 3 and tl.tier_oldest >= current_date - interval '1 month'  then 'fresh_high'
    when tl.tier_deal_count >= 3 and tl.tier_oldest >= current_date - interval '3 months' then 'fresh_mid'
    when tl.tier_deal_count >= 3                                                          then 'fresh_low'
    else                                                                                       'scarce'
  end                                               as tier_freshness
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id
-- 6개월 창이 12개월 안에 들어가므로 yearly는 항상 매칭된다. 그래도 left join으로
-- 두는 이유는 위 창을 나중에 넓혔을 때 단지가 통째로 사라지지 않게 하려는 것이다.
left join yearly y on y.apt_id = a.id
join tier_map  tm on tm.apt_id = a.id
join tier_info ti on (ti.name, ti.gu, ti.dong, ti.tier_min) = (tm.name, tm.gu, tm.dong, tm.tier_min)
left join tier_latest3 tl on tl.group_id = ti.group_id
left join tier_yearly  ty on ty.group_id = ti.group_id
;
-- 6개월 내 거래 0건인 단지는 join에서 자동 제외 → 추천에 안 나옴

-- ─── apt_rent_prices 뷰 (전월세) ────────────────────────────────────────────
-- 매매와 같은 규칙이되 기준 금액은 보증금(억).
-- 월세·갱신 계약은 rent_transactions에 저장은 하되 이 뷰에서는 제외한다.
-- (보증금 비교의 기준을 맞추기 위해 '전세' + '신규' 계약만 사용)
create or replace view apt_rent_prices as
with tier_map as (
  select a.id as apt_id, a.name, a.gu, a.dong, x.p,
         case when x.p >= 20 then (x.p / 4) * 4 else (x.p / 2) * 2 end as tier_min
    from apts a,
         lateral (select round(a.area_sqm / (3.3058 * 0.75))::int as p) x
),
tier_info as (
  -- 라벨은 그 단지·구간에 실제로 있는 면적에서 뽑는다. 구간 이름(32~35평)을 그대로 쓰면
  -- 34평만 있는 단지도 32~35평으로 보여 실제보다 넓게 느껴진다.
  --
  -- group_id는 아래 집계들이 쓰는 숫자 그룹 키다. (name, gu, dong, tier_min) 네 컬럼으로
  -- 직접 파티션하면 텍스트 3개를 정렬해야 해서 윈도 함수가 3.7배 느려진다 (10만 단지
  -- 기준 11.5초 → 42.3초). apt_id는 정수라 정렬이 훨씬 싸다.
  select name, gu, dong, tier_min,
         min(apt_id) as group_id,
         min(p) as lo_py, max(p) as hi_py
    from tier_map
   group by name, gu, dong, tier_min
),
tier_key as (
  select m.apt_id, i.group_id
    from tier_map m
    join tier_info i
      on i.name = m.name and i.gu = m.gu and i.dong = m.dong and i.tier_min = m.tier_min
),
recent as (
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
),
tier_recent as (
  -- 구간 전체의 최근 거래. 위 recent와 규칙은 같고 파티션만 구간이다.
  select k.group_id, t.deposit_man, t.contract_date,
         row_number() over (partition by k.group_id
                            order by t.contract_date desc) as rn
    from rent_transactions t
    join tier_key k on k.apt_id = t.apt_id
   where t.contract_date >= current_date - interval '6 months'
     and t.deal_type = '전세'
     and t.contract_type = '신규'
),
tier_latest3 as (
  select group_id,
         round(avg(deposit_man) / 10000.0, 2) as tier_avg,
         count(*)           as tier_deal_count,
         min(contract_date) as tier_oldest
    from tier_recent
   where rn <= 3
   group by group_id
),
tier_yearly as (
  select k.group_id, count(*) as tier_deal_count_12m
    from rent_transactions t
    join tier_key k on k.apt_id = t.apt_id
   where t.contract_date >= current_date - interval '12 months'
     and t.deal_type = '전세'
     and t.contract_type = '신규'
   group by k.group_id
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
  coalesce(y.deal_count_12m, 0)::int as deal_count_12m,
  -- ── 평형 구간 (위 주석 참고). 행 구조는 그대로 두고 구간 정보를 얹기만 한다 ──
  tm.tier_min                                       as size_tier,
  case when ti.lo_py = ti.hi_py then ti.lo_py || '평'
       else ti.lo_py || '~' || ti.hi_py || '평' end as size_label,
  coalesce(ty.tier_deal_count_12m, 0)::int          as tier_deal_count_12m,
  tl.tier_avg                                       as tier_avg_price,
  case
    when tl.tier_deal_count >= 3 and tl.tier_oldest >= current_date - interval '1 month'  then 'fresh_high'
    when tl.tier_deal_count >= 3 and tl.tier_oldest >= current_date - interval '3 months' then 'fresh_mid'
    when tl.tier_deal_count >= 3                                                          then 'fresh_low'
    else                                                                                       'scarce'
  end                                               as tier_freshness
from apts a
join latest3 l  on l.apt_id  = a.id
join latest1 l1 on l1.apt_id = a.id
left join yearly y on y.apt_id = a.id
join tier_map  tm on tm.apt_id = a.id
join tier_info ti on (ti.name, ti.gu, ti.dong, ti.tier_min) = (tm.name, tm.gu, tm.dong, tm.tier_min)
left join tier_latest3 tl on tl.group_id = ti.group_id
left join tier_yearly  ty on ty.group_id = ti.group_id
;
