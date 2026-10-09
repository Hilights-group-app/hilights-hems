import { getUserName } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";

export async function logActivity({
  title,
  message,
  link,
}: {
  title: string;
  message?: string | null;
  link?: string | null;
}) {
  try {
    const supabase = createClient();
    const actorName = getUserName() || "A team member";

    const { error } = await supabase.from("notifications").insert({
      title,
      message: message || null,
      link: link || null,
      actor_name: actorName,
      is_read: false,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("logActivity error:", error);
    }
  } catch (error) {
    console.error("logActivity unexpected error:", error);
  }
}
