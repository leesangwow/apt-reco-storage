-- 조회용 매터리얼라이즈드 뷰 도입
--
-- 문제: 뷰가 조회할 때마다 단지 하나하나의 집계를 다시 계산한다. 그래서 order by를
-- 붙이면 조기 종료가 안 돼 조건에 맞는 곳을 전부 계산해야 한다. 그 비용 때문에
-- 지금까지는 정렬 없이 limit 500으로 잘랐고, 결과적으로 "어느 500곳인지"가
-- 정해져 있지 않았다. 후보가 500을 넘는 구간에서는 화면의 1위가 진짜 1위가 아니었다.
--
-- 운영 실측 — 기준가별 후보 수 (수도권 ±10%):
--   6.5억  3,698곳     5.5억  3,528곳     4.0억  3,007곳
-- 사용자가 가장 많은 5~8억대가 전부 상한의 6~7배였다.
--
-- 같은 규모 데이터에서 넓은 범위 + 정렬 + limit:
--   일반 뷰   2,821ms      matview   0.7ms
--
-- 이 값들은 "누가 무엇을 검색하느냐"와 무관하다. 데이터는 주 2회 적재 때만 바뀌므로
-- 그때 한 번 계산해 두고 조회는 읽기만 한다. 캐시가 아니라 계산 결과 자체를 들고
-- 있는 것이라, 한 번도 안 해본 검색도 처음부터 빠르다.
--
-- ⚠ 실행 시간: 처음 만들 때 27만 행을 계산하므로 1~2분 걸릴 수 있다.
--   Supabase SQL Editor가 중간에 끊기면 아래를 나눠서 실행할 것.
--
-- ⚠ 순서 주의: 이 SQL을 먼저 적용한 뒤에 앱을 배포해야 한다.
--   앱이 먼저 나가면 PostgREST가 없는 테이블을 거절해 화면이 빈다.
--
-- ⚠ 적재 후 반드시 갱신해야 한다. scripts/refresh_views.py가 워크플로 마지막 단계로
--   들어가 있다. 갱신하지 않으면 DB에는 들어갔는데 화면에는 안 나온다.
--
-- ⚠ 뷰 안의 current_date가 refresh 시점으로 굳는다. 주 2회 갱신이면 "6개월 내"
--   판정이 최대 3~4일 밀린다.

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

-- 통계가 있어야 인덱스를 제대로 탄다.
analyze apt_prices_mv;
analyze apt_rent_prices_mv;

-- PostgREST가 새 테이블을 알아보게 한다. 이게 없으면 앱이 404를 받는다.
notify pgrst, 'reload schema';
