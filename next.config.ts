import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  // The FastAPI sidecar serves the static export; during `next dev` we proxy
  // API calls to it instead (see src/lib/api.ts which targets :5800 directly).
  images: { unoptimized: true },
};

export default nextConfig;
