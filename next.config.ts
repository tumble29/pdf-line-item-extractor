import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf bundles pdf.js and its worker. Keeping it external means Next.js
  // loads it from node_modules at runtime instead of re-bundling it.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
