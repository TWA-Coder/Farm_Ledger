// The portal shares the repository's .env and .env.<NETWORK> with the services (../services/env.js). Variables
// already set in the shell win. Server side only: nothing here is exposed to the browser.
require("../services/env").loadEnv();
require("../services/rpc").applyRpcEnv();

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // the PostgreSQL driver is loaded by Node at run time, not bundled (its optional native binding cannot be bundled)
  experimental: { serverComponentsExternalPackages: ["pg"] },
};
