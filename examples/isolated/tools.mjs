// The tools that run isolated: plain JavaScript, a module of its own, which the host never imports. Each is a name, a
// description and a JSON Schema for the model, and `execute`, which returns text (or something JSON can carry).
export default [
  {
    name: "word_frequency",
    description: "Counts how often each word occurs in a text, the most frequent first.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text" }, top: { type: "number", description: "How many words to list (default 10)" } },
      required: ["text"],
    },
    execute: ({ text, top = 10 }) => {
      const counts = new Map();
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
      return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([word, count]) => `${word} ${count}`)
        .join("\n");
    },
  },
];
