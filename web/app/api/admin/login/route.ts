import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, SESSION_MAX_AGE, checkPassword, issueToken } from '@/lib/admin-auth';

export async function POST(req: NextRequest) {
  let password = '';
  try {
    ({ password = '' } = await req.json());
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다' }, { status: 400 });
  }

  if (!checkPassword(password)) {
    // 실패 사유(비밀번호 틀림 / 환경변수 미설정)를 구분해 알려주지 않는다.
    return NextResponse.json({ error: '비밀번호가 올바르지 않습니다' }, { status: 401 });
  }

  const store = await cookies();
  store.set(ADMIN_COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  return NextResponse.json({ ok: true });
}
