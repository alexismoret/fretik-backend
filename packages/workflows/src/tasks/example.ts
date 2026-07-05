import { task } from "@trigger.dev/sdk";

// First task, proving the setup works end-to-end. Fire a test run from the
// dashboard once `trigger dev` is running, then replace with real workflows.
export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name: string }) => {
    return { message: `Hello ${payload.name}!` };
  },
});
