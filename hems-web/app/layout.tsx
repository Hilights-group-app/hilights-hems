import "./globals.css";
import { APP_LAYOUT_BOOTSTRAP } from "@/lib/appLayout";
import type { Viewport } from "next";
import ActionNotificationsProvider from "@/components/ActionNotificationsProvider";
import OfflineWorkspace from "@/components/OfflineWorkspace";
import AppStartup from "@/components/AppStartup";
import TopBar from "@/components/TopBar";
import MobileDraftDock from "@/components/MobileDraftDock";
import AppShellClient from "@/components/AppShellClient";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export const metadata = {
  metadataBase: new URL("https://hilights-hems.vercel.app"),
  title: "Hilights Equipment Management System",
  description: "Equipment Inventory",
  manifest: "/manifest.json",

  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/apple-touch-icon.png",
  },

  openGraph: {
    title: "Hilights Equipment Management System",
    description: "Equipment Inventory",
    url: "https://hilights-hems.vercel.app",
    siteName: "Hilights",
    images: [
      {
        url: "/preview.png",
        width: 1200,
        height: 630,
      },
    ],
    type: "website",
  },

  twitter: {
    card: "summary_large_image",
    title: "Hilights Equipment Management System",
    description: "Equipment Inventory",
    images: ["/preview.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: APP_LAYOUT_BOOTSTRAP }} /></head>
      <body className="bg-white text-black">
        <OfflineWorkspace />
        <div data-hems-online-app className="contents">
        <AppStartup>
        <ActionNotificationsProvider>
        <TopBar />
        <AppShellClient>{children}</AppShellClient>
        <MobileDraftDock />
        </ActionNotificationsProvider>
        </AppStartup>
        </div>
      </body>
    </html>
  );
}
