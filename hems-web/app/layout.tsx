import "./globals.css";
import TopBar from "@/components/TopBar";

export const metadata = {
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
    <html lang="en">
      <body className="text-black">
        <TopBar />
        <main className="w-full min-h-screen px-[2px] py-2 sm:max-w-6xl sm:mx-auto sm:p-6">
  {children}
</main>
      </body>
    </html>
  );
}