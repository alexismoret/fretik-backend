import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // TODO: paste your project ref (proj_...) from the Trigger.dev dashboard.
  project: "proj_vdpokgcsplbmmcapqngm",
  runtime: "bun",
  dirs: ["./src/tasks"],
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      randomize: true,
    },
  },
});
