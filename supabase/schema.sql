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
  -- 통칭 평형. 사람들이 "34평"이라 부르는 그 숫자다.
  -- 국토부 자료의 area_sqm은 전용면적이라 그대로 나누면 84㎡가 25.4평으로 나온다.
  -- 통상 전용률(전용/공급) 0.75로 되돌려야 실제로 쓰는 평형이 된다.
  --   전용 84.97㎡ / (3.3058 * 0.75) = 34.3 → 34평
  pyeong_supply smallint generated always as (round(area_sqm / (3.3058 * 0.75))::smallint) stored,
  -- 평형 구간. 아래 "평형 구간" 주석 참고. 20평 이상은 4평, 미만은 2평 단위.
  size_tier smallint generated always as (
    case when round(area_sqm / (3.3058 * 0.75)) >= 20
         then ((round(area_sqm / (3.3058 * 0.75))::int / 4) * 4)::smallint
         else ((round(area_sqm / (3.3058 * 0.75))::int / 2) * 2)::smallint
    end
  ) stored,
  year_built int,
  hh         int,
  lat        numeric(10,7),
  lng        numeric(10,7),
  created_at timestamptz default now(),
  unique (name, gu, dong, area_sqm)
);

-- create table if not exists는 이미 있는 테이블에 컬럼을 더해주지 않는다.
-- 위 정의를 나중에 추가한 컬럼은 여기서 한 번 더 붙여야 기존 DB에도 반영된다.
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

-- apt_rent_prices의 LATERAL들이 전부 "이 단지의 전세·신규 계약을 최신순으로"를 묻는다.
-- 유니크 인덱스로는 apt_id·contract_date까지만 좁혀지고 deal_type·contract_type은 힙에서
-- 걸러야 해서, 월세·갱신까지 다 읽고 버리게 된다. 조건을 인덱스에 박아 그 낭비를 없앤다.
-- (운영과 같은 규모로 만든 데이터에서 전월세 조회 390ms → 33ms)
create index if not exists idx_rent_tx_jeonse
  on rent_transactions (apt_id, contract_date desc, id desc) include (deposit_man)
  where deal_type = '전세' and contract_type = '신규';

-- 평형 구간 조회용. 뷰가 행마다 "같은 단지·같은 구간의 다른 면적들"을 찾는 데 쓴다.
-- include로 pyeong_supply·id를 얹어 힙까지 안 가고 인덱스만 읽고 끝낸다.
create index if not exists idx_apts_complex_tier
  on apts (name, gu, dong, size_tier) include (pyeong_supply, id);

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

-- ─── 왜 LATERAL인가 ─────────────────────────────────────────────────────────
-- 예전에는 CTE(recent/latest3/yearly)로 apt_id별 집계를 먼저 만들고 마지막에
-- apts를 조인했다. 그러면 gu·sido 조건이 CTE 안으로 못 내려간다. CTE가 두 번
-- 참조돼 Postgres가 materialize하는 것도 겹쳤다.
--
-- 그 결과 강남구 27곳을 얻는 데 전국을 다 계산했다 (운영 explain analyze):
--   recent WindowAgg  269,094행  4,471ms
--   연간 집계         539,728행    994ms
--   가격 필터 후       1,363행
--   gu 필터 후            27행   ← 여기서 99%를 버린다
--   Execution Time: 6,803ms
--
-- apts를 구동 테이블로 두고 LATERAL로 뒤집으면 gu 조건이 맨 먼저 걸리고,
-- 살아남은 단지에 대해서만 transactions_unique 인덱스로 최근 몇 건을 집어온다.
-- 269,094행 정렬이 통째로 사라진다.
--
-- 정렬에 `, t.id desc` 동률 처리를 넣었다. 예전 row_number()는 같은 계약일이
-- 여러 건이면 임의로 골라서 실행할 때마다 값이 달라질 수 있었다.

