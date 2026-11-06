/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  webpack(config, { isServer }) {
    // node:sqlite (Node 22.5+) is newer than webpack's list of Node built-ins: load it at run time, don't bundle it.
    if (isServer) config.externals.push({ "node:sqlite": "commonjs node:sqlite" });
    return config;
  },
};
