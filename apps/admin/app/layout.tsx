import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Ailyn Admin",
  description: "Internal Ailyn Stage 1 admin interface"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
