"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient, readBrowserSession } from "@/lib/supabase/client";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createBrowserId } from "@/lib/browserId";
import { EQUIPMENT_LISTS_EVENT } from "@/lib/equipmentLists";
import { createRefreshQueue, MAINTENANCE_ALERTS_EVENT, NOTIFICATION_FEED_EVENT } from "@/lib/workspaceRefresh";

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
    let disposed=false,owner:string|null=null,version=0,lastRefresh=0;
    let fingerprint:string|null=null;
    let queue:ReturnType<typeof createRefreshQueue>|null=null;
    let channel:ReturnType<typeof supabase.channel>|null=null;
    async function refresh() {
      if (!owner || disposed) return;
      const user=owner,read=version;
      try {
        const {data,error}=await supabase.rpc("hems_action_notifications");
        if(disposed || read!==version || user!==owner)return;
        if(error){console.error("action notifications load error",error);return;}
        lastRefresh=Date.now();
        const next:ActionNotification[]=Array.isArray(data)?data:[];
        const nextFingerprint=JSON.stringify(next);
        if(nextFingerprint===fingerprint)return;
        fingerprint=nextFingerprint;
        setTasks(next);
        setRevision(value=>value+1);
        // A changed task inbox is not a reason to reload activity/certificates.
        window.dispatchEvent(new Event("hems:notification-inbox-change"));
      } catch(error) {
        if(!disposed && read===version && user===owner)console.error("action notifications load error",error);
      }
    }
    function schedule() { queue?.schedule(); }
    function wake() {
      if(document.visibilityState!=="visible")return;
      queue?.resume();
      if(!queue?.isPending() && Date.now()-lastRefresh>=30000)queue?.request();
    }
    function syncOwner(next:string|null) {
      if(disposed || next===owner)return;
      owner=next;++version;lastRefresh=0;fingerprint=null;
      queue?.dispose();queue=null;
      setTasks([]);setRevision(value=>value+1);
      if(channel)void supabase.removeChannel(channel);channel=null;
      if(!owner)return;
      queue=createRefreshQueue(refresh);
      const channelOwner=owner;
      let subscribedBefore=false;
      channel=supabase.channel(`action-inbox:${owner}:${createBrowserId()}`)
        .on("postgres_changes",{event:"*",schema:"public",table:"equipment_lists"},()=>{
          if(!disposed && owner===channelOwner)schedule();
        })
        .on("postgres_changes",{event:"*",schema:"public",table:"maintenance_requests"},()=>{
          if(disposed || owner!==channelOwner)return;
          schedule();
          window.dispatchEvent(new Event(MAINTENANCE_ALERTS_EVENT));
        })
        .on("postgres_changes",{event:"INSERT",schema:"public",table:"notifications"},(payload:{new:Record<string,unknown>})=>{
          if(disposed || owner!==channelOwner)return;
          // Activity uses notifications; tasks use lists and maintenance. An
          // ordinary notification must not re-read the task RPC/certificates.
          window.dispatchEvent(new CustomEvent(NOTIFICATION_FEED_EVENT,{detail:{
            certificateChanged:/certificate/i.test(String(payload.new.message ?? "")),
          }}));
        })
        .subscribe((status:string)=>{
          if(disposed || owner!==channelOwner || status!=="SUBSCRIBED")return;
          if(subscribedBefore){
            schedule();
            window.dispatchEvent(new Event(NOTIFICATION_FEED_EVENT));
            window.dispatchEvent(new Event(MAINTENANCE_ALERTS_EVENT));
          }
          subscribedBefore=true;
        });
      queue.request();
    }
    let authEvents=0;
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event:AuthChangeEvent,session:Session|null)=>{++authEvents;syncOwner(session?.user.id || null);});
    const observedAuthEvents=authEvents;
    void readBrowserSession().then(({data:{session}})=>{if(authEvents===observedAuthEvents)syncOwner(session?.user.id || null);}).catch(()=>{});
    window.addEventListener("focus",wake);document.addEventListener("visibilitychange",wake);
    window.addEventListener(EQUIPMENT_LISTS_EVENT,schedule);
    window.addEventListener("hems:maintenance-requests-change",schedule);
    return()=>{disposed=true;++version;queue?.dispose();subscription.unsubscribe();if(channel)void supabase.removeChannel(channel);
      window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",wake);
      window.removeEventListener(EQUIPMENT_LISTS_EVENT,schedule);window.removeEventListener("hems:maintenance-requests-change",schedule);};
  },[supabase]);
  return <InboxContext.Provider value={{tasks,revision}}>{children}</InboxContext.Provider>;
}
