# Application

The application component is Lemma's composition root. It parses process arguments, selects an
operation, and wires user intent to the client or daemon interface.

It may depend on high-level component interfaces, but it owns no mux state, terminal emulation,
rendering algorithm, socket mechanism, or event loop. Keep `apps/lemma/main.cpp` policy-free:
process bootstrap delegates immediately to `lemma::app::run`.
