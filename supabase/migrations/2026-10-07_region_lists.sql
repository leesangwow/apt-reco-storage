-- 가격대 탐색의 시도·시군구 목록 함수
--
-- web/app/api/regions가 get_sido_list / get_gu_list RPC를 부르는데, 두 함수의 정의가
-- 저장소에 없었다. 운영 DB에 없으면 "가격대로 찾기"에서 시도 버튼이 하나도 안 나온다.
-- 앱은 함수가 없을 때 apt_prices_mv를 직접 읽도록 바뀌었지만(느리다 — 경기도는
-- 수십 번 왕복), 이 함수가 있으면 한 번에 끝난다.
--
-- 추천 API와 같은 apt_prices_mv를 읽는다. 최근 6개월 거래가 없어 추천에 안 나오는
-- 단지는 목록에도 세지 않는다. matview라 적재 후 refresh 때 함께 갱신된다.

-- 운영 DB에 손으로 만든 같은 이름 함수가 있으면 반환형이 달라 replace가 거절된다.
-- 의존 객체가 없는 함수라 지우고 다시 만든다.
drop function if exists get_sido_list();
drop function if exists get_gu_list(text);

create or replace function get_sido_list()
returns table (sido text)
language sql stable
as $$
  select distinct m.sido::text from apt_prices_mv m order by 1;
$$;

create or replace function get_gu_list(p_sido text)
returns table (gu text, count bigint)
language sql stable
as $$
  select m.gu::text, count(*) from apt_prices_mv m
   where m.sido = p_sido
   group by m.gu
   order by m.gu;
$$;

grant execute on function get_sido_list()     to anon, authenticated;
grant execute on function get_gu_list(text)   to anon, authenticated;

notify pgrst, 'reload schema';
