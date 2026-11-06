import "./globals.css";

export const metadata = {
  title: "FarmLedger",
  description: "Crop and cattle insurance for Rwandan smallholder farmers",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
};

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#2F6B3A" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
