import { Context } from "effect";

// Applications and plugin authors own these contracts; the core supplies composition.
export class Formatter extends Context.Service<
  Formatter,
  {
    readonly format: (text: string) => Promise<string>;
  }
>()("consumer/Formatter") {}

export class Message extends Context.Service<
  Message,
  {
    readonly render: (text: string) => Promise<string>;
  }
>()("consumer/Message") {}