-- ─── 평형 구간 (size_tier) ──────────────────────────────────────────────────
-- apts의 키가 (단지명, 구, 동, 전용면적)이라 같은 평형이 84.28·84.74·84.97처럼
-- 여러 행으로 쪼개진다. 운영 데이터에서 해밀마을1단지 34평은 14개 행, 자연앤힐스테이트는
-- 13개 행이었다. 그만큼 거래량이 나뉘어 어느 행을 봐도 그 평형의 진짜 거래량이 안 보인다.
--
-- 묶는 규칙: 통칭 평형(pyeong_supply)을 20평 이상은 4평, 미만은 2평 단위로 자른다.
--   32~35평 = 전용 78.1~88.0㎡  ← 국민평형(84㎡)이 통째로 들어온다
--   size_tier가 구간 식별자이자 구간의 시작 평이다.
--   20평 경계에서 값이 겹치지 않는다 (19평 → 18, 20평 → 20).
--
-- 왜 고정 구간인가: 처음엔 "이웃 면적과 간격이 벌어지면 끊기"를 검토했으나 운영
-- 데이터에서 연쇄가 폭주했다. 해운대 아이파크는 45개 면적이 80.57~139.44㎡에 평균
-- 1.34㎡ 간격으로 깔려 있어 전부 한 덩어리가 됐다. 고정 구간은 그 폭주가 원천적으로 없다.
--
-- 왜 경계를 ㎡가 아니라 평으로 잡았나: ㎡ 어림수(80·92)로 자르면 32평(78.1~80.6㎡)처럼
-- 한 평이 두 구간에 걸쳐, 79.99와 80.00이 다른 구간으로 간다. 평 단위면 걸침이 없다.
--
-- 20평 미만을 2평으로 좁힌 이유: 4평 구간을 그대로 내리면 4~7평이 전용 9.9~19.8㎡로
-- 폭이 100%가 된다. 실제로 센트럴S타운은 30개 면적이 12.07~16.43㎡에 있어 한 덩어리가 된다.
--
-- ⚠ 평당가에는 이 구간을 쓰면 안 된다. 32~35평 구간은 전용 78.1~88.0㎡로 12.7% 벌어져
--   있어, 구간 평균가를 구간 대표 평형으로 나누면 값이 왜곡된다. 평당가는 행별 area_sqm으로.
--
-- 뷰는 행 구조를 그대로 둔다 (면적당 한 행). 구간 정보를 컬럼으로 얹기만 하고,
-- 실제로 묶어서 보여줄지는 앱이 정한다. 통계·평형별 분석은 종전대로 area_sqm을 쓰면 된다.

-- ─── apt_prices 뷰 (매매) ───────────────────────────────────────────────────
-- 최근 6개월 내 최신 3건 평균 + 신선도. 금액 단위는 '억'(만원 / 10000).
--
-- 신선도 판정에 latest_date가 아니라 oldest_date(최신 3건 중 가장 오래된 건)를 쓴다.
-- "최근 거래가 있다"가 아니라 "최근 3건이 모두 그 기간 안에 몰려 있다"는 뜻이라
-- 거래가 꾸준한 단지만 fresh로 잡히는 더 엄격한 기준이다.
-- LATERAL 재작성판. 컬럼 이름·순서·타입은 기존과 동일해야 한다
-- (create or replace view는 기존 컬럼을 바꾸지 못하고, 앱이 그대로 읽는다).

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
-- 6개월 내 거래 0건인 단지는 위 latest1 LATERAL에서 행이 사라진다 → 추천에 안 나옴

-- ─── apt_rent_prices 뷰 (전월세) ────────────────────────────────────────────
-- 매매와 같은 규칙이되 기준 금액은 보증금(억).
-- 월세·갱신 계약은 rent_transactions에 저장은 하되 이 뷰에서는 제외한다.
-- (보증금 비교의 기준을 맞추기 위해 '전세' + '신규' 계약만 사용)
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


-- ─── 조회용 매터리얼라이즈드 뷰 ─────────────────────────────────────────────
-- 위 두 뷰는 조회할 때마다 단지 하나하나에 대해 최근 3건 평균, 최신 1건, 연간
-- 거래량, 구간 거래량을 다시 계산한다. 그런데 그 값들은 "누가 무엇을 검색하느냐"와
-- 무관하다 — 자연앤힐스테이트 34평의 평균가는 언제 물어도 같은 값이다.
-- 데이터는 주 2회 적재 때만 바뀌므로, 그때 한 번 계산해 두고 조회는 읽기만 한다.
--
-- 이게 없으면 정렬을 DB에 맡길 수 없다. order by를 붙이는 순간 조기 종료가
-- 불가능해져 조건에 맞는 단지를 전부 계산해야 한다. 그래서 예전에는 정렬 없이
-- limit 500으로 잘랐고, 그 결과 "어떤 500곳인지" 정해지지 않았다. 후보가 500을
-- 넘는 구간(운영 실측: 수도권 6.5억 ±10%에서 3,698곳)에서는 화면의 1위가 진짜
-- 1위가 아닐 수 있었다.
--
-- 운영과 같은 규모(단지 32만, 뷰 274,273행)에서 서로 다른 조건 12개를 각각 한 번씩:
--   일반 뷰   9 ~ 2,422ms   (넓은 범위 + 정렬에서 2초대)
--   matview   0.3 ~ 34ms
-- 캐시가 아니라 계산 결과 자체를 들고 있는 것이라, 처음 하는 검색도 빠르다.
--
-- ⚠ 뷰 안의 current_date가 refresh 시점으로 굳는다. 주 2회 갱신이면 "6개월 내"
--   판정이 최대 3~4일 밀린다. 배치로 갱신되는 데이터라 실용상 문제는 없지만,
--   매 조회마다 그날 기준으로 계산되던 것과는 다르다.
--
-- 적재가 끝나면 scripts/refresh_views.py가 concurrently로 갱신한다.
-- concurrently는 갱신 중에도 앱 조회를 막지 않는 대신 유니크 인덱스를 요구한다.
create materialized view if not exists apt_prices_mv      as select * from apt_prices;
create materialized view if not exists apt_rent_prices_mv as select * from apt_rent_prices;

