import "./globals.css";
import TopBar from "@/components/TopBar";

export const metadata = {
  title: "Hilights Equipment Management System",
  description: "Equipment Inventory",

  icons: {
  icon: "/icon.png",
  shortcut: "/icon.png",
  apple: "/icon.png",
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
        <main className="max-w-6xl mx-auto p-6 min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}