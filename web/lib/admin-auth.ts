import { createHmac, timingSafeEqual } from 'crypto';

export const ADMIN_COOKIE = 'admin_session';
export const SESSION_MAX_AGE = 60 * 60 * 12; // 12시간

function secret(): string {
  const s = process.env.ADMIN_PASSWORD;
  if (!s) throw new Error('ADMIN_PASSWORD 환경변수가 설정되지 않았습니다');
  return s;
}

/**
 * 세션 토큰: "<만료시각>.<서명>".
 * 비밀번호 자체를 쿠키에 담지 않고, 비밀번호로 서명한 만료시각만 담는다.
 */
export function issueToken(): string {
  const expires = Date.now() + SESSION_MAX_AGE * 1000;
  const sig = createHmac('sha256', secret()).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;

  let expected: string;
  try {
    expected = createHmac('sha256', secret()).update(expires).digest('hex');
  } catch {
    return false;
  }

  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 비밀번호 비교. 길이 노출을 막기 위해 해시를 거쳐 고정 길이로 비교한다. */
export function checkPassword(input: string): boolean {
  let expected: string;
  try {
    expected = secret();
  } catch {
    return false;
  }
  const h = (v: string) => createHmac('sha256', 'pw').update(v).digest();
  return timingSafeEqual(h(input), h(expected));
}
