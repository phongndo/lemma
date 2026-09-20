local lemma = require("lemma")

lemma.command.register("nav.pick", {
  description = "Choose a Session, Tab, or Pane",
  timeout_ms = 120000,
  argv = { "python3", os.getenv("HOME") .. "/.config/lemma/picker.py" },
})
lemma.keymap.set("prefix", "p", "nav.pick")
