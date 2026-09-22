local lemma = require("lemma")

lemma.extension.set("statusline", { lemma.bundled_ui, "status" })
lemma.command.register("session.manager", {
  description = "Find a session, tab, or pane",
  timeout_ms = 600000,
  argv = { lemma.bundled_ui, "sessions" },
})
lemma.keymap.set("prefix", "s", "session.manager", "base")
