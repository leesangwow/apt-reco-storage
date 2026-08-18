-- 공개 테이블 RLS 활성화 — Supabase 보안 경고(rls_disabled_in_public) 대응
--
-- ─── 무엇이 문제였나 ────────────────────────────────────────────────────────
-- Supabase는 public 스키마의 테이블을 PostgREST로 자동 공개하고, anon·authenticated
-- 역할에 기본으로 전 권한(select/insert/update/delete)을 준다. 그 권한을 실제로
-- 막아 주는 건 RLS 하나뿐인데 apts·transactions·rent_transactions에는 켜져 있지
-- 않았다. ingestion_runs만 처음부터 켜 둔 상태였다.
--
-- anon 키는 NEXT_PUBLIC_SUPABASE_ANON_KEY로 브라우저 번들에 그대로 실려 나간다.
-- 즉 화면을 한 번 연 사람이면 누구나 프로젝트 URL과 키를 손에 넣고
--   curl -X DELETE 'https://<ref>.supabase.co/rest/v1/transactions?id=gt.0' ...
-- 로 20만 행짜리 실거래 테이블을 지울 수 있었다. 데이터 자체는 국토부 공개 자료라
-- 읽히는 것은 문제가 아니지만, 쓰기·삭제가 열려 있는 것은 별개의 이야기다.
--
-- ─── 왜 정책(policy)을 하나도 만들지 않나 ───────────────────────────────────
-- RLS를 켜고 정책이 없으면 anon·authenticated는 전부 차단된다. 이 프로젝트는
-- 그래도 아무것도 깨지지 않는다. 세 경로 모두 이 테이블들을 PostgREST로
-- 직접 읽지 않기 때문이다:
--   * 웹앱 조회  — apt_prices_mv / apt_rent_prices_mv (매터리얼라이즈드 뷰)
--   * 관리자 화면 — ingestion_runs / region_data_stats, service_role 키 (RLS 우회)
--   * 적재·갱신  — scripts/*.py, Postgres에 postgres 역할로 직접 접속.
--                 테이블 소유자는 RLS 대상이 아니다 (force row level security를
--                 걸지 않는 한). matview의 refresh concurrently도 같은 이유로 그대로 돈다.
-- 나중에 클라이언트에서 원시 테이블을 읽어야 할 일이 생기면 그때
--   create policy ... for select to anon using (true);
-- 를 필요한 테이블에만 붙이면 된다. select만 여는 것이 핵심이다.

alter table apts              enable row level security;
alter table transactions      enable row level security;
alter table rent_transactions enable row level security;

-- ─── 뷰는 RLS로 막히지 않는다 ───────────────────────────────────────────────
-- 뷰는 기본적으로 소유자(postgres) 권한으로 실행되므로 아래 테이블에 RLS를 켜도
-- 뷰를 통하면 그대로 읽힌다. 매터리얼라이즈드 뷰는 아예 RLS를 지원하지 않는다.
-- 그래서 뷰 쪽은 RLS가 아니라 grant로 정리한다.
--
-- apt_prices / apt_rent_prices는 앱이 쓰지 않는다 (앱은 _mv만 읽는다). 그런데도
-- API에 열려 있으면 조회 한 번에 단지 32만 개의 집계를 다시 도는 질의를 아무나
-- 반복해서 때릴 수 있다. 데이터 유출보다 이쪽이 실질적인 위험이다.
revoke all on apt_prices      from anon, authenticated;
revoke all on apt_rent_prices from anon, authenticated;

-- region_data_stats는 관리자 화면 전용이고 service_role로만 읽는다.
revoke all on region_data_stats from anon, authenticated;

-- matview 두 개는 앱이 anon 키로 읽어야 하므로 열어 두되, 읽기만 남긴다.
-- (matview는 애초에 쓰기가 불가능하지만 기본 grant를 그대로 두지 않는다는 뜻이다.)
revoke all on apt_prices_mv      from anon, authenticated;
revoke all on apt_rent_prices_mv from anon, authenticated;
grant select on apt_prices_mv      to anon, authenticated;
grant select on apt_rent_prices_mv to anon, authenticated;
