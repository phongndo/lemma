import { sessionsConformance } from "@lemma/testing";
import { fakeSessions } from "./fakes.ts";

// The fake these tests serve sessions from keeps the contract the sessions plugin keeps.
sessionsConformance("the transport tests' fake", () => [fakeSessions]);
