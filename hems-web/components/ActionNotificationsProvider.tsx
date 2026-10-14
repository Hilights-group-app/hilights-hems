"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { createBrowserId } from "@/lib/browserId";
import { EQUIPMENT_LISTS_EVENT } from "@/lib/equipmentLists";

export type ActionNotification = {
  id: string; kind: "approval" | "testing"; title: string; message: string; href: string; created_at: string;
};
const InboxContext = createContext<{ tasks: ActionNotification[]; revision: number }>({tasks:[],revision:0});
export const useActionNotifications = () => useContext(InboxContext);

export default function ActionNotificationsProvider({children}:{children:ReactNode}) {
  const supabase = useMemo(() => createClient(), []);
  const [tasks,setTasks] = useState<ActionNotification[]>([]);
  const [revision,setRevision] = useState(0);
  useEffect(() => {
    let disposed=false,owner:string|null=null,version=0;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let channel:ReturnType<typeof supabase.channel>|null=null;
    async function refresh() {
      if (!owner || disposed) return;
      const user=owner,read=++version;
      let response;
      try { response=await supabase.rpc("hems_action_notifications"); }
      catch(error){if(!disposed && read===version && user===owner)console.error("action notifications load error",error);return;}
      const {data,error}=response;
      if(disposed || read!==version || user!==owner)return;
      if(error){console.error("action notifications load error",error);return;}
      setTasks(Array.isArray(data)?data:[]);
      setRevision(value=>value+1);
      window.dispatchEvent(new Event("hems:notification-inbox-change"));
    }
    function schedule() { clearTimeout(timer);timer=setTimeout(()=>void refresh(),250); }
    function syncOwner(next:string|null) {
      if(disposed || next===owner)return;
      owner=next;++version;clearTimeout(timer);setTasks([]);setRevision(value=>value+1);
      if(channel)void supabase.removeChannel(channel);channel=null;
      if(!owner)return;
      channel=supabase.channel(`action-inbox:${owner}:${createBrowserId()}`)
        .on("postgres_changes",{event:"*",schema:"public",table:"equipment_lists"},schedule)
        .on("postgres_changes",{event:"*",schema:"public",table:"maintenance_requests"},schedule)
        .on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications"},schedule)
        .subscribe();
      schedule();
    }
    let authEvents=0;
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{++authEvents;syncOwner(session?.user.id || null);});
    const observedAuthEvents=authEvents;
    void supabase.auth.getSession().then(({data:{session}})=>{if(authEvents===observedAuthEvents)syncOwner(session?.user.id || null);});
    const visible=()=>{if(document.visibilityState==="visible")schedule();};
    window.addEventListener("focus",schedule);document.addEventListener("visibilitychange",visible);
    window.addEventListener(EQUIPMENT_LISTS_EVENT,schedule);
    window.addEventListener("hems:maintenance-requests-change",schedule);
    return()=>{disposed=true;++version;clearTimeout(timer);subscription.unsubscribe();if(channel)void supabase.removeChannel(channel);
      window.removeEventListener("focus",schedule);document.removeEventListener("visibilitychange",visible);
      window.removeEventListener(EQUIPMENT_LISTS_EVENT,schedule);window.removeEventListener("hems:maintenance-requests-change",schedule);};
  },[supabase]);
  return <InboxContext.Provider value={{tasks,revision}}>{children}</InboxContext.Provider>;
}
