import type { CapacitorConfig } from "@capacitor/cli";

// appId is permanent once an app is uploaded to App Store Connect or Google Play.
// PLACEHOLDER: com.example.cooldownchess must become the real reverse-domain ID before the first upload
// (also in android/app/build.gradle, android strings.xml, the iOS project and codemagic.yaml).
const config: CapacitorConfig = {
  appId: "com.example.cooldownchess",
  appName: "Cooldown Chess",
  webDir: "dist",
  backgroundColor: "#05080c",
  ios: {
    contentInset: "never"
  }
};

export default config;
