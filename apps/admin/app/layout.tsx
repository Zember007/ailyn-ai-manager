import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Ailyn Admin",
  description: "Внутренний интерфейс Ailyn Stage 1"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
