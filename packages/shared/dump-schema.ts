import { z } from "zod";
import { aiSuggestResponseSchema } from "./src/schemas/field-definitions";

const jsonSchema = z.toJSONSchema(aiSuggestResponseSchema as any, {
  unrepresentable: "any",
});
console.log(JSON.stringify(jsonSchema, null, 2));
