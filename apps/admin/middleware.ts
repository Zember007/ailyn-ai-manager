import { NextResponse } from "next/server";

const authCookie = "ailyn_admin";

export function middleware(request: { nextUrl: URL; url: string; cookies: { get(name: string): { value: string } | undefined } }) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/_next") || pathname === "/favicon.ico" || pathname === "/health") {
    return undefined;
  }
  if (request.cookies.get(authCookie)?.value === "ok") {
    return undefined;
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!api).*)"]
};
