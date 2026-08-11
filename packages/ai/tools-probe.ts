import { chatbotAgentSet } from "./src/agents/chatbot";
const tools = chatbotAgentSet.primary.tools;
const domain = Object.entries(tools)
  .filter(([, t]) => t.category === "domain")
  .map(([n]) => n);
const core = Object.entries(tools)
  .filter(([, t]) => t.category === "core")
  .map(([n]) => n);
console.log("core", core.length, core.join(" "));
console.log("domain", domain.length, domain.join(" "));
