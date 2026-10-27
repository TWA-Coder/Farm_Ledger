import "./globals.css";

export const metadata = {
  title: "FarmLedger",
  description: "Parametric micro-insurance for Rwandan smallholder farmers",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg" },
};

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#006B3F" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
