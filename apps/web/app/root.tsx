import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import "./style.css";
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>folio — Your creative world, together.</title>
        <meta
          name="description"
          content="Google Driveとつながる、チームのアートワークライブラリ。"
        />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
export function HydrateFallback() {
  return (
    <div className="loading">
      <span className="brand">
        folio<span>✳</span>
      </span>
      <p>クリエイティブな世界を準備しています…</p>
    </div>
  );
}
export default function Root() {
  return <Outlet />;
}