-- id 유니크 인덱스는 refresh concurrently의 전제 조건이다 (없으면 거부당한다).
create unique index if not exists apt_prices_mv_id      on apt_prices_mv (id);
create unique index if not exists apt_rent_prices_mv_id on apt_rent_prices_mv (id);

-- 앱이 거는 조건 그대로. 범위(시도 / 시도+구 / 시도+구+동)를 좁힌 뒤 가격대로 자른다.
-- 정렬 키(준공·평형·거래량)는 따로 인덱스를 두지 않았다 — 범위로 좁히고 나면
-- 남는 행이 적어 top-N 정렬이 몇 ms로 끝난다.
create index if not exists apt_prices_mv_sido_price
  on apt_prices_mv (sido, avg_price);
create index if not exists apt_prices_mv_region_price
  on apt_prices_mv (sido, gu, dong, avg_price);
create index if not exists apt_rent_prices_mv_sido_price
  on apt_rent_prices_mv (sido, avg_deposit);
create index if not exists apt_rent_prices_mv_region_price
  on apt_rent_prices_mv (sido, gu, dong, avg_deposit);

-- "같은 단지의 다른 평형"은 이름·구·동으로만 찾는다 (가격대와 무관하게 받아야 해서).
create index if not exists apt_prices_mv_complex
  on apt_prices_mv (name, gu, dong);
create index if not exists apt_rent_prices_mv_complex
  on apt_rent_prices_mv (name, gu, dong);

-- 단지명 검색(/api/search)은 ilike '%…%'라 일반 btree가 못 탄다.
-- trigram 인덱스는 앞뒤가 다 열린 부분 일치도 인덱스로 처리한다.
create extension if not exists pg_trgm;
create index if not exists apt_prices_mv_name_trgm
  on apt_prices_mv using gin (name gin_trgm_ops);

-- ─── 접근 권한 (RLS · grant) ────────────────────────────────────────────────
-- Supabase는 public 스키마의 테이블을 PostgREST로 자동 공개하고 anon·authenticated에
-- 기본으로 전 권한을 준다. anon 키는 브라우저 번들에 그대로 실려 나가므로, RLS를
-- 켜지 않으면 화면을 연 사람이면 누구나 rest/v1로 삭제·수정까지 할 수 있다.
-- (2026-08 Supabase 보안 경고 rls_disabled_in_public. supabase/migrations/2026-08-18_rls.sql)
--
-- 정책은 두지 않는다 — 정책이 없으면 anon·authenticated는 전부 차단된다.
-- 앱은 이 테이블들을 직접 읽지 않고(조회는 아래 matview, 관리자 화면은 service_role),
-- 적재 스크립트는 postgres 역할로 직접 접속한다. 테이블 소유자는 RLS 대상이 아니므로
-- 적재도 matview 갱신도 그대로 돈다.
alter table apts              enable row level security;
alter table transactions      enable row level security;
alter table rent_transactions enable row level security;
-- ingestion_runs는 위쪽 정의 옆에서 이미 켠다.

-- 뷰는 소유자 권한으로 실행되어 RLS로 막히지 않고, matview는 RLS 자체가 없다.
-- 그래서 뷰 쪽은 grant로 정리한다.
-- apt_prices / apt_rent_prices는 앱이 쓰지 않는다(앱은 _mv만 읽는다). 열어 두면
-- 조회 한 번에 전국 집계를 다시 도는 질의를 아무나 반복해 때릴 수 있다.
revoke all on apt_prices        from anon, authenticated;
revoke all on apt_rent_prices   from anon, authenticated;
revoke all on region_data_stats from anon, authenticated;  -- 관리자 전용, service_role로만 읽는다

-- matview 두 개만 anon에게 읽기로 열어 둔다.
revoke all on apt_prices_mv      from anon, authenticated;
revoke all on apt_rent_prices_mv from anon, authenticated;
grant select on apt_prices_mv      to anon, authenticated;
grant select on apt_rent_prices_mv to anon, authenticated;
