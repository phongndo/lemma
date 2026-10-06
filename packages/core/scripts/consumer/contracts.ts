import { Context } from "effect";

// Applications and plugin authors own these contracts; the core supplies composition.
export class Formatter extends Context.Tag("consumer/Formatter")<
  Formatter,
  {
    readonly format: (text: string) => Promise<string>;
  }
>() {}

export class Message extends Context.Tag("consumer/Message")<
  Message,
  {
    readonly render: (text: string) => Promise<string>;
  }
>() {}
