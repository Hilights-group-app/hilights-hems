import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Offline shell assets contain no private data and must not wait for Auth.
  if (["/offline.html", "/offline-store.js", "/offline-app.js", "/offline.css", "/hems-sw.js", "/logo-icon.png"].includes(pathname)) {
    return NextResponse.next();
  }

  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".");

  const isApi = pathname.startsWith("/api");

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  const hasAuthCookie = request.cookies.getAll().some(({ name }) =>
    /^sb-.*-auth-token(?:\.\d+)?$/.test(name)
  );
  const authStatus = Number((authError as { status?: number } | null)?.status || 0);
  const authMessage = String(authError?.message || "");
  const transientAuthError = Boolean(authError && hasAuthCookie && (
    authStatus === 0 || authStatus === 429 || authStatus >= 500 || /fetch|network|timeout|retryable/i.test(authMessage)
  ));

  // A temporary network/Auth service failure with an existing session cookie
  // is not a sign-out. Missing or rejected sessions still go to /login below.
  if (transientAuthError) return response;

  if (!user && !isPublic && !isApi) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
