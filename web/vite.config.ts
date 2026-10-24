/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH is "/rocket-tracker/" on GitHub Pages, "/" locally.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  server: { fs: { allow: [".."] } }, // the Code tab imports ../firmware sources
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Rocket Tracker",
        short_name: "Rocket Tracker",
        description: "Live GPS tracking, terminal and firmware flashing for a rocket GPS tracker.",
        theme_color: "#10161d",
        background_color: "#10161d",
        display: "standalone",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        // Map tiles you've looked at are kept, so the launch site works with no signal.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.hostname.endsWith("tile.openstreetmap.org") || url.hostname === "server.arcgisonline.com",
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: { maxEntries: 5000, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes("/firmware/"),
            handler: "NetworkFirst",
            options: { cacheName: "firmware" },
          },
        ],
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
