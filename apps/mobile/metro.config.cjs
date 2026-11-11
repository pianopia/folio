const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
// Remix 2 uses React 18; Expo SDK 54 uses React 19. Resolve every native
// React import from the mobile package, including imports inside hoisted deps.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    const filePath = require.resolve(moduleName, { paths: [__dirname] });
    return { type: "sourceFile", filePath };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
