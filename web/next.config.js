// The portal shares the repository's .env and .env.<NETWORK> with the services (../services/env.js). Variables
// already set in the shell win. Server side only: nothing here is exposed to the browser.
require("../services/env").loadEnv();
require("../services/rpc").applyRpcEnv();

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  webpack(config, { isServer }) {
    // node:sqlite (Node 22.5+) is newer than webpack's list of Node built-ins: load it at run time, don't bundle it.
    if (isServer) config.externals.push({ "node:sqlite": "commonjs node:sqlite" });
    return config;
  },
};
