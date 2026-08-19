import { langfuseClient } from "../src/lib/langfuse";

const traceId = process.argv[2];
const page = await langfuseClient.api.observations.getMany({
  traceId,
  limit: 200,
});
for (const o of page.data.reverse()) {
  if (o.type === "TOOL" && o.name === "searchTools") {
    const full = await langfuseClient.api.observations.get(o.id);
    console.error(
      `\n=== searchTools\n IN : ${JSON.stringify(full.input)}\n OUT: ${JSON.stringify(full.output ?? null).slice(0, 1600)}`,
    );
  }
}
process.exit(0);
