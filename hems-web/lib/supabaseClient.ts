// Legacy import kept for catalogStore. It must share the same browser client as
// the rest of HEMS; a second auth client can steal Supabase's session lock.
import { createClient } from "./supabase/client";

export const supabase = createClient();
