# llm.commands

The model providers' commands. Adds them to `Commands`. They are a plugin of
their own, so a composition without `Llm` still has the other commands. No
config.

| Command      | Title                  | Does                                               |
| ------------ | ---------------------- | -------------------------------------------------- |
| `llm.logout` | Log out of a provider… | Asks which configured provider, and logs out of it |

`llmCommands` is exported for reuse and testing.
