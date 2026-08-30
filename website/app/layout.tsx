import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YoreBot | Private help on your computer",
  description:
    "Private local chat and a Downloads organizer that asks before changing files.",
  icons: {
    icon: "/logo-app.png",
    shortcut: "/logo-app.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
