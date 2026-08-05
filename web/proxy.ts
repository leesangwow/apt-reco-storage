import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ADMIN_COOKIE, verifyToken } from '@/lib/admin-auth';

/**
 * /admin 이하를 관리자 세션 쿠키로 막는다.
 *
 * Next.js 16에서 middleware는 proxy로 이름이 바뀌었고 Node.js 런타임이 기본이다.
 * 공식 문서 권고대로 이 게이트만 믿지 않고, /api/admin/* 라우트 안에서도
 * 세션을 다시 검사한다.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 로그인 화면과 로그인 API 자체는 통과시켜야 한다 (막으면 로그인이 불가능해진다)
  if (pathname === '/admin/login' || pathname === '/api/admin/login') {
    return NextResponse.next();
  }

  if (verifyToken(request.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const login = new URL('/admin/login', request.url);
  login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
