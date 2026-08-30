import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { getSocialImageUrl } from "./social-image-url.mjs";

const title = "YoreBot | Private help on your computer";
const description =
  "Private local chat and a Downloads organizer that asks before changing files.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const socialImage = getSocialImageUrl({
    forwardedHost: requestHeaders.get("x-forwarded-host"),
    host: requestHeaders.get("host"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });
  const images = socialImage ? [socialImage] : [];

  return {
    title,
    description,
    icons: {
      icon: "/logo-app.png",
      shortcut: "/logo-app.png",
    },
    openGraph: {
      title,
      description,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images,
    },
  };
}

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
