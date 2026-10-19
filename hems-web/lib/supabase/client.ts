import { offlineFetch } from "@/lib/offline";
import { createBrowserClient } from "@supabase/ssr";
import type { AuthError, Session } from "@supabase/supabase-js";

type HemsBrowserClient = ReturnType<typeof createBrowserClient>;
type BrowserSessionResult = { data: { session: Session | null }; error: AuthError | null };
let browserClient: HemsBrowserClient | undefined;
let sessionRequest: Promise<BrowserSessionResult> | undefined;

function makeClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: offlineFetch } }
  );
}

export function createClient() {
  // Every client owns an auth refresher and competes for the same browser
  // token lock. Reuse one instance for the whole tab so simultaneous startup,
  // sidebar and report reads cannot steal that lock from each other.
  if (typeof window === "undefined") return makeClient();
  browserClient ??= makeClient();
  return browserClient;
}

/** Share simultaneous startup/session reads instead of competing for auth-js' lock. */
export function readBrowserSession(): Promise<BrowserSessionResult> {
  if (typeof window === "undefined") return createClient().auth.getSession();
  if (!sessionRequest) {
    const pending = createClient().auth.getSession();
    sessionRequest = pending;
    const clear = () => {
      if (sessionRequest === pending) sessionRequest = undefined;
    };
    void pending.then(clear, clear);
  }
  return sessionRequest!;
}
