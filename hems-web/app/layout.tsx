import "./globals.css";
import TopBar from "@/components/TopBar";

export const metadata = {
  title: "Hilights Equipment Management System",
  description: "Equipment Inventory",
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